/**
 * P2P files_v1 — файлы идут ТОЛЬКО по DataChannel `phantom-p2p`, relay их не видит
 * (documentation/PROTOCOL_P2P_V2.md §4, эталон documentation/p2p_file_vector.json).
 *
 *   file_offer (текстовый кадр DC) = { type, messageId, fileId, encryptedBlob }, plaintext конверта v2 =
 *     U+0000 ‖ JSON { k:"file_offer", id, fileId, name, mime, size, sha256, key, nonceBase, chunk, text?, replyTo?, sd? }
 *   чанк (бинарный кадр DC) = fileId(16) ‖ ctr(4, BE) ‖ AES-256-GCM(key, nonceBase(8) ‖ ctr(4, BE), plaintext_i, AD) ‖ tag(16)
 *   AD = UTF8("phantom-p2p-file:1:" + from + ":" + to) ‖ fileId(16) ‖ ctr(4, BE)
 *
 * Чистый модуль без React (WebCrypto + потоковый SHA-256 из @noble/hashes — WebCrypto не умеет
 * хешировать по частям). Его используют App.tsx и node-тест scripts/test-p2p-file.mjs.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { isValidFileName, isValidMime, TEXT_MAX_CHARS } from "./meta1";

type Bytes = Uint8Array<ArrayBuffer>;

/** §3.4: возможности, объявляемые в `hello` v2. */
export const P2P_HELLO_FEATURES = ["messages", "delivery_ack", "files_v1", "events_v1"] as const;
export const FILE_CHUNK_DEFAULT = 65536;
export const FILE_CHUNK_MAX = 65536;
export const FILE_ID_BYTES = 16;
export const FILE_FRAME_HEADER = FILE_ID_BYTES + 4;
export const FILE_TAG_BYTES = 16;
/** 20 + 65536 + 16 = 65 572 байт. */
export const FILE_FRAME_MAX = FILE_FRAME_HEADER + FILE_CHUNK_MAX + FILE_TAG_BYTES;
/** §4.5: web собирает файл в Blob в RAM — больше 2 ГиБ браузеры не тянут → `too_large`. */
export const WEB_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** §4.5: ≤ 3 входящих и ≤ 3 исходящих передач на пира. */
export const MAX_TRANSFERS_PER_PEER = 3;
/** §4.5: backpressure DataChannel. */
export const DC_BUFFER_HIGH = 1024 * 1024;
export const DC_BUFFER_LOW = 256 * 1024;
/** §4.4: допустимые причины `file_abort`; неизвестные показываются как «Передача прервана». */
export const FILE_ABORT_REASONS = [
  "declined", "busy", "disk_full", "too_large", "unsupported", "timeout", "invalid", "cancelled", "protocol", "io",
] as const;
export type FileAbortReason = typeof FILE_ABORT_REASONS[number];

const AD_LABEL = "phantom-p2p-file:1:";
const MAX_SD_SEC = 7 * 24 * 3600;
const ID_MAX_CHARS = 128;
const NUMBER_RE = /^[0-9A-Za-z+_-]{1,64}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// ─── hello (§3.4) ───

/** §3.4: кадр `hello` v2 — первый кадр после open и (один раз) ответ на первый hello пира. */
export function buildHelloFrame(deviceId: string): string {
  return JSON.stringify({
    type: "hello", version: 2, features: [...P2P_HELLO_FEATURES], deviceId,
    maxChunk: FILE_CHUNK_MAX, maxInflight: MAX_TRANSFERS_PER_PEER,
  });
}

/**
 * §3.4: разбор `hello` пира (v1 без features → только messages; неизвестные поля игнорируются).
 * `reply` — отправить свой hello ещё раз: только на ПЕРВЫЙ hello пира в этом канале. Старые iOS/macOS
 * (до 23.10.2026) назначали delegate DC отвечающей стороны с задержкой и теряли наш первый hello,
 * а их hello приходит уже после назначения — ответ до них доходит. Каждая сторона шлёт ≤ 2 hello.
 */
