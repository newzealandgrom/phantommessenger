/**
 * In-memory auth token.
 *
 * We used to keep the bearer token in `sessionStorage`, which is reachable
 * from any script on the page — a single XSS leaks it and the attacker can
 * open a WebSocket as the user. The tokens now live only in a module-level
 * closure; Storage never holds them while the page runs.
 *
 * The `phantom_number` counterpart is NOT sensitive (the UI needs it across
 * refreshes anyway) and stays in sessionStorage as-is.
 *
 * Reload (F5) keeps the session without tokens in Storage: on `pagehide` the tokens go to the
 * RAM of the Service Worker controller (30 s TTL, one-shot read) and only a random nonce is left
 * in sessionStorage; `restoreSession` (main.tsx, before first render) redeems it — only for a
 * real reload (see `isReloadNavigation`). Closing the tab/browser = sign out.
 *
 * Мультиаккаунт (до 3 номеров в одной вкладке): токены хранятся картой «номер → токен» только
 * в памяти, активный номер — один; `getToken()` отдаёт токен активного. В sessionStorage лежат
 * лишь номера (`phantom_number` — активный, `phantom_accounts` — список), не секреты.
 */
import { slog } from "./log";
import {
  type AccountsState, type Stash, addAccount, emptyAccounts, nextActiveAfterRemoval, nonceFromBytes,
  isAccountNumber, isReloadNavType, isStashNonce, parseAccountList, parseLegacyStash, parseStash,
  restoreAccounts, serializeStash, switchAccount, jwtTtlSeconds, isTtlElapsed,
} from "./accounts";

/** Одноразовый nonce тайника в RAM Service Worker (не секрет без SW; токенов в Storage нет). */
const NONCE_KEY = "phantom_stash_nonce";
/** Ключ тайника версии 6a (голый JWT): новая схема его больше не пишет, но принимает при reload. */
const LEGACY_TOKEN_KEY = "phantom_token";
const NUMBER_KEY = "phantom_number";
const ACCOUNTS_KEY = "phantom_accounts";
/** Ожидание ответа SW на `take_stash` при загрузке: дольше — вход заново. */
const TAKE_TIMEOUT_MS = 1500;

let tokens: Record<string, string> = {};
let accounts: AccountsState = emptyAccounts();

/**
 * Тип текущей загрузки страницы. Токены из тайника принимаются только при перезагрузке (F5,
 * `location.reload()`): восстановленная после закрытия вкладка («Открыть закрытую вкладку»
 * возвращает её sessionStorage) и новый переход остаются без входа.
 */
function isReloadNavigation(): boolean {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const legacy = (performance as unknown as { navigation?: { type?: number } }).navigation;
    return isReloadNavType(nav, legacy?.type);
  } catch {
    return false;
  }
}

/** Номера (не секреты) → sessionStorage: активный и список. */
function syncNumbers(): void {
  try {
    if (accounts.active) sessionStorage.setItem(NUMBER_KEY, accounts.active);
    else sessionStorage.removeItem(NUMBER_KEY);
    if (accounts.numbers.length > 0) sessionStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts.numbers));
    else sessionStorage.removeItem(ACCOUNTS_KEY);
  } catch {
    /* ignore — Storage недоступен */
  }
}

function swController(): ServiceWorker | null {
  try { return ("serviceWorker" in navigator && navigator.serviceWorker.controller) || null; }
  catch { return null; }
}

/** Попросить SW отдать (и стереть) тайник по nonce; null — нет ответа/нет тайника. */
function takeStashFromSW(ctrl: ServiceWorker, nonce: string): Promise<string | null> {
  return new Promise((resolve) => {
    const mc = new MessageChannel();
    const timer = setTimeout(() => { try { mc.port1.close(); } catch { /* ignore */ } resolve(null); }, TAKE_TIMEOUT_MS);
    mc.port1.onmessage = (e) => {
      clearTimeout(timer);
      try { mc.port1.close(); } catch { /* ignore */ }
      const r = e.data && e.data.ok ? e.data.result : null;
      resolve(typeof r === "string" ? r : null);
    };
    try { ctrl.postMessage({ op: "take_stash", nonce }, [mc.port2]); }
    catch { clearTimeout(timer); resolve(null); }
  });
}

