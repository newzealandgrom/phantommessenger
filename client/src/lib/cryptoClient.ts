/**
 * Crypto client — delegates ALL private-key operations to the Service Worker.
 *
 * Contract: if the SW is unavailable the crypto module refuses to initialise.
 * There is no main-thread fallback: keeping the key material in a module
 * closure would still expose it to every browser extension that can read the
 * page's JS heap, and page-level XSS would get `decrypt()` for free. We fail
 * closed and let the UI show "browser not supported" instead.
 *
 * The SW's handler validates `event.origin`, so this module must be the
 * only source of messages it accepts — see `client/public/sw.js`.
 */
import type { EncryptedBlob } from "../types";
import { slog } from "./log";

export const EXPECTED_SW_VERSION = 6;

/** Имя IndexedDB с ключом устройства — должно совпадать с `_IDB_NAME` в sw.js. */
const KEYSTORE_DB_NAME = "phantom-keystore";
/** Store и префикс записи ключа — должны совпадать с `_IDB_STORE`/`_IDB_KEY_PREFIX` в sw.js. */
const KEYSTORE_STORE = "keys";
const KEYSTORE_KEY_PREFIX = "device-ecdh-p256";


/** Thrown when no SW controls this page (private mode, 1st-load race, unregister). */
export class CryptoUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CryptoUnavailableError";
  }
}

/** Wait for a SW controller to become available. Returns null on timeout.
 *
 * Fresh-install and post-unregister paths both leave the page with no
 * controller for a short window while the browser activates the worker.
 * Without this wait, the first `createKeys()` call after a page load would
 * synchronously reject with `no_sw_controller`, leading the app to log the
 * user out before the SW even finished installing.
 */
async function awaitController(timeoutMs = 5000): Promise<ServiceWorker | null> {
  if (!("serviceWorker" in navigator)) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  try { await navigator.serviceWorker.ready; } catch { /* ignore */ }
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(navigator.serviceWorker.controller ?? null), timeoutMs);
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => { clearTimeout(timer); resolve(navigator.serviceWorker.controller ?? null); },
      { once: true },
    );
  });
}

/** Send a crypto operation to the Service Worker via a MessageChannel.
 *
 * The SW replies on `mc.port2` (delivered via `event.ports[0]` inside its
 * handler); we close `mc.port1` unconditionally — on success, on reject, on
 * timeout — so ports never accumulate if the SW ever stops responding.
 */
async function postToSW<T>(msg: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
  const ctrl = await awaitController();
  if (!ctrl) throw new CryptoUnavailableError("no_sw_controller");
  return new Promise((resolve, reject) => {
    const mc = new MessageChannel();
    let settled = false;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { mc.port1.close(); } catch { /* ignore */ }
      if (ok) resolve(value as T);
      else reject(value instanceof Error ? value : new Error(String(value)));
    };
    const timer = setTimeout(() => finish(false, new Error("sw_timeout")), timeoutMs);
    mc.port1.onmessage = (e) => {
      if (e.data && e.data.ok) finish(true, e.data.result);
      else finish(false, new Error((e.data && e.data.error) || "sw_error"));
    };
    try {
      ctrl.postMessage(msg, [mc.port2]);
    } catch (err) {
      finish(false, err);
    }
  });
}

/** Wait for SW controller to become available (handles first-load race). */
async function waitForSW(timeoutMs = 3000): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  if (navigator.serviceWorker.controller) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(!!navigator.serviceWorker.controller), timeoutMs);
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => { clearTimeout(timer); resolve(true); },
      { once: true },
    );
  });
}

/** Call once on boot. Rejects if crypto is unusable so UI can show a banner. */
export async function ensureSecureCrypto(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    throw new CryptoUnavailableError("serviceworker_unsupported");
  }
  const ok = await waitForSW();
  if (!ok) {
    throw new CryptoUnavailableError("sw_controller_missing");
  }
  // Healthcheck: confirm version matches. Mismatched SW version means either
  // a stale cached worker or a hostile swap — we'd rather refuse than trust.
  try {
    const pong = await postToSW<{ version: number }>({ op: "healthcheck" }, 4000);
    if (!pong || pong.version !== EXPECTED_SW_VERSION) {
      throw new CryptoUnavailableError(`sw_version_mismatch:${pong?.version}`);
    }
  } catch (err) {
    if (err instanceof CryptoUnavailableError) throw err;
    slog.error("crypto: SW healthcheck failed", err);
    throw new CryptoUnavailableError("sw_healthcheck_failed");
  }
}

/** Ключ устройства (S2) для номера `number`: SW поднимает пару из IndexedDB,
 *  иначе создаёт и сохраняет. Пара своя у каждого номера — разные аккаунты
 *  одного браузера не регистрируют на relay общий publicKey. Приватный ключ
 *  остаётся non-extractable внутри SW. */
export async function loadOrCreateKeys(number: string): Promise<{ publicKey: string }> {
  return postToSW<{ publicKey: string }>({ op: "loadOrCreateKeys", number });
}

