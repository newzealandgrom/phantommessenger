// Visual Catalog — фикс-сайз страница со всеми ключевыми UI-элементами
// в одинаковом порядке и размерах на всех 3 платформах (web/Android/iOS).
//
// Активация: открыть приложение с `?visual=1` в URL (App.tsx ловит этот флаг).
// Скриншот делается через Chrome DevTools (или Playwright headless).
// Сравнение pixel-by-pixel — `node scripts/visual-diff.mjs <web.png> <other.png>`.
//
// Любые изменения в UI-компонентах должны сопровождаться обновлением этого
// каталога — это единственный способ гарантировать визуальную консистентность.
//
// Размер canvas: 360 × 800 — стандарт мобильного портрета (iPhone SE, Pixel 4a).

import React from "react";

const T = {
  bg: "#080A0E",
  surface: "#0F1116",
  surfaceAlt: "#161922",
  border: "#252A36",
  text: "#E8EAED",
  textMuted: "#9AA3AF",
  accent: "#6EA8FE",
  accentText: "#08111F",
  success: "#34D399",
  danger: "#EF4444",
};

const cell: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: 8,
  background: T.surface,
  borderRadius: 8,
};
const label: React.CSSProperties = {
  fontFamily: "Figtree, -apple-system, sans-serif",
  fontSize: 10,
  color: T.textMuted,
  letterSpacing: 0.4,
  textTransform: "uppercase",
};

export function VisualCatalog() {
  return (
    <div
      data-visual-catalog="phantom-mobile-360x800"
      style={{
        width: 360,
        minHeight: 800,
        background: T.bg,
        color: T.text,
        fontFamily: "Figtree, -apple-system, sans-serif",
        padding: 12,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* 01 — Primary button */}
      <div style={cell}>
        <div style={label}>01 button.primary</div>
        <button style={{
          height: 44, padding: "0 16px", border: "none", borderRadius: 12,
          background: T.accent, color: T.accentText, fontSize: 16, fontWeight: 600,
          fontFamily: "inherit", cursor: "pointer",
        }}>Send Message</button>
      </div>

      {/* 02 — Secondary button */}
      <div style={cell}>
        <div style={label}>02 button.secondary</div>
        <button style={{
          height: 44, padding: "0 16px", borderRadius: 12,
          background: "transparent", color: T.accent,
          border: `1px solid ${T.border}`, fontSize: 16, fontWeight: 500,
          fontFamily: "inherit", cursor: "pointer",
        }}>Cancel</button>
      </div>

      {/* 03 — Danger button */}
      <div style={cell}>
        <div style={label}>03 button.danger</div>
        <button style={{
          height: 44, padding: "0 16px", border: "none", borderRadius: 12,
          background: T.danger, color: "#fff", fontSize: 16, fontWeight: 600,
          fontFamily: "inherit", cursor: "pointer",
        }}>Delete</button>
      </div>

      {/* 04 — Avatar with initials */}
      <div style={cell}>
        <div style={label}>04 avatar.initials</div>
        <div style={{
          width: 40, height: 40, borderRadius: 20, background: T.accent,
          color: T.accentText, fontSize: 16, fontWeight: 600,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>VM</div>
      </div>

      {/* 05 — Status: online */}
      <div style={cell}>
        <div style={label}>05 status.online</div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: T.success, display: "inline-block" }} />
          <span style={{ fontSize: 11, color: T.success }}>онлайн</span>
        </div>
      </div>

      {/* 06 — Status: offline */}
      <div style={cell}>
        <div style={label}>06 status.offline</div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: "rgba(154,163,175,0.4)", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: T.textMuted }}>оффлайн</span>
        </div>
      </div>

      {/* 07 — P2P badge */}
      <div style={cell}>
        <div style={label}>07 badge.p2p</div>
        <span style={{ fontSize: 11, color: T.success }}>· 🔗 P2P</span>
      </div>

      {/* 08 — Bubble incoming */}
      <div style={cell}>
        <div style={label}>08 bubble.incoming</div>
        <div style={{
          maxWidth: 240, padding: "8px 12px", borderRadius: 16,
          background: T.surfaceAlt, color: T.text, fontSize: 14, alignSelf: "flex-start",
        }}>Привет, как дела?</div>
      </div>

      {/* 09 — Bubble outgoing */}
      <div style={cell}>
        <div style={label}>09 bubble.outgoing</div>
        <div style={{
          maxWidth: 240, padding: "8px 12px", borderRadius: 16,
          background: T.accent, color: T.accentText, fontSize: 14, alignSelf: "flex-end",
          marginLeft: "auto",
        }}>Привет! Всё отлично</div>
      </div>

      {/* 10 — Input empty */}
      <div style={cell}>
        <div style={label}>10 input.empty</div>
        <input
          placeholder="Введите номер"
          style={{
            height: 44, padding: "0 12px", borderRadius: 12,
            background: T.surfaceAlt, color: T.text,
            border: `1px solid ${T.border}`, fontSize: 14, fontFamily: "inherit",
            outline: "none",
          }}
        />
      </div>

      {/* 11 — Input filled */}
      <div style={cell}>
        <div style={label}>11 input.filled</div>
        <input
          defaultValue="111-22-333-44"
          style={{
            height: 44, padding: "0 12px", borderRadius: 12,
            background: T.surfaceAlt, color: T.text,
            border: `1px solid ${T.accent}`, fontSize: 14, fontFamily: "inherit",
            outline: "none",
          }}
        />
      </div>

      {/* 12 — Banner: relay offline */}
      <div style={cell}>
        <div style={label}>12 banner.offline</div>
        <div style={{
          padding: 8, borderRadius: 8, background: "rgba(239,68,68,0.12)",
          color: T.danger, fontSize: 12, textAlign: "center",
        }}>Нет соединения. Сообщения будут отправлены позже.</div>
      </div>

      {/* 13 — Banner: P2P fallback active */}
      <div style={cell}>
        <div style={label}>13 banner.p2p</div>
        <div style={{
          padding: 8, borderRadius: 8, background: "rgba(52,211,153,0.15)",
          color: T.success, fontSize: 12, textAlign: "center",
        }}>🔗 Сервер недоступен. Сообщения идут напрямую.</div>
      </div>

      {/* 14 — Chat header (online + P2P) */}
      <div style={cell}>
        <div style={label}>14 header.chat</div>
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: 10, background: T.bg, borderRadius: 12,
          border: `1px solid ${T.border}`,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 18, background: T.accent,
            color: T.accentText, fontSize: 14, fontWeight: 600,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>NK</div>
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Никита</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: 3, background: T.success, display: "inline-block" }} />
              <span style={{ fontSize: 11, color: T.success }}>онлайн</span>
              <span style={{ fontSize: 11, color: T.success }}>· 🔗 P2P</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default VisualCatalog;
