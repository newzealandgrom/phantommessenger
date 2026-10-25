"""Эталон phantom-safety-v2 (S10.2) и v1 (S3) для кросс-проверки клиентов."""
import hashlib, json, sys

def raw(first, rng):
    return bytes([0x04]) + bytes(rng)

A = raw(4, range(0x01, 0x41))          # 04 ‖ 01..40
B = raw(4, range(0x40, 0x00, -1))      # 04 ‖ 40..01
assert len(A) == 65 and len(B) == 65

def fp(k):  # S3 fingerprint
    return hashlib.sha256(k).hexdigest()[:32]

def groups(h):
    return [str(((h[2*i] << 8) | h[2*i+1]) % 100000).zfill(5) for i in range(12)]

def safety_v1(a, b):
    lo, hi = sorted([a, b])
    return groups(hashlib.sha256(b"phantom-safety-v1" + lo + hi).digest())

def lp(s):
    b = s.encode("utf-8"); assert len(b) < 256
    return bytes([len(b)]) + b

def safety_v2(n1, k1, n2, k2):
    (na, ka), (nb, kb) = sorted([(n1.encode(), k1), (n2.encode(), k2)])
    data = b"phantom-safety-v2" + b"\x00" + lp(na.decode()) + ka + lp(nb.decode()) + kb
    return groups(hashlib.sha256(data).digest()), data.hex()

assert " ".join(safety_v1(A, B)) == "41239 37345 47415 32442 40923 18939 52879 39295 25097 09299 15516 19527"

cases = []
for name, (nA, nB) in {
    "numbers_same_order_as_keys": ("1110000001", "1110000002"),
    "numbers_reverse_order_to_keys": ("1119999999", "1110000000"),
}.items():
    g1, inp = safety_v2(nA, A, nB, B)
    g2, _ = safety_v2(nB, B, nA, A)
    assert g1 == g2
    cases.append({"name": name, "numberA": nA, "numberB": nB, "input_hex": inp, "groups": " ".join(g1),
                  "qr_from_A": f"phantomsafety:2:{nA}:{fp(A)}:{nB}:{fp(B)}"})

out = {
    "spec": "S10.2 phantom-safety-v2; S10.4 QR",
    "keyA_raw65_hex": A.hex(), "keyB_raw65_hex": B.hex(),
    "fingerprintA": fp(A), "fingerprintB": fp(B),
    "safety_v1_groups": " ".join(safety_v1(A, B)),
    "v2_cases": cases,
}
json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
