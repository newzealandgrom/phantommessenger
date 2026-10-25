import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCountdown, generateWaveform } from "../lib/utils";
import { slog } from "../lib/log";
import { useT } from "../lib/i18n";
import { waveBars, waveFromBase64 } from "../lib/voiceWave";
import { MAX_VOICE_PLAY_MS, patchWebmDuration, webmOpusDurationMs } from "../lib/webmDuration";
import { MAX_FRAME_BYTES } from "../lib/meta1";

const RATES = [1, 1.5, 2] as const;
const BAR_PITCH = 4; // 3 px столбик + 1 px зазор
const MIN_BARS = 28;
const MAX_BARS = 60;
const SEEK_STEP_SEC = 5;

// Одновременно звучит одно голосовое: новое останавливает предыдущее
let stopActive: (() => void) | null = null;

/** Сигнатура EBML (WebM/Matroska): формат определяется по байтам, а не по заявленному mime (§1.2). */
function isWebm(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch { return null; }
}

// WebM/Opus без родной поддержки в <audio> (старый Safari): декод в PCM и WAV-blob. Только для файлов
// не больше кадра relay (MAX_FRAME_BYTES = 256 КиБ) и не длиннее MAX_VOICE_PLAY_MS (по TOC, до декода):
// PCM целиком в памяти (≈ 192 КБ/с float32 + 96 КБ/с int16 → ≤ 58 МБ + 29 МБ при 300 с).
const MAX_WAV_FALLBACK_BYTES = MAX_FRAME_BYTES;

function nativeWebmOpus(): boolean {
  try { return document.createElement("audio").canPlayType('audio/webm; codecs="opus"') !== ""; } catch { return false; }
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

async function webmToWavBlob(bytes: Uint8Array): Promise<Blob | null> {
  const w = window as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Ctor = w.OfflineAudioContext || w.webkitOfflineAudioContext;
  if (!Ctor) return null;
  const ctx = new Ctor(1, 1, 48000);
  const ab = bytes.slice().buffer; // decodeAudioData отсоединяет буфер — отдаём копию
  // Колбэки — для старых Safari, где decodeAudioData без промиса
  const buf = await new Promise<AudioBuffer>((resolve, reject) => {
    const p = ctx.decodeAudioData(ab, resolve, reject) as Promise<AudioBuffer> | undefined;
    if (p && typeof p.catch === "function") p.catch(reject);
  });
  const n = buf.length;
  if (!n || !(buf.sampleRate > 0)) return null;
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < chans.length; c++) m += chans[c][i];
    m /= chans.length;
    pcm[i] = Math.round(Math.max(-1, Math.min(1, m)) * (m < 0 ? 32768 : 32767));
  }
  const rate = Math.round(buf.sampleRate);
  const hdr = new DataView(new ArrayBuffer(44));
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) hdr.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); hdr.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  hdr.setUint32(16, 16, true); hdr.setUint16(20, 1, true); hdr.setUint16(22, 1, true);
  hdr.setUint32(24, rate, true); hdr.setUint32(28, rate * 2, true); hdr.setUint16(32, 2, true); hdr.setUint16(34, 16, true);
  str(36, "data"); hdr.setUint32(40, n * 2, true);
  return new Blob([hdr, pcm], { type: "audio/wav" });
}

