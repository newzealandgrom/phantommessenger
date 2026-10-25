#!/usr/bin/env node
// Тест голосовых v2 (documentation/PROTOCOL_VOICE_V2.md) без браузера на эталоне
// documentation/voice_v2_vector.json:
//   1) wave_pack: упаковка/распаковка 100 × 5 бит ↔ 63 байта (src/lib/voiceWave.ts);
//   2) wave_compute: PCM по формуле вектора → 100 значений (|Δ| ≤ 1, ≥ 95 точных);
//   3) meta1_voice: разбор plaintext тем же парсером, что в приложении (src/lib/meta1.ts → parseMeta1):
//      wave ≠ 63 Б / не строка / не base64 игнорируется БЕЗ invalid, старшие 4 бита последнего байта обнуляются;
//   4) round-trip buildVoicePayload → parseMeta1 (wave, без wave, невалидная wave не уходит в провод);
//   5) waveBars (§3.3) и фикстуры WebM (sha256/размер) из вектора;
//   7) WaveAccumulator (инкрементальная волна записи любой длины): порции PCM → то же, что computeWave
//      целиком (в допуске округления), в т.ч. после слияний корзин и на часовом потоке с O(1) памяти;
//   8) webmOpusDurationMs: длительность по TOC пакетов без декода (эталон фикстур, порча входа);
//      + защита приёма (§5): «бомба» ≤ 256 КиБ из 1-байтных пакетов → длительность > MAX_VOICE_PLAY_MS (плеер отказывает
//      ДО декода), не-WebM → null, предел числа элементов → null (не частичная сумма);
//   6) patchWebmDuration (src/lib/webmDuration.ts): Duration = 0 (Firefox) → durMs, иначе не трогает.
// TS-модули без импортов транспилируются typescript'ом (devDependency) и грузятся как ESM.
// Запуск: node scripts/test-voice-v2.mjs, или npm run test:voice-v2.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
const docDir = resolve(clientDir, "../documentation");

async function importTs(rel) {
  const src = readFileSync(resolve(clientDir, rel), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(out).toString("base64"));
}

const W = await importTs("src/lib/voiceWave.ts");
const D = await importTs("src/lib/webmDuration.ts");
const M = await importTs("src/lib/meta1.ts");
const V = JSON.parse(readFileSync(resolve(docDir, "voice_v2_vector.json"), "utf8"));

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
}
const hex = (u8) => Buffer.from(u8).toString("hex");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ════════ 1. wave_pack ════════
check("константы: 100 корзин, 63 байта, максимум 31", W.WAVE_BARS === 100 && W.WAVE_BYTES === 63 && W.WAVE_MAX === 31);
for (const c of V.wave_pack) {
  const packed = W.packWave(c.values);
  check(`wave_pack ${c.name}: pack == hex`, hex(packed) === c.hex);
  check(`wave_pack ${c.name}: base64`, W.waveToBase64(c.values) === c.b64);
  const un = W.unpackWave(packed);
  check(`wave_pack ${c.name}: unpack == values`, JSON.stringify(un) === JSON.stringify(c.values));
  const fromB64 = W.waveFromBase64(c.b64);
  check(`wave_pack ${c.name}: waveFromBase64`, JSON.stringify(fromB64) === JSON.stringify(c.values));
}
check("unpackWave: длина ≠ 63 → null", W.unpackWave(new Uint8Array(62)) === null && W.unpackWave(new Uint8Array(64)) === null);
check("waveFromBase64: не строка / мусор → null", W.waveFromBase64(123) === null && W.waveFromBase64("!!!") === null && W.waveFromBase64(undefined) === null);

