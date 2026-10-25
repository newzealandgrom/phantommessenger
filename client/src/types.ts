export type RelayInbound =
  | { type: "session_ready"; number: string; deviceId?: string }
  | { type: "registered"; status: "ok" | "invalid_public_key" }
  // capabilities (S9/P9): возможности клиента собеседника; отсутствие = старый клиент
  | { type: "lookup_result"; targetNumber: string; online: boolean; publicKey?: string; reason?: string; capabilities?: string[];
      // WEB-16 / mdev1: устройства номера (relay), копии шифруются только на закреплённые ключи
      devices?: { deviceId: string; publicKey: string; capabilities?: string[] }[] }
  // replyTo на приёме: строка (старый Android шлёт голый id) или объект — см. S5 у ReplyRef.
  // _meshBridge — маркер relay для сообщений, пришедших через mesh-bridge (P8: без TOFU/даунгрейд-проверок)
  | { type: "message"; fromNumber: string; encryptedBlob: EncryptedBlob; replyTo?: ReplyRef | string; forwardFrom?: string; selfDestruct?: number | "read"; messageId?: string; _meshBridge?: { hops?: number } }
  | { type: "peer_offline"; number?: string; toNumber?: string; reason?: string }
  | { type: "peer_online"; number: string }
  // callId (S10.5/Q10): UUID звонка от инициатора; отсутствует у старых клиентов
  | { type: "call_incoming"; fromNumber: string; sdp: RTCSessionDescriptionInit; callId?: string; media?: string }
  | { type: "call_answer"; fromNumber?: string; sdp: RTCSessionDescriptionInit; callId?: string }
  | { type: "ice_candidate"; fromNumber?: string; candidate: RTCIceCandidateInit; callId?: string }
  | { type: "session_replaced" }
  | { type: "error"; reason: string }
  // Typing indicator
  | { type: "typing"; fromNumber: string; isTyping: boolean }
  // Read/delivery receipts
  | { type: "read_receipt"; fromNumber: string; messageIds: string[]; timestamp: number }
  | { type: "delivery_receipt"; fromNumber: string; messageIds: string[]; timestamp: number }
  // Reactions
  // meta1 (S10.1): эмодзи и remove внутри encryptedBlob, снаружи emoji = ""
  | { type: "reaction"; fromNumber: string; messageId: string; emoji: string; remove: boolean; timestamp: number; encryptedBlob?: EncryptedBlob; toNumber?: string }
  // Pinned messages
  // preview всегда игнорируется: превью закрепа берётся из локальной истории (S5).
  | { type: "message_pinned"; messageId: string; pinnedBy: string; preview?: string; chatKey?: string }
  | { type: "message_unpinned"; messageId: string; unpinnedBy: string; chatKey?: string }
  | { type: "pinned_messages"; chatKey: string; pins: PinnedMessageInfo[] }
  // Offline queue
  | { type: "message_queued"; toNumber: string; messageId: string }
  // Call media toggle
  | { type: "call_media_toggle"; fromNumber: string; audio: boolean; video: boolean; callId?: string }
  // Call control
  | { type: "call_reject"; fromNumber: string; callId?: string }
  | { type: "call_hangup"; fromNumber: string; callId?: string }
  // File / voice messages
  | { type: "file_message"; fromNumber: string; encryptedBlob: EncryptedBlob; fileName: string; fileSize: number; mimeType: string; messageId?: string }
  | { type: "voice_message"; fromNumber: string; encryptedBlob: EncryptedBlob; duration: number; mimeType?: string; messageId?: string }
  // Chat settings sync
  | { type: "chat_settings"; peerNumber: string; chatColor: string | null; wallpaper: string | null }
  | { type: "chat_settings_all"; settings: Array<{ peerNumber: string; chatColor: string | null; wallpaper: string | null }> }
  // Multi-device sessions
  | { type: "sessions_list"; sessions: Array<{deviceId: string; platform: string; lastActive: number; current: boolean}> }
  | { type: "session_revoked"; deviceId: string }
  // Multi-device message sync
  | { type: "message_sync"; fromNumber: string; toNumber: string; encryptedBlob: EncryptedBlob; messageId?: string }
  // Push registration confirmation
  | { type: "push_registered"; status: string }
  // Block/unblock
  | { type: "user_blocked"; number: string }
  | { type: "user_unblocked"; number: string }
  | { type: "blocked_list"; numbers: string[] }
  // Delete messages
  | { type: "message_deleted"; fromNumber: string; messageIds: string[]; timestamp: number }
  // Edit messages
  | { type: "message_edited"; fromNumber: string; messageId: string; encryptedBlob: EncryptedBlob; timestamp: number }
  // Screenshot alert
  | { type: "screenshot_alert"; fromNumber: string; timestamp: number }
  // Burn after read acknowledgment
  | { type: "burn_read_ack"; fromNumber: string; messageId: string }
  // Token rotation
  | { type: "token_rotated"; token: string }
  // Queue overflow
  | { type: "queue_overflow"; toNumber: string; queueSize: number; queueMax: number; reason?: "overflow" | "payload_too_large" | "global_overflow" | string }
  // P2P signaling
  | { type: "p2p_offer"; fromNumber: string; sdp: RTCSessionDescriptionInit }
  | { type: "p2p_answer"; fromNumber: string; sdp: RTCSessionDescriptionInit }
  | { type: "p2p_ice_candidate"; fromNumber: string; candidate: RTCIceCandidateInit }
  // ── Mesh (T3/T4 transport, see MESH_INTEGRATION_PLAN.md) ──
  | { type: "mesh_identity_registered"; status: "ok" | "error"; relayAttestation?: string; relayPubkey?: string; expiresAtMs?: number; rotationCount?: number; reason?: string }
  | { type: "mesh_identity_lookup_result"; status: "ok" | "error"; targetNumber?: string; found?: boolean; identity?: MeshIdentityRecord; reason?: string }
  | { type: "mesh_peer_announce"; fromNumber: string; transports: string[]; status: "online" | "offline"; timestampMs: number }
  | { type: "mesh_bridge_forward_ack"; status: "ok" | "error"; reason?: string }
  | { type: "mesh_wakeup_ack"; status: "ok" | "error"; reason?: string };