export function parseHelloFrame(data: Record<string, unknown>, alreadyReceived: boolean):
  { features: string[]; deviceId: string; reply: boolean } {
  const feats: string[] = Array.isArray(data.features)
    ? data.features.filter((f: unknown): f is string => typeof f === "string" && f.length <= 32).slice(0, 16)
    : [];
  return {
    features: feats.includes("messages") ? feats : ["messages", ...feats],
    deviceId: typeof data.deviceId === "string" && /^[0-9a-f]{16,64}$/.test(data.deviceId) ? data.deviceId : "",
    reply: !alreadyReceived,
  };
}

// ─── кодеки ───

export function toHex(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, "0");
  return s;
}

/** Строгий hex (нижний регистр, чётная длина); иначе null. */
export function fromHex(hex: string): Bytes | null {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toB64(u8: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

/** Строгий base64 (std, с паддингом) ровно `len` байт; иначе null. */
export function fromB64(b64: unknown, len: number): Bytes | null {
  if (typeof b64 !== "string" || b64.length % 4 !== 0 || !B64_RE.test(b64)) return null;
  let bin: string;
  try { bin = atob(b64); } catch { return null; }
  if (bin.length !== len) return null;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function ctrBytes(ctr: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, ctr >>> 0, false);
  return b;
}

function concat(...parts: Uint8Array[]): Bytes {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ─── параметры чанков ───

export function chunkCount(size: number, chunk: number): number {
  return Math.ceil(size / chunk);
}

/** Длина plaintext чанка `ctr` (последний может быть короче). */
export function chunkPlainLen(size: number, chunk: number, ctr: number): number {
  return Math.max(0, Math.min(chunk, size - ctr * chunk));
}

export function fileNonce(nonceBase: Uint8Array, ctr: number): Bytes {
  return concat(nonceBase, ctrBytes(ctr));
}

export function fileAd(from: string, to: string, fileId: Uint8Array, ctr: number): Bytes {
  return concat(new TextEncoder().encode(`${AD_LABEL}${from}:${to}`), fileId, ctrBytes(ctr));
}

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** Ключ файла (32 Б) → AES-GCM CryptoKey, не извлекаемый. */
export function importFileKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as Bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export type ChunkParams = {
  key: CryptoKey;
  nonceBase: Uint8Array;
  fileId: Uint8Array;
  ctr: number;
  /** from/to — как в конверте file_offer: отправитель → получатель. */
  from: string;
  to: string;
};

/** Кадр чанка: fileId ‖ ctr ‖ ct ‖ tag. */
export async function encryptFileChunk(p: ChunkParams & { plaintext: Uint8Array }): Promise<Bytes> {
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: fileNonce(p.nonceBase, p.ctr), additionalData: fileAd(p.from, p.to, p.fileId, p.ctr), tagLength: 128 },
    p.key, p.plaintext as Bytes,
  ));
  return concat(p.fileId, ctrBytes(p.ctr), ct);
}

/** Заголовок бинарного кадра; null — кадр не похож на чанк (дроп без разрыва канала). */
export function parseFileFrame(frame: Uint8Array): { fileIdHex: string; ctr: number; body: Bytes } | null {
  if (!(frame instanceof Uint8Array) || frame.length < FILE_FRAME_HEADER + FILE_TAG_BYTES || frame.length > FILE_FRAME_MAX) return null;
  const fileIdHex = toHex(frame.subarray(0, FILE_ID_BYTES));
  const ctr = new DataView(frame.buffer, frame.byteOffset + FILE_ID_BYTES, 4).getUint32(0, false);
  return { fileIdHex, ctr, body: frame.slice(FILE_FRAME_HEADER) };
}

/** Расшифровка тела кадра (ct ‖ tag) для ОЖИДАЕМОГО ctr. GCM fail → исключение. */
export async function decryptFileChunk(p: ChunkParams & { body: Uint8Array }): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fileNonce(p.nonceBase, p.ctr), additionalData: fileAd(p.from, p.to, p.fileId, p.ctr), tagLength: 128 },
    p.key, p.body as Bytes,
  ));
}