/** Nonce тайника, положенного этой страницей (для drop при bfcache/выходе). */
let lastStashNonce = "";

/**
 * Стереть в SW свою запись тайника (только по своему nonce). Нет контроллера (Shift+F5) — через
 * активный воркер регистрации; старый SW без этой операции сообщение игнорирует.
 */
function dropStashInSW(nonce: string): void {
  if (!isStashNonce(nonce)) return;
  const msg = { op: "drop_stash", nonce };
  try {
    const ctrl = swController();
    if (ctrl) { ctrl.postMessage(msg); return; }
  } catch { /* ignore */ }
  try {
    void navigator.serviceWorker?.ready.then(r => { r.active?.postMessage(msg); }).catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}

/**
 * Восстановление сессии при загрузке — вызывается ДО первого рендера (main.tsx).
 * Токены в Storage не лежат: тайник — в RAM Service Worker, в sessionStorage только одноразовый
 * nonce (удаляется в любом случае). Принимается лишь при `navigation.type === "reload"` и живом
 * контроллере SW; иначе (закрытие вкладки, новый переход, нет SW, SW перезапущен) — вход заново.
 * Выложенный 6a клал голый JWT в `phantom_token` — при reload принимаем и его (один раз).
 */
export async function restoreSession(): Promise<void> {
  let savedList: string[] = [];
  let nonce = "";
  let legacyRaw = "";
  let legacyNumber = "";
  try {
    nonce = sessionStorage.getItem(NONCE_KEY) || "";
    legacyRaw = sessionStorage.getItem(LEGACY_TOKEN_KEY) || "";
    legacyNumber = sessionStorage.getItem(NUMBER_KEY) || "";
    savedList = parseAccountList(sessionStorage.getItem(ACCOUNTS_KEY));
    // Сразу вычищаем из Storage: nonce и (устаревший) токен одноразовые
    sessionStorage.removeItem(NONCE_KEY);
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch (err) {
    slog.warn("token: sessionStorage read failed", err);
  }
  let stash: Stash | null = null;
  if (isReloadNavigation()) {
    const ctrl = swController();
    if (ctrl && isStashNonce(nonce)) {
      let raw = await takeStashFromSW(ctrl, nonce);
      // Chrome: кадр stash_tokens выгружаемой страницы может дойти до SW позже, чем take_stash
      // новой, — одна повторная попытка через 300 мс (только при reload с nonce).
      if (!raw) {
        await new Promise(r => setTimeout(r, 300));
        raw = await takeStashFromSW(ctrl, nonce);
      }
      stash = raw ? parseStash(raw) : null;
    }
    if (!stash) stash = parseLegacyStash(legacyRaw, legacyNumber);
    // Контроллера нет (Shift+F5) — своя запись в SW не нужна, не держим её до TTL
    if (!ctrl) dropStashInSW(nonce);
  } else {
    dropStashInSW(nonce); // не reload — тайник не нужен, не держим его в RAM SW
  }
  accounts = restoreAccounts(stash, savedList);
  tokens = stash ? { ...stash.tokens } : {};
  syncNumbers();
}

/** Токен активного аккаунта ("" — активного нет). */
export function getToken(): string {
  return tokens[accounts.active] || "";
}

/** Номер активного аккаунта ("" — нет). */
export function getActiveNumber(): string {
  return accounts.active;
}

/** Номера аккаунтов этой вкладки в порядке добавления. */
export function listAccounts(): string[] {
  return [...accounts.numbers];
}

/**
 * Когда токен получен (монотонные часы) и его TTL: срок считается от получения, а не по часам
 * устройства (спешащие часы не должны стирать годный токен). После перезагрузки записи нет —
 * срок неизвестен, токен считается годным (решает relay: 4401).
 */
const receivedAt: Record<string, { perf: number; ttl: number | null }> = {};
function noteReceived(number: string, value: string): void {
  try { receivedAt[number] = { perf: performance.now(), ttl: jwtTtlSeconds(value) }; } catch { /* ignore */ }
}

/** Записать (ротация) токен активного аккаунта. */
export function setToken(value: string): void {
  if (!accounts.active) return;
  setTokenFor(accounts.active, value);
}

/** Записать (ротация) токен конкретного аккаунта; чужой/неизвестный номер игнорируется. */
export function setTokenFor(number: string, value: string): void {
  if (!accounts.numbers.includes(number)) return;
  if (value) { tokens[number] = value; noteReceived(number, value); }
}

/**
 * Вход: добавить аккаунт с токеном и сделать его активным. Уже добавленный номер — токен
 * заменяется, номер становится активным. Возвращает false на лимите (MAX_ACCOUNTS) или при
 * некорректном номере.
 */
export function addAccountToken(number: string, value: string): boolean {
  if (!isAccountNumber(number) || !value) return false;
  if (accounts.numbers.includes(number)) {
    tokens[number] = value;
    noteReceived(number, value);
    accounts = switchAccount(accounts, number);
  } else {
    const r = addAccount(accounts, number);
    if (r.result !== "ok") return false;
    accounts = r.state;
    tokens[number] = value;
    noteReceived(number, value);
  }
  syncNumbers();
  return true;
}

/** Сделать активным уже добавленный аккаунт (его токен уже в памяти). */
export function activateAccount(number: string): boolean {
  if (!accounts.numbers.includes(number) || !tokens[number]) return false;
  accounts = switchAccount(accounts, number);
  syncNumbers();
  return true;
}

/** Токена нет или с его получения прошёл TTL (по монотонным часам; неизвестный срок — не истёк). */
export function isTokenExpiredFor(number: string): boolean {
  if (!tokens[number]) return true;
  const r = receivedAt[number];
  return !!r && isTtlElapsed(r.ttl, performance.now() - r.perf);
}

/** Есть ли в памяти токен аккаунта. */
export function hasTokenFor(number: string): boolean {
  return !!tokens[number];
}

/**
 * Перезагрузка вкладки без повторного входа. Пока страница работает, токенов в Storage нет. На
 * `pagehide` (F5, переход, закрытие) токены уходят в RAM контроллера Service Worker (`stash_tokens`,
 * TTL 30 с, чтение одноразовое), а в sessionStorage остаётся лишь случайный nonce — по нему
 * `restoreSession` заберёт токены при перезагрузке. Закрытие вкладки/браузера = выход: тайник живёт
 * только в RAM SW и сам истекает. Нет SW-контроллера — тайник не создаётся (перезагрузка = вход).
 * TTL токена и привязка к device hint (BE-30) не меняются; logout/panic стирают токены и тайник.
 */
export function stashTokenForReload(): void {
  const payload = serializeStash(accounts, tokens);
  if (!payload) return;
  const ctrl = swController();
  if (!ctrl) return;
  try {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const nonce = nonceFromBytes(bytes);
    ctrl.postMessage({ op: "stash_tokens", nonce, payload });
    lastStashNonce = nonce;
    sessionStorage.setItem(NONCE_KEY, nonce);
  } catch {
    /* ignore — после перезагрузки потребуется вход */
  }
}

function dropStash(): void {
  let nonce = lastStashNonce;
  try {
    nonce = nonce || sessionStorage.getItem(NONCE_KEY) || "";
    sessionStorage.removeItem(NONCE_KEY);
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch { /* ignore */ }
  lastStashNonce = "";
  dropStashInSW(nonce);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", stashTokenForReload);
  // Возврат из bfcache без перезагрузки: страница снова работает — тайник стирается (и в SW, и nonce).
  window.addEventListener("pageshow", (e: PageTransitionEvent) => { if (e.persisted) dropStash(); });
}

/**
 * Убрать токен аккаунта `number` (выход/4401); без аргумента — все (panic). Если удалён активный,
 * активным становится сосед по списку (`getActiveNumber()` покажет, кто); "" — других нет.
 */
export function clearToken(number?: string): void {
  if (number === undefined) {
    tokens = {};
    for (const k of Object.keys(receivedAt)) delete receivedAt[k];
    accounts = emptyAccounts();
  } else if (accounts.numbers.includes(number)) {
    const next = accounts.active === number ? nextActiveAfterRemoval(accounts.numbers, number) : accounts.active;
    accounts = { numbers: accounts.numbers.filter(n => n !== number), active: next };
    delete tokens[number];
    delete receivedAt[number];
  }
  dropStash();
  syncNumbers();
}
