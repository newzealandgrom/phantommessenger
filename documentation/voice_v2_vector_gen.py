"""Эталон голосовых v2 (documentation/PROTOCOL_VOICE_V2.md): только stdlib, детерминированный.

Запуск (из любого каталога):  python3 -I documentation/voice_v2_vector_gen.py
Читает  documentation/fixtures/voice_chrome_opus_5s.webm (Chrome MediaRecorder, 5 с),
пишет   documentation/fixtures/voice_v2_ref.webm (канонический муксер §2.3)
        documentation/voice_v2_vector.json.
Повторный запуск даёт побайтно тот же результат.
"""
import base64, hashlib, json, math, os, struct

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "fixtures", "voice_chrome_opus_5s.webm")
REF = os.path.join(HERE, "fixtures", "voice_v2_ref.webm")
OUT = os.path.join(HERE, "voice_v2_vector.json")

# ---------- EBML: чтение ----------

def _vint(b, p, keep):
    f = b[p]
    n = 1
    while n <= 8 and not (f & (0x80 >> (n - 1))):
        n += 1
    if n > 8:
        raise ValueError("bad vint")
    v = f if keep else (f & (0xFF >> n))
    unknown = (f & (0xFF >> n)) == (0xFF >> n)
    for i in range(1, n):
        v = (v << 8) | b[p + i]
        if b[p + i] != 0xFF:
            unknown = False
    return v, n, (unknown and not keep)

MASTERS = {0x18538067, 0x1654AE6B, 0xAE, 0xE1, 0x1F43B675, 0xA0, 0x1549A966}

def parse_webm(b):
    """-> dict(packets=[bytes], clusters=int, channels, pre_skip, tracks=int, a_opus=int)."""
    r = {"packets": [], "clusters": 0, "tracks": 0, "a_opus": 0, "channels": None, "pre_skip": None}
    def walk(p, end):
        while p < end:
            eid, l1, _ = _vint(b, p, True); p += l1
            size, l2, unk = _vint(b, p, False); p += l2
            e = end if unk else min(end, p + size)
            if eid in MASTERS:
                if eid == 0x1F43B675: r["clusters"] += 1
                if eid == 0xAE: r["tracks"] += 1
                walk(p, e)
            elif eid in (0xA3, 0xA1):
                _, l3, _ = _vint(b, p, False)
                r["packets"].append(bytes(b[p + l3 + 3:e]))
            elif eid == 0x86 and b[p:e] == b"A_OPUS":
                r["a_opus"] += 1
            elif eid == 0x63A2:
                cp = b[p:e]
                r["channels"] = cp[9]
                r["pre_skip"] = struct.unpack("<H", cp[10:12])[0]
            p = e
    walk(0, len(b))
    return r

def toc_frames48(pkt):
    """Длительность Opus-пакета в кадрах 48 кГц по TOC (RFC 6716 §3.1)."""
    toc = pkt[0]; cfg = toc >> 3; code = toc & 3
    if cfg < 12: fs = (480, 960, 1920, 2880)[cfg & 3]
    elif cfg < 16: fs = (480, 960)[cfg & 1]
    else: fs = (120, 240, 480, 960)[cfg & 3]
    n = 1 if code == 0 else 2 if code in (1, 2) else (pkt[1] & 0x3F)
    return fs * n

# ---------- EBML: запись (канонический муксер §2.3) ----------

def vsize(n):
    for l in range(1, 9):
        if n < (1 << (7 * l)) - 1:
            return (n | (1 << (7 * l))).to_bytes(l, "big")
    raise ValueError

