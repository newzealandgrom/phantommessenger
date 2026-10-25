import { useEffect } from "react";
import type { ReactNode } from "react";
import { useT } from "../lib/i18n";
import type { Locale } from "../lib/i18n";
import { LEGAL_CHROME, LEGAL_REVISION, getLegalDoc } from "../lib/legalContent";
import { siteHost } from "../lib/operatorInfo";
import { useOperator } from "../lib/useOperator";
import type { LegalKind } from "../lib/legalContent";

/** Только свои пути и https — иначе ссылка не рендерится как <a>. mailto — только на контакт оператора
 *  (он уже проверен регэкспом в operatorInfo.ts). */
function isSafeHref(href: string, mailHref: string): boolean {
  return (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("https://") || href === mailHref;
}

/** Мини-разметка текста: [текст](url), **жирный**, `код`. Без dangerouslySetInnerHTML. */
function renderInline(text: string, mailHref: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined && m[2] !== undefined) {
      const external = m[2].startsWith("https://");
      out.push(isSafeHref(m[2], mailHref)
        ? <a key={i++} href={m[2]} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{m[1]}</a>
        : m[1]);
    } else if (m[3] !== undefined) {
      out.push(<strong key={i++}>{m[3]}</strong>);
    } else if (m[4] !== undefined) {
      out.push(<code key={i++}>{m[4]}</code>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LOCALES: Locale[] = ["ru", "en"];

/** Публичные страницы /terms и /privacy: без входа, без relay и Service Worker. */
export default function LegalPage({ kind }: { kind: LegalKind }) {
  const { locale, setLocale } = useT();
  const { op, ready } = useOperator();
  const doc = getLegalDoc(kind, locale, op);
  const mailHref = `mailto:${op.contactEmail}`;
  const chrome = LEGAL_CHROME[locale];
  const other: LegalKind = kind === "terms" ? "privacy" : "terms";

  useEffect(() => {
    document.title = `${doc.title} — ${op.name}`;
  }, [doc.title, op.name]);

  // Пока /operator.json не прочитан (≤ 3 с), текст не показываем: иначе на чужом сервере мелькнули бы наши контакты.
  if (!ready) return <div className="pm-legalpage" aria-busy="true" />;

  return (
    <div className="pm-legalpage">
      <header className="pm-legalpage-bar">
        <a className="pm-legalpage-brand" href={op.siteUrl}>{op.name}</a>
        <nav className="pm-legalpage-nav" aria-label="legal">
          <a href="/terms" aria-current={kind === "terms" ? "page" : undefined}>{chrome.terms}</a>
          <a href="/privacy" aria-current={kind === "privacy" ? "page" : undefined}>{chrome.privacy}</a>
        </nav>
        <div className="pm-legalpage-lang" role="group" aria-label="language">
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              className={l === locale ? "active" : ""}
              aria-pressed={l === locale}
              onClick={() => setLocale(l)}
            >{l.toUpperCase()}</button>
          ))}
        </div>
      </header>

      <main className="pm-legalpage-main">
        <h1>{doc.title}</h1>
        <div className="pm-legalpage-meta">{chrome.revision} {LEGAL_REVISION} · <a href={op.siteUrl}>{siteHost(op)}</a></div>
        <p className="pm-legalpage-lead">{renderInline(doc.lead, mailHref)}</p>
        <p className="pm-legalpage-clients">{chrome.clients}</p>

        {doc.sections.map((s) => (
          <section key={s.h}>
            <h2>{s.h}</h2>
            {s.p?.map((par, i) => <p key={i}>{renderInline(par, mailHref)}</p>)}
            {s.ul && (
              <ul>
                {s.ul.map((li, i) => <li key={i}>{renderInline(li, mailHref)}</li>)}
              </ul>
            )}
          </section>
        ))}
      </main>

      <footer className="pm-legalpage-foot">
        <a href={`/${other}`}>{other === "terms" ? chrome.terms : chrome.privacy}</a>
        {op.securityReport && <a href="/SECURITY_AUDIT.md">{chrome.audit}</a>}
        <a href="/">{chrome.openApp}</a>
      </footer>
    </div>
  );
}