export type RelayOutbound =
  | { type: "register"; publicKey: string; capabilities?: ClientCapability[] }
  | { type: "lookup"; targetNumber: string }
  // meta1-собеседнику (S10.1) — только { type, toNumber, messageId, encryptedBlob }
  // WEB-16 / mdev1: deviceBlobs — копии на остальные (закреплённые) устройства получателя
  | { type: "message"; toNumber: string; encryptedBlob: EncryptedBlob; replyTo?: ReplyWire; selfDestruct?: number | "read"; messageId?: string; deviceBlobs?: Record<string, EncryptedBlob> }
  | { type: "call_offer"; toNumber: string; sdp: RTCSessionDescriptionInit; callId?: string; media?: "audio" | "video" }
  | { type: "call_answer"; toNumber: string; sdp: RTCSessionDescriptionInit; callId?: string }
  | { type: "ice_candidate"; toNumber: string; candidate: RTCIceCandidateInit; callId?: string }
  | { type: "disconnect" }
  // Typing
  | { type: "typing"; toNumber: string; isTyping: boolean }
  // Receipts
  | { type: "read_receipt"; toNumber: string; messageIds: string[] }
  | { type: "delivery_receipt"; toNumber: string; messageIds: string[] }
  // Reactions: легаси — emoji/remove открыто; meta1 (S10.1) — только encryptedBlob
  | { type: "reaction"; toNumber?: string; messageId: string; emoji: string; remove?: boolean }
  | { type: "reaction"; toNumber: string; messageId: string; encryptedBlob: EncryptedBlob; deviceBlobs?: Record<string, EncryptedBlob> }
  // Pin
  // S5: preview всегда "" — открытый текст сообщения relay не получает.
  | { type: "pin_message"; toNumber?: string; messageId: string; preview: "" }
  | { type: "unpin_message"; toNumber?: string; messageId: string }
  | { type: "get_pins"; toNumber?: string }
  // Forward
  | { type: "forward"; toNumber: string; encryptedBlob: EncryptedBlob; forwardFrom: string; messageId: string }
  // Call media toggle
  | { type: "call_media_toggle"; toNumber: string; audio: boolean; video: boolean; callId?: string }
  // Call control
  | { type: "call_reject"; toNumber: string; callId?: string }
  | { type: "call_hangup"; toNumber: string; callId?: string }
  // File / voice messages
  | { type: "file_message"; toNumber: string; encryptedBlob: EncryptedBlob; fileName: string; fileSize: number; mimeType: string; messageId?: string }
  | { type: "voice_message"; toNumber: string; encryptedBlob: EncryptedBlob; duration: number; mimeType?: string; messageId?: string }
  // Chat settings sync
  | { type: "save_chat_settings"; peerNumber: string; chatColor?: string | null; wallpaper?: string | null }
  | { type: "get_chat_settings"; peerNumber?: string }
  // Push token
  | { type: "register_push"; pushToken: string; platform: string }
  | { type: "unregister_push" }
  // Multi-device sessions
  | { type: "get_sessions" }
  | { type: "revoke_session"; deviceId: string }
  // Block/unblock
  | { type: "block_user"; number: string }
  | { type: "unblock_user"; number: string }
  | { type: "get_blocked" }
  // S10.6/Q11: локальный блок-лист → relay (set |= numbers; set -= unblocked), ответ blocked_list
  | { type: "block_sync"; numbers: string[]; unblocked: string[] }
  // WEB-11: «Скрыть в сети» — relay не отдаёт online/peer_online собеседникам (RAM, после каждого register)
  | { type: "set_presence"; hidden: boolean }
  // Delete messages
  | { type: "message_delete"; toNumber: string; messageIds: string[] }
  // Edit messages
  | { type: "message_edit"; toNumber: string; messageId: string; encryptedBlob: EncryptedBlob; deviceBlobs?: Record<string, EncryptedBlob> }
  // Screenshot alert
  | { type: "screenshot_alert"; toNumber: string }
  // Burn after read ack
  | { type: "burn_read_ack"; toNumber: string; messageId: string }
  // P2P signaling
  | { type: "p2p_offer"; toNumber: string; sdp: RTCSessionDescriptionInit }
  | { type: "p2p_answer"; toNumber: string; sdp: RTCSessionDescriptionInit }
  | { type: "p2p_ice_candidate"; toNumber: string; candidate: RTCIceCandidateInit }
  // ── Mesh (T3/T4 transport) ──
  // Identity registration: client computes Ed25519 signature over
  //   "phantom-mesh-bind:v1\x00" || number || meshStaticPub(32) || meshSigningPub(32) || timestampMsBE(8)
  // and submits with a unique 32-hex nonce. Relay returns a relay-attestation
  // (Ed25519, signed with the long-lived relay key) that mobile peers can
  // verify offline. See backend/mesh.py and MESH_INTEGRATION_PLAN.md §17.3.
  | { type: "mesh_register_identity"; meshStaticPub: string; meshSigningPub: string; signature: string; timestampMs: number; nonce: string }
  | { type: "mesh_identity_lookup"; targetNumber: string }
  | { type: "mesh_announce"; transports: Array<"ble" | "wifi-aware" | "bridge">; status: "online" | "offline" }
  // Bridge-forward: send an E2E-encrypted blob through a peer that has
  // internet access. Sender sets ``originalSender`` (themself); the peer
  // who reaches the relay carries the message in this envelope. Backend
  // unwraps to a plain `message` for the recipient (or queues offline).
  | { type: "mesh_bridge_forward"; toNumber: string; encryptedBlob: EncryptedBlob; originalSender: string; messageId: string; meshHops: number; wakeupRecipient?: boolean }
  | { type: "mesh_wakeup"; toNumber: string; messageId?: string };

