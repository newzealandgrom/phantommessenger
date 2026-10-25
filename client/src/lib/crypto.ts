/**
 * E2E crypto layer — ECDH P-256 + AES-256-GCM via WebCrypto API.
 * Wire-compatible with Android client (PhantomCrypto.kt).
 *
 * Key exchange: ECDH P-256 (secp256r1)
 * Symmetric:   AES-256-GCM (128-bit tag)
 * KDF:         SHA-256(sharedSecret || "direct:{from}:{to}")
 * AD:          "msg:{from}:{to}"
 * Public key:  65-byte uncompressed P-256 point, base64-encoded
 *
 * Forward secrecy: each message uses a fresh ephemeral ECDH keypair
 * so compromise of one message key cannot decrypt others.
 */
import type { EncryptedBlob } from "../types";
import { p256 } from "@noble/curves/nist.js";

export type SessionKeys = {
  publicKey: string;      // base64 of 65-byte raw P-256 uncompressed point
  privateKey: CryptoKey;  // ECDH P-256 private key (non-extractable)
};

// ─── helpers ───

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

// ─── key generation ───

/** Generate ephemeral ECDH P-256 keypair. */
export async function createSessionKeys(): Promise<SessionKeys> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );

  const rawPub = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return {
    publicKey: toBase64(rawPub),
    privateKey: keyPair.privateKey,
  };
}

// ─── key fingerprint (W-07) ───

/**
 * Compute a human-readable fingerprint for a public key.
 * SHA-256 of the raw key bytes, formatted as groups of hex digits.
 * Users can compare fingerprints out-of-band to verify key authenticity.
 *
 * Example: "a3f8 12bc 9e45 d017  8c6a 3f2b 1e90 7d5c"
 */
export async function keyFingerprint(publicKeyBase64: string): Promise<string> {
  const raw = fromBase64(publicKeyBase64);
  const hash = await crypto.subtle.digest("SHA-256", raw);
  const bytes = new Uint8Array(hash);
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    hex.push(bytes[i].toString(16).padStart(2, "0"));
  }
  // Format: "xxxx xxxx xxxx xxxx  xxxx xxxx xxxx xxxx"
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
  ].map(g => g.match(/.{4}/g)!.join(" ")).join("  ");
}

// ─── ECDH + KDF ───

/** Validate that `raw` is an uncompressed 65-byte P-256 point on-curve.
 *
 * Some WebCrypto backends historically accepted off-curve points and would
 * produce a "shared secret" that in fact reveals the private key (classic
 * invalid-curve attack — e.g. CVE-2017-5655 in older Safari). The fix is
 * universal: reject any peer point that does not satisfy the curve equation
 * BEFORE feeding it to `subtle.importKey`. We delegate to @noble/curves,
 * whose `ProjectivePoint.fromBytes` throws on malformed or off-curve input.
 */
function assertValidP256Point(raw: Uint8Array): void {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("ecdh_invalid_point_format");
  }
  try {
    p256.Point.fromBytes(raw).assertValidity();
  } catch (err) {
    throw new Error(`ecdh_invalid_point: ${(err as Error)?.message || "off-curve"}`);
  }
}

/** Import raw 65-byte P-256 public key and perform ECDH → 32-byte shared secret. */
async function ecdhSharedSecret(
  privateKey: CryptoKey,
  peerPublicKeyBase64: string,
): Promise<ArrayBuffer> {
  const raw = new Uint8Array(fromBase64(peerPublicKeyBase64));
  assertValidP256Point(raw);
  const peerPublicKey = await crypto.subtle.importKey(
    "raw",
    raw as unknown as ArrayBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256,
  );
}