def eid(i):
    return i.to_bytes((i.bit_length() + 7) // 8, "big")

def el(i, payload):
    return eid(i) + vsize(len(payload)) + payload

def uint(i, v):
    return el(i, v.to_bytes(max(1, (v.bit_length() + 7) // 8), "big"))

def mux_webm(packets, channels=1, pre_skip=0):
    frames = [toc_frames48(p) for p in packets]
    total = sum(frames)
    ebml = el(0x1A45DFA3, uint(0x4286, 1) + uint(0x42F7, 1) + uint(0x42F2, 4) + uint(0x42F3, 8)
              + el(0x4282, b"webm") + uint(0x4287, 4) + uint(0x4285, 2))
    info = el(0x1549A966, uint(0x2AD7B1, 1000000) + el(0x4489, struct.pack(">d", total / 48.0))
              + el(0x4D80, b"phantom") + el(0x5741, b"phantom"))
    head = (b"OpusHead" + bytes([1, channels]) + struct.pack("<HIhB", pre_skip, 48000, 0, 0))
    track = el(0xAE, uint(0xD7, 1) + uint(0x73C5, 1) + uint(0x83, 2) + uint(0x9C, 0)
               + el(0x86, b"A_OPUS") + uint(0x56AA, pre_skip * 1000000000 // 48000)
               + uint(0x56BB, 80000000) + el(0x63A2, head)
               + el(0xE1, el(0xB5, struct.pack(">f", 48000.0)) + uint(0x9F, channels)))
    tracks = el(0x1654AE6B, track)
    clusters = []
    cur_ts = None; cur = b""
    before = 0
    for pkt, fr in zip(packets, frames):
        ts = before // 48
        if cur_ts is None or ts - cur_ts >= 5000:
            if cur_ts is not None:
                clusters.append(el(0x1F43B675, uint(0xE7, cur_ts) + cur))
            cur_ts = ts; cur = b""
        cur += el(0xA3, b"\x81" + struct.pack(">hB", ts - cur_ts, 0x80) + pkt)
        before += fr
    if cur_ts is not None:
        clusters.append(el(0x1F43B675, uint(0xE7, cur_ts) + cur))
    body = info + tracks + b"".join(clusters)
    seg = eid(0x18538067) + bytes([0x01]) + len(body).to_bytes(7, "big") + body
    return ebml + seg, total

# ---------- Волна (§3) ----------

def wave_compute(samples):
    n = len(samples); k = 100
    rms = []
    for i in range(k):
        a = i * n // k; b = (i + 1) * n // k
        rms.append(math.sqrt(sum(float(x) * x for x in samples[a:b]) / (b - a)) if b > a else 0.0)
    peak = max(rms)
    if peak <= 0:
        return [0] * k, rms, peak
    return [min(31, int(math.floor(r / peak * 31 + 0.5))) for r in rms], rms, peak

def wave_pack(v):
    out = bytearray(63)
    for i, x in enumerate(v):
        bp = 5 * i; by = bp >> 3; sh = bp & 7
        out[by] |= (x << sh) & 0xFF
        if sh > 3: out[by + 1] |= x >> (8 - sh)
    return bytes(out)

def wave_unpack(b):
    return [(((b[(5 * i) >> 3]) | ((b[((5 * i) >> 3) + 1] << 8) if ((5 * i) >> 3) + 1 < 63 else 0)) >> ((5 * i) & 7)) & 31
            for i in range(100)]

def synth_pcm(segments):
    out = []; n = 0
    for s in segments:
        cnt = s["ms"] * 48
        for _ in range(cnt):
            if s["amp"] == 0: out.append(0)
            elif s["freqHz"] == 0: out.append(int(math.floor(s["amp"] * 32767 + 0.5)))  # постоянная составляющая
            else: out.append(int(math.floor(s["amp"] * 32767 * math.sin(2 * math.pi * s["freqHz"] * n / 48000) + 0.5)))
            n += 1
    return out

def margin_ok(rms, peak):
    """Запас ≥ 0,05 от границы округления (…,5) для каждого значения (кроме 0-пика)."""
    if peak <= 0: return True
    for r in rms:
        t = r / peak * 31
        if t < 31 and abs((t % 1.0) - 0.5) < 0.05: return False
    return True

def b64(b): return base64.b64encode(b).decode()
def compact(o): return json.dumps(o, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

def main():
    src = open(SRC, "rb").read()
    p = parse_webm(src)
    assert p["a_opus"] == 1 and p["tracks"] == 1 and len(p["packets"]) == 83
    ref, ref_frames = mux_webm(p["packets"], p["channels"], p["pre_skip"])
    open(REF, "wb").write(ref)
    q = parse_webm(ref)
    assert q["packets"] == p["packets"] and q["clusters"] == 1

    # wave_pack
    saw = [i % 32 for i in range(100)]
    pack_cases = [("example_31_0_1_2_3", [31, 0, 1, 2, 3] + [0] * 95), ("all_31", [31] * 100),
                  ("all_0", [0] * 100), ("saw_0_31", saw), ("alt_31_0", [31 if i % 2 == 0 else 0 for i in range(100)]),
                  ("last_31", [0] * 99 + [31])]
    wave_pack_cases = []
    for name, v in pack_cases:
        pk = wave_pack(v); assert wave_unpack(pk) == v and pk[62] >> 4 == 0
        wave_pack_cases.append({"name": name, "values": v, "hex": pk.hex(), "b64": b64(pk)})
    assert wave_pack_cases[0]["hex"].startswith("1f0431") and len(wave_pack_cases[0]["b64"]) == 84

    # wave_compute (тона 1000 Гц: период 48 кадров, корзины кратны периодам → RMS стабилен; непрерывный индекс n по всему PCM; round = floor(x + 0.5))
    wc = [
        ("tone_300ms", [{"ms": 150, "amp": 0.2, "freqHz": 1000}, {"ms": 150, "amp": 0.7, "freqHz": 1000}]),
        ("silence_1000ms", [{"ms": 1000, "amp": 0, "freqHz": 0}]),
        ("single_peak_10ms", [{"ms": 500, "amp": 0, "freqHz": 0}, {"ms": 10, "amp": 1.0, "freqHz": 1000},
                              {"ms": 490, "amp": 0, "freqHz": 0}]),
        ("ramp_5012ms", [{"ms": 1000, "amp": 0.1, "freqHz": 1000}, {"ms": 1000, "amp": 0.3, "freqHz": 1000},
                         {"ms": 1000, "amp": 0.9, "freqHz": 1000}, {"ms": 1000, "amp": 0.0, "freqHz": 0},
                         {"ms": 1000, "amp": 0.6, "freqHz": 1000}, {"ms": 12, "amp": 0.6, "freqHz": 1000}]),
        ("short_1ms_empty_bins", [{"ms": 1, "amp": 0.5, "freqHz": 0}]),
    ]
    compute_cases = []
    for name, segs in wc:
        pcm = synth_pcm(segs)
        v, rms, peak = wave_compute(pcm)
        assert margin_ok(rms, peak), (name, [round(r / peak * 31 % 1, 3) for r in rms])
        raw = b"".join(struct.pack("<h", x) for x in pcm)
        compute_cases.append({"name": name, "segments": segs, "frames": len(pcm),
                              "pcm_sha256": hashlib.sha256(raw).hexdigest(),
                              "values": v, "hex": wave_pack(v).hex()})

    # meta1_voice
    saw_b64 = b64(wave_pack(saw))
    def case(name, obj, expect):
        pt = b"\x00" + compact(obj)
        return {"name": name, "plaintext_hex": pt.hex(), "expect": expect}
    base = {"k": "voice", "id": "v-1", "mime": "audio/webm", "durMs": 5012, "data": "AAEC"}
    show = {"action": "show", "k": "voice", "id": "v-1", "mime": "audio/webm", "durMs": 5012, "data_hex": "000102"}
    def with_wave(w): d = dict(base); d["wave"] = w; return d
    meta1 = [
        case("v2_ok", with_wave(saw_b64), dict(show, wave_hex=wave_pack(saw).hex())),
        case("v2_wave_62b", with_wave(b64(bytes(62))), dict(show, wave_hex=None)),
        case("v2_wave_64b", with_wave(b64(bytes(64))), dict(show, wave_hex=None)),
        case("v2_wave_not_base64", with_wave("!!not-base64!!"), dict(show, wave_hex=None)),
        case("v2_wave_not_string", with_wave(123), dict(show, wave_hex=None)),
        case("v2_wave_high_bits_ignored", with_wave(b64(wave_pack(saw)[:62] + bytes([wave_pack(saw)[62] | 0xF0]))),
             dict(show, wave_hex=wave_pack(saw).hex())),
        case("legacy_m4a_no_wave", dict(base, mime="audio/mp4"), dict(show, mime="audio/mp4", wave_hex=None)),
        case("bad_dur", dict(base, durMs=3600001), {"action": "invalid"}),
    ]

    chrome_sha = hashlib.sha256(src).hexdigest()
    doc = {
        "spec": "PROTOCOL_VOICE_V2 (голосовые v2: WebM/Opus + wave в meta1 k:voice)",
        "generator": "documentation/voice_v2_vector_gen.py",
        "note": "meta1_voice — plaintext-кейсы (0x00 ‖ JSON) без шифрования; конверт покрыт meta1_vector.json. "
                "wave_hex: hex 63 байт или null (поле игнорируется). Для wave_compute допускается |Δ| ≤ 1 на значение, ≥ 95 из 100 точных.",
        "wave_pack": wave_pack_cases,
        "wave_compute": compute_cases,
        "meta1_voice": meta1,
        "webm_fixture": {
            "chrome": {"file": "fixtures/voice_chrome_opus_5s.webm", "sha256": chrome_sha, "size": len(src),
                       "packets": len(p["packets"]), "clusters": p["clusters"], "channels": p["channels"],
                       "pre_skip": p["pre_skip"], "frames48": sum(toc_frames48(x) for x in p["packets"]),
                       "decoded_ms_min": 4900, "decoded_ms_max": 5100},
            "ref": {"file": "fixtures/voice_v2_ref.webm", "sha256": hashlib.sha256(ref).hexdigest(), "size": len(ref),
                    "packets": len(q["packets"]), "clusters": q["clusters"], "channels": q["channels"],
                    "pre_skip": q["pre_skip"], "frames48": ref_frames, "duration_ms": ref_frames / 48.0,
                    "muxing_app": "phantom", "track_uid": 1,
                    "packet_sha256": hashlib.sha256(b"".join(q["packets"])).hexdigest()},
        },
        "encoder_roundtrip": {
            "pcm_ms": 3000, "max_bytes": 12000, "decoded_ms_min": 2940, "decoded_ms_max": 3060,
            "durMs": 3000, "wave_tolerance": 2,
            "note": "только требования: платформенный энкодер из синтетического PCM; байты не сравниваются",
        },
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")

if __name__ == "__main__":
    main()
