/**
 * App Lock / Panic-PIN — единая модель (S10.7, X-05; documentation/PROTOCOL_S10_SPEC.md, Q13/Q14).
 *
 * PIN и panic-PIN хранятся только как верификатор PBKDF2-HMAC-SHA256
 * `{ v: 1, iter, salt (16 B, base64), hash (32 B, base64) }` — per-account в localStorage.
 * Открытое значение из старых версий хэшируется при первом чтении и удаляется.
 * Сравнение — constant-time; при каждой попытке считаются обе проверки (PIN и panic),
 * чтобы время ответа не выдавало наличие panic-PIN.
 * Счётчик неудач и `lockedUntil` персистентны: 1–4 — без задержки; 5 → 30 с; 6 → 1 мин;
 * 7 → 2 мин; 8 → 5 мин; 9 → 15 мин; 10-я неудача → полный wipe.
 *
 * Честно (Q13): на web счётчик лежит в localStorage и обнуляем тем, у кого есть доступ
 * к профилю браузера; блокировка защищает от случайного доступа к открытой вкладке.
 *
 * Модуль без импортов: его функции проверяет node-тест scripts/test-meta1.mjs.
 */

export const APPLOCK_PBKDF2_ITERATIONS = 310_000;
export const APPLOCK_SALT_BYTES = 16;
export const APPLOCK_HASH_BYTES = 32;
/** Неудача с этим номером — полный wipe. */
export const APPLOCK_WIPE_AFTER_FAILURES = 10;
/** С этой неудачи UI показывает задержку и «осталось N попыток». */
export const APPLOCK_WARN_FROM_FAILURES = 5;

export type PinVerifier = { v: 1; iter: number; salt: string; hash: string };
export type LockFailState = { failCount: number; lockedUntil: number };
export type UnlockResult = "ok" | "panic" | "fail";

/** Минимальный интерфейс хранилища (localStorage в приложении, Map-обёртка в тесте). */
export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

