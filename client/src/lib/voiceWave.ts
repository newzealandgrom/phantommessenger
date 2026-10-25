/**
 * Волна голосового (PROTOCOL_VOICE_V2 §3): 100 значений 0…31, упакованных по 5 бит LSB-first
 * в 63 байта (формат Telegram). В meta1 `k:"voice"` — поле `wave` (base64, 84 символа).
 *
 * Чистый модуль без импортов: его используют VoiceRecorderBar/VoicePlayer и node-тест
 * scripts/test-voice-v2.mjs (эталон documentation/voice_v2_vector.json).
 */

/** Число корзин волны. */
export const WAVE_BARS = 100;
/** Максимальное значение корзины (5 бит). */
export const WAVE_MAX = 31;
/** Размер упакованной волны, байт: ceil(100·5/8). */
export const WAVE_BYTES = 63;

/** Нормировка RMS корзин к максимуму: min(31, floor(rms/peak·31 + 0.5)); тишина → нули. */
function normalizeRms(rms: number[]): number[] {
  let peak = 0;
  for (let i = 0; i < rms.length; i++) if (rms[i] > peak) peak = rms[i];
  const out = new Array<number>(WAVE_BARS).fill(0);
  if (!(peak > 0)) return out;
  for (let i = 0; i < WAVE_BARS; i++) out[i] = Math.min(WAVE_MAX, Math.floor((rms[i] / peak) * WAVE_MAX + 0.5));
  return out;
}

/**
 * Вычисление (§3.1): PCM моно (при ≥ 2 каналах — среднее по каналам), N кадров → 100 равных
 * корзин (границы floor(i·N/100)), RMS корзины, нормировка к максимуму: round(rms/peak·31).
 * Без сглаживания и логарифма; пустые корзины (N < 100) и тишина дают 0.
 */
export function computeWave(channels: ArrayLike<number>[]): number[] {
  const out = new Array<number>(WAVE_BARS).fill(0);
  const nch = channels.length;
  if (nch === 0) return out;
  let n = channels[0].length;
  for (let c = 1; c < nch; c++) if (channels[c].length < n) n = channels[c].length;
  if (n <= 0) return out;
  const rms = new Array<number>(WAVE_BARS).fill(0);
  for (let i = 0; i < WAVE_BARS; i++) {
    const a = Math.floor((i * n) / WAVE_BARS);
    const b = Math.floor(((i + 1) * n) / WAVE_BARS);
    if (b <= a) continue;
    let sum = 0;
    if (nch === 1) {
      const x = channels[0];
      for (let k = a; k < b; k++) { const v = x[k]; sum += v * v; }
    } else {
      for (let k = a; k < b; k++) {
        let m = 0;
        for (let c = 0; c < nch; c++) m += channels[c][k];
        m /= nch;
        sum += m * m;
      }
    }
    rms[i] = Math.sqrt(sum / (b - a));
  }
  return normalizeRms(rms);
}

/**
 * Инкрементальная волна для записи любой длины (до часа и больше) без хранения PCM: сэмплы
 * приходят порциями, копится только энергия (Σx²) мелких корзин по `binFrames` кадров — не более
 * `MAX_FINE_BINS` штук (при переполнении соседние корзины сливаются, шаг удваивается), то есть
 * память O(1) от длительности. `finalize()` сводит их к 100 корзинам по границам §3.1
 * (floor(i·N/100)); энергия мелкой корзины, пересекающей границу, делится пропорционально
 * перекрытию (равномерная плотность) — отличие от `computeWave` только в пределах округления.
 */
const MAX_FINE_BINS = 4096; // чётное: слияние попарно

export class WaveAccumulator {
  private binFrames: number;
  private readonly bins = new Float64Array(MAX_FINE_BINS); // энергия закрытых корзин, каждая по binFrames кадров
  private closed = 0;
  private curSum = 0;
  private curFrames = 0;

  /**
   * `sampleRate` — частота поступающих сэмплов; начальная корзина ≈ 1 мс. Мелкая корзина нужна,
   * чтобы и у короткой записи (≥ 0,7 с) корзина волны (N/100 кадров) состояла из многих мелких;
   * после слияний на корзину волны всегда приходится ≥ 20 мелких (N ≥ 2048·binFrames).
   */
  constructor(sampleRate: number) {
    this.binFrames = Math.max(1, Math.round((Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000) / 1000));
  }

  /** Всего принятых кадров (N). */
  get frames(): number { return this.closed * this.binFrames + this.curFrames; }

