import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyBrandTheme, BRAND } from "./lib/brand";
import { loadOrCreateKeys, encrypt, decrypt, wipe, wipeKeysAndWait, isUnsupportedVersionError } from "./lib/cryptoClient";
import { keyFingerprint } from "./lib/safety";
import {
  parseMeta1, isMeta1Plaintext, stripNul, utf8Length, legacyDurationToSeconds,
  buildTextPayload, buildVoicePayload, buildEditPayload, buildReactionPayload,
  MAX_ATTACHMENT_BYTES, MAX_META1_PLAINTEXT_BYTES, TEXT_MAX_CHARS, type Meta1Outcome,
  sanitizeOutgoingFileName, sanitizeOutgoingMime,
} from "./lib/meta1";
import {
  readAppLock, readPanic, migratePlainPins, readFailState, writeFailState, checkUnlock,
  registerFailure, lockRemainingMs, attemptsBeforeWipe, APPLOCK_WARN_FROM_FAILURES, type LockFailState,
} from "./lib/applock";
import { formatNumber, normalizeNumber } from "./lib/phone";
// S10.5/Q9: SDP без host(/prflx) и raddr/rport обнулены во всех кандидатах (lib/sdp.ts)
import { stripSdpCandidates, sanitizeIceCandidate } from "./lib/sdp";
import {
  humanAuthError, requestNotificationPermission, showBrowserNotification, closeNotificationsFor,
  nowId, openRelayWs, getStoredTheme, resolveTheme, accountKey,
  normalizeReplyRef, toReplyWire,
} from "./lib/utils";
import type { ChatMessage, ChatSettings, ClientCapability, EncryptedBlob, RelayInbound, RelayOutbound, ReplyRef, Theme, PinnedMessageInfo } from "./types";
import { slog } from "./lib/log";
import { safeAvatar } from "./lib/avatar";
import { safeSetJson, safeSetItem } from "./lib/storage";
import { sniffFile } from "./lib/fileType";
import { acceptRemoteFingerprint, callSas } from "./lib/callSas";
// P2P v2 (documentation/PROTOCOL_P2P_V2.md): files_v1 — шифрование чанков, file_offer, приём
import {
  FILE_CHUNK_DEFAULT, FILE_FRAME_MAX, WEB_MAX_FILE_BYTES, MAX_TRANSFERS_PER_PEER,
  DC_BUFFER_LOW, FILE_ABORT_REASONS, toHex, fromHex, randomBytes, importFileKey, parseFileFrame, sha256OfBlob,
  buildFileOfferPlaintext, parseFileOffer, sendFileChunks, safeReceivedMime, FileReceiver,
  buildHelloFrame, parseHelloFrame,
  type FileAbortReason, type DcLike,
} from "./lib/p2pFile";
import { decideIncomingOffer, P2P_DEFERRED_OFFER_TTL_MS } from "./lib/p2pGlare";
import {
  getToken, getActiveNumber, listAccounts, hasTokenFor, isTokenExpiredFor, setTokenFor, addAccountToken, activateAccount,
  clearToken as clearTokenMemory,
} from "./lib/token";
import { MAX_ACCOUNTS } from "./lib/accounts";

import AuthScreen from "./components/AuthScreen";
import CallOverlay from "./components/CallOverlay";
import ErrorBoundary from "./components/ErrorBoundary";

import Sidebar from "./components/Sidebar";
import MenuPanelComponent from "./components/MenuPanel";
import ChatPanel from "./components/ChatPanel";
import type { VoiceRecording } from "./components/VoiceRecorderBar";
import Onboarding from "./components/Onboarding";
import { usePhantomToast } from "./components/Toast";

import { tx, initialLocale } from "./lib/i18n";

type Screen = "login" | "otp" | "messenger";
type ConnectionState = "offline" | "connecting" | "online";
type MenuPanel = null | "profile" | "contacts" | "settings" | "newchat";

const OTP_LENGTH = 6;
const TYPING_DEBOUNCE_MS = 2000;
const CALL_TIMEOUT_MS = 30000;
const ICE_DISCONNECT_TIMEOUT_MS = 5000;
const MAX_ICE_RESTART_ATTEMPTS = 2;
const MESSAGE_WINDOW_SIZE = 100;
// S1: ключ собеседника старше 5 минут перед отправкой перезапрашивается lookup'ом
const PEER_KEY_MAX_AGE_MS = 5 * 60_000;
// S1: сколько ждать ответ на lookup, если ключа нет / если он просто «старый»
const PEER_KEY_WAIT_MISSING_MS = 5000;
const PEER_KEY_WAIT_STALE_MS = 1500;
// Не слать повторный lookup чаще (relay: LOOKUP_RATE_LIMIT_PER_MINUTE = 5)
const PEER_KEY_LOOKUP_THROTTLE_MS = 15_000;
const PEER_KEY_UNAVAILABLE_ERROR = "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043A\u043B\u044E\u0447 \u0441\u043E\u0431\u0435\u0441\u0435\u0434\u043D\u0438\u043A\u0430. \u0412\u043E\u0437\u043C\u043E\u0436\u043D\u043E, \u043E\u043D \u043E\u0444\u043B\u0430\u0439\u043D.";

const SAVED_MESSAGES_KEY = "__saved__";

const ONBOARDING_KEY = "phantom_onboarding_seen";

// X-02 / S3: verified[number] = отпечаток ключа (hex(SHA-256(raw65))[:32]).
// Старый формат `true` без привязки к ключу отбрасывается — его нужно подтвердить заново.
function loadVerifiedKeys(number: string): Record<string, string> {
  if (!number) return {};
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(number, "verified_keys")) || "{}");
    const out: Record<string, string> = {};
    if (raw && typeof raw === "object") {
      for (const [num, fp] of Object.entries(raw)) {
        if (typeof fp === "string" && /^[0-9a-f]{32}$/.test(fp)) out[num] = fp;
      }
    }
    return out;
  } catch { return {}; }
}

// S9 (documentation/PROTOCOL_V2_SPEC.md): возможности, объявляемые relay в register (P9).
// S10 (documentation/PROTOCOL_S10_SPEC.md, Q8): "meta1" = клиент S10 целиком —
// метаданные внутри E2E, safety number v2 + QR v2, block_sync.
const CLIENT_CAPABILITIES: ClientCapability[] = ["env2", "meta1"];
// P2P v2 §3.7 (events_v1): события, которые идут по DC тем же JSON, что на relay (без toNumber/deviceBlobs)
// Идемпотентные события, которые помимо DC дублируются через relay (без ack на DC)
const P2P_EVENT_RELAY_DUP = new Set<string>(["message_delete", "message_edit", "burn_read_ack"]);
const P2P_EVENT_TYPES = new Set([
  "typing", "read_receipt", "delivery_receipt", "message_edit", "message_delete", "reaction", "burn_read_ack", "screenshot_alert",
]);
// §3.2(c): кадры relay от пира, после которых пробуем поднять DC
const P2P_INBOUND_TRIGGER_TYPES = new Set(["message", "reaction", "typing", "message_edited", "file_message", "voice_message"]);
// Тип кадра relay на приёме для события, пришедшего по DC (relay переименовывает edit/delete)
const P2P_EVENT_INBOUND_TYPE: Record<string, string> = { message_edit: "message_edited", message_delete: "message_deleted" };
// §3.5: delivery_ack по DC не пришёл за это время — повтор через relay тем же messageId
const P2P_ACK_TIMEOUT_MS = 10_000;
// §3.2(d): повторы установки канала, пока файл «ожидает собеседника»: 5 с → 15 с → 60 с → 5 мин
const P2P_FILE_RETRY_MS = [5_000, 15_000, 60_000, 300_000];
// §3.2: не больше 6 p2p_offer в минуту на номер (лимит relay — 30)
const P2P_OFFERS_PER_MIN = 6;
// §4.5: таймауты передачи файлов
const FILE_ACCEPT_TIMEOUT_MS = 30_000;
const FILE_IDLE_TIMEOUT_MS = 60_000;
// §5.1: повторных предложений после обрыва канала
const FILE_MAX_REOFFERS = 3;
const FILE_WAITING_TEXT = "Ожидает собеседника";
const FILE_OLD_PEER_TEXT = "Собеседник использует старую версию приложения — отправка файлов недоступна";
const FILE_P2P_OFF_TEXT = "Прямое соединение выключено у вас — файлы передаются только напрямую";
const FILE_ONE_DEVICE_TEXT = "Доставлено на одно устройство собеседника";
const FILE_ABORT_TEXT: Record<string, string> = {
  declined: "собеседник отклонил", busy: "собеседник занят", disk_full: "нет места у собеседника",
  too_large: "файл слишком большой", unsupported: "не поддерживается", timeout: "нет ответа",
  invalid: "ошибка проверки", cancelled: "отменено", protocol: "ошибка передачи", io: "ошибка чтения",
};
// P6: не больше 8 закреплённых отпечатков identity-ключей на собеседника (FIFO)
const PINNED_IDENTITY_MAX = 8;
// P3: blob с version ≥ 3 — без попытки расшифровки как v1
const UNSUPPORTED_VERSION_TEXT = "[Неподдерживаемая версия сообщения — обновите приложение]";
const IDENTITY_CHANGED_TEXT = "У собеседника появилось новое устройство или изменился ключ безопасности — проверьте код безопасности";
const OLD_PROTOCOL_TEXT = "Сообщение пришло по старому протоколу (возможно, с другого устройства собеседника)";
const DECRYPT_FAILED_TEXT = "[Не удалось расшифровать сообщение]";
// S10.1 / Q5: payload meta1 не прошёл валидацию
const INVALID_MESSAGE_TEXT = "[Некорректное сообщение]";
// Q16: легаси-формат от собеседника, который уже присылал meta1 — однократно за сессию
const META1_DOWNGRADE_TEXT = "Метаданные этого сообщения пришли по старому формату (возможно, с другого устройства собеседника)";
// Q7: отправка заблокирована до подтверждения смены ключа
const KEY_ALERT_BLOCKED_TEXT = "Ключ безопасности собеседника изменился. Сверьте код безопасности или нажмите «Продолжить» в чате.";
// Q5: честный лимит вложения (файл/голос) — от капа кадра relay 256 КиБ
const ATTACHMENT_LIMIT_TEXT = `Максимальный размер файла или голосового сообщения: ${Math.floor(MAX_ATTACHMENT_BYTES / 1024)} КБ`;
// Q11: tombstone разблокировки живёт 30 дней
const UNBLOCK_TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

// P6: pinnedIdentity[number] — множество отпечатков (hex(SHA-256(raw65))[:32]) из
// senderIdentityKey успешно расшифрованных v2. Persist per-account, стирается logout/panic.
function loadPinnedIdentity(number: string): Record<string, string[]> {
  if (!number) return {};
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(number, "pinned_identity")) || "{}");
    const out: Record<string, string[]> = {};
    if (raw && typeof raw === "object") {
      for (const [num, fps] of Object.entries(raw)) {
        if (!Array.isArray(fps)) continue;
        const valid = fps.filter((fp): fp is string => typeof fp === "string" && /^[0-9a-f]{32}$/.test(fp));
        if (valid.length) out[num] = valid.slice(-PINNED_IDENTITY_MAX);
      }
    }
    return out;
  } catch { return {}; }
}

// P6/P7 (уточнение): lastVerifiedIdentity[number] — отпечаток, подтверждённый пользователем
// кнопкой «проверено». НЕ сбрасывается по P6 вместе с verified (только logout/panic), никогда
// не вытесняется из пинов. Для уже подтверждённых до обновления собеседников берётся из verified_keys.
function loadLastVerifiedIdentity(number: string): Record<string, string> {
  if (!number) return {};
  const out: Record<string, string> = { ...loadVerifiedKeys(number) };
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(number, "last_verified_identity")) || "{}");
    if (raw && typeof raw === "object") {
      for (const [num, fp] of Object.entries(raw)) {
        if (typeof fp === "string" && /^[0-9a-f]{32}$/.test(fp)) out[num] = fp;
      }
    }
  } catch { /* битая запись — только verified_keys */ }
  return out;
}

// P9: peerEnv2[number] = true — от номера уже приходил v2 (защита от даунгрейда).
function loadPeerEnv2(number: string): Record<string, boolean> {
  if (!number) return {};
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(number, "peer_env2")) || "{}");
    const out: Record<string, boolean> = {};
    if (raw && typeof raw === "object") {
      for (const [num, v] of Object.entries(raw)) if (v === true) out[num] = true;
    }
    return out;
  } catch { return {}; }
}

// S10.1/Q16: peerMeta1[number] = true — от номера уже приходил meta1-payload (липкий, persist
// рядом с peer_env2; сброс только logout/panic).
function loadPeerMeta1(number: string): Record<string, boolean> {
  if (!number) return {};
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(number, "peer_meta1")) || "{}");
    const out: Record<string, boolean> = {};
    if (raw && typeof raw === "object") {
      for (const [num, v] of Object.entries(raw)) if (v === true) out[num] = true;
    }
    return out;
  } catch { return {}; }
}

// S10.3/Q7: keyAlert[number] = отпечаток, из-за которого отправка заблокирована;
// ackFp[number] — отпечатки, смену на которые пользователь уже подтвердил («Продолжить»).
// Persist per-account вместе с пинами, сброс logout/panic.
function loadKeyAlerts(number: string): Record<string, string> {
  if (!number) return {};
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(number, "key_alert")) || "{}");
    const out: Record<string, string> = {};
    if (raw && typeof raw === "object") {
      for (const [num, fp] of Object.entries(raw)) if (typeof fp === "string" && /^[0-9a-f]{32}$/.test(fp)) out[num] = fp;
    }
    return out;
  } catch { return {}; }
}
function loadAckFp(number: string): Record<string, string[]> {
  if (!number) return {};
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(number, "key_ack")) || "{}");
    const out: Record<string, string[]> = {};
    if (raw && typeof raw === "object") {
      for (const [num, fps] of Object.entries(raw)) {
        if (!Array.isArray(fps)) continue;
        const valid = fps.filter((fp): fp is string => typeof fp === "string" && /^[0-9a-f]{32}$/.test(fp));
        if (valid.length) out[num] = valid.slice(-PINNED_IDENTITY_MAX);
      }
    }
    return out;
  } catch { return {}; }
}

// S10.6/Q11: локальный блок-лист (источник правды) + tombstones разблокировки (30 дней).
// exists=false — локального списка ещё нет (первый запуск): сначала принимаем blocked_list relay.
type LocalBlockList = { exists: boolean; numbers: string[]; unblocked: Record<string, number> };
function loadBlockList(number: string): LocalBlockList {
  const empty: LocalBlockList = { exists: false, numbers: [], unblocked: {} };
  if (!number) return empty;
  try {
    const raw = localStorage.getItem(accountKey(number, "blocklist"));
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const numbers = Array.isArray(parsed?.numbers)
      ? parsed.numbers.filter((n: unknown): n is string => typeof n === "string" && !!normalizeNumber(n)).slice(0, 1000)
      : [];
    const unblocked: Record<string, number> = {};
    if (parsed?.unblocked && typeof parsed.unblocked === "object") {
      for (const [n, ts] of Object.entries(parsed.unblocked)) {
        if (typeof ts === "number" && now - ts < UNBLOCK_TOMBSTONE_TTL_MS && normalizeNumber(n)) unblocked[n] = ts;
      }
    }
    return { exists: true, numbers, unblocked };
  } catch { return empty; }
}

// Настройки приватности per-account. privateCalls раньше жил в устройство-уровневом
// `phantom_private_calls` — берётся оттуда, если в аккаунте ещё не задан.
function loadPrivacySettings(number: string) {
  const fallback = {
    hideOnline: false, disableReadReceipts: false, disableTyping: false, burnAfterRead: false,
    // P2P v2 §2: прямое соединение включено по умолчанию (нет значения → true)
    privateCalls: false, p2pFallback: true, p2pMigratedV2: true,
  };
  try {
    if (localStorage.getItem("phantom_private_calls") === "1") fallback.privateCalls = true;
  } catch { /* ignore */ }
  if (!number) return fallback;
  try {
    const raw = localStorage.getItem(accountKey(number, "privacy"));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    const merged = { ...fallback, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    // P2P v2 §2: одноразовая миграция — у всех, кто сохранял приватность до 16.10, лежит
    // p2pFallback:false, которого они не выбирали (дефолт тогда был выкл.). Включаем один раз.
    if (!(parsed && typeof parsed === "object" && parsed.p2pMigratedV2)) {
      merged.p2pFallback = true;
      (merged as Record<string, unknown>).p2pMigratedV2 = true;
      try { localStorage.setItem(accountKey(number, "privacy"), JSON.stringify(merged)); } catch { /* ignore */ }
    }
    return merged;
  } catch { return fallback; }
}


// P2P v2 §7.3: путь медиа по выбранной паре ICE-кандидатов (transport.selectedCandidatePairId,
// иначе candidate-pair nominated+succeeded / selected). Хоть одна сторона relay → TURN.
async function detectCallPath(pc: RTCPeerConnection): Promise<"" | "direct" | "turn"> {
  const stats = await pc.getStats();
  let pairId = "";
  stats.forEach((r: any) => { if (r.type === "transport" && typeof r.selectedCandidatePairId === "string") pairId = r.selectedCandidatePairId; });
  let pair: any = pairId ? stats.get(pairId) : undefined;
  if (!pair) stats.forEach((r: any) => { if (!pair && r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r; });
  if (!pair) stats.forEach((r: any) => { if (!pair && r.type === "candidate-pair" && r.selected) pair = r; });
  if (!pair) return "";
  const local: any = stats.get(pair.localCandidateId);
  const remote: any = stats.get(pair.remoteCandidateId);
  if (!local && !remote) return "";
  return local?.candidateType === "relay" || remote?.candidateType === "relay" ? "turn" : "direct";
}

// UUID звонка (S10.5/Q10)
function newCallId(): string {
  try { return crypto.randomUUID(); }
  catch {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  }
}

// H2 (ревью): wipe/logout в одной вкладке → немедленный выход во всех остальных вкладках
// (иначе соседняя вкладка продолжает жить с данными в RAM и пишет их обратно).
const WIPE_CHANNEL = "phantom-wipe";
type WipeSignal = { scope: "all" } | { scope: "account"; number: string };
function broadcastWipe(msg: WipeSignal) {
  try {
    const bc = new BroadcastChannel(WIPE_CHANNEL);
    bc.postMessage(msg);
    bc.close();
  } catch { /* BroadcastChannel недоступен — остаётся событие storage */ }
}
// Записи аккаунта, которые в обычной работе никогда не удаляются: их исчезновение в другой
// вкладке означает logout/panic/wipe этого аккаунта.
const ACCOUNT_WIPE_MARKERS = ["contacts", "pinned_identity", "peer_env2", "blocklist", "applock", "panic", "verified_keys", "key_ack"];

// X-06/Q14: стереть все записи accountKey(number, *) в localStorage и sessionStorage.
function wipeAccountStorage(number: string) {
  if (!number) return;
  const prefix = accountKey(number, "");
  for (const store of [localStorage, sessionStorage]) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
      for (const k of keys) store.removeItem(k);
    } catch { /* storage недоступен */ }
  }
}

// Мультиаккаунт: у аккаунта включена блокировка (App Lock) — тот же разбор, что у начального состояния
function accountHasLock(n: string): boolean {
  try { return JSON.parse(localStorage.getItem(accountKey(n, "applock")) || "{}")?.enabled === true; } catch { return false; }
}

