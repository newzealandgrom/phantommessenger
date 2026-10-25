/**
 * Мультиаккаунт web (до 3 номеров в одной вкладке) — чистая логика без React и без Storage.
 *
 * Состояние — упорядоченный список номеров и активный номер. Токены хранит `token.ts`
 * (только в памяти); сюда относится сериализация «тайника для перезагрузки»
 * (`sessionStorage["phantom_token"]`, JSON `{active, tokens:{номер: токен}}`).
 */

export const MAX_ACCOUNTS = 3;

export interface AccountsState {
  /** Номера в порядке добавления. */
  numbers: string[];
  /** Активный номер ("" — активного нет). */
  active: string;
}

export type AddResult = "ok" | "duplicate" | "limit";

const NUMBER_RE = /^\d{10}$/;

export function isAccountNumber(value: unknown): value is string {
  return typeof value === "string" && NUMBER_RE.test(value);
}

export function emptyAccounts(): AccountsState {
  return { numbers: [], active: "" };
}

/** Добавить номер и сделать его активным. Дубль и 4-й аккаунт — отказ без изменения состояния. */
export function addAccount(s: AccountsState, number: string): { state: AccountsState; result: AddResult } {
  if (!isAccountNumber(number)) return { state: s, result: "duplicate" };
  if (s.numbers.includes(number)) return { state: s, result: "duplicate" };
  if (s.numbers.length >= MAX_ACCOUNTS) return { state: s, result: "limit" };
  return { state: { numbers: [...s.numbers, number], active: number }, result: "ok" };
}

/** Можно ли ещё добавить аккаунт (кнопка «Добавить аккаунт» скрывается на лимите). */
export function canAddAccount(s: AccountsState): boolean {
  return s.numbers.length < MAX_ACCOUNTS;
}

/**
 * Следующий активный номер после удаления `removed`: сосед справа в списке, а если удалён
 * последний — сосед слева; "" — если других не осталось.
 */
export function nextActiveAfterRemoval(numbers: string[], removed: string): string {
  const idx = numbers.indexOf(removed);
  const rest = numbers.filter(n => n !== removed);
  if (rest.length === 0) return "";
  if (idx < 0) return rest[0];
  return rest[Math.min(idx, rest.length - 1)];
}

/** Удалить номер. Если он был активным — активным становится следующий (см. выше). */
export function removeAccount(s: AccountsState, number: string): AccountsState {
  if (!s.numbers.includes(number)) return s;
  const numbers = s.numbers.filter(n => n !== number);
  const active = s.active === number ? nextActiveAfterRemoval(s.numbers, number) : s.active;
  return { numbers, active };
}

/** Переключить активный номер (только на уже добавленный). */
export function switchAccount(s: AccountsState, number: string): AccountsState {
  if (!s.numbers.includes(number) || s.active === number) return s;
  return { numbers: s.numbers, active: number };
}

export interface Stash {
  active: string;
  tokens: Record<string, string>;
}

/** Тайник: JSON `{active, tokens}`. Пустой набор токенов — пустая строка (тайник не пишется). */
export function serializeStash(s: AccountsState, tokens: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const n of s.numbers) {
    const t = tokens[n];
    if (isAccountNumber(n) && typeof t === "string" && t) out[n] = t;
  }
  if (Object.keys(out).length === 0) return "";
  const active = out[s.active] ? s.active : Object.keys(out)[0];
  return JSON.stringify({ active, tokens: out });
}

/**
 * Разбор тайника. Всё, что не соответствует форме (чужой JSON, не те типы, больше
 * MAX_ACCOUNTS, активный не из списка), отбрасывается; null — тайник непригоден.
 */
export function parseStash(raw: string): Stash | null {
  if (!raw) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== "object") return null;
  const obj = data as { active?: unknown; tokens?: unknown };
  if (!obj.tokens || typeof obj.tokens !== "object" || Array.isArray(obj.tokens)) return null;
  const tokens: Record<string, string> = {};
  for (const [n, t] of Object.entries(obj.tokens as Record<string, unknown>)) {
    if (isAccountNumber(n) && typeof t === "string" && t) tokens[n] = t;
    if (Object.keys(tokens).length >= MAX_ACCOUNTS) break;
  }
  const numbers = Object.keys(tokens);
  if (numbers.length === 0) return null;
  const active = typeof obj.active === "string" && tokens[obj.active] ? obj.active : numbers[0];
  return { active, tokens };
}

/** Список номеров из `sessionStorage["phantom_accounts"]` (JSON-массив, только номера). */
export function parseAccountList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const n of arr) if (isAccountNumber(n) && !out.includes(n)) out.push(n);
    return out.slice(0, MAX_ACCOUNTS);
  } catch { return []; }
}

/**
 * Восстановление состояния после перезагрузки: порядок — из сохранённого списка, только
 * номера с токеном в тайнике; номера тайника, которых нет в списке, добавляются в конец.
 */
export function restoreAccounts(stash: Stash | null, savedList: string[]): AccountsState {
  if (!stash) return emptyAccounts();
  const numbers: string[] = [];
  for (const n of savedList) if (stash.tokens[n] && !numbers.includes(n)) numbers.push(n);
  for (const n of Object.keys(stash.tokens)) if (!numbers.includes(n)) numbers.push(n);
  const capped = numbers.slice(0, MAX_ACCOUNTS);
  const active = capped.includes(stash.active) ? stash.active : capped[0];
  return { numbers: capped, active };
}

const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/**
 * Совместимость с выложенной версией 6a: она клала в `sessionStorage["phantom_token"]` голый JWT
 * (а номер — в `phantom_number`). Принимается только форма `JWT + корректный номер`; новая схема
 * этот ключ больше не пишет.
 */
export function parseLegacyStash(raw: string | null, number: string | null): Stash | null {
  if (!raw || !number || !isAccountNumber(number)) return null;
  if (!JWT_RE.test(raw)) return null;
  return { active: number, tokens: { [number]: raw } };
}

/** Одноразовый nonce тайника в SW: base64url, 16–64 символа (то же правило проверяет sw.js). */
export function isStashNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

/** Nonce из случайных байтов (≥ 16 байт → ≥ 22 символа base64url). */
export function nonceFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Перезагрузка ли это загрузка страницы. `nav` — запись Navigation Timing L2
 * (`performance.getEntriesByType("navigation")[0]`), `legacyType` — `performance.navigation.type`
 * старых движков (1 = reload). Внедряется снаружи, чтобы тестировать без браузера.
 */
export function isReloadNavType(nav: { type?: unknown } | undefined | null, legacyType?: number): boolean {
  if (nav && typeof nav.type === "string") return nav.type === "reload";
  return legacyType === 1;
}

/** Срок жизни токена в секундах (`exp - iat`) — не зависит от часов устройства; null — не разобрать. */
export function jwtTtlSeconds(token: string): number | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const obj = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
    const ttl = obj?.exp - obj?.iat;
    return typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? ttl : null;
  } catch { return null; }
}

/** Прошёл ли TTL: `elapsedMs` — время с получения токена по монотонным часам (performance.now). */
export function isTtlElapsed(ttlSec: number | null, elapsedMs: number, marginMs = 5000): boolean {
  return ttlSec !== null && elapsedMs + marginMs >= ttlSec * 1000;
}
