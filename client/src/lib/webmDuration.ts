/**
 * Правка `Info/Duration` в WebM от MediaRecorder (чистый модуль без импортов).
 *
 * Firefox пишет `Duration = 0`, Chrome — вообще без Duration (и тот, и другой — без Cues).
 * С `Duration = 0` Firefox отдаёт `audio.duration = Infinity`, `seekable` пуст, перемотка не работает
 * (проверено на Firefox, headless). Если подставить длительность (она известна: `durMs` из meta1),
 * `duration` конечна и `currentTime = …` работает. Правка ТОЛЬКО на месте: уже существующий
 * элемент Duration (float32/float64) перезаписывается тем же размером; ничего не вставляется,
 * размеры контейнеров не меняются. Чужие байты не читаются за пределы буфера.
 */

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

/** Вложенность не глубже Segment → Info; предел числа элементов — защита от «бомбы». */
const MAX_ELEMENTS = 256;

function readId(b: Uint8Array, p: number): { id: number; len: number } | null {
  if (p >= b.length) return null;
  const first = b[p];
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 4 || p + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[p + i];
  return { id, len };
}

/** size < 0 — «неизвестный размер» (все биты значения = 1). */
function readSize(b: Uint8Array, p: number): { size: number; len: number } | null {
  if (p >= b.length) return null;
  const first = b[p];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || p + len > b.length) return null;
  let v = first & (0xff >> len);
  let allOnes = v === (0xff >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) allOnes = false; }
  if (allOnes) return { size: -1, len };
  if (!Number.isSafeInteger(v)) return null;
  return { size: v, len };
}

function readUint(b: Uint8Array, p: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[p + i];
  return v;
}

/**
 * Копия `bytes` с подставленной `Info/Duration` = `durMs`, если элемент есть и его значение ≤ 0 / не число.
 * null — править нечего (не WebM, Duration нет или уже конечна и > 0, некорректная структура).
 */
export function patchWebmDuration(bytes: Uint8Array, durMs: number): Uint8Array<ArrayBuffer> | null {
  if (!(durMs > 0) || !Number.isFinite(durMs) || bytes.length < 16) return null;
  if (!(bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) return null;
  let count = 0;
  // Верхний уровень: EBML-заголовок, затем Segment
  let p = 0;
  let segStart = -1;
  let segEnd = bytes.length;
  while (p < bytes.length && count++ < MAX_ELEMENTS) {
    const id = readId(bytes, p); if (!id) return null;
    const sz = readSize(bytes, p + id.len); if (!sz) return null;
    const body = p + id.len + sz.len;
    if (id.id === ID_SEGMENT) {
      segStart = body;
      segEnd = sz.size < 0 ? bytes.length : Math.min(bytes.length, body + sz.size);
      break;
    }
    if (sz.size < 0) return null;
    p = body + sz.size;
  }
  if (segStart < 0) return null;
  // Дети Segment до первого Cluster: ищем Info
  p = segStart;
  while (p < segEnd && count++ < MAX_ELEMENTS) {
    const id = readId(bytes, p); if (!id) return null;
    const sz = readSize(bytes, p + id.len); if (!sz) return null;
    const body = p + id.len + sz.len;
    if (id.id === ID_CLUSTER) return null;
    if (sz.size < 0) return null;
    const end = body + sz.size;
    if (end > segEnd) return null;
    if (id.id === ID_INFO) return patchInfo(bytes, body, end, durMs);
    p = end;
  }
  return null;
}

function patchInfo(bytes: Uint8Array, start: number, end: number, durMs: number): Uint8Array<ArrayBuffer> | null {
  let scale = 1_000_000;
  let durPos = -1;
  let durLen = 0;
  let count = 0;
  let p = start;
  while (p < end && count++ < MAX_ELEMENTS) {
    const id = readId(bytes, p); if (!id) return null;
    const sz = readSize(bytes, p + id.len); if (!sz || sz.size < 0) return null;
    const body = p + id.len + sz.len;
    if (body + sz.size > end) return null;
    if (id.id === ID_TIMECODE_SCALE && sz.size >= 1 && sz.size <= 8) {
      const s = readUint(bytes, body, sz.size);
      if (s > 0) scale = s;
    } else if (id.id === ID_DURATION && (sz.size === 4 || sz.size === 8)) {
      durPos = body; durLen = sz.size;
    }
    p = body + sz.size;
  }
  if (durPos < 0) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + durPos, durLen);
  const cur = durLen === 8 ? dv.getFloat64(0, false) : dv.getFloat32(0, false);
  if (Number.isFinite(cur) && cur > 0) return null; // уже задана — не трогаем
  const out = bytes.slice();
  const wv = new DataView(out.buffer, durPos, durLen);
  const ticks = (durMs * 1_000_000) / scale;
  if (durLen === 8) wv.setFloat64(0, ticks, false); else wv.setFloat32(0, ticks, false);
  return out;
}