// WEB-05: проверка ?visual=1 (VisualCatalog) вынесена в Root в main.tsx —
// ранний return до хуков App нарушал Rules of Hooks.
export default function App() {
  // token.ts hydrates the bearer from sessionStorage at module load and
  // immediately wipes that storage key, so the only way to reach it after
  // boot is through the React state below (which stays in the module closure).
  const storedToken = getToken();
  const storedNumber = storedToken ? getActiveNumber() : "";

  const phantomToast = usePhantomToast();
  // Для обработчиков WS-эффекта: тост без добавления в зависимости эффекта
  const phantomToastRef = useRef(phantomToast);
  phantomToastRef.current = phantomToast;

  // Onboarding gate (§10.6) — show the 3-screen intro only to first-time
  // visitors who aren't already logged in. Logged-in users are assumed to
  // have seen it implicitly, so we mark it as seen on boot.
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    if (storedToken && storedNumber) {
      try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch { /* ignore */ }
      return false;
    }
    try { return localStorage.getItem(ONBOARDING_KEY) !== "1"; }
    catch { return false; }
  });

  const completeOnboarding = useCallback(() => {
    try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch { /* ignore */ }
    setShowOnboarding(false);
  }, []);

  const [screen, setScreen] = useState<Screen>(() => {
    if (!storedToken || !storedNumber) return "login";
    return "messenger";
  });

  // Auth state
  const [inputNumber, setInputNumber] = useState("");
  const [pendingNumber, setPendingNumber] = useState("");
  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(""));
  const [otpSeconds, setOtpSeconds] = useState(0);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");

  // Session state
  const [token, setToken] = useState(storedToken);
  const [selfNumber, setSelfNumber] = useState(storedNumber);
  // Мультиаккаунт (до MAX_ACCOUNTS номеров в вкладке): список номеров (токены — только в lib/token.ts)
  // и режим «Добавить аккаунт» (экран входа с кнопкой «Отмена»; прежний аккаунт остаётся в списке).
  const [accounts, setAccounts] = useState<string[]>(() => listAccounts());
  const [addingAccount, setAddingAccount] = useState(false);
  // Поколение попытки входа: смена/сброс аккаунта обесценивает ответы уже отправленных
  // send-code / verify-code (поздний ответ не уводит на ввод кода и не подменяет аккаунт)
  const authGenRef = useRef(0);
  // Аккаунт, с которого переключились на заблокированный (App Lock): пока PIN не введён,
  // принудительный выход из цели (4401) возвращает сюда, а не стирает токены всех аккаунтов
  const switchOriginRef = useRef("");
  const [sessionReady, setSessionReady] = useState(false);
  const [connState, setConnState] = useState<ConnectionState>("offline");
  const [relayError, setRelayError] = useState("");

  // Chat state
  const [activePeer, setActivePeer] = useState("");
  const [activePeerOnline, setActivePeerOnline] = useState<boolean | null>(null);
  const [messageText, setMessageText] = useState("");
  const messageTextRef = useRef("");
  messageTextRef.current = messageText;
  // X-01 / S1: ключи собеседников — ТОЛЬКО из lookup_result (не из senderPublicKey входящих)
  const [peerKeys, setPeerKeys] = useState<Record<string, string>>({});
  // Время получения ключа из lookup_result / последнего ответа на lookup / последнего запроса (ms)
  const peerKeyAtRef = useRef<Record<string, number>>({});
  const peerLookupReplyAtRef = useRef<Record<string, number>>({});
  const peerLookupSentAtRef = useRef<Record<string, number>>({});
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  // Снимок истории для async-обработчиков P2P (file_offer проверяет существующий messageId)
  const messagesRef = useRef<Record<string, ChatMessage[]>>({});
  messagesRef.current = messages;

  // UI state
  const [menuPanel, setMenuPanel] = useState<MenuPanel>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [newChatNumber, setNewChatNumber] = useState("");
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  // Theme
  const [themePreference, setThemePreference] = useState<Theme>(getStoredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">(() => resolveTheme(getStoredTheme()));

  // Contacts -- per-account
  const [contacts, setContacts] = useState<Record<string, string>>(() => {
    if (!storedNumber) return {};
    try { return JSON.parse(localStorage.getItem(accountKey(storedNumber, "contacts")) || "{}"); }
    catch { return {}; }
  });
  const [editContactName, setEditContactName] = useState("");
  const [editContactNumber, setEditContactNumber] = useState("");

  // Privacy -- per-account
  const [showPrivacyNotice, setShowPrivacyNotice] = useState(
    () => {
      if (!storedNumber) return true;
      return localStorage.getItem(accountKey(storedNumber, "privacy_seen")) !== "1";
    }
  );

  // Typing indicator
  const [typingPeers, setTypingPeers] = useState<Record<string, number>>({});
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentRef = useRef(0);

  // Reply state
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);

  // Self-destruct
  const [selfDestructSec, setSelfDestructSec] = useState(0);
  const [showSelfDestructMenu, setShowSelfDestructMenu] = useState(false);

  // Reactions popup
  const [reactionMsgId, setReactionMsgId] = useState<string | null>(null);
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);

  // Delete confirmation modal
  const [deleteConfirmMsg, setDeleteConfirmMsg] = useState<ChatMessage | null>(null);

  // Pinned messages
  const [pinnedMessages, setPinnedMessages] = useState<Record<string, PinnedMessageInfo[]>>({});
  const [showPinned, setShowPinned] = useState(false);

  // Search in chat
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [chatSearchOpen, setChatSearchOpen] = useState(false);

  // Message windowing
  const [messageWindowSize, setMessageWindowSize] = useState(MESSAGE_WINDOW_SIZE);

  // Drag & drop
  const [isDragOver, setIsDragOver] = useState(false);
  // Файл, брошенный мимо зоны drop (.app-root): экраны входа/блокировки, оверлей блокировки —
  // Firefox пытается открыть его как file:// («Security Error: … may not load or link to file:///»).
  // Глушим только навигацию браузера; отправка файла — по-прежнему в handleDrop.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  // Unread counts
  const [unread, setUnread] = useState<Record<string, number>>({});

  // Drafts — persisted in sessionStorage per account (9.4) — survives F5 but not tab close
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    if (!storedNumber) return {};
    try { return JSON.parse(sessionStorage.getItem(accountKey(storedNumber, "drafts")) || "{}"); }
    catch { return {}; }
  });

  // Add contact modal
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [addContactName, setAddContactName] = useState("");

  // ── Blocked users ──
  // S10.6/Q11: локальный блок-лист per-account — источник правды; relay получает block_sync
  // после каждого успешного register. Tombstones разблокировки — 30 дней.
  const [initialBlockList] = useState(() => loadBlockList(storedNumber));
  const blockListRef = useRef<LocalBlockList>(initialBlockList);
  const [blockedUsers, setBlockedUsers] = useState<Set<string>>(() => new Set(initialBlockList.numbers));
  // S4: refs для гейта P2P внутри ws.onmessage (замыкание эффекта видит устаревший state)
  const blockedUsersRef = useRef(blockedUsers);
  useEffect(() => { blockedUsersRef.current = blockedUsers; }, [blockedUsers]);
  const contactsRef = useRef(contacts);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  // S4: номера, которым мы сами писали в этой сессии (RAM, сбрасывается при logout/panic)
  const sentToRef = useRef<Set<string>>(new Set());
  // S4 / X-04: гейт P2P (раскрытие IP). Номер не в блок-листе И
  // (есть в контактах ИЛИ мы сами писали ему в этой сессии). Применяется и к
  // входящему p2p_offer, и к авто-старту по peer_online / lookup_result.
  const p2pPeerAllowed = useCallback((peer: string): boolean => {
    if (!peer || peer === selfNumberRef.current) return false;
    // P2P v2 §2: настройка «Прямое соединение (P2P)» (дефолт вкл.); выкл. — offer не шлём и не принимаем
    if (!privacyRef.current.p2pFallback) return false;
    if (blockedUsersRef.current.has(peer)) return false;
    // Доверие = контакт, ИЛИ мы ему писали/ставили файл в этой сессии, ИЛИ есть переписка в любую
    // сторону. Иначе после перезагрузки web молча отбрасывал p2p_offer собеседника, а файлы обеих
    // сторон вечно висели «ожидает собеседника». IP не-контактам не раскрывается: ICE relay-only.
    if (Object.prototype.hasOwnProperty.call(contactsRef.current, peer) || sentToRef.current.has(peer)) return true;
    // §2: TOFU-пин identity-ключа (localStorage, ставится только после успешной расшифровки) = «от него уже
    // приходили сообщения»: после перезахода (RAM пуста) авто-offer собеседника принимается сразу (паритет с macOS).
    if ((pinnedIdentityRef.current[peer]?.length ?? 0) > 0) return true;
    return (messagesRef.current[peer]?.length ?? 0) > 0;
  }, []);

  // ── Editing message ──
  const [editingMsg, setEditingMsg] = useState<{ id: string; peer: string; text: string } | null>(null);

  // ── Privacy settings ──
  // S10.5/Q9: privateCalls — «Скрывать IP в звонках» (relay-only ICE, дефолт выкл.), p2pFallback —
  // «Прямое соединение (P2P)» (P2P v2 §2, дефолт вкл.).
  const [privacySettings, setPrivacySettings] = useState<{
    hideOnline: boolean;
    disableReadReceipts: boolean;
    disableTyping: boolean;
    burnAfterRead: boolean;
    privateCalls: boolean;
    p2pFallback: boolean;
  }>(() => loadPrivacySettings(storedNumber));

  // ── Logout confirmation ──
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // ── App Lock ──
  const [appLocked, setAppLocked] = useState<boolean>(() => {
    if (!storedNumber) return false;
    try {
      const settings = JSON.parse(localStorage.getItem(accountKey(storedNumber, "applock")) || "{}");
      return settings.enabled || false;
    } catch { return false; }
  });
  const [appLockPin, setAppLockPin] = useState("");
  // L1: ref для обработчиков клавиш (оверлей блокировки — горячие клавиши звонка не работают)
  const appLockedRef = useRef(appLocked);
  useEffect(() => { appLockedRef.current = appLocked; }, [appLocked]);
  const lastActivityRef = useRef(Date.now());
  // S10.7/Q14: персистентный счётчик неудач и задержка; lockNow тикает для обратного отсчёта
  const [lockFail, setLockFail] = useState<LockFailState>(() => (storedNumber ? readFailState(localStorage, storedNumber) : { failCount: 0, lockedUntil: 0 }));
  const [lockBusy, setLockBusy] = useState(false);
  const [lockNow, setLockNow] = useState(() => Date.now());

  // ── P2P Mode (per-peer pool) ──
  // P2P v2 (documentation/PROTOCOL_P2P_V2.md): «P2P-first» — настройка «Прямое соединение (P2P)»
  // (дефолт вкл.). Каналы устанавливаются превентивно (§3.2) с контактами/собеседниками по гейту S4;
  // текст/голос/события идут по DC, если он открыт (§3.5), файлы — ТОЛЬКО по DC (§4–5).
  // Политика ICE как у звонков.
  //
  // Threat model: скомпрометированный relay может слать произвольные
  // p2p_offer (любой fromNumber, в любом количестве). Защиты:
  // - self-loop отбрасываем (fromNumber != self)
  // - cap на одновременные каналы (защита от exhaustion)
  // - TTL для каналов в connecting state (защита от висящих pc)
  // - cap на размер сообщения в DataChannel (защита от RAM-DoS)
  // - содержимое зашифровано E2E поверх DTLS тем же конвертом, что и через relay
  //   (ключ собеседника — из lookup_result; подмену ключа relay'ем обнаруживает
  //   только сверка safety number / TOFU-пины v2).
  const P2P_MAX_CHANNELS = 32;
  // Лимит считает только живые каналы: закрытые/упавшие не должны навсегда занимать слоты
  const p2pLiveCount = () => {
    let n = 0;
    for (const ch of p2pChannelsRef.current.values()) if (ch.state !== "closed" && ch.state !== "failed") n++;
    return n;
  };
  const P2P_STALE_MS = 30_000;
  const P2P_MAX_DC_MESSAGE = 256 * 1024; // 256 KiB
  type P2PChannel = {
    pc: RTCPeerConnection;
    dc: RTCDataChannel | null;
    state: "connecting" | "open" | "closed" | "failed";
    initiator: boolean;
    createdAt: number;
    pendingCandidates: RTCIceCandidateInit[]; // queued before remote desc set
    remoteDescSet: boolean;
    // S10.5/Q9: relay-only ICE и срок TURN-кредов (unix sec), с которыми создан канал
    relayOnly: boolean;
    credExpiresAt: number;
    // P2P v2 §3.4: hello пира; до hello (≤ 5 с после open) — features = ["messages"]
    openedAt: number;
    helloReceived: boolean;
    peerFeatures: string[];
    peerDeviceId: string;
  };
  const p2pChannelExtras = () => ({ openedAt: 0, helloReceived: false, peerFeatures: ["messages"], peerDeviceId: "" });
  const P2P_HELLO_WAIT_MS = 5000;
  const p2pChannelsRef = useRef<Map<string, P2PChannel>>(new Map());
  // M1 (ревью): пересоздаваемый relay-only канал — живёт рядом со старым, пока не откроется;
  // старый закрывается только после открытия нового. Backoff неудачных пересозданий.
  const p2pRenewRef = useRef<Map<string, P2PChannel>>(new Map());
  // Старые relay-only каналы после renew: живут, пока по ним идут передачи файлов (или до credExpiresAt)
  const p2pRetiringRef = useRef<Map<P2PChannel, { peer: string; timer: ReturnType<typeof setInterval> }>>(new Map());
  const p2pRenewBackoffRef = useRef<Map<string, { next: number; delay: number }>>(new Map());
  // §3.3: чужой offer, отложенный невежливой стороной при свежем своём (пересмотр через ≤ 3 с, TTL 10 с)
  const p2pDeferredOffersRef = useRef<Map<string, { sdp: RTCSessionDescriptionInit; at: number; timer: ReturnType<typeof setTimeout> }>>(new Map());
  const p2pHandleOfferRef = useRef<((from: string, sdp: RTCSessionDescriptionInit, receivedAt?: number) => Promise<void>) | null>(null);
  const [p2pActivePeers, setP2PActivePeers] = useState<Set<string>>(new Set());
  // Если relay упал — пытаемся доставлять через P2P
  const [relayDown, setRelayDown] = useState(false);
  // P2P v2 §3.2: отметки отправленных p2p_offer (≤ 6 в минуту на номер, тишина на peer_offline-ответ)
  const p2pOfferTimesRef = useRef<Map<string, number[]>>(new Map());
  // P2P v2 §3.5: сообщения, ушедшие по DC без delivery_ack, — через 10 с повтор через relay тем же messageId
  const p2pAckWaitRef = useRef<Map<string, { peer: string; relayPayload: RelayOutbound; timer: ReturnType<typeof setTimeout> }>>(new Map());
  // Файловый движок (§4–5) объявлен ниже обработчиков DC — вызывается через ref (как handleIncomingEnvelopeRef)
  const p2pFileOpsRef = useRef<{
    onControl: (peer: string, ch: P2PChannel, data: Record<string, unknown>) => void;
    onFrame: (peer: string, ch: P2PChannel, bytes: Uint8Array) => void;
    onChannelReady: (peer: string) => void;
    onChannelClosed: (peer: string, ch: P2PChannel) => void;
    // peer_online / lookup_result.online: файлы «ожидают собеседника» — попытка сразу, без backoff
    onPeerOnline: (peer: string) => void;
    reset: () => void;
    // Отмена передачи (кнопка «Отменить», удаление сообщения); silent — без смены статуса пузыря
    cancel: (peer: string, messageId: string, silent?: boolean) => void;
    retry: (peer: string, messageId: string) => void;
  } | null>(null);
  // Обработчик кадров relay (ws.onmessage) — для событий, пришедших по DC (§3.7, fromNumber = peer)
  const relayFrameHandlerRef = useRef<((payload: RelayInbound, via: "relay" | "p2p") => Promise<void>) | null>(null);
  // Авто-старт канала по триггерам §3.2 (c)/(d) — startP2P объявлен ниже
  const p2pAutoStartRef = useRef<((peer: string) => void) | null>(null);
  // Постановка файла в очередь P2P (§5) — объявлена в P2P-секции ниже sendFile
  const enqueueP2PFileRef = useRef<((peer: string, messageId: string, file: File, declaredMime: string, sniffedMime: string) => void) | null>(null);
  // sendPeerEvent объявлен ниже эффектов, которым он нужен (скриншот)
  const sendPeerEventRef = useRef<(payload: RelayOutbound) => boolean>(() => false);
  // screenshot_alert: момент последнего по номеру — повтор за 2 с не показываем (старые iOS слали
  // два события на один скриншот, иногда одно по DC и одно по relay)
  const screenshotAlertAtRef = useRef<Map<string, number>>(new Map());

  // ── Key Verification ──
  const [showKeyVerification, setShowKeyVerification] = useState(false);
  // X-02 / S3: карта подтверждённых отпечатков текущего аккаунта (см. loadVerifiedKeys)
  const [verifiedKeys, setVerifiedKeys] = useState<Record<string, string>>(() => loadVerifiedKeys(storedNumber));
  const verifiedKeysRef = useRef(verifiedKeys);
  useEffect(() => { verifiedKeysRef.current = verifiedKeys; }, [verifiedKeys]);
  // S3: собеседники, у которых сменился ранее подтверждённый ключ (неблокирующий баннер в чате)
  const [keyChangedPeers, setKeyChangedPeers] = useState<Record<string, boolean>>({});
  // S9/P6: закреплённые identity-ключи собеседников (TOFU), ref — для синхронных проверок в обработчиках
  const [pinnedIdentity, setPinnedIdentity] = useState<Record<string, string[]>>(() => loadPinnedIdentity(storedNumber));
  const pinnedIdentityRef = useRef(pinnedIdentity);
  // P6/P7: последний подтверждённый пользователем identity-отпечаток (см. loadLastVerifiedIdentity)
  const [lastVerifiedIdentity, setLastVerifiedIdentity] = useState<Record<string, string>>(() => loadLastVerifiedIdentity(storedNumber));
  const lastVerifiedIdentityRef = useRef(lastVerifiedIdentity);
  // S9/P9: от номера уже приходил v2 (persist) и capabilities из последнего lookup_result (RAM)
  const peerEnv2Ref = useRef<Record<string, boolean>>(loadPeerEnv2(storedNumber));
  const peerCapsRef = useRef<Record<string, string[]>>({});
  // P9: «старый протокол» показываем не чаще раза за сессию на собеседника
  const downgradeWarnedRef = useRef<Set<string>>(new Set());
  // S10.1/Q16: от номера уже приходил meta1 (persist); даунгрейд meta1 → легаси — раз за сессию
  const [initialPeerMeta1] = useState(() => loadPeerMeta1(storedNumber));
  const peerMeta1Ref = useRef<Record<string, boolean>>(initialPeerMeta1);
  const meta1DowngradeWarnedRef = useRef<Set<string>>(new Set());
  // Q8: capabilities последнего lookup_result в state — для выбора safety number v1/v2 в UI
  const [peerCaps, setPeerCaps] = useState<Record<string, string[]>>({});
  // S10.3/Q7: блокирующее предупреждение о смене ключа и подтверждённые отпечатки
  const [keyAlerts, setKeyAlerts] = useState<Record<string, string>>(() => loadKeyAlerts(storedNumber));
  const keyAlertsRef = useRef(keyAlerts);
  useEffect(() => { keyAlertsRef.current = keyAlerts; }, [keyAlerts]);
  const [initialAckFp] = useState(() => loadAckFp(storedNumber));
  const ackFpRef = useRef<Record<string, string[]>>(initialAckFp);

  // ── Burn After Read (per-chat setting) ──
  const [chatBurnSettings, setChatBurnSettings] = useState<Record<string, boolean>>(() => {
    if (!storedNumber) return {};
    try { return JSON.parse(localStorage.getItem(accountKey(storedNumber, "burn_settings")) || "{}"); }
    catch { return {}; }
  });

  // ── Call state ──
  type CallState = "idle" | "calling" | "ringing" | "connected" | "reconnecting" | "failed";
  const [callState, setCallState] = useState<CallState>("idle");
  // Подготовка исходящего звонка (ожидание ключа собеседника): аккаунт не переключается
  const [callPreparing, setCallPreparing] = useState(false);
  const callPreparingRef = useRef(false);
  const [callPeer, setCallPeer] = useState("");
  const [callIsVideo, setCallIsVideo] = useState(false);
  const [callMuted, setCallMuted] = useState(false);
  const [callVideoEnabled, setCallVideoEnabled] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  // WEB-17: код звонка (SAS) из DTLS-отпечатков — сверяется голосом против MITM на relay
  const [callSasCode, setCallSasCode] = useState("");
  // P2P v2 §7.3: путь медиа звонка по getStats — "direct" | "turn" ("" — ещё не известен)
  const [callPath, setCallPath] = useState<"" | "direct" | "turn">("");
  const [peerMediaState, setPeerMediaState] = useState({ audio: true, video: false });
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const incomingSdpRef = useRef<RTCSessionDescriptionInit | null>(null);
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  // S10.5/Q10: callId текущего звонка (UUID инициатора; "" — у собеседника старый клиент)
  const callIdRef = useRef("");
  // Q10: событие с callId, отличным от callId активного звонка, игнорируется; без callId
  // (старый клиент) — проверка только по номеру (S4)
  const callIdMismatch = useCallback((id: unknown): boolean =>
    !!callIdRef.current && typeof id === "string" && id !== "" && id !== callIdRef.current, []);
  const withCallId = useCallback((payload: RelayOutbound): RelayOutbound =>
    (callIdRef.current ? { ...payload, callId: callIdRef.current } as RelayOutbound : payload), []);
  const remoteDescSetRef = useRef<boolean>(false);
  // CR-01: DTLS-отпечаток собеседника из его первого SDP в этом звонке (null — ещё нет / звонок завершён)
  const remoteDtlsFpRef = useRef<string | null>(null);
  // CR-01: отложенный cleanup после отказа пина (окно «Не удалось соединиться», 3 с)
  const pinFailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // WEB-19: никаких сторонних STUN по умолчанию — список ICE приходит только с relay
  // (/api/ice перед каждым звонком/P2P, /api/config при старте).
  const iceServersRef = useRef<RTCIceServer[]>([]);
  // Unix seconds at which the current TURN credential dies (0 = STUN only).
  const iceExpiresAtRef = useRef(0);
  const iceRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">("user");
  const iceRestartAttempts = useRef(0);
  const makingOfferRef = useRef(false);
  const iceDisconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoEnabledBeforeHiddenRef = useRef(false);
  const callPeerRef = useRef("");
  const callVideoEnabledRef = useRef(false);
  // Perfect negotiation (W3C): при коллизии offer'ов (glare: обе стороны одновременно шлют
  // ICE-рестарт/видео) уступает «вежливая» сторона — вызываемый; инициатор чужой offer в
  // состоянии have-local-offer игнорирует, собеседник откатит свой и ответит на наш.
  const isCallerRef = useRef(false);
  // Счётчик применённых offer'ов собеседника: рестарт, начатый до чужого offer (пока ждали
  // /api/ice), после него уже не нужен
  const remoteOfferSeqRef = useRef(0);
  const ringtoneRef = useRef<{ ctx: AudioContext; osc: OscillatorNode; gain: GainNode } | null>(null);

  // ── Voice recording ──
  const [isRecording, setIsRecording] = useState(false);
  // Микрофон, MediaRecorder и таймер ведёт VoiceRecorderBar: isRecording = «полоса записи открыта»;
  // сброс в false (выход, смена чата) размонтирует полосу и гасит треки микрофона.

  // ── Chat customization ──
  const [chatSettings, setChatSettings] = useState<Record<string, ChatSettings>>(() => {
    if (!storedNumber) return {};
    try { return JSON.parse(localStorage.getItem(accountKey(storedNumber, "chat_settings")) || "{}"); }
    catch { return {}; }
  });
  const [showCustomize, setShowCustomize] = useState(false);

  // ── Avatar upload ──
  const [avatars, setAvatars] = useState<Record<string, string>>(() => {
    if (!storedNumber) return {};
    try {
      const raw = JSON.parse(localStorage.getItem(accountKey(storedNumber, "avatars")) || "{}");
      // Sanitize on read — localStorage is trivially writable by any injected
      // script or browser extension, so we can't trust what's on disk.
      const out: Record<string, string> = {};
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          const safe = safeAvatar(v);
          if (safe) out[k] = safe;
        }
      }
      return out;
    } catch { return {}; }
  });
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // ── QR code ──
  const [showQr, setShowQr] = useState(false);
  const [qrLinkInput, setQrLinkInput] = useState("");
  const [showQrLinkInput, setShowQrLinkInput] = useState(false);

  // ── Multi-device sessions ──
  const [activeSessions, setActiveSessions] = useState<Array<{deviceId: string, platform: string, lastActive: number, current: boolean}>>([]);

  // ── Session replaced dialog ──
  const [showSessionReplacedDialog, setShowSessionReplacedDialog] = useState(false);

  // Refs
  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);
  const wsRef = useRef<WebSocket | null>(null);
  // Свой deviceId из session_ready — для отзыва своей сессии перед полным wipe
  const ownDeviceIdRef = useRef("");
  const revokeAckRef = useRef<(() => void) | null>(null);
  // Идёт полный wipe: закрытие 4401 после revoke_session — без тоста «Сессия истекла»
  const wipingRef = useRef(false);
  const keysRef = useRef<{ publicKey: string } | null>(null);
  const selfNumberRef = useRef(selfNumber);
  const activePeerRef = useRef(activePeer);
  const peerKeysRef = useRef(peerKeys);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Swipe gesture handlers
  const swipeStartRef = useRef<{ x: number; y: number; id: string } | null>(null);
  const [swipingMsgId, setSwipingMsgId] = useState<string | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);

  // Privacy settings ref for use in callbacks
  const privacyRef = useRef(privacySettings);
  useEffect(() => { privacyRef.current = privacySettings; }, [privacySettings]);
  // WEB-11: смена «Скрыть в сети» сразу уходит на relay (после register — см. "registered")
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "set_presence", hidden: privacySettings.hideOnline })); } catch { /* ignore */ }
    }
  }, [privacySettings.hideOnline]);

  const updatePrivacy = useCallback((update: Partial<typeof privacySettings>) => {
    setPrivacySettings(prev => {
      // p2pMigratedV2 всегда пишем: иначе миграция при входе вернёт выключенный пользователем P2P
      const next = { ...prev, ...update, p2pMigratedV2: true };
      if (selfNumberRef.current) localStorage.setItem(accountKey(selfNumberRef.current, "privacy"), JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => { selfNumberRef.current = selfNumber; }, [selfNumber]);
  useEffect(() => { activePeerRef.current = activePeer; }, [activePeer]);
  useEffect(() => { peerKeysRef.current = peerKeys; }, [peerKeys]);

  // Theme management
  useEffect(() => {
    const resolved = resolveTheme(themePreference);
    setResolvedTheme(resolved);
    applyBrandTheme(resolved);
    document.documentElement.setAttribute("data-theme", resolved);
    localStorage.setItem("phantom_theme", themePreference);
  }, [themePreference]);

  useEffect(() => {
    if (themePreference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => {
      const r = resolveTheme("system");
      setResolvedTheme(r);
      applyBrandTheme(r);
      document.documentElement.setAttribute("data-theme", r);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [themePreference]);

  const activeMessages = useMemo(() => messages[activePeer] || [], [messages, activePeer]);

  const filteredActiveMessages = useMemo(() => {
    if (!chatSearchQuery.trim()) return activeMessages;
    const q = chatSearchQuery.toLowerCase();
    return activeMessages.filter(m => m.text.toLowerCase().includes(q));
  }, [activeMessages, chatSearchQuery]);

  useEffect(() => {
    const el = messagesEndRef.current;
    const container = el?.parentElement;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
  }, [activeMessages]);

  useEffect(() => {
    const total = Object.values(unread).reduce((sum, n) => sum + n, 0);
    document.title = total > 0 ? `(${total}) ${BRAND.identity.name}` : BRAND.identity.name;
  }, [unread]);

  useEffect(() => {
    if (!relayError) return;
    // Bridge legacy `setRelayError("...")` calls into the new <ToastProvider>
    // so we keep one unified UI for transient errors. Heuristic: messages
    // with success-y wording are demoted to "info"; everything else is "error".
    const lower = relayError.toLowerCase();
    const isInfo = lower.includes("загрузка") /* "загрузка" */
      || lower.includes("подключение") /* "подключение" */;
    phantomToast(relayError, isInfo ? "info" : "error", 5000);
    setRelayError("");
  }, [relayError, phantomToast]);

  // Self-destruct timer
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setMessages(prev => {
        let changed = false;
        const updated: Record<string, ChatMessage[]> = {};
        for (const [peer, msgs] of Object.entries(prev)) {
          const filtered = msgs.filter(m => {
            if (m.selfDestructAt && m.selfDestructAt <= now) {
              changed = true;
              return false;
            }
            return true;
          });
          updated[peer] = filtered;
        }
        return changed ? updated : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Clean up typing indicators
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTypingPeers(prev => {
        const updated: Record<string, number> = {};
        let changed = false;
        for (const [key, ts] of Object.entries(prev)) {
          if (now - ts < 3000) {
            updated[key] = ts;
          } else {
            changed = true;
          }
        }
        return changed ? updated : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Keep call refs in sync with state (used inside ws.onmessage closure)
  useEffect(() => { callPeerRef.current = callPeer; }, [callPeer]);
  useEffect(() => { callVideoEnabledRef.current = callVideoEnabled; }, [callVideoEnabled]);

  // ── M2 (ревью): на старте мигрировать открытые PIN/panic-PIN ВСЕХ аккаунтов браузера ──
  useEffect(() => {
    const numbers = new Set<string>();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const m = /^phantom_(\d+)_(applock|panic)$/.exec(localStorage.key(i) || "");
        if (m) numbers.add(m[1]);
      }
    } catch { /* storage недоступен */ }
    for (const n of numbers) void migratePlainPins(localStorage, n).catch(() => {});
  }, []);

  // ── App Lock: миграция открытого PIN/panic-PIN старых версий в PBKDF2 (S10.7) ──
  // Блокировка не снимается до миграции: unlockApp сам дожидается migratePlainPins.
  useEffect(() => {
    if (!selfNumber) return;
    void migratePlainPins(localStorage, selfNumber).catch(() => {});
    setLockFail(readFailState(localStorage, selfNumber));
  }, [selfNumber]);

  // Настройки блокировки меняются в MenuPanel — перечитываем без перелогина (WEB-22)
  const [applockRev, setApplockRev] = useState(0);
  useEffect(() => {
    const onChange = () => setApplockRev(v => v + 1);
    window.addEventListener("phantom-applock-changed", onChange);
    return () => window.removeEventListener("phantom-applock-changed", onChange);
  }, []);

  // ── App Lock: Inactivity detection ──
  useEffect(() => {
    if (screen !== "messenger" || !selfNumber) return;
    const lockSettings = (() => {
      try { return JSON.parse(localStorage.getItem(accountKey(selfNumber, "applock")) || "{}"); }
      catch { return {}; }
    })();
    if (!lockSettings.enabled || !lockSettings.inactivityTimeout) return;

    const checkInactivity = () => {
      const elapsed = (Date.now() - lastActivityRef.current) / 1000;
      if (elapsed >= lockSettings.inactivityTimeout) {
        setAppLocked(true);
      }
    };
    const interval = setInterval(checkInactivity, 5000);
    const resetActivity = () => { lastActivityRef.current = Date.now(); };
    const events = ["mousemove", "keydown", "click", "pointerdown", "touchstart", "scroll"] as const;
    for (const ev of events) window.addEventListener(ev, resetActivity, { passive: true, capture: true });

    return () => {
      clearInterval(interval);
      for (const ev of events) window.removeEventListener(ev, resetActivity, { capture: true });
    };
  }, [screen, selfNumber, applockRev]);

  // ── Screenshot Detection ──
  useEffect(() => {
    if (screen !== "messenger" || !selfNumber) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // PrintScreen key
      if (e.key === "PrintScreen") {
        // Notify active peer
        // WEB-11: только если включено «Уведомления о скриншотах»
        // По умолчанию включено (паритет с Android); выключено только явным "0"
        let notifyOn = true;
        try { notifyOn = localStorage.getItem(accountKey(selfNumber, "notify_screenshots")) !== "0"; } catch { /* ignore */ }
        // P2P v2 §3.7: по DC (events_v1), иначе relay
        if (notifyOn && activePeer && activePeer !== SAVED_MESSAGES_KEY) {
          sendPeerEventRef.current({ type: "screenshot_alert", toNumber: activePeer });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [screen, selfNumber, activePeer]);

  // ── Save verifiedKeys to localStorage ──
  // Не пишем на экране входа: после logout/panic карта очищена, и запись `{}`
  // под старым номером стёрла бы подтверждения (а после panic — оставила бы след аккаунта).
  useEffect(() => {
    if (!selfNumber || screen === "login") return;
    localStorage.setItem(accountKey(selfNumber, "verified_keys"), JSON.stringify(verifiedKeys));
  }, [verifiedKeys, selfNumber, screen]);

  // ── Persist drafts (9.4) — sessionStorage survives F5, dies on tab close.
  //    Skip writes while logged out (screen === "login") so wipe() can't accidentally clear them.
  useEffect(() => {
    if (!selfNumber || screen === "login") return;
    const cleaned: Record<string, string> = {};
    for (const [peer, text] of Object.entries(drafts)) {
      if (text && text.trim()) cleaned[peer] = text;
    }
    sessionStorage.setItem(accountKey(selfNumber, "drafts"), JSON.stringify(cleaned));
  }, [drafts, selfNumber, screen]);

  // Chat list sorted by last message time
  const chatList = useMemo(() => {
    const peers = Object.keys(messages).filter(p => messages[p].length > 0);
    return peers.sort((a, b) => {
      const aLast = messages[a][messages[a].length - 1]?.createdAt || 0;
      const bLast = messages[b][messages[b].length - 1]?.createdAt || 0;
      return bLast - aLast;
    });
  }, [messages]);

  const filteredChatList = useMemo(() => {
    if (!searchQuery.trim()) return chatList;
    const q = searchQuery.toLowerCase();
    return chatList.filter(peer => {
      const name = contacts[peer] || "";
      return name.toLowerCase().includes(q) || formatNumber(peer).includes(q) || peer.includes(q);
    });
  }, [chatList, searchQuery, contacts]);

  const navigate = useCallback((nextScreen: Screen) => {
    const path = nextScreen === "login" ? "/" : `/${nextScreen}`;
    if (window.location.pathname !== path) window.history.replaceState({}, "", path);
    setScreen(nextScreen);
  }, []);

  // S4: согласие на P2P даёт только отправка, запущенная пользователем в этой
  // вкладке (текст/голос/файл/правка). Кадры relay (message_sync и т.п.) его не дают.
  const markSentTo = useCallback((peer: string) => {
    if (peer && peer !== SAVED_MESSAGES_KEY) sentToRef.current.add(peer);
  }, []);

  const appendMessage = useCallback((peer: string, message: ChatMessage) => {
    setMessages(prev => {
      const list = prev[peer] || [];
      // Дедуп по id: входящие хранятся под wire messageId — повтор после
      // reconnect или подделанный дубль не должен давать двойной рендер/ключи React.
      if (list.some(m => m.id === message.id)) return prev;
      return { ...prev, [peer]: [...list, message] };
    });
  }, []);


  const updateMessage = useCallback((peer: string, messageId: string, updates: Partial<ChatMessage>) => {
    setMessages(prev => {
      const msgs = prev[peer];
      if (!msgs) return prev;
      const idx = msgs.findIndex(m => m.id === messageId);
      if (idx === -1) return prev;
      const updated = [...msgs];
      updated[idx] = { ...updated[idx], ...updates };
      return { ...prev, [peer]: updated };
    });
  }, []);

  const sendRelay = useCallback((payload: RelayOutbound) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }, []);

  // CR-01: проверка перед каждым setRemoteDescription удалённого SDP звонка. Первый отпечаток
  // закрепляется, дальше принимается только совпадающий; иначе (или без отпечатка) — звонок
  // завершается как при failed ICE, отложенный offer выбрасывается, чтобы «Принять» его не применило.
  const acceptRemoteCallSdp = useCallback((peer: string, sdp: string | null | undefined): boolean => {
    const fp = acceptRemoteFingerprint(remoteDtlsFpRef.current, sdp);
    if (fp) { remoteDtlsFpRef.current = fp; return true; }
    slog.warn("[WebRTC] remote DTLS fingerprint changed");
    incomingSdpRef.current = null;
    sendRelay(withCallId({ type: "call_hangup", toNumber: peer }));
    setRelayError("Не удалось соединиться");
    setCallState("failed");
    if (pinFailTimerRef.current) clearTimeout(pinFailTimerRef.current);
    pinFailTimerRef.current = setTimeout(() => { pinFailTimerRef.current = null; cleanupCallRef.current(); }, 3000);
    return false;
  }, [sendRelay, withCallId]);

  // S1: lookup ключа собеседника с отметкой времени запроса (для троттлинга)
  const requestPeerLookup = useCallback((peer: string): boolean => {
    if (!peer || peer === SAVED_MESSAGES_KEY) return false;
    const ok = sendRelay({ type: "lookup", targetNumber: peer });
    if (ok) peerLookupSentAtRef.current[peer] = Date.now();
    return ok;
  }, [sendRelay]);

  // ── S10.6/Q11: локальный блок-лист ──
  const persistBlockList = useCallback((numbers: Iterable<string>, unblocked: Record<string, number>) => {
    const now = Date.now();
    const fresh: Record<string, number> = {};
    for (const [n, ts] of Object.entries(unblocked)) if (now - ts < UNBLOCK_TOMBSTONE_TTL_MS) fresh[n] = ts;
    const list = Array.from(new Set(numbers)).filter(n => !!normalizeNumber(n)).slice(0, 1000);
    blockListRef.current = { exists: true, numbers: list, unblocked: fresh };
    const me = selfNumberRef.current;
    if (me) safeSetJson(accountKey(me, "blocklist"), { v: 1, numbers: list, unblocked: fresh });
    setBlockedUsers(new Set(list));
  }, []);
  // После каждого успешного register: локальный список → relay (union + tombstones).
  // Первый запуск без локального списка — сначала get_blocked, ответ становится начальным списком.
  const syncBlockListAfterRegister = useCallback(() => {
    const bl = blockListRef.current;
    if (!bl.exists) {
      sendRelay({ type: "get_blocked" });
      return;
    }
    sendRelay({ type: "block_sync", numbers: bl.numbers.slice(0, 1000), unblocked: Object.keys(bl.unblocked).slice(0, 1000) });
  }, [sendRelay]);

  // S1: ключ для отправки. Нет ключа → lookup и ждём ≤5 с; ключ старше 5 мин →
  // lookup и ждём ≤1,5 с, затем шлём текущим (возможно уже обновлённым) ключом.
  // Ожидание lookup одно на peer: параллельные отправки ждут тот же promise и
  // продолжают в порядке вызова (реакции promise выполняются FIFO) — порядок сохраняется.
  const peerKeyWaitRef = useRef<Map<string, Promise<void>>>(new Map());
  const resolvePeerKey = useCallback(async (peer: string): Promise<string | undefined> => {
    const inflight = peerKeyWaitRef.current.get(peer);
    if (inflight) {
      await inflight;
      return peerKeysRef.current[peer];
    }
    const current = peerKeysRef.current[peer];
    const keyAt = peerKeyAtRef.current[peer] || 0;
    const now = Date.now();
    if (current && now - keyAt < PEER_KEY_MAX_AGE_MS) return current;
    // Старый ключ, а lookup недавно уже уходил (ответа нет/лимит) — не ждём повторно
    if (current && now - (peerLookupSentAtRef.current[peer] || 0) < PEER_KEY_LOOKUP_THROTTLE_MS) return current;
    if (!requestPeerLookup(peer)) return current;
    const sentAt = Date.now();
    const deadline = sentAt + (current ? PEER_KEY_WAIT_STALE_MS : PEER_KEY_WAIT_MISSING_MS);
    const wait = (async () => {
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
        if ((peerLookupReplyAtRef.current[peer] || 0) >= sentAt) break;
      }
    })().finally(() => { peerKeyWaitRef.current.delete(peer); });
    peerKeyWaitRef.current.set(peer, wait);
    await wait;
    return peerKeysRef.current[peer];
  }, [requestPeerLookup]);

  // S9/P9/P12: единая точка шифрования исходящих (текст/голос/файл/правка; P2P шлёт тот же blob).
  // v2 — если собеседник объявил "env2" в последнем lookup_result или уже присылал v2.
  // Ключ получателя — всегда из lookup_result (peerKey), никогда из входящих blob.
  const peerUsesV2 = useCallback((to: string): boolean =>
    (peerCapsRef.current[to] || []).includes("env2") || peerEnv2Ref.current[to] === true, []);
  // WEB-16 / mdev1: устройства собеседника из последнего lookup_result.
  const peerDevicesRef = useRef<Record<string, { deviceId: string; publicKey: string }[]>>({});
  // Копии сообщения (конверт v2) на ОСТАЛЬНЫЕ устройства собеседника. Только на ключи, уже
  // закреплённые TOFU-пином (устройство писало нам и прошло keyAlert) — иначе relay мог бы
  // подсунуть «устройство» со своим ключом и читать переписку. Копии добавляются, пока весь
  // кадр укладывается в лимит WS relay (256 КиБ): крупные вложения получат не все устройства.
  const buildDeviceBlobs = useCallback(async (
    peer: string, primaryKey: string, main: EncryptedBlob, encryptTo: (key: string) => Promise<EncryptedBlob>,
  ): Promise<Record<string, EncryptedBlob> | undefined> => {
    const devices = peerDevicesRef.current[peer] || [];
    const pins = pinnedIdentityRef.current[peer] || [];
    if (devices.length === 0 || pins.length === 0) return undefined;
    const FRAME_BUDGET = 230_000;
    let used = JSON.stringify(main).length + 512;
    const out: Record<string, EncryptedBlob> = {};
    for (const d of devices) {
      if (!d.publicKey || d.publicKey === primaryKey) continue;
      const fp = await keyFingerprint(d.publicKey).catch(() => null);
      if (!fp || !pins.includes(fp)) continue;
      try {
        const copy = await encryptTo(d.publicKey);
        const size = JSON.stringify(copy).length + d.deviceId.length + 8;
        if (used + size > FRAME_BUDGET) break;
        used += size;
        out[d.deviceId] = copy;
      } catch { /* устройство с битым ключом пропускаем */ }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }, []);

  const encryptForPeer = useCallback(async (text: string, from: string, to: string, peerKey: string): Promise<EncryptedBlob> => {
    return encrypt(text, from, to, peerKey, peerUsesV2(to) ? { version: 2, keyNumber: from } : undefined);
  }, [peerUsesV2]);
  // S10.1: формат meta1 — если для собеседника выбран v2 (P9) И (lookup_result объявил "meta1"
  // ИЛИ от номера уже приходил meta1). Иначе — прежний формат без изменений.
  const peerUsesMeta1 = useCallback((to: string): boolean =>
    peerUsesV2(to) && ((peerCapsRef.current[to] || []).includes("meta1") || peerMeta1Ref.current[to] === true), [peerUsesV2]);

  // ── S10.3/Q7: блокирующее предупреждение о смене ключа ──
  const persistKeyAlertState = useCallback(() => {
    const me = selfNumberRef.current;
    if (!me) return;
    safeSetJson(accountKey(me, "key_alert"), keyAlertsRef.current);
    safeSetJson(accountKey(me, "key_ack"), ackFpRef.current);
  }, []);
  // Взводится по (а) новый пин при непустом множестве и (в) снятие verified из-за смены ключа.
  // Не взводится, если отпечаток уже подтверждён «Продолжить» (ackFp) или проверен (lastVerified).
  const raiseKeyAlert = useCallback((peer: string, fp: string | null | undefined) => {
    if (!peer || !fp || peer === SAVED_MESSAGES_KEY || peer === selfNumberRef.current) return;
    if ((ackFpRef.current[peer] || []).includes(fp) || lastVerifiedIdentityRef.current[peer] === fp) return;
    if (keyAlertsRef.current[peer] === fp) return;
    keyAlertsRef.current = { ...keyAlertsRef.current, [peer]: fp };
    setKeyAlerts(keyAlertsRef.current);
    persistKeyAlertState();
  }, [persistKeyAlertState]);
  const clearKeyAlert = useCallback((peer: string, ackFps: Array<string | null | undefined>) => {
    const add = ackFps.filter((fp): fp is string => !!fp && /^[0-9a-f]{32}$/.test(fp));
    if (add.length) {
      const prev = ackFpRef.current[peer] || [];
      const next = [...prev.filter(x => !add.includes(x)), ...add].slice(-PINNED_IDENTITY_MAX);
      ackFpRef.current = { ...ackFpRef.current, [peer]: next };
    }
    if (keyAlertsRef.current[peer]) {
      const next = { ...keyAlertsRef.current };
      delete next[peer];
      keyAlertsRef.current = next;
      setKeyAlerts(next);
    }
    persistKeyAlertState();
  }, [persistKeyAlertState]);
  // «Продолжить»: снять alert и запомнить отпечаток текущего ключа из lookup (и того, что взвёл alert)
  const acknowledgeKeyAlert = useCallback(async (peer: string) => {
    const me = selfNumberRef.current;
    const lookupKey = peerKeysRef.current[peer];
    const fp = lookupKey ? await keyFingerprint(lookupKey).catch(() => null) : null;
    if (selfNumberRef.current !== me) return;
    clearKeyAlert(peer, [keyAlertsRef.current[peer], fp]);
  }, [clearKeyAlert]);
  // Единый гейт пользовательского контента: relay, P2P и исходящий звонок (receipts/typing — нет)
  const canSendTo = useCallback((peer: string): boolean => {
    if (!peer || peer === SAVED_MESSAGES_KEY || peer === selfNumberRef.current) return true;
    return !keyAlertsRef.current[peer];
  }, []);
  // H1 (ревью): взвод (в) в lookup_result асинхронный — поэтому ПОСЛЕ resolvePeerKey и ДО
  // шифрования синхронно сверяем отпечаток ключа, на который будем шифровать, с подтверждённым.
  // Не совпал (и не подтверждён «Продолжить»/сверкой) → alert, ничего не шифруем и не шлём.
  const ensurePeerKeyTrusted = useCallback(async (peer: string, peerKey: string): Promise<boolean> => {
    if (!peer || peer === SAVED_MESSAGES_KEY || peer === selfNumberRef.current) return true;
    if (!canSendTo(peer)) return false;
    const me = selfNumberRef.current;
    // L-b: эталон — подтверждённый отпечаток, а если verified уже снят асинхронной веткой
    // lookup_result — последний проверенный пользователем (lastVerifiedIdentity)
    const verifiedFp = verifiedKeysRef.current[peer] || lastVerifiedIdentityRef.current[peer];
    if (verifiedFp) {
      const fp = await keyFingerprint(peerKey).catch(() => null);
      if (!fp || selfNumberRef.current !== me) return false;
      if (fp !== verifiedFp && !(ackFpRef.current[peer] || []).includes(fp) && lastVerifiedIdentityRef.current[peer] !== fp) {
        raiseKeyAlert(peer, fp);
        return false;
      }
    }
    return canSendTo(peer);
  }, [canSendTo, raiseKeyAlert]);

  // ── P2P v2 §3.5: выбор транспорта ──
  // kind: "message" — текст/голос; "event" — edit/delete/reaction/burn/screenshot; "receipt" —
  // квитанции и typing (к ним canSendTo не применяется, Q7).
  type P2PKind = "message" | "event" | "receipt";
  const p2pChannelReady = (ch: P2PChannel | undefined): boolean =>
    !!ch && ch.state === "open" && ch.dc?.readyState === "open"
    && (ch.helloReceived || (ch.openedAt > 0 && Date.now() - ch.openedAt > P2P_HELLO_WAIT_MS));
  const pickTransport = useCallback((peer: string, kind: P2PKind): "p2p" | "relay" => {
    if (!peer || peer === SAVED_MESSAGES_KEY || peer === selfNumberRef.current) return "relay";
    if (!privacyRef.current.p2pFallback || blockedUsersRef.current.has(peer)) return "relay";
    const ch = p2pChannelsRef.current.get(peer);
    if (!ch || !p2pChannelReady(ch)) return "relay";
    if (kind !== "receipt" && !canSendTo(peer)) return "relay";
    // §3.6: у собеседника > 1 устройства — relay с deviceBlobs (получат все устройства)
    if ((peerDevicesRef.current[peer] || []).length > 1) return "relay";
    return ch.peerFeatures.includes(kind === "message" ? "messages" : "events_v1") ? "p2p" : "relay";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSendTo]);

  // JSON-кадр в открытый основной канал собеседника (≤ 256 КиБ)
  const p2pSendJson = useCallback((peer: string, obj: Record<string, unknown>): boolean => {
    const ch = p2pChannelsRef.current.get(peer);
    if (!ch?.dc || ch.state !== "open" || ch.dc.readyState !== "open") return false;
    try {
      const json = JSON.stringify(obj);
      if (json.length > P2P_MAX_DC_MESSAGE) return false;
      ch.dc.send(json);
      return true;
    } catch (err) {
      slog.warn("[P2P] send failed:", (err as Error)?.name);
      return false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // §3.7: события собеседнику — по DC (events_v1), иначе relay
  const sendPeerEvent = useCallback((payload: RelayOutbound): boolean => {
    const peer = (payload as { toNumber?: string }).toNumber || "";
    if (peer && P2P_EVENT_TYPES.has(payload.type)) {
      const kind: P2PKind = payload.type === "typing" || payload.type === "read_receipt" || payload.type === "delivery_receipt" ? "receipt" : "event";
      if (pickTransport(peer, kind) === "p2p") {
        const frame: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
        delete frame.toNumber;
        delete frame.deviceBlobs;
        if (p2pSendJson(peer, frame)) {
          // Идемпотентные события без ack: дублируем через relay, чтобы «удалить у всех»/правка
          // не потерялись, если канал закроется до отправки буфера. Приём безвреден при повторе
          // (фильтр по id / тот же текст / удаление уже удалённого).
          if (P2P_EVENT_RELAY_DUP.has(payload.type)) sendRelay(payload);
          return true;
        }
      }
    }
    return sendRelay(payload);
  }, [pickTransport, p2pSendJson, sendRelay]);
  sendPeerEventRef.current = sendPeerEvent;

  const clearP2PAckWait = useCallback((messageId: string, from?: string) => {
    const w = p2pAckWaitRef.current.get(messageId);
    if (!w) return;
    if (from !== undefined && w.peer !== from) return;
    clearTimeout(w.timer);
    p2pAckWaitRef.current.delete(messageId);
  }, []);
  // §3.5: нет delivery_ack за 10 с — повтор через relay тем же messageId (relay недоступен — ещё раз позже)
  const armP2PAckWait = useCallback((peer: string, messageId: string, relayPayload: RelayOutbound, attempt = 0) => {
    const prev = p2pAckWaitRef.current.get(messageId);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      const w = p2pAckWaitRef.current.get(messageId);
      if (!w || w.timer !== timer) return;
      p2pAckWaitRef.current.delete(messageId);
      if (!sendRelay(relayPayload)) {
        if (attempt < 30) armP2PAckWait(peer, messageId, relayPayload, attempt + 1);
        else {
          // 30 неудачных повторов — помечаем сообщение как неотправленное
          setMessages(prev => {
            const list = prev[peer];
            const idx = list ? list.findIndex(m => m.id === messageId && m.direction === "out") : -1;
            if (!list || idx === -1 || list[idx].status === "delivered" || list[idx].status === "read") return prev;
            const updated = [...list];
            updated[idx] = { ...updated[idx], failed: true };
            return { ...prev, [peer]: updated };
          });
        }
      }
    }, P2P_ACK_TIMEOUT_MS);
    p2pAckWaitRef.current.set(messageId, { peer, relayPayload, timer });
  }, [sendRelay]);
  // Канал закрылся до delivery_ack — сразу через relay
  const flushP2PAckWaits = useCallback((peer: string) => {
    for (const [messageId, w] of [...p2pAckWaitRef.current.entries()]) {
      if (w.peer !== peer) continue;
      clearTimeout(w.timer);
      p2pAckWaitRef.current.delete(messageId);
      if (!sendRelay(w.relayPayload)) armP2PAckWait(peer, messageId, w.relayPayload, 1);
    }
  }, [sendRelay, armP2PAckWait]);

  // §3.5: текст/голос — DC при canP2P (sent при dc.send, delivered по delivery_ack), иначе relay;
  // relay недоступен — любой открытый DC (прежний auto-fallback). Транспорт или null — не отправлено.
  const sendPeerMessage = useCallback((
    peer: string, messageId: string, relayPayload: RelayOutbound, dcFrame: Record<string, unknown>,
  ): "p2p" | "relay" | null => {
    if (pickTransport(peer, "message") === "p2p" && p2pSendJson(peer, dcFrame)) {
      armP2PAckWait(peer, messageId, relayPayload);
      return "p2p";
    }
    if (sendRelay(relayPayload)) return "relay";
    if (canSendTo(peer) && privacyRef.current.p2pFallback && !blockedUsersRef.current.has(peer) && p2pSendJson(peer, dcFrame)) {
      armP2PAckWait(peer, messageId, relayPayload);
      return "p2p";
    }
    return null;
  }, [pickTransport, p2pSendJson, armP2PAckWait, sendRelay, canSendTo]);

  // §3.5: дедуп входящих по messageId для обоих транспортов (DC + повтор через relay)
  const seenIncomingRef = useRef<Map<string, true>>(new Map());
  const markSeenIncoming = useCallback((from: string, messageId: string): boolean => {
    const k = `${from}\u0000${messageId}`;
    const seen = seenIncomingRef.current;
    if (seen.has(k)) return true;
    seen.set(k, true);
    if (seen.size > 5000) { const first = seen.keys().next().value; if (first !== undefined) seen.delete(first); }
    return false;
  }, []);

  // P7 (уточнение): пользователь нажал «проверено» — запоминаем отпечаток текущего ключа lookup
  const markIdentityVerified = useCallback((peer: string, fp: string) => {
    if (!peer || !/^[0-9a-f]{32}$/.test(fp)) return;
    if (lastVerifiedIdentityRef.current[peer] === fp) return;
    lastVerifiedIdentityRef.current = { ...lastVerifiedIdentityRef.current, [peer]: fp };
    setLastVerifiedIdentity(lastVerifiedIdentityRef.current);
    const me = selfNumberRef.current;
    if (me) safeSetJson(accountKey(me, "last_verified_identity"), lastVerifiedIdentityRef.current);
  }, []);

  // Ручное «Снять проверку»: снимается и lastVerifiedIdentity — гейт ensurePeerKeyTrusted
  // и баннер «отличается от проверенного» больше не опираются на снятую проверку (Q7(б))
  const unmarkIdentityVerified = useCallback((peer: string) => {
    if (!peer || !lastVerifiedIdentityRef.current[peer]) return;
    const next = { ...lastVerifiedIdentityRef.current };
    delete next[peer];
    lastVerifiedIdentityRef.current = next;
    setLastVerifiedIdentity(next);
    const me = selfNumberRef.current;
    if (me) safeSetJson(accountKey(me, "last_verified_identity"), next);
  }, []);

  // Системное уведомление клиента в ленте чата (S9) — не сообщение собеседника
  const appendSystemNotice = useCallback((peer: string, text: string) => {
    appendMessage(peer, {
      id: `sys-${nowId()}`, from: peer, to: selfNumberRef.current,
      text, createdAt: Date.now(), direction: "in", status: "read", system: true,
    });
  }, [appendMessage]);

  // S9/P6/P9: вызывается ТОЛЬКО после успешной расшифровки входящего от собеседника
  // (GCM-тег прошёл → senderIdentityKey аутентичен). P8: не вызывать для message_sync,
  // from == self и сообщений с маркером _meshBridge.
  const noteIncomingEnvelope = useCallback(async (from: string, blob: EncryptedBlob | undefined) => {
    const me = selfNumberRef.current;
    if (!blob || !from || from === me || from === SAVED_MESSAGES_KEY) return;
    if (blob.version === 2 && typeof blob.senderIdentityKey === "string") {
      if (!peerEnv2Ref.current[from]) {
        peerEnv2Ref.current = { ...peerEnv2Ref.current, [from]: true };
        if (me) safeSetJson(accountKey(me, "peer_env2"), peerEnv2Ref.current);
      }
      const fp = await keyFingerprint(blob.senderIdentityKey).catch(() => null);
      if (!fp || selfNumberRef.current !== me) return;
      const pins = pinnedIdentityRef.current[from] || [];
      const lastVerifiedFp = lastVerifiedIdentityRef.current[from];
      // lastVerifiedIdentity считается членом множества пинов, даже если его там нет
      if (pins.includes(fp) || fp === lastVerifiedFp) return;
      // P6 (уточнение): при FIFO-вытеснении никогда не вытесняем отпечаток, совпадающий с
      // verifiedKeys[from] или lastVerifiedIdentity[from] — иначе поток поддельных v2 от relay
      // «вымыл» бы проверенный ключ. Вытесняется самый старый из остальных.
      const verifiedFp = verifiedKeysRef.current[from];
      const nextPins = [...pins, fp];
      while (nextPins.length > PINNED_IDENTITY_MAX) {
        const evict = nextPins.findIndex(x => x !== verifiedFp && x !== lastVerifiedFp);
        if (evict < 0) break;
        nextPins.splice(evict, 1);
      }
      pinnedIdentityRef.current = { ...pinnedIdentityRef.current, [from]: nextPins };
      setPinnedIdentity(pinnedIdentityRef.current);
      if (me) safeSetJson(accountKey(me, "pinned_identity"), pinnedIdentityRef.current);
      // Первый пин — TOFU молча (S9.4 п.1); новый ключ при непустом множестве — P6
      if (pins.length === 0) return;
      setVerifiedKeys(prev => {
        if (!prev[from]) return prev;
        const next = { ...prev };
        delete next[from];
        return next;
      });
      appendSystemNotice(from, IDENTITY_CHANGED_TEXT);
      // Q7 (а): новый identity-ключ при уже непустом множестве пинов — отправка блокируется
      raiseKeyAlert(from, fp);
      requestPeerLookup(from);
      return;
    }
    // P9: v1 от номера, который уже присылал v2 — однократно за сессию
    if (peerEnv2Ref.current[from] && !downgradeWarnedRef.current.has(from)) {
      downgradeWarnedRef.current.add(from);
      appendSystemNotice(from, OLD_PROTOCOL_TEXT);
    }
  }, [appendSystemNotice, raiseKeyAlert, requestPeerLookup]);

  // S10.1/Q16: учёт формата расшифрованного контента от собеседника. P8: не для
  // message_sync, from == self и _meshBridge (вызывающий не зовёт для них).
  const notePayloadFormat = useCallback((from: string, meta1: boolean) => {
    const me = selfNumberRef.current;
    if (!from || from === me || from === SAVED_MESSAGES_KEY) return;
    if (meta1) {
      if (!peerMeta1Ref.current[from]) {
        peerMeta1Ref.current = { ...peerMeta1Ref.current, [from]: true };
        if (me) safeSetJson(accountKey(me, "peer_meta1"), peerMeta1Ref.current);
      }
      return;
    }
    if (peerMeta1Ref.current[from] && !meta1DowngradeWarnedRef.current.has(from)) {
      meta1DowngradeWarnedRef.current.add(from);
      appendSystemNotice(from, META1_DOWNGRADE_TEXT);
    }
  }, [appendSystemNotice]);

  // Q13: при включённой блокировке уведомления — без текста и без номера
  const notifyIncoming = useCallback((from: string, text: string, kind: "text" | "file" | "voice") => {
    let generic = false;
    try {
      generic = JSON.parse(localStorage.getItem(accountKey(selfNumberRef.current, "applock")) || "{}")?.enabled === true;
    } catch { generic = false; }
    showBrowserNotification(from, text, kind, generic, selfNumberRef.current);
  }, []);

  // ── S10.1 / Q1: ЕДИНЫЙ диспетчер расшифрованного контента собеседника ──
  // Вызывается для relay `message`, `message_edited`, `reaction` (с encryptedBlob) и P2P
  // DataChannel. NUL → meta1 (lib/meta1.ts: Q3 k↔тип, Q4 id/target = внешний messageId,
  // Q5 валидация), без NUL → легаси по внешнему типу. Легаси file_message/voice_message
  // обрабатываются отдельно (как раньше). Возвращает id показанного пузыря (для receipts) или null.
  type IncomingEnvelope = {
    from: string;
    outerType: "message" | "message_edited" | "reaction";
    messageId: string;
    blob: EncryptedBlob;
    timestamp?: number;
    legacy?: { replyTo?: unknown; forwardFrom?: string; selfDestruct?: number | "read" };
    via: "relay" | "p2p";
    meshBridge?: boolean;
  };
  const handleIncomingEnvelope = useCallback(async (env: IncomingEnvelope): Promise<string | null> => {
    const me = selfNumberRef.current;
    const { from, outerType, blob } = env;
    if (!from || !me || from === me || from === SAVED_MESSAGES_KEY || !blob || typeof blob !== "object") return null;
    // Defense-in-depth: офлайн-очередь relay приходит сразу после registered, раньше ответа на
    // block_sync — контент от номера из ЛОКАЛЬНОГО блок-листа молча отбрасывается
    if (blockListRef.current.numbers.includes(from)) return null;

    const applyEdit = (id: string, text: string) => {
      setMessages(prev => {
        const list = prev[from];
        if (!list) return prev;
        // Править можно только входящие сообщения этого собеседника
        const idx = list.findIndex(m => m.id === id && m.direction === "in" && !m.system);
        if (idx === -1) return prev;
        const updated = [...list];
        updated[idx] = { ...updated[idx], text, edited: true, editedAt: env.timestamp || Date.now() };
        return { ...prev, [from]: updated };
      });
    };
    const applyReaction = (target: string, emoji: string, remove: boolean) => {
      setMessages(prev => {
        const msgs = prev[from];
        if (!msgs) return prev;
        const idx = msgs.findIndex(m => m.id === target);
        if (idx === -1) return prev;
        const updated = [...msgs];
        const msg = { ...updated[idx] };
        const reactions = [...(msg.reactions || [])];
        if (remove) {
          const ri = reactions.findIndex(r => r.from === from && r.emoji === emoji);
          if (ri !== -1) reactions.splice(ri, 1);
        } else {
          reactions.push({ emoji, from, timestamp: env.timestamp || Date.now() });
        }
        msg.reactions = reactions;
        updated[idx] = msg;
        return { ...prev, [from]: updated };
      });
    };
    const showBubble = (fields: Partial<ChatMessage> & { text: string }, sd: number | "read" | undefined, kind: "text" | "file" | "voice"): string => {
      const id = env.messageId || nowId();
      const isBurn = sd === "read";
      const now = Date.now();
      // P2P v2 §3.5: дубль (DC + повтор через relay тем же messageId) — без второго пузыря и
      // уведомления; квитанции отправляются снова (первая могла потеряться)
      const dup = !!env.messageId && markSeenIncoming(from, env.messageId);
      if (!dup) {
        appendMessage(from, {
          id, from, to: me, createdAt: now, direction: "in", status: "delivered",
          selfDestruct: isBurn ? undefined : sd,
          selfDestructAt: (typeof sd === "number" && sd > 0) ? now + sd * 1000 : undefined,
          burnAfterRead: isBurn || undefined,
          transport: env.via,
          ...fields,
        });
        // WEB-13: текст burn-сообщения не попадает и в уведомление
        notifyIncoming(from, isBurn ? "\uD83D\uDD25" : (kind === "file" ? (fields.text || "") : fields.text), kind);
        if (activePeerRef.current !== from) {
          setUnread(prev => ({ ...prev, [from]: (prev[from] || 0) + 1 }));
        }
      }
      // По DC «доставлено» — delivery_ack (его шлёт обработчик DC); квитанции — по выбранному транспорту
      if (env.via === "relay") sendPeerEvent({ type: "delivery_receipt", toNumber: from, messageIds: [id] });
      if (activePeerRef.current === from && !privacyRef.current.disableReadReceipts) {
        sendPeerEvent({ type: "read_receipt", toNumber: from, messageIds: [id] });
      }
      return id;
    };

    let pt: string | null = null;
    let unsupported = false;
    try {
      // X-01 / S1: эфемерный ключ из blob — только для расшифровки этого сообщения (в SW)
      pt = await decrypt(blob, from, me);
      // S9: TOFU / даунгрейд — только после успешной расшифровки; P8: не для mesh-bridge
      if (!env.meshBridge) await noteIncomingEnvelope(from, blob);
    } catch (e) {
      unsupported = isUnsupportedVersionError(e);
    }
    if (selfNumberRef.current !== me) return null;

    if (pt === null) {
      // P3: версия ≥ 3 — заглушка; иначе как раньше: relay — «не удалось расшифровать»,
      // P2P — отбросить, правка — оставить старый текст, реакция — игнор
      if (outerType === "message" && (unsupported || env.via === "relay")) {
        return showBubble({ text: unsupported ? UNSUPPORTED_VERSION_TEXT : DECRYPT_FAILED_TEXT }, undefined, "text");
      }
      if (outerType === "message_edited" && unsupported) applyEdit(env.messageId, UNSUPPORTED_VERSION_TEXT);
      return null;
    }

    const outcome: Meta1Outcome = parseMeta1(pt, outerType, env.messageId);
    // Q19: peerMeta1 — при ЛЮБОМ NUL-payload, прошедшем GCM (включая drop/invalid)
    if (!env.meshBridge) notePayloadFormat(from, isMeta1Plaintext(pt));
    if (outcome.action !== "legacy" && outcome.action !== "show" && outcome.action !== "edit" && outcome.action !== "reaction") {
      slog.warn("[meta1] payload rejected:", outcome.action, "reason" in outcome ? outcome.reason : "");
    }

    if (outerType === "message") {
      if (outcome.action === "legacy") {
        const lg = env.legacy || {};
        const sd = lg.selfDestruct === "read" || (typeof lg.selfDestruct === "number" && lg.selfDestruct > 0) ? lg.selfDestruct : undefined;
        return showBubble({
          text: pt, replyTo: normalizeReplyRef(lg.replyTo),
          // WEB-09: легаси-конверт — forwardFrom только как валидный номер
          forwardFrom: typeof lg.forwardFrom === "string" && /^[0-9A-Za-z+_-]{1,64}$/.test(lg.forwardFrom) ? lg.forwardFrom : undefined,
        }, sd, "text");
      }
      if (outcome.action === "invalid") return showBubble({ text: INVALID_MESSAGE_TEXT }, undefined, "text");
      if (outcome.action !== "show") return null;
      const c = outcome.content;
      const common: Partial<ChatMessage> = { replyTo: normalizeReplyRef(c.replyTo), forwardFrom: c.fwd };
      if (c.k === "text") return showBubble({ ...common, text: c.text }, c.sd, "text");
      if (c.k === "file") {
        return showBubble({
          ...common,
          text: `[\u0424\u0430\u0439\u043B: ${c.name}]`,
          fileName: c.name, fileSize: c.size, mimeType: c.mime, fileData: `data:${c.mime};base64,${c.data}`,
        }, c.sd, "file");
      }
      const durSec = Math.round(c.durMs / 1000);
      return showBubble({
        ...common,
        text: `[\u0413\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 ${durSec}\u0441]`,
        isVoice: true, duration: durSec, voiceData: c.data, mimeType: c.mime,
        voiceDurMs: c.durMs, voiceWave: c.wave,
      }, c.sd, "voice");
    }
    if (outerType === "message_edited") {
      if (outcome.action === "legacy") applyEdit(env.messageId, pt);
      else if (outcome.action === "edit") applyEdit(outcome.id, outcome.text);
      return null;
    }
    // outerType === "reaction"
    if (outcome.action === "reaction") applyReaction(outcome.target, outcome.emoji, outcome.remove);
    return null;
  }, [appendMessage, noteIncomingEnvelope, notePayloadFormat, notifyIncoming, sendPeerEvent, markSeenIncoming]);
  const handleIncomingEnvelopeRef = useRef(handleIncomingEnvelope);
  handleIncomingEnvelopeRef.current = handleIncomingEnvelope;


  const saveContact = useCallback((number: string, name: string) => {
    setContacts(prev => {
      const updated = { ...prev, [number]: name };
      if (selfNumberRef.current) localStorage.setItem(accountKey(selfNumberRef.current, "contacts"), JSON.stringify(updated));
      return updated;
    });
  }, []);

  const removeContact = useCallback((number: string) => {
    setContacts(prev => {
      const updated = { ...prev };
      delete updated[number];
      if (selfNumberRef.current) localStorage.setItem(accountKey(selfNumberRef.current, "contacts"), JSON.stringify(updated));
      return updated;
    });
  }, []);

  const saveChatSetting = useCallback((peer: string, settings: ChatSettings) => {
    setChatSettings(prev => {
      const updated = { ...prev, [peer]: { ...(prev[peer] || {}), ...settings } };
      if (selfNumberRef.current) localStorage.setItem(accountKey(selfNumberRef.current, "chat_settings"), JSON.stringify(updated));
      return updated;
    });
    // S10.1: настройки чата (цвет/обои) хранятся только локально — на relay не отправляются
  }, []);

  const handleDeleteMessage = useCallback((msgId: string) => {
    setMessages(prev => {
      const updated = { ...prev };
      for (const peer of Object.keys(updated)) {
        updated[peer] = updated[peer].filter(m => m.id !== msgId);
      }
      return updated;
    });
  }, []);

  const saveToSavedMessages = useCallback((msg: ChatMessage) => {
    appendMessage(SAVED_MESSAGES_KEY, {
      ...msg,
      // P2P v2: состояние передачи — только у исходного пузыря
      transferState: undefined, progress: undefined, transferNote: undefined, fileId: undefined, transport: undefined,
      id: nowId(),
      to: SAVED_MESSAGES_KEY,
      direction: "in",
      createdAt: Date.now(),
    });
  }, [appendMessage]);

  const handleAvatarUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      phantomToast("\u041C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u0440\u0430\u0437\u043C\u0435\u0440 \u0430\u0432\u0430\u0442\u0430\u0440\u0430: 2 \u041C\u0411", "warning");
      return;
    }
    try {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.src = url;
      await new Promise(r => { img.onload = r; });
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, 128, 128);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);

      const keys = keysRef.current;
      if (keys) {
        setAvatars(prev => {
          const updated = { ...prev, [selfNumber]: dataUrl };
          if (selfNumberRef.current) safeSetJson(accountKey(selfNumberRef.current, "avatars"), updated);
          return updated;
        });
        // P9: relay перезаписывает capabilities при каждом register — передаём всегда
        sendRelay({ type: "register", publicKey: keys.publicKey, capabilities: CLIENT_CAPABILITIES });
        phantomToast("\u0410\u0432\u0430\u0442\u0430\u0440 \u043E\u0431\u043D\u043E\u0432\u043B\u0451\u043D", "success");
      }
    } catch {
      phantomToast("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0430\u0432\u0430\u0442\u0430\u0440", "error");
    }
  }, [selfNumber, sendRelay, phantomToast]);

  // Мультиаккаунт: RAM-состояние аккаунта `n` из localStorage/sessionStorage — то же, что при входе
  // по коду. Вызывается в одном батче с setSelfNumber(n): persist-эффекты не должны успеть записать
  // чужое состояние под ключ `n`.
  const loadAccountState = useCallback((n: string) => {
    try { setContacts(JSON.parse(localStorage.getItem(accountKey(n, "contacts")) || "{}")); } catch { setContacts({}); }
    try { setAvatars(JSON.parse(localStorage.getItem(accountKey(n, "avatars")) || "{}")); } catch { setAvatars({}); }
    try { setChatSettings(JSON.parse(localStorage.getItem(accountKey(n, "chat_settings")) || "{}")); } catch { setChatSettings({}); }
    try { setChatBurnSettings(JSON.parse(localStorage.getItem(accountKey(n, "burn_settings")) || "{}")); } catch { setChatBurnSettings({}); }
    try { setDrafts(JSON.parse(sessionStorage.getItem(accountKey(n, "drafts")) || "{}")); } catch { setDrafts({}); }
    setVerifiedKeys(loadVerifiedKeys(n));
    pinnedIdentityRef.current = loadPinnedIdentity(n);
    setPinnedIdentity(pinnedIdentityRef.current);
    lastVerifiedIdentityRef.current = loadLastVerifiedIdentity(n);
    setLastVerifiedIdentity(lastVerifiedIdentityRef.current);
    peerEnv2Ref.current = loadPeerEnv2(n);
    peerCapsRef.current = {};
    setPeerCaps({});
    downgradeWarnedRef.current = new Set();
    // S10: per-account состояние нового входа (meta1, блок-лист, keyAlert, приватность, счётчик PIN)
    peerMeta1Ref.current = loadPeerMeta1(n);
    meta1DowngradeWarnedRef.current = new Set();
    keyAlertsRef.current = loadKeyAlerts(n);
    setKeyAlerts(keyAlertsRef.current);
    ackFpRef.current = loadAckFp(n);
    blockListRef.current = loadBlockList(n);
    setBlockedUsers(new Set(blockListRef.current.numbers));
    setPrivacySettings(loadPrivacySettings(n));
    setLockFail(readFailState(localStorage, n));
    setShowPrivacyNotice(localStorage.getItem(accountKey(n, "privacy_seen")) !== "1");
  }, []);

  // Мультиаккаунт: сделать `n` активным (токен уже в lib/token.ts) и подключиться как он.
  // Подключение — обычный путь: смена token/selfNumber пересоздаёт WS-эффект и запрос ключа
  // (loadOrCreateKeys(n)), затем register → block_sync → set_profile.
  // `honorLock` — переключение на аккаунт с включённой блокировкой требует его PIN, как после F5.
  const enterAccount = useCallback((n: string, opts?: { honorLock?: boolean }): boolean => {
    if (!activateAccount(n)) return false;
    loadAccountState(n);
    setAppLocked(opts?.honorLock ? accountHasLock(n) : false);
    setAppLockPin("");
    lastActivityRef.current = Date.now();
    setToken(getToken());
    setSelfNumber(n);
    setAddingAccount(false);
    setAccounts(listAccounts());
    setInputNumber("");
    setAuthError("");
    navigate("messenger");
    return true;
  }, [loadAccountState, navigate]);

  // eraseKey=false — выход без стирания ключа устройства (session_replaced, сбой
  // инициализации ключа): SW общий для вкладок, ключ может использовать другая вкладка.
  // soft — «мягкий выход» для переключения аккаунта: WS закрывается обычным disconnect (без
  // revoke_session), RAM сбрасывается как при logout, но токены, хранилище и ключ устройства
  // остаются; `to` — аккаунт, на который переключаемся (без `to` — экран входа в режиме добавления).
  // Возвращает номер аккаунта, на который переключились (после обычного выхода — следующий из
  // списка, если он есть), иначе "".
  const hardLogout = useCallback((opts?: { eraseKey?: boolean; soft?: boolean; to?: string }): string => {
    const soft = opts?.soft === true;
    const erase = !soft && opts?.eraseKey !== false;
    authGenRef.current++; // любой выход/переключение обесценивает незавершённый вход
    setAuthBusy(false);
    // L-a: номер аккаунта снимается синхронно — асинхронные записи (persist*, после PBKDF2/
    // await) проверяют selfNumberRef и не пишут данные выходящего/стёртого аккаунта
    const me = selfNumberRef.current;
    selfNumberRef.current = "";
    // App Lock: аккаунт мог быть заблокирован в момент принудительного выхода (4401, исчезновение
    // маркера блокировки, сбой ключа) — следующий аккаунт тогда нельзя показывать без PIN
    const wasLocked = appLockedRef.current;
    const switchOrigin = switchOriginRef.current;
    switchOriginRef.current = "";
    // Уведомления прежнего номера не должны остаться в центре уведомлений
    if (me) closeNotificationsFor(me);
    if (soft && me && activePeerRef.current && messageTextRef.current.trim()) {
      // Черновик в композере переживёт возврат на этот аккаунт (как при F5)
      try {
        const k = accountKey(me, "drafts");
        const cur = JSON.parse(sessionStorage.getItem(k) || "{}");
        cur[activePeerRef.current] = messageTextRef.current;
        sessionStorage.setItem(k, JSON.stringify(cur));
      } catch { /* ignore */ }
    }
    ownDeviceIdRef.current = "";
    // WEB-08: выход/wipe не оставляет живой звонок или запись микрофона
    try { cleanupCallRef.current(); } catch { /* ignore */ }
    // Запись голоса прежнего аккаунта не переживает выход/переключение (полоса размонтируется)
    setIsRecording(false);
    sendRelay({ type: "disconnect" });
    wsRef.current?.close();
    wsRef.current = null;
    // Закрываем все P2P-каналы — иначе они переживут logout и останутся в RAM
    for (const ch of [...p2pChannelsRef.current.values(), ...p2pRenewRef.current.values()]) {
      try {
        ch.dc?.close();
        ch.pc.close();
      } catch {}
    }
    p2pChannelsRef.current.clear();
    p2pRenewRef.current.clear();
    p2pRenewBackoffRef.current.clear();
    for (const d of p2pDeferredOffersRef.current.values()) clearTimeout(d.timer);
    p2pDeferredOffersRef.current.clear();
    setP2PActivePeers(new Set());
    // P2P v2: очереди файлов, приём, ожидания delivery_ack и дедуп — только RAM этого аккаунта
    p2pFileOpsRef.current?.reset();
    for (const w of p2pAckWaitRef.current.values()) clearTimeout(w.timer);
    p2pAckWaitRef.current.clear();
    p2pOfferTimesRef.current.clear();
    seenIncomingRef.current.clear();
    screenshotAlertAtRef.current.clear();
    setRelayDown(false);
    // S2: logout стирает ключ устройства и из IndexedDB SW (Q14 — с подтверждением SW)
    // Стирается ключ только этого номера: ключи других аккаунтов браузера — свои
    if (erase && me) void wipeKeysAndWait({ number: me });
    else wipe({ erase: false, number: me });
    keysRef.current = null;
    peerKeyWaitRef.current.clear();
    setVerifiedKeys({});
    peerKeyAtRef.current = {};
    peerLookupReplyAtRef.current = {};
    peerLookupSentAtRef.current = {};
    sentToRef.current = new Set();
    setKeyChangedPeers({});
    // S9: пины identity-ключей, peerEnv2 и lastVerified стираются только при явном выходе
    // пользователя (и panic). Выход по инициативе relay (4401, session_replaced) и сбой ключа
    // хранилище не трогают: иначе вредоносный relay обнулил бы TOFU и после повторного входа
    // молча закрепился бы его ключ. RAM сбрасывается всегда — при входе всё перечитается из
    // localStorage (ключи per-number).
    // X-06/Q14: явный logout — account-scoped wipe: все accountKey(n, *) этого номера в
    // localStorage и sessionStorage (контакты, пины, verified, PIN-верификаторы, блок-лист,
    // черновики…). Устройство-уровневые настройки (тема, onboarding, язык) остаются.
    if (erase && me) {
      wipeAccountStorage(me);
      broadcastWipe({ scope: "account", number: me });
    }
    pinnedIdentityRef.current = {};
    setPinnedIdentity({});
    lastVerifiedIdentityRef.current = {};
    setLastVerifiedIdentity({});
    peerEnv2Ref.current = {};
    peerCapsRef.current = {};
    setPeerCaps({});
    downgradeWarnedRef.current = new Set();
    peerMeta1Ref.current = {};
    meta1DowngradeWarnedRef.current = new Set();
    keyAlertsRef.current = {};
    setKeyAlerts({});
    ackFpRef.current = {};
    blockListRef.current = { exists: false, numbers: [], unblocked: {} };
    setBlockedUsers(new Set());
    callIdRef.current = "";
    // Мягкий выход токены не трогает; обычный — убирает токен только этого аккаунта (остальные живут)
    if (!soft && me) clearTokenMemory(me);
    if (!soft && me) {
      localStorage.removeItem(accountKey(me, "privacy_seen"));
    }
    setAccounts(listAccounts());
    setToken("");
    setSelfNumber("");
    setSessionReady(false);
    setConnState("offline");
    setRelayError("");
    setPeerKeys({});
    setMessages({});
    setActivePeer("");
    setMessageText("");
    setPendingNumber("");
    setOtp(Array(OTP_LENGTH).fill(""));
    setShowPrivacyNotice(true);
    if (!(soft && opts?.to)) setMenuPanel(null); // при переключении профиль остаётся открытым
    setUnread({});
    setTypingPeers({});
    setReplyTo(null);
    setDrafts({});
    setPinnedMessages({});
    setActivePeerOnline(null);
    setActiveSessions([]);
    setMobileChatOpen(false);
    setShowKeyVerification(false);
    setShowQr(false);
    setEditingMsg(null);
    setChatSearchOpen(false);
    setChatSearchQuery("");
    setShowPinned(false);
    setShowLogoutConfirm(false);
    setShowSessionReplacedDialog(false);
    if (soft) {
      if (opts?.to && enterAccount(opts.to, { honorLock: true })) return opts.to;
      navigate("login");
      return "";
    }
    // Остались другие аккаунты — переключаемся на следующий (clearToken уже выбрал его активным)
    // Цель переключения была заблокирована и ещё не разблокирована — возвращаемся на исходный
    // аккаунт (он был разблокирован пользователем), ничего не стирая; его блокировка учитывается
    if (me && wasLocked && switchOrigin && switchOrigin !== me && listAccounts().includes(switchOrigin)
      && enterAccount(switchOrigin, { honorLock: true })) return switchOrigin;
    let next = me ? getActiveNumber() : "";
    // Следующим выбираем аккаунт с живым токеном: истёкшие убираем (иначе 4401 цели и, при
    // блокировке, лишнее стирание всех аккаунтов)
    while (next && isTokenExpiredFor(next)) { clearTokenMemory(next); next = getActiveNumber(); }
    setAccounts(listAccounts());
    if (next && wasLocked && !accountHasLock(next)) {
      // Блокировка была включена, а у следующего аккаунта PIN нет — чаты без PIN не показываем:
      // токены остальных аккаунтов сбрасываются, экран входа (данные на диске не трогаются)
      clearTokenMemory();
      setAccounts([]);
      // Экран входа без «залипшей» блокировки: иначе после входа по коду снова экран PIN (вход дважды)
      setAppLocked(false);
      setAppLockPin("");
      navigate("login");
      return "";
    }
    if (next && enterAccount(next, { honorLock: true })) return next;
    setAppLocked(false);
    setAppLockPin("");
    navigate("login");
    return "";
  }, [navigate, sendRelay, enterAccount]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      // Snapshot the in-flight composer text into the persistent draft store
      // before wipe() resets state — so it can be restored after F5.
      const peer = activePeerRef.current;
      const num = selfNumberRef.current;
      if (peer && num && messageText.trim()) {
        try {
          const k = accountKey(num, "drafts");
          const cur = JSON.parse(sessionStorage.getItem(k) || "{}");
          cur[peer] = messageText;
          sessionStorage.setItem(k, JSON.stringify(cur));
        } catch { /* ignore */ }
      }
      try { sendRelay({ type: "disconnect" }); } catch { /* ignore */ }
      // Только выгрузка из RAM SW; ключ устройства в IndexedDB остаётся (S2)
      wipe();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [sendRelay, messageText]);

  // OTP countdown
  useEffect(() => {
    if (screen !== "otp" || otpSeconds <= 0) return;
    const timer = window.setTimeout(() => setOtpSeconds(v => Math.max(0, v - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [screen, otpSeconds]);

  // Init E2E keys (private key stored in Service Worker scope)
  // S2: ключ устройства персистентный и свой у каждого номера — SW поднимает
  // его из IndexedDB (`device-ecdh-p256:<number>`) или создаёт.
  useEffect(() => {
    if (!token || !selfNumber) {
      // Нет сессии — выгружаем ключ из RAM SW (не стираем: стирание только logout/panic)
      wipe();
      keysRef.current = null;
      setSessionReady(false);
      return;
    }
    let canceled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Сбой инициализации (SW недоступен/таймаут) — не logout и не каскад по всем аккаунтам:
    // ошибка и ограниченный повтор только для текущего аккаунта; отменённая загрузка (аккаунт
    // сменился) ничего не делает
    const RETRY_DELAYS_MS = [1500, 4000, 8000];
    const attempt = (n: number) => {
      loadOrCreateKeys(selfNumber)
        .then(result => {
          if (canceled) return;
          keysRef.current = result;
          setSessionReady(true);
          setRelayError("");
        })
        .catch(() => {
          if (canceled) return;
          setRelayError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0438\u043D\u0438\u0446\u0438\u0430\u043B\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C E2E-\u043A\u043B\u044E\u0447\u0438");
          if (n < RETRY_DELAYS_MS.length) retryTimer = setTimeout(() => attempt(n + 1), RETRY_DELAYS_MS[n]);
        });
    };
    attempt(0);
    return () => { canceled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [token, selfNumber]);

  // Send typing indicator
  const sendTypingIndicator = useCallback(() => {
    if (!activePeer || privacyRef.current.disableTyping) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_DEBOUNCE_MS) return;
    lastTypingSentRef.current = now;
    sendPeerEvent({ type: "typing", toNumber: activePeer, isTyping: true });

    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      sendPeerEvent({ type: "typing", toNumber: activePeer, isTyping: false });
    }, TYPING_DEBOUNCE_MS);
  }, [activePeer, sendPeerEvent]);

  // WEB-21: токен — через ref. Ротация (token_rotated, раз в час) не должна
  // пересоздавать WS: собеседники получали бы peer_offline и рвали P2P/звонок.
  // Реконнект берёт актуальный токен из ref.
  const wsTokenRef = useRef(token);
  wsTokenRef.current = token;
  const hasToken = !!token;

  // WebSocket connection (с auto-reconnect и P2P-fallback при падении сервера)
  useEffect(() => {
    if (!hasToken || !sessionReady || !selfNumber || screen !== "messenger") return;

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

    const connect = () => {
      if (cancelled) return;
      const ws = openRelayWs(wsTokenRef.current);
      wsRef.current = ws;
      setConnState("connecting");

    ws.onopen = () => {
      reconnectAttempt = 0;
      setRelayDown(false);
      setConnState("online");
      requestNotificationPermission();
      const keys = keysRef.current;
      if (keys) ws.send(JSON.stringify({ type: "register", publicKey: keys.publicKey, capabilities: CLIENT_CAPABILITIES }));
      // S10.1: настройки чата только локальные — get_chat_settings не запрашиваем.
      // Блок-лист синхронизируется после ответа registered (S10.6/Q11).
      // Keep connection alive through NAT/proxy by sending periodic pings
      keepAliveTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 25000);
    };

    // WEB-21: входящие обрабатываются строго по очереди — async-обработчик иначе
    // переставлял сообщения и применял ICE до setRemoteDescription.
    let inboundChain: Promise<void> = Promise.resolve();
    // P2P v2 §3.7: тот же обработчик и для событий, пришедших по DC (via "p2p", fromNumber = peer)
    const handlePayload = async (payload: RelayInbound, via: "relay" | "p2p"): Promise<void> => {
      // §3.2(c): входящее сообщение/реакция/typing от пира через relay — повод поднять DC
      if (via === "relay" && P2P_INBOUND_TRIGGER_TYPES.has(payload.type)) {
        const f = (payload as { fromNumber?: unknown }).fromNumber;
        if (typeof f === "string" && f) p2pAutoStartRef.current?.(f);
      }

      if (payload.type === "registered" && payload.status !== "ok") {
        setRelayError("Relay \u043E\u0442\u043A\u043B\u043E\u043D\u0438\u043B \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u043E\u043D\u043D\u044B\u0439 \u043A\u043B\u044E\u0447.");
        return;
      }
      if (payload.type === "registered") {
        syncBlockListAfterRegister();
        // WEB-11: флаг присутствия живёт в RAM relay — повторяем после каждого register
        sendRelay({ type: "set_presence", hidden: !!privacyRef.current.hideOnline });
        return;
      }

      if (payload.type === "lookup_result") {
        const target = payload.targetNumber || "";
        if (target) peerLookupReplyAtRef.current[target] = Date.now();
        // Ответ лимитера relay — не данные о собеседнике: никаких побочных эффектов (S1)
        if (payload.reason === "rate_limited") return;
        // P9: capabilities последнего ответа; отсутствие поля = старый клиент (без env2)
        if (target) {
          const caps = Array.isArray(payload.capabilities)
            ? payload.capabilities.filter((c): c is string => typeof c === "string").slice(0, 8)
            : [];
          peerCapsRef.current = { ...peerCapsRef.current, [target]: caps };
          setPeerCaps(prev => (prev[target] && prev[target].join(",") === caps.join(",") ? prev : { ...prev, [target]: caps }));
        }
        if (target) {
          // mdev1: список устройств; некорректные записи отбрасываются, не больше 8
          const devs = Array.isArray(payload.devices) ? payload.devices : [];
          peerDevicesRef.current = {
            ...peerDevicesRef.current,
            [target]: devs
              .filter(d => d && typeof d.deviceId === "string" && /^[0-9a-f]{16,64}$/.test(d.deviceId)
                && typeof d.publicKey === "string" && d.publicKey.length > 0 && d.publicKey.length <= 1024)
              .slice(0, 8)
              .map(d => ({ deviceId: d.deviceId, publicKey: d.publicKey })),
          };
        }
        if (payload.publicKey && target) {
          // S1: единственный источник ключа собеседника
          const newKey = payload.publicKey;
          // Мультиаккаунт: async-ветки ниже не должны трогать состояние другого аккаунта
          const lookupMe = selfNumberRef.current;
          peerKeyAtRef.current[target] = Date.now();
          peerKeysRef.current = { ...peerKeysRef.current, [target]: newKey };
          setPeerKeys(prev => (prev[target] === newKey ? prev : { ...prev, [target]: newKey }));
          // S3: «verified» привязан к отпечатку ключа; ключ сменился → снять флаг и показать баннер
          const pinnedFp = verifiedKeysRef.current[target];
          // P7: ключ с сервера не входит в закреплённые identity-ключи → verified снимается
          // (липкий баннер считает ChatPanel по pinnedIdentity и отпечатку lookup-ключа)
          const lastVerifiedFp = lastVerifiedIdentityRef.current[target];
          const identityPins = [...(pinnedIdentityRef.current[target] || []), ...(lastVerifiedFp ? [lastVerifiedFp] : [])];
          if (pinnedFp && identityPins.length > 0) {
            keyFingerprint(newKey).then(fp => {
              if (selfNumberRef.current !== lookupMe) return;
              // Ключ из пинов, но не тот, что пользователь проверял, — тоже снимаем verified
              if (fp && identityPins.includes(fp) && (!lastVerifiedFp || fp === lastVerifiedFp)) return;
              // L-b: alert взводится в той же ветке, что снимает verified — без окна между .then
              if (fp && fp !== pinnedFp) raiseKeyAlert(target, fp);
              setVerifiedKeys(prev => {
                if (!prev[target]) return prev;
                const next = { ...prev };
                delete next[target];
                return next;
              });
            }).catch(() => {});
          }
          if (pinnedFp) {
            keyFingerprint(newKey).then(fp => {
              if (selfNumberRef.current !== lookupMe || fp === pinnedFp) return;
              setVerifiedKeys(prev => {
                if (prev[target] !== pinnedFp) return prev;
                const next = { ...prev };
                delete next[target];
                return next;
              });
              setKeyChangedPeers(prev => ({ ...prev, [target]: true }));
              // Q7 (в): снят «проверено» из-за смены ключа — отправка блокируется до решения пользователя
              raiseKeyAlert(target, fp);
            }).catch(() => {});
          }
        }
        if (target === activePeerRef.current) {
          setActivePeerOnline(payload.online);
        }
        // P2P v2 §3.2(b): собеседник в сети — очередь файлов к нему пробуется сразу
        if (payload.online && target && target !== selfNumberRef.current) p2pFileOpsRef.current?.onPeerOnline(target);
        // Авто-P2P: если peer online и мы инициатор по lex-порядку — стартуем.
        // S4: только для номеров, прошедших гейт (не в блок-листе И контакт/исходящее).
        if (payload.online && target && target !== selfNumberRef.current && p2pPeerAllowed(target)) {
          if (selfNumberRef.current < payload.targetNumber) {
            const existing = p2pChannelsRef.current.get(payload.targetNumber);
            if (!existing || existing.state === "closed" || existing.state === "failed") {
              startP2P(payload.targetNumber);
            }
          }
        }
        return;
      }

      if (payload.type === "peer_online") {
        const peer = (payload as any).number || "";
        if (peer && peer === activePeerRef.current) setActivePeerOnline(true);
        // P2P v2 §3.2(a): файлы в очереди к этому собеседнику — попытка канала сразу (любой стороной)
        if (peer && peer !== selfNumberRef.current) p2pFileOpsRef.current?.onPeerOnline(peer);
        // S4: авто-старт P2P только для номеров, прошедших гейт
        if (peer && peer !== selfNumberRef.current && selfNumberRef.current < peer && p2pPeerAllowed(peer)) {
          const existing = p2pChannelsRef.current.get(peer);
          if (!existing || existing.state === "closed" || existing.state === "failed") {
            startP2P(peer);
          }
        }
        return;
      }

      if (payload.type === "peer_offline") {
        const peer = payload.number || payload.toNumber || "";
        const reason = (payload as any).reason || "";
        slog.log("[RELAY] peer_offline, reason:", reason);
        if (peer && peer === activePeerRef.current) setActivePeerOnline(false);
        // P2P v2 §3.2: no_session в ответ на наш p2p_offer/ICE — пир офлайн, это «зонд», а не ошибка
        // доставки: канал закрываем без баннера (следующая попытка — по backoff или триггеру (c))
        const p2pProbe = reason === "no_session" && !!peer && peer !== callPeerRef.current
          && (p2pOfferTimesRef.current.get(peer) || []).some(t => Date.now() - t < 20_000);
        if (peer) {
          if (reason === "no_session") {
            // no_session приходит и на любой не-message кадр/renew-offer, когда у пира упал WS, —
            // открытый DC это не отменяет: закрываем только connecting-канал и renew-канал
            const renew = p2pRenewRef.current.get(peer);
            if (renew) {
              try { renew.dc?.close(); } catch {}
              try { renew.pc.close(); } catch {}
              p2pRenewRef.current.delete(peer);
              p2pFileOpsRef.current?.onChannelClosed(peer, renew);
            }
            const cur = p2pChannelsRef.current.get(peer);
            if (cur && cur.state === "connecting") closeP2P(peer);
          } else {
            // peer ушёл — закрываем P2P (он мёртв)
            closeP2P(peer);
          }
        }
        if (p2pProbe) return;
        // WEB-07: звонок рвёт только уход ТЕКУЩЕГО собеседника по звонку
        if (pcRef.current && peer && peer === callPeerRef.current) {
          cleanupCallRef.current();
          setRelayError(`\u0421\u043E\u0431\u0435\u0441\u0435\u0434\u043D\u0438\u043A ${peer ? formatNumber(peer) : ""} \u043E\u0444\u043B\u0430\u0439\u043D.`);
        } else if (reason !== "disconnect") {
          setRelayError(`\u0421\u043E\u0431\u0435\u0441\u0435\u0434\u043D\u0438\u043A ${peer ? formatNumber(peer) : ""} \u043E\u0444\u043B\u0430\u0439\u043D. \u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u043D\u0435 \u0434\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E. [${reason}]`);
        }
        return;
      }

      if (payload.type === "error") {
        const reason = (payload as { reason?: string }).reason || "unknown";
        const msgs: Record<string, string> = {
          invalid_target: "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043D\u043E\u043C\u0435\u0440 \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u044F",
          missing_encryptedBlob: "\u041E\u0448\u0438\u0431\u043A\u0430: \u043E\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0443\u044E\u0442 \u0434\u0430\u043D\u043D\u044B\u0435 \u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u0438\u044F",
          invalid_json: "\u041E\u0448\u0438\u0431\u043A\u0430 \u0444\u043E\u0440\u043C\u0430\u0442\u0430 \u0434\u0430\u043D\u043D\u044B\u0445",
          missing_type: "\u041E\u0448\u0438\u0431\u043A\u0430 \u043F\u0440\u043E\u0442\u043E\u043A\u043E\u043B\u0430",
          // Q17: лимиты relay — только тост, без модалок и без разрыва WS
          rate_limited: "Слишком много запросов. Повторите чуть позже.",
          too_large: "Сообщение слишком большое для отправки.",
          invalid_blob: "Ошибка формата зашифрованного сообщения.",
        };
        setRelayError(msgs[reason] || `\u041E\u0448\u0438\u0431\u043A\u0430 relay: ${reason}`);
        return;
      }

      if (payload.type === "session_ready") {
        ownDeviceIdRef.current = typeof payload.deviceId === "string" ? payload.deviceId : "";
        return;
      }

      if (payload.type === "session_replaced") {
        setShowSessionReplacedDialog(true);
        return;
      }

      if (payload.type === "typing") {
        const from = payload.fromNumber;
        if (payload.isTyping) {
          setTypingPeers(prev => ({ ...prev, [from]: Date.now() }));
        } else {
          setTypingPeers(prev => {
            const updated = { ...prev };
            delete updated[from];
            return updated;
          });
        }
        return;
      }

      if (payload.type === "read_receipt") {
        const from = payload.fromNumber;
        if (!Array.isArray(payload.messageIds)) return;
        for (const msgId of payload.messageIds) {
          if (typeof msgId === "string") clearP2PAckWait(msgId, from);
          setMessages(prev => {
            const msgs = prev[from];
            if (!msgs) return prev;
            const idx = msgs.findIndex(m => m.id === msgId);
            if (idx === -1) return prev;
            const updated = [...msgs];
            updated[idx] = { ...updated[idx], status: "read" };
            return { ...prev, [from]: updated };
          });
        }
        return;
      }

      if (payload.type === "delivery_receipt") {
        const from = payload.fromNumber;
        if (!Array.isArray(payload.messageIds)) return;
        for (const msgId of payload.messageIds) {
          if (typeof msgId === "string") clearP2PAckWait(msgId, from);
          setMessages(prev => {
            const msgs = prev[from];
            if (!msgs) return prev;
            const idx = msgs.findIndex(m => m.id === msgId);
            if (idx === -1 || msgs[idx].status === "read") return prev;
            const updated = [...msgs];
            updated[idx] = { ...updated[idx], status: "delivered" };
            return { ...prev, [from]: updated };
          });
        }
        return;
      }

      if (payload.type === "message_queued") {
        setMessages(prev => {
          const msgs = prev[payload.toNumber];
          if (!msgs) return prev;
          const idx = msgs.findIndex(m => m.id === payload.messageId);
          if (idx === -1) return prev;
          // не понижаем статус, если delivered/read уже пришли раньше
          if (msgs[idx].status === "delivered" || msgs[idx].status === "read") return prev;
          const updated = [...msgs];
          updated[idx] = { ...updated[idx], status: "sent" };
          return { ...prev, [payload.toNumber]: updated };
        });
        return;
      }

      if (payload.type === "reaction") {
        const from = payload.fromNumber;
        if (from === selfNumberRef.current) return;
        // S10.1: meta1-реакция — эмодзи внутри E2E-blob, разбирает единый диспетчер
        if (payload.encryptedBlob && typeof payload.encryptedBlob === "object") {
          await handleIncomingEnvelopeRef.current({
            from, outerType: "reaction", messageId: payload.messageId || "",
            blob: payload.encryptedBlob, timestamp: payload.timestamp, via: "relay",
          });
          return;
        }
        // Легаси-реакция открытым текстом (Q16: от meta1-собеседника — уведомление о даунгрейде)
        if (blockListRef.current.numbers.includes(from)) return;
        if (typeof payload.emoji !== "string" || !payload.emoji || [...payload.emoji].length > 16) return;
        notePayloadFormat(from, false);
        setMessages(prev => {
          const msgs = prev[from];
          if (!msgs) return prev;
          const idx = msgs.findIndex(m => m.id === payload.messageId);
          if (idx === -1) return prev;
          const updated = [...msgs];
          const msg = { ...updated[idx] };
          const reactions = [...(msg.reactions || [])];
          if (payload.remove) {
            const ri = reactions.findIndex(r => r.from === from && r.emoji === payload.emoji);
            if (ri !== -1) reactions.splice(ri, 1);
          } else {
            reactions.push({ emoji: payload.emoji, from: from, timestamp: payload.timestamp });
          }
          msg.reactions = reactions;
          updated[idx] = msg;
          return { ...prev, [from]: updated };
        });
        return;
      }

      if (payload.type === "message_pinned") {
        const key = payload.chatKey || "";
        if (key) {
          setPinnedMessages(prev => ({
            ...prev,
            [key]: [...(prev[key] || []), {
              messageId: payload.messageId,
              pinnedBy: payload.pinnedBy,
              pinnedAt: Date.now(),
              // S5: preview от relay игнорируется — превью берётся из локальной истории
              preview: "",
            }],
          }));
        }
        return;
      }

      if (payload.type === "message_unpinned") {
        const key = payload.chatKey || "";
        if (key) {
          setPinnedMessages(prev => ({
            ...prev,
            [key]: (prev[key] || []).filter(p => p.messageId !== payload.messageId),
          }));
        }
        return;
      }

      if (payload.type === "pinned_messages") {
        // S5: preview от relay игнорируется — превью берётся из локальной истории
        const pins = Array.isArray(payload.pins) ? payload.pins.map(p => ({ ...p, preview: "" })) : [];
        setPinnedMessages(prev => ({
          ...prev,
          [payload.chatKey]: pins,
        }));
        return;
      }

      if (payload.type === "message") {
        if (!keysRef.current) return;
        const from = payload.fromNumber;
        if (from === selfNumberRef.current) return;
        // S10.1/Q1: единый диспетчер (meta1 / легаси)
        await handleIncomingEnvelopeRef.current({
          from, outerType: "message", messageId: payload.messageId || "",
          blob: payload.encryptedBlob, via: "relay", meshBridge: !!payload._meshBridge,
          legacy: { replyTo: payload.replyTo, forwardFrom: payload.forwardFrom, selfDestruct: payload.selfDestruct },
        });
        if (activePeerRef.current === from) setActivePeerOnline(true);
      }

      // ── File message (direct only) ──
      if (payload.type === "file_message") {
        const from = payload.fromNumber;
        if (blockListRef.current.numbers.includes(from)) return;
        const msgId = payload.messageId || nowId();
        // WEB-09: легаси-поля снаружи шифртекста — проверяем типы, иначе рендер упадёт
        const rawName = (payload as any).fileName;
        const fileName = (typeof rawName === "string" ? rawName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) : "") || "file";
        const rawSize = (payload as any).fileSize;
        const fileSize = typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : 0;
        const rawMime = (payload as any).mimeType;
        const mimeType = typeof rawMime === "string" && /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/i.test(rawMime)
          ? rawMime : "application/octet-stream";

        let fileDataUrl: string | undefined;
        let fileUnsupported = false;
        const keys = keysRef.current;
        const fileMe = selfNumberRef.current;
        if (keys && payload.encryptedBlob) {
          try {
            const decrypted = await decrypt(
              payload.encryptedBlob,
              from,
              selfNumberRef.current,
            );
            // Мультиаккаунт: за время расшифровки аккаунт сменился — сообщение чужое, не показываем
            if (selfNumberRef.current !== fileMe) return;
            await noteIncomingEnvelope(from, payload.encryptedBlob);
            // Q19/D4: meta1-payload во внешнем легаси-типе — перестановка контекста → дроп без пузыря
            if (isMeta1Plaintext(decrypted)) { notePayloadFormat(from, true); return; }
            fileDataUrl = `data:${mimeType};base64,${decrypted}`;
            notePayloadFormat(from, false);
          } catch (e) {
            fileUnsupported = isUnsupportedVersionError(e);
            slog.warn("[File] Decryption failed:", (e as Error)?.message);
          }
        }

        if (selfNumberRef.current !== fileMe) return;
        // P3: версия ≥ 3 — обычное текстовое сообщение-заглушка вместо файла
        appendMessage(from, fileUnsupported ? {
          id: msgId, from, to: selfNumberRef.current,
          text: UNSUPPORTED_VERSION_TEXT, createdAt: Date.now(), direction: "in",
          status: "delivered",
        } : {
          id: msgId, from, to: selfNumberRef.current,
          text: `[\u0424\u0430\u0439\u043B: ${fileName}]`,
          createdAt: Date.now(), direction: "in",
          fileName, fileSize, mimeType, fileData: fileDataUrl,
          status: "delivered",
        });
        notifyIncoming(from, `\u0424\u0430\u0439\u043B: ${fileName}`, "file");
        if (activePeerRef.current !== from) {
          setUnread(prev => ({ ...prev, [from]: (prev[from] || 0) + 1 }));
        }
      }

      // ── Voice message (direct only) ──
      if (payload.type === "voice_message") {
        const from = payload.fromNumber;
        if (blockListRef.current.numbers.includes(from)) return;
        const msgId = payload.messageId || nowId();
        // Q2: легаси duration — web/iOS секунды, Android мс (< 1000 → секунды)
        const duration = legacyDurationToSeconds(payload.duration);

        let voiceData: string | undefined;
        let voiceUnsupported = false;
        const keys = keysRef.current;
        const voiceMe = selfNumberRef.current;
        if (keys && payload.encryptedBlob) {
          try {
            voiceData = await decrypt(
              payload.encryptedBlob,
              from,
              selfNumberRef.current,
            );
            if (selfNumberRef.current !== voiceMe) return;
            await noteIncomingEnvelope(from, payload.encryptedBlob);
            // Q19/D4: meta1-payload во внешнем легаси-типе — перестановка контекста → дроп без пузыря
            if (isMeta1Plaintext(voiceData)) { notePayloadFormat(from, true); return; }
            notePayloadFormat(from, false);
          } catch (e) {
            voiceUnsupported = isUnsupportedVersionError(e);
            slog.warn("[Voice] Decryption failed:", (e as Error)?.message);
          }
        } else {
          slog.warn("[Voice] No keys or no encryptedBlob");
        }

        if (selfNumberRef.current !== voiceMe) return;
        const voiceMime = (payload as any).mimeType || "audio/webm";
        appendMessage(from, voiceUnsupported ? {
          id: msgId, from, to: selfNumberRef.current,
          text: UNSUPPORTED_VERSION_TEXT, createdAt: Date.now(), direction: "in",
          status: "delivered",
        } : {
          id: msgId, from, to: selfNumberRef.current,
          text: `[\u0413\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 ${duration}\u0441]`,
          createdAt: Date.now(), direction: "in",
          isVoice: true, duration, voiceData, mimeType: voiceMime,
          status: "delivered",
        });
        notifyIncoming(from, "\u0413\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435", "voice");
        if (activePeerRef.current !== from) {
          setUnread(prev => ({ ...prev, [from]: (prev[from] || 0) + 1 }));
        }
      }

      // ── Multi-device sessions ──
      if ((payload as any).type === "sessions_list") {
        setActiveSessions((payload as any).sessions || []);
        return;
      }

      if ((payload as any).type === "session_revoked") {
        if (ownDeviceIdRef.current && (payload as any).deviceId === ownDeviceIdRef.current) revokeAckRef.current?.();
        setActiveSessions(prev => prev.filter(s => s.deviceId !== (payload as any).deviceId));
        return;
      }

      if ((payload as any).type === "push_registered") {
        return;
      }

      // ── Block/unblock sync ──
      // S10.6/Q11: события блок-листа (в т.ч. с других своих устройств) обновляют локальный список
      if ((payload as any).type === "user_blocked") {
        const n = normalizeNumber(String((payload as any).number || ""));
        if (!n) return;
        const bl = blockListRef.current;
        const unblocked = { ...bl.unblocked };
        delete unblocked[n];
        persistBlockList([...bl.numbers, n], unblocked);
        return;
      }
      if ((payload as any).type === "user_unblocked") {
        const n = normalizeNumber(String((payload as any).number || ""));
        if (!n) return;
        const bl = blockListRef.current;
        persistBlockList(bl.numbers.filter(x => x !== n), { ...bl.unblocked, [n]: Date.now() });
        return;
      }
      if ((payload as any).type === "blocked_list") {
        const raw: unknown[] = Array.isArray((payload as any).numbers) ? (payload as any).numbers : [];
        const fromRelay = raw.map(x => normalizeNumber(String(x)) || "").filter(Boolean);
        const bl = blockListRef.current;
        if (!bl.exists) {
          // Первый запуск новой версии: список relay — начальный, затем синхронизация
          persistBlockList(fromRelay, {});
          syncBlockListAfterRegister();
        } else {
          // Ответ на block_sync = union(relay, наш) − tombstones; свежие tombstones не воскрешаем
          persistBlockList(fromRelay.filter(n => !bl.unblocked[n]), bl.unblocked);
        }
        return;
      }

      // ── Message deleted ──
      if ((payload as any).type === "message_deleted") {
        const p = payload as any;
        const ids = new Set<string>(Array.isArray(p.messageIds) ? p.messageIds.filter((x: unknown) => typeof x === "string") : []);
        const fromSelf = p.fromNumber === selfNumberRef.current;
        // WEB-14/WEB-23: собеседник удаляет только СВОИ сообщения (входящие от него),
        // моё другое устройство — только мои исходящие. Ищем по актуальному prev,
        // а не по замыканию `messages` эффекта.
        setMessages(prev => {
          const peer = fromSelf
            ? Object.keys(prev).find(k => prev[k]?.some(m => ids.has(m.id) && m.direction === "out")) || ""
            : p.fromNumber;
          if (!peer || !prev[peer]) return prev;
          const owned = (m: ChatMessage) => fromSelf
            ? m.direction === "out"
            : m.direction === "in" && m.from === peer;
          return { ...prev, [peer]: prev[peer].filter(m => !(ids.has(m.id) && owned(m))) };
        });
        return;
      }

      // ── Message edited ──
      // S10.1/Q1: правка собеседника — через единый диспетчер. Свои правки с других устройств
      // зашифрованы на ключ собеседника — прочитать их нельзя (как и раньше), пропускаем.
      if ((payload as any).type === "message_edited") {
        const p = payload as Extract<RelayInbound, { type: "message_edited" }>;
        if (!keysRef.current || !p.fromNumber || p.fromNumber === selfNumberRef.current) return;
        await handleIncomingEnvelopeRef.current({
          from: p.fromNumber, outerType: "message_edited", messageId: p.messageId || "",
          blob: p.encryptedBlob, timestamp: p.timestamp, via: "relay",
        });
        return;
      }

      // ── Multi-device message sync ──
      if ((payload as any).type === "message_sync") {
        const keys = keysRef.current;
        if (!keys) return;
        const toNumber = (payload as any).toNumber as string;
        const blob = (payload as any).encryptedBlob;

        const syncMe = selfNumberRef.current;
        let text = "[\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0440\u0430\u0441\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435]";
        try {
          // Синхронизированная копия своего исходящего — расшифровываем своим ключом
          // P8: копия своего исходящего — без TOFU/даунгрейд-проверок
          text = await decrypt(blob, selfNumberRef.current, toNumber, selfNumberRef.current);

        } catch (e) {
          if (isUnsupportedVersionError(e)) text = UNSUPPORTED_VERSION_TEXT;
        }

        if (selfNumberRef.current !== syncMe) return;
        const msgId = (payload as any).messageId || nowId();
        appendMessage(toNumber, {
          id: msgId, from: selfNumberRef.current, to: toNumber,
          text, createdAt: Date.now(), direction: "out",
          status: "sent",
        });
        return;
      }

      // ── Chat settings sync ──
      if ((payload as any).type === "chat_settings") {
        const p = payload as any;
        setChatSettings(prev => {
          const updated = {
            ...prev,
            [p.peerNumber]: {
              chatColor: p.chatColor || undefined,
              wallpaper: p.wallpaper || undefined,
            },
          };
          if (selfNumberRef.current) localStorage.setItem(accountKey(selfNumberRef.current, "chat_settings"), JSON.stringify(updated));
          return updated;
        });
      }

      if ((payload as any).type === "chat_settings_all") {
        const p = payload as any;
        if (Array.isArray(p.settings)) {
          setChatSettings(prev => {
            const updated = { ...prev };
            for (const s of p.settings) {
              updated[s.peerNumber] = {
                chatColor: s.chatColor || undefined,
                wallpaper: s.wallpaper || undefined,
              };
            }
            if (selfNumberRef.current) localStorage.setItem(accountKey(selfNumberRef.current, "chat_settings"), JSON.stringify(updated));
            return updated;
          });
        }
      }

      // ── Call events ──
      // X-04 / S4: сигналинг звонка принимается только от активного собеседника звонка.
      if (payload.type === "call_incoming") {
        const incomingCallId = typeof payload.callId === "string" ? payload.callId : "";
        // S10.5: звонок от номера из локального блок-листа — молча отклонить
        if (payload.fromNumber && blockedUsersRef.current.has(payload.fromNumber)) {
          sendRelay({ type: "call_reject", toNumber: payload.fromNumber, ...(incomingCallId ? { callId: incomingCallId } : {}) });
          return;
        }
        // Входящий от другого номера во время активного звонка — busy, текущий звонок не трогаем
        if (callPeerRef.current && payload.fromNumber !== callPeerRef.current) {
          if (payload.fromNumber) sendRelay({ type: "call_reject", toNumber: payload.fromNumber, ...(incomingCallId ? { callId: incomingCallId } : {}) });
          return;
        }
        // CR-01: новый звонок того же номера в окне «Не удалось соединиться» после отказа пина —
        // прежний закрываем сразу, иначе отложенный cleanup молча стёр бы этот входящий
        if (pinFailTimerRef.current && payload.fromNumber === callPeerRef.current && callIdMismatch(incomingCallId)) {
          clearTimeout(pinFailTimerRef.current);
          pinFailTimerRef.current = null;
          cleanupCallRef.current();
        }
        const pc = pcRef.current;
        // Q10: в идущем звонке offer с чужим callId — не наш звонок (до «Принять» — см. ниже)
        if (pc && callPeerRef.current && callIdMismatch(incomingCallId)) return;
        const peerMatch = callPeerRef.current === payload.fromNumber;
        const inCall = callPeerRef.current !== "";
        slog.log("[WebRTC] call_incoming, pc:", !!pc, "match:", peerMatch, "inCall:", inCall);
        // Renegotiation: re-offer during active call from same peer (ICE restart / video toggle)
        if (pc && peerMatch && inCall) {
          slog.log("[WebRTC] Renegotiation offer, signalingState:", pc.signalingState);
          const collision = makingOfferRef.current || pc.signalingState !== "stable";
          if (collision && isCallerRef.current) {
            slog.log("[WebRTC] Renegotiation glare: remote offer ignored (impolite)");
            return;
          }
          if (!acceptRemoteCallSdp(payload.fromNumber, payload.sdp?.sdp)) return;
          // Чужой offer пришёл — свой отложенный/идущий ICE-рестарт больше не нужен
          if (iceDisconnectTimerRef.current) { clearTimeout(iceDisconnectTimerRef.current); iceDisconnectTimerRef.current = null; }
          remoteOfferSeqRef.current += 1;
          try {
            // Откат только реально установленного своего offer: rollback в stable — InvalidStateError
            if (pc.signalingState === "have-local-offer") await pc.setLocalDescription({ type: "rollback" });
            await pc.setRemoteDescription(payload.sdp as RTCSessionDescriptionInit);
            remoteDescSetRef.current = true;
            for (const c of iceCandidateQueueRef.current) {
              try { await pc.addIceCandidate(c); } catch (e) { slog.warn("ICE candidate failed:", (e as Error)?.name); }
            }
            iceCandidateQueueRef.current = [];
            preferH264Transceiver(pc);
            const answer = await pc.createAnswer();
            const mungedReneg = answer.sdp ? preferH264InSdp(answer.sdp) : answer.sdp;
            await pc.setLocalDescription({ type: answer.type, sdp: mungedReneg });
            sendRelay(withCallId({ type: "call_answer", toNumber: payload.fromNumber, sdp: { type: answer.type, sdp: stripSdpCandidates(mungedReneg) } as RTCSessionDescriptionInit }));
            // Update video state if media changed
            if ((payload as any).media === "video" || payload.sdp?.sdp?.includes("m=video")) {
              setCallIsVideo(true);
              setPeerMediaState(prev => ({ ...prev, video: true }));
            }
          } catch (err) {
            slog.warn("[WebRTC] renegotiation failed:", (err as Error)?.name);
          }
        } else if (!pc && peerMatch && inCall) {
          // Same peer but PC not yet created (duplicate offer before user accepted)
          // Just update the SDP — user will accept with the latest offer
          slog.log("[WebRTC] Updated incoming SDP");
          // Новый звонок того же номера до принятия (прежний hangup потерялся) — берём его callId,
          // буфер кандидатов прежнего звонка выбрасываем
          if (callIdMismatch(incomingCallId)) {
            callIdRef.current = incomingCallId;
            iceCandidateQueueRef.current = [];
            remoteDtlsFpRef.current = null;
          }
          // CR-01: обновлённый offer того же звонка обязан нести тот же отпечаток
          if (!acceptRemoteCallSdp(payload.fromNumber, payload.sdp?.sdp)) return;
          incomingSdpRef.current = payload.sdp as RTCSessionDescriptionInit;
          const isVideoCall = (payload as any).media === "video" || payload.sdp?.sdp?.includes("m=video") || false;
          if (isVideoCall) {
            setCallIsVideo(true);
            setPeerMediaState(prev => ({ ...prev, video: true }));
          }
        } else {
          // New incoming call. S10.5: до «Принять» PeerConnection не создаётся, SDP не применяется,
          // ICE не собирается; входящие кандидаты буферизуются (≤ 64, тот же номер и callId).
          setCallPeer(payload.fromNumber);
          callPeerRef.current = payload.fromNumber; // Sync immediately for subsequent messages in same tick
          isCallerRef.current = false;
          callIdRef.current = incomingCallId;
          setCallState("ringing");
          const isVideoCall = (payload as any).media === "video" || payload.sdp?.sdp?.includes("m=video") || false;
          setCallIsVideo(isVideoCall);
          setPeerMediaState({ audio: true, video: isVideoCall });
          incomingSdpRef.current = payload.sdp as RTCSessionDescriptionInit;
          iceCandidateQueueRef.current = [];
          remoteDescSetRef.current = false;
          // CR-01: пин берётся из входящего offer ещё до «Принять»
          remoteDtlsFpRef.current = null;
          acceptRemoteCallSdp(payload.fromNumber, payload.sdp?.sdp);
        }
      }

      if (payload.type === "call_answer") {
        if (!callPeerRef.current || payload.fromNumber !== callPeerRef.current) return;
        if (callIdMismatch(payload.callId)) return;
        const pc = pcRef.current;
        if (pc && payload.sdp) {
          slog.log("[WebRTC] call_answer received, signalingState:", pc.signalingState);
          // Answer применим только к нашему неотвеченному offer; запоздавший/повторный
          // игнорируем — иначе InvalidStateError прервал бы обработчик.
          if (pc.signalingState !== "have-local-offer") return;
          if (!acceptRemoteCallSdp(payload.fromNumber, payload.sdp.sdp)) return;
          if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
          callTimeoutRef.current = null;

          try {
            await pc.setRemoteDescription(payload.sdp as RTCSessionDescriptionInit);
          } catch (err) {
            slog.warn("[WebRTC] setRemoteDescription(answer) failed:", (err as Error)?.name);
            return;
          }
          remoteDescSetRef.current = true;
          for (const c of iceCandidateQueueRef.current) {
            try { await pc.addIceCandidate(c); } catch (e) { slog.warn("ICE candidate failed:", (e as Error)?.name); }
          }
          iceCandidateQueueRef.current = [];
          // Update video state if answer includes video
          if ((payload.sdp as any).sdp?.includes("m=video")) {
            setCallIsVideo(true);
            setPeerMediaState(prev => ({ ...prev, video: true }));
          }
          // Только первый answer: answer на ICE-рестарт приходит до connectionState=connected и
          // раньше обнулял таймер и запускал второй интервал (счёт ×2)
          if (callPeerRef.current && !callTimerRef.current) {
            setCallState("connected");
            setCallDuration(0);
            callTimerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000);
            sendRelay(withCallId({ type: "call_media_toggle", toNumber: callPeerRef.current, audio: true, video: callVideoEnabledRef.current }));
          }
        }
      }

      if (payload.type === "ice_candidate") {
        if (!callPeerRef.current || payload.fromNumber !== callPeerRef.current) return;
        if (callIdMismatch(payload.callId)) return;
        const pc = pcRef.current;
        if (!pc && !callPeerRef.current) {
          // No active call — ignore stale ICE candidates
          return;
        }
        if (pc && remoteDescSetRef.current) {
          try { await pc.addIceCandidate(payload.candidate as RTCIceCandidateInit); } catch (e) { slog.warn("ICE candidate add failed:", (e as Error)?.name); }
        } else if (payload.candidate && callPeerRef.current && iceCandidateQueueRef.current.length < 64) {
          // S10.5: до принятия/remoteDescription — буфер не больше 64 кандидатов
          iceCandidateQueueRef.current.push(payload.candidate as RTCIceCandidateInit);
        }
      }

      if (payload.type === "call_reject" || payload.type === "call_hangup") {
        if (!callPeerRef.current || payload.fromNumber !== callPeerRef.current) return;
        if (callIdMismatch(payload.callId)) return;
        cleanupCallRef.current();
      }

      if (payload.type === "call_media_toggle") {
        if (!callPeerRef.current || payload.fromNumber !== callPeerRef.current) return;
        if (callIdMismatch(payload.callId)) return;

        setPeerMediaState({
          audio: (payload as any).audio ?? true,
          video: (payload as any).video ?? false,
        });
      }

      // ── Security & privacy relay events ──
      const msg = payload as any;
      switch (msg.type) {
        case "token_rotated": {
          const newToken = (msg as any).token;
          // Ротация относится к аккаунту, чей это сокет: токен записывается именно ему
          const rotatedFor = selfNumberRef.current;
          if (newToken && rotatedFor) {
            setTokenFor(rotatedFor, newToken);
            setToken(newToken);
          }
          break;
        }
        case "queue_overflow": {
          const qm = msg as any;
          setRelayError(`\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u0434\u043B\u044F ${formatNumber(qm.toNumber)} \u043F\u0435\u0440\u0435\u043F\u043E\u043B\u043D\u0435\u043D\u0430 (${qm.queueSize}/${qm.queueMax}). \u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F \u043C\u043E\u0433\u0443\u0442 \u0431\u044B\u0442\u044C \u043F\u043E\u0442\u0435\u0440\u044F\u043D\u044B.`);
          setTimeout(() => setRelayError(""), 8000);
          break;
        }
        case "screenshot_alert": {
          const sa = msg as any;
          const from = sa.fromNumber;
          const peer = from;
          const saNow = Date.now();
          if (saNow - (screenshotAlertAtRef.current.get(peer) ?? 0) < 2000) break;
          screenshotAlertAtRef.current.set(peer, saNow);
          setMessages(prev => {
            const list = [...(prev[peer] || [])];
            list.push({
              id: nowId(),
              from: peer,
              to: selfNumberRef.current,
              text: "\u26A0\uFE0F \u0421\u043E\u0431\u0435\u0441\u0435\u0434\u043D\u0438\u043A \u0441\u0434\u0435\u043B\u0430\u043B \u0441\u043A\u0440\u0438\u043D\u0448\u043E\u0442",
              createdAt: Date.now(),
              direction: "in" as const,
              status: "read" as const,
            });
            return { ...prev, [peer]: list };
          });
          break;
        }
        case "burn_read_ack": {
          const ba = msg as any;
          const from = ba.fromNumber;
          const msgId = ba.messageId;
          setMessages(prev => {
            // WEB-14: подтверждение прочтения удаляет только моё исходящее burn-сообщение
            if (!prev[from]) return prev;
            const list = prev[from].filter(m => !(m.id === msgId && m.direction === "out" && m.burnAfterRead));
            return { ...prev, [from]: list };
          });
          break;
        }
        case "p2p_offer": {
          const po = msg as any;
          handleP2POffer(po.fromNumber, po.sdp);
          break;
        }
        case "p2p_answer": {
          const pa = msg as any;
          handleP2PAnswer(pa.fromNumber, pa.sdp);
          break;
        }
        case "p2p_ice_candidate": {
          const pic = msg as any;
          handleP2PIceCandidate(pic.fromNumber, pic.candidate);
          break;
        }
      }
    };
    relayFrameHandlerRef.current = handlePayload;
    const handleInbound = async (event: MessageEvent) => {
      let payload: RelayInbound;
      try { payload = JSON.parse(event.data as string) as RelayInbound; }
      catch { return; }
      await handlePayload(payload, "relay");
    };
    ws.onmessage = (event) => {
      // Мультиаккаунт: кадры сокета прежнего аккаунта (после переключения) не обрабатываются
      if (wsRef.current !== ws) return;
      inboundChain = inboundChain.then(() => (wsRef.current === ws ? handleInbound(event) : undefined)).catch((e) => {
        slog.warn("[RELAY] inbound handler failed:", (e as Error)?.name);
      });
    };

    ws.onclose = (event) => {
      if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
      // Сокет уже заменён/закрыт нами (переключение аккаунта, выход) — его закрытие состояние не трогает
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      setConnState("offline");
      setRelayDown(true);
      if (event.code === 4001 || event.code === 4401 || event.code === 1008) {
        revokeAckRef.current?.();
        if (wipingRef.current) return; // свой revoke_session перед wipe — без тоста и без hardLogout
        setRelayError("\u0421\u0435\u0441\u0441\u0438\u044F \u0438\u0441\u0442\u0435\u043A\u043B\u0430, \u0432\u043E\u0439\u0434\u0438\u0442\u0435 \u0437\u0430\u043D\u043E\u0432\u043E");
        // 4401 — токен недействителен/сессия отозвана (no_token, invalid_token,
        // session_revoked): реконнект с мёртвым токеном бесконечен → выходим.
        // Ключ устройства не стираем: SW общий, его может использовать другая вкладка.
        if (event.code === 4401) {
          // Мультиаккаунт: убираем только этот аккаунт; есть другие — переключаемся на следующий
          const dead = selfNumberRef.current;
          if (hardLogout({ eraseKey: false }) && dead) {
            phantomToastRef.current(tx(initialLocale(), "accounts.sessionEnded", { number: formatNumber(dead) }), "error", 6000);
          }
        }
        return; // auth failure — не реконнектим
      }
      if (event.code === 4403) {
        // WEB-21: relay отказал по origin/WSS — реконнект ничего не изменит
        setRelayError("\u0421\u0435\u0440\u0432\u0435\u0440 \u043E\u0442\u043A\u043B\u043E\u043D\u0438\u043B \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435");
        return;
      }
      if (cancelled) return;
      // Exponential backoff: 1s -> 2s -> 4s -> ... cap 30s, с jitter ×[0.5, 1.5) —
      // WEB-21: после рестарта relay клиенты не переподключаются одной волной
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000) * (0.5 + Math.random());
      reconnectAttempt++;
      reconnectTimer = setTimeout(connect, delay);
    };
    ws.onerror = () => {
      // onclose follow-up автоматически решает реконнект
      setConnState("offline");
    };

    }; // end of connect()

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
      const cur = wsRef.current;
      if (cur && cur.readyState === WebSocket.OPEN) cur.send(JSON.stringify({ type: "disconnect" }));
      cur?.close();
      wsRef.current = null;
      setConnState("offline");
    };
  }, [appendMessage, hardLogout, noteIncomingEnvelope, screen, selfNumber, sessionReady, hasToken, sendRelay]);

  // Auth actions
  const requestCode = useCallback(async (numberValue: string) => {
    const normalized = normalizeNumber(numberValue);
    if (!normalized) { setAuthError("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043D\u043E\u043C\u0435\u0440 \u0444\u043E\u0440\u043C\u0430\u0442\u0430 111-XX-XXX-XX"); return; }
    // Мультиаккаунт: номер уже добавлен — отказ до send-code (код не тратится)
    if (listAccounts().includes(normalized)) { setAuthError(tx(initialLocale(), "accounts.duplicate")); return; }
    const gen = ++authGenRef.current;
    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: normalized })
      });
      const data = await response.json();
      if (authGenRef.current !== gen) return; // попытку отменили/заменили — ответ не применяем
      if (!response.ok || !data.ok) { setAuthError(humanAuthError(data.reason)); return; }
      setPendingNumber(normalized);
      setOtp(Array(OTP_LENGTH).fill(""));
      setOtpSeconds(Number(data.retryAfter) || 60);
      navigate("otp");
      window.setTimeout(() => otpRefs.current[0]?.focus(), 40);
    } catch { if (authGenRef.current === gen) setAuthError("\u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u0435\u0442\u0438 \u043F\u0440\u0438 \u0437\u0430\u043F\u0440\u043E\u0441\u0435 \u043A\u043E\u0434\u0430"); }
    finally { if (authGenRef.current === gen) setAuthBusy(false); }
  }, [navigate]);

  const verifyCode = useCallback(async () => {
    const code = otp.join("");
    if (code.length !== OTP_LENGTH) { setAuthError("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 6-\u0437\u043D\u0430\u0447\u043D\u044B\u0439 \u043A\u043E\u0434"); return; }
    const gen = ++authGenRef.current;
    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: pendingNumber, code })
      });
      const data = await response.json();
      if (authGenRef.current !== gen) return; // отменено (или аккаунт сменился) — ответ не применяем
      if (!response.ok || !data.ok) { setAuthError(humanAuthError(data.reason)); return; }
      // Защита: под новым номером не должно остаться состояния прежнего. Режим добавления уже
      // сделал мягкий выход; если активный номер всё же есть — сначала мягкий выход
      if (selfNumberRef.current) hardLogout({ soft: true });
      // Bearer stays in-memory only (see lib/token.ts). The `phantom_number` / `phantom_accounts`
      // keys are NOT sensitive — the UI needs to remember which accounts are logged in across an F5
      // (token.ts пишет их сам). Мультиаккаунт: новый номер добавляется и становится активным.
      if (!addAccountToken(data.number, data.token)) { setAuthError(tx(initialLocale(), "accounts.limit")); return; }
      setToken(data.token);
      setSelfNumber(data.number);
      setAccounts(listAccounts());
      setAddingAccount(false);
      setInputNumber("");
      setPendingNumber("");
      // Load per-account data for new user
      loadAccountState(data.number);
      navigate("messenger");
    } catch { if (authGenRef.current === gen) setAuthError("\u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u0435\u0442\u0438 \u043F\u0440\u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0435 \u043A\u043E\u0434\u0430"); }
    finally { if (authGenRef.current === gen) setAuthBusy(false); }
  }, [navigate, otp, pendingNumber, loadAccountState, hardLogout]);

  // Chat actions
  const openChat = useCallback((peer: string) => {
    setIsRecording(false); // запись в закрываемом чате не отправляется (полоса размонтируется)
    if (activePeerRef.current && messageText.trim()) {
      setDrafts(prev => ({ ...prev, [activePeerRef.current]: messageText }));
    }
    setActivePeer(peer);
    setMessageWindowSize(MESSAGE_WINDOW_SIZE);
    setActivePeerOnline(null);
    setMobileChatOpen(true);
    setMenuPanel(null);
    setReplyTo(null);
    setChatSearchOpen(false);
    setChatSearchQuery("");
    setMessageText(drafts[peer] || "");
    setUnread(prev => { const u = { ...prev }; delete u[peer]; return u; });
    sendRelay({ type: "lookup", targetNumber: peer });
    sendRelay({ type: "get_pins", toNumber: peer } as RelayOutbound);
    const msgs = messages[peer];
    if (msgs && !privacyRef.current.disableReadReceipts) {
      const unreadIds = msgs.filter(m => m.direction === "in" && !m.system && m.status !== "read").map(m => m.id);
      if (unreadIds.length > 0) {
        sendPeerEvent({ type: "read_receipt", toNumber: peer, messageIds: unreadIds });
      }
    }
  }, [sendRelay, sendPeerEvent, messageText, drafts, messages]);

  // Periodic key refresh
  useEffect(() => {
    if (!activePeer || activePeer === SAVED_MESSAGES_KEY || connState !== "online") return;
    const interval = setInterval(() => {
      sendRelay({ type: "lookup", targetNumber: activePeer });
    }, 30000);
    return () => clearInterval(interval);
  }, [activePeer, connState, sendRelay]);

  // Service worker messages (hot path: existing window)
  useEffect(() => {
    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === "open_chat" && event.data.fromNumber) {
        // Уведомление несёт номер получателя: чат открывается только под совпадающим активным аккаунтом
        const toNumber = typeof event.data.toNumber === "string" ? event.data.toNumber : "";
        if (!toNumber || toNumber !== selfNumberRef.current) return;
        // The SW passes back whatever it saw in the push payload — we
        // re-normalise here because the push channel is attacker-controlled
        // and could deliver `999-99-999-99` or worse.
        const target = normalizeNumber(String(event.data.fromNumber));
        if (target) openChat(target);
      }
    };
    navigator.serviceWorker?.addEventListener("message", handleSwMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", handleSwMessage);
    };
  }, [openChat]);

  // Cold-start notification navigation: SW opens /?open_chat=<number>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("open_chat");
    if (!raw) return;
    // Strip the URL immediately so a copied link from a phishing page can't
    // persist and be re-triggered across navigations.
    window.history.replaceState({}, "", window.location.pathname);
    const target = normalizeNumber(raw);
    // Ссылка из уведомления несёт получателя (`to`): чужому активному аккаунту чат не открывается
    const toParam = params.get("to");
    if (toParam && toParam !== selfNumberRef.current) return;
    if (target && screen === "messenger" && sessionReady) {
      openChat(target);
    }
  }, [screen, sessionReady, openChat]);

  const startNewChat = useCallback(() => {
    const target = normalizeNumber(newChatNumber);
    if (!target) { setRelayError("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 Phantom Number"); return; }
    if (target === selfNumber) { setRelayError("\u041D\u0435\u043B\u044C\u0437\u044F \u043D\u0430\u0447\u0430\u0442\u044C \u0447\u0430\u0442 \u0441 \u0441\u043E\u0431\u0441\u0442\u0432\u0435\u043D\u043D\u044B\u043C \u043D\u043E\u043C\u0435\u0440\u043E\u043C"); return; }
    setNewChatNumber("");
    setMenuPanel(null);
    openChat(target);
  }, [newChatNumber, openChat, selfNumber]);

  const sendMessage = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    // S10.1: U+0000 из пользовательского текста вырезается всегда (маркер meta1)
    const text = stripNul(messageText).trim();
    if (!text || !activePeer || !selfNumber) return;
    // Мультиаккаунт: после каждого await аккаунт мог смениться — тогда отправка отменяется
    const me = selfNumber;
    if (text.length > TEXT_MAX_CHARS) {
      phantomToast(`Сообщение длиннее ${TEXT_MAX_CHARS} символов`, "warning");
      return;
    }

    if (activePeer === SAVED_MESSAGES_KEY) {
      appendMessage(SAVED_MESSAGES_KEY, {
        id: nowId(), from: selfNumber, to: SAVED_MESSAGES_KEY,
        text, createdAt: Date.now(), direction: "out",
        status: "sent",
      });
      setMessageText("");
      setReplyTo(null);
      setDrafts(prev => { const d = { ...prev }; delete d[SAVED_MESSAGES_KEY]; return d; });
      return;
    }

    const keys = keysRef.current;

    if (!keys) {
      setRelayError("\u041A\u043B\u044E\u0447\u0438 \u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u0438\u044F \u043D\u0435 \u0433\u043E\u0442\u043E\u0432\u044B. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043F\u043E\u0437\u0436\u0435.");
      return;
    }
    // S10.3/Q7: смена ключа собеседника не подтверждена — отправка заблокирована
    if (!canSendTo(activePeer)) {
      phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning");
      return;
    }

    // S1: ключ только из lookup_result; нет — ждём ≤5 с, «старый» (>5 мин) — освежаем ≤1,5 с
    const hadKey = !!peerKeysRef.current[activePeer];
    if (!hadKey) setRelayError("\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u043A\u043B\u044E\u0447\u0430 \u0441\u043E\u0431\u0435\u0441\u0435\u0434\u043D\u0438\u043A\u0430...");
    const peerKey = await resolvePeerKey(activePeer);
    if (selfNumberRef.current !== me) return;
    if (!hadKey) setRelayError("");
    if (!peerKey) {
      setRelayError(PEER_KEY_UNAVAILABLE_ERROR);
      return;
    }
    const trusted = await ensurePeerKeyTrusted(activePeer, peerKey);
    if (selfNumberRef.current !== me) return;
    if (!trusted) {
      phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning");
      return;
    }
    // S5: на провод — только { messageId, from }, без текста цитаты
    const replyWire = toReplyWire(replyTo);

    const msgId = nowId();
    try {
      // WEB-11: настройка чата приоритетнее глобального «Burn After Read по умолчанию»
      const isBurn = chatBurnSettings[activePeer] ?? privacyRef.current.burnAfterRead ?? false;
      const sd: number | "read" | undefined = isBurn ? "read" : (selfDestructSec > 0 ? selfDestructSec : undefined);
      // S10.1: meta1 — цитата/самоуничтожение внутри E2E, снаружи только { type, toNumber, messageId, encryptedBlob }
      const meta1 = peerUsesMeta1(activePeer);
      const textPt = meta1 ? buildTextPayload({ id: msgId, text, replyTo: replyWire, sd }) : "";
      const blob = meta1
        ? await encrypt(textPt, selfNumber, activePeer, peerKey, { version: 2, keyNumber: selfNumber })
        : await encryptForPeer(text, selfNumber, activePeer, peerKey);
      const deviceBlobs = meta1
        ? await buildDeviceBlobs(activePeer, peerKey, blob, k => encrypt(textPt, selfNumber, activePeer, k, { version: 2, keyNumber: selfNumber }))
        : undefined;
      if (selfNumberRef.current !== me) return;

      const relayPayload: RelayOutbound = {
        type: "message",
        toNumber: activePeer,
        encryptedBlob: blob,
        messageId: msgId,
        ...(deviceBlobs ? { deviceBlobs } : {}),
      };
      if (!meta1) {
        if (replyWire) relayPayload.replyTo = replyWire;
        if (sd !== undefined) relayPayload.selfDestruct = sd;
      }

      // P2P v2 §3.5: DC, если открыт (delivered — по delivery_ack, иначе через 10 с повтор через
      // relay тем же messageId); иначе relay; relay недоступен — любой открытый DC.
      const dcFrame: Record<string, unknown> = { type: "message", messageId: msgId, encryptedBlob: blob };
      if (!meta1) {
        if (replyWire) dcFrame.replyTo = replyWire;
        if (sd !== undefined) dcFrame.selfDestruct = sd;
      }
      const transport = sendPeerMessage(activePeer, msgId, relayPayload, dcFrame);
      const ok = transport !== null;
      markSentTo(activePeer); // S4: отправка запущена пользователем
      appendMessage(activePeer, {
        id: msgId, from: selfNumber, to: activePeer,
        text, createdAt: Date.now(), direction: "out",
        failed: !ok,
        status: ok ? "sent" : undefined,
        transport: transport ?? undefined,
        // Локально тоже без текста: цитата рендерится из истории по messageId (S5)
        replyTo: replyWire,
        selfDestruct: selfDestructSec > 0 ? selfDestructSec : undefined,
        selfDestructAt: selfDestructSec > 0 ? Date.now() + selfDestructSec * 1000 : undefined,
        burnAfterRead: isBurn || undefined,
      });
      setMessageText("");
      setReplyTo(null);
      setDrafts(prev => { const d = { ...prev }; delete d[activePeer]; return d; });
    } catch {
      setRelayError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435");
    }
  }, [activePeer, appendMessage, markSentTo, messageText, selfNumber, sendPeerMessage, resolvePeerKey, encryptForPeer, peerUsesMeta1, canSendTo, ensurePeerKeyTrusted, phantomToast, replyTo, selfDestructSec, chatBurnSettings]);


  const sendReaction = useCallback(async (messageId: string, emoji: string, remove = false) => {
    if (!activePeer) return;
    const peer = activePeer;
    const me = selfNumber;
    if (peer !== SAVED_MESSAGES_KEY) {
      if (!canSendTo(peer)) { phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning"); setReactionMsgId(null); return; }
      // L7 (ревью): формат выбирается только ПОСЛЕ разрешения ключа/capabilities (lookup) —
      // иначе эмодзи мог бы уйти открытым текстом meta1-собеседнику, чьи caps ещё не пришли
      const peerKey = await resolvePeerKey(peer);
      if (selfNumberRef.current !== me) return;
      if (!peerKey) { setRelayError(PEER_KEY_UNAVAILABLE_ERROR); return; }
      const reactionTrusted = await ensurePeerKeyTrusted(peer, peerKey);
      if (selfNumberRef.current !== me) return;
      if (!reactionTrusted) { phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning"); setReactionMsgId(null); return; }
      if (peerUsesMeta1(peer)) {
        // S10.1: эмодзи и remove — внутри E2E; relay видит только факт реакции на messageId
        try {
          const reactionPt = buildReactionPayload({ target: messageId, emoji, remove });
          const blob = await encrypt(reactionPt, selfNumber, peer, peerKey, { version: 2, keyNumber: selfNumber });
          const deviceBlobs = await buildDeviceBlobs(peer, peerKey, blob, k => encrypt(reactionPt, selfNumber, peer, k, { version: 2, keyNumber: selfNumber }));
          if (selfNumberRef.current !== me) return;
          sendPeerEvent({ type: "reaction", toNumber: peer, messageId, encryptedBlob: blob, ...(deviceBlobs ? { deviceBlobs } : {}) });
        } catch {
          setRelayError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435");
          return;
        }
      } else {
        sendPeerEvent({ type: "reaction", toNumber: peer, messageId, emoji, remove });
      }
    }
    setMessages(prev => {
      const msgs = prev[peer];
      if (!msgs) return prev;
      const idx = msgs.findIndex(m => m.id === messageId);
      if (idx === -1) return prev;
      const updated = [...msgs];
      const msg = { ...updated[idx] };
      const reactions = [...(msg.reactions || [])];
      if (remove) {
        const ri = reactions.findIndex(r => r.from === selfNumber && r.emoji === emoji);
        if (ri !== -1) reactions.splice(ri, 1);
      } else {
        reactions.push({ emoji, from: selfNumber, timestamp: Date.now() });
      }
      msg.reactions = reactions;
      updated[idx] = msg;
      return { ...prev, [peer]: updated };
    });
    setReactionMsgId(null);
  }, [activePeer, selfNumber, sendPeerEvent, canSendTo, ensurePeerKeyTrusted, peerUsesMeta1, resolvePeerKey, phantomToast]);

  // ── Fetch ICE servers ──
  // TURN credentials are minted per request and expire: the relay refuses an
  // expired one, and coturn ends a relay session when the credential it was
  // allocated with runs out. So instead of caching whatever the app saw at
  // start-up we pull a fresh set from `/api/ice` before every call and on every
  // ICE restart. `/api/ice` only hands out TURN against a live session token —
  // an anonymous fetch gets the STUN list.
  // Defence in depth: even though the backend already filters, we re-validate
  // here so that a compromised relay / MITM cannot feed the browser exotic ICE
  // URLs (data:, file:, javascript:).
  const ICE_SCHEMES = /^(?:stun|stuns|turn|turns):/i;
  const ICE_REFRESH_MARGIN_SEC = 300;

  const refreshIceServers = useCallback(async (): Promise<void> => {
    const inFlight = iceRefreshInFlightRef.current;
    if (inFlight) return inFlight;
    const task = (async () => {
      try {
        const res = await fetch("/api/ice", {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        const data = await res.json();
        if (!data?.ok || !Array.isArray(data.iceServers)) return;
        const sanitised: RTCIceServer[] = [];
        for (const raw of data.iceServers) {
          if (!raw || typeof raw !== "object") continue;
          const urls = Array.isArray(raw.urls) ? raw.urls : [raw.urls];
          const good: string[] = [];
          for (const u of urls) {
            if (typeof u === "string" && ICE_SCHEMES.test(u.trim())) good.push(u.trim());
          }
          if (!good.length) continue;
          const entry: RTCIceServer = { urls: good };
          if (typeof raw.username === "string") entry.username = raw.username;
          if (typeof raw.credential === "string") entry.credential = raw.credential;
          sanitised.push(entry);
        }
        if (!sanitised.length) return;
        iceServersRef.current = sanitised;
        iceExpiresAtRef.current = typeof data.expiresAt === "number" ? data.expiresAt : 0;
        slog.log("[WebRTC] ICE refreshed:", sanitised.length, "servers, TURN:", !!data.turn);
      } catch {
        /* keep whatever we had — STUN-only still connects on most networks */
      } finally {
        iceRefreshInFlightRef.current = null;
      }
    })();
    iceRefreshInFlightRef.current = task;
    return task;
  }, [token]);

  /** Guarantee the TURN credential outlives the call we are about to start. */
  // WEB-20 / CLAUDE.md: TURN-креды обновляются перед КАЖДЫМ звонком/P2P — coturn
  // рвёт релей-сессию по истечении креденшела, с которым она создана. Если /api/ice
  // недоступен, а старые ещё живы — звоним на них.
  const ensureFreshIce = useCallback(async (): Promise<void> => {
    await refreshIceServers();
  }, [refreshIceServers]);

  // Read through a ref inside createPeerConnection so its identity stays
  // stable across token rotations.
  const ensureFreshIceRef = useRef(ensureFreshIce);
  ensureFreshIceRef.current = ensureFreshIce;

  useEffect(() => {
    if (screen !== "messenger") return;
    void refreshIceServers();
    // Well inside the 1 h credential lifetime, so an incoming call never has to
    // wait for a round-trip before it can answer.
    const timer = setInterval(() => { void refreshIceServers(); }, 20 * 60 * 1000);
    return () => clearInterval(timer);
  }, [screen, refreshIceServers]);

  // ── WebRTC call functions ──
  const cleanupCall = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    callTimerRef.current = null;
    if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
    callTimeoutRef.current = null;
    setCallState("idle");
    setCallPeer("");
    callPeerRef.current = ""; // Sync immediately to prevent stale call_incoming processing
    setCallMuted(false);
    setCallVideoEnabled(false);
    setCallDuration(0);
    setPeerMediaState({ audio: true, video: false });
    incomingSdpRef.current = null;
    iceCandidateQueueRef.current = [];
    remoteDescSetRef.current = false;
    remoteDtlsFpRef.current = null;
    if (pinFailTimerRef.current) clearTimeout(pinFailTimerRef.current);
    pinFailTimerRef.current = null;
    callIdRef.current = "";
    isCallerRef.current = false;
    setCameraFacing("user");
    iceRestartAttempts.current = 0;
    makingOfferRef.current = false;
    if (iceDisconnectTimerRef.current) clearTimeout(iceDisconnectTimerRef.current);
    iceDisconnectTimerRef.current = null;
  }, []);

  const cleanupCallRef = useRef(cleanupCall);

  // WEB-17: код звонка считается, когда обе стороны выставили SDP (connected);
  // при завершении звонка сбрасывается.
  useEffect(() => {
    if (callState !== "connected") { setCallSasCode(""); return; }
    const pc = pcRef.current;
    let cancelled = false;
    void callSas(pc?.localDescription?.sdp, pc?.remoteDescription?.sdp)
      .then(code => { if (!cancelled) setCallSasCode(code || ""); })
      .catch(() => { if (!cancelled) setCallSasCode(""); });
    return () => { cancelled = true; };
  }, [callState]);
  // P2P v2 §7.3: «Напрямую» / «Через TURN» — после connected, на каждую смену iceConnectionState
  // и раз в 5 с. Адреса и кандидаты не логируются.
  useEffect(() => {
    if (callState !== "connected") { setCallPath(""); return; }
    const pc = pcRef.current;
    if (!pc) return;
    let cancelled = false;
    const update = () => {
      void detectCallPath(pc).then(p => { if (!cancelled && p) setCallPath(p); }).catch(() => {});
    };
    update();
    pc.addEventListener("iceconnectionstatechange", update);
    const timer = setInterval(update, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      pc.removeEventListener("iceconnectionstatechange", update);
    };
  }, [callState]);
  cleanupCallRef.current = cleanupCall;

  /** Codec preference — disabled, using natural VP8 negotiation (H.264 HW encoder fails on some Android devices) */
  const preferH264Transceiver = (_pc: RTCPeerConnection) => {};
  const preferH264InSdp = (sdpText: string): string => sdpText;

  const createPeerConnection = useCallback((peer: string) => {
    // WEB-08: не оставляем висящий PeerConnection предыдущего звонка
    if (pcRef.current) {
      try { pcRef.current.close(); } catch { /* ignore */ }
      pcRef.current = null;
    }
    const servers = iceServersRef.current;
    const hasTurn = servers.some(s => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some(u => typeof u === "string" && u.startsWith("turn"));
    });
    // S10.5/Q9: relay-only, если включено «Скрывать IP в звонках» или собеседник не в контактах
    // (как в Signal); иначе все типы, но `host` не уходит ни триклом, ни в SDP.
    const relayOnly = privacyRef.current.privateCalls || !Object.prototype.hasOwnProperty.call(contactsRef.current, peer);
    slog.log("[WebRTC] Creating PeerConnection, iceServers:", servers.length, "hasTURN:", hasTurn, "relayOnly:", relayOnly);
    if (relayOnly && !hasTurn) {
      setRelayError("TURN-сервер недоступен: звонок без раскрытия IP-адреса может не установиться");
    }
    const pc = new RTCPeerConnection({
      iceServers: servers,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceTransportPolicy: relayOnly ? "relay" : "all",
    });
    // Allowed ICE candidate kinds: srflx (server-reflexive — public IP seen
    // through NAT) and relay (via TURN). We deliberately DROP `host`
    // candidates (LAN IPs like 192.168.x.x / link-local fe80::) and `prflx`
    // (peer-reflexive, not observed here anyway) because they leak the
    // user's local network topology to the other side of the call.
    const ALLOWED_ICE_TYPES = new Set(["srflx", "relay"]);
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        slog.log("[WebRTC] ICE gathering complete");
        return;
      }
      const c = e.candidate;
      if (!c.type || !ALLOWED_ICE_TYPES.has(c.type)) {
        slog.log("[WebRTC] ICE filter drop:", c.type);
        return;
      }
      slog.log("[WebRTC] ICE candidate:", c.type, c.protocol);
      sendRelay(withCallId({ type: "ice_candidate", toNumber: peer, candidate: sanitizeIceCandidate(c.toJSON()) }));
    };
    pc.onicegatheringstatechange = () => slog.log("[WebRTC] ICE gathering:", pc.iceGatheringState);
    pc.oniceconnectionstatechange = () => slog.log("[WebRTC] ICE connection:", pc.iceConnectionState);
    pc.ontrack = (e) => {
      slog.log("[WebRTC] ontrack:", e.track.kind);
      e.track.enabled = true;
      // Track state diagnostics
      e.track.onmute = () => slog.log("[WebRTC] track MUTED:", e.track.kind);
      e.track.onunmute = () => slog.log("[WebRTC] track UNMUTED:", e.track.kind);
      e.track.onended = () => slog.log("[WebRTC] track ENDED:", e.track.kind);
      let stream: MediaStream;
      if (e.streams && e.streams[0]) {
        stream = e.streams[0];
      } else {
        stream = remoteStreamRef.current ?? new MediaStream();
        stream.addTrack(e.track);
      }
      remoteStreamRef.current = stream;
      for (const t of stream.getAudioTracks()) t.enabled = true;
      for (const t of stream.getVideoTracks()) t.enabled = true;
      if (e.track.kind === "video") {
        setCallIsVideo(true);
        setPeerMediaState(prev => ({ ...prev, video: true }));
      }

      // Attach stream to elements and call play() — critical for audio in Safari
      if (remoteAudioRef.current) {
        if (remoteAudioRef.current.srcObject !== stream) remoteAudioRef.current.srcObject = stream;
        remoteAudioRef.current.play().catch(() => {});
      }
      if (remoteVideoRef.current) {
        if (remoteVideoRef.current.srcObject !== stream) remoteVideoRef.current.srcObject = stream;
        if (e.track.kind === "video") remoteVideoRef.current.play().catch(() => {});
      }
      // Deferred: covers race where React refs aren't mounted yet
      setTimeout(() => {
        if (remoteAudioRef.current) {
          if (remoteAudioRef.current.srcObject !== stream) remoteAudioRef.current.srcObject = stream;
          remoteAudioRef.current.play().catch(() => {});
        }
        if (remoteVideoRef.current) {
          if (remoteVideoRef.current.srcObject !== stream) remoteVideoRef.current.srcObject = stream;
          if (e.track.kind === "video") remoteVideoRef.current.play().catch(() => {});
        }
      }, 300);
    };
    // Renegotiation handler — needed when video track is added mid-call
    pc.onnegotiationneeded = async () => {
      slog.log("[WebRTC] negotiationneeded, signalingState:", pc.signalingState, "makingOffer:", makingOfferRef.current);
      if (makingOfferRef.current) return;
      try {
        if (pc.signalingState !== "stable") return;
        makingOfferRef.current = true;
        preferH264Transceiver(pc);
        const offer = await pc.createOffer();
        const munged = offer.sdp ? preferH264InSdp(offer.sdp) : offer.sdp;
        await pc.setLocalDescription({ type: offer.type, sdp: munged });
        sendRelay(withCallId({ type: "call_offer", toNumber: peer, sdp: { type: offer.type, sdp: stripSdpCandidates(munged) } as RTCSessionDescriptionInit, media: "video" }));
      } catch (err) {
        slog.warn("[WebRTC] renegotiation failed:", (err as Error)?.name);
      } finally {
        makingOfferRef.current = false;
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;

      if (state === "connected") {
        iceRestartAttempts.current = 0;
        if (iceDisconnectTimerRef.current) {
          clearTimeout(iceDisconnectTimerRef.current);
          iceDisconnectTimerRef.current = null;
        }
        // Соединение вернулось после ICE-рестарта — убрать «Переподключение…»
        setCallState(prev => (prev === "reconnecting" ? "connected" : prev));
        // Single controlled play() after DTLS handshake — Safari needs explicit play()
        const ensurePlayback = () => {
          if (!remoteStreamRef.current) return;
          if (remoteAudioRef.current) {
            if (remoteAudioRef.current.srcObject !== remoteStreamRef.current) {
              remoteAudioRef.current.srcObject = remoteStreamRef.current;
            }
            remoteAudioRef.current.play().catch(() => {});
          }
          if (remoteVideoRef.current) {
            if (remoteVideoRef.current.srcObject !== remoteStreamRef.current) {
              remoteVideoRef.current.srcObject = remoteStreamRef.current;
            }
            remoteVideoRef.current.play().catch(() => {});
          }
        };
        ensurePlayback();
        // Retry with increasing delays for Safari timing issues
        setTimeout(ensurePlayback, 500);
        // Video recovery at 2s: if readyState=0, force srcObject reassign
        setTimeout(() => {
          const vid = remoteVideoRef.current;
          if (vid && vid.readyState < 2 && remoteStreamRef.current) {
            slog.log("[WebRTC] Video recovery: readyState=", vid.readyState);
            vid.srcObject = null;
            vid.srcObject = remoteStreamRef.current;
            vid.play().catch(() => {});
          }
        }, 2000);
      }

      // ICE-рестарт — один путь для disconnected (после таймера) и failed. makingOfferRef держится
      // весь рестарт, включая запрос /api/ice: иначе чужой offer, пришедший во время запроса, не
      // виден как коллизия, а наш createOffer/setLocalDescription потом падал бы в
      // have-remote-offer (InvalidStateError) и рвал звонок.
      const giveUp = (text: string) => {
        // Собеседник не должен ждать своего таймаута
        sendRelay(withCallId({ type: "call_hangup", toNumber: peer }));
        setRelayError(text);
        setCallState("failed");
        setTimeout(() => cleanupCallRef.current(), 3000);
      };
      const performIceRestart = async () => {
        // Идёт чужая/своя негоциация — рестарт создал бы коллизию; её разрешит текущий обмен
        if (pcRef.current !== pc || pc.signalingState !== "stable" || makingOfferRef.current) return;
        if (iceRestartAttempts.current >= MAX_ICE_RESTART_ATTEMPTS) {
          giveUp(state === "failed" ? "Не удалось соединиться" : "Звонок прервался");
          return;
        }
        const seqBefore = remoteOfferSeqRef.current;
        makingOfferRef.current = true;
        try {
          setCallState("reconnecting");
          iceRestartAttempts.current += 1;
          // The old credential may be exactly why the relay dropped us.
          await ensureFreshIceRef.current();
          // Пока ждали /api/ice, приняли offer собеседника — переговоры прошли без нас
          if (pcRef.current !== pc || pc.signalingState !== "stable" || remoteOfferSeqRef.current !== seqBefore) return;
          try { pc.setConfiguration({ ...pc.getConfiguration(), iceServers: iceServersRef.current }); } catch { /* браузер без setConfiguration */ }
          const offer = await pc.createOffer({ iceRestart: true });
          if (pc.signalingState !== "stable" || remoteOfferSeqRef.current !== seqBefore) return;
          await pc.setLocalDescription(offer);
          sendRelay(withCallId({ type: "call_offer", toNumber: peer, sdp: { type: offer.type, sdp: stripSdpCandidates(offer.sdp) } as RTCSessionDescriptionInit }));
        } catch (err) {
          // Чужой offer перехватил переговоры — не ошибка
          if ((err as Error)?.name === "InvalidStateError" || pc.signalingState !== "stable") return;
          giveUp("Соединение потеряно");
        } finally {
          makingOfferRef.current = false;
        }
      };

      if (state === "disconnected") {
        if (iceDisconnectTimerRef.current) clearTimeout(iceDisconnectTimerRef.current);
        iceDisconnectTimerRef.current = setTimeout(() => {
          if (pc.connectionState !== "disconnected") return;
          void performIceRestart();
        }, ICE_DISCONNECT_TIMEOUT_MS);
      }

      if (state === "failed") {
        void performIceRestart();
      }
    };
    pcRef.current = pc;
    return pc;
  }, [sendRelay, withCallId]);

  const startCall = useCallback(async (peer: string, withVideo: boolean) => {
    if (!peer || callState !== "idle" || callPreparingRef.current) return;
    // Мультиаккаунт: звонок уходит только от номера, под которым нажали «Позвонить»
    const me = selfNumberRef.current;
    if (!me) return;
    // S10.3/Q7: исходящий звонок — под тем же гейтом, что и сообщения
    if (!canSendTo(peer)) { phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning"); return; }
    // Подготовка звонка (ожидание ключа до 5 с) — аккаунт в это время не переключается
    callPreparingRef.current = true;
    setCallPreparing(true);
    try {
      // H1: до звонка — та же синхронная сверка ключа из lookup с подтверждённым
      const peerKey = await resolvePeerKey(peer);
      if (selfNumberRef.current !== me) return;
      if (peerKey) {
        const callTrusted = await ensurePeerKeyTrusted(peer, peerKey);
        if (selfNumberRef.current !== me) return;
        if (!callTrusted) { phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning"); return; }
      }
    } finally {
      callPreparingRef.current = false;
      setCallPreparing(false);
    }
    if (!canSendTo(peer) || callPeerRef.current) return;
    setCallPeer(peer);
    callPeerRef.current = peer; // S4: сразу, чтобы call_answer/ice сверялись с актуальным peer
    isCallerRef.current = true;
    callIdRef.current = newCallId(); // Q10: UUID инициатора во всех событиях звонка
    remoteDtlsFpRef.current = null; // CR-01: пин — из первого answer
    setCallState("calling");
    setCallIsVideo(withVideo);
    setCallVideoEnabled(withVideo);
    setCallMuted(false);
    setCallDuration(0);
    setPeerMediaState({ audio: true, video: withVideo });
    iceCandidateQueueRef.current = [];
    remoteDescSetRef.current = false;

    if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
    callTimeoutRef.current = setTimeout(() => {
      // Нет ответа за CALL_TIMEOUT_MS — сообщаем вызываемому, иначе у него звонок «висит»
      if (callPeerRef.current) sendRelay(withCallId({ type: "call_hangup", toNumber: callPeerRef.current }));
      cleanupCallRef.current();
    }, CALL_TIMEOUT_MS);

    try {
      // Overlap the credential fetch with the (possibly slow) permission prompt.
      const icePromise = ensureFreshIce();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: withVideo ? { facingMode: "user", width: 640, height: 480, frameRate: { ideal: 30 } } : false,
      });
      slog.log("[WebRTC] getUserMedia OK, tracks:", stream.getTracks().length);
      // Аккаунт сменился/звонок уже сброшен во время запроса доступа — call_offer не отправляем
      const callAborted = () => selfNumberRef.current !== me || callPeerRef.current !== peer;
      if (callAborted()) { stream.getTracks().forEach(t => t.stop()); return; }
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      await icePromise;
      if (callAborted()) { stream.getTracks().forEach(t => t.stop()); return; }
      const pc = createPeerConnection(peer);
      makingOfferRef.current = true;
      stream.getTracks().forEach(t => { pc.addTrack(t, stream); });
      preferH264Transceiver(pc);

      const offer = await pc.createOffer();
      const mungedOfferSdp = offer.sdp ? preferH264InSdp(offer.sdp) : offer.sdp;
      await pc.setLocalDescription({ type: offer.type, sdp: mungedOfferSdp });
      makingOfferRef.current = false;
      if (callAborted()) { try { pc.close(); } catch { /* ignore */ } stream.getTracks().forEach(t => t.stop()); return; }
      sendRelay(withCallId({ type: "call_offer", toNumber: peer, sdp: { type: offer.type, sdp: stripSdpCandidates(mungedOfferSdp) } as RTCSessionDescriptionInit, media: withVideo ? "video" : "audio" }));
    } catch (err: any) {
      const errName = err?.name || "";
      if (errName === "NotAllowedError") {
        setRelayError("\u0414\u043E\u0441\u0442\u0443\u043F \u043A \u043A\u0430\u043C\u0435\u0440\u0435/\u043C\u0438\u043A\u0440\u043E\u0444\u043E\u043D\u0443 \u0437\u0430\u043F\u0440\u0435\u0449\u0451\u043D. \u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u0435 \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430");
      } else if (errName === "NotFoundError") {
        setRelayError("\u041A\u0430\u043C\u0435\u0440\u0430 \u0438\u043B\u0438 \u043C\u0438\u043A\u0440\u043E\u0444\u043E\u043D \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u044B");
      } else if (errName === "NotReadableError") {
        setRelayError("\u0423\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u0437\u0430\u043D\u044F\u0442\u043E \u0434\u0440\u0443\u0433\u0438\u043C \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435\u043C");
      } else {
        setRelayError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F \u043A \u043C\u0435\u0434\u0438\u0430\u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430\u043C");
      }
      cleanupCallRef.current();
    }
  }, [callState, createPeerConnection, ensureFreshIce, sendRelay, withCallId, canSendTo, ensurePeerKeyTrusted, resolvePeerKey, phantomToast]);

  const answerCall = useCallback(async (fromNumber: string, sdp: RTCSessionDescriptionInit) => {
    // CR-01: отложенный offer сверяется с пином до создания PeerConnection и setRemoteDescription
    if (!acceptRemoteCallSdp(fromNumber, sdp?.sdp)) return;
    try {
      const icePromise = ensureFreshIce();
      const hasVideo = sdp.sdp?.includes("m=video") ?? false;


      // Try to get local media — proceed without it if denied (receive-only mode)
      let stream: MediaStream | null = null;
      let localHasVideo = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: hasVideo ? { facingMode: "user", width: 640, height: 480, frameRate: { ideal: 30 } } : false,
        });
        localHasVideo = hasVideo && stream.getVideoTracks().length > 0;
      } catch (mediaErr: any) {
        slog.warn("[WebRTC] getUserMedia failed, proceeding in receive-only mode:", mediaErr?.name);
        // Try audio-only fallback
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch {
          slog.warn("[WebRTC] Audio-only getUserMedia also failed");
        }
      }

      if (stream) {
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      }
      setCallVideoEnabled(localHasVideo);
      setPeerMediaState({ audio: true, video: hasVideo });

      await icePromise;
      const pc = createPeerConnection(fromNumber);
      if (stream) {
        stream.getTracks().forEach(t => pc.addTrack(t, stream!));
      }
      // If no local video track but offer has video, add recvonly transceiver
      if (hasVideo && (!stream || !stream.getVideoTracks().length)) {
        pc.addTransceiver("video", { direction: "recvonly" });
      }

      await pc.setRemoteDescription(sdp);
      remoteDescSetRef.current = true;
      // Set codec preferences AFTER setRemoteDescription so all transceivers are visible
      preferH264Transceiver(pc);
      for (const c of iceCandidateQueueRef.current) {
        try { await pc.addIceCandidate(c); } catch (e) { slog.warn("ICE candidate failed:", (e as Error)?.name); }
      }
      iceCandidateQueueRef.current = [];
      const answer = await pc.createAnswer();
      // Apply SDP-level H.264 reorder (matches Android preferH264InSdp)
      const mungedSdp = answer.sdp ? preferH264InSdp(answer.sdp) : answer.sdp;
      await pc.setLocalDescription({ type: answer.type, sdp: mungedSdp });

      if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = null;

      setCallState("connected");
      setCallDuration(0);
      callTimerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000);

      sendRelay(withCallId({ type: "call_answer", toNumber: fromNumber, sdp: { type: answer.type, sdp: stripSdpCandidates(mungedSdp) } as RTCSessionDescriptionInit }));
      sendRelay(withCallId({ type: "call_media_toggle", toNumber: fromNumber, audio: !!stream, video: localHasVideo }));

      // Diagnostic: periodic video stats to determine if video data is arriving
      const diagInterval = setInterval(async () => {
        try {
          if (pc.connectionState !== "connected") return;
          const stats = await pc.getStats();
          let foundVideoIn = false;
          const reportTypes: string[] = [];
          stats.forEach((report: any) => {
            const rKind = report.kind || report.mediaType; // Safari may use mediaType
            if (report.type === "inbound-rtp" && rKind === "video") {
              foundVideoIn = true;
              slog.log("[WebRTC] VIDEO-DIAG inbound: bytes=", report.bytesReceived, "pkts=", report.packetsReceived, "decoded=", report.framesDecoded, "dropped=", report.framesDropped, "decoder=", report.decoderImplementation, "nack=", report.nackCount, "pli=", report.pliCount, "jitter=", report.jitter);
            }
            if (report.type === "inbound-rtp" && rKind === "audio") {
              slog.log("[WebRTC] VIDEO-DIAG audio-in: bytes=", report.bytesReceived, "pkts=", report.packetsReceived);
            }
            if (report.type === "outbound-rtp" && rKind === "video") {
              slog.log("[WebRTC] VIDEO-DIAG outbound: bytes=", report.bytesSent, "pkts=", report.packetsSent, "frames=", report.framesEncoded);
            }
            if (report.type === "codec" && report.mimeType?.includes("video")) {
              slog.log("[WebRTC] VIDEO-DIAG codec:", report.mimeType, "pt=", report.payloadType, "fmtp=", report.sdpFmtpLine);
            }
            reportTypes.push(`${report.type}:${rKind || ""}`);
          });
          if (!foundVideoIn) {
            // Dump all report types so we can see what Safari provides
            slog.log("[WebRTC] VIDEO-DIAG: NO inbound-rtp video! report-types:", [...new Set(reportTypes)].join(", "));
            slog.log("[WebRTC] VIDEO-DIAG receivers:", pc.getReceivers().map(r => `${r.track?.kind}:en=${r.track?.enabled},muted=${r.track?.muted},live=${r.track?.readyState}`));
          }
          const vid = remoteVideoRef.current;
          if (vid) {
            const vTracks = (vid.srcObject as MediaStream)?.getVideoTracks?.();
            slog.log("[WebRTC] VIDEO-DIAG element: rs=", vid.readyState, "w=", vid.videoWidth, "h=", vid.videoHeight, "paused=", vid.paused, "tracks=", vTracks?.map(t => `en=${t.enabled},muted=${t.muted},live=${t.readyState}`));
          }
        } catch (e) { slog.warn("[WebRTC] VIDEO-DIAG error:", (e as Error)?.name); }
      }, 3000);
      // Stop diagnostic after 30s or on cleanup
      setTimeout(() => clearInterval(diagInterval), 30000);
      const origCleanup = cleanupCallRef.current;
      cleanupCallRef.current = () => { clearInterval(diagInterval); origCleanup(); };
    } catch (err) {
      slog.error("[WebRTC] answerCall failed:", (err as Error)?.name);
      setRelayError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u0438\u043D\u044F\u0442\u044C \u0437\u0432\u043E\u043D\u043E\u043A");
      cleanupCallRef.current();
    }
  }, [createPeerConnection, ensureFreshIce, sendRelay, withCallId, acceptRemoteCallSdp]);

  const hangupCall = useCallback(() => {
    if (callPeer) {
      sendRelay(withCallId({ type: "call_hangup", toNumber: callPeer }));
    }
    cleanupCall();
  }, [callPeer, sendRelay, cleanupCall, withCallId]);

  const rejectCall = useCallback(() => {
    if (callPeer) {
      sendRelay(withCallId({ type: "call_reject", toNumber: callPeer }));
    }
    setCallState("idle");
    setCallPeer("");
    callIdRef.current = "";
    iceCandidateQueueRef.current = [];
    incomingSdpRef.current = null;
    remoteDtlsFpRef.current = null;
  }, [callPeer, sendRelay, withCallId]);

  const toggleCallMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = callMuted;
      setCallMuted(!callMuted);
      sendRelay(withCallId({ type: "call_media_toggle", toNumber: callPeer, audio: audioTrack.enabled, video: callVideoEnabled }));
    }
  }, [callMuted, callPeer, callVideoEnabled, sendRelay, withCallId]);

  const toggleCallVideo = useCallback(async () => {
    const stream = localStreamRef.current;
    const pc = pcRef.current;
    if (!stream || !pc) return;
    const newVideoEnabled = !callVideoEnabled;
    if (callVideoEnabled) {
      stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t); });
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(null);
      setCallVideoEnabled(false);
    } else {
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640, height: 480, frameRate: { ideal: 30 } } });
        const videoTrack = videoStream.getVideoTracks()[0];
        stream.addTrack(videoTrack);
        // Reuse existing video sender/transceiver if available (avoids renegotiation)
        const existingVideoTransceiver = pc.getTransceivers().find(t =>
          t.sender.track === null && t.receiver.track?.kind === "video"
        );
        const existingVideoSender = pc.getSenders().find(s =>
          s.track === null && s !== pc.getSenders().find(s2 => s2.track?.kind === "audio")
        );
        if (existingVideoTransceiver) {
          await existingVideoTransceiver.sender.replaceTrack(videoTrack);
          if (existingVideoTransceiver.direction === "recvonly") {
            existingVideoTransceiver.direction = "sendrecv";
          }
        } else if (existingVideoSender) {
          await existingVideoSender.replaceTrack(videoTrack);
        } else {
          // No existing video transceiver — addTrack triggers onnegotiationneeded
          pc.addTrack(videoTrack, stream);
        }
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        setCallVideoEnabled(true);
      } catch (err: any) {
        slog.error("[WebRTC] toggleVideo failed:", err?.name);
        setRelayError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u043A\u0430\u043C\u0435\u0440\u0443: " + (err?.name || err?.message || ""));
      }
    }
    sendRelay(withCallId({ type: "call_media_toggle", toNumber: callPeer, audio: !callMuted, video: newVideoEnabled }));
  }, [callVideoEnabled, callMuted, callPeer, sendRelay, withCallId]);

  const switchCamera = useCallback(async () => {
    const pc = pcRef.current;
    const stream = localStreamRef.current;
    if (!pc || !stream) return;
    const sender = pc.getSenders().find(s => s.track?.kind === "video");
    if (!sender) return;
    const currentTrack = sender.track;
    if (currentTrack) currentTrack.stop();
    const newFacing = cameraFacing === "user" ? "environment" : "user";
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: newFacing, width: 640, height: 480 },
      });
      const newTrack = newStream.getVideoTracks()[0];
      await sender.replaceTrack(newTrack);
      stream.getVideoTracks().forEach(t => stream.removeTrack(t));
      stream.addTrack(newTrack);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setCameraFacing(newFacing);
    } catch {
      setRelayError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u043A\u0430\u043C\u0435\u0440\u0443");
    }
  }, [cameraFacing]);

  // ── Keep WebRTC call alive when tab is hidden ──
  useEffect(() => {
    if (callState !== "connected") return;
    const handleVisibilityChange = async () => {
      const stream = localStreamRef.current;
      const pc = pcRef.current;
      if (!stream) return;
      if (document.hidden) {
        const videoTrack = stream.getVideoTracks()[0];
        videoEnabledBeforeHiddenRef.current = !!videoTrack?.enabled;
        if (videoTrack) videoTrack.enabled = false;
        if (pc) {
          const videoSender = pc.getSenders().find(s => s.track?.kind === "video");
          if (videoSender) {
            try {
              const params = videoSender.getParameters();
              if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
              }
              params.encodings[0].maxBitrate = 0;
              await videoSender.setParameters(params);
            } catch { /* ignore */ }
          }
        }
      } else {
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack && videoEnabledBeforeHiddenRef.current) {
          videoTrack.enabled = true;
        }
        if (pc) {
          const videoSender = pc.getSenders().find(s => s.track?.kind === "video");
          if (videoSender) {
            try {
              const params = videoSender.getParameters();
              if (params.encodings && params.encodings.length > 0) {
                delete params.encodings[0].maxBitrate;
                await videoSender.setParameters(params);
              }
            } catch { /* ignore */ }
          }
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [callState]);

  // ── Keyboard shortcuts for call controls ──
  useEffect(() => {
    if (callState === "idle") return;
    const handleCallKeydown = (e: KeyboardEvent) => {
      if (appLockedRef.current) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") { e.preventDefault(); hangupCall(); }
      else if (e.key === "m" || e.key === "M") { e.preventDefault(); toggleCallMute(); }
      else if (e.key === "v" || e.key === "V") { e.preventDefault(); toggleCallVideo(); }
    };
    window.addEventListener("keydown", handleCallKeydown);
    return () => window.removeEventListener("keydown", handleCallKeydown);
  }, [callState, hangupCall, toggleCallMute, toggleCallVideo]);

  // ── W-10: Ringtone for incoming calls ──
  useEffect(() => {
    if (callState === "ringing") {
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 440;
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        // Ring pattern: 1s on, 2s off repeating
        const scheduleRing = () => {
          const now = ctx.currentTime;
          for (let i = 0; i < 3; i++) {
            gain.gain.setValueAtTime(0.25, now + i * 3);
            gain.gain.setValueAtTime(0, now + i * 3 + 1);
          }
        };
        scheduleRing();
        const interval = setInterval(scheduleRing, 9000);
        ringtoneRef.current = { ctx, osc, gain };
        return () => {
          clearInterval(interval);
          try { osc.stop(); } catch { /* already stopped */ }
          try { ctx.close(); } catch { /* already closed */ }
          ringtoneRef.current = null;
        };
      } catch { /* AudioContext not available */ }
    } else if (ringtoneRef.current) {
      try { ringtoneRef.current.osc.stop(); } catch { /* ignore */ }
      try { ringtoneRef.current.ctx.close(); } catch { /* ignore */ }
      ringtoneRef.current = null;
    }
  }, [callState]);

  // ── Voice recording ──
  // Открыть полосу записи: getUserMedia/MediaRecorder (opus 24 кбит/с, WEB-15), таймер, пауза, лимит —
  // внутри VoiceRecorderBar; ошибки микрофона показывает он же.
  const startRecording = useCallback(() => {
    // Не начинаем запись, которую нельзя будет отправить: шифрование не готово, keyAlert, идёт звонок
    const loc = initialLocale();
    if (callState !== "idle") { phantomToast(tx(loc, "voice.inCall"), "info"); return; }
    if (!sessionReady || !activePeer) { phantomToast(tx(loc, "voice.notReady"), "info"); return; }
    if (!canSendTo(activePeer)) { phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning"); return; }
    setIsRecording(true);
  }, [callState, sessionReady, activePeer, canSendTo, phantomToast]);

  // \u0413\u043E\u0442\u043E\u0432\u0430\u044F \u0437\u0430\u043F\u0438\u0441\u044C \u0438\u0437 VoiceRecorderBar (durMs \u2014 \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0433\u043E \u0434\u043B\u044F meta1, Q2)
  // Возвращает false, если отправка отклонена до шифрования: полоса остаётся в «отправить/удалить»
  const sendVoiceMessage = useCallback(async (result: VoiceRecording): Promise<boolean> => {
    const me = selfNumber;
    if (!activePeer || !selfNumber || selfNumberRef.current !== me) return false;
    if (activePeer === SAVED_MESSAGES_KEY) {
      // «Избранное»: как у текста — только локально, без сети и ключей
      if (result.blob.size > MAX_ATTACHMENT_BYTES) { phantomToast(ATTACHMENT_LIMIT_TEXT, "warning"); return false; }
      try {
        const bytes = new Uint8Array(await result.blob.arrayBuffer());
        if (selfNumberRef.current !== me) return false;
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        appendMessage(SAVED_MESSAGES_KEY, {
          id: nowId(), from: selfNumber, to: SAVED_MESSAGES_KEY,
          text: `[Голосовое сообщение ${result.duration}с]`,
          createdAt: Date.now(), direction: "out",
          isVoice: true, duration: result.duration, voiceData: btoa(bin), mimeType: result.mime,
          voiceDurMs: result.durMs, voiceWave: result.wave,
          status: "sent",
        });
        setIsRecording(false);
        return true;
      } catch { return false; }
    }
    if (!canSendTo(activePeer)) { phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning"); return false; }
    // Q5: честный лимит от капа кадра relay (вместо молчаливого отказа relay)
    if (result.blob.size > MAX_ATTACHMENT_BYTES) { phantomToast(ATTACHMENT_LIMIT_TEXT, "warning"); return false; }
    const keys = keysRef.current;
    // S1: ключ только из lookup_result, «старый» освежается перед отправкой
    const peerKey = await resolvePeerKey(activePeer);
    if (selfNumberRef.current !== me) return false;
    if (!keys || !peerKey) {
      setRelayError("\u041D\u0435\u0442 \u043A\u043B\u044E\u0447\u0430 \u0441\u043E\u0431\u0435\u0441\u0435\u0434\u043D\u0438\u043A\u0430");
      return false;
    }
    const voiceTrusted = await ensurePeerKeyTrusted(activePeer, peerKey);
    if (selfNumberRef.current !== me) return false;
    if (!voiceTrusted) { phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning"); return false; }
    let queued = false; // true после постановки в транспорт: повторная отправка дала бы дубль
    try {
      const arrayBuffer = await result.blob.arrayBuffer();
      if (selfNumberRef.current !== me) return false;
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const msgId = nowId();
      let transport: "p2p" | "relay" | null = null;
      queued = false;
      const voiceMeta1 = peerUsesMeta1(activePeer);
      // Таймер самоуничтожения композера и «после прочтения» — как у текста; только для meta1 (sd внутри E2E)
      const voiceBurn = chatBurnSettings[activePeer] ?? privacyRef.current.burnAfterRead ?? false;
      const voiceSd: number | "read" | undefined = !voiceMeta1 ? undefined : (voiceBurn ? "read" : (selfDestructSec > 0 ? selfDestructSec : undefined));
      // S10.1: meta1 — длительность и mime внутри E2E, внешний тип "message"
      if (voiceMeta1) {
        const pt = buildVoicePayload({ id: msgId, mime: result.mime, durMs: result.durMs, data: base64, wave: result.wave, sd: voiceSd });
        if (utf8Length(pt) > MAX_META1_PLAINTEXT_BYTES) { phantomToast(ATTACHMENT_LIMIT_TEXT, "warning"); return false; }
        const blob = await encrypt(pt, selfNumber, activePeer, peerKey, { version: 2, keyNumber: selfNumber });
        const deviceBlobs = await buildDeviceBlobs(activePeer, peerKey, blob, k => encrypt(pt, selfNumber, activePeer, k, { version: 2, keyNumber: selfNumber }));
        if (selfNumberRef.current !== me) return false;
        // P2P v2 §3.5: голос — как текст (DC, если открыт; иначе relay с офлайн-очередью)
        transport = sendPeerMessage(activePeer, msgId,
          { type: "message", toNumber: activePeer, messageId: msgId, encryptedBlob: blob, ...(deviceBlobs ? { deviceBlobs } : {}) },
          { type: "message", messageId: msgId, encryptedBlob: blob });
      } else {
        const blob = await encryptForPeer(base64, selfNumber, activePeer, peerKey);
        if (selfNumberRef.current !== me) return false;
        // Легаси voice_message — только relay (по DC старые клиенты принимают лишь "message")
        transport = sendRelay({
          type: "voice_message",
          toNumber: activePeer,
          encryptedBlob: blob,
          duration: result.duration,
          mimeType: result.mime,
          messageId: msgId,
        } as RelayOutbound) ? "relay" : null;
      }
      queued = true;
      markSentTo(activePeer); // S4: отправка запущена пользователем
      appendMessage(activePeer, {
        id: msgId, from: selfNumber, to: activePeer,
        text: `[\u0413\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 ${result.duration}\u0441]`,
        createdAt: Date.now(), direction: "out",
        isVoice: true, duration: result.duration,
        voiceData: base64,
        voiceDurMs: result.durMs,
        voiceWave: result.wave,
        mimeType: result.mime,
        status: transport ? "sent" : undefined,
        failed: !transport,
        transport: transport ?? undefined,
        selfDestruct: voiceSd === "read" ? undefined : voiceSd,
        selfDestructAt: typeof voiceSd === "number" ? Date.now() + voiceSd * 1000 : undefined,
        burnAfterRead: voiceSd === "read" ? true : undefined,
      });
      setIsRecording(false);
      return true;
    } catch {
      setRelayError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435");
      if (queued) setIsRecording(false);
      return queued;
    }
  }, [chatBurnSettings, selfDestructSec, activePeer, appendMessage, markSentTo, resolvePeerKey, encryptForPeer, peerUsesMeta1, canSendTo, ensurePeerKeyTrusted, phantomToast, selfNumber, sendRelay, sendPeerMessage]);

  const cancelRecording = useCallback(() => {
    setIsRecording(false);
  }, []);

  // ── Swipe gesture handlers ──
  const handleBubbleTouchStart = useCallback((e: React.TouchEvent, msgId: string) => {
    const touch = e.touches[0];
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY, id: msgId };
  }, []);

  const handleBubbleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!swipeStartRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - swipeStartRef.current.x;
    const dy = touch.clientY - swipeStartRef.current.y;
    if (Math.abs(dy) > Math.abs(dx)) {
      swipeStartRef.current = null;
      setSwipingMsgId(null);
      setSwipeOffset(0);
      return;
    }
    if (dx > 10) {
      setSwipingMsgId(swipeStartRef.current.id);
      setSwipeOffset(Math.min(dx, 80));
    } else if (dx < -10) {
      setSwipingMsgId(swipeStartRef.current.id);
      setSwipeOffset(Math.max(dx, -80));
    }
  }, []);

  const handleBubbleTouchEnd = useCallback(() => {
    if (swipeOffset > 60 && swipingMsgId) {
      const msg = activeMessages.find(m => m.id === swipingMsgId);
      if (msg) {
        setReplyTo({ messageId: msg.id, text: msg.text, from: msg.from });
      }
    } else if (swipeOffset < -60 && swipingMsgId) {
      const msg = activeMessages.find(m => m.id === swipingMsgId);
      if (msg) setDeleteConfirmMsg(msg);
    }
    swipeStartRef.current = null;
    setSwipingMsgId(null);
    setSwipeOffset(0);
  }, [swipeOffset, swipingMsgId, activeMessages]);

  const handleBubbleMouseDown = useCallback((e: React.MouseEvent, msgId: string) => {
    swipeStartRef.current = { x: e.clientX, y: e.clientY, id: msgId };
  }, []);

  const handleBubbleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!swipeStartRef.current) return;
    const dx = e.clientX - swipeStartRef.current.x;
    const dy = e.clientY - swipeStartRef.current.y;
    if (Math.abs(dy) > Math.abs(dx)) {
      swipeStartRef.current = null;
      setSwipingMsgId(null);
      setSwipeOffset(0);
      return;
    }
    if (dx > 10) {
      setSwipingMsgId(swipeStartRef.current.id);
      setSwipeOffset(Math.min(dx, 80));
    } else if (dx < -10) {
      setSwipingMsgId(swipeStartRef.current.id);
      setSwipeOffset(Math.max(dx, -80));
    }
  }, []);

  const handleBubbleMouseUp = useCallback(() => {
    if (!swipeStartRef.current) return;
    if (swipeOffset > 60) {
      const msgId = swipeStartRef.current.id;
      const msgs = messages[activePeer] || [];
      const msg = msgs.find(m => m.id === msgId);
      if (msg) setReplyTo({ messageId: msg.id, text: msg.text.slice(0, 60), from: msg.from });
    } else if (swipeOffset < -60) {
      const msgId = swipeStartRef.current.id;
      const msgs = messages[activePeer] || [];
      const msg = msgs.find(m => m.id === msgId);
      if (msg) setDeleteConfirmMsg(msg);
    }
    swipeStartRef.current = null;
    setSwipingMsgId(null);
    setSwipeOffset(0);
  }, [swipeOffset, messages, activePeer]);

  // ── File sending ──
  const sendFile = useCallback(async (file: File) => {
    if (!activePeer || !selfNumber) return;
    const me = selfNumber;
    // MIME — по сигнатуре (magic bytes), а не только по File.type: «картинка»
    // с чужим содержимым уходит как application/octet-stream.
    const sniff = await sniffFile(file);
    if (selfNumberRef.current !== me) return;
    const fileMime = sniff.mismatch
      ? (sniff.detectedMime || "application/octet-stream")
      : (file.type || sniff.detectedMime || "application/octet-stream");

    if (activePeer === SAVED_MESSAGES_KEY) {
      if (file.size > 10 * 1024 * 1024) {
        phantomToast("\u041C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u0440\u0430\u0437\u043C\u0435\u0440 \u0444\u0430\u0439\u043B\u0430: 10 \u041C\u0411", "warning");
        return;
      }
      try {
        const arrayBuffer = await file.arrayBuffer();
        if (selfNumberRef.current !== me) return;
        const fileBytes = new Uint8Array(arrayBuffer);
        let fileBinary = "";
        for (let i = 0; i < fileBytes.length; i++) fileBinary += String.fromCharCode(fileBytes[i]);
        const base64 = btoa(fileBinary);
        const mime = fileMime;
        const fileDataUrl = `data:${mime};base64,${base64}`;
        appendMessage(SAVED_MESSAGES_KEY, {
          id: nowId(), from: selfNumber, to: SAVED_MESSAGES_KEY,
          text: `[\u0424\u0430\u0439\u043B: ${file.name}]`,
          createdAt: Date.now(), direction: "out",
          fileName: file.name, fileSize: file.size, mimeType: mime,
          fileData: fileDataUrl,
          status: "sent",
        });
      } catch {
        setRelayError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0444\u0430\u0439\u043B");
      }
      return;
    }

    // P2P v2 §4–5: файл собеседнику — ТОЛЬКО по DataChannel (files_v1), через relay не уходит ни
    // file_message, ни meta1 k=file. Лимита размера нет (web — до 2 ГиБ: приём собирается в RAM).
    // S10.3/Q7: смена ключа не подтверждена — файл не ставится в очередь (и file_offer не уйдёт)
    if (!canSendTo(activePeer)) { phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning"); return; }
    if (file.size < 1) { phantomToast("Пустой файл не отправляется", "warning"); return; }
    if (file.size > WEB_MAX_FILE_BYTES) { phantomToast("Максимальный размер файла в браузере — 2 ГБ", "warning"); return; }
    const enqueue = enqueueP2PFileRef.current;
    if (!enqueue) return;
    markSentTo(activePeer); // S4: отправка запущена пользователем (гейт P2P-канала)
    enqueue(activePeer, nowId(), file, fileMime, sniff.detectedMime);
    if (!privacyRef.current.p2pFallback) phantomToast(FILE_P2P_OFF_TEXT, "warning");
  }, [activePeer, appendMessage, markSentTo, canSendTo, selfNumber, phantomToast]);

  // Pin handler
  // S5: превью закрепа relay не получает — всегда "", рендер из локальной истории
  const pinMessage = useCallback((messageId: string) => {
    if (!activePeer) return;
    sendRelay({ type: "pin_message", toNumber: activePeer, messageId, preview: "" });
  }, [activePeer, sendRelay]);

  const unpinMessage = useCallback((messageId: string) => {
    if (!activePeer) return;
    sendRelay({ type: "unpin_message", toNumber: activePeer, messageId });
  }, [activePeer, sendRelay]);

  // ── Block/unblock ──
  // S10.6/Q11: локальный список обновляется сразу (источник правды), relay — block/unblock
  const blockUser = useCallback((target: string) => {
    sendRelay({ type: "block_user", number: target } as any);
    const bl = blockListRef.current;
    const unblocked = { ...bl.unblocked };
    delete unblocked[target];
    persistBlockList([...bl.numbers, target], unblocked);
  }, [sendRelay, persistBlockList]);

  const unblockUser = useCallback((target: string) => {
    sendRelay({ type: "unblock_user", number: target } as any);
    const bl = blockListRef.current;
    persistBlockList(bl.numbers.filter(n => n !== target), { ...bl.unblocked, [target]: Date.now() });
  }, [sendRelay, persistBlockList]);

  // ── Delete message for all ──
  const deleteMessageForAll = useCallback((messageId: string) => {
    if (!activePeer) return;
    sendPeerEvent({ type: "message_delete", toNumber: activePeer, messageIds: [messageId] });
    // Исходящий файл в очереди/передаче — отменить (P2P v2 §5.1)
    p2pFileOpsRef.current?.cancel(activePeer, messageId, true);
    setMessages(prev => ({
      ...prev,
      [activePeer]: (prev[activePeer] || []).filter(m => m.id !== messageId),
    }));
  }, [activePeer, sendPeerEvent]);

  // ── Edit message ──
  const startEditMessage = useCallback((msg: { id: string; peer: string; text: string }) => {
    setEditingMsg(msg);
    setMessageText(msg.text);
  }, []);

  const sendEditMessage = useCallback(async () => {
    if (!editingMsg || !activePeer || !selfNumber) return;
    const me = selfNumber;
    if (!canSendTo(activePeer)) { phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning"); return; }
    const newText = stripNul(messageText);
    if (newText.length > TEXT_MAX_CHARS) { phantomToast(`Сообщение длиннее ${TEXT_MAX_CHARS} символов`, "warning"); return; }
    const keys = keysRef.current;
    // S1: ключ только из lookup_result, «старый» освежается перед отправкой
    const peerKey = await resolvePeerKey(activePeer);
    if (selfNumberRef.current !== me) return;
    if (!keys || !peerKey) {
      // Та же ошибка, что и при отправке текста
      setRelayError(PEER_KEY_UNAVAILABLE_ERROR);
      return;
    }
    const editTrusted = await ensurePeerKeyTrusted(activePeer, peerKey);
    if (selfNumberRef.current !== me) return;
    if (!editTrusted) { phantomToast(KEY_ALERT_BLOCKED_TEXT, "warning"); return; }
    try {
      // S10.1: meta1-собеседнику — { k:"text", id, text } (Q3/Q4), иначе прежний формат
      const editMeta1 = peerUsesMeta1(activePeer);
      const editPt = editMeta1 ? buildEditPayload({ id: editingMsg.id, text: newText }) : "";
      const blob = editMeta1
        ? await encrypt(editPt, selfNumber, activePeer, peerKey, { version: 2, keyNumber: selfNumber })
        : await encryptForPeer(newText, selfNumber, activePeer, peerKey);
      const deviceBlobs = editMeta1
        ? await buildDeviceBlobs(activePeer, peerKey, blob, k => encrypt(editPt, selfNumber, activePeer, k, { version: 2, keyNumber: selfNumber }))
        : undefined;
      if (selfNumberRef.current !== me) return;
      sendPeerEvent({ type: "message_edit", toNumber: activePeer, messageId: editingMsg.id, encryptedBlob: blob, ...(deviceBlobs ? { deviceBlobs } : {}) });
      markSentTo(activePeer); // S4: отправка запущена пользователем
      setMessages(prev => {
        const msgs = [...(prev[activePeer] || [])];
        const idx = msgs.findIndex(m => m.id === editingMsg.id);
        if (idx !== -1) {
          msgs[idx] = { ...msgs[idx], text: newText, edited: true, editedAt: Date.now() };
        }
        return { ...prev, [activePeer]: msgs };
      });
      setEditingMsg(null);
      setMessageText("");
    } catch {
      setRelayError("Не удалось отредактировать сообщение");
    }
  }, [editingMsg, activePeer, selfNumber, messageText, markSentTo, resolvePeerKey, encryptForPeer, peerUsesMeta1, canSendTo, ensurePeerKeyTrusted, phantomToast, sendPeerEvent]);

  // OTP handlers
  const handleOtpInput = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    setOtp(prev => { const next = [...prev]; next[index] = digit; return next; });
    if (digit && index < OTP_LENGTH - 1) otpRefs.current[index + 1]?.focus();
  };

  const handleOtpKeyDown = (index: number, key: string) => {
    if (key === "Backspace" && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
      setOtp(prev => { const next = [...prev]; next[index - 1] = ""; return next; });
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, OTP_LENGTH);
    if (pasted.length > 0) {
      e.preventDefault();
      const newOtp = Array(OTP_LENGTH).fill("");
      for (let i = 0; i < pasted.length && i < OTP_LENGTH; i++) newOtp[i] = pasted[i];
      setOtp(newOtp);
      otpRefs.current[Math.min(pasted.length, OTP_LENGTH - 1)]?.focus();
    }
  };

  const acceptPrivacyNotice = () => {
    if (selfNumberRef.current) localStorage.setItem(accountKey(selfNumberRef.current, "privacy_seen"), "1");
    setShowPrivacyNotice(false);
  };

  // Drag & drop handlers (direct only)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      sendFile(file);
    }
  }, [sendFile]);

  // Export chat
  const exportChat = useCallback(() => {
    if (!activePeer) return;
    // WEB-13: эфемерные сообщения (burn / таймер) в экспорт не попадают; перед
    // выгрузкой — явное предупреждение, что файл ляжет на диск открытым текстом.
    const msgs = (messages[activePeer] || []).filter(m => !m.burnAfterRead && !m.selfDestructAt);
    if (!window.confirm("Переписка будет сохранена на устройство открытым текстом (без самоуничтожающихся сообщений). Продолжить?")) return;
    const peerName = contacts[activePeer] || formatNumber(activePeer);
    const lines = msgs.map(m => {
      const time = new Date(m.createdAt).toLocaleString("ru-RU");
      const sender = m.direction === "out" ? "\u042F" : peerName;
      return `[${time}] ${sender}: ${m.text}`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `phantom-chat-${peerName}-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, [activePeer, messages, contacts]);

  // Auto-login when all 6 OTP digits are filled
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (otp.every(item => item.length === 1) && !authBusy && screen === "otp") {
      verifyCode();
    }
  }, [otp]);

  // ── P2P Mode: per-peer WebRTC DataChannel pool ──
  // Каналы хранятся в Map по peerNumber. Установка сигналинга идёт через
  // relay пока он жив; готовый канал переживает падение сервера.

  const _p2pUpdateActive = useCallback((peer: string, active: boolean) => {
    setP2PActivePeers(prev => {
      const next = new Set(prev);
      if (active) next.add(peer);
      else next.delete(peer);
      return next;
    });
  }, []);

  // Обработчик входящего кадра по P2P (PROTOCOL_P2P_V2 §3.4–§3.7, §4)
  const _p2pHandleIncoming = useCallback(async (peer: string, ch: P2PChannel, raw: unknown) => {
    // Блок-лист мог измениться при открытом канале — содержимое не принимаем
    if (blockedUsersRef.current.has(peer)) return;
    // §4.3: бинарные кадры — только чанки файлов. Обработка синхронная до постановки в очередь
    // приёмника: порядок кадров ordered-канала сохраняется.
    if (raw instanceof ArrayBuffer) {
      if (raw.byteLength <= FILE_FRAME_MAX) p2pFileOpsRef.current?.onFrame(peer, ch, new Uint8Array(raw));
      return;
    }
    // size cap: не позволяем peer'у заваливать нас RAM-ом
    if (typeof raw !== "string" || raw.length > P2P_MAX_DC_MESSAGE) return;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.type !== "string") return;
      if (data.type === "hello") {
        // §3.4: features и deviceId пира (неизвестные поля игнорируются); v1 — только messages
        const hello = parseHelloFrame(data, ch.helloReceived);
        ch.peerFeatures = hello.features;
        ch.peerDeviceId = hello.deviceId;
        ch.helloReceived = true;
        // §3.4: ответный hello на первый hello пира (старые iOS/macOS теряли наш первый)
        if (hello.reply && ch.openedAt > 0 && ch.dc?.readyState === "open") {
          try { ch.dc.send(buildHelloFrame(ownDeviceIdRef.current)); } catch {}
        }
        if (p2pChannelsRef.current.get(peer) === ch) p2pFileOpsRef.current?.onChannelReady(peer);
        return;
      }
      // §4.2/§4.4: управляющие кадры файлов (текст JSON) — порядок с бинарными чанками сохраняется
      if (data.type.startsWith("file_")) {
        p2pFileOpsRef.current?.onControl(peer, ch, data);
        return;
      }
      if (data.type === "message" && data.encryptedBlob && typeof data.encryptedBlob === "object") {
        // S10.1/Q1: тот же единый диспетчер, что и для relay (meta1 / легаси); дубли — по messageId
        const msgId = await handleIncomingEnvelopeRef.current({
          from: peer, outerType: "message",
          messageId: typeof data.messageId === "string" ? data.messageId : "",
          blob: data.encryptedBlob, via: "p2p",
          legacy: { replyTo: data.replyTo, selfDestruct: data.selfDestruct },
        });
        if (!msgId) return;
        // ack по тому же каналу, по которому пришло сообщение (если он ещё жив)
        if (ch.dc?.readyState === "open") {
          try { ch.dc.send(JSON.stringify({ type: "delivery_ack", messageId: msgId })); } catch {}
        }
        return;
      }
      if (data.type === "delivery_ack" && typeof data.messageId === "string") {
        clearP2PAckWait(data.messageId, peer);
        setMessages(prev => {
          const list = prev[peer];
          if (!list) return prev;
          const idx = list.findIndex(m => m.id === data.messageId && m.direction === "out");
          if (idx === -1 || list[idx].status === "read") return prev;
          const updated = [...list];
          updated[idx] = { ...updated[idx], status: "delivered", failed: false };
          return { ...prev, [peer]: updated };
        });
        return;
      }
      // §3.7 (events_v1): тот же обработчик, что для кадра relay; fromNumber — всегда пир канала
      if (P2P_EVENT_TYPES.has(data.type)) {
        const frame: Record<string, unknown> = {
          ...data,
          type: P2P_EVENT_INBOUND_TYPE[data.type] || data.type,
          fromNumber: peer,
          timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
        };
        delete frame.toNumber;
        delete frame.deviceBlobs;
        await relayFrameHandlerRef.current?.(frame as unknown as RelayInbound, "p2p");
        return;
      }
      // неизвестный type — дроп без разрыва канала
    } catch (err) {
      slog.error("[P2P] message error:", (err as Error)?.name);
    }
  }, [clearP2PAckWait]);

  // Внутренняя функция: настраивает обработчики канала
  // Обработчики привязаны к объекту канала (а не к записи в Map): старый и пересоздаваемый
  // каналы одного собеседника не путаются (M1).
  // Закрыть старый канал после renew: сразу, если по нему нет активных передач файлов, иначе
  // дождаться их завершения (или credExpiresAt — дальше TURN всё равно оборвёт сессию)
  const closeRetiredP2P = useCallback((old: P2PChannel) => {
    const r = p2pRetiringRef.current.get(old);
    if (r) { clearInterval(r.timer); p2pRetiringRef.current.delete(old); }
    try { old.dc?.close(); } catch {}
    try { old.pc.close(); } catch {}
    old.state = "closed";
    if (r) p2pFileOpsRef.current?.onChannelClosed(r.peer, old);
  }, []);
  const retireP2PChannel = useCallback((peer: string, old: P2PChannel) => {
    const busy = () => [...pendingFilesRef.current.values()].some(f => f.ch === old && (f.state === "offered" || f.state === "sending" || f.state === "ended"))
      || [...inFilesRef.current.values()].some(x => x.ch === old && (x.state === "receiving" || x.state === "verifying"));
    if (!busy()) {
      try { old.dc?.close(); } catch {}
      try { old.pc.close(); } catch {}
      p2pFileOpsRef.current?.onChannelClosed(peer, old);
      return;
    }
    const timer = setInterval(() => {
      if (old.dc?.readyState !== "open" || !busy() || (old.credExpiresAt > 0 && Date.now() / 1000 >= old.credExpiresAt)) closeRetiredP2P(old);
    }, 2000);
    p2pRetiringRef.current.set(old, { peer, timer });
  }, [closeRetiredP2P]);

  const _p2pAttachDataChannel = useCallback((peer: string, ch: P2PChannel, dc: RTCDataChannel) => {
    ch.dc = dc;
    // §3.1/§4.5: чанки файлов — ArrayBuffer; порог onbufferedamountlow для backpressure
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = DC_BUFFER_LOW;
    const isMain = () => p2pChannelsRef.current.get(peer) === ch;
    // Канал закрыт/упал: передачи этого канала — в очередь/«прервана»; сообщения без ack — через relay
    const onGone = () => {
      p2pFileOpsRef.current?.onChannelClosed(peer, ch);
      const main = p2pChannelsRef.current.get(peer);
      if (!main || main === ch || main.state !== "open") flushP2PAckWaits(peer);
    };
    dc.onopen = () => {
      ch.state = "open";
      ch.openedAt = Date.now();
      if (p2pRenewRef.current.get(peer) === ch) {
        // Новый канал открылся — только теперь заменяем и закрываем старый
        const old = p2pChannelsRef.current.get(peer);
        p2pChannelsRef.current.set(peer, ch);
        p2pRenewRef.current.delete(peer);
        p2pRenewBackoffRef.current.delete(peer);
        if (old && old !== ch) retireP2PChannel(peer, old);
      }
      if (!isMain()) return;
      _p2pUpdateActive(peer, true);
      // §3.4: hello v2 — первый кадр после open
      try { dc.send(buildHelloFrame(ownDeviceIdRef.current)); } catch {}
      // Пир без hello за 5 с — старый клиент (features = ["messages"]): очередь файлов узнаёт об этом
      setTimeout(() => {
        if (isMain() && ch.state === "open" && !ch.helloReceived) p2pFileOpsRef.current?.onChannelReady(peer);
      }, P2P_HELLO_WAIT_MS + 100);
    };
    dc.onclose = () => {
      ch.state = "closed";
      if (isMain()) _p2pUpdateActive(peer, false);
      onGone();
    };
    dc.onerror = () => {
      ch.state = "failed";
      if (isMain()) _p2pUpdateActive(peer, false);
      onGone();
    };
    dc.onmessage = (e) => { void _p2pHandleIncoming(peer, ch, e.data); };
  }, [_p2pUpdateActive, _p2pHandleIncoming, flushP2PAckWaits, retireP2PChannel]);

  // Закрыть конкретный P2P-канал
  const closeP2P = useCallback((peer: string) => {
    const renew = p2pRenewRef.current.get(peer);
    if (renew) {
      try { renew.dc?.close(); } catch {}
      try { renew.pc.close(); } catch {}
      p2pRenewRef.current.delete(peer);
      p2pFileOpsRef.current?.onChannelClosed(peer, renew);
    }
    for (const [old, r] of [...p2pRetiringRef.current.entries()]) if (r.peer === peer) closeRetiredP2P(old);
    const ch = p2pChannelsRef.current.get(peer);
    if (!ch) return;
    try { ch.dc?.close(); } catch {}
    try { ch.pc.close(); } catch {}
    p2pChannelsRef.current.delete(peer);
    _p2pUpdateActive(peer, false);
    p2pFileOpsRef.current?.onChannelClosed(peer, ch);
  }, [_p2pUpdateActive, closeRetiredP2P]);

  // Закрыть все каналы (logout / panic / выключение «Прямого соединения»)
  const closeAllP2P = useCallback(() => {
    for (const [peer, ch] of [...p2pChannelsRef.current.entries(), ...p2pRenewRef.current.entries()]) {
      try {
        ch.dc?.close();
        ch.pc.close();
      } catch {}
      p2pFileOpsRef.current?.onChannelClosed(peer, ch);
    }
    for (const old of [...p2pRetiringRef.current.keys()]) closeRetiredP2P(old);
    p2pChannelsRef.current.clear();
    p2pRenewRef.current.clear();
    p2pRenewBackoffRef.current.clear();
    for (const d of p2pDeferredOffersRef.current.values()) clearTimeout(d.timer);
    p2pDeferredOffersRef.current.clear();
    setP2PActivePeers(new Set());
  }, [closeRetiredP2P]);

  // S10.5/Q9: политика ICE как у звонков — relay-only при «Скрывать IP» или не-контакте;
  // relay-only без TURN — канал не создаётся.
  const _p2pIcePolicy = useCallback((peer: string): { relayOnly: boolean; ok: boolean } => {
    const relayOnly = privacyRef.current.privateCalls || !Object.prototype.hasOwnProperty.call(contactsRef.current, peer);
    const hasTurn = iceServersRef.current.some(sv => (Array.isArray(sv.urls) ? sv.urls : [sv.urls])
      .some(u => typeof u === "string" && /^turns?:/i.test(u)));
    return { relayOnly, ok: !relayOnly || hasTurn };
  }, []);

  // Создать peer connection с общими настройками (фильтрация ICE как в звонках)
  const _p2pCreatePeerConnection = useCallback((peer: string, relayOnly: boolean): RTCPeerConnection => {
    const pc = new RTCPeerConnection({
      iceServers: iceServersRef.current,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceTransportPolicy: relayOnly ? "relay" : "all",
    });
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      // Q9: только srflx/relay — host (локальные адреса) и prflx не отправляются
      if (!e.candidate.type || !["srflx", "relay"].includes(e.candidate.type)) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "p2p_ice_candidate", toNumber: peer, candidate: sanitizeIceCandidate(e.candidate.toJSON()) }));
      }
    };
    pc.oniceconnectionstatechange = () => {
      const main = p2pChannelsRef.current.get(peer);
      const ch = main?.pc === pc ? main : (p2pRenewRef.current.get(peer)?.pc === pc ? p2pRenewRef.current.get(peer) : undefined);
      const st = pc.iceConnectionState;
      if (st === "failed" || st === "closed") {
        if (ch && !(st === "closed" && ch.state === "closed")) ch.state = "failed";
        if (ch && ch === main) _p2pUpdateActive(peer, false);
      } else if (st === "connected" || st === "completed") {
        // disconnected — временное состояние ICE (state не трогаем); после восстановления возвращаем
        // open только если DC реально открыт ("open" первым ставит dc.onopen)
        if (ch && ch.state !== "open" && ch.dc?.readyState === "open") {
          ch.state = "open";
          if (ch === main) _p2pUpdateActive(peer, true);
        }
      }
    };
    return pc;
  }, [_p2pUpdateActive]);

  // §3.2: учёт отправленных p2p_offer — лимит клиента и распознавание peer_offline-ответа на «зонд»
  const noteP2POffer = useCallback((peer: string) => {
    const now = Date.now();
    const times = (p2pOfferTimesRef.current.get(peer) || []).filter(t => now - t < 60_000);
    times.push(now);
    p2pOfferTimesRef.current.set(peer, times);
  }, []);

  // Инициировать P2P (отправляем offer)
  const startP2P = useCallback(async (peerNumber: string) => {
    if (!peerNumber) return;
    // self-check: relay-spoof или баг не должны создавать loopback
    if (peerNumber === selfNumberRef.current) return;
    // S4 + Q9: согласие на P2P (настройка) и гейт контакт/исходящее/блок-лист — и для ручного старта
    if (!p2pPeerAllowed(peerNumber)) return;
    // cap на одновременные каналы (защита от exhaustion)
    if (p2pLiveCount() >= P2P_MAX_CHANNELS) return;
    const existing = p2pChannelsRef.current.get(peerNumber);
    if (existing && existing.state !== "closed" && existing.state !== "failed") return;
    if (existing) closeP2P(peerNumber);

    // Q9: ICE-серверы с expiresAt — освежаются перед новым PeerConnection
    await ensureFreshIceRef.current();
    const policy = _p2pIcePolicy(peerNumber);
    if (!policy.ok) return;
    const again = p2pChannelsRef.current.get(peerNumber);
    if (again && again.state !== "closed" && again.state !== "failed") return;

    const pc = _p2pCreatePeerConnection(peerNumber, policy.relayOnly);
    const channel: P2PChannel = {
      pc, dc: null, state: "connecting", initiator: true,
      createdAt: Date.now(), pendingCandidates: [], remoteDescSet: false,
      relayOnly: policy.relayOnly, credExpiresAt: iceExpiresAtRef.current, ...p2pChannelExtras(),
    };
    p2pChannelsRef.current.set(peerNumber, channel);

    const dc = pc.createDataChannel("phantom-p2p", { ordered: true });
    _p2pAttachDataChannel(peerNumber, channel, dc);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "p2p_offer", toNumber: peerNumber, sdp: { type: offer.type, sdp: stripSdpCandidates(offer.sdp, ["host", "prflx"]) } }));
        noteP2POffer(peerNumber);
      } else {
        // Без relay не получится сделать handshake — отменяем
        closeP2P(peerNumber);
      }
    } catch (err) {
      slog.error("[P2P] startP2P error:", (err as Error)?.name);
      closeP2P(peerNumber);
    }
  }, [_p2pAttachDataChannel, _p2pCreatePeerConnection, _p2pIcePolicy, closeP2P, p2pPeerAllowed, noteP2POffer]);

  // Получили offer от другого peer
  const handleP2POffer = useCallback(async (fromNumber: string, sdp: RTCSessionDescriptionInit, receivedAt: number = Date.now()) => {
    if (!fromNumber) return;
    const deferred = p2pDeferredOffersRef.current.get(fromNumber);
    if (deferred) { clearTimeout(deferred.timer); p2pDeferredOffersRef.current.delete(fromNumber); }
    // self-check: скомпрометированный relay не должен создавать loopback
    if (fromNumber === selfNumberRef.current) return;
    // S4: offer только от номеров, прошедших гейт (иначе relay/чужой номер узнаёт наш IP)
    if (!p2pPeerAllowed(fromNumber)) return;
    // cap на одновременные каналы (защита от exhaustion от relay-spam)
    if (p2pLiveCount() >= P2P_MAX_CHANNELS && !p2pChannelsRef.current.has(fromNumber)) return;
    // Glare resolution: если у нас уже есть исходящий и мы инициатор с большим номером,
    // то наш offer "проигрывает" — закрываем и принимаем входящий
    const existing = p2pChannelsRef.current.get(fromNumber);
    // Offer при открытом канале — пересоздание собеседником по ЕГО TURN-кредам (Q9/M1):
    // новый канал строится рядом, старый закрывается только после открытия нового.
    // Glare двух встречных пересозданий: у нас свой незавершённый renew с этим номером →
    // меньший номер побеждает: fromNumber < self — уступаем (наш renew закрывается ниже),
    // fromNumber > self — игнорируем чужой offer и ждём ответа на свой.
    // §3.3: невежливый (наш номер меньше) уступает, если свой offer «протух» (≥ 3 с без answer — вежливый
    // его отбросил: перезагрузка, гейт §2); свежий — чужой offer откладывается до «свой + 3 с» (lib/p2pGlare.ts).
    const glareHold = (own: P2PChannel): boolean => {
      const dec = decideIncomingOffer(selfNumberRef.current, fromNumber,
        { createdAt: own.createdAt, answered: own.remoteDescSet }, Date.now());
      if (dec.action === "accept") return false;
      if (dec.action === "defer" && Date.now() - receivedAt < P2P_DEFERRED_OFFER_TTL_MS) {
        const timer = setTimeout(() => {
          const d = p2pDeferredOffersRef.current.get(fromNumber);
          if (!d || d.timer !== timer) return;
          p2pDeferredOffersRef.current.delete(fromNumber);
          void p2pHandleOfferRef.current?.(fromNumber, d.sdp, d.at);
        }, Math.max(100, dec.retryInMs));
        p2pDeferredOffersRef.current.set(fromNumber, { sdp, at: receivedAt, timer });
      }
      return true;
    };
    const ownRenew = p2pRenewRef.current.get(fromNumber);
    if (ownRenew && ownRenew.initiator && ownRenew.state !== "open" && glareHold(ownRenew)) return;
    // P2P v2 §3.3 «вежливый пир»: встречный offer при нашем исходящем connecting — наш номер больше →
    // уступаем (свой канал закрывается ниже, отвечаем на чужой); меньше → чужой offer игнорируем и
    // ждём answer на свой (вежливый пир его пришлёт); свой «протух» (≥ 3 с без answer) — уступаем (glareHold)
    if (existing && existing.initiator && existing.state === "connecting" && glareHold(existing)) return;

    await ensureFreshIceRef.current();
    const policy = _p2pIcePolicy(fromNumber);
    if (!policy.ok) return;
    // M1: открытый relay-only канал собеседник пересоздаёт — новый живёт рядом, старый
    // закроется только после открытия нового (dc.onopen)
    const current = p2pChannelsRef.current.get(fromNumber);
    const renewing = !!current && current.state === "open";
    const prevRenew = p2pRenewRef.current.get(fromNumber);
    if (prevRenew) {
      try { prevRenew.dc?.close(); } catch {}
      try { prevRenew.pc.close(); } catch {}
      p2pRenewRef.current.delete(fromNumber);
    }
    if (current && !renewing) closeP2P(fromNumber);

    const pc = _p2pCreatePeerConnection(fromNumber, policy.relayOnly);
    const channel: P2PChannel = {
      pc, dc: null, state: "connecting", initiator: false,
      createdAt: Date.now(), pendingCandidates: [], remoteDescSet: false,
      relayOnly: policy.relayOnly, credExpiresAt: iceExpiresAtRef.current, ...p2pChannelExtras(),
    };
    if (renewing) p2pRenewRef.current.set(fromNumber, channel);
    else p2pChannelsRef.current.set(fromNumber, channel);
    const dropThis = () => {
      if (p2pRenewRef.current.get(fromNumber) === channel) {
        try { channel.pc.close(); } catch {}
        p2pRenewRef.current.delete(fromNumber);
      } else closeP2P(fromNumber);
    };

    pc.ondatachannel = (e) => _p2pAttachDataChannel(fromNumber, channel, e.channel);

    try {
      await pc.setRemoteDescription(sdp);
      channel.remoteDescSet = true;
      // применяем ICE-кандидаты которые пришли раньше offer
      for (const c of channel.pendingCandidates) {
        try { await pc.addIceCandidate(c); } catch (e) { slog.warn("[P2P] queued ICE failed:", (e as Error)?.name); }
      }
      channel.pendingCandidates = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "p2p_answer", toNumber: fromNumber, sdp: { type: answer.type, sdp: stripSdpCandidates(answer.sdp, ["host", "prflx"]) } }));
      } else {
        dropThis();
      }
    } catch (err) {
      slog.error("[P2P] handleP2POffer error:", (err as Error)?.name);
      dropThis();
    }
  }, [_p2pAttachDataChannel, _p2pCreatePeerConnection, _p2pIcePolicy, closeP2P, p2pPeerAllowed]);

  p2pHandleOfferRef.current = handleP2POffer;

  const handleP2PAnswer = useCallback(async (fromNumber: string, sdp: RTCSessionDescriptionInit) => {
    // Во время пересоздания (M1) answer относится к новому каналу
    const ch = p2pRenewRef.current.get(fromNumber) ?? p2pChannelsRef.current.get(fromNumber);
    // S4: answer имеет смысл только для НАШЕГО исходящего offer'а этому номеру
    if (!ch || !ch.initiator || ch.remoteDescSet) return;
    try {
      await ch.pc.setRemoteDescription(sdp);
      ch.remoteDescSet = true;
      for (const c of ch.pendingCandidates) {
        try { await ch.pc.addIceCandidate(c); } catch (e) { slog.warn("[P2P] queued ICE failed:", (e as Error)?.name); }
      }
      ch.pendingCandidates = [];
    } catch (err) {
      slog.error("[P2P] handleP2PAnswer error:", (err as Error)?.name);
    }
  }, []);

  const handleP2PIceCandidate = useCallback(async (fromNumber: string, candidate: RTCIceCandidateInit) => {
    // Во время пересоздания (M1) новые кандидаты — для нового канала (старый уже установлен)
    const ch = p2pRenewRef.current.get(fromNumber) ?? p2pChannelsRef.current.get(fromNumber);
    if (!ch) return;
    if (!ch.remoteDescSet) {
      // Буфер до remoteDescription — не больше 64 кандидатов (как у звонков, S10.5)
      if (ch.pendingCandidates.length < 64) ch.pendingCandidates.push(candidate);
      return;
    }
    try { await ch.pc.addIceCandidate(candidate); }
    catch (err) { slog.warn("[P2P] addIceCandidate failed:", (err as Error)?.name); }
  }, []);

  // ── P2P v2 §3.2: авто-старт канала по триггерам (c) входящее через relay и (d) файл в очереди ──
  // Гейт §2 и политика ICE — внутри startP2P; не больше P2P_OFFERS_PER_MIN offer в минуту на номер;
  // по (c) ещё и не чаще раза в 10 с (typing/receipts приходят пачками), (d) — по своему backoff.
  const p2pTryStart = useCallback((peer: string, forFile = false) => {
    if (!peer || peer === selfNumberRef.current || peer === SAVED_MESSAGES_KEY) return;
    if (!privacyRef.current.p2pFallback || !p2pPeerAllowed(peer)) return;
    const ex = p2pChannelsRef.current.get(peer);
    if (ex && ex.state !== "closed" && ex.state !== "failed") return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const times = (p2pOfferTimesRef.current.get(peer) || []).filter(t => now - t < 60_000);
    if (times.length >= P2P_OFFERS_PER_MIN) return;
    if (!forFile && times.length > 0 && now - times[times.length - 1] < 10_000) return;
    void startP2P(peer);
  }, [p2pPeerAllowed, startP2P]);
  p2pAutoStartRef.current = p2pTryStart;

  // ── P2P v2 §4–5: файлы только по DataChannel (files_v1) ──
  // Исходящие: очередь pendingFilesRef (messageId → файл), «ожидает собеседника» до канала с files_v1;
  // file_offer — конверт v2 (encrypt через SW) с ключом/nonceBase файла; чанки — lib/p2pFile.ts.
  // Входящие: inFilesRef (fileId → приёмник), сборка в Blob (RAM) → blob: URL в ChatMessage.fileUrl.
  type OutFile = {
    peer: string; messageId: string; file: File; name: string; mime: string; size: number;
    fileId: Uint8Array; fileIdHex: string; keyRaw: Uint8Array; nonceBase: Uint8Array;
    sha256: string;
    state: "queued" | "offered" | "sending" | "ended" | "delivered" | "failed" | "cancelled";
    ch: P2PChannel | null;
    reoffers: number; retryIdx: number; nextTryAt: number; busyUntil: number;
    timer: ReturnType<typeof setTimeout> | null;
    note: string; lastProgressAt: number; lastProgress: number;
    // Пузырь уже был в истории (см. эффект очистки ниже) / время постановки
    seen: boolean; createdAt: number;
  };
  type InFile = {
    peer: string; ch: P2PChannel; messageId: string; fileIdHex: string; mime: string; size: number;
    rx: FileReceiver; state: "receiving" | "verifying" | "done" | "failed" | "cancelled";
    timer: ReturnType<typeof setTimeout> | null; lastProgressAt: number; lastProgress: number;
    lastFrameAt: number; seen: boolean; createdAt: number;
  };
  const pendingFilesRef = useRef<Map<string, OutFile>>(new Map());
  const inFilesRef = useRef<Map<string, InFile>>(new Map());
  // Принятые файлы (peer\0messageId): повторный file_offer того же сообщения → снова file_done
  const doneInFilesRef = useRef<Set<string>>(new Set());
  // blob: URL вложений → seen (был в истории). Отзываются, когда пропали из messages (удаление,
  // самоуничтожение, logout), и при reset.
  const fileUrlsRef = useRef<Map<string, { seen: boolean; createdAt: number }>>(new Map());

  const p2pJsonOn = (ch: P2PChannel | null, obj: Record<string, unknown>): boolean => {
    if (!ch?.dc || ch.dc.readyState !== "open") return false;
    try { ch.dc.send(JSON.stringify(obj)); return true; } catch { return false; }
  };
  const fileClearTimer = (x: { timer: ReturnType<typeof setTimeout> | null }) => {
    if (x.timer) clearTimeout(x.timer);
    x.timer = null;
  };
  const trackFileUrl = (url: string) => { fileUrlsRef.current.set(url, { seen: false, createdAt: Date.now() }); };

  // Пузырь исходящего: «ожидает» с подписью (без лишних перерисовок при той же подписи)
  const outSetQueued = (f: OutFile, note: string) => {
    if (f.state === "queued" && f.note === note) return;
    fileClearTimer(f);
    f.state = "queued";
    f.ch = null;
    f.note = note;
    updateMessage(f.peer, f.messageId, { transferState: "waiting_peer", progress: 0, transferNote: note, failed: false });
  };
  const outFail = (f: OutFile, reason: string) => {
    fileClearTimer(f);
    f.state = "failed";
    f.ch = null;
    f.note = "";
    updateMessage(f.peer, f.messageId, {
      transferState: "failed", failed: true,
      transferNote: `Не отправлено · ${FILE_ABORT_TEXT[reason] || "передача прервана"}`,
    });
  };
  const inFail = (inf: InFile, note = "Передача прервана") => {
    fileClearTimer(inf);
    inf.rx.discard();
    inf.state = "failed";
    inFilesRef.current.delete(inf.fileIdHex);
    updateMessage(inf.peer, inf.messageId, { transferState: "failed", transferNote: note });
  };
  // §4.5: нет чанков 60 с → abort timeout (один таймер на передачу, перевзводится по lastFrameAt)
  const inArmIdle = (inf: InFile) => {
    fileClearTimer(inf);
    const tick = () => {
      if (inf.state !== "receiving") return;
      const idle = Date.now() - inf.lastFrameAt;
      if (idle < FILE_IDLE_TIMEOUT_MS) { inf.timer = setTimeout(tick, FILE_IDLE_TIMEOUT_MS - idle); return; }
      p2pJsonOn(inf.ch, { type: "file_abort", fileId: inf.fileIdHex, reason: "timeout" });
      inFail(inf);
    };
    inf.timer = setTimeout(tick, FILE_IDLE_TIMEOUT_MS);
  };
  const progressDue = (x: { lastProgressAt: number; lastProgress: number }, p: number): boolean => {
    const now = Date.now();
    if (p < 1 && p - x.lastProgress < 0.01 && now - x.lastProgressAt < 500) return false;
    x.lastProgressAt = now;
    x.lastProgress = p;
    return true;
  };

  // §5.1 queued → offered: конверт v2 на ключ собеседника из lookup (TOFU/keyAlert как у текста)
  const fileOffer = async (f: OutFile, ch: P2PChannel) => {
    // S10.3/Q7: смена ключа не подтверждена — file_offer не уходит
    if (!canSendTo(f.peer)) { outSetQueued(f, KEY_ALERT_BLOCKED_TEXT); return; }
    f.state = "offered";
    f.ch = ch;
    f.note = "";
    updateMessage(f.peer, f.messageId, { transferState: "offered", transferNote: undefined, failed: false });
    const me = selfNumberRef.current;
    try {
      const peerKey = await resolvePeerKey(f.peer);
      if (f.state !== "offered" || f.ch !== ch) return;
      if (!peerKey) { outSetQueued(f, PEER_KEY_UNAVAILABLE_ERROR); return; }
      if (!(await ensurePeerKeyTrusted(f.peer, peerKey))) { outSetQueued(f, KEY_ALERT_BLOCKED_TEXT); return; }
      if (!f.sha256) {
        // Потоково по File.slice: файл целиком в память не читается
        const h = await sha256OfBlob(f.file, undefined, () => f.state !== "offered" || f.ch !== ch);
        if (h === null) return;
        f.sha256 = h;
      }
      if (f.state !== "offered" || f.ch !== ch) return;
      // §4.1: свежие ключ, nonceBase и fileId на каждое предложение (повтор после обрыва — тоже)
      f.keyRaw = randomBytes(32);
      f.nonceBase = randomBytes(8);
      f.fileId = randomBytes(16);
      f.fileIdHex = toHex(f.fileId);
      const pt = buildFileOfferPlaintext({
        id: f.messageId, fileIdHex: f.fileIdHex, name: f.name, mime: f.mime, size: f.size, sha256: f.sha256,
        key: f.keyRaw, nonceBase: f.nonceBase, chunk: FILE_CHUNK_DEFAULT,
      });
      const blob = await encrypt(pt, me, f.peer, peerKey, { version: 2, keyNumber: me });
      if (selfNumberRef.current !== me || f.state !== "offered" || f.ch !== ch) return;
      if (!canSendTo(f.peer)) { outSetQueued(f, KEY_ALERT_BLOCKED_TEXT); return; }
      if (!p2pJsonOn(ch, { type: "file_offer", messageId: f.messageId, fileId: f.fileIdHex, encryptedBlob: blob })) {
        outSetQueued(f, FILE_WAITING_TEXT);
        return;
      }
      f.timer = setTimeout(() => {
        if (f.state !== "offered" || f.ch !== ch) return;
        p2pJsonOn(ch, { type: "file_abort", fileId: f.fileIdHex, reason: "timeout" });
        outFail(f, "timeout");
      }, FILE_ACCEPT_TIMEOUT_MS);
    } catch (err) {
      slog.warn("[P2P] file_offer failed:", (err as Error)?.name);
      if (f.state === "offered" && f.ch === ch) outFail(f, "io");
    }
  };

  // §5.1 sending: чанки с backpressure, затем file_end и ожидание file_done (60 с)
  const filePump = async (f: OutFile, ch: P2PChannel) => {
    const me = selfNumberRef.current;
    try {
      const key = await importFileKey(f.keyRaw);
      const res = await sendFileChunks({
        file: f.file, size: f.size, chunk: FILE_CHUNK_DEFAULT, key, nonceBase: f.nonceBase, fileId: f.fileId,
        from: me, to: f.peer, dc: ch.dc as unknown as DcLike,
        shouldStop: () => f.state !== "sending" || f.ch !== ch,
        onProgress: (sent) => {
          const p = sent / f.size;
          if (progressDue(f, p)) updateMessage(f.peer, f.messageId, { progress: p });
        },
      });
      if (res === "stopped" || f.state !== "sending" || f.ch !== ch) return;
      if (res === "closed" || !p2pJsonOn(ch, { type: "file_end", fileId: f.fileIdHex })) {
        // Канал правда закрыт — обрыв (повторное предложение); иначе сбой отправки только этого файла
        if (ch.dc?.readyState === "open") {
          p2pJsonOn(ch, { type: "file_abort", fileId: f.fileIdHex, reason: "io" });
          outFail(f, "io");
        } else p2pFileOpsRef.current?.onChannelClosed(f.peer, ch);
        return;
      }
      f.state = "ended";
      updateMessage(f.peer, f.messageId, { transferState: "verifying", progress: 1 });
      f.timer = setTimeout(() => {
        if (f.state !== "ended" || f.ch !== ch) return;
        p2pJsonOn(ch, { type: "file_abort", fileId: f.fileIdHex, reason: "timeout" });
        outFail(f, "timeout");
      }, FILE_IDLE_TIMEOUT_MS);
    } catch (err) {
      slog.warn("[P2P] file send failed:", (err as Error)?.name);
      if (f.state === "sending" && f.ch === ch) {
        p2pJsonOn(ch, { type: "file_abort", fileId: f.fileIdHex, reason: "io" });
        outFail(f, "io");
      }
    }
  };

  // Очередь собеседника: канал с files_v1 → до 3 предложений; канала нет → попытка по backoff §3.2(d)
  const fileKick = (peer: string) => {
    const queued = [...pendingFilesRef.current.values()].filter(f => f.peer === peer && f.state === "queued");
    if (queued.length === 0) return;
    if (!privacyRef.current.p2pFallback) { for (const f of queued) outSetQueued(f, FILE_P2P_OFF_TEXT); return; }
    const ch = p2pChannelsRef.current.get(peer);
    const now = Date.now();
    if (!ch || !p2pChannelReady(ch)) {
      for (const f of queued) outSetQueued(f, FILE_WAITING_TEXT);
      if (queued.some(f => f.nextTryAt <= now)) {
        for (const f of queued) {
          f.nextTryAt = now + P2P_FILE_RETRY_MS[Math.min(f.retryIdx, P2P_FILE_RETRY_MS.length - 1)];
          f.retryIdx++;
        }
        p2pTryStart(peer, true);
      }
      return;
    }
    if (!ch.peerFeatures.includes("files_v1")) { for (const f of queued) outSetQueued(f, FILE_OLD_PEER_TEXT); return; }
    let active = 0;
    for (const f of pendingFilesRef.current.values()) {
      if (f.peer === peer && (f.state === "offered" || f.state === "sending" || f.state === "ended")) active++;
    }
    for (const f of queued) {
      if (active >= MAX_TRANSFERS_PER_PEER) break;
      if (f.busyUntil > now) continue;
      if (!canSendTo(peer)) { outSetQueued(f, KEY_ALERT_BLOCKED_TEXT); continue; }
      active++;
      f.retryIdx = 0;
      void fileOffer(f, ch);
    }
  };

  // §4.5/§5.2: входящий file_offer — проверки, пузырь «Приём 0 %», file_accept
  const fileReceiveOffer = async (peer: string, ch: P2PChannel, data: Record<string, unknown>) => {
    const me = selfNumberRef.current;
    const fileIdHex = typeof data.fileId === "string" && /^[0-9a-f]{32}$/.test(data.fileId) ? data.fileId : "";
    if (!fileIdHex || !me) return;
    const abort = (reason: FileAbortReason) => { p2pJsonOn(ch, { type: "file_abort", fileId: fileIdHex, reason }); };
    const messageId = typeof data.messageId === "string" && data.messageId.length > 0 && data.messageId.length <= 128 ? data.messageId : "";
    const blob = data.encryptedBlob;
    if (!messageId || !blob || typeof blob !== "object" || Array.isArray(blob)) { abort("invalid"); return; }
    // §4.1: file_offer — только конверт v2 с identity-ключом отправителя. Легаси v1
    // (ECDH эфемерный×мой ключ) не аутентифицирует отправителя: любой, кто знает мой
    // публичный ключ (relay/MITM DTLS), мог бы подсунуть файл «от контакта».
    const b = blob as Partial<EncryptedBlob>;
    if (b.version !== 2 || typeof b.senderIdentityKey !== "string" || !b.senderIdentityKey) { abort("invalid"); return; }
    // §4.5: только по DC после hello, от номера по гейту §2 (не блок-лист, контакт/переписка)
    if (!ch.helloReceived || !p2pPeerAllowed(peer)) { abort("declined"); return; }
    // Чужой messageId не должен перезаписывать существующее исходящее/текстовое сообщение
    const existingMsg = (messagesRef.current[peer] || []).find(m => m.id === messageId);
    if (existingMsg && (existingMsg.direction !== "in" || !existingMsg.transferState)) { abort("invalid"); return; }
    if (inFilesRef.current.has(fileIdHex)) return;
    if (doneInFilesRef.current.has(`${peer}\u0000${messageId}`)) {
      p2pJsonOn(ch, { type: "file_done", fileId: fileIdHex, messageId });
      return;
    }
    // Незавершённый приём того же сообщения (канал оборвался) заменяется новым предложением
    for (const x of [...inFilesRef.current.values()]) {
      if (x.peer === peer && x.messageId === messageId) { fileClearTimer(x); x.rx.discard(); x.state = "failed"; inFilesRef.current.delete(x.fileIdHex); }
    }
    let active = 0;
    for (const x of inFilesRef.current.values()) if (x.peer === peer && (x.state === "receiving" || x.state === "verifying")) active++;
    if (active >= MAX_TRANSFERS_PER_PEER) { abort("busy"); return; }
    let pt: string;
    try {
      pt = await decrypt(blob as EncryptedBlob, peer, me);
      // TOFU/keyAlert — как для текста (приём не блокируется, блокируется только отправка)
      await noteIncomingEnvelope(peer, blob as EncryptedBlob);
    } catch (e) {
      abort(isUnsupportedVersionError(e) ? "unsupported" : "invalid");
      return;
    }
    if (selfNumberRef.current !== me) return;
    const parsed = parseFileOffer(pt, messageId, fileIdHex);
    if (!parsed.ok) { slog.warn("[P2P] file_offer rejected:", parsed.reason); abort("invalid"); return; }
    const o = parsed.offer;
    const fileIdBytes = fromHex(fileIdHex);
    if (!fileIdBytes) { abort("invalid"); return; }
    const now = Date.now();
    const sd = o.sd;
    const isBurn = sd === "read";
    const bubble: ChatMessage = {
      id: messageId, from: peer, to: me, createdAt: now, direction: "in", status: "delivered",
      text: `[Файл: ${o.name}]`,
      fileName: o.name, fileSize: o.size, mimeType: safeReceivedMime(o.mime, ""),
      replyTo: normalizeReplyRef(o.replyTo),
      selfDestruct: isBurn ? undefined : sd,
      selfDestructAt: (typeof sd === "number" && sd > 0) ? now + sd * 1000 : undefined,
      burnAfterRead: isBurn || undefined,
      transport: "p2p", fileId: fileIdHex, transferState: "transferring", progress: 0,
    };
    const showOrReset = (fields: Partial<ChatMessage>) => {
      if (markSeenIncoming(peer, messageId)) {
        updateMessage(peer, messageId, { ...fields, fileUrl: undefined });
      } else {
        appendMessage(peer, { ...bubble, ...fields });
        notifyIncoming(peer, isBurn ? "🔥" : o.name, "file");
        if (activePeerRef.current !== peer) setUnread(prev => ({ ...prev, [peer]: (prev[peer] || 0) + 1 }));
      }
    };
    // §4.5: web собирает файл в RAM (Blob) — больше 2 ГиБ не принимается
    if (o.size > WEB_MAX_FILE_BYTES) {
      abort("too_large");
      showOrReset({ transferState: "failed", progress: 0, transferNote: "Файл больше 2 ГБ — в браузере не принимается" });
      return;
    }
    if (ch.dc?.readyState !== "open" || inFilesRef.current.has(fileIdHex)) return;
    let key: CryptoKey;
    try { key = await importFileKey(o.key); } catch { abort("invalid"); return; }
    if (selfNumberRef.current !== me) return;
    // Повторная проверка после await: пачка offer не должна пройти мимо лимита / дубля messageId
    if (ch.dc?.readyState !== "open" || inFilesRef.current.has(fileIdHex)) return;
    for (const x of [...inFilesRef.current.values()]) {
      if (x.peer === peer && x.messageId === messageId) { fileClearTimer(x); x.rx.discard(); x.state = "failed"; inFilesRef.current.delete(x.fileIdHex); }
    }
    let activeNow = 0;
    for (const x of inFilesRef.current.values()) if (x.peer === peer && (x.state === "receiving" || x.state === "verifying")) activeNow++;
    if (activeNow >= MAX_TRANSFERS_PER_PEER) { abort("busy"); return; }
    const inf: InFile = {
      peer, ch, messageId, fileIdHex, mime: o.mime, size: o.size,
      rx: new FileReceiver({ key, nonceBase: o.nonceBase, fileId: fileIdBytes, from: peer, to: me, size: o.size, chunk: o.chunk, sha256: o.sha256 }),
      state: "receiving", timer: null, lastProgressAt: 0, lastProgress: 0,
      lastFrameAt: Date.now(), seen: false, createdAt: Date.now(),
    };
    inFilesRef.current.set(fileIdHex, inf);
    showOrReset({ transferState: "transferring", progress: 0, transferNote: undefined, fileId: fileIdHex });
    if (!p2pJsonOn(ch, { type: "file_accept", fileId: fileIdHex })) { inFail(inf); return; }
    inArmIdle(inf);
  };

  // §5.2 receiving → verifying → done: n чанков и sha256, Blob → blob: URL, file_done
  const fileFinish = async (inf: InFile) => {
    fileClearTimer(inf);
    inf.state = "verifying";
    updateMessage(inf.peer, inf.messageId, { transferState: "verifying", progress: 1 });
    const me = selfNumberRef.current;
    const r = await inf.rx.finish("application/octet-stream");
    if (inf.state !== "verifying") return;
    if (!r.ok) {
      p2pJsonOn(inf.ch, { type: "file_abort", fileId: inf.fileIdHex, reason: r.reason });
      inFail(inf);
      return;
    }
    // Тип для показа — по сигнатуре (sniffFile), объявленному не доверяем (кроме аудио/видео)
    const sniff = await sniffFile(new File([r.blob], "file"));
    const mime = safeReceivedMime(inf.mime, sniff.detectedMime);
    if (selfNumberRef.current !== me || inf.state !== "verifying") return;
    const url = URL.createObjectURL(r.blob.slice(0, r.blob.size, mime));
    trackFileUrl(url);
    inf.state = "done";
    inFilesRef.current.delete(inf.fileIdHex);
    doneInFilesRef.current.add(`${inf.peer}\u0000${inf.messageId}`);
    updateMessage(inf.peer, inf.messageId, { fileUrl: url, mimeType: mime, transferState: "done", progress: 1, transferNote: undefined });
    p2pJsonOn(inf.ch, { type: "file_done", fileId: inf.fileIdHex, messageId: inf.messageId });
  };

  const findOutFile = (peer: string, fileIdHex: string): OutFile | undefined => {
    for (const f of pendingFilesRef.current.values()) if (f.peer === peer && f.fileIdHex === fileIdHex) return f;
    return undefined;
  };

  p2pFileOpsRef.current = {
    onControl: (peer, ch, data) => {
      const fileIdHex = typeof data.fileId === "string" ? data.fileId : "";
      switch (data.type) {
        case "file_offer": void fileReceiveOffer(peer, ch, data); return;
        case "file_accept": {
          const f = findOutFile(peer, fileIdHex);
          if (!f || f.ch !== ch || f.state !== "offered") return;
          fileClearTimer(f);
          f.state = "sending";
          f.lastProgress = 0;
          updateMessage(peer, f.messageId, { transferState: "transferring", progress: 0 });
          void filePump(f, ch);
          return;
        }
        case "file_end": {
          const inf = inFilesRef.current.get(fileIdHex);
          if (!inf || inf.peer !== peer || inf.ch !== ch || inf.state !== "receiving") return;
          void fileFinish(inf);
          return;
        }
        case "file_done": {
          const f = findOutFile(peer, fileIdHex);
          if (!f || f.ch !== ch || (f.state !== "ended" && f.state !== "sending" && f.state !== "offered") || data.messageId !== f.messageId) return;
          fileClearTimer(f);
          f.state = "delivered";
          pendingFilesRef.current.delete(f.messageId);
          // §3.6: файл получило устройство, с которым открыт DC
          const multi = (peerDevicesRef.current[peer] || []).length > 1;
          updateMessage(peer, f.messageId, {
            transferState: "done", progress: 1, status: "delivered", failed: false,
            transferNote: multi ? FILE_ONE_DEVICE_TEXT : undefined,
          });
          return;
        }
        case "file_abort": {
          const reason = typeof data.reason === "string" ? data.reason : "";
          const f = findOutFile(peer, fileIdHex);
          if (f && f.ch === ch && (f.state === "offered" || f.state === "sending" || f.state === "ended")) {
            if (reason === "busy") {
              // У собеседника уже 3 передачи — повтор позже
              outSetQueued(f, FILE_WAITING_TEXT);
              f.busyUntil = Date.now() + 15_000;
            } else outFail(f, (FILE_ABORT_REASONS as readonly string[]).includes(reason) ? reason : "");
            return;
          }
          const inf = inFilesRef.current.get(fileIdHex);
          if (inf && inf.peer === peer && inf.ch === ch) inFail(inf, reason === "cancelled" ? "Отменено отправителем" : "Передача прервана");
          return;
        }
        default: return; // неизвестный file_* — дроп без разрыва канала
      }
    },
    onFrame: (peer, ch, bytes) => {
      const fr = parseFileFrame(bytes);
      if (!fr) return;
      const inf = inFilesRef.current.get(fr.fileIdHex);
      // §4.5: неизвестный fileId / не в receiving — дроп
      if (!inf || inf.peer !== peer || inf.ch !== ch || inf.state !== "receiving") return;
      inf.lastFrameAt = Date.now();
      void inf.rx.push(fr.ctr, fr.body).then(bad => {
        if (inf.state !== "receiving") return;
        if (bad) {
          p2pJsonOn(inf.ch, { type: "file_abort", fileId: inf.fileIdHex, reason: bad });
          inFail(inf);
          return;
        }
        const p = inf.rx.receivedBytes / inf.size;
        if (progressDue(inf, p)) updateMessage(inf.peer, inf.messageId, { progress: p });
      });
    },
    onChannelReady: (peer) => { fileKick(peer); },
    onPeerOnline: (peer) => {
      let any = false;
      for (const f of pendingFilesRef.current.values()) {
        if (f.peer === peer && f.state === "queued") { f.nextTryAt = 0; f.retryIdx = 0; any = true; }
      }
      if (any) fileKick(peer);
    },
    onChannelClosed: (peer, ch) => {
      // §5.1: обрыв канала → повторное предложение (≤ 3 раз) при следующем канале
      for (const f of pendingFilesRef.current.values()) {
        if (f.peer !== peer || f.ch !== ch) continue;
        if (f.state !== "offered" && f.state !== "sending" && f.state !== "ended") continue;
        f.reoffers++;
        if (f.reoffers > FILE_MAX_REOFFERS) outFail(f, "protocol");
        else { outSetQueued(f, FILE_WAITING_TEXT); f.nextTryAt = 0; f.retryIdx = 0; }
      }
      // §5.2: незавершённый приём — «Передача прервана», частичные данные сброшены
      for (const inf of [...inFilesRef.current.values()]) {
        if (inf.peer === peer && inf.ch === ch && inf.state === "receiving") inFail(inf);
      }
    },
    reset: () => {
      for (const f of pendingFilesRef.current.values()) { fileClearTimer(f); f.state = "cancelled"; }
      for (const inf of inFilesRef.current.values()) { fileClearTimer(inf); inf.rx.discard(); inf.state = "cancelled"; }
      pendingFilesRef.current.clear();
      inFilesRef.current.clear();
      doneInFilesRef.current.clear();
      for (const url of fileUrlsRef.current.keys()) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
      fileUrlsRef.current.clear();
    },
    cancel: (peer, messageId, silent) => {
      const f = pendingFilesRef.current.get(messageId);
      if (f && f.peer === peer) {
        if (f.state === "offered" || f.state === "sending" || f.state === "ended") {
          p2pJsonOn(f.ch, { type: "file_abort", fileId: f.fileIdHex, reason: "cancelled" });
        }
        fileClearTimer(f);
        f.state = "cancelled";
        pendingFilesRef.current.delete(messageId);
        if (!silent) updateMessage(peer, messageId, { transferState: "cancelled", transferNote: "Отменено", failed: false });
        return;
      }
      for (const inf of [...inFilesRef.current.values()]) {
        if (inf.peer !== peer || inf.messageId !== messageId) continue;
        p2pJsonOn(inf.ch, { type: "file_abort", fileId: inf.fileIdHex, reason: "cancelled" });
        fileClearTimer(inf);
        inf.rx.discard();
        inf.state = "cancelled";
        inFilesRef.current.delete(inf.fileIdHex);
        if (!silent) updateMessage(peer, messageId, { transferState: "cancelled", transferNote: "Отменено" });
      }
    },
    retry: (peer, messageId) => {
      const f = pendingFilesRef.current.get(messageId);
      if (!f || f.peer !== peer || f.state !== "failed") return;
      f.reoffers = 0;
      f.retryIdx = 0;
      f.nextTryAt = 0;
      f.busyUntil = 0;
      f.note = "";
      outSetQueued(f, FILE_WAITING_TEXT);
      fileKick(peer);
    },
  };

  // §5: постановка файла в очередь (вызывается из sendFile после всех проверок)
  const enqueueP2PFile = useCallback((peer: string, messageId: string, file: File, declaredMime: string, sniffedMime: string) => {
    const me = selfNumberRef.current;
    if (!me) return;
    // Своё превью — blob: URL того же File (без чтения); тип — как у принятого (не text/html и т.п.)
    const previewMime = safeReceivedMime(declaredMime, sniffedMime);
    const url = URL.createObjectURL(file.slice(0, file.size, previewMime));
    trackFileUrl(url);
    const name = sanitizeOutgoingFileName(file.name);
    appendMessage(peer, {
      id: messageId, from: me, to: peer,
      text: `[Файл: ${name}]`,
      createdAt: Date.now(), direction: "out",
      fileName: name, fileSize: file.size, mimeType: previewMime, fileUrl: url,
      transport: "p2p", transferState: "waiting_peer", progress: 0, transferNote: FILE_WAITING_TEXT,
    });
    // Постановка файла в очередь = явное намерение писать этому номеру (гейт P2P §2)
    if (peer !== SAVED_MESSAGES_KEY) sentToRef.current.add(peer);
    pendingFilesRef.current.set(messageId, {
      peer, messageId, file, name, mime: sanitizeOutgoingMime(declaredMime), size: file.size,
      fileId: new Uint8Array(16), fileIdHex: "", keyRaw: new Uint8Array(32), nonceBase: new Uint8Array(8), sha256: "",
      state: "queued", ch: null, reoffers: 0, retryIdx: 0, nextTryAt: 0, busyUntil: 0, timer: null,
      note: FILE_WAITING_TEXT, lastProgressAt: 0, lastProgress: 0, seen: false, createdAt: Date.now(),
    });
    // §3.2(d): немедленная попытка канала, затем backoff
    p2pFileOpsRef.current?.onChannelReady(peer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendMessage]);
  enqueueP2PFileRef.current = enqueueP2PFile;

  // §3.2(d): пока есть файлы «ожидает собеседника» и вкладка активна — очередь пробуется раз в 2 с
  // (сама попытка канала — по backoff 5 с → 15 с → 60 с → 5 мин)
  useEffect(() => {
    if (screen !== "messenger") return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const peers = new Set<string>();
      for (const f of pendingFilesRef.current.values()) if (f.state === "queued") peers.add(f.peer);
      for (const peer of peers) p2pFileOpsRef.current?.onChannelReady(peer);
    }, 2000);
    return () => clearInterval(interval);
  }, [screen]);

  // blob: URL вложений отзываются, а передачи отменяются, когда сообщение пропало из истории
  // (удаление у себя/у всех, самоуничтожение, очистка чата, logout). Свежие записи, ещё не
  // попавшие в state, не трогаем 30 с.
  useEffect(() => {
    const live = new Set<string>();
    const liveIds = new Set<string>();
    for (const [peer, list] of Object.entries(messages)) {
      for (const m of list) {
        if (m.fileUrl) live.add(m.fileUrl);
        if (m.transferState) liveIds.add(`${peer}\u0000${m.id}`);
      }
    }
    const now = Date.now();
    const gone = (x: { peer: string; messageId: string; seen: boolean; createdAt: number }): boolean => {
      if (liveIds.has(`${x.peer}\u0000${x.messageId}`)) { x.seen = true; return false; }
      return x.seen || now - x.createdAt > 30_000;
    };
    for (const f of [...pendingFilesRef.current.values()]) if (gone(f)) p2pFileOpsRef.current?.cancel(f.peer, f.messageId, true);
    for (const inf of [...inFilesRef.current.values()]) if (gone(inf)) p2pFileOpsRef.current?.cancel(inf.peer, inf.messageId, true);
    for (const [url, st] of [...fileUrlsRef.current.entries()]) {
      if (live.has(url)) { st.seen = true; continue; }
      if (st.seen || now - st.createdAt > 30_000) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        fileUrlsRef.current.delete(url);
      }
    }
  }, [messages]);

  // Выключили «Прямое соединение» (Q9) — каналы закрываются (offer не шлём и не принимаем, §2)
  useEffect(() => {
    if (!privacySettings.p2pFallback) closeAllP2P();
  }, [privacySettings.p2pFallback, closeAllP2P]);

  // Совместимость: внешний disconnectP2P (используется кнопкой в ChatPanel)
  const disconnectP2P = useCallback((peer?: string) => {
    if (peer) closeP2P(peer);
    else closeAllP2P();
  }, [closeP2P, closeAllP2P]);


  // M1: экспоненциальный backoff неудачного пересоздания relay-only канала (≥ 30 с, до 15 мин)
  const p2pRenewBackoff = useCallback((peer: string) => {
    const prev = p2pRenewBackoffRef.current.get(peer);
    const delay = prev ? Math.min(prev.delay * 2, 15 * 60_000) : 30_000;
    p2pRenewBackoffRef.current.set(peer, { next: Date.now() + delay, delay });
  }, []);

  // M1: пересоздать relay-only канал со свежими TURN-кредами. Только если /api/ice реально
  // продлил срок (новый expiresAt > старого + запас); иначе backoff. Старый канал работает,
  // пока новый не откроется (замена — в dc.onopen).
  const renewP2P = useCallback(async (peer: string) => {
    const old = p2pChannelsRef.current.get(peer);
    if (!old || p2pRenewRef.current.has(peer)) return;
    if (!p2pPeerAllowed(peer)) { closeP2P(peer); return; }
    await refreshIceServers();
    const fresh = iceExpiresAtRef.current;
    if (!fresh || fresh <= old.credExpiresAt + ICE_REFRESH_MARGIN_SEC) { p2pRenewBackoff(peer); return; }
    const policy = _p2pIcePolicy(peer);
    const ws = wsRef.current;
    if (!policy.ok || ws?.readyState !== WebSocket.OPEN || p2pRenewRef.current.has(peer)) { p2pRenewBackoff(peer); return; }
    const pc = _p2pCreatePeerConnection(peer, policy.relayOnly);
    const channel: P2PChannel = {
      pc, dc: null, state: "connecting", initiator: true,
      createdAt: Date.now(), pendingCandidates: [], remoteDescSet: false,
      relayOnly: policy.relayOnly, credExpiresAt: fresh, ...p2pChannelExtras(),
    };
    p2pRenewRef.current.set(peer, channel);
    _p2pAttachDataChannel(peer, channel, pc.createDataChannel("phantom-p2p", { ordered: true }));
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: "p2p_offer", toNumber: peer, sdp: { type: offer.type, sdp: stripSdpCandidates(offer.sdp, ["host", "prflx"]) } }));
      noteP2POffer(peer);
    } catch (err) {
      slog.error("[P2P] renew error:", (err as Error)?.name);
      try { pc.close(); } catch {}
      if (p2pRenewRef.current.get(peer) === channel) p2pRenewRef.current.delete(peer);
      p2pRenewBackoff(peer);
    }
  }, [_p2pAttachDataChannel, _p2pCreatePeerConnection, _p2pIcePolicy, closeP2P, p2pPeerAllowed, p2pRenewBackoff, refreshIceServers, noteP2POffer]);

  // Periodic stale cleanup: каналы что висят в connecting > P2P_STALE_MS — закрываем.
  // Защита от atttacker который шлёт offers без завершения handshake.
  useEffect(() => {
    if (screen !== "messenger") return;
    const interval = setInterval(() => {
      const now = Date.now();
      const stale: string[] = [];
      const renew: string[] = [];
      for (const [peer, ch] of p2pChannelsRef.current.entries()) {
        if (ch.state === "connecting" && now - ch.createdAt > P2P_STALE_MS) {
          stale.push(peer);
        } else if (ch.state === "open" && ch.relayOnly && ch.credExpiresAt
          && now / 1000 > ch.credExpiresAt - ICE_REFRESH_MARGIN_SEC) {
          // Q9: relay-only канал пересоздаётся со свежими TURN-кредами за ≥ 5 мин до истечения
          // (coturn рвёт релей-сессию по истечении креденшела). Без relay — некуда слать offer.
          const bo = p2pRenewBackoffRef.current.get(peer);
          // Обе стороны пересоздают по СВОИМ кредам; glare решается в handleP2POffer
          if (wsRef.current?.readyState === WebSocket.OPEN && !p2pRenewRef.current.has(peer) && (!bo || bo.next <= now)) {
            renew.push(peer);
          }
        }
      }
      // Зависшее пересоздание — закрыть новый канал (старый остаётся) и отложить следующую попытку
      for (const [peer, ch] of p2pRenewRef.current.entries()) {
        if (ch.state !== "open" && now - ch.createdAt > P2P_STALE_MS) {
          try { ch.dc?.close(); } catch {}
          try { ch.pc.close(); } catch {}
          p2pRenewRef.current.delete(peer);
          p2pRenewBackoff(peer);
        }
      }
      for (const peer of stale) closeP2P(peer);
      for (const peer of renew) void renewP2P(peer);
    }, 10_000);
    return () => clearInterval(interval);
  }, [screen, closeP2P, renewP2P, p2pRenewBackoff]);

  // ── Мультиаккаунт (до MAX_ACCOUNTS номеров в вкладке) ──
  // Во время звонка (и набора/входящего) аккаунт не переключается и не добавляется.
  const accountsBusy = callState !== "idle" || callPreparing;

  // Переключение = «мягкий выход» текущего (disconnect без revoke_session, весь RAM сброшен,
  // хранилище и ключ устройства целы) + обычное подключение под выбранным номером.
  const switchAccount = useCallback((n: string) => {
    if (!n || n === selfNumberRef.current || !listAccounts().includes(n) || !hasTokenFor(n)) return;
    if (accountsBusy) { phantomToast(tx(initialLocale(), "accounts.callBusy"), "error"); return; }
    // Токен неактивного аккаунта живёт не дольше TTL после входа: истёк — не переключаемся
    // (иначе 4401 и лишний выход), убираем только этот аккаунт и просим войти заново
    if (isTokenExpiredFor(n)) {
      clearTokenMemory(n);
      setAccounts(listAccounts());
      phantomToast(tx(initialLocale(), "accounts.sessionExpired", { number: formatNumber(n) }), "error", 6000);
      return;
    }
    const origin = selfNumberRef.current;
    closeAllP2P();
    // Профиль остаётся открытым — виден индикатор «Подключение…» у нового активного
    hardLogout({ soft: true, to: n });
    switchOriginRef.current = origin && accountHasLock(n) ? origin : "";
  }, [accountsBusy, closeAllP2P, hardLogout, phantomToast]);

  // «Добавить аккаунт»: мягкий выход текущего и экран входа с кнопкой «Отмена».
  const startAddAccount = useCallback(() => {
    if (listAccounts().length >= MAX_ACCOUNTS) return;
    if (accountsBusy) { phantomToast(tx(initialLocale(), "accounts.callBusy"), "error"); return; }
    closeAllP2P();
    hardLogout({ soft: true });
    setAddingAccount(true);
    setInputNumber("");
    setPendingNumber("");
    setOtp(Array(OTP_LENGTH).fill(""));
    setAuthError("");
  }, [accountsBusy, closeAllP2P, hardLogout, phantomToast]);

  // «Отмена» при добавлении: возврат к прежнему аккаунту с его токеном (он остался активным в token.ts).
  const cancelAddAccount = useCallback(() => {
    authGenRef.current++;
    setAuthBusy(false);
    setPendingNumber("");
    setInputNumber("");
    setOtp(Array(OTP_LENGTH).fill(""));
    setAuthError("");
    const back = getActiveNumber();
    if (back && enterAccount(back, { honorLock: true })) return;
    setAddingAccount(false);
    navigate("login");
  }, [enterAccount, navigate]);

  // «Выйти» из аккаунта: активный — обычный logout (затем следующий или экран входа);
  // неактивный — убрать из списка, стереть его данные и ключ SW, активный не меняется.
  const logoutAccount = useCallback((n: string) => {
    if (!n) return;
    if (n === selfNumberRef.current) { hardLogout(); return; }
    if (!listAccounts().includes(n)) return;
    clearTokenMemory(n);
    wipeAccountStorage(n);
    void wipeKeysAndWait({ number: n });
    broadcastWipe({ scope: "account", number: n });
    setAccounts(listAccounts());
  }, [hardLogout]);

  // Сброс всего RAM-состояния к экрану входа без записи в хранилище (eraseKey: false —
  // хранилище уже стёрто здесь или в другой вкладке).
  const resetLocalState = useCallback(() => {
    try { cleanupCallRef.current(); } catch { /* ignore */ }
    closeAllP2P();
    // Мультиаккаунт: убран только этот аккаунт; перешли на другой — его состояние уже загружено
    if (hardLogout({ eraseKey: false })) return;
    setContacts({});
    setAvatars({});
    setChatSettings({});
    setChatBurnSettings({});
    setPrivacySettings(loadPrivacySettings(""));
    setVerifiedKeys({});
    setAppLocked(false);
    setAppLockPin("");
    setLockFail({ failCount: 0, lockedUntil: 0 });
    setShowLogoutConfirm(false);
  }, [closeAllP2P, hardLogout]);

  // ── X-06/Q14: единый ПОЛНЫЙ wipe — panic-PIN, 10-я неудача PIN, «Удалить аккаунт» ──
  // Порядок: остановить звонок/P2P → синхронно стереть хранилища (на случай закрытия вкладки
  // посреди процесса) → сбросить RAM-состояние → дождаться SW (IndexedDB phantom-keystore,
  // отдельное сообщение wipe) и очистить Cache Storage. Итог — обычный экран входа, без следов.
  const fullWipe = useCallback(async () => {
    wipingRef.current = true;
    // 1) СНАЧАЛА синхронно: revoke_session по уже открытому WS (кадр уйдёт раньше close),
    //    стирание хранилищ, сообщение wipe в SW и сигнал другим вкладкам. Закрытие вкладки
    //    в любой момент после этого блока ничего не оставляет на диске.
    // Паритет с Android/iOS: relay снимает JWT и push-токен этого устройства.
    const ws = wsRef.current;
    const dev = ownDeviceIdRef.current;
    const revoke = new Promise<void>((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !dev) { resolve(); return; }
      revokeAckRef.current = () => { revokeAckRef.current = null; resolve(); };
      try { ws.send(JSON.stringify({ type: "revoke_session", deviceId: dev })); } catch { resolve(); }
    });
    // Все записи приложения всех аккаунтов: accountKey(n, *) и устройство-уровневые phantom_*
    try {
      const lsKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("phantom_")) lsKeys.push(k);
      }
      for (const k of lsKeys) localStorage.removeItem(k);
    } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    clearTokenMemory();
    closeNotificationsFor(); // panic: уведомления всех номеров
    // S2/Q14: все ключи устройства (все номера) — сообщение wipe уходит в SW синхронно
    const keysWiped = wipeKeysAndWait({ all: true });
    broadcastWipe({ scope: "all" });
    // 2) Параллельно, не задерживая стирание: отписка Web Push (уведомления для стёртого номера
    //    больше не приходят)
    const unsubscribePush = (async () => {
      try {
        if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager?.getSubscription();
        if (sub) await sub.unsubscribe();
      } catch { /* push недоступен */ }
    })();
    // 3) Сброс RAM (звонок, P2P, сокет, ключи, пины…) — хранилище уже пусто
    resetLocalState();
    // 4) Best-effort ожидание revoke/отписки ≤ 1 с, затем подтверждение SW и Cache Storage
    await Promise.race([
      Promise.all([revoke, unsubscribePush]),
      new Promise<void>(r => setTimeout(r, 1000)),
    ]);
    revokeAckRef.current = null;
    await keysWiped.catch(() => false);
    try {
      if (typeof caches !== "undefined") {
        for (const name of await caches.keys()) await caches.delete(name);
      }
    } catch { /* Cache Storage недоступен */ }
    ownDeviceIdRef.current = "";
    wipingRef.current = false;
  }, [closeAllP2P, resetLocalState]);

  // H2: wipe/logout в другой вкладке (BroadcastChannel или исчезновение записей аккаунта в
  // localStorage) → немедленный выход здесь, RAM очищается, ничего не пишется обратно.
  // Мультиаккаунт: слушаем всегда (и на экране входа в режиме добавления), по всем аккаунтам вкладки:
  // активный — как раньше (resetLocalState → следующий аккаунт или вход), неактивный — убираем его
  // токен из памяти и из списка; `all` (panic) — токены всех аккаунтов и экран входа.
  useEffect(() => {
    const accountGone = (n: string) => {
      if (!listAccounts().includes(n)) return;
      if (n === selfNumberRef.current) { resetLocalState(); return; }
      clearTokenMemory(n);
      setAccounts(listAccounts());
    };
    const allGone = () => {
      clearTokenMemory();
      setAccounts([]);
      if (selfNumberRef.current) { resetLocalState(); return; }
      // Экран входа (в т.ч. режим добавления): прежнего аккаунта больше нет
      setAddingAccount(false);
      setPendingNumber("");
      setOtp(Array(OTP_LENGTH).fill(""));
      navigate("login");
    };
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel(WIPE_CHANNEL);
      bc.onmessage = (e: MessageEvent) => {
        const m = e.data as WipeSignal | undefined;
        if (!m || typeof m !== "object") return;
        // panic в другой вкладке стёр хранилище всех аккаунтов — токены этой вкладки тоже недействительны
        if (m.scope === "all") { allGone(); return; }
        if (m.scope === "account" && typeof m.number === "string") accountGone(m.number);
      };
    } catch { bc = null; }
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea && e.storageArea !== localStorage) return;
      if (e.key === null) { allGone(); return; }  // localStorage.clear() в другой вкладке
      if (e.newValue !== null || e.oldValue === null) return;
      const key = e.key;
      for (const n of listAccounts()) {
        const prefix = accountKey(n, "");
        if (key.startsWith(prefix) && ACCOUNT_WIPE_MARKERS.some(k => key === accountKey(n, k))) { accountGone(n); return; }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      try { bc?.close(); } catch { /* ignore */ }
    };
  }, [resetLocalState, navigate]);

  // ── S10.7: разблокировка ──
  // Обе проверки (PIN и panic-PIN) считаются всегда; счётчик неудач персистентный;
  // с 5-й неудачи — задержка, 10-я — полный wipe.
  const unlockApp = useCallback(async (pin: string) => {
    const me = selfNumberRef.current;
    if (!me || lockBusy) return;
    const st = readFailState(localStorage, me);
    if (lockRemainingMs(st, Date.now()) > 0) {
      setLockFail(st);
      setAppLockPin("");
      return;
    }
    setLockBusy(true);
    try {
      await migratePlainPins(localStorage, me).catch(() => false);
      const lock = readAppLock(localStorage, me);
      if (!lock.enabled) {
        // H2: заблокированная вкладка, а записи блокировки нет (panic/logout/wipe в другой
        // вкладке или подмена хранилища) — не разблокировать, а выйти на экран входа
        resetLocalState();
        return;
      }
      const panic = readPanic(localStorage, me);
      const res = await checkUnlock(pin, lock.pinHash, panic.enabled ? panic.pinHash : null);
      if (selfNumberRef.current !== me) return;
      if (res === "panic") { await fullWipe(); return; }
      if (res === "ok") {
        const zero = { failCount: 0, lockedUntil: 0 };
        writeFailState(localStorage, me, zero);
        setLockFail(zero);
        switchOriginRef.current = "";
        setAppLocked(false);
        setAppLockPin("");
        lastActivityRef.current = Date.now();
        return;
      }
      const r = registerFailure(readFailState(localStorage, me), Date.now());
      if (r.wipe) { await fullWipe(); return; }
      writeFailState(localStorage, me, r.state);
      setLockFail(r.state);
      setLockNow(Date.now());
      setAppLockPin("");
    } finally {
      setLockBusy(false);
    }
  }, [fullWipe, lockBusy, resetLocalState]);

  // Обратный отсчёт задержки на экране блокировки
  useEffect(() => {
    if (!appLocked || !lockFail.lockedUntil) return;
    const t = setInterval(() => setLockNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [appLocked, lockFail.lockedUntil]);

  // Q13: корень приложения под блокировкой — inert (без фокуса/кликов/скринридера), не размонтируется (WS живёт)
  const appRootRef = useRef<HTMLDivElement>(null);
  const lockActive = appLocked && screen === "messenger";
  useEffect(() => {
    const el = appRootRef.current;
    if (!el) return;
    if (lockActive) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }, [lockActive, screen, selfNumber]);

  // ── Clear all chats — только локально (relay историю не хранит; clear_history
  // он не знает и ответил бы unknown_type) ──
  const clearAllChats = useCallback(() => {
    setMessages({});
    setUnread({});
    setReplyTo(null);
    setEditingMsg(null);
    setActivePeer("");
    setPinnedMessages({});
  }, []);

  // ── Burn After Read helpers ──
  const toggleBurnAfterRead = useCallback((peer: string) => {
    setChatBurnSettings(prev => {
      const next = { ...prev, [peer]: !prev[peer] };
      localStorage.setItem(accountKey(selfNumber, "burn_settings"), JSON.stringify(next));
      return next;
    });
  }, [selfNumber]);

  const handleBurnReveal = useCallback((peer: string, msgId: string) => {
    setMessages(prev => {
      const list = (prev[peer] || []).map(m =>
        m.id === msgId ? { ...m, burnRevealed: true } : m
      );
      return { ...prev, [peer]: list };
    });
    // Send ack to peer that message was read (will be destroyed); P2P v2 §3.7 — по DC, иначе relay
    sendPeerEvent({ type: "burn_read_ack", toNumber: peer, messageId: msgId });
    // Remove message after brief delay
    setTimeout(() => {
      setMessages(prev => {
        const list = (prev[peer] || []).filter(m => m.id !== msgId);
        return { ...prev, [peer]: list };
      });
    }, 3000);
  }, [sendPeerEvent]);

  // ── Render ──

  // Onboarding (§10.6) — first-time intro gate, before everything else.
  if (showOnboarding && screen === "login") {
    return <Onboarding onComplete={completeOnboarding} />;
  }

  // App Lock Screen — оверлей поверх приложения (Q13): дерево мессенджера остаётся
  // смонтированным (WS не рвётся), но под `inert` + `aria-hidden` + `visibility: hidden`.
  let lockOverlay: JSX.Element | null = null;
  if (lockActive) {
    const pinLen = appLockPin.length;
    const lockRec = readAppLock(localStorage, selfNumber);
    const dotsTotal = Math.min(Math.max(lockRec.pinLength || 6, 4), 24);
    const tt = (k: string) => tx(initialLocale(), k);
    const remainingMs = lockRemainingMs(lockFail, lockNow);
    const lockedOut = remainingMs > 0;
    const disabled = lockedOut || lockBusy;
    const onPad = (d: string) => {
      if (disabled || appLockPin.length >= 24) return;
      const next = appLockPin + d;
      setAppLockPin(next);
      if (next.length === dotsTotal) {
        setTimeout(() => { void unlockApp(next); }, 50);
      }
    };
    const onPadBack = () => setAppLockPin(appLockPin.slice(0, -1));
    const remainingSec = Math.ceil(remainingMs / 1000);
    const mmss = `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")}`;
    lockOverlay = (
      <div className="tg-app-lock-screen" role="dialog" aria-modal="true" aria-label={tt("lock.title")}>
        <div className="tg-app-lock-card" style={{ maxWidth: 380, padding: "32px 28px" }}>
          <div className="tg-app-lock-icon">{"\uD83D\uDC7B"}</div>
          <h2 style={{ marginBottom: 6 }}>{tt("lock.title")}</h2>
          <p>{tt("lock.sub")}</p>

          <div style={{ display: "flex", justifyContent: "center", gap: 12, margin: "12px 0 16px 0", flexWrap: "wrap" }}>
            {Array.from({ length: dotsTotal }).map((_, i) => (
              <span
                key={i}
                style={{
                  width: 10, height: 10, borderRadius: 999,
                  background: i < pinLen ? "#a78bfa" : "rgba(255,255,255,0.12)",
                  boxShadow: i < pinLen ? "0 0 8px rgba(167,139,250,0.6)" : "none",
                  transition: "background 180ms ease",
                }}
              />
            ))}
          </div>

          {/* S10.7: с 5-й неудачи — задержка и сколько попыток осталось до удаления данных */}
          <div role="status" aria-live="polite" style={{ minHeight: 36, margin: "0 0 12px 0", fontSize: 12.5, color: "#fda4af", textAlign: "center" }}>
            {lockBusy ? "Проверка…" : null}
            {!lockBusy && lockFail.failCount > 0 && lockFail.failCount < APPLOCK_WARN_FROM_FAILURES && "Неверный PIN"}
            {!lockBusy && lockFail.failCount >= APPLOCK_WARN_FROM_FAILURES && (
              <>
                {lockedOut ? `Повторите через ${mmss}. ` : ""}
                {`Осталось попыток до удаления данных: ${attemptsBeforeWipe(lockFail.failCount)}`}
              </>
            )}
          </div>

          <div className="pm-numpad" style={{ width: 240, margin: "0 auto" }}>
            {[1,2,3,4,5,6,7,8,9].map(n => (
              <button
                key={n}
                type="button"
                className="pm-numpad-key"
                style={{ height: 52 }}
                disabled={disabled}
                onClick={() => onPad(String(n))}
              >{n}</button>
            ))}
            <button type="button" className="pm-numpad-key" style={{ height: 52 }} disabled={disabled || !appLockPin}
              onClick={() => { void unlockApp(appLockPin); }} aria-label="OK">{"\u2713"}</button>
            <button type="button" className="pm-numpad-key" style={{ height: 52 }} disabled={disabled} onClick={() => onPad("0")}>0</button>
            <button type="button" className="pm-numpad-key" style={{ height: 52 }} onClick={onPadBack} aria-label="Стереть">{"\u232B"}</button>
          </div>

          <input
            type="password"
            value={appLockPin}
            onChange={e => { if (!disabled) setAppLockPin(e.target.value); }}
            onKeyDown={e => { if (e.key === "Enter" && !disabled) void unlockApp(appLockPin); }}
            maxLength={24}
            placeholder=""
            aria-label="PIN"
            style={{ position: "absolute", opacity: 0, height: 0, width: 0, pointerEvents: "none" }}
            autoFocus
          />
        </div>
      </div>
    );
  }

  // Auth screens
  if (screen === "login" || screen === "otp") {
    return (
      <AuthScreen
        screen={screen}
        inputNumber={inputNumber}
        setInputNumber={setInputNumber}
        pendingNumber={pendingNumber}
        otp={otp}
        otpSeconds={otpSeconds}
        authBusy={authBusy}
        authError={authError}
        requestCode={requestCode}
        verifyCode={verifyCode}
        handleOtpInput={handleOtpInput}
        handleOtpKeyDown={handleOtpKeyDown}
        handleOtpPaste={handleOtpPaste}
        otpRefs={otpRefs}
        navigate={navigate}
        setAuthError={setAuthError}
        setOtp={setOtp}
        addingAccount={addingAccount}
        onCancelAdd={cancelAddAccount}
      />
    );
  }

  // ── Messenger screen ──
  return (
    <>
    {lockOverlay}
    <div className="app-root"
      key={selfNumber}
      ref={appRootRef}
      aria-hidden={lockActive || undefined}
      style={lockActive ? { visibility: "hidden" } : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragOver && activePeer && (
        <div className="drag-overlay">
          <div className="drag-overlay-content">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
            <p>{"\u041F\u0435\u0440\u0435\u0442\u0430\u0449\u0438\u0442\u0435 \u0444\u0430\u0439\u043B\u044B \u0441\u044E\u0434\u0430"}</p>
          </div>
        </div>
      )}

      <div className="tg-layout">
        <Sidebar
          selfNumber={selfNumber}
          connState={connState}
          menuPanel={menuPanel}
          setMenuPanel={setMenuPanel}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          mobileChatOpen={mobileChatOpen}
          filteredChatList={filteredChatList}
          activePeer={activePeer}
          openChat={openChat}
          messages={messages}
          contacts={contacts}
          avatars={avatars}
          unread={unread}
          typingPeers={typingPeers}
          drafts={drafts}
        />

        <MenuPanelComponent
          menuPanel={menuPanel}
          setMenuPanel={setMenuPanel}
          selfNumber={selfNumber}
          connState={connState}
          contacts={contacts}
          avatars={avatars}
          themePreference={themePreference}
          setThemePreference={setThemePreference}
          resolvedTheme={resolvedTheme}
          selfDestructSec={selfDestructSec}
          setSelfDestructSec={setSelfDestructSec}
          editContactName={editContactName}
          setEditContactName={setEditContactName}
          editContactNumber={editContactNumber}
          setEditContactNumber={setEditContactNumber}
          saveContact={saveContact}
          removeContact={removeContact}
          newChatNumber={newChatNumber}
          setNewChatNumber={setNewChatNumber}
          startNewChat={startNewChat}
          openChat={openChat}
          handleAvatarUpload={handleAvatarUpload}
          avatarInputRef={avatarInputRef}
          showQr={showQr}
          setShowQr={setShowQr}
          showQrLinkInput={showQrLinkInput}
          setShowQrLinkInput={setShowQrLinkInput}
          qrLinkInput={qrLinkInput}
          setQrLinkInput={setQrLinkInput}
          setRelayError={setRelayError}
          activeSessions={activeSessions}
          sendRelay={sendRelay}
          hardLogout={() => { hardLogout(); }}
          accounts={accounts}
          canAddAccount={accounts.length < MAX_ACCOUNTS}
          accountsBusy={accountsBusy}
          switchAccount={switchAccount}
          addAccount={startAddAccount}
          logoutAccount={logoutAccount}
          deleteAccount={() => { void fullWipe(); }}
          privacySettings={privacySettings}
          updatePrivacy={updatePrivacy}
          showLogoutConfirm={showLogoutConfirm}
          setShowLogoutConfirm={setShowLogoutConfirm}
          clearAllChats={clearAllChats}
        />

        {/* Right: Chat panel with call overlay */}
        {/* WEB-05: падение панели чата не роняет всё приложение; смена чата сбрасывает ошибку */}
        <ErrorBoundary scope="chat" variant="panel" resetKey={activePeer}>
        <ChatPanel
          activePeer={activePeer}
          activePeerOnline={activePeerOnline}
          selfNumber={selfNumber}
          sessionReady={sessionReady}
          contacts={contacts}
          messages={messages}
          messageText={messageText}
          setMessageText={setMessageText}
          filteredActiveMessages={filteredActiveMessages}
          activeMessages={activeMessages}
          messagesEndRef={messagesEndRef}
          sendMessage={sendMessage}
          sendFile={sendFile}
          sendReaction={sendReaction}
          saveToSavedMessages={saveToSavedMessages}
          handleDeleteMessage={handleDeleteMessage}
          pinMessage={pinMessage}
          unpinMessage={unpinMessage}
          exportChat={exportChat}
          startCall={startCall}
          saveContact={saveContact}
          saveChatSetting={saveChatSetting}
          sendTypingIndicator={sendTypingIndicator}
          openChat={openChat}
          mobileChatOpen={mobileChatOpen}
          setMobileChatOpen={setMobileChatOpen}
          replyTo={replyTo}
          setReplyTo={setReplyTo}
          selfDestructSec={selfDestructSec}
          setSelfDestructSec={setSelfDestructSec}
          showSelfDestructMenu={showSelfDestructMenu}
          setShowSelfDestructMenu={setShowSelfDestructMenu}
          reactionMsgId={reactionMsgId}
          setReactionMsgId={setReactionMsgId}
          fullscreenImage={fullscreenImage}
          setFullscreenImage={setFullscreenImage}
          deleteConfirmMsg={deleteConfirmMsg}
          setDeleteConfirmMsg={setDeleteConfirmMsg}
          pinnedMessages={pinnedMessages}
          showPinned={showPinned}
          setShowPinned={setShowPinned}
          chatSearchQuery={chatSearchQuery}
          setChatSearchQuery={setChatSearchQuery}
          chatSearchOpen={chatSearchOpen}
          setChatSearchOpen={setChatSearchOpen}
          messageWindowSize={messageWindowSize}
          setMessageWindowSize={setMessageWindowSize}
          chatSettings={chatSettings}
          showCustomize={showCustomize}
          setShowCustomize={setShowCustomize}
          typingPeers={typingPeers}
          callState={callState}
          isRecording={isRecording}
          startRecording={startRecording}
          sendVoiceMessage={sendVoiceMessage}
          cancelRecording={cancelRecording}
          swipingMsgId={swipingMsgId}
          swipeOffset={swipeOffset}
          handleBubbleTouchStart={handleBubbleTouchStart}
          handleBubbleTouchMove={handleBubbleTouchMove}
          handleBubbleTouchEnd={handleBubbleTouchEnd}
          handleBubbleMouseDown={handleBubbleMouseDown}
          handleBubbleMouseMove={handleBubbleMouseMove}
          handleBubbleMouseUp={handleBubbleMouseUp}
          showAddContactModal={showAddContactModal}
          setShowAddContactModal={setShowAddContactModal}
          addContactName={addContactName}
          setAddContactName={setAddContactName}
          blockedUsers={blockedUsers}
          blockUser={blockUser}
          unblockUser={unblockUser}
          deleteMessageForAll={deleteMessageForAll}
          editingMsg={editingMsg}
          setEditingMsg={setEditingMsg}
          startEditMessage={startEditMessage}
          sendEditMessage={sendEditMessage}
          avatars={avatars}
          connState={connState}
          showKeyVerification={showKeyVerification}
          setShowKeyVerification={setShowKeyVerification}
          verifiedKeys={verifiedKeys}
          setVerifiedKeys={setVerifiedKeys}
          keyChanged={activePeer ? !!keyChangedPeers[activePeer] : false}
          pinnedIdentity={activePeer ? pinnedIdentity[activePeer] : undefined}
          lastVerifiedIdentity={activePeer ? lastVerifiedIdentity[activePeer] : undefined}
          markIdentityVerified={(fp: string) => { markIdentityVerified(activePeer, fp); clearKeyAlert(activePeer, [fp]); }}
          unmarkIdentityVerified={() => unmarkIdentityVerified(activePeer)}
          keyAlert={activePeer ? !!keyAlerts[activePeer] : false}
          onKeyAlertContinue={() => { void acknowledgeKeyAlert(activePeer); }}
          peerCapabilities={activePeer ? peerCaps[activePeer] : undefined}
          dismissKeyChanged={() => setKeyChangedPeers(prev => {
            if (!prev[activePeer]) return prev;
            const next = { ...prev };
            delete next[activePeer];
            return next;
          })}

          chatBurnSettings={chatBurnSettings}
          toggleBurnAfterRead={toggleBurnAfterRead}
          handleBurnReveal={handleBurnReveal}
          p2pActive={activePeer ? p2pActivePeers.has(activePeer) : false}
          startP2P={startP2P}
          disconnectP2P={() => disconnectP2P(activePeer)}
          relayDown={relayDown}
          cancelFileTransfer={(peer, id) => p2pFileOpsRef.current?.cancel(peer, id)}
          retryFileTransfer={(peer, id) => p2pFileOpsRef.current?.retry(peer, id)}
          peerKeys={peerKeys}
          selfPublicKey={keysRef.current?.publicKey || ""}
        />
        </ErrorBoundary>
      </div>

      {/* Call overlay — отдельная граница ошибок: падение звонка не роняет чат (WEB-05) */}
      <ErrorBoundary
        scope="call"
        variant="overlay"
        resetKey={callState === "idle"}
        onDismiss={callState === "ringing" ? rejectCall : hangupCall}
      >
      <CallOverlay
        callState={callState}
        callPeer={callPeer}
        callIsVideo={callIsVideo}
        callMuted={callMuted}
        callVideoEnabled={callVideoEnabled}
        callDuration={callDuration}
        callSas={callSasCode}
        callPath={callPath}
        peerMediaState={peerMediaState}
        localVideoRef={localVideoRef}
        remoteVideoRef={remoteVideoRef}
        remoteAudioRef={remoteAudioRef}
        localStreamRef={localStreamRef}
        remoteStreamRef={remoteStreamRef}
        answerCall={answerCall}
        hangupCall={hangupCall}
        rejectCall={rejectCall}
        messageCaller={() => { const peer = callPeer; rejectCall(); if (peer) openChat(peer); }}
        toggleCallMute={toggleCallMute}
        toggleCallVideo={toggleCallVideo}
        switchCamera={switchCamera}
        contacts={contacts}
        incomingSdpRef={incomingSdpRef}
        cameraFacing={cameraFacing}
      />
      </ErrorBoundary>

      {/* Session replaced dialog */}
      {showSessionReplacedDialog && (
        <div className="tg-modal-overlay">
          <div className="tg-modal" onClick={e => e.stopPropagation()}>
            <div className="tg-modal-header">
              <h3>{tx(initialLocale(), "session.replaced.title")}</h3>
            </div>
            <div style={{ padding: "12px 20px" }}>
              <p style={{ color: "var(--text-2)", fontSize: 14 }}>{tx(initialLocale(), "session.replaced.body")}</p>
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", padding: "8px 20px 20px" }}>
              <button
                onClick={() => { setShowSessionReplacedDialog(false); hardLogout({ eraseKey: false }); }}
                className="tg-btn-secondary"
              >
                {tx(initialLocale(), "session.replaced.logout")}
              </button>
              <button
                onClick={() => {
                  setShowSessionReplacedDialog(false);
                  setSessionReady(false);
                  setTimeout(() => setSessionReady(true), 100);
                }}
                className="tg-modal-btn primary"
              >
                {tx(initialLocale(), "session.replaced.reconnect")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast: bridged into <ToastProvider> via the relayError useEffect above. */}

      {/* Privacy notice */}
      {screen === "messenger" && showPrivacyNotice && (() => {
        const tt2 = (k: string) => tx(initialLocale(), k);
        return (
        <div className="privacy-modal">
          <section>
            <h4>{"\u26A0"} {tt2("privacy.heading")}</h4>
            <div className="onboarding-steps">
              <div className="onboarding-step">
                <div className="onboarding-icon">{"\uD83D\uDD12"}</div>
                <div>
                  <strong>{tt2("privacy.e2eTitle")}</strong>
                  <p>{tt2("privacy.e2eBody")}</p>
                </div>
              </div>
              <div className="onboarding-step">
                <div className="onboarding-icon">{"\uD83D\uDCA8"}</div>
                <div>
                  <strong>{tt2("privacy.ephTitle")}</strong>
                  <p>{tt2("privacy.ephBody")}</p>
                </div>
              </div>
              <div className="onboarding-step">
                <div className="onboarding-icon">{"\u23F1"}</div>
                <div>
                  <strong>{tt2("privacy.sdTitle")}</strong>
                  <p>{tt2("privacy.sdBody")}</p>
                </div>
              </div>
              <div className="onboarding-step">
                <div className="onboarding-icon">{"\uD83C\uDF10"}</div>
                <div>
                  <strong>{tt2("privacy.anonTitle")}</strong>
                  <p>{tt2("privacy.anonBody")}</p>
                </div>
              </div>
            </div>
            <button onClick={acceptPrivacyNotice}>{tt2("common.gotIt")}</button>
          </section>
        </div>
        );
      })()}
      {fullscreenImage && (
        <div className="tg-img-fullscreen-overlay" onClick={() => setFullscreenImage(null)}>
          <img src={fullscreenImage} alt="fullscreen" />
        </div>
      )}
    </div>
    </>
  );
}