// ════════ 2. wave_compute ════════
function synthPcm(segments) {
  const out = [];
  let n = 0;
  for (const s of segments) {
    const cnt = s.ms * 48;
    for (let i = 0; i < cnt; i++) {
      if (s.amp === 0) out.push(0);
      else if (s.freqHz === 0) out.push(Math.floor(s.amp * 32767 + 0.5));
      else out.push(Math.floor(s.amp * 32767 * Math.sin((2 * Math.PI * s.freqHz * n) / 48000) + 0.5));
      n++;
    }
  }
  return out;
}
for (const c of V.wave_compute) {
  const pcm = synthPcm(c.segments);
  const raw = Buffer.alloc(pcm.length * 2);
  pcm.forEach((x, i) => raw.writeInt16LE(x, i * 2));
  check(`wave_compute ${c.name}: кадров ${c.frames}`, pcm.length === c.frames);
  check(`wave_compute ${c.name}: sha256 PCM`, sha256(raw) === c.pcm_sha256);
  const v = W.computeWave([pcm]);
  let exact = 0, maxD = 0;
  for (let i = 0; i < 100; i++) { const d = Math.abs(v[i] - c.values[i]); if (d === 0) exact++; if (d > maxD) maxD = d; }
  check(`wave_compute ${c.name}: |Δ| ≤ 1, точных ≥ 95`, maxD <= 1 && exact >= 95, `точных ${exact}/100, max|Δ| ${maxD}`);
  // Тот же PCM как float32 [-1, 1) в двух каналах (стерео-даунмикс = среднее) — масштаб не важен
  const f32 = Float32Array.from(pcm, (x) => x / 32768);
  const v2 = W.computeWave([f32, f32]);
  let maxD2 = 0;
  for (let i = 0; i < 100; i++) maxD2 = Math.max(maxD2, Math.abs(v2[i] - c.values[i]));
  check(`wave_compute ${c.name}: float32 стерео ≈ эталон`, maxD2 <= 1, `max|Δ| ${maxD2}`);
}
check("computeWave: пустой вход → нули", W.computeWave([]).every((x) => x === 0) && W.computeWave([[]]).every((x) => x === 0));
check("computeWave: тишина → нули", W.computeWave([new Float32Array(4800)]).every((x) => x === 0));

// ════════ 3. meta1_voice ════════
for (const c of V.meta1_voice) {
  const pt = Buffer.from(c.plaintext_hex, "hex").toString("utf8");
  const obj = JSON.parse(pt.slice(1));
  const r = M.parseMeta1(pt, "message", typeof obj.id === "string" ? obj.id : "v-1");
  const e = c.expect;
  if (e.action === "show") {
    const ct = r.action === "show" ? r.content : null;
    const ok = !!ct && ct.k === e.k && ct.id === e.id && ct.mime === e.mime && ct.durMs === e.durMs
      && Buffer.from(ct.data, "base64").toString("hex") === e.data_hex
      && (e.wave_hex === null ? ct.wave === undefined : !!ct.wave && hex(Buffer.from(ct.wave, "base64")) === e.wave_hex);
    check(`meta1_voice ${c.name}`, ok, ok ? "" : JSON.stringify(r).slice(0, 160));
  } else {
    check(`meta1_voice ${c.name}`, r.action === e.action, JSON.stringify(r).slice(0, 120));
  }
}

// ════════ 4. round-trip построителя ════════
{
  const values = V.wave_pack[0].values;
  const wave = W.waveToBase64(values);
  const pt = M.buildVoicePayload({ id: "m-1", mime: "audio/webm", durMs: 3000, data: "AAEC", wave });
  const r = M.parseMeta1(pt, "message", "m-1");
  check("round-trip: wave и durMs сохраняются", r.action === "show" && r.content.wave === wave && r.content.durMs === 3000);
  check("round-trip: wave в JSON — 84 символа", JSON.parse(pt.slice(1)).wave.length === 84);
  const pt2 = M.buildVoicePayload({ id: "m-2", mime: "audio/mp4", durMs: 1200, data: "AAEC" });
  const r2 = M.parseMeta1(pt2, "message", "m-2");
  check("round-trip: без wave поле отсутствует", r2.action === "show" && r2.content.wave === undefined && !("wave" in JSON.parse(pt2.slice(1))));
  const pt3 = M.buildVoicePayload({ id: "m-3", mime: "audio/webm", durMs: 1200, data: "AAEC", wave: "AAAA" });
  check("round-trip: невалидная wave не уходит в провод", !("wave" in JSON.parse(pt3.slice(1))));
  const pt4 = M.buildVoicePayload({ id: "m-4", mime: "audio/webm;codecs=opus", durMs: 1200, data: "AAEC" });
  check("mime без параметров", JSON.parse(pt4.slice(1)).mime === "audio/webm");
}

