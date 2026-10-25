"""Эталон meta1 (S10.1 + Q1–Q6): plaintext = 0x00 ‖ UTF-8 JSON внутри конверта v2.
Ключ/AD/номера/ключи — из documentation/protocol_v2_vector.json (from 1001 → to 1002)."""
import base64, json, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

v2 = json.load(open(sys.argv[1]))
key = bytes.fromhex(v2["intermediate"]["key_hex"])
ad = bytes.fromhex(v2["intermediate"]["ad_hex"])
eph_pub = v2["keys"]["eph_A"]["pub_b64"]
id_pub = v2["keys"]["id_A"]["pub_b64"]

def compact(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

def pad_to(obj, bucket=256):
    obj = dict(obj); obj["pad"] = ""
    while (1 + len(compact(obj))) % bucket:
        obj["pad"] += " "
    return obj

def blob(pt, n):
    nonce = bytes([n] * 12)
    c = AESGCM(key).encrypt(nonce, pt, ad)
    nb = base64.b64encode(nonce).decode()
    return {"version": 2, "senderPublicKey": eph_pub, "senderIdentityKey": id_pub,
            "nonce": nb, "iv": nb, "cipher": base64.b64encode(c).decode()}

cases = []
def add(name, outer_type, message_id, pt, expect, n):
    cases.append({"name": name, "outer": {"type": outer_type, "fromNumber": v2["from"], "messageId": message_id},
                  "encryptedBlob": blob(pt, n), "plaintext_hex": pt.hex(), "expect": expect})

text_obj = pad_to({"k": "text", "id": "m-1", "text": "привет meta1", "replyTo": {"messageId": "m-0", "from": "1002"}, "sd": 30})
add("text_reply_sd_padded", "message", "m-1", b"\x00" + compact(text_obj),
    {"action": "show", "k": "text", "id": "m-1", "text": "привет meta1", "replyTo": {"messageId": "m-0", "from": "1002"}, "sd": 30,
     "plaintext_len_multiple_of": 256}, 0x11)
add("file", "message", "m-2", b"\x00" + compact({"k": "file", "id": "m-2", "name": "photo.jpg", "mime": "image/jpeg", "size": 3, "data": "AQID"}),
    {"action": "show", "k": "file", "id": "m-2", "name": "photo.jpg", "mime": "image/jpeg", "size": 3, "data_hex": "010203"}, 0x12)
add("voice", "message", "m-3", b"\x00" + compact({"k": "voice", "id": "m-3", "mime": "audio/webm", "durMs": 1500, "data": "AAEC"}),
    {"action": "show", "k": "voice", "id": "m-3", "mime": "audio/webm", "durMs": 1500, "data_hex": "000102"}, 0x13)
add("reaction", "reaction", "m-1", b"\x00" + compact({"k": "reaction", "target": "m-1", "emoji": "👍", "remove": False}),
    {"action": "apply_reaction", "target": "m-1", "emoji": "👍", "remove": False}, 0x14)
add("edit", "message_edited", "m-1", b"\x00" + compact({"k": "text", "id": "m-1", "text": "исправлено"}),
    {"action": "edit", "id": "m-1", "text": "исправлено"}, 0x15)
add("neg_legacy_no_nul", "message", "m-4", "hello legacy".encode(),
    {"action": "show_legacy_text", "text": "hello legacy"}, 0x16)
add("neg_unknown_k", "message", "m-5", b"\x00" + compact({"k": "poll", "id": "m-5"}),
    {"action": "ignore_no_bubble"}, 0x17)
add("neg_id_mismatch", "message", "m-6", b"\x00" + compact({"k": "text", "id": "m-X", "text": "подмена id"}),
    {"action": "drop"}, 0x18)
add("neg_k_type_mismatch", "reaction", "m-1", b"\x00" + compact({"k": "text", "id": "m-1", "text": "не реакция"}),
    {"action": "drop"}, 0x19)
add("neg_bad_name", "message", "m-7", b"\x00" + compact({"k": "file", "id": "m-7", "name": "../etc/\u0001passwd", "mime": "text/plain", "size": 1, "data": "AA=="}),
    {"action": "invalid", "display": "[Некорректное сообщение]"}, 0x1a)

add("neg_bidi_name", "message", "m-8", b"\x00" + compact({"k": "file", "id": "m-8", "name": "invoice\u202efdp.exe", "mime": "application/pdf", "size": 1, "data": "AA=="}),
    {"action": "invalid", "display": "[Некорректное сообщение]"}, 0x1b)

add("reaction_zwj_emoji", "reaction", "m-1", b"\x00" + compact({"k": "reaction", "target": "m-1", "emoji": "\u2764\ufe0f\u200d\U0001f525", "remove": False}),
    {"action": "apply_reaction", "target": "m-1", "emoji": "\u2764\ufe0f\u200d\U0001f525", "remove": False}, 0x1c)

json.dump({"spec": "S10.1 meta1 + S10-ПРАВКИ Q1–Q6", "from": v2["from"], "to": v2["to"],
           "recipient_priv_hex": v2["keys"]["id_B"]["priv_hex"], "recipient_pub_b64": v2["keys"]["id_B"]["pub_b64"],
           "key_hex": key.hex(), "ad_hex": ad.hex(), "cases": cases}, sys.stdout, ensure_ascii=False, indent=1)