export type EncryptedBlob = {
  version: 1 | 2;
  senderPublicKey: string;     // всегда эфемерный ключ — НИКОГДА не ключ собеседника (S1)
  senderIdentityKey?: string;  // только v2: raw65 identity-ключ отправителя (S9.2)
  nonce: string;
  cipher: string;
  iv?: string; // Android compatibility alias for nonce
};

/** Возможности клиента, объявляемые в `register.capabilities` (P9). */
export type ClientCapability = "env2" | "meta1";

/**
 * ─── Протокол: конверт v2 (S9, X-01/X-02) — полная спецификация и правки P1–P12:
 * documentation/PROTOCOL_V2_SPEC.md, векторы: documentation/protocol_v2_vector.json ───
 * Blob: { version: 2, senderPublicKey: b64(raw65 eph_A), senderIdentityKey: b64(raw65 id_A),
 *         nonce = iv = b64(12 байт), cipher: b64(ct ‖ tag16) }.
 * ss1 = ECDH(eph_A, id_B), ss2 = ECDH(id_A, id_B); salt = SHA-256("phantom-v2-salt");
 * info = "phantom-env:2:<from>:<to>" ‖ id_A ‖ id_B ‖ eph_A; key = HKDF-SHA256(ss1‖ss2, salt, info, 32);
 * AES-256-GCM, AD = "phantom-env-ad:2:<from>:<to>". Реализация: public/envelope-v2.js + public/sw.js.
 * Версии на приёме: 2 → v2; 1/нет → v1; ≥3 → «Неподдерживаемая версия» (без попытки v1).
 * Выбор при отправке: v2, если в последнем lookup_result есть "env2" ИЛИ от номера уже
 * приходил v2 (peerEnv2). Исходящие — всегда на ключ из lookup_result.
 * TOFU (P6): pinnedIdentity[number] — множество ≤8 отпечатков (FIFO) из senderIdentityKey
 * успешно расшифрованных v2; новый отпечаток → сброс verified + системное сообщение + lookup.
 * P7: пины непусты и отпечаток ключа из lookup_result ∉ пинам → липкий баннер, verified запрещён.
 * P8: message_sync, from == self и _meshBridge — без TOFU/даунгрейд-проверок.
 */

