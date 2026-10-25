import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft, ChevronRight, MoreHorizontal, SquarePen,
  MessageSquare, Users, Settings as SettingsIcon, LogOut, X, ArrowRight,
  Shield, Server, Smartphone, EyeOff, Palette, Bell, Languages, Info,
  Lock, KeyRound, AlertTriangle, Timer, Camera, Eye, Trash2, Power,
  QrCode, Crown, Check, Plus,
} from "lucide-react";
import { BRAND } from "../lib/brand";
import type { RelayOutbound, Theme } from "../types";
import { formatNumber, normalizeNumber, formatInput } from "../lib/phone";
import { avatarColor, accountKey, getInitials, setNotifyShowPreview } from "../lib/utils";
import { avatarBackgroundCss, safeAvatar } from "../lib/avatar";
import { useT, type Locale } from "../lib/i18n";
import QrImage from "./QrImage";
import { usePhantomToast } from "./Toast";
import { readAppLock, readPanic, writeAppLock, writePanic, writeFailState, setLockPin, setPanicPin } from "../lib/applock";

type MenuPanelType = null | "profile" | "contacts" | "settings" | "newchat";
type SettingsSub = null | "security" | "server" | "devices" | "privacy" | "appearance" | "notifications" | "language" | "about" | "applock" | "panic";

const SELF_DESTRUCT_OPTIONS = [
  { key: "sd.5s", value: 5 },
  { key: "sd.30s", value: 30 },
  { key: "sd.1m", value: 60 },
  { key: "sd.5m", value: 300 },
  { key: "sd.off", value: 0 },
];

const VIBE_LIST = [
  { id: "noir",   label: "🌙 noir" },
  { id: "dream",  label: "🌸 dream" },
  { id: "retro",  label: "⚡ retro" },
  { id: "disco",  label: "🪩 disco" },
  { id: "wave",   label: "🌊 wave" },
];

export interface MenuPanelProps {
  menuPanel: MenuPanelType;
  setMenuPanel: (v: MenuPanelType) => void;
  selfNumber: string;
  connState: string;
  contacts: Record<string, string>;
  avatars: Record<string, string>;
  themePreference: Theme;
  setThemePreference: (v: Theme) => void;
  resolvedTheme: "dark" | "light";
  selfDestructSec: number;
  setSelfDestructSec: (v: number) => void;
  editContactName: string;
  setEditContactName: (v: string) => void;
  editContactNumber: string;
  setEditContactNumber: (v: string) => void;
  saveContact: (number: string, name: string) => void;
  removeContact: (number: string) => void;
  newChatNumber: string;
  setNewChatNumber: (v: string) => void;
  startNewChat: () => void;
  openChat: (peer: string) => void;
  handleAvatarUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  avatarInputRef: RefObject<HTMLInputElement | null>;
  showQr: boolean;
  setShowQr: (v: boolean) => void;
  showQrLinkInput: boolean;
  setShowQrLinkInput: (v: boolean) => void;
  qrLinkInput: string;
  setQrLinkInput: (v: string) => void;
  setRelayError: (v: string) => void;
  activeSessions: Array<{ deviceId: string; platform: string; lastActive: number; current: boolean }>;
  sendRelay: (payload: RelayOutbound) => boolean;
  hardLogout: () => void;
  // Мультиаккаунт: номера аккаунтов вкладки (до 3), активный — selfNumber
  accounts: string[];
  canAddAccount: boolean;
  accountsBusy: boolean;
  switchAccount: (number: string) => void;
  addAccount: () => void;
  logoutAccount: (number: string) => void;
  // X-06/Q14: «Удалить аккаунт» — полный wipe устройства (как panic)
  deleteAccount: () => void;
  privacySettings: PrivacyFlags;
  updatePrivacy: (update: Partial<PrivacyFlags>) => void;
  showLogoutConfirm: boolean;
  setShowLogoutConfirm: (v: boolean) => void;
  clearAllChats: () => void;
}

// S10.5/Q9: privateCalls — «Скрывать IP в звонках»; p2pFallback — «Прямое соединение (P2P)» (P2P v2 §2, дефолт вкл.)
type PrivacyFlags = {
  hideOnline: boolean; disableReadReceipts: boolean; disableTyping: boolean; burnAfterRead: boolean;
  privateCalls: boolean; p2pFallback: boolean;
};

// L-a: аккаунт всё ещё вошёл в этой вкладке (logout/wipe снимают phantom_number)
function isAccountActive(number: string): boolean {
  try { return !!number && sessionStorage.getItem("phantom_number") === number; } catch { return false; }
}

// Настройки блокировки изменились — App перечитывает их без перелогина
function notifyAppLockChanged() {
  try { window.dispatchEvent(new Event("phantom-applock-changed")); } catch { /* ignore */ }
}

/* ===== Локальные настройки в localStorage (per-account, не уезжают на сервер) ===== */
function useAccountFlag(accountNum: string, key: string, defaultValue: boolean): [boolean, (v: boolean) => void] {
  const storageKey = accountNum ? accountKey(accountNum, key) : `phantom_${key}`;
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return defaultValue;
      return raw === "1";
    } catch { return defaultValue; }
  });
  const update = (v: boolean) => {
    setValue(v);
    try { localStorage.setItem(storageKey, v ? "1" : "0"); } catch { /* ignore */ }
  };
  return [value, update];
}

function useAccountString(accountNum: string, key: string, defaultValue: string): [string, (v: string) => void] {
  const storageKey = accountNum ? accountKey(accountNum, key) : `phantom_${key}`;
  const [value, setValue] = useState<string>(() => {
    try { return localStorage.getItem(storageKey) || defaultValue; }
    catch { return defaultValue; }
  });
  const update = (v: string) => {
    setValue(v);
    try { localStorage.setItem(storageKey, v); } catch { /* ignore */ }
  };
  return [value, update];
}

/* Notifications API helper */
function useNotificationPermission(): { permission: NotificationPermission; request: () => Promise<NotificationPermission> } {
  const [permission, setPermission] = useState<NotificationPermission>(
    () => (typeof Notification !== "undefined" ? Notification.permission : "denied")
  );
  const request = async (): Promise<NotificationPermission> => {
    if (typeof Notification === "undefined") return "denied";
    if (Notification.permission === "granted") { setPermission("granted"); return "granted"; }
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result;
    } catch { return "denied"; }
  };
  return { permission, request };
}

