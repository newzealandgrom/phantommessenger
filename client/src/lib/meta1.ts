/**
 * meta1 — метаданные пользовательского контента внутри E2E (S10.1 + S10-ПРАВКИ Q1–Q6,
 * documentation/PROTOCOL_S10_SPEC.md).
 *
 * Plaintext внутри blob v2 = U+0000 ‖ компактный UTF-8 JSON
 *   { k: "text"|"file"|"voice"|"reaction", id | target, text, data, name, mime, size,
 *     durMs, wave, replyTo, fwd, sd, emoji, remove, pad }.
 * Снаружи relay видит только { type, toNumber, messageId, encryptedBlob }.
 *
 * Чистый модуль без импортов: его используют и App.tsx (единый диспетчер приёма),
 * и node-тест scripts/test-meta1.mjs (эталон documentation/meta1_vector.json).
 */

export const META1_MARK = "\u0000";

/** Q5: кап WS-кадра / encryptedBlob на relay (MESSAGE_MAX_BLOB_BYTES). */
export const MAX_FRAME_BYTES = 262144;
/** Запас на внешний конверт и поля blob, кроме cipher (номер, messageId, ключи, nonce/iv). */
const FRAME_RESERVE_BYTES = 1024;
/** Максимум байт plaintext, чтобы base64(ct ‖ tag16) вместе с конвертом уложился в кадр. */
export const MAX_META1_PLAINTEXT_BYTES = Math.floor((MAX_FRAME_BYTES - FRAME_RESERVE_BYTES) / 4) * 3 - 16;
/** Запас на JSON-поля файла (k, id, name ≤ 255 символов, mime, size, pad-ключ). */
const ATTACHMENT_JSON_RESERVE = 2048;
/** Расчётный максимум байт вложения: base64(data) + JSON + конверт ≤ кадра. */
export const MAX_ATTACHMENT_BYTES_COMPUTED =
  Math.floor((MAX_META1_PLAINTEXT_BYTES - ATTACHMENT_JSON_RESERVE) / 4) * 3;
/** Честный лимит файла/голоса для UI (округлён вниз до 140 КБ; легаси-формат укладывается тоже). */
export const MAX_ATTACHMENT_BYTES = 140 * 1024;

/** Q5: лимиты полей. */
export const TEXT_MAX_CHARS = 16384;
export const NAME_MAX_CHARS = 255;
export const MIME_MAX_CHARS = 127;
/** Q4 (уточнено): ≤ 32 UTF-16 code units (`.length`) на всех клиентах. */
export const EMOJI_MAX_CHARS = 32;
const ID_MAX_CHARS = 128;
const NUMBER_RE = /^[0-9A-Za-z+_-]{1,64}$/;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// Q5 (S10-ПРАВКИ, ревью M4): в имени файла запрещены категории Cc, Cf (в т.ч. bidi
// U+200E/U+200F/U+202A–U+202E/U+2066–U+2069), Co, Cn, Zl, Zp и разделители пути `/ \`.
const NAME_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}/\\]/u;
const NAME_FORBIDDEN_RE_G = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}/\\]/gu;
// Q4: в emoji запрещены Cc и bidi-управляющие; ZWJ U+200D, U+FE0E/U+FE0F и теги
// U+E0020–U+E007F разрешены (составные эмодзи вроде ❤️‍🔥). Длина ≤ 32 UTF-16 code units.
const EMOJI_FORBIDDEN_RE = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
// Q19: durMs ≤ 3 600 000 (1 ч)
const MAX_DUR_MS = 3_600_000;
/** PROTOCOL_VOICE_V2 §3: волна — ровно 63 байта (100 × 5 бит), в JSON — 84 символа base64. */
export const WAVE_BYTES = 63;
const WAVE_B64_CHARS = 84;
const MAX_SD_SEC = 7 * 24 * 3600;