  /** Порция PCM (моно; для нескольких каналов вызывающий усредняет). */
  push(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      this.curSum += v * v;
      if (++this.curFrames === this.binFrames) this.closeBin();
    }
  }

  private closeBin(): void {
    this.bins[this.closed++] = this.curSum;
    this.curSum = 0; this.curFrames = 0;
    if (this.closed === MAX_FINE_BINS) {
      const half = MAX_FINE_BINS / 2;
      for (let j = 0; j < half; j++) this.bins[j] = this.bins[2 * j] + this.bins[2 * j + 1];
      this.bins.fill(0, half);
      this.closed = half;
      this.binFrames *= 2;
    }
  }

  /** 100 значений 0…31 (§3.1) по принятым кадрам; нет кадров или тишина → нули. */
  finalize(): number[] {
    const n = this.frames;
    if (n <= 0) return new Array<number>(WAVE_BARS).fill(0);
    const B = this.binFrames;
    const rms = new Array<number>(WAVE_BARS).fill(0);
    for (let i = 0; i < WAVE_BARS; i++) {
      const a = Math.floor((i * n) / WAVE_BARS);
      const b = Math.floor(((i + 1) * n) / WAVE_BARS);
      if (b <= a) continue;
      let energy = 0;
      for (let j = Math.floor(a / B); j <= this.closed; j++) {
        const start = j * B;
        if (start >= b) break;
        const len = j < this.closed ? B : this.curFrames; // последняя — незакрытая корзина
        if (len <= 0) break;
        const e = j < this.closed ? this.bins[j] : this.curSum;
        const overlap = Math.min(b, start + len) - Math.max(a, start);
        if (overlap > 0) energy += e * (overlap / len);
      }
      rms[i] = Math.sqrt(energy / (b - a));
    }
    return normalizeRms(rms);
  }
}

/** Упаковка (§3.2): значение i занимает биты [5i, 5i+5), младший бит потока — первый; биты 500…503 = 0. */
export function packWave(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(WAVE_BYTES);
  for (let i = 0; i < WAVE_BARS; i++) {
    const x = (values[i] ?? 0) & WAVE_MAX;
    const bp = 5 * i;
    const by = bp >> 3;
    const sh = bp & 7;
    out[by] |= (x << sh) & 0xff;
    if (sh > 3) out[by + 1] |= x >> (8 - sh);
  }
  return out;
}

/** Распаковка: ровно 63 байта, иначе null. Старшие 4 бита последнего байта игнорируются. */
export function unpackWave(bytes: ArrayLike<number>): number[] | null {
  if (!bytes || bytes.length !== WAVE_BYTES) return null;
  const out = new Array<number>(WAVE_BARS);
  for (let i = 0; i < WAVE_BARS; i++) {
    const by = (5 * i) >> 3;
    const lo = bytes[by];
    const hi = by + 1 < WAVE_BYTES ? bytes[by + 1] << 8 : 0;
    out[i] = ((lo | hi) >> ((5 * i) & 7)) & WAVE_MAX;
  }
  return out;
}

/** base64 (std, с паддингом) упакованной волны — значение поля `wave` в meta1. */
export function waveToBase64(values: ArrayLike<number>): string {
  const bytes = packWave(values);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Поле `wave` → 100 значений; не строка, не base64 или длина ≠ 63 → null (поле игнорируется). */
export function waveFromBase64(b64: unknown): number[] | null {
  if (typeof b64 !== "string" || b64.length !== 84 || !/^[A-Za-z0-9+/]+$/.test(b64)) return null;
  try {
    const bin = atob(b64);
    if (bin.length !== WAVE_BYTES) return null;
    const bytes = new Uint8Array(WAVE_BYTES);
    for (let i = 0; i < WAVE_BYTES; i++) bytes[i] = bin.charCodeAt(i);
    return unpackWave(bytes);
  } catch { return null; }
}

/**
 * Отрисовка (§3.3): столбику j из `count` соответствует максимум по корзинам
 * [floor(j·100/count), floor((j+1)·100/count)); результат 0…1 (v/31).
 */
export function waveBars(values: ArrayLike<number>, count: number): number[] {
  const b = Math.max(1, Math.floor(count));
  const out = new Array<number>(b);
  for (let j = 0; j < b; j++) {
    const a = Math.floor((j * WAVE_BARS) / b);
    const e = Math.max(a + 1, Math.floor(((j + 1) * WAVE_BARS) / b));
    let m = 0;
    for (let i = a; i < e && i < WAVE_BARS; i++) if (values[i] > m) m = values[i];
    out[j] = m / WAVE_MAX;
  }
  return out;
}
