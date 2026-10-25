#!/usr/bin/env node
// Тест S10 web (documentation/PROTOCOL_S10_SPEC.md) без браузера:
//   1) meta1: расшифровка всех кейсов documentation/meta1_vector.json НАСТОЯЩИМ public/sw.js
//      (+ envelope-v2.js) ключом получателя и разбор ТЕМ ЖЕ парсером, что в приложении
//      (src/lib/meta1.ts → parseMeta1), сверка с `expect`; round-trip построителей.
//   2) safety number v1/v2 и QR-строка (src/lib/safety.ts) против documentation/safety_v2_vector.json.
//   3) App Lock (src/lib/applock.ts): PBKDF2 против node:crypto, constant-time, миграция
//      открытого PIN, проверка обеих веток, счётчик/задержки/порог wipe.
//   4) Санитизация ICE/SDP (src/lib/sdp.ts): host/prflx вырезаются, raddr/rport обнуляются.
// TS-модули без импортов транспилируются typescript'ом (devDependency) и грузятся как ESM.
// Запуск: node scripts/test-meta1.mjs (Node 18+), или npm run test:meta1.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { webcrypto, pbkdf2Sync } from "node:crypto";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
const docDir = resolve(clientDir, "../documentation");

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

async function importTs(rel) {
  const src = readFileSync(resolve(clientDir, rel), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(out).toString("base64"));
}

