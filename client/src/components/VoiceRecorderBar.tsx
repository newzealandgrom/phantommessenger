import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Pause, Play, Send, Square, Trash2 } from "lucide-react";
import { useT } from "../lib/i18n";
import { usePhantomToast } from "./Toast";
import { computeWave, waveToBase64, WaveAccumulator, WAVE_BARS } from "../lib/voiceWave";
import { webmOpusDurationMs } from "../lib/webmDuration";

/**
 * Готовая запись для отправки (PROTOCOL_VOICE_V2): blob WebM/Opus, `mime` = `audio/webm`,
 * длительность в секундах и точная в мс, `wave` — base64 63 байт или undefined, если волну
 * получить не удалось (выдуманную не шлём). Короткая запись (≤ MAX_ANALYZE_BYTES) уточняется
 * декодом (§1.1), длинная — без декода: durMs по счётчику времени записи без пауз,
 * wave — инкрементально во время записи (WaveAccumulator).
 */
export interface VoiceRecording { blob: Blob; duration: number; durMs: number; mime: string; wave?: string }

/** Жест, начавший запись (мышь/сенсор/перо). null — старт с клавиатуры, сразу «без рук». */
export interface VoiceHold { x: number; y: number; pointerType: string; t: number }

interface Props {
  /** Лимит голосового (meta1), байт: при приближении запись останавливается сама. */
  maxBytes: number;
  hold: VoiceHold | null;
  /** Входящий/исходящий звонок: запись останавливается, остаётся «отправить/удалить». */
  interrupted: boolean;
  /** false — отправка отклонена (ключ, keyAlert, лимит): запись остаётся в «отправить/удалить». */
  onSend: (rec: VoiceRecording) => boolean | void | Promise<boolean | void>;
  onCancel: () => void;
  /** Режим «без рук» включён или выключен (родитель прячет кнопку-микрофон). */
  onLockedChange?: (locked: boolean) => void;
}

type Status = "init" | "rec" | "paused" | "stopped";

// Только Opus/WebM (решение владельца): без него запись недоступна, кнопка неактивна («Обновите браузер»)
const OPUS_MIME = "audio/webm;codecs=opus";
const BITRATE = 24000; // WEB-15: ~45 с голоса в лимит 140 КиБ
// Уточнение durMs/wave полным декодом (decodeAudioData ≈ 192 КБ/с PCM float32): только для коротких
// записей. Бóльшие НЕ декодируются вообще — иначе память пропорциональна длительности (час ≈ 690 МБ).
const MAX_ANALYZE_BYTES = 256 * 1024; // ≈ 85 с при 24 кбит/с → ≈ 16 МБ PCM
const ANALYZE_TIMEOUT_MS = 5000;      // декод короткой записи; по таймауту берём счётчик и инкрементальную волну
const WAVE_SAMPLE_MS = 20;            // период чтения AnalyserNode для инкрементальной волны (< окна fftSize)
const MIN_MS = 700;        // короче — не отправляем
const HOLD_MS = 300;       // удержание дольше = жест «записал и отпустил»
const CANCEL_DX = 100;     // влево за порог — отмена
const LOCK_DY = 80;        // вверх за порог — «без рук» (сенсор)
const LIMIT_MARGIN = 2048; // запас до лимита, байт (§2.4: ≥ 2 КиБ)
const LEVEL_STEP_MS = 55;  // период отсчётов волны

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Запись голоса доступна: микрофон и MediaRecorder с WebM/Opus (AAC-запись не предусмотрена). */
export function isVoiceRecordingSupported(): boolean {
  try {
    return !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"
      && MediaRecorder.isTypeSupported(OPUS_MIME);
  } catch { return false; }
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

/**
 * Точная длительность и волна по декоду КОРОТКОЙ записи (§1.1): durMs = round(кадры / частота · 1000),
 * wave — по тем же кадрам (§3.1). null — запись больше MAX_ANALYZE_BYTES (не декодируем), декод
 * недоступен или не удался (вызывающий берёт счётчик времени и инкрементальную волну).
 * OfflineAudioContext не требует жеста и не выводит звук; 48 кГц — как у Opus. Таймаут лишь
 * прекращает ожидание, а не сам декод — поэтому предел по размеру обязателен.
 */
async function analyzeRecording(blob: Blob): Promise<{ durMs: number; wave: string } | null> {
  if (blob.size === 0 || blob.size > MAX_ANALYZE_BYTES) return null;
  const w = window as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Ctor = w.OfflineAudioContext || w.webkitOfflineAudioContext;
  if (!Ctor) return null;
  const work = (async () => {
    const ab = await blob.arrayBuffer();
    const ctx = new Ctor(1, 1, 48000);
    // Колбэки — для старых Safari, где decodeAudioData без промиса
    const buf = await new Promise<AudioBuffer>((resolve, reject) => {
      const p = ctx.decodeAudioData(ab, resolve, reject) as Promise<AudioBuffer> | undefined;
      if (p && typeof p.catch === "function") p.catch(reject);
    });
    if (!buf.length || !(buf.sampleRate > 0)) return null;
    const chans: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    return { durMs: Math.round((buf.length / buf.sampleRate) * 1000), wave: waveToBase64(computeWave(chans)) };
  })();
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ANALYZE_TIMEOUT_MS)),
    ]);
  } catch { return null; }
}

