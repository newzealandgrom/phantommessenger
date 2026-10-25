/* Данные оператора сервера для /terms, /privacy и модалки на экране входа.
 *
 * Сервер оператора (self-hosted) отдаёт `/operator.json` (его пишет установщик selfhost/):
 *   { "version": 1, "name", "siteUrl", "contactEmail", "termsUrl"?, "privacyUrl"?, "securityReport" }
 * Файла нет, ответ не JSON, таймаут или любое нарушение схемы → значения проекта по умолчанию
 * (так выглядит прод phantommessenger.org). Файл читается строго: он попадает в текст юридических
 * страниц и в href, поэтому берутся только проверенные строки, URL — только https:, e-mail — по регэкспу.
 * Без импортов — модуль гоняется в node-тесте (scripts/test-operator.mjs) как есть. */

export interface OperatorInfo {
  name: string;
  siteUrl: string;
  contactEmail: string;
  /** null — страница условий этого же сервера (`/terms`). */
  termsUrl: string | null;
  /** null — страница политики этого же сервера (`/privacy`). */
  privacyUrl: string | null;
  /** Есть ли у оператора сводка аудита (`/SECURITY_AUDIT.md`). */
  securityReport: boolean;
}

export const DEFAULT_OPERATOR: OperatorInfo = {
  name: "Phantom Messenger",
  siteUrl: "https://phantommessenger.org",
  contactEmail: "admin@phantommessenger.org",
  termsUrl: null,
  privacyUrl: null,
  securityReport: true,
};

const MAX_FIELD = 200;
const MAX_BODY_BYTES = 4096;
export const OPERATOR_FETCH_TIMEOUT_MS = 3000;

// Локальная часть + домен с точкой и TLD; без пробелов, скобок, кавычек и <>.
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}$/;
// Символы, которые ломают разметку [текст](url) в legalContent или href.
const URL_FORBIDDEN_RE = /[\s()<>"'`\\[\]{}|^]/;
// Управляющие символы и разметка мини-языка legalContent ([ ] ( ) * `) в имени оператора.
const NAME_FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f[\]()*`<>\u2028\u2029]/;

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= MAX_FIELD ? s : null;
}

/** Только `https:`, без userinfo, с хостом; возвращает исходную строку без хвостового «/». */
export function validHttpsUrl(v: unknown): string | null {
  const s = str(v);
  if (s === null || URL_FORBIDDEN_RE.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return s.replace(/\/+$/, "");
}

export function validEmail(v: unknown): string | null {
  const s = str(v);
  return s !== null && EMAIL_RE.test(s) ? s : null;
}

export function validName(v: unknown): string | null {
  const s = str(v);
  return s !== null && !NAME_FORBIDDEN_RE.test(s) ? s : null;
}

/** Строгая проверка разобранного JSON. null — файл негоден целиком (ничего не смешиваем с дефолтами). */
export function parseOperatorInfo(raw: unknown): OperatorInfo | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== undefined && o.version !== 1) return null;
  const name = validName(o.name);
  const siteUrl = validHttpsUrl(o.siteUrl);
  const contactEmail = validEmail(o.contactEmail);
  if (name === null || siteUrl === null || contactEmail === null) return null;
  let termsUrl: string | null = null;
  if (o.termsUrl !== undefined && o.termsUrl !== null) {
    termsUrl = validHttpsUrl(o.termsUrl);
    if (termsUrl === null) return null;
  }
  let privacyUrl: string | null = null;
  if (o.privacyUrl !== undefined && o.privacyUrl !== null) {
    privacyUrl = validHttpsUrl(o.privacyUrl);
    if (privacyUrl === null) return null;
  }
  // Сводка аудита описывает наш прод: чужому серверу ссылка по умолчанию не показывается.
  const securityReport = o.securityReport === true;
  return { name, siteUrl, contactEmail, termsUrl, privacyUrl, securityReport };
}

/** Разбор тела ответа: лимит размера, JSON, схема. */
export function parseOperatorBody(text: string): OperatorInfo | null {
  if (text.length > MAX_BODY_BYTES) return null;
  try { return parseOperatorInfo(JSON.parse(text)); } catch { return null; }
}

export function siteHost(op: OperatorInfo): string {
  try { return new URL(op.siteUrl).host; } catch { return op.siteUrl; }
}

/** Сервер не прод (оператор подставил свои данные) — тексты получают пометку об операторе. */
export function isCustomOperator(op: OperatorInfo): boolean {
  return op.contactEmail !== DEFAULT_OPERATOR.contactEmail || op.siteUrl !== DEFAULT_OPERATOR.siteUrl;
}

let cached: OperatorInfo | null = null;
let inflight: Promise<OperatorInfo> | null = null;

/** Значение, если уже загружено; иначе null. */
export function operatorLoaded(): OperatorInfo | null {
  return cached;
}

/** Читает /operator.json того же origin один раз за загрузку страницы. Никогда не бросает. */
export function loadOperator(): Promise<OperatorInfo> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    let result = DEFAULT_OPERATOR;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OPERATOR_FETCH_TIMEOUT_MS);
    try {
      const r = await fetch("/operator.json", {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
      // SPA-fallback relay отдаёт index.html с 200 — это «файла нет».
      if (r.ok && (r.headers.get("content-type") || "").toLowerCase().includes("json")) {
        const parsed = parseOperatorBody(await r.text());
        if (parsed) result = parsed;
      }
    } catch {
      /* нет сети/таймаут — значения по умолчанию */
    } finally {
      clearTimeout(timer);
    }
    cached = result;
    return result;
  })();
  return inflight;
}