const M = await importTs("src/lib/meta1.ts");
const S = await importTs("src/lib/safety.ts");
const L = await importTs("src/lib/applock.ts");
const SDP = await importTs("src/lib/sdp.ts");

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
const hex = (u8) => Buffer.from(u8).toString("hex");
const fromHex = (h) => new Uint8Array(Buffer.from(h, "hex"));
const b64url = (u8) => Buffer.from(u8).toString("base64url");
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ════════ 1. meta1 ════════
const V = JSON.parse(readFileSync(resolve(docDir, "meta1_vector.json"), "utf8"));
const subtle = globalThis.crypto.subtle;
const pubRaw = new Uint8Array(Buffer.from(V.recipient_pub_b64, "base64"));
const privB = await subtle.importKey(
  "jwk",
  { kty: "EC", crv: "P-256", d: b64url(fromHex(V.recipient_priv_hex)), x: b64url(pubRaw.slice(1, 33)), y: b64url(pubRaw.slice(33)), ext: false },
  { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
);
const ownB = { privateKey: privB, publicKey: V.recipient_pub_b64 };

// Действие диспетчера App.tsx по результату parseMeta1 (та же таблица, что в handleIncomingEnvelope)
function dispatch(outcome, plaintext) {
  switch (outcome.action) {
    case "legacy": return { action: "show_legacy_text", text: plaintext };
    case "show": return { action: "show", ...outcome.content };
    case "edit": return { action: "edit", id: outcome.id, text: outcome.text };
    case "reaction": return { action: "apply_reaction", target: outcome.target, emoji: outcome.emoji, remove: outcome.remove };
    case "ignore": return { action: "ignore_no_bubble" };
    case "drop": return { action: "drop" };
    case "invalid": return { action: "invalid", display: "[Некорректное сообщение]" };
    default: return { action: "?" };
  }
}

for (const c of V.cases) {
  let pt;
  try {
    pt = await globalThis._decrypt(c.encryptedBlob, c.outer.fromNumber, V.to, ownB);
  } catch (e) {
    check(`meta1 ${c.name}: расшифровка`, false, e?.message);
    continue;
  }
  const ptBytes = Buffer.from(pt, "utf8");
  check(`meta1 ${c.name}: plaintext побайтово = plaintext_hex`, hex(ptBytes) === c.plaintext_hex);
  const got = dispatch(M.parseMeta1(pt, c.outer.type, c.outer.messageId), pt);
  const exp = { ...c.expect };
  let ok = got.action === exp.action;
  const details = [];
  if (exp.plaintext_len_multiple_of) {
    const okPad = ptBytes.length % exp.plaintext_len_multiple_of === 0;
    if (!okPad) details.push(`длина ${ptBytes.length} не кратна ${exp.plaintext_len_multiple_of}`);
    ok = ok && okPad;
    delete exp.plaintext_len_multiple_of;
  }
  if (exp.data_hex !== undefined) {
    const okData = typeof got.data === "string" && Buffer.from(got.data, "base64").toString("hex") === exp.data_hex;
    if (!okData) details.push("data");
    ok = ok && okData;
    delete exp.data_hex;
  }
  for (const [key, val] of Object.entries(exp)) {
    if (key === "action") continue;
    if (!eq(got[key], val)) { ok = false; details.push(`${key}: ${JSON.stringify(got[key])} ≠ ${JSON.stringify(val)}`); }
  }
  check(`meta1 ${c.name}: ${exp.action}`, ok, details.join("; ") || JSON.stringify(got).slice(0, 120));
}

// Round-trip построителей приложения: build → encrypt v2 (sw) → decrypt → parse
{
  const own = { privateKey: privB, publicKey: V.recipient_pub_b64 }; // сам себе: from=1002 → to=1002
  const rt = async (payload, type, id) => {
    const blob = await globalThis._encryptV2(payload, "1002", "1002", V.recipient_pub_b64, own);
    const pt = await globalThis._decrypt(blob, "1002", "1002", own);
    return M.parseMeta1(pt, type, id);
  };
  const t = await rt(M.buildTextPayload({ id: "x-1", text: "a\u0000b", replyTo: { messageId: "x-0", from: "1001" }, sd: "read" }), "message", "x-1");
  check("round-trip text: NUL вырезан, replyTo/sd на месте",
    t.action === "show" && t.content.text === "ab" && t.content.sd === "read" && t.content.replyTo?.messageId === "x-0");
  const longText = M.buildTextPayload({ id: "x-9", text: "я".repeat(3000) });
  check("паддинг: plaintext ≥ 4096 кратен 4096", M.utf8Length(longText) % 4096 === 0, String(M.utf8Length(longText)));
  check("паддинг: короткий plaintext кратен 256", M.utf8Length(M.buildTextPayload({ id: "x", text: "hi" })) % 256 === 0);
  const f = await rt(M.buildFilePayload({ id: "x-2", name: "../a\u0001b.txt", mime: "text/plain; charset=utf-8", size: 2, data: "AAE=" }), "message", "x-2");
  check("round-trip file: имя санитизировано отправителем, mime без параметров",
    f.action === "show" && f.content.name === "..ab.txt" && f.content.mime === "text/plain");
  const v = await rt(M.buildVoicePayload({ id: "x-3", mime: "audio/webm", durMs: 2500.4, data: "AAEC" }), "message", "x-3");
  check("round-trip voice: durMs", v.action === "show" && v.content.durMs === 2500);
  const r = await rt(M.buildReactionPayload({ target: "x-1", emoji: "🔥", remove: true }), "reaction", "x-1");
  check("round-trip reaction", r.action === "reaction" && r.emoji === "🔥" && r.remove === true);
  const e = await rt(M.buildEditPayload({ id: "x-1", text: "new" }), "message_edited", "x-1");
  check("round-trip edit", e.action === "edit" && e.text === "new");
  check("edit с k=file → drop", M.parseMeta1(M.buildFilePayload({ id: "x-2", name: "a", mime: "a/b", size: 0, data: "" }), "message_edited", "x-2").action === "drop");
  check("пустой внешний messageId → drop", M.parseMeta1(M.buildTextPayload({ id: "", text: "x" }), "message", "").action === "drop");
  check("битый JSON → invalid", M.parseMeta1("\u0000{not json", "message", "x").action === "invalid");
  // Q19: некорректный sd игнорируется — сообщение показывается без таймера
  for (const bad of [-5, 0, 1.5, 604801, "never", true, null]) {
    const r = M.parseMeta1("\u0000" + JSON.stringify({ k: "text", id: "x", text: "a", sd: bad }), "message", "x");
    check(`Q19: sd=${JSON.stringify(bad)} → show без таймера`, r.action === "show" && r.content.sd === undefined);
  }
  const sdOk = M.parseMeta1("\u0000" + JSON.stringify({ k: "text", id: "x", text: "a", sd: 604800 }), "message", "x");
  check("Q19: sd=604800 → таймер сохранён", sdOk.action === "show" && sdOk.content.sd === 604800);
  // Q19: durMs ≤ 3 600 000
  const voiceDur = (d) => M.parseMeta1("\u0000" + JSON.stringify({ k: "voice", id: "x", mime: "audio/webm", durMs: d, data: "" }), "message", "x").action;
  check("Q19: durMs=3600000 → show", voiceDur(3_600_000) === "show");
  check("Q19: durMs=3600001 → invalid", voiceDur(3_600_001) === "invalid");
  check("Q19: voice без durMs → invalid", M.parseMeta1("\u0000" + JSON.stringify({ k: "voice", id: "x", mime: "audio/webm", data: "" }), "message", "x").action === "invalid");
  check("Q19: file без size → invalid", M.parseMeta1("\u0000" + JSON.stringify({ k: "file", id: "x", name: "a", mime: "a/b", data: "" }), "message", "x").action === "invalid");
  // Q19: реакция без remove (или не bool) → drop
  check("Q19: reaction без remove → drop", M.parseMeta1("\u0000" + JSON.stringify({ k: "reaction", target: "x", emoji: "👍" }), "reaction", "x").action === "drop");
  check("Q19: reaction remove=\"no\" → drop", M.parseMeta1("\u0000" + JSON.stringify({ k: "reaction", target: "x", emoji: "👍", remove: "no" }), "reaction", "x").action === "drop");
  // Q19/D4: NUL-payload распознаётся (легаси file/voice по нему делают дроп, peerMeta1 — при любом NUL)
  check("Q19: isMeta1Plaintext(NUL‖…) = true, легаси base64 = false",
    M.isMeta1Plaintext("\u0000{\"k\":\"poll\"}") && !M.isMeta1Plaintext("AAEC"));
  check("текст > 16384 → invalid", M.parseMeta1("\u0000" + JSON.stringify({ k: "text", id: "x", text: "a".repeat(16385) }), "message", "x").action === "invalid");
  // Q4 (уточнено): emoji ≤ 32 UTF-16 code units
  check("emoji 32 code units → reaction",
    M.parseMeta1("\u0000" + JSON.stringify({ k: "reaction", target: "x", emoji: "😀".repeat(16), remove: false }), "reaction", "x").action === "reaction");
  check("emoji 33 code units → invalid",
    M.parseMeta1("\u0000" + JSON.stringify({ k: "reaction", target: "x", emoji: "😀".repeat(16) + "!", remove: false }), "reaction", "x").action === "invalid");
  // M4/Q5: bidi/форматирующие символы в имени — отправитель вырезает, приём — invalid
  const fb = await rt(M.buildFilePayload({ id: "x-4", name: "invoice\u202Efdp.exe\u200B\u2028", mime: "application/pdf", size: 1, data: "AA==" }), "message", "x-4");
  check("отправка: bidi/Cf/Zl вырезаны из имени", fb.action === "show" && fb.content.name === "invoicefdp.exe");
  check("приём: имя с U+200F → invalid",
    M.parseMeta1("\u0000" + JSON.stringify({ k: "file", id: "x", name: "a\u200Fb", mime: "a/b", size: 0, data: "" }), "message", "x").action === "invalid");
  // Q4: emoji — ZWJ/вариационные селекторы/теги разрешены, bidi и Cc — нет
  const flag = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
  check("emoji с тегами (флаг Шотландии, 14 code units) → reaction",
    M.parseMeta1(M.buildReactionPayload({ target: "x", emoji: flag, remove: false }), "reaction", "x").action === "reaction");
  check("emoji с U+202E → invalid",
    M.parseMeta1("\u0000" + JSON.stringify({ k: "reaction", target: "x", emoji: "\u202E👍", remove: false }), "reaction", "x").action === "invalid");
  check("легаси duration: 7 → 7 с, 7000 → 7 с", M.legacyDurationToSeconds(7) === 7 && M.legacyDurationToSeconds(7000) === 7);
  check(`лимит вложения ${M.MAX_ATTACHMENT_BYTES} ≤ расчётного ${M.MAX_ATTACHMENT_BYTES_COMPUTED}`,
    M.MAX_ATTACHMENT_BYTES <= M.MAX_ATTACHMENT_BYTES_COMPUTED);
  // Худший случай: файл на лимите с максимальным именем помещается в кадр relay
  const bigData = Buffer.alloc(M.MAX_ATTACHMENT_BYTES, 7).toString("base64");
  const bigPt = M.buildFilePayload({ id: "1700000000000-ffffffffffffff", name: "ж".repeat(255), mime: "application/octet-stream", size: M.MAX_ATTACHMENT_BYTES, data: bigData });
  const bigBlob = await globalThis._encryptV2(bigPt, "1110000001", "1110000002", V.recipient_pub_b64, own);
  const frame = JSON.stringify({ type: "message", toNumber: "1110000002", messageId: "1700000000000-ffffffffffffff", encryptedBlob: bigBlob });
  check(`кадр с файлом на лимите ≤ ${M.MAX_FRAME_BYTES} байт`, Buffer.byteLength(frame) <= M.MAX_FRAME_BYTES, String(Buffer.byteLength(frame)));
  // Легаси file_message (base64 файла шифруется как текст) на том же лимите тоже укладывается
  const legacyBlob = await globalThis._encryptV1(bigData, "1110000001", "1110000002", V.recipient_pub_b64);
  const legacyFrame = JSON.stringify({ type: "file_message", toNumber: "1110000002", encryptedBlob: legacyBlob,
    fileName: "ж".repeat(255), fileSize: M.MAX_ATTACHMENT_BYTES, mimeType: "application/octet-stream", messageId: "1700000000000-ffffffffffffff" });
  check(`легаси-кадр file_message на лимите ≤ ${M.MAX_FRAME_BYTES} байт`, Buffer.byteLength(legacyFrame) <= M.MAX_FRAME_BYTES, String(Buffer.byteLength(legacyFrame)));
}

// ════════ 2. safety number v1/v2 + QR ════════
const SV = JSON.parse(readFileSync(resolve(docDir, "safety_v2_vector.json"), "utf8"));
const keyA = fromHex(SV.keyA_raw65_hex);
const keyB = fromHex(SV.keyB_raw65_hex);
const keyAB64 = Buffer.from(keyA).toString("base64");
const keyBB64 = Buffer.from(keyB).toString("base64");
check("fingerprint A", (await S.keyFingerprint(keyAB64)) === SV.fingerprintA);
check("fingerprint B", (await S.keyFingerprint(keyBB64)) === SV.fingerprintB);
check("safety v1 (A,B)", (await S.safetyNumberRaw(keyA, keyB)).join(" ") === SV.safety_v1_groups);
check("safety v1 симметричен (B,A)", (await S.safetyNumberRaw(keyB, keyA)).join(" ") === SV.safety_v1_groups);
for (const c of SV.v2_cases) {
  check(`safety v2 ${c.name}: input`, hex(S.safetyV2Input(c.numberA, keyA, c.numberB, keyB)) === c.input_hex);
  const gA = (await S.safetyNumberV2(c.numberA, keyAB64, c.numberB, keyBB64))?.join(" ");
  const gB = (await S.safetyNumberV2(c.numberB, keyBB64, c.numberA, keyAB64))?.join(" ");
  check(`safety v2 ${c.name}: groups (сторона A)`, gA === c.groups, gA);
  check(`safety v2 ${c.name}: groups (сторона B) совпадают`, gB === c.groups);
  check(`safety v2 ${c.name}: QR от A`, S.safetyQrPayload(c.numberA, SV.fingerprintA, c.numberB, SV.fingerprintB) === c.qr_from_A);
}

// ════════ 3. App Lock ════════
{
  const salt = new Uint8Array(16).map((_, i) => i + 1);
  const ours = await L.derivePinHash("123456", salt, 1000);
  const ref = pbkdf2Sync(Buffer.from("123456"), Buffer.from(salt), 1000, 32, "sha256");
  check("PBKDF2-SHA256 = node:crypto.pbkdf2Sync", hex(ours) === ref.toString("hex"));
  check(`итераций по умолчанию ≥ 310000 (${L.APPLOCK_PBKDF2_ITERATIONS})`, L.APPLOCK_PBKDF2_ITERATIONS >= 310_000);
  const t0 = Date.now();
  const ver = await L.createPinVerifier("2468");
  const ms = Date.now() - t0;
  check("верификатор {v:1, iter, salt16, hash32}", L.isPinVerifier(ver) && ver.iter === L.APPLOCK_PBKDF2_ITERATIONS, `${ms} мс`);
  check("верный PIN → true", await L.checkPin("2468", ver));
  check("неверный PIN → false", !(await L.checkPin("2469", ver)));
  check("нет верификатора → false", !(await L.checkPin("2468", null)));
  check("constantTimeEqual", L.constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))
    && !L.constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))
    && !L.constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0])));

  // Хранилище + миграция открытого PIN
  const mem = new Map();
  const kv = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  kv.setItem("phantom_1110000001_applock", JSON.stringify({ enabled: true, pin: "111111", pinLength: 6, inactivityTimeout: 300 }));
  kv.setItem("phantom_1110000001_panic", JSON.stringify({ enabled: true, panicPin: "999999" }));
  check("миграция выполнена", await L.migratePlainPins(kv, "1110000001"));
  const rawStore = [...mem.values()].join("\n");
  check("после миграции открытых PIN в хранилище нет", !rawStore.includes("111111") && !rawStore.includes("999999") && !rawStore.includes("\"pin\"") && !rawStore.includes("panicPin"));
  const lock = L.readAppLock(kv, "1110000001");
  const panic = L.readPanic(kv, "1110000001");
  check("миграция: enabled и верификаторы", lock.enabled && panic.enabled && L.isPinVerifier(lock.pinHash) && L.isPinVerifier(panic.pinHash));
  check("повторная миграция — no-op", !(await L.migratePlainPins(kv, "1110000001")));
  check("checkUnlock: PIN → ok", (await L.checkUnlock("111111", lock.pinHash, panic.pinHash)) === "ok");
  check("checkUnlock: panic → panic", (await L.checkUnlock("999999", lock.pinHash, panic.pinHash)) === "panic");
  check("checkUnlock: чужой → fail", (await L.checkUnlock("000000", lock.pinHash, panic.pinHash)) === "fail");
  check("checkUnlock без panic-PIN: PIN → ok", (await L.checkUnlock("111111", lock.pinHash, null)) === "ok");
  check("panic-PIN = PIN запрещён", (await L.setPanicPin(kv, "1110000001", "111111")) === "same_as_pin");
  check("PIN = panic-PIN запрещён", (await L.setLockPin(kv, "1110000001", "999999", { pinLength: 6, inactivityTimeout: 300 })) === "same_as_panic");

  // Счётчик/задержки/wipe
  const expectDelays = [0, 0, 0, 0, 30_000, 60_000, 120_000, 300_000, 900_000];
  let st = { failCount: 0, lockedUntil: 0 };
  let okDelays = true;
  let wipeAt = 0;
  for (let i = 1; i <= 10; i++) {
    const r = L.registerFailure(st, 1_000_000);
    if (i < 10) {
      if (r.wipe || r.delayMs !== expectDelays[i - 1] || r.state.lockedUntil !== (r.delayMs ? 1_000_000 + r.delayMs : 0)) okDelays = false;
    } else if (r.wipe) wipeAt = i;
    st = r.state;
  }
  check("задержки: 1–4 → 0; 5 → 30 с; 6 → 1 мин; 7 → 2 мин; 8 → 5 мин; 9 → 15 мин", okDelays);
  check("10-я неудача → wipe", wipeAt === 10);
  check("осталось попыток после 5-й неудачи = 5", L.attemptsBeforeWipe(5) === 5);
  check("lockRemainingMs", L.lockRemainingMs({ failCount: 5, lockedUntil: 1_030_000 }, 1_000_000) === 30_000);
  L.writeFailState(kv, "1110000001", { failCount: 6, lockedUntil: 123 });
  check("счётчик персистентен", eq(L.readFailState(kv, "1110000001"), { failCount: 6, lockedUntil: 123 }));
  L.writeFailState(kv, "1110000001", { failCount: 0, lockedUntil: 0 });
  check("успех обнуляет счётчик", eq(L.readFailState(kv, "1110000001"), { failCount: 0, lockedUntil: 0 }) && !mem.has("phantom_1110000001_applock_fail"));
}