// ─── SHA-256 всего файла (потоково) ───

export type StreamHash = { update(u8: Uint8Array): void; hex(): string };

export function createSha256(): StreamHash {
  const h = sha256.create();
  return {
    update(u8: Uint8Array) { h.update(u8); },
    hex() { return toHex(h.digest()); },
  };
}

/** SHA-256 Blob/File по частям `File.slice` (файл целиком в память не читается). */
export async function sha256OfBlob(blob: Blob, step = 4 * 1024 * 1024, shouldStop?: () => boolean): Promise<string | null> {
  const h = createSha256();
  for (let off = 0; off < blob.size; off += step) {
    if (shouldStop?.()) return null;
    h.update(new Uint8Array(await blob.slice(off, Math.min(off + step, blob.size)).arrayBuffer()));
  }
  return h.hex();
}

// ─── file_offer ───

export type FileOfferReply = { messageId: string; from: string };
export type FileOffer = {
  id: string;
  fileIdHex: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  key: Uint8Array;
  nonceBase: Uint8Array;
  chunk: number;
  text?: string;
  replyTo?: FileOfferReply;
  sd?: number | "read";
};

/** Plaintext конверта file_offer: U+0000 ‖ компактный JSON (порядок полей как в эталоне). */
export function buildFileOfferPlaintext(o: FileOffer): string {
  const obj: Record<string, unknown> = {
    k: "file_offer", id: o.id, fileId: o.fileIdHex, name: o.name, mime: o.mime, size: o.size,
    sha256: o.sha256, key: toB64(o.key), nonceBase: toB64(o.nonceBase), chunk: o.chunk,
  };
  if (o.text) obj.text = o.text.replace(/\u0000/g, "");
  if (o.replyTo) obj.replyTo = { messageId: o.replyTo.messageId, from: o.replyTo.from };
  if (o.sd !== undefined) obj.sd = o.sd;
  return "\u0000" + JSON.stringify(obj);
}

export type FileOfferParse = { ok: true; offer: FileOffer } | { ok: false; reason: string };

/**
 * §4.2: разбор и валидация расшифрованного file_offer. `outerMessageId`/`outerFileIdHex` — из
 * внешнего кадра DC (Q3/Q4: перестановка → invalid). Любое нарушение → `file_abort invalid`.
 */