function stopTracks(stream: MediaStream | null): void {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
}

/** Полоса записи голосового (в стиле Telegram). Владеет MediaRecorder и потоком микрофона:
 *  при размонтировании в любом сценарии треки getUserMedia останавливаются. */
export default function VoiceRecorderBar({ maxBytes, hold, interrupted, onSend, onCancel, onLockedChange }: Props) {
  const { t } = useT();
  const toast = usePhantomToast();

  const [status, setStatus] = useState<Status>("init");
  const [locked, setLocked] = useState(hold === null);
  const [elapsed, setElapsed] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [slideX, setSlideX] = useState(0);
  const [sending, setSending] = useState(false); // ждём onSend (ключ, TOFU, шифрование): кнопки неактивны

  // Актуальные значения для долгоживущих обработчиков (без пересоздания эффектов)
  const statusRef = useRef<Status>("init");
  const lockedRef = useRef(hold === null);
  const propsRef = useRef({ onSend, onCancel, onLockedChange, t, toast, maxBytes });
  useEffect(() => { propsRef.current = { onSend, onCancel, onLockedChange, t, toast, maxBytes }; });

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const accRef = useRef(0);          // накопленные мс записи (без пауз)
  const segRef = useRef(0);          // начало текущего сегмента записи (performance.now), 0 — не пишем
  const finalRef = useRef<{ blob: Blob; durMs: number; wave?: string; mime: string } | null>(null);
  const waveAccRef = useRef<WaveAccumulator | null>(null); // инкрементальная волна (кадры только при status "rec")
  const waveTimerRef = useRef<number | null>(null);
  const stoppingRef = useRef<Promise<void> | null>(null);
  const doneRef = useRef(false);     // отправка/отмена уже запущены
  const haltingRef = useRef(false);  // остановка по лимиту/прерыванию уже идёт (один тост)
  const sendBtnRef = useRef<HTMLButtonElement | null>(null);
  const releasedRef = useRef(false); // жест отпущен до готовности микрофона
  const holdRef = useRef<VoiceHold | null>(hold);
  const lockedAtRef = useRef(0);     // защита от «залипшего» клика сразу после отпускания мыши
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelsRef = useRef<number[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const setStatusBoth = useCallback((s: Status) => { statusRef.current = s; setStatus(s); }, []);

  const setLockedBoth = useCallback((v: boolean) => {
    if (lockedRef.current === v) return;
    lockedRef.current = v;
    lockedAtRef.current = performance.now();
    setLocked(v);
    propsRef.current.onLockedChange?.(v);
  }, []);

  // ── Предпрослушивание ──
  const stopPreview = useCallback(() => {
    const a = audioRef.current;
    if (a) { try { a.pause(); } catch { /* ignore */ } a.onended = null; }
    audioRef.current = null;
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setPreviewing(false);
  }, []);

  const togglePreview = useCallback(() => {
    if (audioRef.current) { stopPreview(); return; }
    const blob = finalRef.current?.blob ?? new Blob(chunksRef.current, { type: "audio/webm" });
    if (blob.size === 0) return;
    const url = URL.createObjectURL(blob);
    urlRef.current = url;
    const a = new Audio(url);
    audioRef.current = a;
    a.onended = () => stopPreview();
    setPreviewing(true);
    a.play().catch(() => stopPreview());
  }, [stopPreview]);

  // ── Остановка рекордера: собирает итоговый blob, гасит треки микрофона ──
  const stopRecorder = useCallback((): Promise<void> => {
    if (stoppingRef.current) return stoppingRef.current;
    const rec = recRef.current;
    if (!rec) return Promise.resolve();
    if (segRef.current) { accRef.current += performance.now() - segRef.current; segRef.current = 0; }
    const p = new Promise<void>((resolve) => {
      const finish = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const timerMs = accRef.current;
        const acc = waveAccRef.current;
        stopTracks(streamRef.current);
        if (waveTimerRef.current !== null) { window.clearInterval(waveTimerRef.current); waveTimerRef.current = null; }
        // durMs — точно по пакетам Opus файла (Σ кадров по TOC − pre-skip, без декода и для любой длины);
        // нет — по декоду короткой записи, затем по счётчику времени записи без пауз.
        // wave — по декоду короткой записи (§3.1 целиком), иначе накопленная во время записи
        // (полный декод часовой записи съел бы сотни МБ)
        void (async () => {
          let tocMs: number | null = null;
          try { tocMs = webmOpusDurationMs(new Uint8Array(await blob.arrayBuffer())); } catch { /* ignore */ }
          const a = await analyzeRecording(blob);
          const wave = a ? a.wave : (acc && acc.frames >= WAVE_BARS ? waveToBase64(acc.finalize()) : undefined);
          finalRef.current = { blob, durMs: tocMs ?? a?.durMs ?? Math.round(timerMs), wave, mime: "audio/webm" };
          resolve();
        })();
      };
      if (rec.state === "inactive") { finish(); return; }
      rec.onstop = finish;
      try { rec.stop(); } catch { finish(); }
    });
    stoppingRef.current = p;
    return p;
  }, []);

  // Остановка по лимиту/прерыванию: запись остаётся в «отправить/удалить»
  const haltToDraft = useCallback(async (noticeKey: string) => {
    if (doneRef.current || haltingRef.current) return;
    const s = statusRef.current;
    if (s !== "rec" && s !== "paused") return;
    haltingRef.current = true;
    holdRef.current = null;
    await stopRecorder();
    if (doneRef.current) return;
    setElapsed(accRef.current);
    setStatusBoth("stopped");
    setLockedBoth(true);
    propsRef.current.toast(propsRef.current.t(noticeKey), "warning");
  }, [setLockedBoth, setStatusBoth, stopRecorder]);

  // ── Полная очистка (идемпотентна) ──
  const teardown = useCallback(() => {
    const rec = recRef.current;
    if (rec) {
      rec.ondataavailable = null;
      if (rec.state !== "inactive") { rec.onstop = null; try { rec.stop(); } catch { /* ignore */ } }
    }
    stopTracks(streamRef.current);
    if (waveTimerRef.current !== null) { window.clearInterval(waveTimerRef.current); waveTimerRef.current = null; }
    waveAccRef.current = null;
    const a = audioRef.current;
    if (a) { try { a.pause(); } catch { /* ignore */ } a.onended = null; audioRef.current = null; }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    const ctx = ctxRef.current;
    ctxRef.current = null; analyserRef.current = null;
    if (ctx) { void ctx.close().catch(() => { /* ignore */ }); }
  }, []);

  const cancel = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    teardown();
    propsRef.current.onCancel();
  }, [teardown]);

  const send = useCallback(async () => {
    const s = statusRef.current;
    if (doneRef.current || s === "init") return;
    doneRef.current = true;
    stopPreview();
    setSending(true); // остановка и анализ записи занимают время: кнопки неактивны сразу
    await stopRecorder();
    const f = finalRef.current;
    if (!f || f.durMs < MIN_MS) {
      teardown();
      propsRef.current.toast(propsRef.current.t("voice.tooShort"), "info");
      propsRef.current.onCancel();
      return;
    }
    let ok: boolean | void = false;
    setElapsed(f.durMs);
    setStatusBoth("stopped");
    setLockedBoth(true);
    try {
      ok = await propsRef.current.onSend({
        blob: f.blob, duration: Math.max(1, Math.round(f.durMs / 1000)), durMs: Math.round(f.durMs), mime: f.mime, wave: f.wave,
      });
    } catch { ok = false; }
    setSending(false);
    if (ok === false) {
      // Отказ отправки: запись не теряем — остаётся «отправить/удалить»
      doneRef.current = false;
      return;
    }
    teardown();
  }, [setLockedBoth, setStatusBoth, stopPreview, stopRecorder, teardown]);

  const pause = useCallback(() => {
    const rec = recRef.current;
    if (!rec || statusRef.current !== "rec" || rec.state !== "recording") return;
    if (segRef.current) { accRef.current += performance.now() - segRef.current; segRef.current = 0; }
    try { rec.pause(); rec.requestData(); } catch { /* ignore */ }
    setElapsed(accRef.current);
    setStatusBoth("paused");
  }, [setStatusBoth]);

  const resume = useCallback(() => {
    const rec = recRef.current;
    if (!rec || statusRef.current !== "paused" || rec.state !== "paused") return;
    stopPreview();
    try { rec.resume(); } catch { return; }
    segRef.current = performance.now();
    setStatusBoth("rec");
  }, [setStatusBoth, stopPreview]);

  // ── Старт: микрофон, рекордер, анализатор ──
  useEffect(() => {
    let cancelled = false;
    // Свежее состояние на каждый запуск эффекта (StrictMode монтирует его дважды)
    doneRef.current = false; haltingRef.current = false;
    recRef.current = null; streamRef.current = null; finalRef.current = null; stoppingRef.current = null;
    chunksRef.current = []; bytesRef.current = 0; accRef.current = 0; segRef.current = 0;
    waveAccRef.current = null; waveTimerRef.current = null;
    levelsRef.current = [];
    propsRef.current.onLockedChange?.(lockedRef.current);
    void (async () => {
      const { t: tr, toast: tst } = propsRef.current;
      if (!isVoiceRecordingSupported()) {
        tst(tr("voice.unsupported"), "error");
        cancel();
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        if (!cancelled) { tst(tr("voice.micDenied"), "error"); cancel(); }
        return;
      }
      // Эффект размонтирован или жест уже отменён (короткий тап) — поток гасим сразу
      if (cancelled || doneRef.current) { stopTracks(stream); return; }
      streamRef.current = stream;
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(stream, { mimeType: OPUS_MIME, audioBitsPerSecond: BITRATE });
      } catch {
        stopTracks(stream);
        tst(tr("voice.unsupported"), "error");
        cancel();
        return;
      }
      rec.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        chunksRef.current.push(e.data);
        bytesRef.current += e.data.size;
        if (bytesRef.current >= propsRef.current.maxBytes - LIMIT_MARGIN && statusRef.current === "rec") {
          void haltToDraft("voice.limit");
        }
      };
      recRef.current = rec;
      // Волна: AnalyserNode по тому же потоку (в динамики не подключаем)
      try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          const an = ctx.createAnalyser();
          an.fftSize = 2048;
          ctx.createMediaStreamSource(stream).connect(an);
          void ctx.resume().catch(() => { /* ignore */ });
          ctxRef.current = ctx; analyserRef.current = an;
          // Инкрементальная волна: последние `frames` кадров окна анализатора, где frames — по часам
          // AudioContext с прошлого чтения; пока запись на паузе (segRef = 0) кадры не считаются
          const acc = new WaveAccumulator(ctx.sampleRate);
          waveAccRef.current = acc;
          const win = new Float32Array(an.fftSize);
          let lastT = ctx.currentTime;
          waveTimerRef.current = window.setInterval(() => {
            const now = ctx.currentTime;
            const dt = now - lastT;
            lastT = now;
            if (!segRef.current || !(dt > 0)) return;
            const frames = Math.min(win.length, Math.round(dt * ctx.sampleRate));
            if (frames <= 0) return;
            an.getFloatTimeDomainData(win);
            acc.push(win.subarray(win.length - frames));
          }, WAVE_SAMPLE_MS);
        }
      } catch { /* волна необязательна */ }
      rec.start(100);
      segRef.current = performance.now();
      setStatusBoth("rec");
      // Жест отпущен, пока ждали разрешение на микрофон — продолжаем «без рук»
      if (releasedRef.current) setLockedBoth(true);
    })();
    return () => {
      cancelled = true;
      doneRef.current = true;
      teardown();
    };
  }, [cancel, haltToDraft, setLockedBoth, setStatusBoth, teardown]);

  // ── Таймер ──
  useEffect(() => {
    if (status !== "rec") return;
    const id = window.setInterval(() => {
      setElapsed(accRef.current + (segRef.current ? performance.now() - segRef.current : 0));
    }, 100);
    return () => window.clearInterval(id);
  }, [status]);

  // ── Волна ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const g = canvas.getContext("2d");
      if (!g) return;
      g.clearRect(0, 0, w, h);
      g.fillStyle = getComputedStyle(canvas).color;
      const bw = Math.max(2, Math.round(2.5 * dpr));
      const step = bw + Math.max(1, Math.round(1.5 * dpr));
      const count = Math.floor(w / step);
      const lv = levelsRef.current;
      for (let i = 0; i < count; i++) {
        const idx = lv.length - count + i;
        const v = idx >= 0 ? lv[idx] : 0;
        const bh = Math.max(bw, Math.round(v * h));
        g.fillRect(i * step, Math.round((h - bh) / 2), bw, bh);
      }
    };
    if (status !== "rec") { paint(); return; }
    const buf = new Uint8Array(analyserRef.current?.fftSize ?? 512);
    let raf = 0;
    let lastPush = 0;
    const loop = (now: number) => {
      const an = analyserRef.current;
      if (an && now - lastPush >= LEVEL_STEP_MS) {
        lastPush = now;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
        const rms = Math.sqrt(sum / buf.length);
        const lv = levelsRef.current;
        lv.push(Math.min(1, rms * 3.2));
        if (lv.length > 400) lv.splice(0, lv.length - 400);
      }
      paint();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  // ── Жест удержания (мышь/сенсор): события на window, пока кнопка-микрофон жива ──
  useEffect(() => {
    if (!hold) return;
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancelEv);
    };
    function onMove(e: PointerEvent) {
      const h = holdRef.current;
      if (!h) { detach(); return; }
      const dx = e.clientX - h.x;
      const dy = e.clientY - h.y;
      setSlideX(Math.max(-CANCEL_DX, Math.min(0, dx)));
      if (dx < -CANCEL_DX) { holdRef.current = null; detach(); cancel(); return; }
      if (h.pointerType !== "mouse" && dy < -LOCK_DY) {
        holdRef.current = null; detach();
        setSlideX(0);
        setLockedBoth(true);
      }
    }
    function onUp() {
      const h = holdRef.current;
      holdRef.current = null;
      detach();
      if (!h || doneRef.current) return;
      setSlideX(0);
      const pressed = performance.now() - h.t;
      if (statusRef.current === "init") {
        // Короткий тап пальцем — подсказка, а не «без рук» (поток погасится в старте через doneRef)
        if (h.pointerType !== "mouse" && pressed < HOLD_MS) {
          propsRef.current.toast(propsRef.current.t("voice.holdHint"), "info");
          cancel();
          return;
        }
        releasedRef.current = true; // отпустили, пока ждали разрешение на микрофон
        return;
      }
      if (pressed < HOLD_MS) {
        if (h.pointerType === "mouse") { setLockedBoth(true); return; } // клик = запись «без рук»
        propsRef.current.toast(propsRef.current.t("voice.holdHint"), "info");
        cancel();
        return;
      }
      void send();
    }
    function onCancelEv() {
      const h = holdRef.current;
      holdRef.current = null;
      detach();
      if (h && h.pointerType !== "mouse") cancel();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancelEv);
    return detach;
  }, [hold, cancel, send, setLockedBoth]);

  // ── Esc — отмена, Enter — отправить ──
  // Не перехватываем чужие поля и кнопки: Enter на кнопке полосы выполняет её собственное действие,
  // Esc при открытом оверлее (модалка, лайтбокс, звонок) принадлежит оверлею.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      const interactive = !!el && el !== document.body && !!el.closest?.("button, a, input, textarea, select, [contenteditable=\"true\"], [role=\"button\"]");
      if (e.key === "Escape") {
        if (document.querySelector(".tg-modal-overlay, .tg-img-fullscreen-overlay, .privacy-modal, .tg-call-overlay, .tg-self-destruct-menu, .tg-header-menu-backdrop, .tg-customize-panel, [role=\"dialog\"], [role=\"menu\"], [aria-modal=\"true\"], [aria-expanded=\"true\"]")) return;
        const foreignField = interactive && !el!.closest(".pm-vrec") && !el!.closest("button");
        if (foreignField) return;
        e.preventDefault(); cancel();
      } else if (e.key === "Enter" && !e.repeat) {
        if (interactive) return;
        e.preventDefault(); void send();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, send]);

  // Фокус на «Отправить» в режиме «без рук»: Enter срабатывает как кнопка, а не уходит в никуда
  useEffect(() => {
    if (!locked || status === "init") return;
    const ae = document.activeElement;
    if (!ae || ae === document.body || (ae as HTMLElement).classList?.contains("tg-mic-btn")) {
      sendBtnRef.current?.focus({ preventScroll: true });
    }
  }, [locked, status]);

  // ── Вкладка ушла в фон ──
  useEffect(() => {
    const onVis = () => { if (document.hidden) void haltToDraft("voice.interrupted"); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [haltToDraft]);

  // ── Звонок ──
  useEffect(() => {
    if (interrupted) void haltToDraft("voice.interrupted");
  }, [interrupted, haltToDraft]);

  // Клики сразу после отпускания мыши (смена раскладки полосы) не должны срабатывать
  const guarded = (fn: () => void) => () => {
    if (performance.now() - lockedAtRef.current < 250) return;
    fn();
  };

  const showTime = status === "init" ? 0 : elapsed;
  const handsFree = locked;

  return (
    <div
      className={`tg-voice-recording pm-vrec ${handsFree ? "is-locked" : "is-hold"} is-${status}${sending ? " is-sending" : ""}`}
      aria-busy={sending}
      role="group"
      aria-label={t("voice.bar")}
    >
      {handsFree && (
        <button type="button" onClick={guarded(cancel)} className="tg-voice-cancel spring-press" disabled={sending} title={t("voice.cancel")} aria-label={t("voice.cancel")}>
          <Trash2 size={16} strokeWidth={1.75} />
        </button>
      )}
      <span className={`tg-voice-dot${status === "rec" && !sending ? "" : " is-idle"}`} aria-hidden="true" />
      <span className="tg-voice-time" aria-live="off">{fmt(showTime)}</span>
      <canvas ref={canvasRef} className="pm-vrec-wave" aria-hidden="true" />
      {sending && <span className="pm-vrec-hint">{t("voice.sending")}</span>}
      {!handsFree && (
        <span className="pm-vrec-hint" style={{ transform: `translateX(${slideX}px)` }}>
          {"‹ "}{t("voice.slideCancel")}{hold?.pointerType === "mouse" ? "" : ` · ↑ ${t("voice.slideLock")}`}
        </span>
      )}
      {handsFree && status === "rec" && (
        <button type="button" onClick={guarded(pause)} className="pm-vrec-ctl spring-press" disabled={sending} title={t("voice.pause")} aria-label={t("voice.pause")}>
          <Pause size={16} strokeWidth={1.75} />
        </button>
      )}
      {handsFree && status === "paused" && (
        <button type="button" onClick={guarded(resume)} className="pm-vrec-ctl spring-press" disabled={sending} title={t("voice.resume")} aria-label={t("voice.resume")}>
          <Mic size={16} strokeWidth={1.75} />
        </button>
      )}
      {handsFree && (status === "paused" || status === "stopped") && (
        <button
          type="button"
          onClick={guarded(togglePreview)}
          className={`pm-vrec-ctl spring-press${previewing ? " active" : ""}`}
          disabled={sending}
          title={previewing ? t("voice.stopPlay") : t("voice.play")}
          aria-label={previewing ? t("voice.stopPlay") : t("voice.play")}
          aria-pressed={previewing}
        >
          {previewing ? <Square size={14} strokeWidth={2} /> : <Play size={16} strokeWidth={1.75} />}
        </button>
      )}
      {handsFree && (
        <button type="button" ref={sendBtnRef} onClick={guarded(() => { void send(); })} className="tg-voice-send spring-press" title={t("voice.send")} aria-label={t("voice.send")} disabled={status === "init" || sending}>
          <Send size={18} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
