import { formatNumber } from "./phone";
import { BRAND } from "./brand";
import type { ReplyRef, ReplyWire, Theme } from "../types";


export function humanAuthError(reason?: string) {
  switch (reason) {
    case "invalid_number": return "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043D\u043E\u043C\u0435\u0440 \u0444\u043E\u0440\u043C\u0430\u0442\u0430 111-XX-XXX-XX";
    case "number_not_found": return "\u041D\u043E\u043C\u0435\u0440 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D. \u041F\u043E\u043B\u0443\u0447\u0438\u0442\u0435 Phantom Number.";
    case "number_inactive": return "\u041D\u043E\u043C\u0435\u0440 \u043D\u0435\u0430\u043A\u0442\u0438\u0432\u0435\u043D. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0441\u0442\u0430\u0442\u0443\u0441 \u0432 \u0432\u0430\u0448\u0435\u043C \u043A\u0430\u0431\u0438\u043D\u0435\u0442\u0435.";
    case "rate_limited": return "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u043F\u043E\u043F\u044B\u0442\u043E\u043A. \u041F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435 \u0438 \u043F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0441\u043D\u043E\u0432\u0430.";
    case "too_many_attempts": return "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u043D\u0435\u0432\u0435\u0440\u043D\u044B\u0445 \u043F\u043E\u043F\u044B\u0442\u043E\u043A. \u0417\u0430\u043F\u0440\u043E\u0441\u0438\u0442\u0435 \u043A\u043E\u0434 \u043F\u043E\u0437\u0436\u0435.";
    case "invalid_code": return "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043A\u043E\u0434. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0432\u0432\u043E\u0434.";
    case "code_expired": return "\u041A\u043E\u0434 \u0438\u0441\u0442\u0451\u043A. \u0417\u0430\u043F\u0440\u043E\u0441\u0438\u0442\u0435 \u043D\u043E\u0432\u044B\u0439 \u043A\u043E\u0434.";
    case "otp_session_expired": return "\u0421\u0435\u0441\u0441\u0438\u044F \u043A\u043E\u0434\u0430 \u0438\u0441\u0442\u0435\u043A\u043B\u0430. \u0417\u0430\u043F\u0440\u043E\u0441\u0438\u0442\u0435 \u043D\u043E\u0432\u044B\u0439 \u043A\u043E\u0434.";
    case "upstream_unreachable": return "\u0421\u0435\u0440\u0432\u0438\u0441 NFT-\u043D\u043E\u043C\u0435\u0440\u043E\u0432 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u043E\u0437\u0436\u0435.";
    case "upstream_error":
    case "upstream_verify_failed": return "\u0421\u0435\u0440\u0432\u0438\u0441 NFT-\u043D\u043E\u043C\u0435\u0440\u043E\u0432 \u0432\u0435\u0440\u043D\u0443\u043B \u043D\u0435\u043E\u0436\u0438\u0434\u0430\u043D\u043D\u044B\u0439 \u043E\u0442\u0432\u0435\u0442 \u043F\u0440\u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0435 \u043A\u043E\u0434\u0430.";
    default: return "\u041E\u0448\u0438\u0431\u043A\u0430 \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u0430\u0446\u0438\u0438. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u043E\u043F\u044B\u0442\u043A\u0443.";
  }
}

export function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

/**
 * Show a browser notification for an incoming message.
 *
 * The Notification Center on every modern OS (macOS / Windows / GNOME / KDE)
 * retains the body text — the same text is visible above the lock screen
 * and inside Focus summaries. Plaintext chat bodies are thus leaked outside
 * the E2E perimeter. We render a GENERIC body by default (“Новое сообщение”
 * + last two digits of the sender), and only reveal the real preview when
 * the user has explicitly opted in via Settings → Privacy. The setting is
 * stored per-account in localStorage and read on every call.
 */
const NOTIFY_PREVIEW_KEY = "phantom_notify_show_preview";

