import { useEffect, useRef, useState } from "react";
import { Search, Plus, MessageSquare, MoreHorizontal, Settings as SettingsIcon, SquarePen, X } from "lucide-react";
import type { ChatMessage } from "../types";
import { formatNumber, normalizeNumber } from "../lib/phone";
import { avatarColor, getInitials } from "../lib/utils";
import { avatarBackgroundCss, safeAvatar } from "../lib/avatar";
import { MeshStatusBadge } from "./MeshStatusBadge";
import { useT } from "../lib/i18n";

type ConnectionState = "offline" | "connecting" | "online";
type MenuPanel = null | "profile" | "contacts" | "settings" | "newchat";
type FilterTab = "all" | "unread" | "contacts" | "archive";

export interface SidebarProps {
  selfNumber: string;
  connState: ConnectionState;
  menuPanel: MenuPanel;
  setMenuPanel: (v: MenuPanel) => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  mobileChatOpen: boolean;
  filteredChatList: string[];
  activePeer: string;
  openChat: (peer: string) => void;
  messages: Record<string, ChatMessage[]>;
  contacts: Record<string, string>;
  avatars: Record<string, string>;
  unread: Record<string, number>;
  typingPeers: Record<string, number>;
  drafts: Record<string, string>;
  meshActivePeers?: number;
  meshCompanionOnline?: boolean;
  meshBridgeActive?: boolean;
  relayBaseUrl?: string;
}

