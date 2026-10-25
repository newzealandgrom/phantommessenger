#!/usr/bin/env node
// Тест P2P files_v1 web (documentation/PROTOCOL_P2P_V2.md §4, §9) без браузера:
//   (а) расшифровка file_offer эталона НАСТОЯЩИМ public/sw.js (+ envelope-v2.js) ключом id_B
//       и разбор ТЕМ ЖЕ парсером, что в приложении (src/lib/p2pFile.ts → parseFileOffer);
//       построитель buildFileOfferPlaintext побайтово = plaintext_hex;
//   (б) кадры 0..2 побайтово при заданных key/nonceBase (encryptFileChunk), nonce/AD;
//       64 КиБ нулевой чанк — длина и sha256 кадра;
//   (в) приём ТЕМ ЖЕ FileReceiver, что в App.tsx: parseFileFrame → push → finish (n чанков + sha256);
//       отправка ТЕМ ЖЕ sendFileChunks (File.slice блоками, backpressure по bufferedAmount) → FileReceiver;
//   (г) негативы: чужой ctr, чужой fileId, переставленные номера → GCM fail;
//       усечённая передача (2 чанка + file_end) → protocol; невалидные file_offer → invalid.
// Модули транспилируются typescript'ом (devDependency) и грузятся как ESM.
// Запуск: node scripts/test-p2p-file.mjs (Node 20+), или npm run test:p2p-file.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
const docDir = resolve(clientDir, "../documentation");

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

function transpile(rel) {
  const src = readFileSync(resolve(clientDir, rel), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  }).outputText;
}
const dataUrl = (js) => "data:text/javascript;base64," + Buffer.from(js).toString("base64");