// ════════ 4. ICE/SDP: host/prflx вырезаются, raddr/rport обнуляются (S10.5/Q9) ════════
{
  const relayCand = "candidate:1 1 udp 41885439 203.0.113.7 3478 typ relay raddr 198.51.100.23 rport 50000 generation 0";
  const srflxCand = "candidate:2 1 udp 1677729535 198.51.100.23 50000 typ srflx raddr 192.168.1.10 rport 54321 generation 0";
  const t = SDP.sanitizeIceCandidate({ candidate: relayCand, sdpMid: "0", sdpMLineIndex: 0 });
  check("трикл relay: raddr → 0.0.0.0, rport → 0, публичный адрес не утёк",
    t.candidate.includes("raddr 0.0.0.0 rport 0") && !t.candidate.includes("198.51.100.23") && t.sdpMid === "0");
  check("трикл srflx: локальный raddr не утёк",
    !SDP.sanitizeCandidateLine(srflxCand).includes("192.168.1.10") && SDP.sanitizeCandidateLine(srflxCand).includes("raddr 0.0.0.0 rport 0"));
  check("кандидат без raddr не меняется", SDP.sanitizeCandidateLine("candidate:3 1 udp 1 1.2.3.4 9 typ host") === "candidate:3 1 udp 1 1.2.3.4 9 typ host");
  const sdp = [
    "v=0", "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "a=candidate:4 1 udp 2122260223 192.168.1.10 54321 typ host generation 0",
    "a=candidate:5 1 udp 2122260223 abcd.local 54321 typ host",
    "a=candidate:6 1 udp 1845501695 198.51.100.24 50001 typ prflx raddr 192.168.1.10 rport 54321",
    "a=" + srflxCand, "a=" + relayCand, "a=mid:0",
  ].join("\r\n");
  const call = SDP.stripSdpCandidates(sdp);
  check("SDP звонка: host вырезан (IP и mDNS)", !call.includes("typ host") && !call.includes("abcd.local"));
  check("SDP звонка: raddr обнулён во всех оставшихся (в т.ч. prflx)", !call.includes("192.168.1.10") && !call.includes("raddr 198.51.100.23"));
  check("SDP звонка: srflx/relay и прочие строки сохранены", call.includes("typ srflx") && call.includes("typ relay") && call.includes("a=mid:0"));
  const p2p = SDP.stripSdpCandidates(sdp, ["host", "prflx"]);
  check("SDP P2P: host и prflx вырезаны", !p2p.includes("typ host") && !p2p.includes("typ prflx") && !p2p.includes("198.51.100.24"));
}

// ── WEB-17: код звонка (phantom-call-sas-v1) на эталоне ──
{
  const SAS = await importTs("src/lib/callSas.ts");
  const vec = JSON.parse(readFileSync(resolve(docDir, "call_sas_vector.json"), "utf8"));
  for (const c of vec.cases) {
    if (c.localSdp) {
      check(`call SAS fp из SDP: ${c.name}`, SAS.sdpFingerprint(c.localSdp) === c.fpLocal && SAS.sdpFingerprint(c.remoteSdp) === c.fpRemote);
      check(`call SAS по SDP: ${c.name}`, (await SAS.callSas(c.localSdp, c.remoteSdp)) === c.code);
    }
    check(`call SAS по отпечаткам: ${c.name}`, (await SAS.callSasFromFingerprints(c.fpLocal, c.fpRemote)) === c.code);
  }
  check("call SAS: без отпечатка -> null", (await SAS.callSas("v=0\r\n", vec.cases[0].remoteSdp)) === null);
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