export type Meta1Reply = { messageId: string; from: string };
type Meta1Common = { id: string; replyTo?: Meta1Reply; fwd?: string; sd?: number | "read" };
export type Meta1Content =
  | (Meta1Common & { k: "text"; text: string })
  | (Meta1Common & { k: "file"; name: string; mime: string; size: number; data: string; text?: string })
  | (Meta1Common & { k: "voice"; mime: string; durMs: number; data: string; wave?: string });

export type Meta1Outcome =
  /** Без маркера U+0000 — легаси-обработка по внешнему типу. */
  | { action: "legacy" }
  /** Новое сообщение (внешний `message`). */
  | { action: "show"; content: Meta1Content }
  /** Правка (внешний `message_edited`): `id` = внешний messageId. */
  | { action: "edit"; id: string; text: string }
  /** Реакция (внешний `reaction`): `target` = внешний messageId. */
  | { action: "reaction"; target: string; emoji: string; remove: boolean }
  /** Неизвестный `k` — игнор без пузыря. */
  | { action: "ignore" }
  /** Q3/Q4: несогласованность с внешним конвертом — дроп без пузыря. */
  | { action: "drop"; reason: string }
  /** Q5/валидация — «[Некорректное сообщение]». */
  | { action: "invalid"; reason: string };

const KNOWN_K = new Set(["text", "file", "voice", "reaction"]);

export function isMeta1Plaintext(plaintext: string): boolean {
  return typeof plaintext === "string" && plaintext.length > 0 && plaintext.charCodeAt(0) === 0;
}

/** S10.1: клиенты вырезают U+0000 из пользовательского текста перед отправкой. */
export function stripNul(text: string): string {
  return text.indexOf("\u0000") === -1 ? text : text.replace(/\u0000/g, "");
}

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Длина в символах Unicode (кодовых точках), как `len()` в Python на relay. */
function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function base64DecodedLength(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

function isB64(s: unknown, maxDecoded: number): s is string {
  return typeof s === "string" && s.length % 4 === 0 && B64_RE.test(s) && base64DecodedLength(s) <= maxDecoded;
}

export function isValidFileName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && codePointLength(name) <= NAME_MAX_CHARS
    && !NAME_FORBIDDEN_RE.test(name);
}

/**
 * `wave` голосового v2 (§1.2): не строка, не base64 или длина ≠ 63 байт → undefined (поле
 * игнорируется, сообщение НЕ invalid). Старшие 4 бита последнего байта (биты 500…503) обнуляются;
 * результат — канонический base64 из 84 символов.
 */
export function parseWaveField(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length !== WAVE_B64_CHARS || !/^[A-Za-z0-9+/]+$/.test(v)) return undefined;
  try {
    const bin = atob(v);
    if (bin.length !== WAVE_BYTES) return undefined;
    const last = String.fromCharCode(bin.charCodeAt(WAVE_BYTES - 1) & 0x0f);
    return btoa(bin.slice(0, WAVE_BYTES - 1) + last);
  } catch { return undefined; }
}

export function isValidMime(mime: unknown): mime is string {
  return typeof mime === "string" && mime.length <= MIME_MAX_CHARS && MIME_RE.test(mime);
}

/** Q2: легаси `duration` < 1000 — секунды, иначе миллисекунды. Результат — секунды. */
export function legacyDurationToSeconds(raw: unknown): number {
  const d = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
  return d < 1000 ? d : Math.round(d / 1000);
}

type Obj = Record<string, unknown>;

// Опциональные поля: replyTo/fwd/sd при некорректном значении отбрасываются. Q19: sd —
// целое 1…604 800 или "read"; иное → поле игнорируется (без таймера), пузырь НЕ invalid.
function parseCommon(o: Obj, id: string): { ok: true; value: Meta1Common } | { ok: false; reason: string } {
  const value: Meta1Common = { id };
  const r = o.replyTo;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const ro = r as Obj;
    if (typeof ro.messageId === "string" && ro.messageId && ro.messageId.length <= ID_MAX_CHARS) {
      value.replyTo = {
        messageId: ro.messageId,
        from: typeof ro.from === "string" && NUMBER_RE.test(ro.from) ? ro.from : "",
      };
    }
  }
  if (typeof o.fwd === "string" && NUMBER_RE.test(o.fwd)) value.fwd = o.fwd;
  if (o.sd === "read") value.sd = "read";
  else if (typeof o.sd === "number" && Number.isInteger(o.sd) && o.sd > 0 && o.sd <= MAX_SD_SEC) value.sd = o.sd;
  return { ok: true, value };
}

