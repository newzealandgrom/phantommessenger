#!/usr/bin/env python3
"""Эталоны анонимного mesh: phantom_id v3 (§5) и конверт моста v2 (§9.2) → mesh_bridge_v2_vector.json.

Запуск: venv/bin/python -I documentation/mesh_bridge_v2_vector_gen.py
Relay-тест (scripts/test_relay_mesh_fixes.py) вскрывает `sealed_hex` кодом relay с сидом `relay_seed_hex`.
"""
import base64
import hashlib
import hmac
import json
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

RAW = (serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def hkdf32(ikm: bytes, salt: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt or None, info=info).derive(ikm)


def phantom_id_v3(signing_pub: bytes, static_pub: bytes) -> bytes:
    return hashlib.sha256(b"phantom-mesh-id:v3\x00" + signing_pub + static_pub).digest()[:16]


def lp(raw: bytes) -> bytes:
    return len(raw).to_bytes(2, "big") + raw


def main() -> None:
    signing_pub = Ed25519PrivateKey.from_private_bytes(bytes([0x11] * 32)).public_key().public_bytes(*RAW)
    static_pub = X25519PrivateKey.from_private_bytes(bytes([0x22] * 32)).public_key().public_bytes(*RAW)

    relay_seed = bytes([0x42] * 32)
    box_sk = X25519PrivateKey.from_private_bytes(hkdf32(relay_seed, b"", b"phantom-relay-box:v1"))
    box_pub = box_sk.public_key().public_bytes(*RAW)
    bridge_secret = hkdf32(relay_seed, b"", b"phantom-bridge-secret:v1")

    frm, to, msg_id = "1110000001", "1110000002", "m-0001"
    ts_ms, epoch = 1791936000123, 20740
    bridge_key = hmac.new(
        bridge_secret, b"phantom-bridge-key:v1\x00" + frm.encode() + epoch.to_bytes(4, "big"), hashlib.sha256
    ).digest()
    blob = '{"version":1,"senderPublicKey":"BAAA","iv":"AAAAAAAAAAAAAAAA","nonce":"AAAAAAAAAAAAAAAA","cipher":"Y2lwaGVy/w=="}'
    mac_input = (
        b"phantom-bridge-env:v2\x00" + lp(frm.encode()) + lp(to.encode()) + lp(msg_id.encode())
        + ts_ms.to_bytes(8, "big") + epoch.to_bytes(4, "big") + hashlib.sha256(blob.encode()).digest()
    )
    mac = hmac.new(bridge_key, mac_input, hashlib.sha256).digest()
    inner = json.dumps(
        {"v": 2, "from": frm, "to": to, "messageId": msg_id, "ts": ts_ms, "epoch": epoch, "blob": blob,
         "mac": base64.b64encode(mac).decode()},
        separators=(",", ":"),
    ).encode()

    eph_secret = bytes([0x33] * 32)
    eph = X25519PrivateKey.from_private_bytes(eph_secret)
    eph_pub = eph.public_key().public_bytes(*RAW)
    seal_key = hkdf32(eph.exchange(X25519PublicKey.from_public_bytes(box_pub)), eph_pub + box_pub, b"phantom-bridge-seal:v2")
    sealed = b"\x02" + eph_pub + ChaCha20Poly1305(seal_key).encrypt(b"\x00" * 12, inner, b"phantom-bridge-seal:v2\x00" + eph_pub)

    out = {
        "spec": "client/src/shared/mesh/wire-spec.md §5 (phantom_id v3), §9.2 (bridge v2)",
        "phantom_id_v3": {
            "signing_pub_hex": signing_pub.hex(),
            "static_pub_hex": static_pub.hex(),
            "id_hex": phantom_id_v3(signing_pub, static_pub).hex(),
        },
        "bridge_v2": {
            "relay_seed_hex": relay_seed.hex(),
            "relay_box_pub_hex": box_pub.hex(),
            "from": frm,
            "to": to,
            "messageId": msg_id,
            "ts": ts_ms,
            "epoch": epoch,
            "bridge_key_b64": base64.b64encode(bridge_key).decode(),
            "blob": blob,
            "mac_input_hex": mac_input.hex(),
            "mac_b64": base64.b64encode(mac).decode(),
            "inner_hex": inner.hex(),
            "eph_secret_hex": eph_secret.hex(),
            "eph_pub_hex": eph_pub.hex(),
            "seal_key_hex": seal_key.hex(),
            "sealed_hex": sealed.hex(),
        },
    }
    path = Path(__file__).with_name("mesh_bridge_v2_vector.json")
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(path)


if __name__ == "__main__":
    main()