// Совпадает с accountKey() из lib/utils.ts (модуль намеренно без импортов)
const storeKey = (number: string, key: string) => `phantom_${number}_${key}`;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function derivePinHash(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const pinBytes = new TextEncoder().encode(pin);
  const key = await crypto.subtle.importKey("raw", pinBytes, "PBKDF2", false, ["deriveBits"]);
  pinBytes.fill(0);
  const saltBuf = new Uint8Array(salt.length);
  saltBuf.set(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuf, iterations },
    key,
    APPLOCK_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function createPinVerifier(
  pin: string,
  opts?: { iterations?: number; salt?: Uint8Array },
): Promise<PinVerifier> {
  const iter = opts?.iterations ?? APPLOCK_PBKDF2_ITERATIONS;
  const salt = opts?.salt ?? crypto.getRandomValues(new Uint8Array(APPLOCK_SALT_BYTES));
  const hash = await derivePinHash(pin, salt, iter);
  return { v: 1, iter, salt: toB64(salt), hash: toB64(hash) };
}

export function isPinVerifier(x: unknown): x is PinVerifier {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  if (r.v !== 1 || typeof r.iter !== "number" || !Number.isInteger(r.iter) || r.iter < 1) return false;
  if (typeof r.salt !== "string" || typeof r.hash !== "string") return false;
  try {
    return fromB64(r.salt).length === APPLOCK_SALT_BYTES && fromB64(r.hash).length === APPLOCK_HASH_BYTES;
  } catch { return false; }
}

/** Сравнение без раннего выхода: время не зависит от позиции первого различия. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// Фиктивный верификатор: при отсутствии PIN/panic-PIN проверка всё равно выполняется
// (тот же PBKDF2), чтобы время ответа не выдавало, задан ли panic-PIN.
const DUMMY_SALT = new Uint8Array(APPLOCK_SALT_BYTES);

/** Проверить PIN; `verifier` = null — вычислить вхолостую и вернуть false. */
export async function checkPin(pin: string, verifier: PinVerifier | null | undefined): Promise<boolean> {
  if (!verifier || !isPinVerifier(verifier)) {
    await derivePinHash(pin, DUMMY_SALT, APPLOCK_PBKDF2_ITERATIONS);
    return false;
  }
  const actual = await derivePinHash(pin, fromB64(verifier.salt), verifier.iter);
  return constantTimeEqual(actual, fromB64(verifier.hash));
}

/** Обе проверки вычисляются всегда и параллельно; panic-PIN при установке ≠ PIN. */
export async function checkUnlock(
  pin: string,
  pinVerifier: PinVerifier | null | undefined,
  panicVerifier: PinVerifier | null | undefined,
): Promise<UnlockResult> {
  const [okPin, okPanic] = await Promise.all([checkPin(pin, pinVerifier), checkPin(pin, panicVerifier)]);
  if (okPanic) return "panic";
  if (okPin) return "ok";
  return "fail";
}

/** Задержка после N-й подряд неудачи (N = новое значение failCount). */
export function failureDelayMs(failCount: number): number {
  if (failCount < 5) return 0;
  switch (failCount) {
    case 5: return 30_000;
    case 6: return 60_000;
    case 7: return 120_000;
    case 8: return 300_000;
    default: return 900_000; // 9 (10-я — wipe)
  }
}

/** Сколько неудачных попыток осталось до удаления данных. */
export function attemptsBeforeWipe(failCount: number): number {
  return Math.max(0, APPLOCK_WIPE_AFTER_FAILURES - failCount);
}

export function registerFailure(state: LockFailState, now: number): { state: LockFailState; wipe: boolean; delayMs: number } {
  const failCount = (state.failCount || 0) + 1;
  if (failCount >= APPLOCK_WIPE_AFTER_FAILURES) {
    return { state: { failCount, lockedUntil: 0 }, wipe: true, delayMs: 0 };
  }
  const delayMs = failureDelayMs(failCount);
  return { state: { failCount, lockedUntil: delayMs ? now + delayMs : 0 }, wipe: false, delayMs };
}

export function lockRemainingMs(state: LockFailState, now: number): number {
  return Math.max(0, (state.lockedUntil || 0) - now);
}

// ─── Хранилище (per-account) ───

export type AppLockRecord = {
  enabled: boolean;
  pinLength: number;
  inactivityTimeout: number;
  pinHash?: PinVerifier;
};
export type PanicRecord = { enabled: boolean; pinHash?: PinVerifier };

function readJson(kv: KeyValueStore, key: string): Record<string, unknown> {
  try {
    const v = JSON.parse(kv.getItem(key) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}

export function readAppLock(kv: KeyValueStore, number: string): AppLockRecord {
  const r = readJson(kv, storeKey(number, "applock"));
  const pinHash = isPinVerifier(r.pinHash) ? r.pinHash : undefined;
  return {
    // Без верификатора блокировка считается выключенной (нечем проверять)
    enabled: r.enabled === true && !!pinHash,
    pinLength: typeof r.pinLength === "number" ? r.pinLength : 6,
    inactivityTimeout: typeof r.inactivityTimeout === "number" ? r.inactivityTimeout : 300,
    pinHash,
  };
}

export function readPanic(kv: KeyValueStore, number: string): PanicRecord {
  const r = readJson(kv, storeKey(number, "panic"));
  const pinHash = isPinVerifier(r.pinHash) ? r.pinHash : undefined;
  return { enabled: r.enabled === true && !!pinHash, pinHash };
}

export function writeAppLock(kv: KeyValueStore, number: string, rec: AppLockRecord): void {
  kv.setItem(storeKey(number, "applock"), JSON.stringify(rec));
}

export function writePanic(kv: KeyValueStore, number: string, rec: PanicRecord): void {
  kv.setItem(storeKey(number, "panic"), JSON.stringify(rec));
}

/**
 * Миграция: открытые `applock.pin` / `panic.panicPin` старых версий хэшируются,
 * открытое значение удаляется. Возвращает true, если что-то было переписано.
 */
export async function migratePlainPins(kv: KeyValueStore, number: string): Promise<boolean> {
  if (!number) return false;
  let changed = false;
  const lockKey = storeKey(number, "applock");
  const lock = readJson(kv, lockKey);
  if ("pin" in lock) {
    const plain = typeof lock.pin === "string" ? lock.pin : "";
    delete lock.pin;
    if (plain && lock.enabled === true && !isPinVerifier(lock.pinHash)) lock.pinHash = await createPinVerifier(plain);
    if (!isPinVerifier(lock.pinHash)) lock.enabled = false;
    // Запись за время PBKDF2 стёрта (wipe/logout) — не воскрешать
    if (kv.getItem(lockKey) === null) return changed;
    kv.setItem(lockKey, JSON.stringify(lock));
    changed = true;
  }
  const panicKey = storeKey(number, "panic");
  const panic = readJson(kv, panicKey);
  if ("panicPin" in panic) {
    const plain = typeof panic.panicPin === "string" ? panic.panicPin : "";
    delete panic.panicPin;
    if (plain && panic.enabled === true && !isPinVerifier(panic.pinHash)) panic.pinHash = await createPinVerifier(plain);
    if (!isPinVerifier(panic.pinHash)) panic.enabled = false;
    if (kv.getItem(panicKey) === null) return changed;
    kv.setItem(panicKey, JSON.stringify(panic));
    changed = true;
  }
  return changed;
}

export function readFailState(kv: KeyValueStore, number: string): LockFailState {
  const r = readJson(kv, storeKey(number, "applock_fail"));
  const failCount = typeof r.failCount === "number" && r.failCount >= 0 ? Math.floor(r.failCount) : 0;
  const lockedUntil = typeof r.lockedUntil === "number" && r.lockedUntil > 0 ? r.lockedUntil : 0;
  return { failCount, lockedUntil };
}

export function writeFailState(kv: KeyValueStore, number: string, state: LockFailState): void {
  if (!state.failCount && !state.lockedUntil) kv.removeItem(storeKey(number, "applock_fail"));
  else kv.setItem(storeKey(number, "applock_fail"), JSON.stringify(state));
}

/** Установить PIN блокировки. Ошибка `same_as_panic`, если совпадает с panic-PIN. */
// isActive (ревью L-a): после PBKDF2 (сотни мс) аккаунт мог выйти/быть стёрт — тогда не пишем.
export async function setLockPin(
  kv: KeyValueStore, number: string, pin: string,
  opts: { pinLength: number; inactivityTimeout: number; isActive?: () => boolean },
): Promise<"ok" | "same_as_panic" | "inactive"> {
  const panic = readPanic(kv, number);
  if (panic.enabled && await checkPin(pin, panic.pinHash)) return "same_as_panic";
  const pinHash = await createPinVerifier(pin);
  if (opts.isActive && !opts.isActive()) return "inactive";
  writeAppLock(kv, number, { enabled: true, pinLength: opts.pinLength, inactivityTimeout: opts.inactivityTimeout, pinHash });
  writeFailState(kv, number, { failCount: 0, lockedUntil: 0 });
  return "ok";
}

/** Установить panic-PIN. Ошибка `same_as_pin`, если совпадает с PIN блокировки. */
export async function setPanicPin(
  kv: KeyValueStore, number: string, pin: string, isActive?: () => boolean,
): Promise<"ok" | "same_as_pin" | "inactive"> {
  const lock = readAppLock(kv, number);
  if (lock.enabled && await checkPin(pin, lock.pinHash)) return "same_as_pin";
  const pinHash = await createPinVerifier(pin);
  if (isActive && !isActive()) return "inactive";
  writePanic(kv, number, { enabled: true, pinHash });
  return "ok";
}
