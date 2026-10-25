#!/usr/bin/env python3
"""End-to-end check of the TURN relay's authentication and peer policy.

Speaks enough STUN/TURN (RFC 5389 / 5766) to prove the four properties the
relay is supposed to have after the SRV-01 hardening:

  1. an ephemeral credential minted from TURN_STATIC_AUTH_SECRET can allocate;
  2. an expired credential — and the old static account — cannot;
  3. CreatePermission for a public peer succeeds, so real calls still relay;
  4. CreatePermission for anything internal (cloud metadata, RFC1918, loopback,
     link-local) is refused with 403; the relay host itself must be ALLOWED (relay<->relay).
  5. one username can hold many allocations at once (P2P channel + call + ICE
     restarts, three TURN URLs per network): user-quota / bps-capacity must not
     refuse them — on 2026-10-17 bps-capacity=6×max-bps silently capped the
     whole server at six allocations and calls on top of P2P channels got no
     relay candidates.

Usage (secrets come from the environment or a file, never from argv — argv is
visible to every user of the host via ps / /proc, INFRA-07/INFRA-15):
    TURN_STATIC_AUTH_SECRET=<hex> python3 scripts/turn_selftest.py --host turn.example.org
    python3 scripts/turn_selftest.py --host … --secret-file /root/turn.secret
    TURN_CREDENTIAL=… python3 scripts/turn_selftest.py --host … --username 12345:u0
    TURN_LEGACY_PASS=<old-static-password> python3 scripts/turn_selftest.py --host … \
        --legacy-user phantom

Exits non-zero if any check fails.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import ipaddress
import os
import secrets
import socket
import struct
import sys
import time

MAGIC_COOKIE = 0x2112A442

# Message types
ALLOCATE_REQUEST = 0x0003
CREATE_PERMISSION_REQUEST = 0x0008
SEND_INDICATION = 0x0016
DATA_INDICATION = 0x0017
REFRESH_REQUEST = 0x0004

# Attributes
ATTR_USERNAME = 0x0006
ATTR_MESSAGE_INTEGRITY = 0x0008
ATTR_ERROR_CODE = 0x0009
ATTR_XOR_PEER_ADDRESS = 0x0012
ATTR_DATA = 0x0013
ATTR_REALM = 0x0014
ATTR_NONCE = 0x0015
ATTR_XOR_RELAYED_ADDRESS = 0x0016
ATTR_REQUESTED_TRANSPORT = 0x0019
ATTR_LIFETIME = 0x000D

TRANSPORT_UDP = 17


class TurnError(Exception):
    def __init__(self, code: int, reason: str):
        super().__init__(f"{code} {reason}")
        self.code = code
        self.reason = reason


def _pad(value: bytes) -> bytes:
    return value + b"\x00" * ((4 - len(value) % 4) % 4)


def _attr(attr_type: int, value: bytes) -> bytes:
    return struct.pack("!HH", attr_type, len(value)) + _pad(value)


def _xor_address(data: bytes, txid: bytes) -> tuple[str, int]:
    family = data[1]
    port = struct.unpack("!H", data[2:4])[0] ^ (MAGIC_COOKIE >> 16)
    if family == 0x01:
        raw = bytes(b ^ m for b, m in zip(data[4:8], struct.pack("!I", MAGIC_COOKIE)))
    else:
        mask = struct.pack("!I", MAGIC_COOKIE) + txid
        raw = bytes(b ^ m for b, m in zip(data[4:20], mask))
    return str(ipaddress.ip_address(raw)), port


def _encode_xor_peer(host: str, port: int, txid: bytes) -> bytes:
    addr = ipaddress.ip_address(host)
    xport = struct.pack("!H", port ^ (MAGIC_COOKIE >> 16))
    if addr.version == 4:
        raw = bytes(b ^ m for b, m in zip(addr.packed, struct.pack("!I", MAGIC_COOKIE)))
        return b"\x00\x01" + xport + raw
    mask = struct.pack("!I", MAGIC_COOKIE) + txid
    raw = bytes(b ^ m for b, m in zip(addr.packed, mask))
    return b"\x00\x02" + xport + raw


def _parse(message: bytes) -> tuple[int, bytes, dict[int, bytes]]:
    msg_type, length = struct.unpack("!HH", message[0:4])
    txid = message[8:20]
    attrs: dict[int, bytes] = {}
    offset = 20
    end = 20 + length
    while offset + 4 <= end:
        attr_type, attr_len = struct.unpack("!HH", message[offset : offset + 4])
        value = message[offset + 4 : offset + 4 + attr_len]
        attrs.setdefault(attr_type, value)
        offset += 4 + attr_len + ((4 - attr_len % 4) % 4)
    return msg_type, txid, attrs


def _error_of(attrs: dict[int, bytes]) -> tuple[int, str]:
    raw = attrs.get(ATTR_ERROR_CODE)
    if not raw or len(raw) < 4:
        return 0, ""
    code = raw[2] * 100 + raw[3]
    return code, raw[4:].decode("utf-8", "replace")


def _with_integrity(header_type: int, txid: bytes, body: bytes, key: bytes) -> bytes:
    # The integrity HMAC covers the message with its length field already
    # counting the 24-byte MESSAGE-INTEGRITY attribute (RFC 5389 §15.4).
    prefix = struct.pack("!HHI", header_type, len(body) + 24, MAGIC_COOKIE) + txid + body
    digest = hmac.new(key, prefix, hashlib.sha1).digest()
    return prefix + _attr(ATTR_MESSAGE_INTEGRITY, digest)


def mint_credential(secret: str, label: str, ttl_sec: int) -> tuple[str, str]:
    """Same TURN REST API scheme the relay backend uses."""
    username = f"{int(time.time()) + ttl_sec}:{label}"
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    return username, base64.b64encode(digest).decode("ascii")


class TurnClient:
    """Minimal TURN client over UDP or TCP (browsers fall back to TCP)."""

    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        credential: str,
        timeout: float = 5.0,
        transport: str = "udp",
    ):
        self.addr = (socket.gethostbyname(host), port)
        self.username = username
        self.credential = credential
        self.transport = transport
        if transport == "tcp":
            self.sock = socket.create_connection(self.addr, timeout=timeout)
        else:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.settimeout(timeout)
        self.realm = b""
        self.nonce = b""

    def close(self) -> None:
        self.sock.close()

    # ── transport framing ───────────────────────────────────────────────
    def _send(self, packet: bytes) -> None:
        if self.transport == "tcp":
            self.sock.sendall(packet)
        else:
            self.sock.sendto(packet, self.addr)

    def _recv(self) -> bytes:
        if self.transport != "tcp":
            datagram, _ = self.sock.recvfrom(4096)
            return datagram
        # STUN over TCP is a byte stream: read the 20-byte header, then the
        # body length it announces.
        header = self._recv_exactly(20)
        return header + self._recv_exactly(struct.unpack("!H", header[2:4])[0])

    def _recv_exactly(self, count: int) -> bytes:
        buffer = b""
        while len(buffer) < count:
            chunk = self.sock.recv(count - len(buffer))
            if not chunk:
                raise socket.timeout("connection closed by relay")
            buffer += chunk
        return buffer

    def _key(self) -> bytes:
        return hashlib.md5(
            f"{self.username}:{self.realm.decode()}:{self.credential}".encode()
        ).digest()

    def _round_trip(self, msg_type: int, body: bytes, authenticated: bool) -> dict[int, bytes]:
        txid = secrets.token_bytes(12)
        if authenticated:
            body = (
                body
                + _attr(ATTR_USERNAME, self.username.encode())
                + _attr(ATTR_REALM, self.realm)
                + _attr(ATTR_NONCE, self.nonce)
            )
            packet = _with_integrity(msg_type, txid, body, self._key())
        else:
            packet = struct.pack("!HHI", msg_type, len(body), MAGIC_COOKIE) + txid + body
        self._send(packet)
        while True:
            data = self._recv()
            rtype, rtxid, attrs = _parse(data)
            if rtxid != txid:
                continue  # stray indication from an earlier exchange
            if rtype & 0x0110 == 0x0110:  # error response
                raise TurnError(*_error_of(attrs))
            return attrs

    def request(self, msg_type: int, body: bytes) -> dict[int, bytes]:
        """Long-term-credential exchange: unauthenticated probe, then signed retry."""
        try:
            return self._round_trip(msg_type, body, authenticated=False)
        except TurnError as exc:
            if exc.code not in (401, 438):
                raise
        # 401 carries the realm/nonce we must echo back.
        txid = secrets.token_bytes(12)
        packet = struct.pack("!HHI", msg_type, len(body), MAGIC_COOKIE) + txid + body
        self._send(packet)
        data = self._recv()
        _, _, attrs = _parse(data)
        self.realm = attrs.get(ATTR_REALM, self.realm)
        self.nonce = attrs.get(ATTR_NONCE, self.nonce)
        return self._round_trip(msg_type, body, authenticated=True)

    def allocate(self, lifetime: int = 300) -> tuple[str, int]:
        body = _attr(ATTR_REQUESTED_TRANSPORT, bytes([TRANSPORT_UDP, 0, 0, 0]) ) + _attr(
            ATTR_LIFETIME, struct.pack("!I", lifetime)
        )
        attrs = self.request(ALLOCATE_REQUEST, body)
        relayed = attrs.get(ATTR_XOR_RELAYED_ADDRESS)
        if not relayed:
            raise TurnError(0, "allocation succeeded without XOR-RELAYED-ADDRESS")
        return _xor_address(relayed, b"\x00" * 12)

    def release(self) -> None:
        """Refresh with lifetime=0 — free the allocation right away."""
        self._round_trip(REFRESH_REQUEST, _attr(ATTR_LIFETIME, struct.pack("!I", 0)), authenticated=True)

    def create_permission(self, peer_host: str, peer_port: int = 9) -> None:
        txid = secrets.token_bytes(12)
        body = _attr(ATTR_XOR_PEER_ADDRESS, _encode_xor_peer(peer_host, peer_port, txid))
        self._round_trip(CREATE_PERMISSION_REQUEST, body, authenticated=True)

    def send_to(self, peer_host: str, peer_port: int, payload: bytes) -> bytes | None:
        """Send a datagram through the relay and return the peer's reply, if any."""
        txid = secrets.token_bytes(12)
        body = _attr(ATTR_XOR_PEER_ADDRESS, _encode_xor_peer(peer_host, peer_port, txid)) + _attr(
            ATTR_DATA, payload
        )
        packet = struct.pack("!HHI", SEND_INDICATION, len(body), MAGIC_COOKIE) + txid + body
        self._send(packet)
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                data = self._recv()
            except socket.timeout:
                return None
            rtype, _, attrs = _parse(data)
            if rtype == DATA_INDICATION:
                return attrs.get(ATTR_DATA)
        return None


