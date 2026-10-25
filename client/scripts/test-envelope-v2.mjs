#!/usr/bin/env node
// Тест конверта v2 (S9, documentation/PROTOCOL_V2_SPEC.md, P11) на эталонных векторах
// documentation/protocol_v2_vector.json. Грузит НАСТОЯЩИЕ public/envelope-v2.js и
// public/sw.js (в текущий realm через vm, со стабами SW-окружения) и проверяет:
//   (а) расшифровка эталонного blob_v2 ключом id_B → "hello v2";
//   (б) фиксированные eph/nonce → побайтово тот же cipher (и через sw._sealV2, и через чистый deriveV2Key);
//   (в) deriveV2Key на фиксированных ss1/ss2 → key_hex (subtle HKDF и ручной HMAC-fallback);
//   (г) подменённый senderIdentityKey → ошибка; (д) переставленные from/to → ошибка;
//   v1-регрессия → "hello v1"; round-trip v1/v2; version ≥ 3 → unsupported_version.
// Запуск: node scripts/test-envelope-v2.mjs (Node 18+), или npm run test:envelope.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
const vectorPath = resolve(clientDir, "../documentation/protocol_v2_vector.json");
const V = JSON.parse(readFileSync(vectorPath, "utf8"));

// ── Окружение SW: crypto, self, importScripts, addEventListener ──
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
globalThis.self = globalThis;
globalThis.addEventListener = () => {};
globalThis.importScripts = (p) => {
  const file = resolve(clientDir, "public", String(p).replace(/^\//, ""));
  vm.runInThisContext(readFileSync(file, "utf8"), { filename: file });
};
vm.runInThisContext(readFileSync(resolve(clientDir, "public/sw.js"), "utf8"), { filename: "sw.js" });

const E = globalThis.PhantomEnvelopeV2;
const subtle = globalThis.crypto.subtle;

// ── helpers ──
const hex = (u8) => Buffer.from(u8).toString("hex");
const fromHex = (h) => new Uint8Array(Buffer.from(h, "hex"));
const fromB64 = (b) => new Uint8Array(Buffer.from(b, "base64"));
const b64url = (u8) => Buffer.from(u8).toString("base64url");

async function importPriv(k) {
  return subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: b64url(fromHex(k.priv_hex)), x: k.x, y: k.y, ext: false },
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
  );
}
async function importPub(b64) {
  return subtle.importKey("raw", fromB64(b64), { name: "ECDH", namedCurve: "P-256" }, false, []);
}
async function ecdh(priv, pubB64) {
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: await importPub(pubB64) }, priv, 256));
}

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
}
async function expectThrow(label, fn) {
  try {
    const r = await fn();
    check(label, false, `ожидалась ошибка, получено ${JSON.stringify(r)}`);
  } catch (e) {
    check(label, true, `ошибка: ${e?.name || ""} ${e?.message || ""}`.trim());
  }
}

const K = V.keys;
const privA = await importPriv(K.id_A);
const privB = await importPriv(K.id_B);
const privEph = await importPriv(K.eph_A);
const ownA = { privateKey: privA, publicKey: K.id_A.pub_b64 };
const ownB = { privateKey: privB, publicKey: K.id_B.pub_b64 };
const nonce = fromHex(V.nonce_hex);

// Промежуточные значения P11
const ss1 = await ecdh(privEph, K.id_B.pub_b64);
const ss2 = await ecdh(privA, K.id_B.pub_b64);
check("ss1 = ECDH(eph_A, id_B)", hex(ss1) === V.intermediate.ss1_hex);
check("ss2 = ECDH(id_A, id_B)", hex(ss2) === V.intermediate.ss2_hex);
check("salt", hex(await E.salt()) === V.intermediate.salt_hex);
const idA65 = fromB64(K.id_A.pub_b64), idB65 = fromB64(K.id_B.pub_b64), eph65 = fromB64(K.eph_A.pub_b64);
check("info", hex(E.buildInfo(V.from, V.to, idA65, idB65, eph65)) === V.intermediate.info_hex);
check("ad", hex(E.buildAd(V.from, V.to)) === V.intermediate.ad_hex);

// (а)
const ptA = await globalThis._decrypt(V.blob_v2, V.from, V.to, ownB);
check("(а) sw._decrypt(blob_v2, id_B) → plaintext", ptA === V.plaintext, JSON.stringify(ptA));

// (б) через код SW с фиксированными eph/nonce
const sealed = await globalThis._sealV2(V.plaintext, V.from, V.to, K.id_B.pub_b64, ownA,
  { privateKey: privEph, publicKey: K.eph_A.pub_b64 }, nonce);
const sameBlob = ["version", "senderPublicKey", "senderIdentityKey", "nonce", "iv", "cipher"]
  .every((f) => sealed[f] === V.blob_v2[f]);