function applyRate(a: HTMLAudioElement, rate: number): void {
  a.playbackRate = rate;
  // Сохранять тон при ускорении (свойство без префикса + старые префиксы)
  const p = a as HTMLAudioElement & { preservesPitch?: boolean; mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };
  p.preservesPitch = true; p.mozPreservesPitch = true; p.webkitPreservesPitch = true;
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface VoicePlayerProps {
  voiceData?: string;
  /** Длительность, целые секунды (легаси и подпись). */
  duration?: number;
  /** Длительность из meta1 (мс): запасная — для подписи, пока/если по пакетам файла её не получить. */
  durMs?: number;
  /** Волна v2: base64 63 байт. Нет — статичные столбики по id (фолбэк, не «громкость»). */
  wave?: string;
  messageId: string;
}

export function VoicePlayer({ voiceData, duration, durMs, wave, messageId }: VoicePlayerProps) {
  const { t, locale } = useT();
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playError, setPlayError] = useState(false);
  const [rate, setRate] = useState<number>(1);
  const [actualDur, setActualDur] = useState<number | null>(null); // фактическая длительность, если соврали > 1 с
  const [barCount, setBarCount] = useState(40);
  const [dragFrac, setDragFrac] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animFrameRef = useRef<number>(0);
  // blob URL текущего аудио — освобождается и при размонтировании на паузе
  const blobUrlRef = useRef<string | undefined>(undefined);
  const waveElRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const pendingAudioRef = useRef<Promise<HTMLAudioElement | null> | null>(null);
  const aliveRef = useRef(true); // WAV-декод мог закончиться уже после размонтирования
  const rateRef = useRef(1);
  const draggingRef = useRef(false);

  // Длительность по пакетам Opus самого файла (до воспроизведения, без декода) — ей верим, а не отправителю:
  // ложный durMs иначе растягивает шкалу и (Firefox) подставляется в Duration. null — нет WebM/Opus: тогда
  // заявленная (`durMs`, затем `duration`) только для подписи, а воспроизведение будет отклонено.
  const tocMs = useMemo(() => {
    if (!voiceData) return null;
    const b = b64ToBytes(voiceData);
    return b && isWebm(b) ? webmOpusDurationMs(b) : null;
  }, [voiceData]);
  const knownSec = tocMs !== null ? tocMs / 1000
    : (durMs !== undefined && durMs > 0 ? durMs / 1000 : (duration || 0));
  const totalSec = actualDur ?? knownSec;
  const totalRef = useRef(totalSec);
  totalRef.current = totalSec;

  const waveValues = useMemo(() => waveFromBase64(wave), [wave]);
  const bars = useMemo(
    () => (waveValues
      ? waveBars(waveValues, barCount)
      // Фолбэк без wave: статичный узор по id (0,15…1 → 0…1), не имитация громкости
      : generateWaveform(messageId, barCount).map((h) => (h - 0.15) / 0.85)),
    [waveValues, messageId, barCount],
  );

  // Число столбиков по ширине (28…60, §3.3). Callback-ref, а не эффект: элемент волны пересоздаётся
  // (например, после «Повторить» при смене ветки рендера) — наблюдатель переподключается сам
  const setWaveEl = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    waveElRef.current = el;
    if (!el || typeof ResizeObserver === "undefined") return;
    const upd = () => {
      const n = Math.floor(el.clientWidth / BAR_PITCH);
      setBarCount(Math.max(MIN_BARS, Math.min(MAX_BARS, n || MIN_BARS)));
    };
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    roRef.current = ro;
  }, []);

  const stopTick = useCallback(() => { cancelAnimationFrame(animFrameRef.current); }, []);

  const releaseAudio = useCallback(() => {
    stopTick();
    const a = audioRef.current;
    if (a) { try { a.pause(); } catch { /* ignore */ } }
    audioRef.current = null;
    if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = undefined; }
  }, [stopTick]);

  // Известная длительность надёжнее audio.duration (у webm от MediaRecorder она Infinity до конца), но
  // если конечная длительность <audio> расходится с заявленной > 1 с — верим файлу (§1.2, защита от лжи)
  const effectiveDur = useCallback((a: HTMLAudioElement): number => {
    const ad = a.duration;
    const finite = Number.isFinite(ad) && ad > 0;
    if (totalRef.current > 0) return finite && Math.abs(ad - totalRef.current) > 1 ? ad : totalRef.current;
    return finite ? ad : 0;
  }, []);

  const startTick = useCallback(() => {
    const tick = () => {
      const a = audioRef.current;
      if (a) {
        const dur = effectiveDur(a);
        const cur = a.currentTime;
        setProgress(dur > 0 ? Math.min(1, Math.max(0, cur / dur)) : 0);
        setCurrentTime(dur > 0 ? Math.min(cur, dur) : cur);
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };
    stopTick();
    tick();
  }, [effectiveDur, stopTick]);

  const pauseNow = useCallback(() => {
    const a = audioRef.current;
    if (a) { try { a.pause(); } catch { /* ignore */ } }
    stopTick();
    setPlaying(false);
    if (stopActive === pauseNow) stopActive = null;
  }, [stopTick]);

  // Элемент <audio> с обработчиками для готового blob-URL (общий для родного и WAV-пути)
  const attachAudio = useCallback((blobUrl: string): HTMLAudioElement => {
    const audio = new Audio(blobUrl);
    audio.preload = "auto";
    applyRate(audio, rateRef.current);
    audioRef.current = audio;
    audio.onended = () => {
      // Файл короче/длиннее заявленного > 1 с — подпись и шкала переходят на фактическую длительность
      const ct = audio.currentTime;
      if (Number.isFinite(ct) && ct > 0 && Math.abs(ct - totalRef.current) > 1) setActualDur(ct);
      setPlaying(false);
      setProgress(0);
      setCurrentTime(0);
      if (stopActive === pauseNow) stopActive = null;
      releaseAudio();
    };
    audio.onerror = () => {
      slog.error("[VoicePlayer] Audio error:", audio.error?.code);
      setPlaying(false);
      setProgress(0);
      setPlayError(true);
      if (stopActive === pauseNow) stopActive = null;
      releaseAudio();
    };
    // Фактическая длительность, если отправитель соврал > 1 с (§1.2); Infinity у webm игнорируем
    audio.ondurationchange = () => {
      const ad = audio.duration;
      if (Number.isFinite(ad) && ad > 0 && Math.abs(ad - totalRef.current) > 1) setActualDur(ad);
    };
    return audio;
  }, [pauseNow, releaseAudio]);

  // Готовый <audio>, либо промис (WAV-путь, асинхронный декод), либо null (ошибка → playError)
  const getAudio = useCallback((): HTMLAudioElement | Promise<HTMLAudioElement | null> | null => {
    if (audioRef.current) return audioRef.current;
    if (pendingAudioRef.current) return pendingAudioRef.current;
    if (!voiceData) return null;
    const bytes = b64ToBytes(voiceData);
    if (!bytes) { slog.error("[VoicePlayer] atob error"); setPlayError(true); return null; }
    // §1.2/§5: только WebM/Opus (по сигнатуре) и не длиннее MAX_VOICE_PLAY_MS по TOC — проверка ДО декода и Blob
    const ms = isWebm(bytes) ? webmOpusDurationMs(bytes) : null;
    if (ms === null || ms > MAX_VOICE_PLAY_MS) { setPlayError(true); return null; }
    // WebM/Opus, который <audio> не умеет (canPlayType пусто): декод → WAV-blob → <audio>.
    // Асинхронный декод уводит play() за пределы жеста: в старом Safari он может быть отклонён — тогда
    // аудио уже создано и повторное нажатие запускает его синхронно (разблокировку заранее проверить нечем)
    if (!nativeWebmOpus()) {
      if (bytes.length > MAX_WAV_FALLBACK_BYTES) { setPlayError(true); return null; }
      const p = webmToWavBlob(bytes).then((wav) => {
        pendingAudioRef.current = null;
        if (!aliveRef.current) return null;
        if (!wav) { setPlayError(true); return null; }
        const url = URL.createObjectURL(wav);
        blobUrlRef.current = url;
        return attachAudio(url);
      }).catch(() => { pendingAudioRef.current = null; setPlayError(true); return null; });
      pendingAudioRef.current = p;
      return p;
    }
    // Firefox пишет в WebM Duration = 0 → duration = Infinity и перемотка не работает: подставляем длительность по TOC
    const fixed = patchWebmDuration(bytes, ms);
    const url = URL.createObjectURL(new Blob([fixed ?? bytes], { type: "audio/webm" }));
    blobUrlRef.current = url;
    return attachAudio(url);
  }, [voiceData, attachAudio]);

  const startPlay = useCallback((audio: HTMLAudioElement) => {
    if (stopActive && stopActive !== pauseNow) stopActive();
    audio.play().then(() => {
      stopActive = pauseNow;
      setPlaying(true);
      startTick();
    }).catch(() => {
      setPlaying(false);
      setPlayError(true);
    });
  }, [pauseNow, startTick]);

  const togglePlay = useCallback(() => {
    if (!voiceData) return;
    if (playing && audioRef.current) { pauseNow(); return; }
    const got = getAudio();
    if (!got) return;
    if (got instanceof Promise) { void got.then((a) => { if (a) startPlay(a); }); return; }
    startPlay(got); // родной путь — синхронно, в жесте пользователя
  }, [voiceData, playing, getAudio, pauseNow, startPlay]);

  const seekTo = useCallback((frac: number) => {
    const apply = (a: HTMLAudioElement) => {
      const dur = effectiveDur(a);
      if (!(dur > 0)) return;
      const f = Math.min(1, Math.max(0, frac));
      try { a.currentTime = Math.min(f * dur, Math.max(0, dur - 0.05)); } catch { return; }
      setProgress(f);
      setCurrentTime(f * dur);
    };
    const got = getAudio();
    if (!got) return;
    if (got instanceof Promise) { void got.then((a) => { if (a) apply(a); }); return; }
    apply(got);
  }, [getAudio, effectiveDur]);

  const cycleRate = useCallback(() => {
    const next = RATES[(RATES.indexOf(rateRef.current as (typeof RATES)[number]) + 1) % RATES.length];
    rateRef.current = next;
    setRate(next);
    if (audioRef.current) applyRate(audioRef.current, next);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (stopActive === pauseNow) stopActive = null;
      releaseAudio();
    };
  }, [pauseNow, releaseAudio]);

  // ── Перемотка жестом по волне (мышь/сенсор/перо) ──
  const fracFromEvent = (e: React.PointerEvent): number => {
    const r = waveElRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const onWaveDown = (e: React.PointerEvent) => {
    if (!voiceData || e.button > 0) return;
    draggingRef.current = true;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setDragFrac(fracFromEvent(e));
  };
  const onWaveMove = (e: React.PointerEvent) => {
    if (draggingRef.current) setDragFrac(fracFromEvent(e));
  };
  const onWaveUp = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragFrac(null);
    seekTo(fracFromEvent(e));
  };
  const onWaveCancel = () => { draggingRef.current = false; setDragFrac(null); };
  const onWaveKey = (e: React.KeyboardEvent) => {
    const dur = totalRef.current;
    if (!voiceData || !(dur > 0)) return;
    const cur = audioRef.current ? audioRef.current.currentTime : currentTime;
    let target: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") target = cur + SEEK_STEP_SEC;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") target = cur - SEEK_STEP_SEC;
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = dur;
    if (target === null) return;
    e.preventDefault();
    seekTo(target / dur);
  };
  // Свайп-жесты пузыря (ответ) не должны перехватывать перетаскивание по волне
  const stopTouch = (e: React.TouchEvent) => e.stopPropagation();

  const shownFrac = dragFrac ?? progress;
  const shownSec = dragFrac !== null ? dragFrac * totalSec : currentTime;
  const showPosition = playing || dragFrac !== null || currentTime > 0;
  const timeStr = showPosition ? fmtClock(shownSec) : fmtClock(Math.round(totalSec));
  const filledBars = Math.floor(shownFrac * bars.length);
  const rateLabel = rate === 1.5 && locale === "ru" ? "1,5\u00D7" : `${rate}\u00D7`;

  if (playError) {
    return (
      <div className="tg-voice-player pm-vp is-error">
        <span className="pm-vp-err">{t("voice.playFailed")}</span>
        <button
          type="button"
          className="pm-vp-retry"
          onClick={() => { setPlayError(false); releaseAudio(); togglePlay(); }}
        >
          {t("voice.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="tg-voice-player pm-vp">
      <button
        type="button"
        className="pm-vp-play"
        onClick={togglePlay}
        disabled={!voiceData}
        title={playing ? t("voice.msgPause") : t("voice.msgPlay")}
        aria-label={playing ? t("voice.msgPause") : t("voice.msgPlay")}
      >
        {playing ? "\u275A\u275A" : "\u25B6"}
      </button>
      <div
        ref={setWaveEl}
        className={`pm-vp-wave${waveValues ? "" : " is-fallback"}${dragFrac !== null ? " is-drag" : ""}`}
        role="slider"
        tabIndex={voiceData ? 0 : -1}
        aria-label={t("voice.seek")}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, Math.round(totalSec))}
        aria-valuenow={Math.max(0, Math.round(shownSec))}
        aria-valuetext={timeStr}
        aria-disabled={!voiceData}
        onPointerDown={onWaveDown}
        onPointerMove={onWaveMove}
        onPointerUp={onWaveUp}
        onPointerCancel={onWaveCancel}
        onKeyDown={onWaveKey}
        onTouchStart={stopTouch}
        onTouchMove={stopTouch}
        onTouchEnd={stopTouch}
      >
        {bars.map((h, i) => (
          <div
            key={i}
            className={`pm-vp-bar${i < filledBars ? " is-on" : ""}`}
            style={{ height: `${Math.round(15 + 85 * h)}%` }}
          />
        ))}
      </div>
      <span className="pm-vp-time">{timeStr}</span>
      <button
        type="button"
        className={`pm-vp-rate${rate !== 1 ? " is-fast" : ""}`}
        onClick={cycleRate}
        disabled={!voiceData}
        title={t("voice.speed", { rate: rateLabel })}
        aria-label={t("voice.speed", { rate: rateLabel })}
      >
        {rateLabel}
      </button>
    </div>
  );
}

export function SelfDestructTimer({ expiresAt }: { expiresAt: number }) {
  const [remaining, setRemaining] = useState(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  if (remaining <= 0) {
    return (
      <span className="tg-self-destruct-timer" style={{ fontSize: 11, color: "var(--text-3, rgba(255,255,255,0.35))", fontStyle: "italic" }}>
        {"\uD83D\uDD12 \u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0443\u0434\u0430\u043B\u0435\u043D\u043E"}
      </span>
    );
  }

  return (
    <span className="tg-self-destruct-timer">
      {formatCountdown(remaining)}
    </span>
  );
}