/**
 * ─── Протокол S10 (documentation/PROTOCOL_S10_SPEC.md, правки Q1–Q18) ───
 * meta1 (capability "meta1"): если собеседнику шлём v2 И (lookup_result.capabilities ∋ "meta1"
 * ИЛИ от него уже приходил meta1) — текст/файл/голос уходят как
 * { type:"message", toNumber, messageId, encryptedBlob }; plaintext = U+0000 ‖ JSON
 * { k:"text"|"file"|"voice", id = messageId, text, data, name, mime, size, durMs, replyTo, fwd, sd, pad }.
 * Реакция: { type:"reaction", toNumber, messageId:<цель>, encryptedBlob } с { k:"reaction", target, emoji, remove }.
 * Правка: message_edit с { k:"text", id, text }. Приём — один диспетчер (App.tsx handleIncomingEnvelope),
 * парсер/валидатор — lib/meta1.ts (эталон documentation/meta1_vector.json, тест scripts/test-meta1.mjs).
 * Safety number v2 (lib/safety.ts) и QR `phantomsafety:2:…` — если у собеседника "meta1", иначе v1.
 */

/**
 * ─── Протокол: цитаты и пины (S5, X-03) — источник правды для всех клиентов ───
 * Канонический wire `replyTo`: объект `{ "messageId": string, "from": string }`.
 * Поле `text` НЕ отправляется: relay не должен видеть открытый текст цитаты.
 * Текст цитаты клиент берёт из локальной истории по `messageId`; если сообщения
 * нет — заглушка «Сообщение недоступно».
 * Приём: и строка (голый messageId от старого Android), и объект; `text` в
 * объекте optional — не хранится (см. `normalizeReplyRef` в lib/utils.ts).
 * `pin_message.preview` всегда `""`; превью закрепа рендерится из локальной
 * истории по `messageId`, иначе заглушка.
 *
 * Локально (`ChatMessage.replyTo`, состояние композера) используется ReplyRef;
 * `text` здесь — только локальный кэш композера, на провод не уходит.
 */
export type ReplyRef = {
  messageId: string;
  from?: string;
  text?: string;
};

/** Канонический wire-формат `replyTo` (S5). */
export type ReplyWire = {
  messageId: string;
  from: string;
};

/**
 * ─── Протокол: safety number `phantom-safety-v1` (S3, X-02) ───
 * Вход: A = свой публичный ключ, B = ключ собеседника — raw uncompressed P-256
 * (65 байт `0x04‖X‖Y`; base64/SPKI сначала приводится к raw).
 * lo = min(A,B), hi = max(A,B) — побайтовое лексикографическое сравнение.
 * H = SHA-256( UTF8("phantom-safety-v1") ‖ lo ‖ hi ).
 * 12 групп по 5 цифр: v = (H[2i] << 8) | H[2i+1], group_i = zeroPad5(v % 100000), i = 0..11.
 * Отпечаток для «verified»: fingerprint = hex(SHA-256(raw65))[:32];
 * verified[number] = fingerprint(ключ из lookup_result). Если lookup_result
 * принёс ключ с другим отпечатком — флаг снимается, в чате показывается
 * неблокирующее уведомление.
 * Тестовый вектор: A = 04 01 02 … 40, B = 04 40 3F … 01 →
 * 41239 37345 47415 32442 40923 18939 52879 39295 25097 09299 15516 19527
 * Реализация: lib/safety.ts.
 */


export type Reaction = {
  emoji: string;
  from: string;
  timestamp: number;
};