check("(б) sw._sealV2(фикс. eph/nonce) → blob побайтово равен эталону", sameBlob, sealed.cipher);
// (б) через чистую функцию deriveV2Key
const keyB = await E.deriveV2Key(ss1, ss2, V.from, V.to, idA65, idB65, eph65);
const ctB = new Uint8Array(await subtle.encrypt(
  { name: "AES-GCM", iv: nonce, additionalData: E.buildAd(V.from, V.to), tagLength: 128 },
  keyB, new TextEncoder().encode(V.plaintext)));
check("(б) deriveV2Key + AES-GCM → тот же cipher", Buffer.from(ctB).toString("base64") === V.blob_v2.cipher);

// (в) KDF на фиксированных ss1/ss2
const kdf = await E.deriveV2KeyBytes(fromHex(V.intermediate.ss1_hex), fromHex(V.intermediate.ss2_hex),
  V.from, V.to, idA65, idB65, eph65);
check("(в) deriveV2KeyBytes → key_hex (subtle HKDF)", hex(kdf) === V.intermediate.key_hex, hex(kdf));
const ikm = new Uint8Array([...fromHex(V.intermediate.ss1_hex), ...fromHex(V.intermediate.ss2_hex)]);
const manual = await E.hkdfSha256Manual(ikm, await E.salt(), fromHex(V.intermediate.info_hex), 32);
check("(в) ручной HKDF (HMAC fallback, P4) → key_hex", hex(manual) === V.intermediate.key_hex);

// (г), (д)
await expectThrow("(г) подменённый senderIdentityKey → ошибка",
  () => globalThis._decrypt(V.negative_g_wrong_identity.blob, V.from, V.to, ownB));
const nd = V.negative_d_swapped_numbers;
await expectThrow("(д) переставленные from/to → ошибка",
  () => globalThis._decrypt(nd.blob, nd.from, nd.to, ownB));

// v1-регрессия
const v1 = V.v1_regression;
const v1Shared = await ecdh(privB, v1.blob.senderPublicKey);
const v1Key = new Uint8Array(await subtle.digest("SHA-256",
  new Uint8Array([...v1Shared, ...new TextEncoder().encode(`direct:${V.from}:${V.to}`)])));
check("v1: ключ SHA-256(ECDH‖direct:from:to) = key_hex", hex(v1Key) === v1.key_hex);
const ptV1 = await globalThis._decrypt(v1.blob, V.from, V.to, ownB);
check("v1: sw._decrypt → \"hello v1\"", ptV1 === v1.plaintext, JSON.stringify(ptV1));
const v1NoVersion = { ...v1.blob }; delete v1NoVersion.version;
check("v1: blob без version → v1", (await globalThis._decrypt(v1NoVersion, V.from, V.to, ownB)) === v1.plaintext);

// P3: version ≥ 3
await expectThrow("version 3 → unsupported_version",
  async () => { try { return await globalThis._decrypt({ ...V.blob_v2, version: 3 }, V.from, V.to, ownB); }
    catch (e) { if (e.message !== "unsupported_version") throw new Error("wrong error " + e.message); throw e; } });

// P2: невалидная точка в senderIdentityKey → ошибка до ECDH
const badPoint = Buffer.from(fromB64(K.id_A.pub_b64)); badPoint[64] ^= 1;
await expectThrow("P2: senderIdentityKey вне кривой → ошибка",
  () => globalThis._decrypt({ ...V.blob_v2, senderIdentityKey: badPoint.toString("base64") }, V.from, V.to, ownB));
await expectThrow("P2: v2 без senderIdentityKey → ошибка",
  () => { const b = { ...V.blob_v2 }; delete b.senderIdentityKey; return globalThis._decrypt(b, V.from, V.to, ownB); });

// Round-trip своим encrypt/decrypt
const rt2 = await globalThis._encryptV2("round-trip v2 ✓", V.from, V.to, K.id_B.pub_b64, ownA);
check("round-trip v2: version/nonce==iv/senderIdentityKey",
  rt2.version === 2 && rt2.nonce === rt2.iv && rt2.senderIdentityKey === K.id_A.pub_b64);
check("round-trip v2: decrypt", (await globalThis._decrypt(rt2, V.from, V.to, ownB)) === "round-trip v2 ✓");
const rt1 = await globalThis._encryptV1("round-trip v1", V.from, V.to, K.id_B.pub_b64);
check("round-trip v1: decrypt", rt1.version === 1 && (await globalThis._decrypt(rt1, V.from, V.to, ownB)) === "round-trip v1");

// Отпечаток id_A (S3) — сверка со спецификацией
const fp = hex(new Uint8Array(await subtle.digest("SHA-256", idA65))).slice(0, 32);
check("fingerprint(id_A)", fp === V.fingerprint_id_A);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
