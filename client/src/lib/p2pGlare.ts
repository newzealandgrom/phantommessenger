// P2P v2 §3.3: решение по входящему p2p_offer при своём незавершённом исходящем offer («вежливый пир»
// + правило «протухшего» offer). Чистая функция без импортов: та же логика — Core `P2PManager.handleOffer`
// (iOS/macOS); тест — scripts/test-p2p-glare.mjs.

/** Свой offer без answer дольше этого — вежливый пир его отбросил (перезагрузка, гейт доверия). */
export const P2P_GLARE_STALE_MS = 3000;
/** Отложенный («проигнорированный») чужой offer рассматривается повторно не дольше этого. */
export const P2P_DEFERRED_OFFER_TTL_MS = 10_000;

/** Наш незавершённый исходящий offer тому же номеру (null — нет). */
export type OwnOffer = { createdAt: number; answered: boolean } | null;

export type GlareDecision =
  | { action: "accept" }
  | { action: "ignore" }
  | { action: "defer"; retryInMs: number };

/**
 * - нет своего offer или наш номер больше (мы вежливые) → принять чужой (свой закрыть);
 * - наш номер меньше и на свой offer уже пришёл answer (ICE идёт) → игнор;
 * - наш номер меньше, answer нет, свой offer старше P2P_GLARE_STALE_MS → принять (вежливый пир
 *   ответил бы за это время — значит, наш offer он отбросил);
 * - иначе → отложить: повторить решение через retryInMs (настоящий glare: answer придёт раньше).
 */
export function decideIncomingOffer(self: string, from: string, own: OwnOffer, now: number): GlareDecision {
  if (!own) return { action: "accept" };
  if (self > from) return { action: "accept" };
  if (own.answered) return { action: "ignore" };
  const age = now - own.createdAt;
  if (age >= P2P_GLARE_STALE_MS) return { action: "accept" };
  return { action: "defer", retryInMs: Math.max(0, P2P_GLARE_STALE_MS - age) };
}
