/**
 * localStorage wrappers with soft quotas.
 *
 * Browser localStorage is a shared 5–10 MB bucket across the origin. If any
 * injected code fills it, subsequent writes throw `QuotaExceededError` and
 * the app starts losing user state (drafts, avatars, theme). These helpers:
 *
 *  - cap per-value size (default 100 KB) so one runaway blob can't fill the
 *    quota on its own;
 *  - track an approximate total size and refuse writes that would push the
 *    origin past `TOTAL_BUDGET`;
 *  - swallow QuotaExceededError into a soft warning via {@link slog} rather
 *    than crashing the call site.
 */
import { slog } from "./log";

const MAX_VALUE_BYTES = 100_000;       // single entry cap
const TOTAL_BUDGET_BYTES = 4_500_000;  // ~4.5 MB; leaves headroom under 5 MB limit

// В логах ключ без номера аккаунта (X-08): phantom_<номер>_contacts → phantom_…_contacts
function logKey(key: string): string {
  return key.replace(/\d{6,}/g, "…");
}

function utf16ByteSize(s: string): number {
  // JS strings are UTF-16; browsers bill localStorage roughly as `length * 2`.
  return s.length * 2;
}

function currentUsage(): number {
  try {
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      const v = localStorage.getItem(k) ?? "";
      total += utf16ByteSize(k) + utf16ByteSize(v);
    }
    return total;
  } catch {
    return 0;
  }
}

export function safeSetItem(key: string, value: string): boolean {
  try {
    const vBytes = utf16ByteSize(value);
    if (vBytes > MAX_VALUE_BYTES) {
      slog.warn(`safeSetItem: oversized value for "${logKey(key)}" (${vBytes} B > ${MAX_VALUE_BYTES} B) — dropped`);
      return false;
    }
    const existing = localStorage.getItem(key);
    const existingBytes = existing ? utf16ByteSize(existing) + utf16ByteSize(key) : 0;
    const delta = vBytes + utf16ByteSize(key) - existingBytes;
    if (delta > 0 && currentUsage() + delta > TOTAL_BUDGET_BYTES) {
      slog.warn(`safeSetItem: total localStorage budget exceeded — "${logKey(key)}" dropped`);
      return false;
    }
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    // QuotaExceededError, SecurityError (private mode in some browsers), etc.
    slog.warn(`safeSetItem("${logKey(key)}"): ${(err as Error)?.message || err}`);
    return false;
  }
}

export function safeSetJson(key: string, value: unknown): boolean {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch (err) {
    slog.warn(`safeSetJson("${logKey(key)}"): JSON.stringify failed — ${(err as Error)?.message || err}`);
    return false;
  }
  return safeSetItem(key, s);
}