// p2pFile.ts импортирует ./meta1 и @noble/hashes — подменяем спецификаторы на загружаемые URL
const meta1Url = dataUrl(transpile("src/lib/meta1.ts"));
const nobleUrl = pathToFileURL(resolve(clientDir, "node_modules/@noble/hashes/sha2.js")).href;
const p2pSrc = transpile("src/lib/p2pFile.ts")
  .replace(/from\s+["']\.\/meta1["']/, `from "${meta1Url}"`)
  .replace(/from\s+["']@noble\/hashes\/sha2\.js["']/, `from "${nobleUrl}"`);
const P = await import(dataUrl(p2pSrc));

// ── Окружение SW (как в test-envelope-v2.mjs) ──
globalThis.self = globalThis;
globalThis.addEventListener = () => {};
globalThis.importScripts = (p) => {
  const file = resolve(clientDir, "public", String(p).replace(/^\//, ""));
  vm.runInThisContext(readFileSync(file, "utf8"), { filename: file });
};
vm.runInThisContext(readFileSync(resolve(clientDir, "public/sw.js"), "utf8"), { filename: "sw.js" });

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
}
async function expectThrow(label, fn) {
  try {
    const r = await fn();
    check(label, false, `ожидалась ошибка, получено ${r && r.length !== undefined ? `${r.length} байт` : JSON.stringify(r)}`);
  } catch (e) {
    check(label, true, `ошибка: ${e?.name || ""}`.trim());
  }
}
const hex = (u8) => Buffer.from(u8).toString("hex");
const fromHex = (h) => new Uint8Array(Buffer.from(h, "hex"));
const b64url = (u8) => Buffer.from(u8).toString("base64url");
const subtle = globalThis.crypto.subtle;

const F = JSON.parse(readFileSync(resolve(docDir, "p2p_file_vector.json"), "utf8"));
const V2 = JSON.parse(readFileSync(resolve(docDir, "protocol_v2_vector.json"), "utf8"));
const FROM = F.from, TO = F.to;
const fileId = fromHex(F.params.fileId_hex);
const keyRaw = fromHex(F.params.key_hex);
const nonceBase = fromHex(F.params.nonceBase_hex);
const chunk = F.params.chunk;
const plain = fromHex(F.file.plaintext_hex);
const key = await P.importFileKey(keyRaw);

// ════════ (а) file_offer ════════
{
  const kB = V2.keys.id_B;
  const privB = await subtle.importKey(
    "jwk", { kty: "EC", crv: "P-256", d: b64url(fromHex(kB.priv_hex)), x: kB.x, y: kB.y, ext: false },
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
  );
  const ownB = { privateKey: privB, publicKey: kB.pub_b64 };
  const wire = F.file_offer.wire;
  let pt = null;
  try { pt = await globalThis._decrypt(wire.encryptedBlob, FROM, TO, ownB); }
  catch (e) { check("file_offer: расшифровка sw.js ключом id_B", false, e?.message); }
  if (pt !== null) {
    check("file_offer: расшифровка sw.js ключом id_B", true);
    check("file_offer: plaintext побайтово = plaintext_hex", hex(Buffer.from(pt, "utf8")) === F.file_offer.plaintext_hex);
    const r = P.parseFileOffer(pt, wire.messageId, wire.fileId);
    const exp = F.file_offer.plaintext_json;
    check("file_offer: parseFileOffer ok", r.ok === true, r.ok ? "" : r.reason);
    if (r.ok) {
      const o = r.offer;
      check("file_offer: поля", o.id === exp.id && o.fileIdHex === exp.fileId && o.name === exp.name && o.mime === exp.mime
        && o.size === exp.size && o.sha256 === exp.sha256 && o.chunk === exp.chunk && o.text === exp.text
        && hex(o.key) === F.params.key_hex && hex(o.nonceBase) === F.params.nonceBase_hex);
      // Построитель приложения → тот же plaintext
      const built = P.buildFileOfferPlaintext(o);
      check("buildFileOfferPlaintext побайтово = plaintext_hex", hex(Buffer.from(built, "utf8")) === F.file_offer.plaintext_hex);
    }
    // Q3/Q4: перестановка внешних полей и порча внутренних
    check("file_offer: чужой внешний messageId → invalid", !P.parseFileOffer(pt, "f-2", wire.fileId).ok);
    check("file_offer: чужой внешний fileId → invalid", !P.parseFileOffer(pt, wire.messageId, "ffeeddccbbaa99887766554433221100").ok);
    const mut = (patch) => "\u0000" + JSON.stringify({ ...exp, ...patch });
    const bad = [
      ["k=file", { k: "file" }], ["имя с /", { name: "../x" }], ["имя с bidi", { name: "a‮b" }],
      ["mime без /", { mime: "text" }], ["size 0", { size: 0 }], ["size дробный", { size: 1.5 }],
      ["key 31 Б", { key: Buffer.alloc(31).toString("base64") }], ["nonceBase 12 Б", { nonceBase: Buffer.alloc(12).toString("base64") }],
      ["chunk 0", { chunk: 0 }], ["chunk 65537", { chunk: 65537 }], ["sha256 короткий", { sha256: "00" }],
      ["fileId верхний регистр", { fileId: exp.fileId.toUpperCase() }],
    ];
    for (const [label, patch] of bad) {
      check(`file_offer негатив: ${label} → invalid`, !P.parseFileOffer(mut(patch), wire.messageId, wire.fileId).ok);
    }
    check("file_offer негатив: без NUL → invalid", !P.parseFileOffer(JSON.stringify(exp), wire.messageId, wire.fileId).ok);
  }
}

// ════════ (б) кадры 0..2 побайтово ════════
check("chunkCount(40,16) = 3", P.chunkCount(F.file.size, chunk) === F.params.chunk_count);
for (const c of F.chunks) {
  check(`чанк ${c.ctr}: nonce`, hex(P.fileNonce(nonceBase, c.ctr)) === c.nonce_hex);
  check(`чанк ${c.ctr}: AD`, hex(P.fileAd(FROM, TO, fileId, c.ctr)) === c.ad_hex);
  const pt = plain.subarray(c.ctr * chunk, c.ctr * chunk + P.chunkPlainLen(F.file.size, chunk, c.ctr));
  check(`чанк ${c.ctr}: plaintext`, hex(pt) === c.plaintext_hex);
  const frame = await P.encryptFileChunk({ key, nonceBase, fileId, ctr: c.ctr, plaintext: pt, from: FROM, to: TO });
  check(`чанк ${c.ctr}: кадр побайтово (${c.frame_len} Б)`, hex(frame) === c.frame_hex && frame.length === c.frame_len);
}
{
  const big = await P.encryptFileChunk({ key, nonceBase, fileId, ctr: 0, plaintext: new Uint8Array(65536), from: FROM, to: TO });
  check("64 КиБ нулевой чанк: длина кадра 65 572", big.length === F.chunk_64k_zero.frame_len && big.length === P.FILE_FRAME_MAX);
  check("64 КиБ нулевой чанк: sha256 кадра", createHash("sha256").update(big).digest("hex") === F.chunk_64k_zero.frame_sha256_hex);
  check("parseFileFrame: 64 КиБ кадр принимается", P.parseFileFrame(big) !== null);
  check("parseFileFrame: кадр > 65 572 Б → дроп", P.parseFileFrame(new Uint8Array(P.FILE_FRAME_MAX + 1)) === null);
  check("parseFileFrame: кадр < 36 Б → дроп", P.parseFileFrame(new Uint8Array(35)) === null);
}

// ════════ (в) приём: тот же FileReceiver, что в App.tsx (ожидаемый ctr, длина, sha256) ════════
// Возвращает { ok, reason, bytes } — reason как у file_abort.
async function receive(frames, { size, chunk: ch, sha256: want, from = FROM, to = TO, fid = F.params.fileId_hex, end = true }) {
  const rx = new P.FileReceiver({ key, nonceBase, fileId: fromHex(fid), from, to, size, chunk: ch, sha256: want });
  for (const fhex of frames) {
    const fr = P.parseFileFrame(fromHex(fhex));
    if (!fr || fr.fileIdHex !== fid) continue; // неизвестный fileId — дроп (как в App.tsx)
    const bad = await rx.push(fr.ctr, fr.body);
    if (bad) return { ok: false, reason: bad };
  }
  if (!end) return { ok: false, reason: "timeout" };
  const r = await rx.finish("application/octet-stream");
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, bytes: Buffer.from(await r.blob.arrayBuffer()) };
}
{
  const r = await receive(F.chunks.map(c => c.frame_hex), { size: F.file.size, chunk, sha256: F.file.sha256_hex });
  check("сборка 3 чанков: ok", r.ok, r.reason || "");
  check("сборка: байты = файл, sha256 = эталон",
    r.ok && hex(r.bytes) === F.file.plaintext_hex && createHash("sha256").update(r.bytes).digest("hex") === F.file.sha256_hex);
  const s = await P.sha256OfBlob(new Blob([plain]), 7);
  check("sha256OfBlob (по частям 7 Б) = эталон", s === F.file.sha256_hex);
  check("safeReceivedMime: html → octet-stream", P.safeReceivedMime("text/html", "") === "application/octet-stream");
  check("safeReceivedMime: svg → octet-stream", P.safeReceivedMime("image/svg+xml", "") === "application/octet-stream");
  check("safeReceivedMime: video/mp4 сохраняется", P.safeReceivedMime("video/mp4", "") === "video/mp4");
  check("safeReceivedMime: сигнатура приоритетнее", P.safeReceivedMime("image/png", "application/pdf") === "application/pdf");
}

// ════════ (г) негативы эталона ════════
{
  const N = F.negative;
  const tryDecrypt = (fhex, ctr, from = FROM, to = TO) => {
    const fr = P.parseFileFrame(fromHex(fhex));
    return P.decryptFileChunk({ key, nonceBase, fileId, ctr, body: fr.body, from, to });
  };
  // Кадр с заголовком ctr=1 (как его и ждёт получатель после чанка 0) — шифровали как 0
  await expectThrow("негатив wrong_ctr_in_header → GCM fail", () => tryDecrypt(N.wrong_ctr_in_header.frame_hex, P.parseFileFrame(fromHex(N.wrong_ctr_in_header.frame_hex)).ctr));
  await expectThrow("негатив chunk_of_other_file → GCM fail", () => tryDecrypt(N.chunk_of_other_file.frame_hex, 0));
  await expectThrow("негатив swapped_numbers_in_ad → GCM fail", () => tryDecrypt(N.swapped_numbers_in_ad.frame_hex, 0));
  // Через приёмник: подмена чанка 1 → invalid
  const swapped = [F.chunks[0].frame_hex, N.wrong_ctr_in_header.frame_hex, F.chunks[2].frame_hex];
  const rs = await receive(swapped, { size: F.file.size, chunk, sha256: F.file.sha256_hex });
  check("приём: подменённый чанк 1 → abort invalid", !rs.ok && rs.reason === "invalid", rs.reason);
  const rt = await receive(N.truncated_transfer.frames, { size: F.file.size, chunk, sha256: F.file.sha256_hex });
  check("приём: truncated_transfer (2 чанка + file_end) → abort protocol", !rt.ok && rt.reason === "protocol", rt.reason);
  const ro = await receive([F.chunks[1].frame_hex], { size: F.file.size, chunk, sha256: F.file.sha256_hex });
  check("приём: чанк не по порядку → abort protocol", !ro.ok && ro.reason === "protocol", ro.reason);
  const rsw = await receive(F.chunks.map(c => c.frame_hex), { size: F.file.size, chunk, sha256: F.file.sha256_hex, from: TO, to: FROM });
  check("приём: переставленные номера → abort invalid", !rsw.ok && rsw.reason === "invalid", rsw.reason);
  const rsha = await receive(F.chunks.map(c => c.frame_hex), { size: F.file.size, chunk, sha256: "00".repeat(32) });
  check("приём: sha256 не совпал → abort invalid", !rsha.ok && rsha.reason === "invalid", rsha.reason);
}

// ════════ round-trip: случайный ключ, файл 200 КиБ + 1, чанк 64 КиБ ════════
{
  const size = 200 * 1024 + 1;
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
  const k2raw = P.randomBytes(32), nb2 = P.randomBytes(8), fid2 = P.randomBytes(16);
  const k2 = await P.importFileKey(k2raw);
  const n = P.chunkCount(size, P.FILE_CHUNK_DEFAULT);
  const h = P.createSha256();
  let ok = n === 4;
  for (let ctr = 0; ctr < n; ctr++) {
    const pt = data.subarray(ctr * P.FILE_CHUNK_DEFAULT, ctr * P.FILE_CHUNK_DEFAULT + P.chunkPlainLen(size, P.FILE_CHUNK_DEFAULT, ctr));
    const fr = await P.encryptFileChunk({ key: k2, nonceBase: nb2, fileId: fid2, ctr, plaintext: pt, from: "1", to: "2" });
    const pf = P.parseFileFrame(fr);
    const back = await P.decryptFileChunk({ key: k2, nonceBase: nb2, fileId: fid2, ctr: pf.ctr, body: pf.body, from: "1", to: "2" });
    ok = ok && pf.fileIdHex === P.toHex(fid2) && Buffer.compare(Buffer.from(back), Buffer.from(pt)) === 0;
    h.update(back);
  }
  check("round-trip 200 КиБ+1: 4 чанка, sha256", ok && h.hex() === createHash("sha256").update(data).digest("hex"));
}

// ════════ отправитель sendFileChunks → FileReceiver через заглушку DataChannel ════════
// 3 МиБ + 5 Б (49 чанков): чтение блоками File.slice, backpressure по bufferedAmount
{
  const size = 3 * 1024 * 1024 + 5;
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 7 + 3) & 0xff;
  const k3raw = P.randomBytes(32), nb3 = P.randomBytes(8), fid3 = P.randomBytes(16);
  const k3 = await P.importFileKey(k3raw);
  const sha = await P.sha256OfBlob(new Blob([data]));
  const rx = new P.FileReceiver({ key: k3, nonceBase: nb3, fileId: fid3, from: "1", to: "2", size, chunk: P.FILE_CHUNK_DEFAULT, sha256: sha });
  const listeners = { bufferedamountlow: new Set(), close: new Set() };
  let maxBuffered = 0, waits = 0, sentWhileHigh = 0;
  const pushes = [];
  // «Сеть» сливает буфер только когда отправитель ждёт bufferedamountlow — проверяется, что
  // send не вызывается при bufferedAmount > 1 МиБ и что ожидание реально происходит
  const dc = {
    readyState: "open", bufferedAmount: 0,
    send(fr) {
      if (this.bufferedAmount > P.DC_BUFFER_HIGH) sentWhileHigh++;
      this.bufferedAmount += fr.length;
      maxBuffered = Math.max(maxBuffered, this.bufferedAmount);
      const pf = P.parseFileFrame(fr);
      pushes.push(rx.push(pf.ctr, pf.body));
    },
    addEventListener(t, f) {
      listeners[t].add(f);
      if (t === "bufferedamountlow") {
        waits++;
        setTimeout(() => { dc.bufferedAmount = P.DC_BUFFER_LOW; for (const g of [...listeners.bufferedamountlow]) g(); }, 1);
      }
    },
    removeEventListener(t, f) { listeners[t].delete(f); },
  };
  let progressed = 0;
  const res = await P.sendFileChunks({ file: new Blob([data]), size, chunk: P.FILE_CHUNK_DEFAULT, key: k3, nonceBase: nb3, fileId: fid3, from: "1", to: "2", dc, shouldStop: () => false, onProgress: (b) => { progressed = b; } });
  const errs = (await Promise.all(pushes)).filter(Boolean);
  const fin = await rx.finish("application/octet-stream");
  const back = fin.ok ? Buffer.from(await fin.blob.arrayBuffer()) : Buffer.alloc(0);
  check("sendFileChunks: done, 49 чанков, прогресс = размер", res === "done" && rx.n === 49 && pushes.length === 49 && progressed === size);
  check("sendFileChunks → FileReceiver: файл собран, sha256 совпал", errs.length === 0 && fin.ok && Buffer.compare(back, Buffer.from(data)) === 0);
  check("backpressure: send не вызывается при bufferedAmount > 1 МиБ, ожидание было",
    sentWhileHigh === 0 && waits > 0 && maxBuffered > P.DC_BUFFER_HIGH && maxBuffered <= P.DC_BUFFER_HIGH + P.FILE_FRAME_MAX,
    `max ${maxBuffered}, ожиданий ${waits}`);
  // Остановка (отмена) и закрытие канала посреди передачи
  let sent = 0;
  const dc2 = { readyState: "open", bufferedAmount: 0, send() { sent++; if (sent === 3) this.readyState = "closed"; }, addEventListener() {}, removeEventListener() {} };
  const res2 = await P.sendFileChunks({ file: new Blob([data]), size, chunk: P.FILE_CHUNK_DEFAULT, key: k3, nonceBase: nb3, fileId: fid3, from: "1", to: "2", dc: dc2, shouldStop: () => false });
  check("sendFileChunks: канал закрылся → closed", res2 === "closed" && sent === 3);
  let n4 = 0;
  const dc3 = { readyState: "open", bufferedAmount: 0, send() { n4++; }, addEventListener() {}, removeEventListener() {} };
  const res3 = await P.sendFileChunks({ file: new Blob([data]), size, chunk: P.FILE_CHUNK_DEFAULT, key: k3, nonceBase: nb3, fileId: fid3, from: "1", to: "2", dc: dc3, shouldStop: () => n4 >= 2 });
  check("sendFileChunks: отмена → stopped", res3 === "stopped" && n4 === 2);
}

// ── (д) hello §3.4: кадр v2, разбор v1/v2, ответный hello только на первый hello пира ──
{
  const dev = "0123456789abcdef";
  const h = JSON.parse(P.buildHelloFrame(dev));
  check("hello v2: type/version/features/deviceId/maxChunk/maxInflight",
    h.type === "hello" && h.version === 2 && JSON.stringify(h.features) === JSON.stringify(["messages", "delivery_ack", "files_v1", "events_v1"])
      && h.deviceId === dev && h.maxChunk === 65536 && h.maxInflight === 3);
  const v1 = P.parseHelloFrame({ type: "hello", version: 1 }, false);
  check("hello v1 без features → только messages", JSON.stringify(v1.features) === '["messages"]' && v1.deviceId === "");
  const v2 = P.parseHelloFrame(h, false);
  check("hello v2: features пира, deviceId", v2.features.includes("files_v1") && v2.features.includes("events_v1") && v2.deviceId === dev);
  const bad = P.parseHelloFrame({ type: "hello", features: ["files_v1", 7, "x".repeat(33)], deviceId: "ZZ" }, false);
  check("hello: мусорные features/deviceId отброшены, messages добавлен",
    JSON.stringify(bad.features) === '["messages","files_v1"]' && bad.deviceId === "");
  // Модель обмена двух каналов: сторона A теряет первый hello B (старый iOS/macOS: delegate DC назначен поздно)
  const side = (name, lostFirst) => ({ name, lostFirst, got: 0, sent: 0, received: false, features: [] });
  const A = side("A", true), B = side("B", false);
  const queue = [];
  const send = (from, to) => { from.sent++; queue.push(to); };
  send(A, B); send(B, A);                       // hello по open с обеих сторон
  while (queue.length) {
    const to = queue.shift();
    to.got++;
    if (to.lostFirst && to.got === 1) continue; // кадр потерян до назначения delegate
    const r = P.parseHelloFrame(h, to.received);
    to.received = true; to.features = r.features;
    if (r.reply) send(to, to === A ? B : A);
  }
  check("ответный hello: потерянный первый hello восполнен, files_v1 у обеих сторон",
    A.received && B.received && A.features.includes("files_v1") && B.features.includes("files_v1"));
  check("ответный hello: обмен конечен, каждая сторона шлёт ≤ 2 hello", A.sent <= 2 && B.sent <= 2, `A ${A.sent}, B ${B.sent}`);
  check("повторный hello пира ответа не вызывает", P.parseHelloFrame(h, true).reply === false);
}

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