// ───────────────────────── Длительность по пакетам Opus ─────────────────────────

const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_SIMPLE_BLOCK = 0xa3;
/** Предел числа элементов: час при 20 мс-пакетах ≈ 180 000 блоков + кластеры; больше — не наш файл. */
const MAX_WALK_ELEMENTS = 600_000;
/** PROTOCOL_VOICE_V2 §5: воспроизводится не больше 300 с (PCM/WAV фолбэка и «бомбы» из 1-байтных пакетов). */
export const MAX_VOICE_PLAY_MS = 300_000;

/** Кадров (48 кГц) в одном Opus-пакете по TOC (RFC 6716 §3.1); null — пакет некорректен. */
function opusPacketFrames(b: Uint8Array, p: number, end: number): number | null {
  if (p >= end) return null;
  const toc = b[p];
  const cfg = toc >> 3;
  // SILK 10/20/40/60 мс; hybrid 10/20 мс; CELT 2,5/5/10/20 мс (в кадрах 48 кГц)
  const per = cfg < 12 ? [480, 960, 1920, 2880][cfg & 3] : cfg < 16 ? [480, 960][cfg & 1] : [120, 240, 480, 960][cfg & 3];
  const code = toc & 3;
  let n: number;
  if (code === 0) n = 1;
  else if (code === 1 || code === 2) n = 2;
  else { if (p + 1 >= end) return null; n = b[p + 1] & 0x3f; if (n === 0) return null; }
  const total = per * n;
  return total <= 5760 ? total : null; // пакет ≤ 120 мс
}

/**
 * Точная длительность WebM/Opus в мс БЕЗ декодирования: Σ кадров по TOC пакетов минус pre-skip из OpusHead
 * (так же считают нативные клиенты). null — не WebM/Opus, lacing, некорректная структура. Память O(1):
 * файл читается по месту, ничего не копируется. Сложность O(размер файла), предел числа элементов.
 */
export function webmOpusDurationMs(b: Uint8Array): number | null {
  if (b.length < 16 || !(b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)) return null;
  let p = 0;
  let count = 0;
  let frames = 0;
  let packets = 0;
  let preSkip = 0;
  let sawOpusHead = false;
  while (p < b.length && count++ < MAX_WALK_ELEMENTS) {
    const id = readId(b, p); if (!id) return null;
    const sz = readSize(b, p + id.len); if (!sz) return null;
    const body = p + id.len + sz.len;
    // Контейнеры: входим внутрь (их дети идут подряд; размер Cluster/Segment может быть «неизвестен»)
    if (id.id === ID_SEGMENT || id.id === ID_CLUSTER || id.id === ID_TRACKS || id.id === ID_TRACK_ENTRY || id.id === ID_BLOCK_GROUP) {
      p = body; continue;
    }
    if (sz.size < 0) return null;
    const end = body + sz.size;
    if (end > b.length) return null;
    if (id.id === ID_CODEC_PRIVATE && sz.size >= 12 && String.fromCharCode(...b.subarray(body, body + 8)) === "OpusHead") {
      preSkip = b[body + 10] | (b[body + 11] << 8);
      sawOpusHead = true;
    } else if (id.id === ID_SIMPLE_BLOCK || id.id === ID_BLOCK) {
      const tr = readSize(b, body); if (!tr || tr.size < 0) return null; // номер дорожки (vint)
      const hdr = body + tr.len + 3;                                   // + timecode(2) + flags(1)
      if (hdr >= end) return null;
      if (b[hdr - 1] & 0x06) return null;                              // lacing не используем
      const f = opusPacketFrames(b, hdr, end); if (f === null) return null;
      frames += f; packets++;
    }
    p = end;
  }
  if (p < b.length) return null; // предел числа элементов исчерпан — частичную сумму не отдаём
  if (!sawOpusHead || packets === 0 || frames <= preSkip) return null; // без OpusHead это не WebM/Opus
  return Math.round(((frames - preSkip) / 48000) * 1000);
}