// ════════ 5. waveBars и фикстуры ════════
{
  const v = V.wave_pack.find((x) => x.name.includes("saw")) ?? V.wave_pack[V.wave_pack.length - 1];
  const b100 = W.waveBars(v.values, 100);
  check("waveBars(100) == v/31", b100.every((x, i) => Math.abs(x - v.values[i] / 31) < 1e-9));
  const b50 = W.waveBars(v.values, 50);
  check("waveBars(50): максимум по паре корзин", b50.every((x, j) => Math.abs(x - Math.max(v.values[2 * j], v.values[2 * j + 1]) / 31) < 1e-9));
  const b60 = W.waveBars(v.values, 60);
  check("waveBars(60): 60 значений в [0,1]", b60.length === 60 && b60.every((x) => x >= 0 && x <= 1));
  for (const k of ["chrome", "ref"]) {
    const f = V.webm_fixture[k];
    const buf = readFileSync(resolve(docDir, f.file));
    check(`фикстура ${f.file}: размер и sha256`, buf.length === f.size && sha256(buf) === f.sha256);
  }
}

// ════════ 7. WaveAccumulator ════════
{
  const feed = (acc, pcm, sizes) => {
    let at = 0, k = 0;
    while (at < pcm.length) { const n = Math.min(sizes[k++ % sizes.length], pcm.length - at); acc.push(pcm.subarray(at, at + n)); at += n; }
  };
  const cmp = (a, b) => { let exact = 0, maxD = 0; for (let i = 0; i < 100; i++) { const d = Math.abs(a[i] - b[i]); if (d === 0) exact++; if (d > maxD) maxD = d; } return { exact, maxD }; };
  for (const c of V.wave_compute) {
    const pcm = Float32Array.from(synthPcm(c.segments), (x) => x / 32768);
    const whole = W.computeWave([pcm]);
    for (const [rate, sizes] of [[48000, [480, 1000, 777, 2048, 13]], [44100, [441, 960, 123, 2048]]]) {
      const acc = new W.WaveAccumulator(rate);
      feed(acc, pcm, sizes);
      const got = acc.finalize();
      const { exact, maxD } = cmp(got, whole);
      // 48 кГц: границы эталонных корзин кратны мелким — точное совпадение. 44,1 кГц: границы «режут» мелкие
      // корзины; на синтетических ступеньках короче корзины волны (0,3 с, пик 10 мс) размазывание до ±5, на реальной длине — точно
      const tol = rate === 48000 ? 1 : 5;
      check(`WaveAccumulator ${c.name} @${rate}: кадров ${pcm.length}`, acc.frames === pcm.length);
      check(`WaveAccumulator ${c.name} @${rate} ≈ computeWave`, maxD <= tol && exact >= 60, `точных ${exact}/100, max|Δ| ${maxD}`);
    }
  }
  check("WaveAccumulator: пусто и тишина → нули", new W.WaveAccumulator(48000).finalize().every((x) => x === 0)
    && (() => { const a = new W.WaveAccumulator(48000); a.push(new Float32Array(10000)); return a.finalize().every((x) => x === 0); })());
  // Слияния: 3 минуты (≈ 8,6 млн кадров) с «речевой» огибающей — корзин больше 4096 → шаг удваивается
  {
    const N = 48000 * 180;
    const pcm = new Float32Array(N);
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let i = 0; i < N; i++) { const env = 0.05 + 0.9 * Math.abs(Math.sin(i / 48000 / 6.3)) * (Math.floor(i / 48000 / 2) % 3 === 0 ? 0.2 : 1); pcm[i] = env * rnd(); }
    const acc = new W.WaveAccumulator(48000);
    feed(acc, pcm, [4800, 1234, 2400]);
    const { exact, maxD } = cmp(acc.finalize(), W.computeWave([pcm]));
    check("WaveAccumulator: 3 мин со слияниями ≈ computeWave", acc.frames === N && maxD <= 1, `точных ${exact}/100, max|Δ| ${maxD}`);
  }
  // Час потоком (172,8 млн кадров) без хранения PCM: сверка с потоковым эталоном по границам §3.1, память не растёт
  {
    const N = 48000 * 3600;
    const amp = (i) => 0.02 + 0.9 * (((i / 48000 / 60) | 0) % 7) / 6;   // ступенька раз в минуту
    const acc = new W.WaveAccumulator(48000);
    const chunk = new Float32Array(4800);
    const rsq = new Float64Array(100); const cnt = new Float64Array(100);
    const bounds = Array.from({ length: 101 }, (_, i) => Math.floor((i * N) / 100));
    let bi = 0;
    for (let at = 0; at < N; at += chunk.length) {
      for (let k = 0; k < chunk.length; k++) {
        const n = at + k;
        chunk[k] = amp(n) * Math.sin(n * 2 * Math.PI * 1000 / 48000);
        while (n >= bounds[bi + 1]) bi++;
        rsq[bi] += chunk[k] * chunk[k]; cnt[bi]++;
      }
      acc.push(chunk);
    }
    const ref = Array.from(rsq, (e, i) => Math.sqrt(e / cnt[i]));
    const peak = Math.max(...ref);
    const want = ref.map((r) => Math.min(31, Math.floor((r / peak) * 31 + 0.5)));
    const { exact, maxD } = cmp(acc.finalize(), want);
    // Ступеньки раз в минуту — худший случай для равномерной плотности внутри мелкой корзины: допуск ±2
    check("WaveAccumulator: 1 час потоком ≈ эталон", acc.frames === N && maxD <= 2, `точных ${exact}/100, max|Δ| ${maxD}`);
    // Память O(1): хранилище фиксировано (4096 × float64), закрытых корзин меньше предела при любой длительности
    check("WaveAccumulator: память не зависит от длительности (≤ 4096 мелких корзин)", acc.bins.length === 4096 && acc.closed < 4096,
      `закрыто ${acc.closed}, шаг ${acc.binFrames} кадров`);
  }
}

