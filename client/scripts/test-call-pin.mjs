#!/usr/bin/env node
// CR-01: пин DTLS-отпечатка собеседника в звонке (src/lib/callSas.ts → acceptRemoteFingerprint),
// паритет с macOS `CallSession.acceptRemoteFingerprint` (mac/tests/call_logic_test.swift).
// TS-модуль без импортов транспилируется typescript'ом и грузится как ESM (как в test-meta1.mjs).
// Запуск: node scripts/test-call-pin.mjs или npm run test:call-pin.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { webcrypto } from "node:crypto";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

async function importTs(rel) {
  const src = readFileSync(resolve(clientDir, rel), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(out).toString("base64"));
}

const SAS = await importTs("src/lib/callSas.ts");
const accept = SAS.acceptRemoteFingerprint;

let failed = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}

const FP_A = "AB".repeat(32);
const FP_B = "CD".repeat(32);
const colon = (fp) => fp.match(/../g).join(":");
const sdp = (fpLine) => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n${fpLine}\r\na=setup:actpass\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n`;
const sdpA = sdp(`a=fingerprint:sha-256 ${colon(FP_A)}`);
const sdpB = sdp(`a=fingerprint:sha-256 ${colon(FP_B)}`);

check("первый SDP закрепляется (pinned=null → fp)", accept(null, sdpA) === FP_A);
check("первый SDP закрепляется (pinned=undefined → fp)", accept(undefined, sdpA) === FP_A);
check("тот же отпечаток принимается (ренеготиация / ICE-рестарт)", accept(FP_A, sdpA) === FP_A);
check("другой отпечаток отвергается", accept(FP_A, sdpB) === null);
check("SDP без fingerprint отвергается (без пина)", accept(null, sdp("a=ice-ufrag:x")) === null);
check("SDP без fingerprint отвергается (с пином)", accept(FP_A, sdp("a=ice-ufrag:x")) === null);
check("только sha-1 отпечаток не принимается", accept(null, sdp("a=fingerprint:sha-1 AA:BB:CC")) === null);
check("пустой/null SDP отвергается", accept(null, "") === null && accept(FP_A, null) === null);
check("нижний регистр и двоеточия нормализуются",
  accept(FP_A, sdp(`a=fingerprint:sha-256 ${colon(FP_A).toLowerCase()}`)) === FP_A);
check("регистр имени алгоритма не важен", accept(FP_A, sdp(`a=fingerprint:SHA-256 ${colon(FP_A)}`)) === FP_A);
check("битая первая строка sha-256 → отказ, следующая не берётся (как iOS/macOS)",
  accept(null, sdp(`a=fingerprint:sha-256 ZZ:ZZ\r\na=fingerprint:sha-256 ${colon(FP_A)}`)) === null);
check("берётся первая строка fingerprint (как в коде звонка)",
  accept(null, sdp(`a=fingerprint:sha-256 ${colon(FP_A)}\r\na=fingerprint:sha-256 ${colon(FP_B)}`)) === FP_A);
// Сценарий звонка: offer до «Принять» → повторный offer с другим fp → отказ; answer с другим fp → отказ
{
  let pin = null;
  pin = accept(pin, sdpA);
  check("сценарий: входящий offer закрепил пин", pin === FP_A);
  check("сценарий: повторный call_incoming с другим fp до «Принять» — отказ", accept(pin, sdpB) === null);
  check("сценарий: ICE-рестарт тем же PeerConnection проходит", accept(pin, sdpA) === FP_A);
  let callerPin = null;
  callerPin = accept(callerPin, sdpB);
  check("сценарий: первый answer закрепил пин вызывающего", callerPin === FP_B);
  check("сценарий: answer на ICE-рестарт с другим fp — отказ", accept(callerPin, sdpA) === null);
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