export function parseFileOffer(pt: string, outerMessageId: string, outerFileIdHex: string): FileOfferParse {
  if (typeof pt !== "string" || pt.charCodeAt(0) !== 0) return { ok: false, reason: "not_meta1" };
  let raw: unknown;
  try { raw = JSON.parse(pt.slice(1)); } catch { return { ok: false, reason: "bad_json" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not_object" };
  const o = raw as Record<string, unknown>;
  if (o.k !== "file_offer") return { ok: false, reason: "bad_k" };
  if (typeof outerMessageId !== "string" || !outerMessageId || outerMessageId.length > ID_MAX_CHARS || o.id !== outerMessageId) {
    return { ok: false, reason: "id_mismatch" };
  }
  if (typeof o.fileId !== "string" || !HEX32_RE.test(o.fileId) || o.fileId !== outerFileIdHex) return { ok: false, reason: "fileid_mismatch" };
  if (!isValidFileName(o.name)) return { ok: false, reason: "bad_name" };
  if (!isValidMime(o.mime)) return { ok: false, reason: "bad_mime" };
  if (typeof o.size !== "number" || !Number.isSafeInteger(o.size) || o.size < 1) return { ok: false, reason: "bad_size" };
  if (typeof o.sha256 !== "string" || !HEX64_RE.test(o.sha256)) return { ok: false, reason: "bad_sha256" };
  const key = fromB64(o.key, 32);
  if (!key) return { ok: false, reason: "bad_key" };
  const nonceBase = fromB64(o.nonceBase, 8);
  if (!nonceBase) return { ok: false, reason: "bad_nonce" };
  if (typeof o.chunk !== "number" || !Number.isInteger(o.chunk) || o.chunk < 1 || o.chunk > FILE_CHUNK_MAX) return { ok: false, reason: "bad_chunk" };
  // ctr — 32 бита: больше 2^32 чанков nonce не уникален
  if (chunkCount(o.size, o.chunk) > 0xffffffff) return { ok: false, reason: "too_many_chunks" };
  if (o.text !== undefined && (typeof o.text !== "string" || o.text.length > TEXT_MAX_CHARS)) return { ok: false, reason: "bad_text" };
  const offer: FileOffer = {
    id: o.id as string, fileIdHex: o.fileId, name: o.name, mime: o.mime, size: o.size, sha256: o.sha256,
    key, nonceBase, chunk: o.chunk,
  };
  if (typeof o.text === "string" && o.text) offer.text = o.text;
  // Опциональные поля с некорректным значением отбрасываются (как в meta1 parseCommon)
  const r = o.replyTo;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const ro = r as Record<string, unknown>;
    if (typeof ro.messageId === "string" && ro.messageId && ro.messageId.length <= ID_MAX_CHARS) {
      offer.replyTo = { messageId: ro.messageId, from: typeof ro.from === "string" && NUMBER_RE.test(ro.from) ? ro.from : "" };
    }
  }
  if (o.sd === "read") offer.sd = "read";
  else if (typeof o.sd === "number" && Number.isInteger(o.sd) && o.sd > 0 && o.sd <= MAX_SD_SEC) offer.sd = o.sd;
  return { ok: true, offer };
}

/**
 * Тип Blob для показа принятого файла: только по сигнатуре (`sniffedMime`), кроме аудио/видео
 * (сниффер их не знает; играются в <audio>/<video>). Всё остальное — octet-stream: blob: URL живёт
 * в origin приложения, text/html или image/svg+xml из чужого файла открывать нельзя.
 */
export function safeReceivedMime(declared: string, sniffedMime: string): string {
  if (sniffedMime) return sniffedMime;
  const m = (declared || "").toLowerCase();
  if (/^(audio|video)\/[\w.+-]+$/.test(m)) return m;
  return "application/octet-stream";
}

// ─── отправка чанков (потоково, с backpressure) ───

/** Минимальный интерфейс RTCDataChannel, нужный отправителю (в тесте — заглушка). */
export type DcLike = {
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: Bytes): void;
  addEventListener(type: "bufferedamountlow" | "close", fn: () => void): void;
  removeEventListener(type: "bufferedamountlow" | "close", fn: () => void): void;
};

function waitBufferedLow(dc: DcLike): Promise<void> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      dc.removeEventListener("bufferedamountlow", done);
      dc.removeEventListener("close", done);
      resolve();
    };
    dc.addEventListener("bufferedamountlow", done);
    dc.addEventListener("close", done);
    // Страховка: событие могло проскочить до подписки
    timer = setTimeout(done, 1000);
  });
}

export type SendChunksResult = "done" | "stopped" | "closed";

/**
 * §4.3/§4.5: шифрует и шлёт чанки 0..n-1. Файл читается блоками `File.slice` по 16 чанков
 * (целиком в память не попадает); `send` не вызывается при `bufferedAmount > DC_BUFFER_HIGH`.
 */