export type ChatMessage = {
  id: string;
  from: string;
  to: string;
  text: string;
  createdAt: number;
  direction: "in" | "out";
  failed?: boolean;
  // New fields
  status?: "sending" | "sent" | "delivered" | "read";
  replyTo?: ReplyRef;
  forwardFrom?: string;
  selfDestruct?: number | "read";
  selfDestructAt?: number;
  burnAfterRead?: boolean;
  burnRevealed?: boolean;
  reactions?: Reaction[];
  pinned?: boolean;
  // Editing
  edited?: boolean;
  editedAt?: number;
  // File / voice
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  fileData?: string; // data: URL — только легаси-вложения ≤ 140 КиБ (relay file_message / meta1 k=file)
  // P2P v2 (documentation/PROTOCOL_P2P_V2.md §5.3): файл files_v1 — blob: URL (Blob в RAM вкладки),
  // отзывается при удалении сообщения / logout. Поля ниже — только локальные, на провод не уходят.
  fileUrl?: string;
  transport?: "p2p" | "relay";
  progress?: number; // 0..1
  transferState?: "waiting_peer" | "offered" | "transferring" | "verifying" | "done" | "failed" | "cancelled";
  fileId?: string;
  transferNote?: string; // подпись под пузырём файла (§5.1: «ожидает», «старая версия», причина ошибки)
  duration?: number; // voice message duration in seconds
  isVoice?: boolean;
  voiceData?: string; // base64 audio data for voice message playback
  voiceWave?: string; // голосовое v2: волна (base64, 63 байта = 100 × 5 бит), PROTOCOL_VOICE_V2 §3
  voiceDurMs?: number; // голосовое v2: точная длительность, мс (duration — округлённые секунды)
  // Mesh metadata (set when message arrived via BLE/Wi-Fi Aware/bridge)
  meshTransport?: "ble" | "wifi-aware" | "bridge";
  meshHops?: number;
  meshSenderVerified?: boolean; // relay-attestation matched a pinned identity
  // Системное уведомление клиента (S9: смена ключа, старый протокол) — не сообщение собеседника
  system?: boolean;
};

export type PinnedMessageInfo = {
  messageId: string;
  pinnedBy: string;
  pinnedAt: number;
  preview: string;
};

// Mesh identity record returned from `mesh_identity_lookup_result` or the
// REST `/api/mesh/identity/{number}` endpoint. ``relayAttestation`` is the
// load-bearing field — clients verify it against the relay public key
// (pinned at first launch from `/api/mesh/relay-pubkey`) so a peer met
// offline through BLE/Wi-Fi Aware can be authenticated without the relay
// being reachable at the moment of the encounter (§4.3 scenario C).
export type MeshIdentityRecord = {
  number: string;
  meshStaticPub: string;     // base64 raw 32-byte X25519 pub
  meshSigningPub: string;    // base64 raw 32-byte Ed25519 pub
  signature: string;         // base64 raw 64-byte client-supplied bind signature
  registeredAtMs?: number;  // MESH-24: relay больше не отдаёт
  expiresAtMs: number;
  relayAttestation: string;  // base64(body || sig) — see backend/mesh.py
  rotationCount?: number;   // MESH-24: relay больше не отдаёт
  previous?: {
    meshSigningPub: string;
    meshStaticPub: string;
    expiresAtMs: number;     // 48h cooldown after rotation
  };
};

// Backend `/api/config` advertises mesh availability when MESH_ENABLED=1.
// Web clients cannot themselves do BLE/Wi-Fi Aware (the browser APIs are
// either unavailable or too restricted), but they participate in mesh as
// signaling endpoints and can render mesh-routed messages from other
// platforms with the right metadata badges.
export type MeshConfig = {
  enabled: boolean;
  relayPubkey?: string;          // Ed25519 public key, base64
  attestationTtlSec?: number;
  registerWindowSec?: number;
  bridgePayloadMaxBytes?: number;
};

export type Theme = "dark" | "light" | "system";

export type ChatSettings = {
  chatColor?: string;       // accent color override for chat bubbles
  wallpaper?: string;       // CSS gradient or image URL for chat background
  burnAfterRead?: boolean;  // messages are destroyed after being read
};

export type PrivacySettings = {
  hideOnline: boolean;
  disableReadReceipts: boolean;
  disableTyping: boolean;
  burnAfterRead: boolean;   // global default for burn after read
};

// S10.7: PIN и panic-PIN хранятся только как верификатор PBKDF2-SHA256
// ({ v, iter, salt, hash }, lib/applock.ts), открытого значения нет.
export type AppLockSettings = {
  enabled: boolean;
  pinHash?: { v: 1; iter: number; salt: string; hash: string };
  pinLength: 6 | 12 | 24;
  inactivityTimeout: number; // seconds (0 = on app switch)
};

export type PanicSettings = {
  enabled: boolean;
  pinHash?: { v: 1; iter: number; salt: string; hash: string };
};