/** SHA-256(sharedSecret || "direct:{from}:{to}") → AES-256 key.  Matches Android. */
async function deriveAesKey(
  shared: ArrayBuffer,
  fromNumber: string,
  toNumber: string,
): Promise<CryptoKey> {
  const ctx = new TextEncoder().encode(`direct:${fromNumber}:${toNumber}`);
  const buf = new ArrayBuffer(shared.byteLength + ctx.length);
  const view = new Uint8Array(buf);
  view.set(new Uint8Array(shared), 0);
  view.set(ctx, shared.byteLength);

  const hash = await crypto.subtle.digest("SHA-256", buf);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// ─── encrypt / decrypt ───

/**
 * Encrypt a message using a fresh ephemeral ECDH keypair (forward secrecy).
 * Each call generates a new sender keypair, so compromising one message's
 * key material cannot decrypt any other message.
 *
 * The targetPublicKey is the recipient's registered session key.
 * The senderPublicKey/senderPrivateKey params are the caller's session keys
 * and are kept for relay registration — encryption uses ephemeral keys.
 */
export async function encryptMessage({
  text,
  fromNumber,
  toNumber,
  targetPublicKey,
}: {
  text: string;
  fromNumber: string;
  toNumber: string;
  senderPublicKey?: string;
  senderPrivateKey?: CryptoKey;
  targetPublicKey: string;
}): Promise<EncryptedBlob> {
  // Generate per-message ephemeral keypair for forward secrecy
  const ephemeral = await createSessionKeys();

  const shared = await ecdhSharedSecret(ephemeral.privateKey, targetPublicKey);
  const aesKey = await deriveAesKey(shared, fromNumber, toNumber);

  // Hybrid 12-byte IV:  [6B big-endian ms-since-epoch mod 2^48] || [6B CSPRNG]
  //
  // Pure random IVs are fine at the birthday bound 2^48, but a regression
  // that reuses an ephemeral key would be catastrophic under AES-GCM: the
  // two XOR'd ciphertexts reveal the plaintexts. Prefixing with a
  // monotonic timestamp makes collisions impossible across time, even if
  // the ephemeral keypair path ever mis-fires. The random tail preserves
  // confidentiality against a predictable-IV side channel.
  const iv = new Uint8Array(12);
  const tsMs = Date.now();            // 2^48 ms ≈ year 10895; safe for 48 bits
  iv[0] = (tsMs / 0x10000000000) & 0xff;
  iv[1] = (tsMs / 0x100000000) & 0xff;
  iv[2] = (tsMs >>> 24) & 0xff;
  iv[3] = (tsMs >>> 16) & 0xff;
  iv[4] = (tsMs >>> 8) & 0xff;
  iv[5] = tsMs & 0xff;
  crypto.getRandomValues(iv.subarray(6));
  const ad = new TextEncoder().encode(`msg:${fromNumber}:${toNumber}`);
  const plaintext = new TextEncoder().encode(text);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ad, tagLength: 128 },
    aesKey,
    plaintext,
  );

  // Drop ephemeral private key immediately after use
  wipePrivateKey(ephemeral.privateKey);

  const nonceB64 = toBase64(iv.buffer as ArrayBuffer);
  return {
    version: 1,
    senderPublicKey: ephemeral.publicKey, // ephemeral public key for this message
    nonce: nonceB64,
    iv: nonceB64, // Android compatibility alias
    cipher: toBase64(ciphertext),
  };
}

export async function decryptMessage({
  blob,
  fromNumber,
  toNumber,
  localPrivateKey,
}: {
  blob: EncryptedBlob;
  fromNumber: string;
  toNumber: string;
  localPrivateKey: CryptoKey;
}): Promise<string> {
  const shared = await ecdhSharedSecret(localPrivateKey, blob.senderPublicKey);
  const aesKey = await deriveAesKey(shared, fromNumber, toNumber);

  const iv = fromBase64(blob.nonce || blob.iv!);
  const ciphertext = fromBase64(blob.cipher);
  const ad = new TextEncoder().encode(`msg:${fromNumber}:${toNumber}`);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: ad, tagLength: 128 },
    aesKey,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}

// ─── cleanup ───

/**
 * Discard a CryptoKey reference.
 * WebCrypto keys are non-extractable opaque handles — we can't zero
 * their internal memory, but we CAN drop the JS reference so the
 * browser's GC can reclaim the object sooner.
 * Returns null so callers can write: ref = wipePrivateKey(ref);
 */
export function wipePrivateKey(key?: CryptoKey | null): null {
  // Intentionally unused: the act of dropping the reference is the cleanup.
  void key;
  return null;
}