export async function sendFileChunks(p: ChunkParamsNoCtr & {
  file: Blob; size: number; chunk: number; dc: DcLike;
  shouldStop: () => boolean; onProgress?: (sentBytes: number) => void;
}): Promise<SendChunksResult> {
  const n = chunkCount(p.size, p.chunk);
  const block = p.chunk * 16;
  for (let ctr = 0; ctr < n;) {
    const off = ctr * p.chunk;
    const buf = new Uint8Array(await p.file.slice(off, Math.min(off + block, p.size)).arrayBuffer());
    for (let i = 0; i < buf.length && ctr < n; i += p.chunk, ctr++) {
      while (p.dc.readyState === "open" && p.dc.bufferedAmount > DC_BUFFER_HIGH && !p.shouldStop()) await waitBufferedLow(p.dc);
      if (p.shouldStop()) return "stopped";
      if (p.dc.readyState !== "open") return "closed";
      const frame = await encryptFileChunk({
        key: p.key, nonceBase: p.nonceBase, fileId: p.fileId, ctr, from: p.from, to: p.to,
        plaintext: buf.subarray(i, Math.min(i + p.chunk, buf.length)),
      });
      if (p.shouldStop()) return "stopped";
      if (p.dc.readyState !== "open") return "closed";
      try { p.dc.send(frame); } catch { return "closed"; }
      p.onProgress?.(Math.min(p.size, (ctr + 1) * p.chunk));
    }
  }
  return "done";
}

export type ChunkParamsNoCtr = Omit<ChunkParams, "ctr">;

// ─── приём чанков ───

/** Сколько расшифрованных байт копить в массивах, прежде чем свернуть в Blob (браузер может выгрузить Blob на диск). */
const RX_COALESCE_BYTES = 8 * 1024 * 1024;

/**
 * §4.5/§5.2: приёмник одного файла. `push` вызывается синхронно из onmessage в порядке кадров
 * (порядок сохраняется внутренней цепочкой). Ошибка → причина `file_abort`, частичные данные сброшены.
 */
export class FileReceiver {
  readonly n: number;
  expected = 0;
  receivedBytes = 0;
  failed: FileAbortReason | null = null;
  private readonly hash = createSha256();
  private pending: Bytes[] = [];
  private pendingBytes = 0;
  private blobs: Blob[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly p: ChunkParamsNoCtr & { size: number; chunk: number; sha256: string }) {
    this.n = chunkCount(p.size, p.chunk);
  }

  private fail(reason: FileAbortReason): FileAbortReason {
    if (!this.failed) this.failed = reason;
    this.discard();
    return this.failed;
  }

  /** Сбросить накопленное (отмена/ошибка/обрыв канала). */
  discard(): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.blobs = [];
  }

  /** null — чанк принят; иначе причина abort. */
  push(ctr: number, body: Uint8Array): Promise<FileAbortReason | null> {
    const run = async (): Promise<FileAbortReason | null> => {
      if (this.failed) return this.failed;
      if (ctr !== this.expected || this.expected >= this.n) return this.fail("protocol");
      let pt: Bytes;
      try {
        pt = await decryptFileChunk({ key: this.p.key, nonceBase: this.p.nonceBase, fileId: this.p.fileId, ctr, body, from: this.p.from, to: this.p.to });
      } catch { return this.fail("invalid"); }
      if (this.failed) return this.failed;
      if (pt.length !== chunkPlainLen(this.p.size, this.p.chunk, ctr)) return this.fail("protocol");
      this.expected++;
      this.receivedBytes += pt.length;
      this.hash.update(pt);
      this.pending.push(pt);
      this.pendingBytes += pt.length;
      if (this.pendingBytes >= RX_COALESCE_BYTES) {
        this.blobs.push(new Blob(this.pending));
        this.pending = [];
        this.pendingBytes = 0;
      }
      return null;
    };
    const r = this.chain.then(run);
    this.chain = r;
    return r;
  }

  /** file_end: все n чанков и sha256 → Blob, иначе причина abort (sha256 при нехватке чанков не считается). */
  async finish(mime: string): Promise<{ ok: true; blob: Blob } | { ok: false; reason: FileAbortReason }> {
    await this.chain;
    if (this.failed) return { ok: false, reason: this.failed };
    if (this.expected !== this.n) return { ok: false, reason: this.fail("protocol") };
    if (this.hash.hex() !== this.p.sha256) return { ok: false, reason: this.fail("invalid") };
    const blob = new Blob([...this.blobs, ...this.pending], { type: mime });
    this.discard();
    return { ok: true, blob };
  }
}
