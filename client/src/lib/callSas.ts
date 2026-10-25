/**
 * WEB-17: короткий код звонка (SAS) из DTLS-отпечатков обеих сторон.
 *
 * phantom-call-sas-v1 (documentation/call_sas_vector.json):
 *   fp   = значение первой строки `a=fingerprint:sha-256 XX:XX:…` SDP, без «:», в верхнем регистре
 *   x, y = два отпечатка (локальный и удалённый), отсортированные лексикографически
 *   h    = SHA-256(UTF-8("phantom-call-sas-v1|" + x + "|" + y))
 *   code = (big-endian uint32 из h[0..4]) mod 1 000 000, 6 цифр с ведущими нулями, вывод «ddd ddd»
 *
 * Relay видит SDP открытым текстом и может подменить `a=fingerprint` (MITM медиа). Тогда
 * у сторон окажутся разные пары отпечатков и разные коды — это выявляется сверкой голосом.
 */

const SAS_LABEL = "phantom-call-sas-v1";

export function sdpFingerprint(sdp: string | null | undefined): string | null {
  if (!sdp) return null;
  // Только первая строка sha-256 (паритет с iOS/macOS): битое значение в ней — null, следующие не смотрим
  const m = /^a=fingerprint:sha-256 (.*)$/im.exec(sdp);
  if (!m) return null;
  const fp = m[1].trim().replace(/:/g, "").toUpperCase();
  return /^[0-9A-F]{64}$/.test(fp) ? fp : null;
}

/**
 * CR-01: пин DTLS-отпечатка собеседника на время звонка (паритет с macOS `CallSession.acceptRemoteFingerprint`).
 * Первый SDP собеседника закрепляет отпечаток; любой следующий (обновление offer до «Принять»,
 * ренеготиация, ICE-рестарт, answer) обязан нести тот же. SDP без sha-256-отпечатка не принимается.
 * Возвращает отпечаток для запоминания или null — SDP отвергнут, звонок надо завершить.
 * Пин не аутентифицирует первый отпечаток — это делает сверка кода звонка голосом.
 */
export function acceptRemoteFingerprint(pinned: string | null | undefined, sdp: string | null | undefined): string | null {
  const fp = sdpFingerprint(sdp);
  if (!fp) return null;
  if (pinned && pinned !== fp) return null;
  return fp;
}

export async function callSasFromFingerprints(a: string, b: string): Promise<string> {
  const [x, y] = a < b ? [a, b] : [b, a];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SAS_LABEL}|${x}|${y}`));
  const h = new Uint8Array(digest);
  const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
  const code = String(n % 1_000_000).padStart(6, "0");
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** Код звонка по локальному и удалённому SDP; null, если в SDP нет sha-256 отпечатка. */
export async function callSas(localSdp: string | null | undefined, remoteSdp: string | null | undefined): Promise<string | null> {
  const a = sdpFingerprint(localSdp);
  const b = sdpFingerprint(remoteSdp);
  if (!a || !b) return null;
  return callSasFromFingerprints(a, b);
}