/**
 * Разбор расшифрованного plaintext (S10.1, Q1–Q5).
 * `outerType` — тип внешнего кадра (`message` | `message_edited` | `reaction`; P2P — `message`),
 * `outerMessageId` — внешний `messageId`.
 */
export function parseMeta1(plaintext: string, outerType: string, outerMessageId: string): Meta1Outcome {
  if (!isMeta1Plaintext(plaintext)) return { action: "legacy" };
  let obj: unknown;
  try { obj = JSON.parse(plaintext.slice(1)); }
  catch { return { action: "invalid", reason: "bad_json" }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { action: "invalid", reason: "not_object" };
  const o = obj as Obj;
  if (typeof o.k !== "string") return { action: "invalid", reason: "no_k" };
  const k = o.k;
  // Неизвестный k (будущие типы) — игнор без пузыря
  if (!KNOWN_K.has(k)) return { action: "ignore" };

  // Q3: согласованность k ↔ внешний тип (защита от перестановки контекста relay'ем)
  const typeOk =
    (outerType === "message" && (k === "text" || k === "file" || k === "voice")) ||
    ((outerType === "message_edited" || outerType === "message_edit") && k === "text") ||
    (outerType === "reaction" && k === "reaction");
  if (!typeOk) return { action: "drop", reason: "k_type_mismatch" };

  // Q4: привязка к внешнему messageId
  if (!outerMessageId) return { action: "drop", reason: "no_outer_id" };
  if (k === "reaction") {
    if (o.target !== outerMessageId) return { action: "drop", reason: "target_mismatch" };
    if (typeof o.emoji !== "string" || !o.emoji || o.emoji.length > EMOJI_MAX_CHARS || EMOJI_FORBIDDEN_RE.test(o.emoji)) {
      return { action: "invalid", reason: "bad_emoji" };
    }
    // Q19: remove (bool) обязателен — иначе дроп
    if (typeof o.remove !== "boolean") return { action: "drop", reason: "no_remove" };
    return { action: "reaction", target: outerMessageId, emoji: o.emoji, remove: o.remove };
  }
  if (o.id !== outerMessageId) return { action: "drop", reason: "id_mismatch" };

  // Q5: текст (для file — необязательная подпись)
  if (o.text !== undefined && (typeof o.text !== "string" || o.text.length > TEXT_MAX_CHARS)) {
    return { action: "invalid", reason: "bad_text" };
  }
  if (outerType !== "message") {
    if (typeof o.text !== "string") return { action: "invalid", reason: "bad_text" };
    return { action: "edit", id: outerMessageId, text: o.text };
  }
  const common = parseCommon(o, outerMessageId);
  if (!common.ok) return { action: "invalid", reason: common.reason };
  const base = common.value;

  if (k === "text") {
    if (typeof o.text !== "string") return { action: "invalid", reason: "bad_text" };
    return { action: "show", content: { ...base, k: "text", text: o.text } };
  }
  if (k === "file") {
    if (!isValidFileName(o.name)) return { action: "invalid", reason: "bad_name" };
    if (!isValidMime(o.mime)) return { action: "invalid", reason: "bad_mime" };
    if (typeof o.size !== "number" || !Number.isInteger(o.size) || o.size < 0 || o.size > MAX_FRAME_BYTES) {
      return { action: "invalid", reason: "bad_size" };
    }
    if (!isB64(o.data, MAX_FRAME_BYTES)) return { action: "invalid", reason: "bad_data" };
    const content: Meta1Content = { ...base, k: "file", name: o.name, mime: o.mime, size: o.size, data: o.data };
    if (typeof o.text === "string" && o.text) content.text = o.text;
    return { action: "show", content };
  }
  // k === "voice"
  if (!isValidMime(o.mime)) return { action: "invalid", reason: "bad_mime" };
  if (typeof o.durMs !== "number" || !Number.isFinite(o.durMs) || o.durMs < 0 || o.durMs > MAX_DUR_MS) {
    return { action: "invalid", reason: "bad_dur" };
  }
  if (!isB64(o.data, MAX_FRAME_BYTES)) return { action: "invalid", reason: "bad_data" };
  const content: Extract<Meta1Content, { k: "voice" }> = { ...base, k: "voice", mime: o.mime, durMs: Math.round(o.durMs), data: o.data };
  const wave = parseWaveField(o.wave);
  if (wave) content.wave = wave;
  return { action: "show", content };
}

// ─── Отправка ───

/**
 * NUL ‖ компактный JSON с паддингом (SHOULD): длина plaintext кратна 256 байтам
 * (если < 4096) или 4096 (иначе), не превышая `maxBytes`.
 */
export function encodeMeta1(fields: Record<string, unknown>, maxBytes = MAX_META1_PLAINTEXT_BYTES): string {
  const obj: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(fields)) if (v !== undefined) obj[key] = v;
  obj.pad = "";
  const len = utf8Length(META1_MARK + JSON.stringify(obj));
  const bucket = len < 4096 ? 256 : 4096;
  let target = Math.ceil(len / bucket) * bucket;
  if (target > maxBytes) target = Math.max(len, maxBytes);
  obj.pad = " ".repeat(target - len);
  return META1_MARK + JSON.stringify(obj);
}

