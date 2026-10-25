/**
 * Санитизация исходящих ICE-кандидатов и SDP (S10.5/Q9, X-04; паритет с Android/iOS).
 *
 * - Кандидаты указанных типов (по умолчанию `host`; для P2P ещё `prflx`) вырезаются из SDP целиком.
 * - Во ВСЕХ оставшихся кандидатах (srflx/relay) `raddr <адрес> rport <порт>` заменяется на
 *   `raddr 0.0.0.0 rport 0`: у relay-кандидата raddr — это публичный (srflx) адрес, у srflx —
 *   локальный; при «Скрывать IP» иначе адрес утёк бы через raddr, в том числе в SDP ренеготиации.
 *
 * Чистый модуль без импортов: используется App.tsx и node-тестом scripts/test-meta1.mjs.
 */

const RADDR_RE = /(\sraddr\s)\S+(\srport\s)\d+/g;

/** Строка кандидата (`candidate:…` или `a=candidate:…`): raddr/rport обнуляются. */
export function sanitizeCandidateLine(line: string): string {
  return line.replace(RADDR_RE, "$10.0.0.0$20");
}

/** Объект из `RTCIceCandidate.toJSON()` для трикла: копия с обнулёнными raddr/rport. */
export function sanitizeIceCandidate(c: RTCIceCandidateInit): RTCIceCandidateInit {
  return typeof c.candidate === "string" ? { ...c, candidate: sanitizeCandidateLine(c.candidate) } : { ...c };
}

/** SDP: вырезать кандидаты типов `types`, в остальных обнулить raddr/rport. */
export function stripSdpCandidates(sdp: string | undefined, types: string[] = ["host"]): string | undefined {
  if (!sdp) return sdp;
  const drop = new RegExp(`^a=candidate:.*\\styp\\s(?:${types.join("|")})(?:\\s.*)?$`);
  return sdp
    .split(/\r\n|\n/)
    .filter(line => !drop.test(line))
    .map(line => (line.startsWith("a=candidate:") ? sanitizeCandidateLine(line) : line))
    .join("\r\n");
}