/** Encrypt a message — offloaded to SW.
 *  `opts.version: 2` — конверт v2 (S9): SW дополнительно смешивает ECDH своего
 *  persistent-ключа номера `opts.keyNumber` (по умолчанию `fromNumber`) с ключом
 *  собеседника. Без `opts` — v1, как раньше. */
export async function encrypt(
  text: string,
  fromNumber: string,
  toNumber: string,
  targetPublicKey: string,
  opts?: { version?: 1 | 2; keyNumber?: string },
): Promise<EncryptedBlob> {
  const version = opts?.version === 2 ? 2 : 1;
  return postToSW<EncryptedBlob>({
    op: "encrypt", text, fromNumber, toNumber, targetPublicKey,
    version, keyNumber: opts?.keyNumber || fromNumber,
  });
}

/** Ошибка SW для blob с `version ≥ 3` (P3): показывать «Неподдерживаемая версия», не «не удалось расшифровать». */
export function isUnsupportedVersionError(err: unknown): boolean {
  return err instanceof Error && err.message === "unsupported_version";
}

/** Decrypt a message — offloaded to SW (uses its private key).
 *  `keyNumber` — чей ключ использовать (по умолчанию получатель `toNumber`;
 *  для message_sync, где получатель — собеседник, передаётся свой номер). */
export async function decrypt(
  blob: EncryptedBlob,
  fromNumber: string,
  toNumber: string,
  keyNumber?: string,
): Promise<string> {
  return postToSW<string>({ op: "decrypt", blob, fromNumber, toNumber, keyNumber: keyNumber || toNumber });
}

/** Выгрузить ключи из RAM SW — fire-and-forget (beforeunload и т.п.).
 *  `erase: true` + `number` — logout: из IndexedDB стирается ключ этого номера;
 *  `erase: true` + `all: true` (или без number) — panic: стираются все ключи
 *  устройства. При следующем входе будет создан новый ключ (S2). */
export function wipe(opts?: { erase?: boolean; number?: string; all?: boolean }): void {
  const erase = opts?.erase === true;
  const all = opts?.all === true || !opts?.number;
  const number = all ? "" : (opts?.number || "");
  try {
    const ctrl = navigator.serviceWorker?.controller;
    if (ctrl) {
      ctrl.postMessage({ op: "wipe", erase, number, all });
      return;
    }
  } catch { /* ignore */ }
  // SW не управляет страницей — стираем хранилище ключа напрямую (та же origin-БД,
  // что открывает sw.js).
  if (!erase) return;
  if (all) {
    // Если SW сейчас держит БД открытой, удаление выполнится, как только он её
    // закроет (sw.js закрывает БД после каждой транзакции).
    try { indexedDB.deleteDatabase(KEYSTORE_DB_NAME); } catch { /* ignore */ }
    return;
  }
  try {
    const req = indexedDB.open(KEYSTORE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      // БД ещё не было — стирать нечего; создаём store, чтобы схема совпала с sw.js
      if (!req.result.objectStoreNames.contains(KEYSTORE_STORE)) req.result.createObjectStore(KEYSTORE_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(KEYSTORE_STORE, "readwrite");
        tx.objectStore(KEYSTORE_STORE).delete(`${KEYSTORE_KEY_PREFIX}:${number}`);
        tx.oncomplete = tx.onerror = tx.onabort = () => db.close();
      } catch { db.close(); }
    };
  } catch { /* ignore */ }
}

/**
 * Q14 / X-06: стирание ключа устройства с подтверждением. Отдельное сообщение `wipe`
 * доходит до SW, который стирает запись(и) IndexedDB `phantom-keystore` и отвечает на порт.
 * `all` (panic, 10-я неудача PIN, удаление аккаунта) — дополнительно со страницы удаляется
 * вся БД (если SW держит соединение, удаление завершится, как только он его закроет).
 * Возвращает true, если SW подтвердил стирание.
 */
export async function wipeKeysAndWait(opts: { number?: string; all?: boolean }, timeoutMs = 3000): Promise<boolean> {
  const all = opts.all === true || !opts.number;
  let acked = false;
  try {
    const ctrl = navigator.serviceWorker?.controller;
    if (ctrl) {
      acked = await new Promise<boolean>((resolve) => {
        const mc = new MessageChannel();
        const done = (ok: boolean) => {
          clearTimeout(timer);
          try { mc.port1.close(); } catch { /* ignore */ }
          resolve(ok);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        mc.port1.onmessage = (e) => done(!!(e.data && e.data.ok));
        ctrl.postMessage({ op: "wipe", erase: true, number: all ? "" : opts.number, all }, [mc.port2]);
      });
    }
  } catch { acked = false; }
  if (all) {
    await new Promise<void>((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(KEYSTORE_DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      } catch { resolve(); }
    });
    return acked;
  }
  // SW не ответил — стираем запись номера напрямую со страницы
  if (!acked) wipe({ erase: true, number: opts.number });
  return acked;
}

/** Check whether the SW holds an active session key. */
export async function hasKey(): Promise<boolean> {
  try {
    return await postToSW<boolean>({ op: "hasKey" });
  } catch {
    return false;
  }
}
