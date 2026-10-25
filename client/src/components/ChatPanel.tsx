import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import {
  Send, Mic, Phone, Video, Search, X, Flame, Paperclip,
  Timer, ChevronLeft, MoreVertical,
} from "lucide-react";
import type { ChatMessage, ChatSettings, PinnedMessageInfo, Reaction, ReplyRef } from "../types";
import { formatNumber } from "../lib/phone";
import { avatarColor, formatCountdown, getInitials, MESSAGE_UNAVAILABLE } from "../lib/utils";
import { avatarBackgroundCss, safeAvatar } from "../lib/avatar";
import { VoicePlayer, SelfDestructTimer } from "./VoicePlayer";
import QrImage from "./QrImage";
import VoiceRecorderBar, { isVoiceRecordingSupported } from "./VoiceRecorderBar";
import { useT } from "../lib/i18n";
import type { VoiceHold, VoiceRecording } from "./VoiceRecorderBar";
import { MAX_ATTACHMENT_BYTES } from "../lib/meta1";
import MediaAttachment, { fileKindIcon, formatFileSize } from "./MediaAttachment";
import { keyFingerprint, safetyNumber, safetyNumberV2, safetyQrPayload } from "../lib/safety";

const SAVED_MESSAGES_KEY = "__saved__";
const EMOJI_QUICK = ["\u2764\uFE0F", "\uD83D\uDC4D", "\uD83D\uDE02", "\uD83D\uDE2E", "\uD83D\uDE22", "\uD83D\uDE21"];
const SELF_DESTRUCT_OPTIONS = [
  { label: "5 \u0441\u0435\u043A", value: 5 },
  { label: "30 \u0441\u0435\u043A", value: 30 },
  { label: "1 \u043C\u0438\u043D", value: 60 },
  { label: "5 \u043C\u0438\u043D", value: 300 },
  { label: "\u0412\u044B\u043A\u043B", value: 0 },
];
const CHAT_COLORS = ["#7b2fbe", "#4a90d9", "#e67e22", "#27ae60", "#e74c3c", "#1abc9c", "#f39c12", "#e91e63"];
const WALLPAPERS = [
  "",
  "linear-gradient(135deg, #0d1117 0%, #1a1a2e 100%)",
  "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)",
  "linear-gradient(135deg, #141e30 0%, #243b55 100%)",
  "linear-gradient(135deg, #1a2a6c 0%, #b21f1f 50%, #fdbb2d 100%)",
  "linear-gradient(135deg, #0d2137 0%, #0a1628 100%)",
];
const MESSAGE_WINDOW_SIZE = 100;

type CallState = "idle" | "calling" | "ringing" | "connected" | "reconnecting" | "failed";

export interface ChatPanelProps {
  activePeer: string;
  activePeerOnline: boolean | null;
  selfNumber: string;
  sessionReady: boolean;
  contacts: Record<string, string>;
  messages: Record<string, ChatMessage[]>;
  messageText: string;
  setMessageText: (v: string) => void;
  filteredActiveMessages: ChatMessage[];
  activeMessages: ChatMessage[];
  messagesEndRef: RefObject<HTMLDivElement | null>;
  // Actions
  sendMessage: (e?: FormEvent) => void;
  sendFile: (file: File) => void;
  sendReaction: (messageId: string, emoji: string, remove?: boolean) => void;
  saveToSavedMessages: (msg: ChatMessage) => void;
  handleDeleteMessage: (msgId: string) => void;
  pinMessage: (messageId: string) => void;
  unpinMessage: (messageId: string) => void;
  exportChat: () => void;
  startCall: (peer: string, withVideo: boolean) => void;
  saveContact: (number: string, name: string) => void;
  saveChatSetting: (peer: string, settings: ChatSettings) => void;
  sendTypingIndicator: () => void;
  openChat: (peer: string) => void;
  // UI state
  mobileChatOpen: boolean;
  setMobileChatOpen: (v: boolean) => void;
  replyTo: ReplyRef | null;
  setReplyTo: (v: ReplyRef | null) => void;
  selfDestructSec: number;
  setSelfDestructSec: (v: number) => void;
  showSelfDestructMenu: boolean;
  setShowSelfDestructMenu: (v: boolean) => void;
  reactionMsgId: string | null;
  setReactionMsgId: (v: string | null) => void;
  fullscreenImage: string | null;
  setFullscreenImage: (v: string | null) => void;
  deleteConfirmMsg: ChatMessage | null;
  setDeleteConfirmMsg: (v: ChatMessage | null) => void;
  pinnedMessages: Record<string, PinnedMessageInfo[]>;
  showPinned: boolean;
  setShowPinned: (v: boolean) => void;
  chatSearchQuery: string;
  setChatSearchQuery: (v: string) => void;
  chatSearchOpen: boolean;
  setChatSearchOpen: (v: boolean) => void;
  messageWindowSize: number;
  setMessageWindowSize: (v: number | ((prev: number) => number)) => void;
  chatSettings: Record<string, ChatSettings>;
  showCustomize: boolean;
  setShowCustomize: (v: boolean) => void;
  typingPeers: Record<string, number>;
  callState: CallState;
  // Voice
  isRecording: boolean;
  startRecording: () => void;
  sendVoiceMessage: (rec: VoiceRecording) => Promise<boolean>;
  cancelRecording: () => void;
  // Swipe
  swipingMsgId: string | null;
  swipeOffset: number;
  handleBubbleTouchStart: (e: React.TouchEvent, msgId: string) => void;
  handleBubbleTouchMove: (e: React.TouchEvent) => void;
  handleBubbleTouchEnd: () => void;
  handleBubbleMouseDown: (e: React.MouseEvent, msgId: string) => void;
  handleBubbleMouseMove: (e: React.MouseEvent) => void;
  handleBubbleMouseUp: () => void;
  // Add contact modal
  showAddContactModal: boolean;
  setShowAddContactModal: (v: boolean) => void;
  addContactName: string;
  setAddContactName: (v: string) => void;
  // Block/unblock
  blockedUsers: Set<string>;
  blockUser: (target: string) => void;
  unblockUser: (target: string) => void;
  // Delete for all
  deleteMessageForAll: (messageId: string) => void;
  // Edit message
  editingMsg: { id: string; peer: string; text: string } | null;
  setEditingMsg: (v: { id: string; peer: string; text: string } | null) => void;
  startEditMessage: (msg: { id: string; peer: string; text: string }) => void;
  sendEditMessage: () => void;
  // Avatars
  avatars: Record<string, string>;
  // Connection state (for loading skeleton)
  connState: string;
  // Key verification (4.5)
  peerKeys: Record<string, string>;
  showKeyVerification?: boolean;
  setShowKeyVerification?: (v: boolean) => void;
  // S3: verified[number] = отпечаток ключа собеседника (hex(SHA-256(raw65))[:32])
  verifiedKeys?: Record<string, string>;
  setVerifiedKeys?: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
  selfPublicKey?: string;
  // S3: ранее подтверждённый ключ собеседника сменился — неблокирующий баннер
  keyChanged?: boolean;
  dismissKeyChanged?: () => void;
  // S9/P6: отпечатки identity-ключей, которыми собеседник подписывал v2 (TOFU-множество)
  pinnedIdentity?: string[];
  // P7 (уточнение): отпечаток, подтверждённый пользователем кнопкой «проверено», и колбэк его обновления
  lastVerifiedIdentity?: string;
  markIdentityVerified?: (fp: string) => void;
  // Ручное «Снять проверку» — очищает и lastVerifiedIdentity этого номера
  unmarkIdentityVerified?: () => void;
  // S10.3/Q7: смена ключа не подтверждена — отправка/звонок заблокированы до «Продолжить»
  keyAlert?: boolean;
  onKeyAlertContinue?: () => void;
  // Q8: capabilities собеседника из последнего lookup_result ("meta1" → safety number v2 + QR)
  peerCapabilities?: string[];
  // Burn After Read (4.6)
  chatBurnSettings?: Record<string, boolean>;
  toggleBurnAfterRead?: (peer: string) => void;
  handleBurnReveal?: (peer: string, msgId: string) => void;
  // P2P (4.8) — direct WebRTC datachannel, активен либо по запросу,
  // либо автоматически когда relay недоступен
  p2pActive?: boolean;
  startP2P?: (peer: string) => void;
  disconnectP2P?: () => void;
  relayDown?: boolean;
  // P2P v2 §5.1–5.2: отмена передачи файла и повтор неудавшейся отправки
  cancelFileTransfer?: (peer: string, messageId: string) => void;
  retryFileTransfer?: (peer: string, messageId: string) => void;
}