/** Имя файла для отправки: без Cc/Cf/Co/Cn/Zl/Zp и `/ \` (Q5), ≤ 255 символов. */
export function sanitizeOutgoingFileName(name: string): string {
  const cleaned = Array.from(name.replace(NAME_FORBIDDEN_RE_G, "")).slice(0, NAME_MAX_CHARS).join("");
  return cleaned || "file";
}

export function sanitizeOutgoingMime(mime: string, fallback = "application/octet-stream"): string {
  const m = (mime || "").split(";")[0].trim();
  return isValidMime(m) ? m : fallback;
}

type OutCommon = { id: string; replyTo?: Meta1Reply; fwd?: string; sd?: number | "read" };

export function buildTextPayload(p: OutCommon & { text: string }): string {
  return encodeMeta1({ k: "text", id: p.id, text: stripNul(p.text), replyTo: p.replyTo, fwd: p.fwd, sd: p.sd });
}

export function buildFilePayload(p: OutCommon & { name: string; mime: string; size: number; data: string; text?: string }): string {
  return encodeMeta1({
    k: "file", id: p.id, name: sanitizeOutgoingFileName(p.name), mime: sanitizeOutgoingMime(p.mime),
    size: p.size, text: p.text ? stripNul(p.text) : undefined, replyTo: p.replyTo, fwd: p.fwd, sd: p.sd, data: p.data,
  });
}

/** `wave` — base64 63 байт (voiceWave.waveToBase64); невалидная не посылается (выдуманную волну слать нельзя). */
export function buildVoicePayload(p: OutCommon & { mime: string; durMs: number; data: string; wave?: string }): string {
  return encodeMeta1({
    k: "voice", id: p.id, mime: sanitizeOutgoingMime(p.mime, "audio/webm"), durMs: Math.max(0, Math.round(p.durMs)),
    wave: p.wave === undefined ? undefined : parseWaveField(p.wave),
    replyTo: p.replyTo, fwd: p.fwd, sd: p.sd, data: p.data,
  });
}

/** Правка: `id` = id правимого сообщения (= внешний messageId кадра message_edit). */
export function buildEditPayload(p: { id: string; text: string }): string {
  return encodeMeta1({ k: "text", id: p.id, text: stripNul(p.text) });
}

/** Реакция: `target` = внешний messageId кадра reaction. */
export function buildReactionPayload(p: { target: string; emoji: string; remove: boolean }): string {
  return encodeMeta1({ k: "reaction", target: p.target, emoji: p.emoji, remove: p.remove });
}
