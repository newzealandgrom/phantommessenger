#!/usr/bin/env python3
"""Генератор эталонов mesh wire v3 (MESH-08, MESH-10, MESH-11) → mesh_v3_vector.json.

Запуск: venv/bin/python -I documentation/mesh_v3_vector_gen.py
Спецификация: client/src/shared/mesh/wire-spec.md §7 (session_id = 0), §7.2 (Noise transport v2),
§7.3 (парольные комнаты room-v1).
"""
import hashlib
import hmac
import json
import struct
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305


def noise_nonce(counter: int) -> bytes:
    # Noise ChaChaPoly: 4 нулевых байта ‖ counter little-endian (8)
    return b"\x00" * 4 + struct.pack("<Q", counter)


def transport_v2(key: bytes, session_id: bytes, msg_type: int, counter: int, plaintext: bytes) -> bytes:
    ad = b"phantom-mesh-aead:v2\x00" + bytes([msg_type]) + session_id
    ct = ChaCha20Poly1305(key).encrypt(noise_nonce(counter), plaintext, ad)
    return struct.pack(">Q", counter) + ct


ROOM_ITERATIONS = 100_000


def room_keys(name: str, password: str) -> tuple[bytes, bytes, bytes]:
    room_key = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), b"phantom-room:v1\x00" + name.encode("utf-8"), ROOM_ITERATIONS, 32
    )
    rid = hmac.new(room_key, b"phantom-room-rid:v1", hashlib.sha256).digest()[:16]
    enc_key = hmac.new(room_key, b"phantom-room-enc:v1", hashlib.sha256).digest()
    return room_key, rid, enc_key


def room_seal(enc_key: bytes, nonce: bytes, msg_type: int, sender: bytes, rid: bytes, inner: bytes) -> bytes:
    aad = b"phantom-room-msg:v1\x00" + bytes([msg_type]) + sender + rid
    return b"\x01" + nonce + ChaCha20Poly1305(enc_key).encrypt(nonce, inner, aad)


def main() -> None:
    key = bytes(range(0x20, 0x40))
    session_id = bytes.fromhex("0102030405060708")
    pt = b'{"text":"hi","v":1}'
    transport = [
        {"type": t, "counter": c, "plaintext_hex": pt.hex(), "wire_hex": transport_v2(key, session_id, t, c, pt).hex()}
        for t, c in ((0x01, 0), (0x01, 1), (0x16, 1023), (0x01, 2**32 + 5))
    ]
    name, password = "общая", "пароль-123"
    room_key, rid, enc_key = room_keys(name, password)
    sender = bytes(range(0xA0, 0xB0))
    nonce = bytes(range(0x50, 0x5C))
    inner = '{"text":"привет","v":1}'.encode("utf-8")
    open_rid = hashlib.sha256(b"phantom-channel:" + "general".encode("utf-8")).digest()[:16]
    out = {
        "spec": "client/src/shared/mesh/wire-spec.md §7, §7.2, §7.3",
        "signature_session_id_hex": "0000000000000000",
        "transport_v2": {
            "key_hex": key.hex(),
            "session_id_hex": session_id.hex(),
            "ad_domain": "phantom-mesh-aead:v2\\x00",
            "replay_window": 1024,
            "cases": transport,
        },
        "room_v1": {
            "iterations": ROOM_ITERATIONS,
            "name": name,
            "password": password,
            "room_key_hex": room_key.hex(),
            "rid_hex": rid.hex(),
            "enc_key_hex": enc_key.hex(),
            "open_room": {"name": "general", "rid_hex": open_rid.hex()},
            "message": {
                "type": 0x12,
                "sender_hex": sender.hex(),
                "nonce_hex": nonce.hex(),
                "inner_hex": inner.hex(),
                "payload_hex": room_seal(enc_key, nonce, 0x12, sender, rid, inner).hex(),
            },
        },
    }
    path = Path(__file__).with_name("mesh_v3_vector.json")
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(path)


if __name__ == "__main__":
    main()