// P2P v2 §5.1–5.2: статус передачи файла под пузырём — прогресс, «ожидает собеседника», причина,
// кнопки «Отменить» / «Повторить». Файлы идут только напрямую (DataChannel).
function FileTransferStatus({ item, onCancel, onRetry }: { item: ChatMessage; onCancel?: () => void; onRetry?: () => void }) {
  const st = item.transferState;
  if (!st) return null;
  const out = item.direction === "out";
  const pct = Math.round(Math.max(0, Math.min(1, item.progress ?? 0)) * 100);
  let label = "";
  switch (st) {
    case "waiting_peer": label = item.transferNote || "Ожидает собеседника"; break;
    case "offered": label = "Соединение…"; break;
    case "transferring": label = `${out ? "Отправка" : "Приём"} ${pct} %`; break;
    case "verifying": label = "Проверка…"; break;
    case "done": label = out ? ["Доставлено", item.transferNote].filter(Boolean).join(" · ") : (item.transferNote || ""); break;
    case "failed": label = item.transferNote || (out ? "Не отправлено" : "Передача прервана"); break;
    case "cancelled": label = item.transferNote || "Отменено"; break;
  }
  const active = st === "waiting_peer" || st === "offered" || st === "transferring" || st === "verifying";
  const linkBtn = { background: "none", border: 0, padding: 0, cursor: "pointer", color: "inherit", textDecoration: "underline", font: "inherit" } as const;
  return (
    <div className="tg-msg-file-transfer" role="status" aria-live="polite" style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
      {(st === "transferring" || st === "verifying") && (
        <div
          role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={st === "verifying" ? 100 : pct}
          aria-label={out ? "Отправка файла" : "Приём файла"}
          style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)", overflow: "hidden", marginBottom: 4 }}
        >
          <div style={{ width: `${st === "verifying" ? 100 : pct}%`, height: "100%", background: "currentColor", transition: "width 0.2s" }} />
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {label && <span>{label}</span>}
        {active && onCancel && <button type="button" onClick={onCancel} style={linkBtn}>{"Отменить"}</button>}
        {out && st === "failed" && onRetry && <button type="button" onClick={onRetry} style={linkBtn}>{"Повторить"}</button>}
      </div>
    </div>
  );
}

// X-02: код безопасности — phantom-safety-v2 (S10.2, номера + identity-ключи), если у собеседника
// capability "meta1" (Q8), иначе phantom-safety-v1 (S3). 12 групп по 5 цифр, 3 строки по 4.
// S10.4: QR `phantomsafety:2:<свой номер>:<свой fp>:<номер собеседника>:<fp собеседника>` —
// web только показывает его (сканируют Android/iOS) и даёт сверить цифры вручную.
function KeyVerificationPanel({ selfKey, peerKey, selfNumber, peerNumber, useV2, peerName, verified, onVerify, onUnverify, verifyBlocked }: {
  selfKey: string; peerKey: string; selfNumber: string; peerNumber: string; useV2: boolean; peerName: string;
  verified: boolean; onVerify: () => void; onUnverify: () => void;
  // P7: ключ с сервера не совпадает ни с одним закреплённым — подтверждать нельзя
  verifyBlocked?: boolean;
}) {
  const [groups, setGroups] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [qrText, setQrText] = useState("");

  useEffect(() => {
    let cancelled = false;
    setGroups(null);
    setFailed(false);
    setQrText("");
    if (!selfKey || !peerKey) { setFailed(true); return; }
    const sn = useV2 ? safetyNumberV2(selfNumber, selfKey, peerNumber, peerKey) : safetyNumber(selfKey, peerKey);
    sn.then(g => { if (!cancelled) { setGroups(g); setFailed(!g); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    if (useV2) {
      Promise.all([keyFingerprint(selfKey), keyFingerprint(peerKey)]).then(([a, b]) => {
        if (!cancelled && a && b) setQrText(safetyQrPayload(selfNumber, a, peerNumber, b));
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [selfKey, peerKey, selfNumber, peerNumber, useV2]);

  const rows = groups ? [groups.slice(0, 4), groups.slice(4, 8), groups.slice(8, 12)] : [];

  return (
    <div className="tg-key-verify-panel">
      <div className="tg-key-verify-title">{"Код безопасности"}</div>
      <p className="tg-key-verify-desc">
        {"Сравните код с "}{peerName}{" лично или по другому каналу связи."}
        {" У вас обоих он должен совпадать полностью."}
      </p>
      <div className="tg-key-verify-fingerprints">
        <div className="tg-key-fp-block">
          <code className="tg-key-fp-code" aria-label="Код безопасности">
            {failed
              ? "Ключ собеседника ещё не получен"
              : groups
                ? rows.map((r, i) => <div key={i}>{r.join(" ")}</div>)
                : "..."}
          </code>
        </div>
      </div>
      {useV2 && qrText && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, margin: "10px 0" }}>
          <div style={{ borderRadius: 8, background: "#fff", padding: 8 }}>
            <QrImage text={qrText} size={180} label="QR-код для сверки ключей" />
          </div>
          <span style={{ fontSize: 11.5, opacity: 0.7, textAlign: "center" }}>
            {"Собеседник может отсканировать этот QR в мобильном приложении"}
          </span>
        </div>
      )}
      {verified ? (

        <button className="tg-verify-confirmed-btn" onClick={onUnverify}>
          {"✅ Верифицировано — нажмите чтобы сбросить"}
        </button>
      ) : (
        <button className="tg-verify-action-btn" onClick={onVerify} disabled={!groups || verifyBlocked}>
          {"Отметить как верифицированный"}
        </button>
      )}
    </div>
  );
}

export default function ChatPanel(props: ChatPanelProps) {
  const {
    activePeer, activePeerOnline, selfNumber, sessionReady,
    contacts, messageText, setMessageText,
    filteredActiveMessages, activeMessages,
    messagesEndRef,
    sendMessage, sendFile, sendReaction, saveToSavedMessages,
    handleDeleteMessage, pinMessage, unpinMessage, exportChat,
    startCall, saveContact, saveChatSetting, sendTypingIndicator,
    mobileChatOpen, setMobileChatOpen,
    replyTo, setReplyTo, selfDestructSec, setSelfDestructSec,
    showSelfDestructMenu, setShowSelfDestructMenu,
    reactionMsgId, setReactionMsgId,
    fullscreenImage, setFullscreenImage,
    deleteConfirmMsg, setDeleteConfirmMsg,
    pinnedMessages, showPinned, setShowPinned,
    chatSearchQuery, setChatSearchQuery, chatSearchOpen, setChatSearchOpen,
    messageWindowSize, setMessageWindowSize,
    chatSettings, showCustomize, setShowCustomize,
    typingPeers, callState,
    isRecording, startRecording, sendVoiceMessage, cancelRecording,
    swipingMsgId, swipeOffset,
    handleBubbleTouchStart, handleBubbleTouchMove, handleBubbleTouchEnd,
    handleBubbleMouseDown, handleBubbleMouseMove, handleBubbleMouseUp,
    showAddContactModal, setShowAddContactModal, addContactName, setAddContactName,
    blockedUsers, blockUser, unblockUser,
    deleteMessageForAll,
    editingMsg, setEditingMsg, startEditMessage, sendEditMessage,
    avatars, connState,
  } = props;

  const peerDisplayName = (peer: string) => contacts[peer] || formatNumber(peer);
  const contactName = activePeer ? (contacts[activePeer] || formatNumber(activePeer)) : "";
  const peerIsTyping = activePeer && typingPeers[activePeer] && Date.now() - typingPeers[activePeer] < 3000;
  const chatKey = activePeer && selfNumber ? [activePeer, selfNumber].sort().join(":") : "";
  const currentPins = pinnedMessages[chatKey] || [];
  const longPressTimerRef = useRef<number | null>(null);

  // 6.1 — Header dropdown menu
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  // Голосовое: жест, начавший запись (null — клавиатура), и режим «без рук» (кнопка-микрофон прячется)
  const [voiceHold, setVoiceHold] = useState<VoiceHold | null>(null);
  const [voiceLocked, setVoiceLocked] = useState(false);
  const { t: tr } = useT();
  // Запись только WebM/Opus: без него кнопка-микрофон неактивна с подсказкой «Обновите браузер»
  const [voiceSupported] = useState(() => isVoiceRecordingSupported());
  // 6.2 — Peer profile panel
  const [showPeerProfile, setShowPeerProfile] = useState(false);
  // 6.14 — Scroll to bottom
  const [atBottom, setAtBottom] = useState(true);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // 6.12 — Auto-resize textarea
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Close header menu when switching peers
  useEffect(() => { setShowHeaderMenu(false); setShowPeerProfile(false); }, [activePeer]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const maxH = 6 * 24; // ~6 lines
    ta.style.height = Math.min(ta.scrollHeight, maxH) + "px";
  }, [messageText]);

  const statusIcon = (msg: ChatMessage) => {
    if (msg.direction !== "out") return null;
    if (msg.failed) return " \u2717";
    switch (msg.status) {
      case "read": return <span style={{ color: "var(--tg-accent, #7b2fbe)" }}>{" \u2713\u2713"}</span>;
      case "delivered": return " \u2713\u2713";
      case "sent": return " \u2713";
      case "sending": return " \u23F1";
      default: return " \u23F1";
    }
  };

  const statusClass = (msg: ChatMessage) => {
    if (msg.status === "read") return "status-read";
    if (msg.status === "delivered") return "status-delivered";
    return "";
  };

  const groupReactions = (reactions: Reaction[]) => {
    const map: Record<string, { emoji: string; count: number; users: string[] }> = {};
    for (const r of reactions) {
      if (!map[r.emoji]) map[r.emoji] = { emoji: r.emoji, count: 0, users: [] };
      map[r.emoji].count++;
      map[r.emoji].users.push(r.from);
    }
    return Object.values(map);
  };

  const cancelMessageLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const startMessageLongPress = useCallback((event: ReactPointerEvent<HTMLDivElement>, messageId: string) => {
    if (event.pointerType === "mouse") return;
    cancelMessageLongPress();
    longPressTimerRef.current = window.setTimeout(() => {
      setReactionMsgId(reactionMsgId === messageId ? null : messageId);
      longPressTimerRef.current = null;
    }, 420);
  }, [cancelMessageLongPress, reactionMsgId, setReactionMsgId]);

  useEffect(() => () => cancelMessageLongPress(), [cancelMessageLongPress]);

  // S3: «verified» действует, только если отпечаток ТЕКУЩЕГО ключа собеседника
  // (из lookup_result) совпадает с сохранённым при подтверждении.
  const activePeerKey = activePeer ? (props.peerKeys[activePeer] || "") : "";
  const [activePeerFp, setActivePeerFp] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setActivePeerFp(null);
    if (!activePeerKey) return;
    keyFingerprint(activePeerKey)
      .then(fp => { if (!cancelled) setActivePeerFp(fp); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activePeerKey]);
  // S9/P7: множество пинов непусто, а отпечаток ключа из lookup_result в него не входит —
  // липкий баннер, «verified» не действует и не выставляется. Нет ключа/отпечатка — баннера нет.
  // lastVerifiedIdentity считается членом множества пинов.
  const lastVerifiedFp = props.lastVerifiedIdentity;
  const identityPins = [...(props.pinnedIdentity || []), ...(lastVerifiedFp ? [lastVerifiedFp] : [])];
  const keyMismatch = !!activePeerFp && identityPins.length > 0 && !identityPins.includes(activePeerFp);
  // P7 (уточнение): ключ с сервера ≠ проверенному пользователем — баннер, пока не нажмут «проверено»
  // заново (кнопка доступна, если нет keyMismatch; нажатие обновляет lastVerifiedIdentity).
  const verifiedMismatch = !!activePeerFp && !!lastVerifiedFp && activePeerFp !== lastVerifiedFp;
  const isPeerVerified = !keyMismatch && !verifiedMismatch && !!activePeerFp && props.verifiedKeys?.[activePeer] === activePeerFp;

  // S5: текст цитаты/закрепа — только из локальной истории по messageId
  const findLocalMessage = (messageId: string) => activeMessages.find(m => m.id === messageId);
  const quotePreview = (messageId: string) => {
    const msg = findLocalMessage(messageId);
    // Непрочитанное «сжечь после прочтения» не раскрываем через цитату/закреп
    if (!msg || !msg.text || (msg.burnAfterRead && !msg.burnRevealed)) return MESSAGE_UNAVAILABLE;
    const text = msg.text;

    if (text.length <= 80) return text;
    const cut = text.lastIndexOf(" ", 80);
    return (cut > 0 ? text.slice(0, cut) : text.slice(0, 80)) + "…";
  };
  const quoteAuthor = (ref: ReplyRef) => {
    const from = ref.from || findLocalMessage(ref.messageId)?.from || "";
    return from ? (contacts[from] || formatNumber(from)) : "";
  };

  if (!activePeer) {
    return (
      <section
        className={`tg-chat-panel ${mobileChatOpen ? "mobile-open" : ""}`}
        role="main"
        aria-label="Информация о Phantom Messenger"
      >
        {connState === "connecting" && (
          <div className="tg-connecting-bar" role="status" aria-live="polite">
            {"Переподключение к серверу..."}
          </div>
        )}
        {connState === "offline" && (
          <div className="tg-connecting-bar offline" role="status" aria-live="polite">
            {"Нет соединения с сервером"}
          </div>
        )}
        <div className="tg-no-chat">
          <div className="tg-no-chat-icon">
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="80" height="80">
              <rect x="6" y="4" width="36" height="32" rx="6" />
              <path d="M6 28l10 12V28" />
              <circle cx="18" cy="20" r="2" fill="currentColor" stroke="none" />
              <circle cx="24" cy="20" r="2" fill="currentColor" stroke="none" />
              <circle cx="30" cy="20" r="2" fill="currentColor" stroke="none" />
            </svg>
          </div>
          <h2>Phantom Messenger</h2>
          <div className="tg-empty-onboarding">
            <div className="tg-onboarding-step">
              <span className="tg-onboarding-num">1</span>
              <span>
                {"Узнайте Phantom Number собеседника"}
                <span
                  className="tg-help-icon"
                  role="img"
                  tabIndex={0}
                  aria-label="Phantom Number — это NFT номер из коллекции Phantom Number на блокчейне TON. Используется как идентификатор пользователя без привязки к телефону или email."
                  title="Phantom Number — NFT номер из коллекции Phantom Number (TON). Купить или выбрать на phantomnumbers.org / getgems.io"
                >?</span>
              </span>
            </div>
            <div className="tg-onboarding-step">
              <span className="tg-onboarding-num">2</span>
              <span>{"Начните новый чат"}</span>
            </div>
            <div className="tg-onboarding-step">
              <span className="tg-onboarding-num">3</span>
              <span>{"Общайтесь безопасно с E2E шифрованием"}</span>
            </div>
          </div>
          <p className="tg-phantom-help">
            <strong>{"Что такое Phantom Number?"}</strong>{" \u2014 \u044D\u0442\u043E NFT \u043D\u043E\u043C\u0435\u0440 \u0438\u0437 \u043A\u043E\u043B\u043B\u0435\u043A\u0446\u0438\u0438 Phantom Number \u043D\u0430 \u0431\u043B\u043E\u043A\u0447\u0435\u0439\u043D\u0435 TON. \u041A\u0443\u043F\u0438\u0442\u044C \u0438\u043B\u0438 \u0432\u044B\u0431\u0440\u0430\u0442\u044C \u043C\u043E\u0436\u043D\u043E \u043D\u0430 phantomnumbers.org \u0438\u043B\u0438 getgems.io. \u0418\u0437\u0431\u0440\u0430\u043D\u043D\u043E\u0435 \u2014 \u044D\u0442\u043E \u0432\u0430\u0448\u0438 \u043B\u0438\u0447\u043D\u044B\u0435 \u0437\u0430\u043C\u0435\u0442\u043A\u0438 (\u0432\u0438\u0434\u043D\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u0430\u043C)."}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`tg-chat-panel ${mobileChatOpen ? "mobile-open" : ""}`}
      role="main"
      aria-label={`Переписка с ${peerDisplayName(activePeer)}`}
    >
      {connState === "connecting" && !props.p2pActive && (
        <div className="tg-connecting-bar" role="status" aria-live="polite">
          {"Переподключение к серверу..."}
        </div>
      )}
      {connState !== "online" && props.p2pActive && (
        <div className="tg-connecting-bar p2p-fallback" role="status" aria-live="polite" style={{ background: "rgba(50,205,150,0.15)", color: "#28d4a3" }}>
          {"🔗 Сервер недоступен. Прямое соединение с собеседником активно — сообщения и файлы идут напрямую."}
        </div>
      )}
      {connState === "offline" && !props.p2pActive && (
        <div className="tg-connecting-bar offline" role="status" aria-live="polite">
          {props.relayDown ? "Сервер недоступен, прямого соединения с собеседником нет. Сообщения отправятся после восстановления связи." : "Нет соединения. Сообщения будут отправлены после восстановления связи."}
        </div>
      )}
      {/* S10.3/Q7: липкое БЛОКИРУЮЩЕЕ предупреждение — отправка и звонки этому собеседнику
          заблокированы до «Сверить код» (проверено) или «Продолжить» (подтвердить смену). */}
      {props.keyAlert && activePeer !== SAVED_MESSAGES_KEY && (
        <div className="tg-connecting-bar key-mismatch" role="alert" style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "stretch" }}>
          <span>{"Ключ безопасности собеседника изменился. Сверьте код безопасности или подтвердите, что знаете о смене устройства. До этого отправка сообщений и звонки заблокированы."}</span>
          <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              className="tg-verify-action-btn"
              onClick={() => { setShowPeerProfile(true); props.setShowKeyVerification?.(true); }}
            >
              {"Сверить код"}
            </button>
            <button type="button" className="tg-btn-secondary" onClick={() => props.onKeyAlertContinue?.()}>
              {"Продолжить"}
            </button>
          </span>
        </div>
      )}
      {/* S9/P7: липкий баннер — ключ с сервера не совпадает ни с одним закреплённым identity-ключом */}
      {(keyMismatch || verifiedMismatch) && (
        <div className="tg-connecting-bar key-mismatch" role="alert">
          <button
            type="button"
            className="tg-key-changed-text"
            onClick={() => { setShowPeerProfile(true); props.setShowKeyVerification?.(true); }}
          >
            {keyMismatch
              ? "Ключ с сервера не совпадает ни с одним ключом, которым собеседник подписывал сообщения"
              : "Ключ с сервера отличается от проверенного вами — сверьте код безопасности заново"}
          </button>
        </div>
      )}
      {/* S3: неблокирующее уведомление о смене подтверждённого ключа собеседника */}
      {props.keyChanged && !keyMismatch && !verifiedMismatch && (
        <div className="tg-connecting-bar key-changed" role="status" aria-live="polite">
          <button
            type="button"
            className="tg-key-changed-text"
            onClick={() => { setShowPeerProfile(true); props.setShowKeyVerification?.(true); }}
          >
            {"Ключ безопасности собеседника изменился — проверьте код безопасности заново"}
          </button>
          <button
            type="button"
            className="tg-key-changed-dismiss"
            onClick={() => props.dismissKeyChanged?.()}
            aria-label="Скрыть уведомление"
          >
            {"×"}
          </button>
        </div>
      )}

      {/* Chat header */}
      <div className="tg-chat-header">
        <button className="tg-back-btn" onClick={() => { cancelRecording(); setMobileChatOpen(false); }} aria-label="Назад">
          <ChevronLeft size={20} strokeWidth={2} />
        </button>
        {/* 6.2 — Clickable avatar+info opens peer profile */}
        <div className="tg-header-peer-clickable" onClick={() => activePeer !== SAVED_MESSAGES_KEY && setShowPeerProfile(v => !v)}>
          <div className="tg-chat-avatar header" style={safeAvatar(avatars[activePeer])
            ? { backgroundImage: avatarBackgroundCss(avatars[activePeer]), backgroundSize: "cover", backgroundPosition: "center" }
            : { background: avatarColor(activePeer) }
          }>
            {!safeAvatar(avatars[activePeer]) && (contacts[activePeer] ? getInitials(contacts[activePeer]) : activePeer.slice(-2))}
          </div>
          <div className="tg-header-info">
            <div className="tg-header-name">{peerDisplayName(activePeer)}</div>
            <div className={`tg-header-status ${peerIsTyping ? "typing" : activePeerOnline === true ? "online" : ""}`}>
              {peerIsTyping
                ? "печатает..."
                : activePeerOnline === true ? "в сети"
                : activePeerOnline === false ? "не в сети"
                : "..."}
            </div>
          </div>
        </div>
        {/* 6.1 — Only 3 primary buttons + "..." menu */}
        <div className="tg-header-actions">
          <button className="tg-header-action" onClick={() => { setChatSearchOpen(!chatSearchOpen); setChatSearchQuery(""); }} title="Поиск в чате">
            <Search size={18} strokeWidth={1.75} />
          </button>
          {activePeer !== SAVED_MESSAGES_KEY && <button className="tg-header-action" onClick={() => startCall(activePeer, false)} title="Аудио звонок" aria-label="Аудио звонок" disabled={callState !== "idle"}>
            <Phone size={18} strokeWidth={1.75} />
          </button>}
          {activePeer !== SAVED_MESSAGES_KEY && <button className="tg-header-action" onClick={() => startCall(activePeer, true)} title="Видео звонок" aria-label="Видео звонок" disabled={callState !== "idle"}>
            <Video size={18} strokeWidth={1.75} />
          </button>}
          {selfDestructSec > 0 && (
            <div className="tg-timer-badge" title={`Самоуничтожение: ${formatCountdown(selfDestructSec)}`}>
              {formatCountdown(selfDestructSec)}
            </div>
          )}
          {/* P2P indicator (4.8) — показываем при любой активности (auto или manual) */}
          {props.p2pActive && (
            <span className="tg-p2p-badge" title="Прямое соединение между устройствами: сообщения и файлы идут напрямую, сервер видит только сигналинг." style={{ color: "#28d4a3" }}>🔗 P2P</span>
          )}
          {/* "..." dropdown */}
          <div className="tg-header-more-wrap">
            <button className="tg-header-action" onClick={() => setShowHeaderMenu(v => !v)} title="Ещё">
              <MoreVertical size={20} strokeWidth={2} />
            </button>
            {showHeaderMenu && (
              <>
                <div className="tg-header-menu-backdrop" onClick={() => setShowHeaderMenu(false)} />
                <div className="tg-header-dropdown">
                  {currentPins.length > 0 && (
                    <button onClick={() => { setShowPinned(!showPinned); setShowHeaderMenu(false); }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M12 2L12 12" /><circle cx="12" cy="18" r="4" /></svg>
                      {"Закреплённые"} ({currentPins.length})
                    </button>
                  )}
                  <button onClick={() => { exportChat(); setShowHeaderMenu(false); }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                    {"Экспорт чата"}
                  </button>
                  <button onClick={() => { setShowCustomize(!showCustomize); setShowHeaderMenu(false); }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                    {"Настройка чата"}
                  </button>
                  {!contacts[activePeer] && activePeer !== SAVED_MESSAGES_KEY && (
                    <button onClick={() => { setAddContactName(""); setShowAddContactModal(true); setShowHeaderMenu(false); }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" /></svg>
                      {"Сохранить контакт"}
                    </button>
                  )}
                  {activePeer !== SAVED_MESSAGES_KEY && (
                    blockedUsers.has(activePeer) ? (
                      <button onClick={() => { unblockUser(activePeer); setShowHeaderMenu(false); }} className="tg-dropdown-danger">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></svg>
                        {"Разблокировать"}
                      </button>
                    ) : (
                      <button onClick={() => { blockUser(activePeer); setShowHeaderMenu(false); }} className="tg-dropdown-danger">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></svg>
                        {"Заблокировать"}
                      </button>
                    )
                  )}
                  {/* Burn After Read toggle (4.6) */}
                  <button onClick={() => { props.toggleBurnAfterRead?.(activePeer); setShowHeaderMenu(false); }}>
                    {props.chatBurnSettings?.[activePeer] ? "🔥 Burn: ВКЛ" : "🔥 Burn: ВЫКЛ"}
                  </button>
                  {/* P2P toggle (4.8) */}
                  <button onClick={() => {
                    if (props.p2pActive) props.disconnectP2P?.();
                    else props.startP2P?.(activePeer);
                    setShowHeaderMenu(false);
                  }}>
                    {props.p2pActive ? "📡 Разорвать прямое соединение" : "📡 Прямое соединение (P2P)"}
                  </button>
                  <div className="tg-dropdown-e2e"><span className="tg-e2e-badge">E2E</span> {"Шифрование активно"}</div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 6.2 — Peer profile panel */}
      {showPeerProfile && activePeer !== SAVED_MESSAGES_KEY && (
        <div className="tg-peer-profile">
          {/* Первым элементом и sticky: панель прокручивается, крестик остаётся видимым */}
          <button className="tg-peer-profile-close" onClick={() => setShowPeerProfile(false)} aria-label="Закрыть профиль" title="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
          <div className="tg-peer-profile-avatar" style={safeAvatar(avatars[activePeer])
            ? { backgroundImage: avatarBackgroundCss(avatars[activePeer]), backgroundSize: "cover", backgroundPosition: "center" }
            : { background: avatarColor(activePeer) }
          }>
            {!safeAvatar(avatars[activePeer]) && (contacts[activePeer] ? getInitials(contacts[activePeer]) : activePeer.slice(-2))}
          </div>
          <div className="tg-peer-profile-name">{peerDisplayName(activePeer)}</div>
          <div className="tg-peer-profile-number">{formatNumber(activePeer)}</div>
          <div className={`tg-peer-profile-status ${activePeerOnline === true ? "online" : ""}`}>
            {activePeerOnline === true ? "В сети" : activePeerOnline === false ? "Не в сети" : "..."}
          </div>
          <div className="tg-peer-profile-actions">
            <button onClick={() => { startCall(activePeer, false); setShowPeerProfile(false); }} disabled={callState !== "idle"} title="Аудио звонок">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
              <span>{"Звонок"}</span>
            </button>
            <button onClick={() => { startCall(activePeer, true); setShowPeerProfile(false); }} disabled={callState !== "idle"} title="Видео звонок">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></svg>
              <span>{"Видео"}</span>
            </button>
            {blockedUsers.has(activePeer) ? (
              <button onClick={() => unblockUser(activePeer)} className="tg-peer-profile-danger" title="Разблокировать">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></svg>
                <span>{"Разблок."}</span>
              </button>
            ) : (
              <button onClick={() => blockUser(activePeer)} className="tg-peer-profile-danger" title="Заблокировать">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></svg>
                <span>{"Блокир."}</span>
              </button>
            )}
          </div>
          <div className="tg-peer-profile-e2e">
            <span className="tg-e2e-badge">E2E</span>
            <span>{"Сквозное шифрование активно"}</span>
          </div>
          {/* Safety Numbers / Key Verification (4.5) */}
          <div className="tg-peer-profile-section">
            <button className="tg-verify-btn" onClick={() => props.setShowKeyVerification?.(!props.showKeyVerification)}>
              {isPeerVerified ? "✅ Ключи верифицированы" : "🔑 Верифицировать ключи"}
            </button>
            {props.showKeyVerification && (
              <KeyVerificationPanel
                selfKey={props.selfPublicKey || ""}
                peerKey={props.peerKeys[activePeer] || ""}
                selfNumber={selfNumber}
                peerNumber={activePeer}
                useV2={(props.peerCapabilities || []).includes("meta1")}
                peerName={contactName}
                verified={isPeerVerified}
                verifyBlocked={keyMismatch}
                onVerify={() => {
                  if (!activePeerFp || keyMismatch) return;
                  props.setVerifiedKeys?.(prev => ({ ...prev, [activePeer]: activePeerFp }));
                  props.markIdentityVerified?.(activePeerFp);
                  props.dismissKeyChanged?.();
                }}
                onUnverify={() => {
                  props.setVerifiedKeys?.(prev => { const n = { ...prev }; delete n[activePeer]; return n; });
                  props.unmarkIdentityVerified?.();
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* Search in chat bar */}
      {chatSearchOpen && (
        <div className="tg-chat-search-bar">
          <input
            autoFocus
            placeholder="\u041F\u043E\u0438\u0441\u043A \u0432 \u0447\u0430\u0442\u0435..."
            value={chatSearchQuery}
            onChange={e => setChatSearchQuery(e.target.value)}
          />
          <span className="tg-chat-search-count">
            {chatSearchQuery.trim() ? `${filteredActiveMessages.length} / ${activeMessages.length}` : ""}
          </span>
          <button onClick={() => { setChatSearchOpen(false); setChatSearchQuery(""); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      )}

      {/* Pinned messages bar */}
      {showPinned && currentPins.length > 0 && (
        <div className="tg-pinned-bar">
          <div className="tg-pinned-header">
            <span>{"\u0417\u0430\u043A\u0440\u0435\u043F\u043B\u0451\u043D\u043D\u044B\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F"} ({currentPins.length})</span>
            <button onClick={() => setShowPinned(false)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
          {currentPins.map(pin => (
            <div key={pin.messageId} className="tg-pinned-item">
              <span className="tg-pinned-preview">{quotePreview(pin.messageId)}</span>
              <button className="tg-pinned-unpin" onClick={() => unpinMessage(pin.messageId)} title="\u041E\u0442\u043A\u0440\u0435\u043F\u0438\u0442\u044C">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Chat customization panel */}
      {showCustomize && activePeer && (
        <div className="tg-customize-panel">
          <h4>{"\u0426\u0432\u0435\u0442 \u0447\u0430\u0442\u0430"}</h4>
          <div className="tg-color-grid">
            {CHAT_COLORS.map(color => (
              <div
                key={color}
                className={`tg-color-swatch ${chatSettings[activePeer]?.chatColor === color ? "active" : ""}`}
                style={{ background: color }}
                onClick={() => saveChatSetting(activePeer, { chatColor: color })}
              />
            ))}
            <div
              className={`tg-color-swatch ${!chatSettings[activePeer]?.chatColor ? "active" : ""}`}
              style={{ background: "var(--accent)", opacity: 0.3 }}
              onClick={() => saveChatSetting(activePeer, { chatColor: undefined })}
              title="По умолчанию"
            />
          </div>
          <h4>{"\u0424\u043E\u043D \u0447\u0430\u0442\u0430"}</h4>
          <div className="tg-wallpaper-grid">
            {WALLPAPERS.map((wp, i) => (
              <div
                key={i}
                className={`tg-wallpaper-swatch ${chatSettings[activePeer]?.wallpaper === wp ? "active" : ""}`}
                style={{ background: wp || "var(--bg-0)" }}
                onClick={() => saveChatSetting(activePeer, { wallpaper: wp })}
              />
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        className="tg-messages"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-atomic="false"
        aria-label="Список сообщений"
        style={chatSettings[activePeer]?.wallpaper ? { background: chatSettings[activePeer].wallpaper } : undefined}
      >
        {filteredActiveMessages.length === 0 ? (
          <p className="tg-empty-msg">
            {chatSearchQuery.trim()
              ? "\u041D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E"
              : activePeerOnline === false
                ? "\u0421\u043E\u0431\u0435\u0441\u0435\u0434\u043D\u0438\u043A \u043E\u0444\u043B\u0430\u0439\u043D. \u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F \u0431\u0443\u0434\u0443\u0442 \u0434\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u044B \u043A\u043E\u0433\u0434\u0430 \u043E\u043D \u043F\u043E\u044F\u0432\u0438\u0442\u0441\u044F."
                : "\u041D\u0430\u0447\u043D\u0438\u0442\u0435 \u0440\u0430\u0437\u0433\u043E\u0432\u043E\u0440"}
          </p>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: "100%" }}
            data={filteredActiveMessages}
            initialTopMostItemIndex={filteredActiveMessages.length - 1}
            followOutput="smooth"
            alignToBottom
            atBottomStateChange={setAtBottom}
            itemContent={(idx, item) => {
              const prevItem = idx > 0 ? filteredActiveMessages[idx - 1] : null;
              const currDate = new Date(item.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
              const prevDate = prevItem ? new Date(prevItem.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : null;
              const showDateSep = !prevDate || prevDate !== currDate;
              const prevSameDir = prevItem && prevItem.direction === item.direction && !showDateSep;

              const itemTime = new Date(item.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
              const itemAuthor = item.direction === "out"
                ? "Вы"
                : (contacts[item.from] || formatNumber(item.from));
              // S9: системное уведомление клиента — без пузыря, реакций и свайпов
              if (item.system) {
                return (
                  <div>
                    {showDateSep && (
                      <div className="tg-date-separator" role="separator"><span>{currDate}</span></div>
                    )}
                    <div className="tg-system-notice" role="status"><span>{item.text}</span></div>
                  </div>
                );
              }
              return (
                <div>
                  {showDateSep && (
                    <div className="tg-date-separator" role="separator"><span>{currDate}</span></div>
                  )}
                  <div
                    className={`tg-bubble-wrapper ${swipingMsgId === item.id ? (swipeOffset < 0 ? "swiping-delete" : "swiping") : ""}`}
                    role="article"
                    aria-label={`От ${itemAuthor}, ${itemTime}${item.failed ? ", не отправлено" : ""}`}
                    style={swipingMsgId === item.id ? { transform: `translateX(${swipeOffset}px)` } : undefined}
                    onTouchStart={e => handleBubbleTouchStart(e, item.id)}
                    onTouchMove={handleBubbleTouchMove}
                    onTouchEnd={handleBubbleTouchEnd}
                    onMouseDown={e => handleBubbleMouseDown(e, item.id)}
                    onMouseMove={handleBubbleMouseMove}
                    onMouseUp={handleBubbleMouseUp}
                    onMouseLeave={handleBubbleMouseUp}
                    onPointerUp={cancelMessageLongPress}
                    onPointerCancel={cancelMessageLongPress}
                    onPointerLeave={cancelMessageLongPress}
                    onPointerMove={cancelMessageLongPress}
                  >
                    {swipingMsgId === item.id && swipeOffset > 0 && <div className="tg-swipe-reply-indicator">{"\u21A9"}</div>}
                    {swipingMsgId === item.id && swipeOffset < 0 && <div className="tg-swipe-delete-indicator">{"\uD83D\uDDD1"}</div>}
                    <div
                      className={`tg-bubble ${item.direction === "out" ? "out" : "in"} ${item.failed ? "failed" : ""} ${item.selfDestruct ? "self-destruct" : ""} ${prevSameDir ? "grouped" : ""}`}
                      style={item.direction === "out" && chatSettings[activePeer]?.chatColor ? {
                        background: `${chatSettings[activePeer].chatColor}30`,
                        borderColor: `${chatSettings[activePeer].chatColor}50`,
                      } : undefined}
                      onDoubleClick={() => setReactionMsgId(reactionMsgId === item.id ? null : item.id)}
                      onContextMenu={e => {
                        e.preventDefault();
                        setReactionMsgId(reactionMsgId === item.id ? null : item.id);
                      }}
                      onPointerDown={e => startMessageLongPress(e, item.id)}
                    >
                      {item.forwardFrom && (
                        <div className="tg-forward-label">
                          {"\u21AA \u041F\u0435\u0440\u0435\u0441\u043B\u0430\u043D\u043E \u043E\u0442 "}{contacts[item.forwardFrom] || formatNumber(item.forwardFrom)}
                        </div>
                      )}
                      {item.replyTo && (
                        <div className="tg-reply-quote">
                          <span className="tg-reply-from">{quoteAuthor(item.replyTo)}</span>
                          <span className="tg-reply-text">{quotePreview(item.replyTo.messageId)}</span>
                        </div>
                      )}
                      {/* Burn After Read (4.6) */}
                      {item.burnAfterRead && !item.burnRevealed && item.direction === "in" ? (
                        <div className="tg-burn-msg" onClick={() => props.handleBurnReveal?.(activePeer, item.id)}>
                          <span className="tg-burn-icon">{"🔥"}</span>
                          <span>{"Нажмите чтобы прочитать"}</span>
                        </div>
                      ) : item.isVoice ? (
                        <VoicePlayer voiceData={item.voiceData} duration={item.duration} durMs={item.voiceDurMs} wave={item.voiceWave} messageId={item.id} />
                      ) : (item.fileUrl || item.fileData) && item.mimeType?.startsWith("image/") ? (
                        <>
                          {/* P2P v2: fileUrl — blob: URL файла files_v1; fileData — data: URL легаси-вложения */}
                          <img
                            src={item.fileUrl || item.fileData}
                            alt={item.fileName || "image"}
                            className="tg-msg-image-preview"
                            onClick={() => setFullscreenImage((item.fileUrl || item.fileData)!)}
                          />
                          {item.fileName && <span className="tg-msg-file-name">{item.fileName}</span>}
                          <FileTransferStatus
                            item={item}
                            onCancel={() => props.cancelFileTransfer?.(activePeer, item.id)}
                            onRetry={() => props.retryFileTransfer?.(activePeer, item.id)}
                          />
                        </>
                      ) : (item.fileUrl || item.fileData || item.transferState) ? (
                        <div className="tg-msg-file">
                          {/* аудио/видео — встроенный плеер (blob: URL, CSP media-src), остальное — файл со значком по типу */}
                          {(item.fileUrl || item.fileData) && (item.mimeType?.startsWith("audio/") || item.mimeType?.startsWith("video/")) && (
                            <MediaAttachment dataUrl={item.fileData} src={item.fileUrl} mimeType={item.mimeType!} fileName={item.fileName} />
                          )}
                          <div className="tg-msg-file-row">
                            <span className="tg-msg-file-icon" aria-hidden="true">{fileKindIcon(item.mimeType, item.fileName)}</span>
                            <div className="tg-msg-file-info">
                              {(item.fileUrl || item.fileData) ? (
                                <a href={item.fileUrl || item.fileData} download={item.fileName || "file"} className="tg-msg-file-link" title={item.fileName || "file"}>
                                  {item.fileName || "file"}
                                </a>
                              ) : (
                                // Файл ещё принимается — скачивать нечего
                                <span className="tg-msg-file-link" title={item.fileName || "file"}>{item.fileName || "file"}</span>
                              )}
                              <span className="tg-msg-file-meta">
                                {item.fileSize ? formatFileSize(item.fileSize) : ""}
                                {item.fileSize && item.mimeType ? " · " : ""}
                                {item.mimeType && item.mimeType !== "application/octet-stream" ? item.mimeType : ""}
                              </span>
                            </div>
                          </div>
                          <FileTransferStatus
                            item={item}
                            onCancel={() => props.cancelFileTransfer?.(activePeer, item.id)}
                            onRetry={() => props.retryFileTransfer?.(activePeer, item.id)}
                          />
                        </div>
                      ) : (
                        <p>{item.text}</p>
                      )}
                      {item.selfDestructAt && (
                        <SelfDestructTimer expiresAt={item.selfDestructAt} />
                      )}
                      <div className="tg-bubble-footer">
                        <span className={`tg-bubble-time ${statusClass(item)}`}>
                          {item.edited && <span style={{ opacity: 0.6, marginRight: 4 }}>{"ред."}</span>}
                          {new Date(item.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                          {statusIcon(item)}
                        </span>
                        <button
                          type="button"
                          className={`tg-message-actions-trigger ${reactionMsgId === item.id ? "active" : ""}`}
                          aria-label="Действия с сообщением"
                          onClick={e => {
                            e.stopPropagation();
                            setReactionMsgId(reactionMsgId === item.id ? null : item.id);
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                            <circle cx="5" cy="12" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="19" cy="12" r="1.5" />
                          </svg>
                        </button>
                      </div>
                      {item.reactions && item.reactions.length > 0 && (
                        <div className="tg-reactions">
                          {groupReactions(item.reactions).map(r => (
                            <button
                              key={r.emoji}
                              className={`tg-reaction-chip ${r.users.includes(selfNumber) ? "own" : ""}`}
                              onClick={() => {
                                const myReaction = r.users.includes(selfNumber);
                                sendReaction(item.id, r.emoji, myReaction);
                              }}
                            >
                              {r.emoji} {r.count > 1 ? r.count : ""}
                            </button>
                          ))}
                        </div>
                      )}
                      {reactionMsgId === item.id && (
                        <div className="tg-reaction-picker">
                          {EMOJI_QUICK.map(emoji => (
                            <button key={emoji} onClick={() => sendReaction(item.id, emoji)}>
                              {emoji}
                            </button>
                          ))}
                          <button onClick={() => { setReplyTo({ messageId: item.id, text: item.text, from: item.from }); setReactionMsgId(null); }} title="Ответить">
                            {"\u21A9"}
                          </button>
                          {/* WEB-13: эфемерные (burn / таймер) нельзя копировать и сохранять в избранное */}
                          {!(item.burnAfterRead || item.selfDestructAt) && (
                          <button onClick={() => { navigator.clipboard.writeText(item.text); setReactionMsgId(null); }} title="Копировать">
                            {"\uD83D\uDCCB"}
                          </button>
                          )}
                          <button onClick={() => { pinMessage(item.id); setReactionMsgId(null); }} title=
"\u0417\u0430\u043A\u0440\u0435\u043F\u0438\u0442\u044C">
                            {"\uD83D\uDCCC"}
                          </button>
                          {!(item.burnAfterRead || item.selfDestructAt) && (
                          <button onClick={() => { saveToSavedMessages(item); setReactionMsgId(null); }} title="В избранное">
                            {"\uD83D\uDD16"}
                          </button>
                          )}
                          {item.direction === "out" && !item.isVoice && !item.fileName && (
                            <button onClick={() => { startEditMessage({ id: item.id, peer: activePeer, text: item.text }); setReactionMsgId(null); }} title="Редактировать">
                              {"\u270F\uFE0F"}
                            </button>
                          )}
                          <button onClick={() => { setDeleteConfirmMsg(item); setReactionMsgId(null); }} title="Удалить">
                            {"\uD83D\uDDD1\uFE0F"}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            }}
          />
        )}
      </div>

      {/* 6.14 — Scroll to bottom button */}
      {/* Не поверх открытой панели профиля: она занимает высоту ленты */}
      {!showPeerProfile && !atBottom && filteredActiveMessages.length > 0 && (
        <button
          className="tg-scroll-bottom-btn"
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: filteredActiveMessages.length - 1, behavior: "smooth" })}
          aria-label="К последним сообщениям"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
      )}

      {/* Reply bar */}
      {replyTo && (
        <div className="tg-reply-bar">
          <div className="tg-reply-bar-content">
            <span className="tg-reply-bar-name">{quoteAuthor(replyTo)}</span>
            <span className="tg-reply-bar-text">{quotePreview(replyTo.messageId)}</span>
          </div>
          <button className="tg-reply-bar-close" onClick={() => setReplyTo(null)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      )}

      {/* Edit bar */}
      {editingMsg && (
        <div className="tg-reply-bar" style={{ borderLeftColor: "var(--tg-accent, #7b2fbe)" }}>
          <div className="tg-reply-bar-content">
            <span className="tg-reply-bar-name">{"Редактирование"}</span>
            <span className="tg-reply-bar-text">{editingMsg.text.slice(0, 80)}</span>
          </div>
          <button className="tg-reply-bar-close" onClick={() => { setEditingMsg(null); setMessageText(""); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      )}

      {/* Blocked banner */}
      {activePeer && activePeer !== SAVED_MESSAGES_KEY && blockedUsers.has(activePeer) && (
        <div style={{ padding: "8px 16px", textAlign: "center", color: "var(--text-2)", fontSize: 13, background: "var(--bg-2)" }}>
          {"Пользователь заблокирован. "}
          <button onClick={() => unblockUser(activePeer)} style={{ color: "var(--tg-accent, #7b2fbe)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>{"Разблокировать"}</button>
        </div>
      )}

      {/* Composer */}
      <form className="tg-composer" onSubmit={editingMsg ? (e) => { e.preventDefault(); sendEditMessage(); } : sendMessage}>
        <button
          type="button"
          className="tg-attach-btn spring-press"
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.multiple = true;
            input.onchange = () => {
              if (input.files) {
                Array.from(input.files).forEach(f => sendFile(f));
              }
            };
            input.click();
          }}
          title="Прикрепить файл"
          aria-label="Прикрепить файл"
        >
          <Paperclip size={18} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className={`tg-composer-action spring-press ${selfDestructSec > 0 ? "active" : ""}`}
          onClick={() => setShowSelfDestructMenu(!showSelfDestructMenu)}
          title={selfDestructSec > 0 ? `\u0421\u0430\u043C\u043E\u0443\u043D\u0438\u0447\u0442\u043E\u0436\u0435\u043D\u0438\u0435: ${formatCountdown(selfDestructSec)}` : "\u0421\u0430\u043C\u043E\u0443\u043D\u0438\u0447\u0442\u043E\u0436\u0435\u043D\u0438\u0435"}
        >
          <Timer size={18} strokeWidth={1.75} />
        </button>
        {showSelfDestructMenu && (
          <div className="tg-self-destruct-menu">
            {SELF_DESTRUCT_OPTIONS.map(opt => (
              <button
                type="button"
                key={opt.value}
                className={selfDestructSec === opt.value ? "active" : ""}
                onClick={() => { setSelfDestructSec(opt.value); setShowSelfDestructMenu(false); }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
        {isRecording ? (
          <VoiceRecorderBar
            key={activePeer}
            hold={voiceHold}
            maxBytes={MAX_ATTACHMENT_BYTES}
            interrupted={callState !== "idle"}
            onSend={sendVoiceMessage}
            onCancel={cancelRecording}
            onLockedChange={setVoiceLocked}
          />
        ) : (
          <textarea
            ref={textareaRef}
            placeholder={!sessionReady ? "Инициализация шифрования..." : "Сообщение..."}
            value={messageText}
            disabled={!sessionReady}
            onChange={e => {
              setMessageText(e.target.value);
              sendTypingIndicator();
            }}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).form?.requestSubmit();
              }
            }}
            rows={1}
          />
        )}
        {messageText.trim() && !isRecording ? (
          <button type="submit" disabled={!activePeer || !messageText.trim() || !sessionReady} className="tg-send-btn spring-press" aria-label="Отправить сообщение">
            <Send size={20} strokeWidth={1.75} />
          </button>
        ) : (
          // Кнопка остаётся в DOM всю запись: на ней держится жест «удержание / свайп» на сенсоре
          <button
            type="button"
            className={`tg-mic-btn spring-press${isRecording ? " recording" : ""}${isRecording && voiceLocked ? " is-hidden" : ""}`}
            title={voiceSupported ? "Голосовое сообщение" : tr("voice.updateBrowser")}
            aria-label={voiceSupported ? "Голосовое сообщение" : tr("voice.updateBrowser")}
            disabled={(!sessionReady && !isRecording) || !voiceSupported}
            aria-hidden={isRecording && voiceLocked ? true : undefined}
            tabIndex={isRecording && voiceLocked ? -1 : undefined}
            onPointerDown={e => {
              if (isRecording || (e.pointerType === "mouse" && e.button !== 0)) return;
              setVoiceLocked(false);
              setVoiceHold({ x: e.clientX, y: e.clientY, pointerType: e.pointerType, t: performance.now() });
              startRecording();
            }}
            onClick={e => {
              // Клавиатура (Enter/Space): detail === 0 — сразу запись «без рук»
              if (e.detail !== 0 || isRecording) return;
              setVoiceHold(null);
              setVoiceLocked(true);
              startRecording();
            }}
            onContextMenu={e => e.preventDefault()}
          >
            <Mic size={20} strokeWidth={1.75} />
          </button>
        )}
      </form>

      {/* Add Contact Modal */}
      {showAddContactModal && activePeer && (
        <div className="tg-modal-overlay" onClick={() => setShowAddContactModal(false)}>
          <div className="tg-modal" onClick={e => e.stopPropagation()}>
            <div className="tg-modal-header">
              <h3>{"\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u043A\u043E\u043D\u0442\u0430\u043A\u0442"}</h3>
              <button className="tg-modal-close" onClick={() => setShowAddContactModal(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div className="tg-modal-body">
              <div className="tg-modal-avatar" style={{ background: avatarColor(activePeer) }}>
                {addContactName.trim() ? getInitials(addContactName.trim()) : activePeer.slice(-2)}
              </div>
              <div className="tg-modal-number">{formatNumber(activePeer)}</div>
              <input
                className="tg-modal-input"
                placeholder={"\u0418\u043C\u044F \u043A\u043E\u043D\u0442\u0430\u043A\u0442\u0430"}
                value={addContactName}
                onChange={e => setAddContactName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && addContactName.trim()) {
                    saveContact(activePeer, addContactName.trim());
                    setShowAddContactModal(false);
                  }
                }}
                autoFocus
              />
            </div>
            <div className="tg-modal-actions">
              <button className="tg-modal-btn secondary" onClick={() => setShowAddContactModal(false)}>
                {"\u041E\u0442\u043C\u0435\u043D\u0430"}
              </button>
              <button
                className="tg-modal-btn primary"
                disabled={!addContactName.trim()}
                onClick={() => {
                  saveContact(activePeer, addContactName.trim());
                  setShowAddContactModal(false);
                }}
              >
                {"\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirmMsg && (
        <div className="tg-modal-overlay" onClick={() => setDeleteConfirmMsg(null)}>
          <div className="tg-modal" onClick={e => e.stopPropagation()}>
            <div className="tg-modal-header">
              <h3>{"Удалить сообщение?"}</h3>
            </div>
            <div style={{ padding: "12px 20px" }}>
              <p style={{ color: "var(--text-2)", fontSize: 14 }}>{"Выберите действие"}</p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 20px 20px" }}>
              <button onClick={() => { handleDeleteMessage(deleteConfirmMsg.id); setDeleteConfirmMsg(null); }} className="tg-btn-secondary">{"Удалить у меня"}</button>
              {deleteConfirmMsg.direction === "out" && activePeer !== SAVED_MESSAGES_KEY && (
                <button onClick={() => { deleteMessageForAll(deleteConfirmMsg.id); setDeleteConfirmMsg(null); }} className="tg-btn-danger">{"Удалить у всех"}</button>
              )}
              <button onClick={() => setDeleteConfirmMsg(null)} className="tg-btn-secondary">{"Отмена"}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
