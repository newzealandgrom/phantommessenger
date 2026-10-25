import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import VisualCatalog from "./visual/VisualCatalog";
import LegalPage from "./components/LegalPage";
import { legalKindFromPath } from "./lib/legalContent";
import { ToastProvider } from "./components/Toast";
import { I18nProvider } from "./lib/i18n";
import { applyVibe, getStoredVibe } from "./lib/vibe";
import "./fonts/fonts.css";
import "./styles.css";
import "./styles/redesign.css";
import { slog } from "./lib/log";
import { EXPECTED_SW_VERSION } from "./lib/cryptoClient";
import { restoreSession } from "./lib/token";

/**
 * Service Worker registration with strict validation.
 *
 * The worker holds the private key and authoritative crypto code. A
 * compromised CDN could otherwise swap `sw.js` for a wallet-draining
 * variant and the user would see no difference. We therefore:
 *   1. register with an explicit ``/`` scope,
 *   2. require the installed scope to match the page origin exactly (a
 *      path-scoped leftover from a stale deployment gets unregistered),
 *   3. probe it with a `healthcheck` message; if the version does not match
 *      the one this bundle was shipped with, we unregister rather than
 *      trust what is there.
 */
const SW_RELOAD_FLAG = "phantom_sw_reloaded";

function probeController(timeoutMs = 4000): Promise<{ version?: number } | null> {
  return probeWorker(navigator.serviceWorker.controller, timeoutMs);
}

function probeWorker(ctrl: ServiceWorker | null, timeoutMs = 4000): Promise<{ version?: number } | null> {
  return new Promise((resolve) => {
    if (!ctrl) { resolve(null); return; }
    const mc = new MessageChannel();
    const timer = setTimeout(() => {
      try { mc.port1.close(); } catch { /* ignore */ }
      resolve(null);
    }, timeoutMs);
    mc.port1.onmessage = (e) => {
      clearTimeout(timer);
      try { mc.port1.close(); } catch { /* ignore */ }
      resolve((e.data && e.data.result) || null);
    };
    try { ctrl.postMessage({ op: "healthcheck" }, [mc.port2]); }
    catch { clearTimeout(timer); resolve(null); }
  });
}

async function claimByHealthyWorker(reg: ServiceWorkerRegistration): Promise<boolean> {
  const active = reg.active;
  if (!active) return false;
  const pong = await probeWorker(active, 2000);
  if (!pong || pong.version !== EXPECTED_SW_VERSION) return false;
  const changed = new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => { navigator.serviceWorker.removeEventListener("controllerchange", on); resolve(ok); };
    const on = () => done(true);
    navigator.serviceWorker.addEventListener("controllerchange", on);
    setTimeout(() => done(false), 2000);
  });
  try { active.postMessage({ op: "claim" }); } catch { return false; }
  return (await changed) && !!navigator.serviceWorker.controller;
}

// updateViaCache: "none" — проверка обновлений sw.js и importScripts('/envelope-v2.js')
// идёт мимо HTTP-кэша: устаревший модуль конверта v2 не должен пережить деплой.
async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    slog.warn("sw: serviceWorker unsupported — crypto will refuse to init");
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    const expectedScope = location.origin + "/";
    if (reg.scope !== expectedScope) {
      slog.error(`sw: unexpected scope ${reg.scope} (expected ${expectedScope}) — unregistering`);
      await reg.unregister();
      return;
    }
    await navigator.serviceWorker.ready;

    // Shift+F5: страница загружена мимо SW (контроллера нет), а активный воркер исправен —
    // просим его взять страницу под управление, а не снимаем регистрацию у всей origin
    // (иначе другие вкладки теряют контроллер и вход на следующем F5). Не вышло (старый SW
    // без op "claim") — ниже прежний путь: unregister + однократная перезагрузка.
    if (!navigator.serviceWorker.controller && await claimByHealthyWorker(reg)) {
      slog.warn("sw: page loaded without controller (hard reload) — claimed by the active worker");
    }

    let pong = await probeController();

    // If the installed worker is stale (e.g. previous deploy's `sw.js` still
    // cached), its healthcheck reply will be undefined. We unregister it,
    // then do a one-shot reload so the browser fetches the fresh `sw.js`
    // and picks it up on next boot. A sessionStorage flag prevents an
    // infinite reload loop on environments where the SW cannot be replaced.
    if (!pong || pong.version !== EXPECTED_SW_VERSION) {
      slog.error(`sw: healthcheck version mismatch (got=${pong?.version}, expected=${EXPECTED_SW_VERSION}) — unregistering`);
      await reg.unregister();
      try {
        // Belt-and-braces: remove any remaining registrations that might
        // re-claim the page between reload and fresh register.
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      } catch { /* ignore */ }
      const already = sessionStorage.getItem(SW_RELOAD_FLAG) === "1";
      if (!already) {
        sessionStorage.setItem(SW_RELOAD_FLAG, "1");
        slog.warn("sw: reloading once to pick up fresh /sw.js");
        location.reload();
        return;
      }
      // Second attempt: register again so the new worker installs without
      // a reload. Wait for controllerchange and re-probe.
      const reg2 = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => {
          const on = () => { navigator.serviceWorker.removeEventListener("controllerchange", on); resolve(); };
          navigator.serviceWorker.addEventListener("controllerchange", on);
          setTimeout(on, 3000);
        });
      }
      pong = await probeController();
      if (!pong || pong.version !== EXPECTED_SW_VERSION) {
        slog.error(`sw: still stale after reload+reinstall (got=${pong?.version}) — crypto will refuse`);
        await reg2.unregister();
      } else {
        sessionStorage.removeItem(SW_RELOAD_FLAG);
      }
    } else {
      // Healthy worker — clear the one-shot reload flag from earlier visits.
      sessionStorage.removeItem(SW_RELOAD_FLAG);
    }
  } catch (err) {
    slog.error("sw: registration failed", err);
  }
}

// Публичные страницы /terms и /privacy: без входа, ключей и Service Worker
const legalKind = legalKindFromPath(window.location.pathname);

if ("serviceWorker" in navigator && !legalKind) {
  window.addEventListener("load", () => { void registerServiceWorker(); });
}

// Применяем сохранённый vibe до первого рендера, чтобы избежать «вспышки»
// дефолтного цвета на splash/welcome.
applyVibe(getStoredVibe());

// Visual catalog — фикс-страница для pixel-diff между web/Android/iOS.
// Активируется ?visual=1 в URL; обходит весь auth/messenger flow.
// WEB-05: проверка вынесена из App (там был ранний return до хуков).
function Root() {
  // Только в dev-сборке: в production VisualCatalog вырезается tree-shaking'ом.
  const visual = import.meta.env.DEV && new URLSearchParams(window.location.search).get("visual") === "1";
  if (legalKind) return <LegalPage kind={legalKind} />;
  return visual ? <VisualCatalog /> : <App />;
}

// Сессия после перезагрузки (тайник токенов в RAM Service Worker) восстанавливается до первого
// рендера: App читает токены синхронно при монтировании. Ожидание ограничено (≤ 1,5 с).
// На публичных страницах /terms и /privacy сессия не нужна — тайник не трогаем.
void (legalKind ? Promise.resolve() : restoreSession()).catch(() => { /* вход заново */ }).then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider>
        <ToastProvider>
          <ErrorBoundary scope="root" variant="screen">
            <Root />
          </ErrorBoundary>

        </ToastProvider>

      </I18nProvider>
    </StrictMode>,
  );
});