export default function Sidebar(props: SidebarProps) {
  const {
    selfNumber, connState, menuPanel, setMenuPanel, searchQuery,
    setSearchQuery, mobileChatOpen,
    filteredChatList, activePeer, openChat, messages, contacts,
    avatars, unread, typingPeers, drafts,
    meshActivePeers, meshCompanionOnline, meshBridgeActive, relayBaseUrl,
  } = props;
  const { t } = useT();

  const [filter, setFilter] = useState<FilterTab>("all");
  const [searchOpen, setSearchOpen] = useState<boolean>(() => Boolean(searchQuery));
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Если запрос пришёл извне (например, из глобального хоткея) — раскрываем поле автоматически.
  useEffect(() => {
    if (searchQuery && !searchOpen) setSearchOpen(true);
  }, [searchQuery, searchOpen]);

  // Хоткей ⌘K / Ctrl+K — открывает и фокусирует поиск.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 30);
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, setSearchQuery]);

  const openSearch = () => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 30);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

  const peerDisplayName = (peer: string) => contacts[peer] || formatNumber(peer);
  const lastMessage = (peer: string): ChatMessage | null => {
    const msgs = messages[peer];
    if (!msgs || msgs.length === 0) return null;
    return msgs[msgs.length - 1];
  };

  const filteredList = filteredChatList.filter(peer => {
    switch (filter) {
      case "unread":   return (unread[peer] || 0) > 0;
      case "contacts": return !!contacts[peer];
      case "archive":  return false;
      default: return true;
    }
  });

  // Поиск по номеру: введён валидный Phantom Number, которого нет среди чатов —
  // предлагаем написать ему (лупа иначе только фильтрует уже существующие чаты).
  const searchNumber = (() => {
    const n = normalizeNumber(searchQuery);
    if (!n || n === selfNumber) return "";
    // чат уже есть (даже если текущий фильтр/запрос его скрыл) — не предлагаем «новый»
    return filteredChatList.includes(n) || (messages[n]?.length ?? 0) > 0 ? "" : n;
  })();
  const startChatFromSearch = () => {
    if (!searchNumber) return;
    setSearchQuery("");
    setSearchOpen(false);
    openChat(searchNumber);
  };

  const selfPhone = selfNumber ? formatNumber(selfNumber) : "phantom";
  const selfShortId = selfNumber ? `0x${selfNumber.slice(-4)}` : "";

  return (
    <aside
      className={`tg-sidebar ${mobileChatOpen ? "mobile-hidden" : ""}`}
      role="navigation"
      aria-label={t("profile.title")}
    >
      {/* === Header === */}
      <div className={`tg-sidebar-header pm-sidebar-header ${searchOpen ? "is-searching" : ""}`}>
        {!searchOpen ? (
          <div className="pm-sidebar-head-row">
            <button
              type="button"
              className="pm-sidebar-brand"
              onClick={() => setMenuPanel(menuPanel ? null : "profile")}
              aria-label={t("profile.title")}
            >
              <div className="pm-sidebar-logo">{"👻"}</div>
              <div>
                <div className="pm-sidebar-name">{t("splash.title")}</div>
                <div className="pm-sidebar-num">{selfPhone}</div>
              </div>
            </button>

            <div className="pm-sidebar-actions">
              <button
                type="button"
                className="pm-sidebar-action"
                onClick={openSearch}
                aria-label={t("sidebar.searchPlaceholder")}
                title={t("sidebar.searchPlaceholder")}
              >
                <Search size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className="pm-sidebar-action"
                onClick={() => setMenuPanel("newchat")}
                aria-label={t("sidebar.tooltip.newChat")}
                title={t("sidebar.tooltip.newChat")}
              >
                <SquarePen size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className="pm-sidebar-action"
                onClick={() => setMenuPanel(menuPanel === "settings" ? null : "settings")}
                aria-label={t("sidebar.tooltip.menu")}
                title={t("sidebar.tooltip.settings")}
              >
                <MoreHorizontal size={14} strokeWidth={2} />
              </button>
            </div>
          </div>
        ) : (
          /* Шапка превращается в полноширочное поле поиска */
          <div className="pm-sidebar-search-row">
            <button
              type="button"
              className="pm-sidebar-search-back"
              onClick={closeSearch}
              aria-label={t("common.back")}
              title={t("common.back")}
            >
              <X size={14} strokeWidth={2.2} />
            </button>
            <div className="pm-sidebar-search expanded">
              <Search size={14} strokeWidth={2} color="rgba(255,255,255,0.55)" />
              <input
                ref={searchInputRef}
                type="search"
                placeholder={t("sidebar.searchPlaceholder")}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === "Escape") closeSearch(); }}
                aria-label={t("sidebar.searchPlaceholder")}
                autoFocus
              />
              {searchQuery && (
                <button
                  type="button"
                  className="pm-sidebar-search-clear"
                  onClick={() => { setSearchQuery(""); searchInputRef.current?.focus(); }}
                  aria-label={t("common.cancel")}
                  title={t("common.cancel")}
                >
                  <X size={12} strokeWidth={2.4} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Mesh badge — связь с relay/mesh */}
        {!searchOpen && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <MeshStatusBadge
              baseUrl={relayBaseUrl ?? (typeof window !== "undefined" ? window.location.origin : undefined)}
              activeMeshPeers={meshActivePeers ?? 0}
              remoteCompanionOnline={meshCompanionOnline ?? false}
              bridgeActive={meshBridgeActive ?? false}
            />
          </div>
        )}
      </div>

      {/* === Filters === */}
      <div className="pm-sidebar-filters">
        <button
          type="button"
          className={`pm-pill ${filter === "all" ? "active" : ""}`}
          onClick={() => setFilter("all")}
        >{t("sidebar.filter.all")}</button>
        <button
          type="button"
          className={`pm-pill ${filter === "unread" ? "active" : ""}`}
          onClick={() => setFilter("unread")}
        >{t("sidebar.filter.unread")}</button>
        <button
          type="button"
          className={`pm-pill ${filter === "contacts" ? "active" : ""}`}
          onClick={() => setFilter("contacts")}
        >{t("sidebar.filter.contacts")}</button>
        <button
          type="button"
          className={`pm-pill ${filter === "archive" ? "active" : ""}`}
          onClick={() => setFilter("archive")}
        >{t("sidebar.filter.archive")}</button>
      </div>

      {/* === Chat list === */}
      <div className="tg-chat-list">
        {searchNumber && filter !== "archive" && (
          <div
            className="tg-chat-item"
            onClick={startChatFromSearch}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startChatFromSearch(); } }}
            role="button"
            tabIndex={0}
            aria-label={`${t("sidebar.search.writeTo")} ${formatNumber(searchNumber)}`}
          >
            <div className="tg-chat-avatar" style={{ background: avatarColor(searchNumber) }}>
              <SquarePen size={16} strokeWidth={2} />
            </div>
            <div className="tg-chat-info">
              <div className="tg-chat-top">
                <span className="tg-chat-name">{t("sidebar.search.writeTo")} {formatNumber(searchNumber)}</span>
              </div>
              <div className="tg-chat-bottom">
                <span className="tg-chat-preview">{t("sidebar.search.newChatByNumber")}</span>
              </div>
            </div>
          </div>
        )}
        {connState === "connecting" && filteredList.length === 0 && !searchNumber && (
          <div className="tg-skeleton-list">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="tg-skeleton-item">
                <div className="tg-skeleton tg-skeleton-avatar" />
                <div className="tg-skeleton-lines">
                  <div className="tg-skeleton tg-skeleton-line-name" />
                  <div className="tg-skeleton tg-skeleton-line-msg" />
                </div>
              </div>
            ))}
          </div>
        )}
        {connState !== "connecting" && filteredList.length === 0 && !searchNumber && (
          <div className="tg-empty-chats">
            <p>{filter === "archive" ? t("sidebar.empty.archive") : t("sidebar.empty.noChats")}</p>
            {filter !== "archive" && (
              <button className="link-btn" onClick={() => setMenuPanel("newchat")}>{t("sidebar.empty.startChat")}</button>
            )}
          </div>
        )}
        {filteredList.map(peer => {
          const last = lastMessage(peer);
          const name = peerDisplayName(peer);
          const isActive = peer === activePeer;
          const unreadCount = unread[peer] || 0;
          const isTyping = typingPeers[peer] && Date.now() - typingPeers[peer] < 3000;
          const draft = drafts[peer];

          return (
            <div
              key={peer}
              className={`tg-chat-item ${isActive ? "active" : ""}`}
              onClick={() => openChat(peer)}
              role="button"
              tabIndex={0}
            >
              <div
                className="tg-chat-avatar"
                style={safeAvatar(avatars[peer])
                  ? { backgroundImage: avatarBackgroundCss(avatars[peer]), backgroundSize: "cover", backgroundPosition: "center" }
                  : { background: avatarColor(peer) }
                }
              >
                {!safeAvatar(avatars[peer]) && (contacts[peer] ? getInitials(contacts[peer]) : peer.slice(-2))}
              </div>
              <div className="tg-chat-info">
                <div className="tg-chat-top">
                  <span className="tg-chat-name">{name}</span>
                  {last && (
                    <span className="tg-chat-time">
                      {new Date(last.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  )}
                </div>
                <div className="tg-chat-bottom">
                  <span className="tg-chat-preview">
                    {isTyping
                      ? t("common.typing")
                      : draft && !isActive
                        ? <><span className="draft-label">{t("common.draft")}</span>{draft.slice(0, 40)}</>
                        : last
                          // WEB-13: нераскрытое burn-сообщение не показываем в превью
                          ? (last.burnAfterRead && !last.burnRevealed && last.direction === "in"
                            ? "\uD83D\uDD25"
                            : (last.direction === "out" ? t("common.you") : "") + last.text.slice(0, 50))
                          : ""}
                  </span>
                  {unreadCount > 0 && <span className="tg-unread-badge">{unreadCount}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* === Footer (self) === */}
      <div className="pm-sidebar-foot">
        <div
          className="pm-sidebar-self-avatar"
          style={safeAvatar(avatars[selfNumber])
            ? { backgroundImage: avatarBackgroundCss(avatars[selfNumber]), backgroundSize: "cover", backgroundPosition: "center" }
            : { background: avatarColor(selfNumber) }
          }
        >
          {!safeAvatar(avatars[selfNumber]) && (selfNumber ? selfNumber.slice(-2) : "Я")}
          {connState === "online" && <span className="pm-sidebar-self-online" aria-hidden="true" />}
        </div>
        <div className="pm-sidebar-self-text">
          <div className="pm-sidebar-self-name">{t("sidebar.foot.me")}</div>
          <div className="pm-sidebar-self-meta">
            {connState === "online" ? t("common.online") : connState === "connecting" ? t("common.connecting") : t("common.offline")} · {t("sidebar.foot.id")}{selfShortId}
          </div>
        </div>
        <button
          type="button"
          className="pm-sidebar-action"
          onClick={() => setMenuPanel(menuPanel === "settings" ? null : "settings")}
          aria-label={t("sidebar.tooltip.settings")}
          title={t("sidebar.tooltip.settings")}
        >
          <SettingsIcon size={14} strokeWidth={2} />
        </button>
      </div>

    </aside>
  );
}
