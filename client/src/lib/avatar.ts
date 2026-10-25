/**
 * Avatar URL sanitiser.
 *
 * Avatars arrive from two sources: (a) peers, via the relay, which validates
 * them server-side but could still be bypassed by a compromised relay, and
 * (b) our own localStorage, which any browser extension or XSS payload can
 * overwrite. We refuse to plug an untrusted URL into `background-image: url(…)`
 * or `<img src=…>`: `javascript:`, `data:text/html`, `data:image/svg+xml`
 * (which allows inline `<script>`), `vbscript:` and relative-protocol URLs
 * would all turn into stored XSS.
 *
 * Whitelist:
 *   https://<host>/<path>
 *   data:image/png;base64,<payload>
 *   data:image/jpeg;base64,<payload>
 *   data:image/jpg;base64,<payload>
 *   data:image/webp;base64,<payload>
 *   data:image/gif;base64,<payload>
 *
 * SVG is intentionally excluded — it carries executable script by design.
 */

const DATA_PREFIXES = [
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/jpg;base64,",
  "data:image/webp;base64,",
  "data:image/gif;base64,",
] as const;

const MAX_AVATAR_LEN = 8192;

export function safeAvatar(url: unknown): string {
  if (typeof url !== "string") return "";
  const s = url.trim();
  if (!s || s.length > MAX_AVATAR_LEN) return "";
  if (s.startsWith("data:")) {
    return DATA_PREFIXES.some(p => s.startsWith(p)) ? s : "";
  }
  // https:// only — reject http, javascript, vbscript, file, chrome-extension etc.
  if (!s.toLowerCase().startsWith("https://")) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || !u.host) return "";
    return s;
  } catch {
    return "";
  }
}

/** Return a CSS ``background-image`` string wrapped in `url("…")`.
 *  Escapes the URL for CSS so a trailing `")` in an avatar cannot break out.
 */
export function avatarBackgroundCss(url: unknown): string {
  const safe = safeAvatar(url);
  if (!safe) return "";
  // Escape quotes and backslashes per CSS url() grammar.
  const escaped = safe.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  return `url("${escaped}")`;
}