/* ===== AppLock ===== */
// S10.7: PIN хранится только как PBKDF2-верификатор (lib/applock.ts), открытого значения нет
function AppLockSettings({ selfNumber, t }: { selfNumber: string; t: (k: string, p?: Record<string, string | number>) => string }) {
  const [settings, setSettings] = useState(() => readAppLock(localStorage, selfNumber));
  const [newPin, setNewPin] = useState("");
  const [pinLength, setPinLength] = useState<6 | 12 | 24>((settings.pinLength as 6 | 12 | 24) || 6);
  const [timeoutVal, setTimeoutVal] = useState(settings.inactivityTimeout || 300);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleEnable = async () => {
    if (newPin.length < pinLength || !/^\d+$/.test(newPin) || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await setLockPin(localStorage, selfNumber, newPin, { pinLength, inactivityTimeout: timeoutVal, isActive: () => isAccountActive(selfNumber) });
      if (res === "inactive") return;
      if (res === "same_as_panic") { setError("PIN не должен совпадать с Panic-PIN"); return; }
      setSettings(readAppLock(localStorage, selfNumber));
      setNewPin("");
      notifyAppLockChanged();
    } finally { setBusy(false); }
  };

  const handleDisable = () => {
    writeAppLock(localStorage, selfNumber, { enabled: false, pinLength: 6, inactivityTimeout: 300 });
    writeFailState(localStorage, selfNumber, { failCount: 0, lockedUntil: 0 });
    setSettings(readAppLock(localStorage, selfNumber));
    notifyAppLockChanged();
  };

  if (settings.enabled) {
    return (
      <div className="pm-applock-block">
        <div className="pm-row">
          <div className="pm-row-icon" style={{ background: "rgba(167,139,250,0.18)" }}>
            <Lock size={16} color="#fff" />
          </div>
          <div className="pm-row-info">
            <div className="pm-row-title">{t("set.sec.appLock.statusOn", { n: settings.pinLength })}</div>
            <div className="pm-row-sub">{t("set.sec.appLock.timeout", { n: Math.round(timeoutVal / 60) })}</div>
          </div>
        </div>
        <button className="pm-btn pm-btn-ghost" style={{ width: "100%", marginTop: 8 }} onClick={handleDisable}>
          {t("set.sec.appLock.disable")}
        </button>
      </div>
    );
  }

  return (
    <div className="pm-applock-block" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {t("set.sec.pinLength")}
        <select
          value={pinLength}
          onChange={e => setPinLength(Number(e.target.value) as 6|12|24)}
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", padding: "6px 10px", borderRadius: 8, fontFamily: "inherit" }}
        >
          <option value={6}>{t("set.sec.pin6")}</option>
          <option value={12}>{t("set.sec.pin12")}</option>
          <option value={24}>{t("set.sec.pin24")}</option>
        </select>
      </label>
      <label style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {t("set.sec.lockAfter")}
        <select
          value={timeoutVal}
          onChange={e => setTimeoutVal(Number(e.target.value))}
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", padding: "6px 10px", borderRadius: 8, fontFamily: "inherit" }}
        >
          <option value={60}>{t("set.sec.t1m")}</option>
          <option value={300}>{t("set.sec.t5m")}</option>
          <option value={600}>{t("set.sec.t10m")}</option>
          <option value={1800}>{t("set.sec.t30m")}</option>
          <option value={3600}>{t("set.sec.t1h")}</option>
        </select>
      </label>
      <input
        type="password"
        inputMode="numeric"
        value={newPin}
        onChange={e => setNewPin(e.target.value.replace(/\D/g, ""))}
        maxLength={pinLength}
        placeholder={t("set.sec.pinPlaceholder", { n: pinLength })}
        style={{ padding: "10px 14px", borderRadius: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)", color: "#fff", fontSize: 14, fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.2em", textAlign: "center" }}
      />
      {error && <p role="alert" style={{ fontSize: 11.5, color: "#fda4af", margin: 0 }}>{error}</p>}
      <button
        className="pm-btn pm-btn-primary"
        onClick={() => { void handleEnable(); }}
        disabled={newPin.length < pinLength || busy}
        style={{ width: "100%" }}
      >
        {t("set.sec.enableLock")}
      </button>
    </div>
  );
}

/* ===== Panic ===== */
// S10.7: panic-PIN — только PBKDF2-верификатор; не может совпадать с PIN блокировки
function PanicModeSettings({ selfNumber, t }: { selfNumber: string; t: (k: string, p?: Record<string, string | number>) => string }) {
  const [settings, setSettings] = useState(() => readPanic(localStorage, selfNumber));
  const [panicPin, setPanicPinInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const activate = async () => {
    if (panicPin.length < 4 || !/^\d+$/.test(panicPin) || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await setPanicPin(localStorage, selfNumber, panicPin, () => isAccountActive(selfNumber));
      if (res === "inactive") return;
      if (res === "same_as_pin") { setError("Panic-PIN не должен совпадать с PIN блокировки"); return; }
      setSettings(readPanic(localStorage, selfNumber));
      setPanicPinInput("");
    } finally { setBusy(false); }
  };
  const disable = () => {
    writePanic(localStorage, selfNumber, { enabled: false });
    setSettings(readPanic(localStorage, selfNumber));
  };

  if (settings.enabled) {
    return (
      <div>
        <div className="pm-row danger">
          <div className="pm-row-icon"><AlertTriangle size={16} color="#fda4af" /></div>
          <div className="pm-row-info">
            <div className="pm-row-title">{t("set.sec.panic.active")}</div>
            <div className="pm-row-sub">{t("set.sec.panic.activeSub")}</div>
          </div>
        </div>
        <button className="pm-btn pm-btn-ghost" style={{ width: "100%", marginTop: 8 }} onClick={disable}>
          {t("common.disable")}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", margin: 0 }}>{t("set.sec.panic.desc")}</p>
      <input
        type="password"
        inputMode="numeric"
        value={panicPin}
        onChange={e => setPanicPinInput(e.target.value.replace(/\D/g, ""))}
        maxLength={24}
        placeholder={t("set.sec.panic.placeholder")}
        style={{ padding: "10px 14px", borderRadius: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)", color: "#fff", fontSize: 14, fontFamily: "JetBrains Mono, monospace" }}
      />
      {error && <p role="alert" style={{ fontSize: 11.5, color: "#fda4af", margin: 0 }}>{error}</p>}
      <button
        className="pm-btn pm-btn-primary"
        onClick={() => { void activate(); }}
        disabled={panicPin.length < 4 || busy}
        style={{ width: "100%" }}
      >
        {t("set.sec.panic.activate")}
      </button>
    </div>
  );
}

/* ===== Y2K Profile Card ===== */
function Y2KProfileCard({
  selfNumber, avatarUrl, onClickAvatar, onClickQr, t,
}: {
  selfNumber: string; avatarUrl?: string;
  onClickAvatar: () => void; onClickQr: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const sparks = Array.from({ length: 6 }, (_, i) => ({
    top: `${10 + i * 13}%`,
    left: `${10 + (i * 17) % 80}%`,
    delay: `${i * 0.3}s`,
  }));
  const last2 = selfNumber ? selfNumber.slice(-2) : "PH";
  const avatarStyle = safeAvatar(avatarUrl)
    ? { backgroundImage: avatarBackgroundCss(avatarUrl!), backgroundSize: "cover", backgroundPosition: "center" } as React.CSSProperties
    : { background: avatarColor(selfNumber) } as React.CSSProperties;

  return (
    <div className="pm-y2k-card">
      {sparks.map((s, i) => (
        <span key={i} className="pm-y2k-spark" style={{ top: s.top, left: s.left, animationDelay: s.delay }}>✦</span>
      ))}
      <div className="pm-y2k-head">
        <div className="pm-y2k-stamp">{t("profile.stamp")}</div>
        <button type="button" className="pm-y2k-qr-btn" onClick={onClickQr} aria-label="QR">
          <QrCode size={14} strokeWidth={2} />
        </button>
      </div>
      <div className="pm-y2k-id">
        <div
          className={`pm-y2k-avatar ${safeAvatar(avatarUrl) ? "is-image" : ""}`}
          style={safeAvatar(avatarUrl) ? avatarStyle : undefined}
          onClick={onClickAvatar}
          role="button"
          aria-label="Сменить аватар"
          title="Нажмите чтобы загрузить аватар"
        >
          {!safeAvatar(avatarUrl) && (last2 || "👻")}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="pm-y2k-name">phantom_{last2}</h3>
          <div className="pm-y2k-num">{formatNumber(selfNumber || "0000000000")}</div>
        </div>
      </div>
    </div>
  );
}

/* ===== Row helpers ===== */
function PMRow({
  Icon, title, sub, color, onClick, right, danger,
}: {
  Icon: any; title: string; sub?: string; color?: string;
  onClick?: () => void; right?: React.ReactNode; danger?: boolean;
}) {
  return (
    <div className={`pm-row ${danger ? "danger" : ""}`} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}>
      <div className="pm-row-icon" style={color ? { background: color } : undefined}>
        <Icon size={16} color={danger ? "#fda4af" : "#fff"} strokeWidth={2} />
      </div>
      <div className="pm-row-info">
        <div className="pm-row-title">{title}</div>
        {sub && <div className="pm-row-sub">{sub}</div>}
      </div>
      {right ?? (onClick ? <ChevronRight size={14} color="rgba(255,255,255,0.35)" /> : null)}
    </div>
  );
}

function PMToggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      className={`pm-toggle ${on ? "on" : ""}`}
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      aria-pressed={on}
    >
      <span className="pm-toggle-knob" />
    </button>
  );
}

/* ===== MAIN ===== */
export default function MenuPanel(props: MenuPanelProps) {
  const {
    menuPanel, setMenuPanel, selfNumber, connState, contacts, avatars,
    themePreference, setThemePreference, resolvedTheme,
    selfDestructSec, setSelfDestructSec,
    editContactName, setEditContactName, editContactNumber, setEditContactNumber,
    saveContact, removeContact,
    newChatNumber, setNewChatNumber, startNewChat, openChat,
    handleAvatarUpload, avatarInputRef,
    showQr, setShowQr, showQrLinkInput, setShowQrLinkInput,
    qrLinkInput, setQrLinkInput, setRelayError,
    activeSessions, sendRelay, hardLogout, deleteAccount,
    accounts, canAddAccount, accountsBusy, switchAccount, addAccount, logoutAccount,
    privacySettings, updatePrivacy,
    showLogoutConfirm, setShowLogoutConfirm,
    clearAllChats,
  } = props;
  const { t, locale, setLocale } = useT();

  const [vibe, setVibe] = useAccountString(selfNumber, "vibe", "noir");

  // Применяем выбранный vibe к корню документа — меняет основной градиент
  // (--pm-grad). Эффект мгновенный: кнопки, аватары, исходящие bubbles.
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-vibe", vibe || "noir");
    }
  }, [vibe]);
  // WEB-11: «Скрыть превью» реально управляет текстом в уведомлениях (по умолчанию скрыт).
  const [hidePreview, setHidePreview] = useAccountFlag(selfNumber, "hide_preview", true);
  const [notifyScreenshots, setNotifyScreenshots] = useAccountFlag(selfNumber, "notify_screenshots", true); // как phantom_screenshot_alerts на Android (вкл. по умолчанию)
  const [pushEnabled, setPushEnabled] = useAccountFlag(selfNumber, "push_enabled", true);
  const { permission: notifPermission, request: requestNotif } = useNotificationPermission();

  const [settingsSub, setSettingsSub] = useState<SettingsSub>(null);
  // Меню «…» в шапке профиля (раньше кнопка была без обработчика)
  const [showProfileMore, setShowProfileMore] = useState(false);
  const phantomToast = usePhantomToast();
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      phantomToast(t("profile.more.copied"), "success");
    } catch {
      phantomToast(t("profile.more.copyFailed"), "error");
    }
  };
  const [showClearChatsConfirm, setShowClearChatsConfirm] = useState(false);
  // Мультиаккаунт: номер неактивного аккаунта, для которого открыто подтверждение «Выйти»
  const [accountToRemove, setAccountToRemove] = useState("");
  // notify_screenshots читает обработчик PrintScreen в App.tsx.
  void notifyScreenshots;
  useEffect(() => { setNotifyShowPreview(!hidePreview); }, [hidePreview]);

  const togglePush = async () => {
    if (!pushEnabled) {
      const result = await requestNotif();
      if (result === "granted") setPushEnabled(true);
    } else {
      setPushEnabled(false);
    }
  };

  if (!menuPanel) return null;

  const close = () => { setMenuPanel(null); setSettingsSub(null); };

  const onClickAvatar = () => avatarInputRef.current?.click();

  // QR генерируется внутри <QrImage> при монтировании — без setTimeout и без canvas
  // (см. комментарий в QrImage.tsx: белый квадрат в Firefox / при повторном открытии).
  const onClickQr = () => setShowQr(!showQr);

  /* === PROFILE === */
  if (menuPanel === "profile") {
    return (
      <div className="tg-menu-panel">
        <div className="tg-menu-panel-inner">
          <div className="tg-menu-header">
            <button className="tg-menu-back" onClick={close} aria-label={t("common.close")}>
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700, marginBottom: 2 }}>{t("profile.idCard")}</div>
              <h2 className="tg-menu-title">{t("profile.title")}</h2>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="tg-menu-back" onClick={() => setMenuPanel("contacts")} aria-label={t("profile.row.security")}><Users size={14} strokeWidth={2} /></button>
              <button className="tg-menu-back" onClick={() => setMenuPanel("settings")} aria-label={t("settings.title")}><SettingsIcon size={14} strokeWidth={2} /></button>
              <button
                className="tg-menu-back"
                aria-label={t("chat.tooltip.more")}
                aria-expanded={showProfileMore}
                onClick={() => setShowProfileMore(v => !v)}
              ><MoreHorizontal size={14} strokeWidth={2} /></button>
            </div>
          </div>

          {showProfileMore && (
            <div className="pm-profile-more" role="menu">
              <button type="button" role="menuitem" className="pm-row" onClick={() => { setShowProfileMore(false); void copyToClipboard(formatNumber(selfNumber)); }}>
                {t("profile.more.copyNumber")}
              </button>
              <button type="button" role="menuitem" className="pm-row" onClick={() => { setShowProfileMore(false); void copyToClipboard(`phantom://${selfNumber}`); }}>
                {t("profile.more.copyLink")}
              </button>
              <button type="button" role="menuitem" className="pm-row" onClick={() => { setShowProfileMore(false); setMenuPanel("settings"); setSettingsSub("security"); setShowClearChatsConfirm(true); }}>
                {t("set.sec.clearChats")}
              </button>
              <button type="button" role="menuitem" className="pm-row pm-row-danger" onClick={() => { setShowProfileMore(false); setShowLogoutConfirm(true); }}>
                {t("profile.row.logout")}
              </button>
            </div>
          )}

          <input
            ref={avatarInputRef as RefObject<HTMLInputElement>}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleAvatarUpload}
          />

          <Y2KProfileCard
            selfNumber={selfNumber}
            avatarUrl={avatars[selfNumber]}
            onClickAvatar={onClickAvatar}
            onClickQr={onClickQr}
            t={t}
          />

          {showQr && (
            <div style={{ display: "flex", justifyContent: "center", padding: "16px 0 8px 0" }}>
              <div style={{ background: "#fff", padding: 14, borderRadius: 16 }}>
                <QrImage text={`phantom://${selfNumber}`} size={200} label={`phantom://${selfNumber}`} />
                <div style={{ textAlign: "center", color: "#0a0a0a", fontSize: 11, fontFamily: "JetBrains Mono, monospace", marginTop: 8 }}>
                  {`phantom://${selfNumber}`}
                </div>
              </div>
            </div>
          )}

          {showQrLinkInput && (
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input
                style={{ flex: 1, padding: "10px 14px", borderRadius: 999, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", fontSize: 13 }}
                placeholder="phantom://1110000000"
                value={qrLinkInput}
                onChange={e => setQrLinkInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    const m = qrLinkInput.match(/^phantom:\/\/(\d{10})$/);
                    if (m) { setQrLinkInput(""); setShowQrLinkInput(false); close(); openChat(m[1]); }
                    else setRelayError("Неверный формат ссылки. Используйте phantom://XXXXXXXXXX");
                  }
                }}
              />
              <button className="pm-btn pm-btn-primary" style={{ padding: "10px 16px" }}
                onClick={() => {
                  const m = qrLinkInput.match(/^phantom:\/\/(\d{10})$/);
                  if (m) { setQrLinkInput(""); setShowQrLinkInput(false); close(); openChat(m[1]); }
                  else setRelayError("Неверный формат ссылки. Используйте phantom://XXXXXXXXXX");
                }}
              >Открыть</button>
            </div>
          )}

          {/* Аккаунты: до 3 номеров в одной вкладке, переключение одним кликом */}
          <div className="tg-menu-section" data-testid="accounts-section">
            <h4 className="pm-section-title">{t("accounts.title")}</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {accounts.map(n => {
                const isActive = n === selfNumber;
                return (
                  <div
                    key={n}
                    className="pm-row"
                    data-testid={`account-row-${n}`}
                    data-active={isActive ? "1" : "0"}
                    role="button"
                    tabIndex={0}
                    aria-current={isActive || undefined}
                    aria-disabled={!isActive && accountsBusy ? true : undefined}
                    aria-label={isActive ? formatNumber(n) : t("accounts.switchTo", { number: formatNumber(n) })}
                    onClick={() => { if (!isActive) switchAccount(n); }}
                    onKeyDown={e => { if (!isActive && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); switchAccount(n); } }}
                  >
                    <div className="pm-row-icon" style={{ background: avatarColor(n), fontSize: 11, fontWeight: 700, color: "#fff" }}>
                      {n.slice(-2)}
                    </div>
                    <div className="pm-row-info">
                      <div className="pm-row-title">{formatNumber(n)}</div>
                      <div className="pm-row-sub">
                        {isActive && connState !== "online" ? t("accounts.connecting") : n}
                      </div>
                    </div>
                    {isActive ? (
                      connState === "online" ? <Check size={16} color="#34d399" strokeWidth={2.4} aria-label={t("accounts.active")} /> : null
                    ) : (
                      <button
                        type="button"
                        className="pm-vibe-chip"
                        data-testid={`account-logout-${n}`}
                        onClick={e => { e.stopPropagation(); setAccountToRemove(n); }}
                      >{t("accounts.logout")}</button>
                    )}
                  </div>
                );
              })}
              {canAddAccount ? (
                <PMRow Icon={Plus} title={t("accounts.add")} color="rgba(167,139,250,0.18)" onClick={addAccount} />
              ) : (
                <div className="pm-row-sub" data-testid="accounts-limit" style={{ padding: "4px 2px" }}>{t("accounts.limit")}</div>
              )}
            </div>
            <div className="pm-row-sub" style={{ padding: "8px 2px 0" }}>{t("accounts.hint")}</div>
          </div>

          {/* Vibe selector */}
          <div className="tg-menu-section">
            <h4 className="pm-section-title">{t("profile.section.vibe")}</h4>
            <div className="pm-vibe-row">
              {VIBE_LIST.map(v => (
                <button
                  key={v.id}
                  type="button"
                  className={`pm-vibe-chip ${vibe === v.id ? "active" : ""}`}
                  onClick={() => setVibe(v.id)}
                >{v.label}</button>
              ))}
            </div>
          </div>

          {/* Quick actions */}
          <div className="tg-menu-section">
            <div className="pm-vibe-row" style={{ marginBottom: 4 }}>
              <button type="button" className="pm-vibe-chip" onClick={() => setShowQrLinkInput(!showQrLinkInput)}>
                {t("profile.qrLink")}
              </button>
              <button type="button" className="pm-vibe-chip" onClick={() => setMenuPanel("newchat")}>
                <MessageSquare size={12} strokeWidth={2} style={{ marginRight: 6, verticalAlign: -1 }} />
                {t("profile.newChat")}
              </button>
            </div>
          </div>

          {/* Settings list */}
          <div className="tg-menu-section">
            <h4 className="pm-section-title">{t("profile.section.settings")}</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <PMRow Icon={Shield}      title={t("profile.row.security")}   sub={t("profile.row.security.sub")}
                color="rgba(167,139,250,0.18)" onClick={() => { setMenuPanel("settings"); setSettingsSub("security"); }} />
              <PMRow Icon={Server}      title={t("profile.row.server")}      sub={typeof window !== "undefined" ? window.location.host : "phantommessenger.org"}
                color="rgba(34,211,238,0.18)" onClick={() => { setMenuPanel("settings"); setSettingsSub("server"); }} />
              <PMRow Icon={Smartphone}  title={t("profile.row.devices")}     sub={t("profile.row.devices.sub", { n: activeSessions.length || 1 })}
                color="rgba(52,211,153,0.18)" onClick={() => { setMenuPanel("settings"); setSettingsSub("devices"); sendRelay({ type: "get_sessions" } as RelayOutbound); }} />
              <PMRow Icon={EyeOff}      title={t("profile.row.privacy")}     sub={t("profile.row.privacy.sub")}
                color="rgba(251,191,36,0.18)" onClick={() => { setMenuPanel("settings"); setSettingsSub("privacy"); }} />
              <PMRow Icon={Palette}     title={t("profile.row.appearance")}  sub={`${resolvedTheme === "dark" ? t("set.app.themeDark").replace(/^\S+\s/, "") : t("set.app.themeLight").replace(/^\S+\s/, "")} · Violet`}
                color="rgba(244,114,182,0.18)" onClick={() => { setMenuPanel("settings"); setSettingsSub("appearance"); }} />
              <PMRow Icon={Bell}        title={t("profile.row.notifications")} sub={t("profile.row.notifications.sub")}
                color="rgba(34,211,238,0.18)" onClick={() => { setMenuPanel("settings"); setSettingsSub("notifications"); }} />
              <PMRow Icon={Languages}   title={t("profile.row.language")}    sub={locale === "ru" ? "Русский" : "English"}
                color="rgba(167,139,250,0.18)" onClick={() => { setMenuPanel("settings"); setSettingsSub("language"); }} />
              <PMRow Icon={Info}        title={t("profile.row.about")}       sub={`v1.0.0 · ${BRAND.copy.securityAlgorithm || "ECDH P-256"}`}
                color="rgba(255,255,255,0.06)" onClick={() => { setMenuPanel("settings"); setSettingsSub("about"); }} />

              <PMRow Icon={LogOut} title={t("profile.row.logout")} danger
                color="rgba(251,113,133,0.20)"
                onClick={() => setShowLogoutConfirm(true)} />
            </div>
          </div>

        </div>

        {showLogoutConfirm && (
          createPortal(<div className="tg-modal-overlay" onClick={() => setShowLogoutConfirm(false)}>
            <div className="tg-modal" onClick={e => e.stopPropagation()}>
              <div className="tg-modal-header"><h3>{t("set.logout.confirmTitle")}</h3></div>
              <div style={{ padding: "12px 24px" }}>
                <p style={{ color: "rgba(255,255,255,0.65)", fontSize: 13 }}>{t("set.logout.confirmBody")}</p>
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "8px 24px 22px" }}>
                <button onClick={() => setShowLogoutConfirm(false)} className="tg-btn-secondary">{t("common.cancel")}</button>
                <button onClick={() => { setShowLogoutConfirm(false); hardLogout(); }} className="tg-modal-btn primary" style={{ background: "linear-gradient(135deg,#fb7185,#f43f5e)" }}>{t("profile.row.logout")}</button>
              </div>
            </div>
          </div>, document.body)
        )}

        {accountToRemove && (
          createPortal(<div className="tg-modal-overlay" onClick={() => setAccountToRemove("")}>
            <div className="tg-modal" data-testid="account-remove-confirm" onClick={e => e.stopPropagation()}>
              <div className="tg-modal-header"><h3>{t("accounts.removeTitle")}</h3></div>
              <div style={{ padding: "12px 24px" }}>
                <p style={{ color: "rgba(255,255,255,0.65)", fontSize: 13 }}>{t("accounts.removeBody", { number: formatNumber(accountToRemove) })}</p>
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "8px 24px 22px" }}>
                <button onClick={() => setAccountToRemove("")} className="tg-btn-secondary">{t("common.cancel")}</button>
                <button
                  data-testid="account-remove-confirm-ok"
                  onClick={() => { const n = accountToRemove; setAccountToRemove(""); logoutAccount(n); }}
                  className="tg-modal-btn primary"
                  style={{ background: "linear-gradient(135deg,#fb7185,#f43f5e)" }}
                >{t("accounts.logout")}</button>
              </div>
            </div>
          </div>, document.body)
        )}
      </div>
    );
  }

  /* === CONTACTS === */
  if (menuPanel === "contacts") {
    return (
      <div className="tg-menu-panel">
        <div className="tg-menu-panel-inner">
          <div className="tg-menu-header">
            <button className="tg-menu-back" onClick={() => setMenuPanel("profile")} aria-label={t("common.back")}>
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
            <div>
              <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700 }}>Profile · Contacts</div>
              <h2 className="tg-menu-title">{t("contacts.title", { n: Object.keys(contacts).length })}</h2>
            </div>
          </div>

          {Object.keys(contacts).length === 0 && (
            <div className="pm-row" style={{ display: "block", textAlign: "center", padding: "24px 16px" }}>
              <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, margin: 0 }}>
                {t("contacts.empty")}
              </p>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {Object.entries(contacts).map(([num, name]) => (
              <div key={num} className="pm-row" style={{ cursor: "pointer" }}>
                <div
                  className="pm-row-icon"
                  style={{ background: avatarColor(num), color: "#fff", fontWeight: 700 }}
                  onClick={() => { close(); openChat(num); }}
                >
                  {getInitials(name)}
                </div>
                <div className="pm-row-info" onClick={() => { close(); openChat(num); }}>
                  <div className="pm-row-title">{name}</div>
                  <div className="pm-row-sub">{formatNumber(num)}</div>
                </div>
                <button
                  className="pm-icon-btn pm-icon-btn-sm"
                  onClick={(e) => { e.stopPropagation(); removeContact(num); }}
                  title={t("common.delete")}
                  aria-label={t("common.delete")}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>

          <div className="tg-menu-section" style={{ marginTop: 22 }}>
            <h4 className="pm-section-title">{t("contacts.add")}</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                style={{ padding: "12px 16px", borderRadius: 999, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)", color: "#fff", fontSize: 13, fontFamily: "JetBrains Mono, monospace" }}
                placeholder="111-00-000-00"
                value={editContactNumber}
                onChange={e => setEditContactNumber(formatInput(e.target.value))}
              />
              <input
                style={{ padding: "12px 16px", borderRadius: 999, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)", color: "#fff", fontSize: 13 }}
                placeholder={t("contacts.namePlaceholder")}
                value={editContactName}
                onChange={e => setEditContactName(e.target.value)}
              />
              <button
                className="pm-btn pm-btn-primary"
                style={{ width: "100%" }}
                onClick={() => {
                  const num = normalizeNumber(editContactNumber);
                  if (num && editContactName.trim()) {
                    saveContact(num, editContactName.trim());
                    setEditContactNumber("");
                    setEditContactName("");
                  }
                }}
                disabled={!normalizeNumber(editContactNumber) || !editContactName.trim()}
              >{t("common.save")}</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* === NEW CHAT === */
  if (menuPanel === "newchat") {
    return (
      <div className="tg-menu-panel">
        <div className="tg-menu-panel-inner">
          <div className="tg-menu-header">
            <button className="tg-menu-back" onClick={close} aria-label={t("common.close")}>
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
            <div>
              <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700 }}>{t("newchat.crumb")}</div>
              <h2 className="tg-menu-title">{t("newchat.title")}</h2>
            </div>
          </div>

          <div className="tg-menu-section">
            <h4 className="pm-section-title">{t("newchat.section")}</h4>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", margin: "0 0 12px 4px" }}>
              {t("newchat.hint")}
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                style={{ flex: 1, padding: "12px 16px", borderRadius: 999, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)", color: "#fff", fontSize: 14, fontFamily: "JetBrains Mono, monospace" }}
                placeholder="111-00-000-00"
                value={newChatNumber}
                onChange={e => setNewChatNumber(formatInput(e.target.value))}
                autoComplete="off"
              />
              <button
                className="pm-btn pm-btn-primary"
                onClick={startNewChat}
                disabled={!normalizeNumber(newChatNumber)}
              >
                <ArrowRight size={16} strokeWidth={2.4} />
              </button>
            </div>
          </div>

          {Object.keys(contacts).length > 0 && (
            <div className="tg-menu-section">
              <h4 className="pm-section-title">{t("newchat.fromContacts")}</h4>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {Object.entries(contacts).map(([num, name]) => (
                  <div key={num} className="pm-row" onClick={() => { close(); openChat(num); }}>
                    <div
                      className="pm-row-icon"
                      style={{ background: avatarColor(num), color: "#fff", fontWeight: 700 }}
                    >
                      {getInitials(name)}
                    </div>
                    <div className="pm-row-info">
                      <div className="pm-row-title">{name}</div>
                      <div className="pm-row-sub">{formatNumber(num)}</div>
                    </div>
                    <ChevronRight size={14} color="rgba(255,255,255,0.35)" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* === SETTINGS === */
  if (menuPanel === "settings") {
    const goRoot = () => setSettingsSub(null);

    if (settingsSub === null) {
      return (
        <div className="tg-menu-panel">
          <div className="tg-menu-panel-inner">
            <div className="tg-menu-header">
              <button className="tg-menu-back" onClick={() => setMenuPanel("profile")} aria-label={t("common.back")}>
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700 }}>{t("settings.crumb")}</div>
                <h2 className="tg-menu-title">{t("settings.title")}</h2>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <PMRow Icon={Shield}     title={t("profile.row.security")}    sub={t("profile.row.security.sub")}   color="rgba(167,139,250,0.18)" onClick={() => setSettingsSub("security")} />
              <PMRow Icon={Server}     title={t("profile.row.server")}      sub={typeof window !== "undefined" ? window.location.host : "phantommessenger.org"}      color="rgba(34,211,238,0.18)" onClick={() => setSettingsSub("server")} />
              <PMRow Icon={Smartphone} title={t("profile.row.devices")}     sub={t("profile.row.devices.sub", { n: activeSessions.length || 1 })}              color="rgba(52,211,153,0.18)" onClick={() => { setSettingsSub("devices"); sendRelay({ type: "get_sessions" } as RelayOutbound); }} />
              <PMRow Icon={EyeOff}     title={t("profile.row.privacy")}     sub={t("profile.row.privacy.sub")}  color="rgba(251,191,36,0.18)" onClick={() => setSettingsSub("privacy")} />
              <PMRow Icon={Palette}    title={t("profile.row.appearance")}  sub={`${resolvedTheme === "dark" ? t("set.app.themeDark").replace(/^\S+\s/, "") : t("set.app.themeLight").replace(/^\S+\s/, "")} · Violet`}                  color="rgba(244,114,182,0.18)" onClick={() => setSettingsSub("appearance")} />
              <PMRow Icon={Bell}       title={t("profile.row.notifications")} sub={t("profile.row.notifications.sub")}    color="rgba(34,211,238,0.18)" onClick={() => setSettingsSub("notifications")} />
              <PMRow Icon={Languages}  title={t("profile.row.language")}    sub={locale === "ru" ? "Русский" : "English"}                 color="rgba(167,139,250,0.18)" onClick={() => setSettingsSub("language")} />
              <PMRow Icon={Info}       title={t("profile.row.about")}       sub={`v1.0.0 · ${BRAND.copy.securityAlgorithm || "ECDH P-256"}`} color="rgba(255,255,255,0.06)" onClick={() => setSettingsSub("about")} />
            </div>
          </div>
        </div>
      );
    }

    /* === SECURITY === */
    if (settingsSub === "security") {
      return (
        <div className="tg-menu-panel">
          <div className="tg-menu-panel-inner">
            <div className="tg-menu-header">
              <button className="tg-menu-back" onClick={goRoot} aria-label={t("common.back")}>
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700 }}>{t("set.sec.crumb")}</div>
                <h2 className="tg-menu-title">{t("set.sec.title")}</h2>
              </div>
            </div>

            <div className="pm-row" style={{ background: "rgba(167,139,250,0.10)", borderColor: "rgba(167,139,250,0.25)", marginBottom: 16 }}>
              <Shield size={16} color="#c4b5fd" />
              <div className="pm-row-info">
                <div className="pm-row-sub" style={{ color: "rgba(255,255,255,0.75)", fontSize: 11.5, lineHeight: 1.5 }}>
                  {t("set.sec.note")}
                </div>
              </div>
            </div>

            <h4 className="pm-section-title">{t("set.sec.appLock")}</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 22 }}>
              <AppLockSettings selfNumber={selfNumber} t={t} />
            </div>

            <h4 className="pm-section-title">{t("set.sec.panic")}</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 22 }}>
              <PanicModeSettings selfNumber={selfNumber} t={t} />
            </div>

            <h4 className="pm-section-title">{t("set.sec.messages")}</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 22 }}>
              <PMRow Icon={Timer} title={t("set.sec.selfDestruct")} sub={selfDestructSec ? t("set.sec.selfDestruct.sec", { n: selfDestructSec }) : t("set.sec.selfDestruct.off")}
                color="rgba(251,191,36,0.18)"
                onClick={() => {
                  const next = SELF_DESTRUCT_OPTIONS.findIndex(o => o.value === selfDestructSec);
                  const idx = next < 0 ? 0 : (next + 1) % SELF_DESTRUCT_OPTIONS.length;
                  setSelfDestructSec(SELF_DESTRUCT_OPTIONS[idx].value);
                }}
              />
              <PMRow Icon={Camera} title={t("set.sec.screenshots")} sub={t("set.sec.screenshots.sub")}
                color="rgba(34,211,238,0.18)"
                right={<PMToggle on={notifyScreenshots} onChange={() => setNotifyScreenshots(!notifyScreenshots)} />}
              />
              <PMRow Icon={Eye} title={t("set.sec.hidePreview")} sub={t("set.sec.hidePreview.sub")}
                color="rgba(52,211,153,0.18)"
                right={<PMToggle on={hidePreview} onChange={() => setHidePreview(!hidePreview)} />}
              />
            </div>

            <h4 className="pm-section-title">{t("set.sec.danger")}</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <PMRow Icon={Trash2} title={t("set.sec.clearChats")} sub={t("set.sec.clearChats.sub")} danger
                color="rgba(251,113,133,0.18)"
                onClick={() => setShowClearChatsConfirm(true)}
              />
              <PMRow Icon={Power} title={accounts.length > 1 ? t("set.sec.deleteAcc.multi") : t("set.sec.deleteAcc")} sub={accounts.length > 1 ? t("set.sec.deleteAcc.multi.sub") : t("set.sec.deleteAcc.sub")} danger
                color="rgba(251,113,133,0.18)"
                onClick={() => setShowLogoutConfirm(true)}
              />
            </div>

            {showLogoutConfirm && (
              createPortal(<div className="tg-modal-overlay" onClick={() => setShowLogoutConfirm(false)}>
                <div className="tg-modal" onClick={e => e.stopPropagation()}>
                  <div className="tg-modal-header"><h3>{accounts.length > 1 ? t("set.sec.deleteAcc.confirmTitleMulti") : t("set.sec.deleteAcc.confirmTitle")}</h3></div>
                  <div style={{ padding: "12px 24px" }}>
                    <p style={{ color: "rgba(255,255,255,0.65)", fontSize: 13 }}>{accounts.length > 1 ? t("set.sec.deleteAcc.confirmBodyMulti") : t("set.sec.deleteAcc.confirmBody")}</p>
                  </div>
                  <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "8px 24px 22px" }}>
                    <button onClick={() => setShowLogoutConfirm(false)} className="tg-btn-secondary">{t("common.cancel")}</button>
                    <button onClick={() => { setShowLogoutConfirm(false); deleteAccount(); }} className="tg-modal-btn primary" style={{ background: "linear-gradient(135deg,#fb7185,#f43f5e)" }}>{t("common.delete")}</button>
                  </div>
                </div>
              </div>, document.body)
            )}

            {showClearChatsConfirm && (
              createPortal(<div className="tg-modal-overlay" onClick={() => setShowClearChatsConfirm(false)}>
                <div className="tg-modal" onClick={e => e.stopPropagation()}>
                  <div className="tg-modal-header"><h3>{t("set.sec.clearChats.confirmTitle")}</h3></div>
                  <div style={{ padding: "12px 24px" }}>
                    <p style={{ color: "rgba(255,255,255,0.65)", fontSize: 13 }}>{t("set.sec.clearChats.confirmBody")}</p>
                  </div>
                  <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "8px 24px 22px" }}>
                    <button onClick={() => setShowClearChatsConfirm(false)} className="tg-btn-secondary">{t("common.cancel")}</button>
                    <button onClick={() => { setShowClearChatsConfirm(false); clearAllChats(); }} className="tg-modal-btn primary" style={{ background: "linear-gradient(135deg,#fb7185,#f43f5e)" }}>{t("set.sec.clearChats.confirmCta")}</button>
                  </div>
                </div>
              </div>, document.body)
            )}
          </div>
        </div>
      );
    }

    /* === PRIVACY === */
    if (settingsSub === "privacy") {
      return (
        <div className="tg-menu-panel">
          <div className="tg-menu-panel-inner">
            <div className="tg-menu-header">
              <button className="tg-menu-back" onClick={goRoot} aria-label={t("common.back")}>
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700 }}>{t("set.sec.crumb")}</div>
                <h2 className="tg-menu-title">{t("set.priv.title")}</h2>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <PMRow Icon={EyeOff}  title={t("set.priv.hideOnline")}      sub={t("set.priv.hideOnline.sub")}
                color="rgba(167,139,250,0.18)"
                right={<PMToggle on={privacySettings.hideOnline} onChange={() => updatePrivacy({ hideOnline: !privacySettings.hideOnline })} />}
              />
              <PMRow Icon={Eye}     title={t("set.priv.readReceipts")}    sub={t("set.priv.readReceipts.sub")}
                color="rgba(34,211,238,0.18)"
                right={<PMToggle on={privacySettings.disableReadReceipts} onChange={() => updatePrivacy({ disableReadReceipts: !privacySettings.disableReadReceipts })} />}
              />
              <PMRow Icon={SquarePen} title={t("set.priv.typing")}        sub={t("set.priv.typing.sub")}
                color="rgba(52,211,153,0.18)"
                right={<PMToggle on={privacySettings.disableTyping} onChange={() => updatePrivacy({ disableTyping: !privacySettings.disableTyping })} />}
              />
              <PMRow Icon={Timer}    title={t("set.priv.bar")}            sub={t("set.priv.bar.sub")}
                color="rgba(251,113,133,0.18)"
                right={<PMToggle on={privacySettings.burnAfterRead} onChange={() => updatePrivacy({ burnAfterRead: !privacySettings.burnAfterRead })} />}
              />
            </div>

            {/* S10.5/Q9: звонки и P2P — что видит собеседник */}
            <h4 className="pm-section-title" style={{ marginTop: 22 }}>{t("set.priv.network")}</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <PMRow Icon={Shield}  title={t("set.priv.privateCalls")}    sub={t("set.priv.privateCalls.sub")}
                color="rgba(167,139,250,0.18)"
                right={<PMToggle on={privacySettings.privateCalls} onChange={() => updatePrivacy({ privateCalls: !privacySettings.privateCalls })} />}
              />
              <PMRow Icon={Server}  title={t("set.priv.p2p")}             sub={t("set.priv.p2p.sub")}
                color="rgba(34,211,238,0.18)"
                right={<PMToggle on={privacySettings.p2pFallback} onChange={() => updatePrivacy({ p2pFallback: !privacySettings.p2pFallback })} />}
              />
            </div>
          </div>
        </div>
      );
    }

    /* === APPEARANCE === */
    if (settingsSub === "appearance") {
      return (
        <div className="tg-menu-panel">
          <div className="tg-menu-panel-inner">
            <div className="tg-menu-header">
              <button className="tg-menu-back" onClick={goRoot} aria-label={t("common.back")}>
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700 }}>{t("set.sec.crumb")}</div>
                <h2 className="tg-menu-title">{t("set.app.title")}</h2>
              </div>
            </div>

            <h4 className="pm-section-title">{t("set.app.theme")}</h4>
            <div className="pm-vibe-row" style={{ marginBottom: 10 }}>
              <button
                className={`pm-vibe-chip ${themePreference === "dark" ? "active" : ""}`}
                onClick={() => setThemePreference("dark" as Theme)}
              >{t("set.app.themeDark")}</button>
              <button
                className={`pm-vibe-chip ${themePreference === "system" ? "active" : ""}`}
                onClick={() => setThemePreference("system" as Theme)}
              >{t("set.app.themeSystem")}</button>
            </div>
            <div className="pm-row" style={{ background: "rgba(34,211,238,0.08)", borderColor: "rgba(34,211,238,0.20)", marginBottom: 22 }}>
              <Info size={16} color="#67e8f9" />
              <div className="pm-row-info">
                <div className="pm-row-sub" style={{ color: "rgba(255,255,255,0.75)", fontSize: 11.5, lineHeight: 1.5 }}>
                  {locale === "ru"
                    ? "В текущей версии Phantom использует только тёмную палитру — Liquid Glass лучше работает на тёмном фоне. Светлая тема появится позже."
                    : "Phantom currently runs in dark Liquid Glass only — light theme is on the roadmap."}
                </div>
              </div>
            </div>

            <h4 className="pm-section-title">{t("profile.section.vibe")}</h4>
            <div className="pm-vibe-row" style={{ marginBottom: 22 }}>
              {VIBE_LIST.map(v => (
                <button
                  key={v.id}
                  type="button"
                  className={`pm-vibe-chip ${vibe === v.id ? "active" : ""}`}
                  onClick={() => setVibe(v.id)}
                >{v.label}</button>
              ))}
            </div>

            <h4 className="pm-section-title">{t("set.app.sdTimer")}</h4>
            <div className="pm-vibe-row">
              {SELF_DESTRUCT_OPTIONS.map(opt => (
                <button key={opt.value}
                  className={`pm-vibe-chip ${selfDestructSec === opt.value ? "active" : ""}`}
                  onClick={() => setSelfDestructSec(opt.value)}
                >{t(opt.key)}</button>
              ))}
            </div>
          </div>
        </div>
      );
    }

    /* === DEVICES === */
    if (settingsSub === "devices") {
      return (
        <div className="tg-menu-panel">
          <div className="tg-menu-panel-inner">
            <div className="tg-menu-header">
              <button className="tg-menu-back" onClick={goRoot} aria-label={t("common.back")}>
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700 }}>{t("set.sec.crumb")}</div>
                <h2 className="tg-menu-title">{t("set.dev.title")}</h2>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <button className="pm-btn pm-btn-ghost" onClick={() => sendRelay({ type: "get_sessions" } as RelayOutbound)}>
                {t("set.dev.refresh")}
              </button>
            </div>

            {activeSessions.length === 0 && (
              <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 13 }}>{t("set.dev.empty")}</p>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {activeSessions.map(s => (
                <div key={s.deviceId} className="pm-row">
                  <div className="pm-row-icon" style={{ background: "rgba(34,211,238,0.18)" }}>
                    <Smartphone size={14} color="#fff" />
                  </div>
                  <div className="pm-row-info">
                    <div className="pm-row-title">
                      {s.platform || t("common.unknown")}
                      {s.current && <span style={{ color: "#34d399", fontSize: 10, marginLeft: 8, fontWeight: 600 }}>{t("set.dev.current")}</span>}
                    </div>
                    <div className="pm-row-sub">{new Date(s.lastActive).toLocaleString(locale === "ru" ? "ru-RU" : "en-US")}</div>
                  </div>
                  {!s.current && (
                    <button
                      className="pm-icon-btn pm-icon-btn-sm danger"
                      onClick={() => sendRelay({ type: "revoke_session", deviceId: s.deviceId } as RelayOutbound)}
                      title={t("set.dev.terminate")}
                      aria-label={t("set.dev.terminate")}
                    >
                      <X size={12} strokeWidth={2} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    /* === ABOUT === */
    if (settingsSub === "about") {
      return (
        <div className="tg-menu-panel">
          <div className="tg-menu-panel-inner">
            <div className="tg-menu-header">
              <button className="tg-menu-back" onClick={goRoot} aria-label={t("common.back")}>
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700 }}>{t("set.sec.crumb")}</div>
                <h2 className="tg-menu-title">{t("set.about.title")}</h2>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <PMRow Icon={Info}     title={t("set.about.version")}     sub="v1.0.0" color="rgba(167,139,250,0.18)" />
              <PMRow Icon={KeyRound} title={t("set.about.crypto")}      sub={BRAND.copy.securityAlgorithm || "ECDH P-256 · AES-256-GCM"} color="rgba(34,211,238,0.18)" />
              <PMRow Icon={Server}   title={t("set.about.storage")}     sub={t("set.about.storage.sub")} color="rgba(52,211,153,0.18)" />
              <PMRow Icon={Palette}  title={t("set.about.theme")}       sub={resolvedTheme === "light" ? t("set.app.themeLight").replace(/^\S+\s/, "") : t("set.app.themeDark").replace(/^\S+\s/, "")} color="rgba(244,114,182,0.18)" />
              <PMRow Icon={SettingsIcon} title={t("set.about.phantomNumber")} sub={formatNumber(selfNumber)} color="rgba(255,255,255,0.06)" />
              <PMRow Icon={SettingsIcon} title={t("set.about.status")}  sub={connState === "online" ? t("common.online") : t("common.offline")} color="rgba(255,255,255,0.06)" />
            </div>
          </div>
        </div>
      );
    }

    /* === SERVER === */
    if (settingsSub === "server") {
      const host = typeof window !== "undefined" ? window.location.host : "phantommessenger.org";
      return (
        <div className="tg-menu-panel">
          <div className="tg-menu-panel-inner">
            <div className="tg-menu-header">
              <button className="tg-menu-back" onClick={goRoot} aria-label={t("common.back")}>
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700 }}>{t("set.sec.crumb")}</div>
                <h2 className="tg-menu-title">{t("set.srv.title")}</h2>
              </div>
            </div>
            <div className="pm-row" style={{ background: "rgba(34,211,238,0.08)", borderColor: "rgba(34,211,238,0.20)", marginBottom: 18 }}>
              <Info size={16} color="#67e8f9" />
              <div className="pm-row-info">
                <div className="pm-row-sub" style={{ color: "rgba(255,255,255,0.75)", fontSize: 11.5, lineHeight: 1.5 }}>
                  {t("set.srv.note")}
                </div>
              </div>
            </div>
            <h4 className="pm-section-title">{t("set.srv.current")}</h4>
            <div className="pm-row">
              <div className="pm-row-icon" style={{ background: "rgba(34,211,238,0.18)" }}>
                <Server size={16} color="#fff" />
              </div>
              <div className="pm-row-info">
                <div className="pm-row-title" style={{ fontFamily: "JetBrains Mono, monospace" }}>{host}</div>
                <div className="pm-row-sub" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 6, height: 6, background: "#34d399", borderRadius: 999, display: "inline-block" }} />
                  {connState === "online" ? `${t("common.online")} · TLS 1.3` : t("common.offline")}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    /* === NOTIFICATIONS === */
    if (settingsSub === "notifications") {
      return (
        <div className="tg-menu-panel">
          <div className="tg-menu-panel-inner">
            <div className="tg-menu-header">
              <button className="tg-menu-back" onClick={goRoot} aria-label={t("common.back")}>
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700 }}>{t("set.sec.crumb")}</div>
                <h2 className="tg-menu-title">{t("set.notif.title")}</h2>
              </div>
            </div>
            <PMRow Icon={Bell}  title={t("set.notif.push")}
              sub={
                notifPermission === "granted" ? (pushEnabled ? t("set.notif.push.granted") : t("set.notif.push.disabled"))
                : notifPermission === "denied"  ? t("set.notif.push.denied")
                : t("set.notif.push.default")
              }
              color="rgba(34,211,238,0.18)"
              right={
                <PMToggle
                  on={notifPermission === "granted" && pushEnabled}
                  onChange={togglePush}
                />
              }
            />
            <PMRow Icon={Eye}   title={t("set.notif.hide")}  sub={t("set.notif.hide.sub")}
              color="rgba(52,211,153,0.18)"
              right={<PMToggle on={hidePreview} onChange={() => setHidePreview(!hidePreview)} />}
            />
          </div>
        </div>
      );
    }

    /* === LANGUAGE === */
    if (settingsSub === "language") {
      return (
        <div className="tg-menu-panel">
          <div className="tg-menu-panel-inner">
            <div className="tg-menu-header">
              <button className="tg-menu-back" onClick={goRoot} aria-label={t("common.back")}>
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.30em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", fontWeight: 700 }}>{t("set.sec.crumb")}</div>
                <h2 className="tg-menu-title">{t("set.lang.title")}</h2>
              </div>
            </div>
            <div className="pm-vibe-row" style={{ marginBottom: 16 }}>
              <button
                className={`pm-vibe-chip ${locale === "ru" ? "active" : ""}`}
                onClick={() => setLocale("ru" as Locale)}
              >{t("set.lang.ru")}</button>
              <button
                className={`pm-vibe-chip ${locale === "en" ? "active" : ""}`}
                onClick={() => setLocale("en" as Locale)}
              >{t("set.lang.en")}</button>
            </div>
            <div className="pm-row" style={{ background: "rgba(34,211,238,0.08)", borderColor: "rgba(34,211,238,0.20)" }}>
              <Info size={16} color="#67e8f9" />
              <div className="pm-row-info">
                <div className="pm-row-sub" style={{ color: "rgba(255,255,255,0.75)", fontSize: 11.5, lineHeight: 1.5 }}>
                  {t("set.lang.note")}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }
  }

  return null;
}