export function getNotifyShowPreview(): boolean {
  try {
    return localStorage.getItem(NOTIFY_PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNotifyShowPreview(on: boolean): void {
  try {
    localStorage.setItem(NOTIFY_PREVIEW_KEY, on ? "1" : "0");
  } catch {
    /* ignore — quota / private mode */
  }
}

function maskedSender(fromNumber: string): string {
  const digits = String(fromNumber || "").replace(/\D/g, "");
  if (!digits) return "●●●●";
  const tail = digits.slice(-2);
  return `●●●●●●${tail}`;
}

// Мультиаккаунт: показанные страницей уведомления привязаны к номеру получателя, чтобы при смене
// аккаунта / panic их можно было убрать (текст не остаётся в центре уведомлений).
const liveNotifications = new Set<{ n: Notification; to: string }>();

function track(n: Notification, to: string) {
  const rec = { n, to };
  liveNotifications.add(rec);
  n.onclose = () => { liveNotifications.delete(rec); };
}

/** Закрыть уведомления получателя `toNumber` (без аргумента — все: panic). Включая показанные через SW. */
export function closeNotificationsFor(toNumber?: string): void {
  for (const rec of [...liveNotifications]) {
    if (!toNumber || rec.to === toNumber || !rec.to) {
      try { rec.n.close(); } catch { /* ignore */ }
      liveNotifications.delete(rec);
    }
  }
  try {
    void navigator.serviceWorker?.getRegistration().then(reg => reg?.getNotifications()).then(list => {
      for (const x of list || []) {
        const to = x.data && typeof x.data.toNumber === "string" ? x.data.toNumber : "";
        if (!toNumber || !to || to === toNumber) x.close();
      }
    }).catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}

export function showBrowserNotification(fromNumber: string, text: string, kind: "text" | "file" | "voice" = "text", generic = false, toNumber = "") {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!(document.hidden || !document.hasFocus())) return;

  // generic (S10.7/Q13, ревью L2): при включённой блокировке приложения — фиксированные
  // заголовок/тело/tag, без текста и без каких-либо цифр номера
  if (generic) {
    track(new Notification(BRAND.identity.name, { body: "Новое сообщение", icon: "/icon.svg", tag: "phantom-generic", data: { toNumber } }), toNumber);
    return;
  }
  const showPreview = getNotifyShowPreview();
  const sender = showPreview ? formatNumber(fromNumber) : maskedSender(fromNumber);
  let body: string;
  if (showPreview && kind === "text") {
    body = text.length > 100 ? text.slice(0, 100) + "..." : text;
  } else if (kind === "file") {
    body = showPreview && text ? text : "Файл";
  } else if (kind === "voice") {
    body = "Голосовое сообщение";
  } else {
    body = "Новое сообщение";
  }
  track(new Notification(`${BRAND.identity.name}: ${sender}`, {
    body,
    icon: "/icon.svg",
    tag: `phantom-${toNumber}-${fromNumber}`,
    data: { toNumber },
  }), toNumber);
}

export function nowId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Client-side device hint. The server does NOT trust this value directly —
 * it feeds it through an HMAC keyed by the server's jwt_secret and returns
 * the derived `deviceId` in the `session_ready` payload. Knowing another
 * user's deviceId gives an attacker nothing, because it can't be reproduced
 * without the server secret.
 */
export function getRelayDeviceHint() {
  // BE-30: стабильный per-browser hex16 (8 случайных байт). Сервер делает из
  // него HMAC-device_id и привязывает к нему JWT. Panic стирает все `phantom_*`
  // ключи localStorage → после panic браузер становится «новым устройством».
  const key = "phantom_device_hint";
  try {
    const stored = localStorage.getItem(key);
    if (stored && /^[0-9a-f]{16}$/.test(stored)) return stored;
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const created = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(key, created);
    localStorage.removeItem("phantom_device_id"); // старый UUID-хинт больше не используется
    return created;
  } catch {
    // localStorage недоступен — хинт только на эту загрузку страницы
    if (!volatileDeviceHint) {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      volatileDeviceHint = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    }
    return volatileDeviceHint;
  }
}
let volatileDeviceHint = "";

/**
 * Historically exported as `getRelayDeviceId`. Kept as a thin alias so
 * call-sites that still display the local identifier in debug UIs keep
 * compiling — the authoritative id now comes from `session_ready`.
 */
export const getRelayDeviceId = getRelayDeviceHint;

/**
 * Build the relay WebSocket URL. Токен в query НЕ передаётся (утёк бы в логи
 * прокси). Device hint передаётся в `?device_id=<hex16>`: когда токен пришёл
 * через Sec-WebSocket-Protocol, relay не читает auth-кадр до установки сессии,
 * и `deviceId` из auth-кадра игнорируется — без query каждый коннект получал
 * случайный device_id. Хинт сам по себе ничего не даёт без валидного JWT и
 * серверного jwt_secret (device_id = HMAC(jwt_secret, number:hint)).
 */
export function buildWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const hint = encodeURIComponent(getRelayDeviceHint());
  return `${protocol}://${window.location.host}/relay?device_id=${hint}`;
}


/**
 * Open a relay WebSocket without ever exposing the auth token in a URL.
 *
 * The browser `WebSocket` constructor cannot set arbitrary headers, but it
 * CAN negotiate a Sec-WebSocket-Protocol. The server recognises
 * `bearer.<jwt>` as an auth sub-protocol. As a belt-and-braces fallback (in
 * case the sub-protocol handshake is stripped by a proxy) we also emit an
 * `auth` message immediately after `open`.
 */
export function openRelayWs(token: string): WebSocket {
  const url = buildWsUrl();
  // sub-protocol tokens may only contain token-chars — dot-separated is fine.
  const ws = new WebSocket(url, [`bearer.${token}`]);
  const originalOnOpen = ws.onopen;
  ws.addEventListener("open", () => {
    try {
      ws.send(JSON.stringify({
        type: "auth",
        token,
        // The field name is kept as `deviceId` for wire compatibility; the
        // server treats it as a hint and computes the authoritative id.
        deviceId: getRelayDeviceHint(),
      }));
    } catch {
      // If send fails the server will close on its own auth timeout.
    }
  });
  // Preserve any handler assigned before open — addEventListener already does,
  // but keep TypeScript happy about the unused var.
  void originalOnOpen;
  return ws;
}

export function getInitials(name: string) {
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?";
}

/**
 * Deterministic avatar background. Returns a `linear-gradient(135deg, ...)`
 * built from two related colors picked by hashing the input string. Two
 * adjacent palette entries are used so the gradient stays harmonious rather
 * than clashing. Consumers assign it via `style={{ background: avatarColor(x) }}`.
 */
export function avatarColor(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const palette = [
    ["#7b2fbe", "#a855f7"],
    ["#4a90d9", "#60a5fa"],
    ["#e67e22", "#f59e0b"],
    ["#27ae60", "#34d399"],
    ["#e74c3c", "#fb7185"],
    ["#9b59b6", "#c084fc"],
    ["#1abc9c", "#22d3ee"],
    ["#f39c12", "#facc15"],
  ];
  const [a, b] = palette[Math.abs(hash) % palette.length];
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}

export function getStoredTheme(): Theme {
  return (localStorage.getItem("phantom_theme") as Theme) || "system";
}

export function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme;
}

export function formatCountdown(sec: number): string {
  if (sec <= 0) return "";
  if (sec < 60) return `${sec}\u0441`;
  return `${Math.floor(sec / 60)}\u043C ${sec % 60}\u0441`;
}

/** Generate deterministic waveform bars from a string hash */
export function generateWaveform(seed: string, barCount: number = 32): number[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const bars: number[] = [];
  for (let i = 0; i < barCount; i++) {
    hash = ((hash * 1103515245 + 12345) & 0x7fffffff);
    bars.push(0.15 + (hash % 100) / 100 * 0.85);
  }
  return bars;
}

/** Build a per-account storage key */
export function accountKey(selfNumber: string, key: string): string {
  return `phantom_${selfNumber}_${key}`;
}

/** Заглушка для цитаты/закрепа, если сообщения нет в локальной истории (S5). */
export const MESSAGE_UNAVAILABLE = "Сообщение недоступно";

/**
 * S5: нормализовать входящий `replyTo` (relay или P2P) к `{ messageId, from? }`.
 * Принимает строку (старый Android) и объект; `text` от собеседника НЕ
 * сохраняется — текст цитаты берётся только из локальной истории.
 */
export function normalizeReplyRef(raw: unknown): ReplyRef | undefined {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id && id.length <= 128 ? { messageId: id } : undefined;
  }
  if (raw && typeof raw === "object") {
    const r = raw as { messageId?: unknown; from?: unknown };
    if (typeof r.messageId !== "string" || !r.messageId || r.messageId.length > 128) return undefined;
    const ref: ReplyRef = { messageId: r.messageId };
    if (typeof r.from === "string" && r.from) ref.from = r.from;
    return ref;
  }
  return undefined;
}

/** S5: канонический wire `replyTo` — только `{ messageId, from }`, без текста. */
export function toReplyWire(ref: ReplyRef | null | undefined): ReplyWire | undefined {
  if (!ref || !ref.messageId) return undefined;
  return { messageId: ref.messageId, from: ref.from || "" };
}