// ════════ 6. patchWebmDuration ════════
{
  const ref = new Uint8Array(readFileSync(resolve(docDir, "fixtures/voice_v2_ref.webm")));
  const chrome = new Uint8Array(readFileSync(resolve(docDir, "fixtures/voice_chrome_opus_5s.webm")));
  check("patchWebmDuration: Duration уже задана (ref) → null", D.patchWebmDuration(ref, 5000) === null);
  check("patchWebmDuration: нет Duration (Chrome) → null", D.patchWebmDuration(chrome, 5000) === null);
  // «Firefox»: обнуляем Duration (ID 44 89, размер 0x88 = float64) в Info эталона
  let at = -1;
  for (let i = 0; i < 128; i++) if (ref[i] === 0x44 && ref[i + 1] === 0x89 && ref[i + 2] === 0x88) { at = i + 3; break; }
  check("ref содержит Info/Duration float64", at > 0);
  const ff = ref.slice();
  new DataView(ff.buffer).setFloat64(at, 0, false);
  const fixed = D.patchWebmDuration(ff, 3034);
  check("patchWebmDuration: Duration=0 → durMs (TimecodeScale 1 мс)", !!fixed && new DataView(fixed.buffer).getFloat64(at, false) === 3034);
  check("patchWebmDuration: правка на месте (длина и прочие байты те же)", !!fixed && fixed.length === ff.length
    && fixed.every((b, i) => (i >= at && i < at + 8) || b === ff[i]));
  check("patchWebmDuration: исходный буфер не изменён", new DataView(ff.buffer).getFloat64(at, false) === 0);
  check("patchWebmDuration: durMs ≤ 0 / NaN → null", D.patchWebmDuration(ff, 0) === null && D.patchWebmDuration(ff, NaN) === null);
  check("patchWebmDuration: не WebM → null", D.patchWebmDuration(new Uint8Array(64), 1000) === null);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  // webmOpusDurationMs: фикстуры вектора (83 пакета × 60 мс, pre_skip 0 → 4980 мс)
  check("webmOpusDurationMs: Chrome-фикстура = 4980", D.webmOpusDurationMs(chrome) === Math.round(V.webm_fixture.chrome.frames48 / 48));
  check("webmOpusDurationMs: ref-фикстура = duration_ms", D.webmOpusDurationMs(ref) === V.webm_fixture.ref.duration_ms);
  check("webmOpusDurationMs: не WebM → null", D.webmOpusDurationMs(new Uint8Array(64)) === null);
  check("webmOpusDurationMs: усечённый файл → null или меньшая длительность без исключений", (() => {
    try { const r = D.webmOpusDurationMs(chrome.slice(0, 5000)); return r === null || (r > 0 && r < 4980); } catch { return false; }
  })());
  let threw2 = 0;
  for (const src of [ref, chrome]) {
    for (let n = 0; n < 600; n += 3) { try { D.webmOpusDurationMs(src.slice(0, n)); } catch { threw2++; } }
    for (let k = 0; k < 400; k++) {
      const m = src.slice();
      for (let j = 0; j < 6; j++) m[rnd() % 700] = rnd() & 0xff;
      try { D.webmOpusDurationMs(m); } catch { threw2++; }
    }
  }
  check("webmOpusDurationMs: усечения и порча заголовков без исключений", threw2 === 0, `исключений ${threw2}`);
  // Защита приёма (§5): бомба из 1-байтных пакетов (TOC 0x58 = SILK 60 мс) укладывается в кадр relay,
  // но TOC выдаёт реальную длительность задолго до декода
  {
    const seg = [0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    const cluster = [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    // Tracks{TrackEntry{CodecPrivate = OpusHead(19 Б)}}: враждебный файл может быть «правильным» по структуре
    const opusHead = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0];
    const tracks = [0x16, 0x54, 0xae, 0x6b, 0x98, 0xae, 0x96, 0x63, 0xa2, 0x93, ...opusHead];
    const head = [...seg, ...tracks, ...cluster];
    const blk = [0xa3, 0x85, 0x81, 0x00, 0x00, 0x80, 0x58];
    const maxBytes = 262144;
    const n = Math.floor((maxBytes - head.length) / blk.length);
    const bomb = new Uint8Array(head.length + n * blk.length);
    bomb.set(head, 0);
    for (let i = 0; i < n; i++) bomb.set(blk, head.length + i * blk.length);
    const ms = D.webmOpusDurationMs(bomb);
    check("бомба под 256 КиБ: размер ≤ кадра relay", bomb.length <= maxBytes, `${bomb.length} Б`);
    check("бомба под 256 КиБ → длительность по TOC > MAX_VOICE_PLAY_MS (отказ до декода)", ms !== null && ms > D.MAX_VOICE_PLAY_MS, `${ms} мс`);
    // Без CodecPrivate/OpusHead (один блок из TOC) — не WebM/Opus: null, а не 60 мс
    const noHead = Uint8Array.from([...seg, ...cluster, ...blk]);
    check("без OpusHead → null (даже с валидным блоком)", D.webmOpusDurationMs(noHead) === null);
    check("MAX_VOICE_PLAY_MS = 300 000 (§5)", D.MAX_VOICE_PLAY_MS === 300000);
    check("обычные фикстуры укладываются в MAX_VOICE_PLAY_MS", D.webmOpusDurationMs(chrome) <= D.MAX_VOICE_PLAY_MS && D.webmOpusDurationMs(ref) <= D.MAX_VOICE_PLAY_MS);
    // Не-WebM (m4a/ogg по сигнатуре) → null: плеер отказывает
    const m4a = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, ...new Array(40).fill(0)]);
    const ogg = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, ...new Array(60).fill(0)]);
    check("не-WebM (mp4/ogg) → null", D.webmOpusDurationMs(m4a) === null && D.webmOpusDurationMs(ogg) === null);
    // Предел числа элементов: > 600 000 пустых Void (EC 80) → null, а не урезанная сумма
    const many = new Uint8Array(head.length + 700_000 * 2 + blk.length * 10);
    many.set(head, 0);
    let at = head.length;
    for (let i = 0; i < 10; i++) { many.set(blk, at); at += blk.length; }
    for (let i = 0; i < 700_000; i++) { many[at++] = 0xec; many[at++] = 0x80; }
    check("предел числа элементов → null (не частичная сумма)", D.webmOpusDurationMs(many.subarray(0, at)) === null);
    // Ложный durMs не влияет: длительность берётся из файла (3 с файл, «30 с» от отправителя)
    check("длительность файла из TOC не зависит от заявленной", D.webmOpusDurationMs(chrome) === 4980);
  }
  // Устойчивость: усечения и случайные порчи не бросают исключений и не читают за буфером
  let threw = 0;
  for (let n = 0; n < ff.length; n += 7) { try { D.patchWebmDuration(ff.slice(0, n), 3034); } catch { threw++; } }
  for (let k = 0; k < 400; k++) {
    const m = ff.slice(0, 200);
    for (let j = 0; j < 4; j++) m[rnd() % m.length] = rnd() & 0xff;
    try { D.patchWebmDuration(m, 3034); } catch { threw++; }
  }
  check("patchWebmDuration: усечённые/испорченные входы без исключений", threw === 0, `исключений ${threw}`);
}

console.log(failed ? `\n${failed} FAIL` : "\nвсе проверки пройдены");
process.exit(failed ? 1 : 0);
