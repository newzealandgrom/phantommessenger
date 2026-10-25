/**
 * Safety number и отпечаток ключа — алгоритм `phantom-safety-v1` (X-02, спецификация S3).
 * Одинаков на web / Android / iOS; спецификация продублирована в `types.ts`.
 *
 * Работает только с ПУБЛИЧНЫМИ ключами (свой и собеседника), поэтому считается
 * на странице, а не в Service Worker: секретов здесь нет.
 */

// DER-префикс SubjectPublicKeyInfo для uncompressed P-256 (id-ecPublicKey + prime256v1).
const P256_SPKI_PREFIX = new Uint8Array([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

const SAFETY_LABEL = new TextEncoder().encode("phantom-safety-v1");

function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const s = atob(b64.trim().replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Привести публичный ключ (base64 raw 65 байт или SPKI 91 байт) к raw `0x04‖X‖Y`. */
export function toRawP256(publicKeyB64: string): Uint8Array | null {
  const bytes = b64ToBytes(publicKeyB64);
  if (!bytes) return null;
  if (bytes.length === 65 && bytes[0] === 0x04) return bytes;
  if (bytes.length === P256_SPKI_PREFIX.length + 65) {
    for (let i = 0; i < P256_SPKI_PREFIX.length; i++) {
      if (bytes[i] !== P256_SPKI_PREFIX[i]) return null;
    }
    const raw = bytes.slice(P256_SPKI_PREFIX.length);
    return raw[0] === 0x04 ? raw : null;
  }
  return null;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Копия в отдельный ArrayBuffer — subtle.digest не принимает SharedArrayBuffer-вью.
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** S3: 12 групп по 5 цифр из raw-ключей (65 байт каждый). */
export async function safetyNumberRaw(selfRaw65: Uint8Array, peerRaw65: Uint8Array): Promise<string[]> {
  const [lo, hi] = compareBytes(selfRaw65, peerRaw65) <= 0
    ? [selfRaw65, peerRaw65]
    : [peerRaw65, selfRaw65];
  const input = new Uint8Array(SAFETY_LABEL.length + lo.length + hi.length);
  input.set(SAFETY_LABEL, 0);
  input.set(lo, SAFETY_LABEL.length);
  input.set(hi, SAFETY_LABEL.length + lo.length);
  const h = await sha256(input);
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    const v = (h[2 * i] << 8) | h[2 * i + 1];
    groups.push(String(v % 100000).padStart(5, "0"));
  }
  return groups;
}

// ─── S10.2 phantom-safety-v2 (X-02) ───
// lp(s) = u8(len(utf8(s))) ‖ utf8(s); пары (номер, raw65 identity-ключ) сортируются по
// utf8(номер), при равенстве — по raw65;
// digest = SHA-256( "phantom-safety-v2" ‖ 0x00 ‖ lp(nLo) ‖ kLo ‖ lp(nHi) ‖ kHi ).
// Номера — канонические 10 цифр (как fromNumber/toNumber relay и from/to в HKDF v2).
// Эталон: documentation/safety_v2_vector.json.
const SAFETY_V2_LABEL = new TextEncoder().encode("phantom-safety-v2");

function groupsFromDigest(h: Uint8Array): string[] {
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    const v = (h[2 * i] << 8) | h[2 * i + 1];
    groups.push(String(v % 100000).padStart(5, "0"));
  }
  return groups;
}

/** S10.2: вход для SHA-256 (вынесен для сверки с `input_hex` эталона). */
export function safetyV2Input(selfNumber: string, selfRaw65: Uint8Array, peerNumber: string, peerRaw65: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const a = { n: enc.encode(selfNumber), k: selfRaw65 };
  const b = { n: enc.encode(peerNumber), k: peerRaw65 };
  if (a.n.length > 255 || b.n.length > 255) throw new Error("safety_v2_number_too_long");
  let cmp = compareBytes(a.n, b.n);
  if (cmp === 0) cmp = compareBytes(a.k, b.k);
  const [lo, hi] = cmp <= 0 ? [a, b] : [b, a];
  const parts = [SAFETY_V2_LABEL, new Uint8Array([0]), new Uint8Array([lo.n.length]), lo.n, lo.k,
    new Uint8Array([hi.n.length]), hi.n, hi.k];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** S10.2: 12 групп по 5 цифр из raw-ключей и номеров. */
export async function safetyNumberV2Raw(
  selfNumber: string, selfRaw65: Uint8Array, peerNumber: string, peerRaw65: Uint8Array,
): Promise<string[]> {
  return groupsFromDigest(await sha256(safetyV2Input(selfNumber, selfRaw65, peerNumber, peerRaw65)));
}

/** S10.2: safety number v2 по base64-ключам; null — если ключ не P-256. */
export async function safetyNumberV2(
  selfNumber: string, selfKeyB64: string, peerNumber: string, peerKeyB64: string,
): Promise<string[] | null> {
  const a = toRawP256(selfKeyB64);
  const b = toRawP256(peerKeyB64);
  if (!a || !b || !selfNumber || !peerNumber) return null;
  return safetyNumberV2Raw(selfNumber, a, peerNumber, b);
}

/** S10.4: содержимое QR сверки (показывает своя сторона). */
export function safetyQrPayload(selfNumber: string, selfFp: string, peerNumber: string, peerFp: string): string {
  return `phantomsafety:2:${selfNumber}:${selfFp}:${peerNumber}:${peerFp}`;
}

/** S3: safety number по base64-ключам; null — если ключ не P-256. */
export async function safetyNumber(selfKeyB64: string, peerKeyB64: string): Promise<string[] | null> {
  const a = toRawP256(selfKeyB64);
  const b = toRawP256(peerKeyB64);
  if (!a || !b) return null;
  return safetyNumberRaw(a, b);
}

/** S3: отпечаток для привязки «verified» — hex(SHA-256(raw65))[:32]. */
export async function keyFingerprint(publicKeyB64: string): Promise<string | null> {
  const raw = toRawP256(publicKeyB64);
  if (!raw) return null;
  const h = await sha256(raw);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += h[i].toString(16).padStart(2, "0");
  return hex;
}