DENIED_PEERS = [
    ("cloud metadata", "169.254.169.254"),
    ("RFC1918 /8", "10.0.0.1"),
    ("RFC1918 /12", "172.16.0.1"),
    ("RFC1918 /16", "192.168.1.1"),
    ("loopback", "127.0.0.1"),
    ("CGNAT", "100.64.0.1"),
]


def _dns_query(name: str = "example.com") -> bytes:
    """Minimal DNS A query — a public resolver answers it, proving the data path."""
    qname = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00"
    return struct.pack("!HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + qname + struct.pack("!HH", 1, 1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=3478)
    ap.add_argument("--secret-file", default="", help="file holding TURN static-auth-secret")
    ap.add_argument("--username", default="")
    ap.add_argument("--ttl", type=int, default=300)
    ap.add_argument("--legacy-user", default="", help="static account that must NOT work any more")
    ap.add_argument("--legacy-pass-file", default="", help="file holding the old static password")
    ap.add_argument("--peer", default="8.8.8.8", help="public peer used for the allowed-path check")
    ap.add_argument("--skip-tcp", action="store_true", help="skip the TURN-over-TCP allocation check")
    ap.add_argument("--parallel", type=int, default=16,
                    help="allocations one username must be able to hold at once (quota check)")
    args = ap.parse_args()

    def read_secret_file(path: str) -> str:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()

    args.secret = (read_secret_file(args.secret_file) if args.secret_file
                   else os.getenv("TURN_STATIC_AUTH_SECRET", ""))
    args.credential = os.getenv("TURN_CREDENTIAL", "")
    args.legacy_pass = (read_secret_file(args.legacy_pass_file) if args.legacy_pass_file
                        else os.getenv("TURN_LEGACY_PASS", ""))

    if not args.secret and not (args.username and args.credential):
        ap.error("set TURN_STATIC_AUTH_SECRET (or --secret-file), or --username + TURN_CREDENTIAL")

    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            failures.append(name)

    # 1 — ephemeral credential can allocate
    if args.secret:
        username, credential = mint_credential(args.secret, "selftest", args.ttl)
    else:
        username, credential = args.username, args.credential
    client = TurnClient(args.host, args.port, username, credential)
    relayed: tuple[str, int] | None = None
    try:
        relayed = client.allocate()
        check("ephemeral credential allocates", True, f"relay {relayed[0]}:{relayed[1]}")
    except (TurnError, socket.timeout) as exc:
        check("ephemeral credential allocates", False, str(exc))

    # 2 — public peer is still reachable (real calls must keep working)
    if relayed:
        try:
            client.create_permission(args.peer)
            check("permission for public peer", True, args.peer)
        except (TurnError, socket.timeout) as exc:
            check("permission for public peer", False, str(exc))

        reply = None
        try:
            reply = client.send_to("8.8.8.8", 53, _dns_query())
        except Exception as exc:  # noqa: BLE001 — diagnostics only
            check("relayed data round-trip", False, str(exc))
        else:
            check(
                "relayed data round-trip",
                bool(reply and reply[:2] == b"\x12\x34"),
                "DNS answer through the relay" if reply else "no Data indication",
            )

        # 3 — nothing internal may be reached
        for label, peer in DENIED_PEERS:
            try:
                client.create_permission(peer)
                check(f"internal peer refused ({label})", False, f"{peer} was ALLOWED")
            except TurnError as exc:
                check(f"internal peer refused ({label})", exc.code == 403, f"{peer} → {exc}")
            except socket.timeout:
                check(f"internal peer refused ({label})", False, f"{peer} → timeout")
        # Relay-кандидат собеседника — это адрес самого coturn: когда ОБЕ стороны идут через
        # TURN (не-контакты, «Скрывать IP»), permission на собственный публичный IP обязателен,
        # иначе ICE failed (16.10.2026). Публично по UDP на хосте слушает только coturn.
        try:
            client.create_permission(socket.gethostbyname(args.host))
            check("relay host itself allowed (TURN<->TURN)", True, "permission granted")
        except TurnError as exc:
            check("relay host itself allowed (TURN<->TURN)", False, f"{exc} — relay<->relay calls will fail")
        except socket.timeout:
            check("relay host itself allowed (TURN<->TURN)", False, "timeout")
    client.close()

    # 3b — one client holds many allocations at once (quota / bandwidth-capacity check)
    if args.secret and args.parallel > 0:
        q_user, q_cred = mint_credential(args.secret, "selftest-quota", args.ttl)
        held: list[TurnClient] = []
        quota_error = ""
        for _ in range(args.parallel):
            qc = TurnClient(args.host, args.port, q_user, q_cred)
            try:
                qc.allocate(lifetime=60)
                held.append(qc)
            except (TurnError, socket.timeout) as exc:
                quota_error = str(exc)
                qc.close()
                break
        check(
            f"{args.parallel} parallel allocations for one username",
            len(held) == args.parallel,
            quota_error or f"{len(held)} allocations held, then released",
        )
        for qc in held:
            try:
                qc.release()
            except Exception:  # noqa: BLE001 — best effort cleanup
                pass
            qc.close()

    # 4 — the same credential must work over TCP (restrictive networks)
    if args.secret and not args.skip_tcp:
        tcp_user, tcp_cred = mint_credential(args.secret, "selftest-tcp", args.ttl)
        try:
            tcp = TurnClient(args.host, args.port, tcp_user, tcp_cred, transport="tcp")
        except OSError as exc:
            check("TURN over TCP allocates", False, f"connect failed: {exc}")
        else:
            try:
                relay_tcp = tcp.allocate()
                check("TURN over TCP allocates", True, f"relay {relay_tcp[0]}:{relay_tcp[1]}")
            except (TurnError, socket.timeout, OSError) as exc:
                check("TURN over TCP allocates", False, str(exc))
            tcp.close()

    # 5 — an expired credential must be rejected
    if args.secret:
        stale_user = f"{int(time.time()) - 60}:selftest"
        stale_cred = base64.b64encode(
            hmac.new(args.secret.encode(), stale_user.encode(), hashlib.sha1).digest()
        ).decode()
        stale = TurnClient(args.host, args.port, stale_user, stale_cred)
        try:
            stale.allocate()
            check("expired credential rejected", False, "allocation SUCCEEDED")
        except TurnError as exc:
            check("expired credential rejected", exc.code in (401, 403, 438), str(exc))
        except socket.timeout:
            check("expired credential rejected", True, "no response (dropped)")
        stale.close()

    # 6 — the retired static account must be dead
    if args.legacy_user:
        legacy = TurnClient(args.host, args.port, args.legacy_user, args.legacy_pass)
        try:
            legacy.allocate()
            check("legacy static account rejected", False, "allocation SUCCEEDED")
        except TurnError as exc:
            check("legacy static account rejected", exc.code in (401, 403, 438), str(exc))
        except socket.timeout:
            check("legacy static account rejected", True, "no response (dropped)")
        legacy.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("all TURN checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
