from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import ipaddress
import json
import logging
import math
import os
import re
import secrets
import threading
import time
import unicodedata
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import hashlib

import httpx
import jwt
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel
from starlette.datastructures import MutableHeaders
from starlette.requests import HTTPConnection

from .config import BASE_DIR, STARTUP_WARNINGS, settings
from . import mesh as _mesh

log = logging.getLogger("phantom.relay")
log.setLevel(logging.getLevelName(os.getenv("LOG_LEVEL", "INFO")))
if not log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(_handler)


WEB_DIR = (BASE_DIR / "client" / "dist").resolve()


def normalize_number(raw: str | None) -> str | None:
    # Только ASCII-цифры: str.isdigit() пропускает «١٢٣» и т.п. (review 2.1).
    digits = "".join(ch for ch in str(raw or "") if ch in "0123456789")
    if len(digits) != 10 or not digits.startswith("111"):
        return None
    return digits


def format_number(number: str) -> str:
    return f"{number[:3]}-{number[3:5]}-{number[5:8]}-{number[8:10]}"


def is_otp_code(code: str | None) -> bool:
    value = str(code or "")
    return len(value) == 6 and value.isdigit()


def _hash_pii(value: str | None) -> str:
    """Return a short, stable HMAC of a PII value suitable for log aggregation.

    Phone numbers, device IDs and other identifiers must not enter
    CloudWatch/ELK in cleartext — an operator with read-only access to the
    log stream would otherwise learn the full user list. Hashing with
    ``jwt_secret`` gives correlatable opaque tokens (same input → same
    digest within a key epoch) without exposing the underlying value.
    """
    import hmac as _hmac

    raw = str(value or "")
    if not raw:
        return "-"
    mac = _hmac.new(
        settings.jwt_secret.encode("utf-8"),
        f"pii:{raw}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return mac[:12]


_ALLOWED_AVATAR_DATA_PREFIXES: tuple[str, ...] = (
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/webp;base64,",
    "data:image/gif;base64,",
)

_AVATAR_MAX_LEN = 8192


def _validate_avatar_url(url: str | None) -> str:
    """Strip avatar URLs to scheme ``https://`` or narrowly-typed data URIs.

    Raw user input is echoed to other users inside the profile payload, so
    an unchecked ``javascript:fetch(...)`` or ``vbscript:`` string would
    execute in the recipient's context. We only accept:

    * ``https://<host>/...`` — must carry a non-empty hostname.
    * ``data:image/{png,jpeg,webp,gif};base64,...`` — common inline
      avatars, already harmless as ``<img src>`` targets.

    Any other scheme / malformed URL collapses to the empty string; the
    caller should treat that as "no avatar" and display a placeholder.
    """
    if not url:
        return ""
    raw = str(url).strip()
    if len(raw) > _AVATAR_MAX_LEN:
        return ""
    # Fast path for data URIs — avoid urllib's costly URL parser.
    if raw.startswith("data:"):
        if not raw.startswith(_ALLOWED_AVATAR_DATA_PREFIXES):
            return ""
        return raw
    from urllib.parse import urlparse

    try:
        p = urlparse(raw)
    except ValueError:
        return ""
    if p.scheme != "https" or not p.netloc:
        return ""
    return raw


@dataclass(slots=True)
class PendingOtp:
    requested_at: float
    expires_at: float
    resend_at: float
    verify_attempts: int = 0


@dataclass(slots=True)
class AuthToken:
    number: str
    expires_at: float
    issued_at: float = field(default_factory=time.time)
    # BE-30: устройство, для сессии которого выпущен токен ("" — токен
    # входа с verify-code, device_id на этом шаге ещё неизвестен).
    device_id: str = ""
    # AND-13: момент ротации (0 — токен не заменён). Заменённый токен живёт
    # ещё _ROTATION_GRACE_SEC, чтобы клиент, не успевший сохранить
    # token_rotated (обрыв WS), переподключился и получил новый.
    rotated_at: float = 0.0


@dataclass(slots=True)
class ClientSession:
    number: str
    ws: WebSocket
    public_key: str | None = None
    connected_at: float = field(default_factory=time.time)
    peer_id: str | None = None
    lookup_window: deque[float] = field(default_factory=deque)
    device_id: str = field(default_factory=lambda: secrets.token_hex(8))
    # BE-30: JWT, которым аутентифицировалась сессия (обновляется при
    # token_rotated) — чтобы ротация и revoke_session адресовали токены
    # конкретным сессиям, а не всем устройствам номера разом.
    auth_token: str = ""
    # BE-30: клиент прислал device hint → device_id стабилен между
    # подключениями, и токены сессии можно привязывать к нему claim'ом.
    hinted: bool = False
    # P9: capabilities, объявленные этим устройством при register.
    capabilities: list[str] = field(default_factory=list)
    # BE-09: token-bucket входящих WS-событий этой сессии.
    event_tokens: float = 0.0
    event_ts: float = 0.0
    event_notice_ts: float = 0.0


@dataclass(slots=True)
class OfflineMessage:
    msg_id: str
    from_number: str
    to_number: str
    payload: dict[str, Any]
    created_at: float
    expires_at: float
    delivery_attempted_at: float | None = None
    size_bytes: int = 0  # cached payload size, counted against the global cap
    # WEB-16 / mdev1: копии encryptedBlob по device_id получателя (клиенту не уходят как есть)
    device_blobs: dict[str, Any] | None = None


@dataclass(slots=True)
class PinnedMessage:
    message_id: str
    pinned_by: str
    pinned_at: float
    preview: str


pending_otps: dict[str, PendingOtp] = {}
auth_tokens: dict[str, AuthToken] = {}
sessions: dict[str, ClientSession] = {}  # number -> primary session (compat)
multi_sessions: dict[str, dict[str, ClientSession]] = {}  # number -> {device_id -> session}
registered_keys: dict[str, str] = {}  # number -> last known public key (persists across sessions)
# WEB-16 / mdev1: реестр устройств номера — device_id -> {"key", "caps", "seen"} (персистится,
# не больше MAX_DEVICES_PER_NUMBER на номер). lookup_result отдаёт его как "devices", и отправитель
# шифрует копию на каждое устройство (deviceBlobs). Только устройства со стабильным device hint.
registered_devices: dict[str, dict[str, dict[str, Any]]] = {}
MAX_DEVICES_PER_NUMBER = 8
_DEVICE_ID_RE = re.compile(r"^[0-9a-f]{16,64}$")
# BE-15: последняя активность владельца ключа (unix-время, персистится) — для TTL registered_keys.
_registered_key_seen: dict[str, float] = {}
registered_capabilities: dict[str, list[str]] = {}  # number -> capabilities primary-устройства (P9, напр. ["env2"])
user_profiles: dict[str, dict[str, str]] = {}  # number -> {"displayName": ..., "status": ..., "avatarUrl": ...}
chat_settings: dict[str, dict[str, str | None]] = {}  # "number:peerNumber" -> {"chatColor": ..., "wallpaper": ...}
push_tokens: dict[str, dict[str, dict[str, str]]] = {}  # number -> {device_id -> {"token":<fernet-encrypted>, "platform":...}}


_push_fernet: Any = None
_push_fernet_warned: bool = False


def _get_push_fernet() -> Any:
    """Lazy-initialised Fernet used to wrap push tokens in memory.

    The symmetric key is sourced from ``PUSH_TOKEN_ENCRYPTION_KEY`` (urlsafe
    base64, 32 bytes decoded). ``setup.sh`` auto-generates it so that a
    memory snapshot (gcore, Frida) or a leaked state dump exposes only
    ciphertext — the attacker still needs the key held in a separate env
    file / KMS to get the FCM/APNs token.

    If the key is missing we fall back to an ephemeral per-process key so
    that local dev keeps working; an operator-visible WARNING is logged
    once because this eliminates the persistence guarantee on restart
    (push_tokens in state.json become undecryptable after the process
    restarts with a new ephemeral key).
    """
    global _push_fernet, _push_fernet_warned
    if _push_fernet is not None:
        return _push_fernet
    try:
        from cryptography.fernet import Fernet, InvalidToken  # noqa: F401
    except ImportError:
        log.error("push: cryptography not installed — push tokens CANNOT be encrypted")
        return None
    key = os.environ.get("PUSH_TOKEN_ENCRYPTION_KEY", "").strip()
    if key:
        try:
            _push_fernet = Fernet(key.encode("utf-8"))
            return _push_fernet
        except Exception as exc:
            log.error("push: invalid PUSH_TOKEN_ENCRYPTION_KEY (%s) — falling back to ephemeral", exc)
    if not _push_fernet_warned:
        log.warning(
            "push: PUSH_TOKEN_ENCRYPTION_KEY not set — using ephemeral in-memory key. "
            "Persisted push_tokens will be undecryptable after restart. "
            "Run setup.sh or generate with `python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"`."
        )
        _push_fernet_warned = True
    _push_fernet = Fernet(Fernet.generate_key())
    return _push_fernet


def _encrypt_push_token(raw: str) -> str:
    """Encrypt a raw FCM/APNs push token for at-rest/in-memory storage."""
    if not raw:
        return ""
    f = _get_push_fernet()
    if f is None:
        return raw  # cryptography missing — best-effort, already logged
    try:
        return f.encrypt(raw.encode("utf-8")).decode("ascii")
    except Exception as exc:
        log.warning("push: encrypt failed: %s", exc)
        return raw


def _decrypt_push_token(stored: str) -> str:
    """Inverse of :func:`_encrypt_push_token`. Returns empty on failure."""
    if not stored:
        return ""
    f = _get_push_fernet()
    if f is None:
        return stored
    try:
        return f.decrypt(stored.encode("ascii")).decode("utf-8")
    except Exception:
        # Might be a legacy plaintext token (before encryption rolled out),
        # or a token encrypted with a previous ephemeral key. Treat as opaque
        # but do NOT leak it to push gateways in the latter case.
        return ""
offline_queue: dict[str, deque[OfflineMessage]] = {}
# Running total of payload bytes across the whole offline_queue. Each push
# adds size_bytes, each pop subtracts it. Protects against OOM-DoS when many
# recipients are offline.
_offline_queue_total_bytes: int = 0
pinned_messages: dict[str, list[PinnedMessage]] = {}  # chatKey -> list
cleanup_task: asyncio.Task | None = None
cleanup_watchdog_task: asyncio.Task | None = None
blocked_users: dict[str, set[str]] = {}  # blocker_number -> {blocked_numbers}
_http_lookup_window: dict[str, deque[float]] = {}  # number -> timestamps of recent lookups
_last_seen: dict[str, float] = {}  # number -> last activity timestamp
# WEB-11: номера с включённым «Скрыть в сети» (только RAM; клиент шлёт set_presence после register).
_presence_hidden: set[str] = set()
INACTIVE_DATA_TTL_SEC = 86400  # 24 hours — purge profiles/settings of inactive users
_push_client: httpx.AsyncClient | None = None

# Brute-force defences for /api/auth/verify-code and /api/auth/send-code.
# Per-IP sliding window of verify attempts (any number).
_verify_ip_hits: dict[str, deque[float]] = {}
# Per-number exponential backoff until timestamp — enforced even if the
# attacker rotates IPs.
_verify_number_next_ok: dict[str, float] = {}
# Per-IP sliding window for /send-code to cap OTP broadcast.
_send_ip_hits: dict[str, deque[float]] = {}
# Per-IP sliding window for TURN credential minting (/api/ice, /api/config).
_ice_ip_hits: dict[str, deque[float]] = {}
# BE-23: скользящие окна HTTP-fallback отправки (/api/messages/send).
_msg_send_ip_hits: dict[str, deque[float]] = {}
_msg_send_number_hits: dict[str, deque[float]] = {}
# S10.5: скользящие окна сигналинга звонков/P2P на номер-отправитель.
_call_offer_hits: dict[str, deque[float]] = {}
_p2p_offer_hits: dict[str, deque[float]] = {}
# Q10/L6: засчитанные call_offer: number -> {(target, callId): время первого появления}.
_call_id_seen: dict[str, dict[tuple[str | None, str], float]] = {}
# Пары номеров с известным звонком (порядок не важен) -> время последнего сигнала звонка.
# relay пересылает call_hangup/call_reject только внутри такой пары (см. _call_pair_known).
_call_pairs: dict[frozenset[str], float] = {}
_call_reneg_hits: dict[str, deque[float]] = {}
# BE-09: контентные WS-события на номер; BE-07: get/set_profile на номер.
_ws_content_hits: dict[str, deque[float]] = {}
# HTTP-fallback keys/register и messages/poll — на номер (ключи "reg:"/"poll:").
_http_fallback_hits: dict[str, deque[float]] = {}
_PUBLIC_KEY_MAX_CHARS = 1024
# BE-21: глобальное окно send-code (один ключ "*").
_otp_global_hits: dict[str, deque[float]] = {}
_profile_hits: dict[str, deque[float]] = {}
_WS_CONTENT_EVENTS = frozenset({
    "message", "file_message", "voice_message", "forward", "message_edit",
})
# BE-05: верхняя граница числа ключей в каждом rate-limit-словаре. При
# превышении cleanup выкидывает самые давно активные записи — память
# relay не растёт неограниченно при переборе IP/номеров.
_RATE_BUCKET_MAX_KEYS = 50_000


class SendCodeRequest(BaseModel):
    number: str | None = None
    phone: str | None = None


class VerifyCodeRequest(BaseModel):
    number: str | None = None
    phone: str | None = None
    code: str


# PROD-05: Swagger/ReDoc/OpenAPI-схема раскрывают все маршруты и схемы —
# по умолчанию выключены, включаются только ENABLE_API_DOCS=1.
_API_DOC_PATHS = ("docs", "redoc", "openapi.json", "docs/oauth2-redirect")
app = FastAPI(
    title="PHANTOM Relay",
    version="2.0.0",
    docs_url="/docs" if settings.enable_api_docs else None,
    redoc_url="/redoc" if settings.enable_api_docs else None,
    openapi_url="/openapi.json" if settings.enable_api_docs else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.app_origin, "http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
    max_age=3600,
)


def _generate_csp_nonce() -> str:
    """Generate a random nonce for Content Security Policy."""
    return secrets.token_urlsafe(24)


# Шаблон index.html для подстановки nonce. INFRA-09: перечитывается при смене
# mtime/inode/размера, поэтому выкладка web-клиента (swap client/dist) не требует
# рестарта relay — сессии и offline-очередь в RAM её переживают.
_index_html_template: str = ""
_index_html_sig: tuple[int, int, int] | None = None


def _get_index_html_template() -> str:
    global _index_html_template, _index_html_sig
    index_path = WEB_DIR / "index.html"
    try:
        st = index_path.stat()
    except OSError:
        _index_html_template, _index_html_sig = "", None
        return ""
    sig = (st.st_mtime_ns, st.st_ino, st.st_size)
    if sig != _index_html_sig:
        try:
            _index_html_template = index_path.read_text(encoding="utf-8")
            _index_html_sig = sig
        except OSError:
            return _index_html_template
    return _index_html_template


def _inject_nonce_into_html(html: str, nonce: str) -> str:
    """Inject nonce attribute into <script> tags in HTML."""
    import re
    # Add nonce to <script> tags that don't already have one
    html = re.sub(
        r'<script(?!\s+nonce=)',
        f'<script nonce="{nonce}"',
        html,
    )
    return html


@app.middleware("http")
async def security_headers(request: Request, call_next):
    nonce = _generate_csp_nonce()
    request.state.csp_nonce = nonce
    response = await call_next(request)
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "img-src 'self' data: blob:; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; "  # WEB-19: шрифты со своего сервера
        f"script-src 'self' 'nonce-{nonce}'; "
        f"connect-src {_CSP_CONNECT_SRC}; "
        "media-src 'self' blob:; "
        "worker-src 'self' blob:; "
        # WEB-19: закрываем base-tag injection, плагины, фрейминг и отправку форм наружу
        "base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; "
        "manifest-src 'self';"
    )
    # PROD-16: без preload — apex на :443 не обслуживается мессенджером.
    response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    return response


def _csp_connect_src() -> str:
    """BE-25: connect-src без голых ``ws:``/``wss:`` (это wildcard на любой хост).

    'self' + явный ws(s)-origin приложения: часть браузеров (старый Safari)
    не сопоставляет 'self' со схемой ws/wss.
    """
    from urllib.parse import urlparse

    sources = ["'self'"]
    for origin in (settings.app_origin,):
        parsed = urlparse(origin or "")
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            ws_scheme = "wss" if parsed.scheme == "https" else "ws"
            sources.append(f"{ws_scheme}://{parsed.netloc}")
            # Сайт доступен и через Cloudflare на стандартном порту (:443 без указания
            # порта) — тот же хост без порта тоже должен проходить connect-src.
            if parsed.hostname and parsed.port:
                sources.append(f"{ws_scheme}://{parsed.hostname}")
    return " ".join(dict.fromkeys(sources))


_CSP_CONNECT_SRC = _csp_connect_src()


def _number_reason(status_code: int, payload: dict[str, Any]) -> str:
    reason = str(payload.get("reason") or "").lower()
    error = str(payload.get("error") or payload.get("message") or "").lower()

    if "not_found" in reason or "не найден" in error or "не зарегистр" in error:
        return "number_not_found"
    if "invalid_code" in reason or "wrong_code" in reason or "bad_code" in reason or "incorrect" in reason or "mismatch" in reason or "неверный код" in error or "wrong" in error:
        return "invalid_code"
    if "code_expired" in reason or "код ист" in error:
        return "code_expired"
    if "inactive" in reason or "expired" in reason or "suspended" in reason or "неактив" in error:
        return "number_inactive"
    if "too_many" in reason or "rate" in reason or status_code == 429:
        return "rate_limited"
    if status_code == 404:
        return "number_not_found"
    if status_code == 403:
        return "number_inactive"
    return "upstream_error"


def _flag_is_true(value: Any) -> bool:
    return value is True or str(value).lower() in {"true", "1", "yes"}


def _numbers_api_success(path: str, payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False

    for key in ("ok", "success", "valid", "verified"):
        if key in payload and not _flag_is_true(payload.get(key)):
            return False

    if any(_flag_is_true(payload.get(key)) for key in ("ok", "success")):
        return True

    # Some Phantom Numbers deployments return
    # { "valid": true, "number_status": "active" } for verify-code.
    if "verify" in path and any(_flag_is_true(payload.get(key)) for key in ("valid", "verified")):
        number_status = str(payload.get("number_status") or payload.get("status") or "").lower()
        return number_status in {"", "active", "ok", "verified"}

    return False


async def _call_numbers_api(path: str, payload: dict[str, Any]) -> tuple[bool, dict[str, Any], int, str]:
    url = f"{settings.numbers_api_base}{path}"
    headers = {"Content-Type": "application/json"}
    if settings.service_secret:
        headers[settings.service_secret_header] = settings.service_secret

    verify_config: bool | str = settings.numbers_api_verify_ssl
    if verify_config is True:
        # The ambient SSL_CERT_FILE env-var (used by uvicorn for the
        # *inbound* TLS cert) would otherwise hijack the trust store for
        # outbound httpx calls as well — and that file only contains the
        # relay's own Let's Encrypt fullchain, not the roots needed to
        # verify other hosts. Pinning the Mozilla CA bundle (certifi)
        # side-steps SSL_CERT_FILE entirely while keeping verification on.
        try:
            import certifi
            verify_config = certifi.where()
        except ImportError:
            pass

    try:
        async with httpx.AsyncClient(timeout=15.0, verify=verify_config) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        log.warning("numbers: upstream_unreachable url=%s verify=%r err=%s: %s",
                    url, verify_config, type(exc).__name__, exc)
        return False, {"error": "upstream_unreachable"}, 503, "upstream_unreachable"

    try:
        data = response.json()
    except json.JSONDecodeError:
        data = {}

    success = _numbers_api_success(path, data)
    if response.status_code < 300 and success:
        return True, data, response.status_code, "ok"

    return False, data, response.status_code, _number_reason(response.status_code, data)


def _prune_rate_bucket(
    bucket: dict[Any, deque[float]],
    window_sec: float,
    now: float,
    max_keys: int = _RATE_BUCKET_MAX_KEYS,
) -> None:
    """BE-05: выкинуть просроченные метки и пустые ключи скользящего окна,
    затем ограничить число ключей (лишние — самые давно активные)."""
    cutoff = now - window_sec
    for key in list(bucket.keys()):
        q = bucket.get(key)
        if q is None:
            continue
        while q and q[0] < cutoff:
            q.popleft()
        if not q:
            bucket.pop(key, None)
    _cap_dict(bucket, max_keys, lambda q: q[-1] if q else 0.0)


def _cap_dict(bucket: dict[Any, Any], max_keys: int, sort_key: Any) -> None:
    """Удалить самые «старые» по ``sort_key`` записи сверх ``max_keys``."""
    excess = len(bucket) - max_keys
    if excess <= 0:
        return
    victims = sorted(bucket.keys(), key=lambda k: sort_key(bucket[k]))[:excess]
    for key in victims:
        bucket.pop(key, None)
    log.warning("cleanup: rate bucket over cap, evicted %d oldest keys", excess)


def _sanitize_public_key(raw: Any) -> str:
    """Публичный ключ устройства: непустая печатная ASCII-строка без пробелов,
    не длиннее _PUBLIC_KEY_MAX_CHARS (ключ персистится и отдаётся в lookup)."""
    if not isinstance(raw, str):
        return ""
    key = raw.strip()
    if not key or len(key) > _PUBLIC_KEY_MAX_CHARS or any(not ("!" <= ch <= "~") for ch in key):
        return ""
    return key


def _ws_event_allowed(session: ClientSession, now: float) -> bool:
    """BE-09: token-bucket на сессию — один клиент не может бесконечно
    флудить relay и собеседника (relay размножает события на все устройства)."""
    rate = settings.ws_event_rate_per_sec
    burst = float(settings.ws_event_burst)
    elapsed = now - session.event_ts if session.event_ts else burst / rate
    session.event_tokens = min(burst, session.event_tokens + elapsed * rate)
    session.event_ts = now
    if session.event_tokens < 1.0:
        return False
    session.event_tokens -= 1.0
    return True


def _gc_session_locks() -> None:
    """BE-05: убрать незанятые локи устройств, у которых нет живой сессии."""
    for key in list(_session_locks.keys()):
        lock = _session_locks.get(key)
        if lock is None or lock.locked():
            continue
        number, device_id = key
        if device_id not in multi_sessions.get(number, {}):
            _session_locks.pop(key, None)


def _cleanup_expired_state(now: float | None = None) -> None:
    current = now or time.time()

    expired_pending = [number for number, otp in pending_otps.items() if otp.expires_at <= current]
    for number in expired_pending:
        pending_otps.pop(number, None)

    expired_tokens = [token for token, auth in auth_tokens.items() if auth.expires_at <= current]
    for token in expired_tokens:
        auth_tokens.pop(token, None)

    # Trim rate-limit buckets: drop entries whose sliding window has lapsed.
    # BE-05: все словари окон чистятся здесь и ограничены по числу ключей.
    _prune_rate_bucket(_verify_ip_hits, settings.verify_ip_rate_window_sec, current)
    _prune_rate_bucket(_send_ip_hits, settings.verify_ip_rate_window_sec, current)
    _prune_rate_bucket(_ice_ip_hits, 60, current)
    _prune_rate_bucket(_http_lookup_window, 60, current)
    _prune_rate_bucket(_msg_send_ip_hits, 60, current)
    _prune_rate_bucket(_msg_send_number_hits, 60, current)
    _prune_rate_bucket(_call_offer_hits, 60, current)
    _prune_rate_bucket(_p2p_offer_hits, 60, current)
    _prune_rate_bucket(_call_reneg_hits, 60, current)
    _prune_rate_bucket(_ws_content_hits, 60, current)
    _prune_rate_bucket(_profile_hits, 60, current)
    _prune_rate_bucket(_otp_global_hits, 3600, current)
    _prune_rate_bucket(_http_fallback_hits, 60, current)
    for n, seen in list(_call_id_seen.items()):
        for cid, ts in list(seen.items()):
            if current - ts >= _CALL_ID_TTL_SEC:
                seen.pop(cid, None)
        if not seen:
            _call_id_seen.pop(n, None)
    _cap_dict(_call_id_seen, _RATE_BUCKET_MAX_KEYS, lambda d: max(d.values(), default=0.0))
    for pair, ts in list(_call_pairs.items()):
        if current - ts >= _CALL_PAIR_TTL_SEC:
            _call_pairs.pop(pair, None)
    _cap_dict(_call_pairs, _RATE_BUCKET_MAX_KEYS, lambda ts: ts)
    for n, ts in list(_verify_number_next_ok.items()):
        if ts <= current:
            _verify_number_next_ok.pop(n, None)
    _cap_dict(_verify_number_next_ok, _RATE_BUCKET_MAX_KEYS, lambda ts: ts)
    _gc_session_locks()

    # Clean expired offline messages
    for target, queue in list(offline_queue.items()):
        while queue and queue[0].expires_at <= current:
            _offline_queue_release(queue.popleft())
        if not queue:
            offline_queue.pop(target, None)

    # B-06: Purge profiles/settings/pins for users inactive > INACTIVE_DATA_TTL_SEC
    cutoff = current - INACTIVE_DATA_TTL_SEC
    active_numbers = set(sessions.keys()) | set(multi_sessions.keys())

    # BE-15: registered_keys не растёт вечно — ключ номера, не появлявшегося
    # дольше REGISTERED_KEY_TTL_SEC, удаляется (TTL длинный: ключ нужен, чтобы
    # писать офлайн-собеседнику). Метка до чистки _last_seen ниже.
    for n, ts in _last_seen.items():
        if ts > _registered_key_seen.get(n, 0.0):
            _registered_key_seen[n] = ts
    for n in active_numbers:
        _registered_key_seen[n] = current
    key_cutoff = current - settings.registered_key_ttl_sec
    for n in list(registered_keys):
        if _registered_key_seen.setdefault(n, current) < key_cutoff and n not in active_numbers:
            registered_keys.pop(n, None)
            registered_capabilities.pop(n, None)
            registered_devices.pop(n, None)
    # mdev1: устройство, не появлявшееся дольше TTL, выпадает из реестра
    for n in list(registered_devices):
        devs = registered_devices[n]
        for d in [d for d, v in devs.items() if v.get("seen", 0) < key_cutoff]:
            devs.pop(d, None)
        if not devs:
            registered_devices.pop(n, None)
    for n in [n for n in _registered_key_seen if n not in registered_keys]:
        _registered_key_seen.pop(n, None)
    stale_numbers = [
        n for n, ts in _last_seen.items()
        if ts < cutoff and n not in active_numbers
    ]
    for n in stale_numbers:
        user_profiles.pop(n, None)
        _presence_hidden.discard(n)
        push_tokens.pop(n, None)
        _last_seen.pop(n, None)
        # Clean chat_settings for this user
        stale_keys = [k for k in chat_settings if k.startswith(f"{n}:")]
        for k in stale_keys:
            chat_settings.pop(k, None)
    # Clean pinned_messages for chats where both users are inactive
    for chat_key in list(pinned_messages):
        parts = chat_key.split(":")
        if len(parts) == 2 and all(
            p not in active_numbers and _last_seen.get(p, 0) < cutoff
            for p in parts
        ):
            pinned_messages.pop(chat_key, None)


def _drop_number_tokens(number: str) -> int:
    stale = [token for token, auth in auth_tokens.items() if auth.number == number]
    for token in stale:
        auth_tokens.pop(token, None)
    return len(stale)


JWT_AUDIENCE = "phantom-relay"


def _encode_jwt(number: str, issued_at: float, ttl_sec: int, device_id: str = "") -> str:
    """Produce a signed JWT (HS256) identifying the user.

    Signing prevents forgery even if the in-memory state is temporarily
    corrupted: every token carries sub/iat/exp/jti, and the server still
    cross-checks the presence of the token string in ``auth_tokens`` for
    revocation (after signature validation).
    """
    payload = {
        "sub": number,
        "iat": int(issued_at),
        "exp": int(issued_at) + int(ttl_sec),
        "jti": secrets.token_hex(8),
        "iss": settings.service_name,
        # BE-13: токен предназначен только relay'ю — не принимается сервисами
        # с тем же секретом, но другой аудиторией.
        "aud": JWT_AUDIENCE,
    }
    # BE-30: необязательный claim — старые токены без него остаются валидными.
    if device_id:
        payload["device_id"] = device_id
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def _decode_jwt(token: str) -> dict | None:
    if not token:
        return None
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            # BE-13: aud/iss не обязательны (токены, выпущенные до появления
            # aud, валидны до exp), но если присутствуют — сверяем вручную ниже.
            options={"require": ["exp", "sub", "iat"], "verify_aud": False, "verify_iss": False},
        )
    except (jwt.InvalidTokenError, jwt.ExpiredSignatureError):
        return None
    if "aud" in claims:
        aud = claims["aud"]
        audiences = aud if isinstance(aud, list) else [aud]
        if JWT_AUDIENCE not in audiences:
            return None
    if "iss" in claims and claims["iss"] != settings.service_name:
        return None
    return claims


def _issue_token(number: str) -> str:
    _drop_number_tokens(number)
    now = time.time()
    token = _encode_jwt(number, now, settings.auth_token_ttl_sec)
    auth_tokens[token] = AuthToken(number=number, expires_at=now + settings.auth_token_ttl_sec, issued_at=now)
    return token


def _mint_session_token(number: str, device_id: str, expires_at: float) -> str:
    """BE-30: выпустить JWT для конкретной сессии (claim ``device_id``).

    Срок жизни не продлевается — наследует ``expires_at`` прежнего токена.
    """
    now = time.time()
    ttl = max(int(expires_at - now), 60)
    token = _encode_jwt(number, now, ttl, device_id=device_id)
    auth_tokens[token] = AuthToken(number=number, expires_at=now + ttl, issued_at=now, device_id=device_id)
    return token


_UNBOUND_GRACE_SEC = 60.0
# AND-13: сколько живёт токен после token_rotated (переподключение после обрыва).
_ROTATION_GRACE_SEC = 300.0


def _session_claim(sess: ClientSession) -> str:
    """device_id для claim токена сессии: только если он стабилен (есть hint)."""
    return sess.device_id if sess.hinted else ""


def _retire_token(token: str, *, keep_if_used_by: ClientSession | None = None) -> None:
    """BE-30: вывести заменённый токен из оборота.

    Если им ещё пользуется другая живая сессия — не трогаем (его заменит
    ротация). Иначе срок урезается до _UNBOUND_GRACE_SEC: параллельные
    HTTP-запросы клиента со старым токеном успеют завершиться.
    """
    auth = auth_tokens.get(token)
    if auth is None:
        return
    for sess in multi_sessions.get(auth.number, {}).values():
        if sess is not keep_if_used_by and sess.auth_token == token:
            return
    auth.expires_at = min(auth.expires_at, time.time() + _UNBOUND_GRACE_SEC)


def _resolve_token(token: str) -> AuthToken | None:
    """Return the AuthToken bound to ``token`` if it's valid and not revoked.

    The token must pass BOTH checks:
      1. JWT signature + exp are valid (defence against forged tokens).
      2. The same string is present in ``auth_tokens`` (revocation list).
    """
    if not token:
        return None
    claims = _decode_jwt(token)
    if not claims:
        return None
    auth = auth_tokens.get(token)
    if not auth:
        return None
    if auth.expires_at <= time.time():
        auth_tokens.pop(token, None)
        return None
    # Defence in depth: ensure the signed subject matches the stored one.
    if str(claims.get("sub") or "") != auth.number:
        auth_tokens.pop(token, None)
        return None
    claim_device = str(claims.get("device_id") or "")
    if claim_device and claim_device != auth.device_id:
        auth_tokens.pop(token, None)
        return None
    return auth


async def _rotate_tokens() -> None:
    """Rotate auth tokens that have been active longer than rotation interval.
    Issues new token and notifies connected clients."""
    now = time.time()
    rotation_sec = settings.auth_token_rotation_sec
    if rotation_sec <= 0:
        return
    for old_token, auth in list(auth_tokens.items()):
        if now - auth.issued_at < rotation_sec:
            continue
        if auth.expires_at <= now:
            continue
        # Защита от гонки: за время предыдущих await токен могли отозвать
        # (revoke_session) или заменить.
        if auth_tokens.get(old_token) is not auth:
            continue
        number = auth.number
        # BE-30: новый токен получают только сессии, которые пользуются
        # старым, плюс «осиротевшие» сессии номера (их токен уже удалён,
        # например повторным входом на другом устройстве) — каждая СВОЙ,
        # с claim своего device_id. Общий токен на несколько сессий сделал
        # бы revoke_session одного устройства бессмысленным. Нет получателей —
        # не ротируем, токен доживает до exp (офлайн-владелец не теряет его).
        recipients = [
            s for s in multi_sessions.get(number, {}).values()
            if s.auth_token == old_token or s.auth_token not in auth_tokens
        ]
        if not recipients:
            continue
        # AND-13: не удаляем сразу — grace-окно; повторной ротации не будет
        # (сессий со старым токеном не останется, а переподключившаяся с ним
        # получит новый на следующем проходе).
        auth.rotated_at = now
        auth.expires_at = min(auth.expires_at, now + _ROTATION_GRACE_SEC)
        for target in recipients:
            target.auth_token = _mint_session_token(number, _session_claim(target), auth.expires_at)
        for target in recipients:
            await _safe_send(target, {"type": "token_rotated", "token": target.auth_token})


async def _safe_send(session: ClientSession | None, payload: dict[str, Any]) -> bool:
    """Send a payload to a session. Returns True on success, False on failure."""
    if not session:
        return False
    try:
        log.debug("relay: %s >> %s", _hash_pii(session.number), payload.get("type", "?"))
        await session.ws.send_json(payload)
        return True
    except Exception as exc:
        log.warning("relay: %s >> SEND FAILED: %s", _hash_pii(session.number), exc)
        return False


async def _safe_close(ws: WebSocket, code: int, reason: str = "") -> None:
    """Закрыть WebSocket, не падая, если клиент уже отключился.

    Starlette бросает WebSocketDisconnect/RuntimeError при close() на мёртвом
    сокете — без обёртки это превращается в трейсбек в логах.
    """
    try:
        await ws.close(code=code, reason=reason)
    except Exception:
        pass


def _presence_visible(number: str) -> bool:
    """WEB-11: «в сети» показываем собеседникам, только если номер не скрыл статус.
    На доставку не влияет — только на lookup_result.online и peer_online/offline."""
    return number not in _presence_hidden and _is_user_online(number)


def _is_user_online(number: str) -> bool:
    """Check if user has ANY active device connected."""
    if sessions.get(number):
        return True
    return bool(multi_sessions.get(number))


def _normalize_capabilities(raw: Any) -> list[str]:
    """P9: capabilities от клиента -> до 8 уникальных строк по <=16 символов.

    Неизвестные значения допускаются (прямая совместимость), мусор отбрасывается.
    Отсутствие/неверный тип поля = [] (старый клиент).
    """
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not item or len(item) > 16 or item in out:
            continue
        out.append(item)
        if len(out) >= 8:
            break
    return out


def _lookup_public_key(target: str) -> str | None:
    """P10: ключ для lookup — сохранённый ключ primary, затем ключ primary-сессии.

    Ключ произвольного (не primary) устройства не отдаём: primary его не расшифрует.
    """
    stored = registered_keys.get(target)
    if stored:
        return stored
    primary = sessions.get(target)
    return primary.public_key if primary and primary.public_key else None


def _register_device(number: str, session: ClientSession) -> None:
    """mdev1: запомнить ключ устройства (только стабильный device hint), не больше
    MAX_DEVICES_PER_NUMBER на номер — лишние вытесняются по давности."""
    if not session.hinted or not session.public_key or not _DEVICE_ID_RE.match(session.device_id):
        return
    devices = registered_devices.setdefault(number, {})
    devices[session.device_id] = {
        "key": session.public_key,
        "caps": list(session.capabilities),
        "seen": int(time.time()),
    }
    while len(devices) > MAX_DEVICES_PER_NUMBER:
        devices.pop(min(devices, key=lambda d: devices[d].get("seen", 0)), None)


def _lookup_devices(target: str) -> list[dict[str, Any]]:
    """mdev1: устройства номера для lookup_result (свежие первыми)."""
    devices = registered_devices.get(target) or {}
    ordered = sorted(devices.items(), key=lambda kv: kv[1].get("seen", 0), reverse=True)
    return [
        {"deviceId": dev, "publicKey": info.get("key", ""), "capabilities": list(info.get("caps", []))}
        for dev, info in ordered[:MAX_DEVICES_PER_NUMBER]
        if info.get("key")
    ]


def _sanitize_device_blobs(raw: Any) -> dict[str, Any] | None | str:
    """mdev1: ``deviceBlobs`` — {device_id: EncryptedBlob}, не больше MAX_DEVICES_PER_NUMBER,
    каждый blob под кап MESSAGE_MAX_BLOB_BYTES. None — поля нет/пусто; "too_large" — превышение."""
    if not isinstance(raw, dict) or not raw:
        return None
    out: dict[str, Any] = {}
    for dev, blob in list(raw.items())[:MAX_DEVICES_PER_NUMBER]:
        if not isinstance(dev, str) or not _DEVICE_ID_RE.match(dev) or not isinstance(blob, dict):
            continue
        if _blob_too_large(blob):
            return "too_large"
        if "iv" in blob and "nonce" not in blob:
            blob["nonce"] = blob["iv"]
        elif "nonce" in blob and "iv" not in blob:
            blob["iv"] = blob["nonce"]
        out[dev] = blob
    return out or None


def _payload_for_device(payload: dict[str, Any], device_blobs: dict[str, Any] | None, device_id: str) -> dict[str, Any]:
    """mdev1: устройству — его собственная копия encryptedBlob; чужие копии не уходят никому."""
    if device_blobs and device_id in device_blobs:
        return {**payload, "encryptedBlob": device_blobs[device_id]}
    return payload


def _sync_registered_from_primary(number: str, new_primary: ClientSession) -> None:
    """P10: после промоута нового primary registered_keys/capabilities — его."""
    if new_primary.public_key:
        registered_keys[number] = new_primary.public_key
        registered_capabilities[number] = list(new_primary.capabilities)


def _get_any_session(number: str) -> ClientSession | None:
    """Get any active session for a user (primary preferred)."""
    primary = sessions.get(number)
    if primary:
        return primary
    device_sessions = multi_sessions.get(number, {})
    if device_sessions:
        return next(iter(device_sessions.values()))
    return None


async def _send_to_all_devices(
    number: str,
    payload: dict[str, Any],
    skip_device: str | None = None,
    device_blobs: dict[str, Any] | None = None,
) -> bool:
    """Send a message to ALL devices of a user (multi-device support).
    mdev1: при ``device_blobs`` каждое устройство получает свою копию encryptedBlob.
    Returns True if at least one send succeeded."""
    any_ok = False
    device_sessions = multi_sessions.get(number, {})
    for device_id, session in list(device_sessions.items()):
        if skip_device and device_id == skip_device:
            continue
        if await _safe_send(session, _payload_for_device(payload, device_blobs, device_id)):
            any_ok = True
    # Fallback: also send to primary session if not in multi_sessions
    primary = sessions.get(number)
    if primary and primary.device_id not in device_sessions:
        if skip_device != primary.device_id:
            if await _safe_send(primary, _payload_for_device(payload, device_blobs, primary.device_id)):
                any_ok = True
    return any_ok


def _chat_key(a: str, b: str) -> str:
    return ":".join(sorted([a, b]))


def _estimate_payload_bytes(payload: dict[str, Any]) -> int:
    """Approximate memory footprint of a payload for quota accounting."""
    try:
        return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        return 0


def _enqueue_offline(
    from_number: str, to_number: str, payload: dict[str, Any], device_blobs: dict[str, Any] | None = None,
) -> bool | str:
    """Queue a message for an offline user.

    Returns True if queued, or a string reason on rejection:
    ``"overflow"`` (per-user cap hit), ``"payload_too_large"`` (single-message
    cap hit), ``"global_overflow"`` (server-wide budget exhausted).
    """
    global _offline_queue_total_bytes
    now = time.time()
    size_bytes = _estimate_payload_bytes(payload) + (_estimate_payload_bytes(device_blobs) if device_blobs else 0)
    if size_bytes > settings.offline_queue_max_payload_bytes * (1 + len(device_blobs or {})):
        return "payload_too_large"
    queue = offline_queue.setdefault(to_number, deque())
    if len(queue) >= settings.offline_queue_max_per_user:
        return "overflow"
    if _offline_queue_total_bytes + size_bytes > settings.offline_queue_max_global_bytes:
        return "global_overflow"
    # Server-authoritative message id — 128-bit entropy eliminates the
    # birthday collision risk of a 64-bit client-supplied value and stops
    # the sender from deliberately colliding on someone else's id.
    msg_id = secrets.token_hex(16)
    queue.append(OfflineMessage(
        msg_id=msg_id,
        from_number=from_number,
        to_number=to_number,
        payload=payload,
        created_at=now,
        expires_at=now + settings.offline_queue_ttl_sec,
        size_bytes=size_bytes,
        device_blobs=device_blobs,
    ))
    _offline_queue_total_bytes += size_bytes
    # Trigger push notification for offline user
    _spawn_tracked(
        _send_push_notification(from_number, to_number, payload),
        label="push",
    )
    return True


def _offline_queue_release(msg: OfflineMessage) -> None:
    """Decrement the global byte counter when ``msg`` leaves the queue."""
    global _offline_queue_total_bytes
    _offline_queue_total_bytes = max(0, _offline_queue_total_bytes - (msg.size_bytes or 0))


# Strong references to fire-and-forget background tasks so that the
# event loop does not garbage-collect them mid-flight (asyncio only
# holds weak refs to create_task results) — and so that a stray
# exception surfaces via add_done_callback instead of vanishing.
_background_tasks: set[asyncio.Task[Any]] = set()


def _spawn_tracked(coro: Any, *, label: str) -> asyncio.Task[Any]:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)

    def _done(t: asyncio.Task[Any]) -> None:
        _background_tasks.discard(t)
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            log.error("%s: background task crashed: %r", label, exc, exc_info=exc)

    task.add_done_callback(_done)
    return task


def _load_apns_auth_key() -> bytes | str | None:
    """Load the APNs ES256 private key.

    Preferred source is ``APNS_AUTH_KEY_PATH`` — the .p8 file on disk with
    mode 0400. Keeping the key out of ``.env`` avoids it leaking into git
    history, ``docker inspect``, systemd ``EnvironmentFile`` world-readable
    copies, and host backup snapshots.

    ``APNS_AUTH_KEY`` is retained as a deprecated fallback (base64 or PEM)
    so that existing deployments keep working until they migrate. A warning
    is logged once per process to nudge operators.
    """
    import base64

    key_path = os.environ.get("APNS_AUTH_KEY_PATH", "").strip()
    if key_path:
        try:
            p = Path(key_path)
            if not p.is_file():
                log.warning("push: APNS_AUTH_KEY_PATH does not exist: %s", key_path)
                return None
            # Refuse world-readable keys — fail closed rather than silently
            # keeping a secret file readable to every user on the host.
            try:
                mode = p.stat().st_mode & 0o777
                if mode & 0o077:
                    log.warning(
                        "push: APNs key %s has overly permissive mode %o "
                        "(expected 0400/0600). Refusing to use it.",
                        key_path, mode,
                    )
                    return None
            except OSError:
                pass
            return p.read_bytes()
        except OSError as exc:
            log.warning("push: failed to read APNs key from %s: %s", key_path, exc)
            return None

    auth_key_b64 = os.environ.get("APNS_AUTH_KEY", "")
    if not auth_key_b64:
        return None
    if not getattr(_load_apns_auth_key, "_warned_env_key", False):
        log.warning(
            "push: APNS_AUTH_KEY is being loaded from an environment variable "
            "— this is insecure and deprecated. Migrate to APNS_AUTH_KEY_PATH "
            "(chmod 0400) as soon as possible."
        )
        setattr(_load_apns_auth_key, "_warned_env_key", True)
    if "BEGIN" in auth_key_b64:
        return auth_key_b64
    try:
        return base64.b64decode(auth_key_b64)
    except Exception as exc:
        log.warning("push: APNs key base64 decode failed: %s", exc)
        return None


def _generate_apns_jwt() -> str | None:
    """Generate a JWT token for APNs HTTP/2 authentication using ES256."""
    key_id = os.environ.get("APNS_KEY_ID", "")
    team_id = os.environ.get("APNS_TEAM_ID", "")
    if not key_id or not team_id:
        return None
    auth_key = _load_apns_auth_key()
    if not auth_key:
        return None

    try:
        import jwt as pyjwt
        now = int(time.time())
        token = pyjwt.encode(
            {"iss": team_id, "iat": now},
            auth_key,
            algorithm="ES256",
            headers={"kid": key_id},
        )
        return token
    except ImportError:
        log.warning("push: PyJWT not installed, APNs push disabled")
        return None
    except Exception as exc:
        log.warning("push: APNs JWT generation failed: %s", exc)
        return None


_apns_jwt_cache: dict[str, Any] = {"token": None, "generated_at": 0.0}


def _get_apns_jwt() -> str | None:
    """Get cached APNs JWT (regenerate every 50 minutes)."""
    now = time.time()
    if _apns_jwt_cache["token"] and now - _apns_jwt_cache["generated_at"] < 3000:
        return _apns_jwt_cache["token"]
    token = _generate_apns_jwt()
    if token:
        _apns_jwt_cache["token"] = token
        _apns_jwt_cache["generated_at"] = now
    return token


async def _send_push_notification(from_number: str, to_number: str, payload: dict[str, Any]) -> None:
    """Send push notification via FCM/APNs when user is offline.

    Wrapped in a broad try/except: this coroutine is spawned as a fire-and-
    forget task, so a silent exception (httpx error, unicode issue, token
    decrypt failure) would otherwise vanish. We log and swallow — the push
    is best-effort, never blocks the caller.
    """
    try:
        await _send_push_notification_impl(from_number, to_number, payload)
    except Exception:
        log.exception(
            "push: uncaught exception while dispatching to %s (from %s)",
            _hash_pii(to_number), _hash_pii(from_number),
        )


async def _send_push_notification_impl(from_number: str, to_number: str, payload: dict[str, Any]) -> None:
    tokens = push_tokens.get(to_number, {})
    if not tokens:
        return

    # Deduplication: skip devices that have an active WS session
    active_devices = set()
    device_sessions = multi_sessions.get(to_number, {})
    for dev_id in device_sessions:
        active_devices.add(dev_id)

    msg_type = payload.get("type", "message")
    message_id = payload.get("messageId", "") or ""

    # Минимизация push-метаданных (sec.md §7.5):
    # FCM/APNs инфраструктура (Google/Apple) НЕ должна видеть, кто кому пишет.
    # Поэтому payload не содержит ни fromNumber, ни text/body. Только тип
    # уведомления и opaque messageId — клиент через защищённый WS подгружает
    # реального отправителя и зашифрованный blob.
    #
    # Notification (видимая часть) — generic: "Новое сообщение".
    # Это значит, что:
    #  - на lock screen ничего конфиденциального не светится;
    #  - человек рядом, посмотрев экран, не узнаёт ни sender'а, ни preview;
    #  - между несколькими push'ами от разных людей нет различий в payload.
    title = "Phantom Messenger"
    body = (
        "Входящий звонок" if msg_type in ("call_incoming", "call") else
        "Новое голосовое сообщение" if msg_type == "voice_message" else
        "Новый файл" if msg_type == "file_message" else
        "Системное уведомление" if msg_type == "system" else
        "Новое сообщение"
    )

    # MESH-22: mesh_wakeup — только фоновое пробуждение радио, без видимого
    # уведомления (APNs background + content-available, FCM data-only).
    silent = msg_type == "mesh_wakeup"

    fcm_key = os.environ.get("GOOGLE_FCM_SERVER_KEY", "")
    # collapse-ключ привязан к получателю + типу, а не к sender'у.
    # Иначе сам collapse_key (виден инфраструктуре FCM) служил бы метаданным.
    collapse_key = f"phantom_{msg_type}"
    bundle_id = os.environ.get("APNS_BUNDLE_ID", "com.phantom.messenger")

    for device_id, token_info in tokens.items():
        # Skip devices with active WS connection
        if device_id in active_devices:
            log.debug("push: skip %s device=%s (active WS)", _hash_pii(to_number), device_id)
            continue

        stored = token_info.get("token", "") if isinstance(token_info, dict) else str(token_info)
        platform = token_info.get("platform", "android") if isinstance(token_info, dict) else "android"
        # Decrypt only at the last moment; `token` goes out of scope as soon
        # as the HTTP POST finishes, so it's never long-lived in RAM.
        token = _decrypt_push_token(stored)

        if not token:
            continue

        client = _push_client
        if not client:
            log.warning("push: client not initialized, skip")
            return

        if platform == "ios":
            # ── APNs HTTP/2 push ──
            apns_jwt = _get_apns_jwt()
            if not apns_jwt:
                log.debug("push: APNs not configured, skip iOS device=%s", device_id)  # device_id OK — not PII
                continue
            apns_host = os.environ.get("APNS_HOST", "https://api.push.apple.com")
            if silent:
                apns_headers = {
                    "authorization": f"bearer {apns_jwt}",
                    "apns-topic": bundle_id,
                    "apns-push-type": "background",
                    "apns-priority": "5",
                }
                aps: dict[str, Any] = {"content-available": 1}
            else:
                apns_headers = {
                    "authorization": f"bearer {apns_jwt}",
                    "apns-topic": bundle_id,
                    "apns-push-type": "alert",
                    "apns-priority": "10",
                    "apns-collapse-id": collapse_key,
                }
                aps = {
                    "alert": {"title": title, "body": body},
                    "sound": "default",
                    "badge": 1,
                    "mutable-content": 1,
                }
            try:
                resp = await client.post(
                    f"{apns_host}/3/device/{token}",
                    headers=apns_headers,
                    json={
                        "aps": aps,
                        # Никаких fromNumber/text. Клиент пойдёт за деталями
                        # через WS, используя messageId как идемпотентный
                        # идентификатор.
                        "type": msg_type,
                        "messageId": message_id,
                    },
                )
                if resp.status_code == 200:
                    log.info("push: APNs sent to %s device=%s", _hash_pii(to_number), device_id)
                else:
                    log.warning("push: APNs error %d for %s: %s", resp.status_code, _hash_pii(to_number), resp.text[:200])
            except Exception as exc:
                log.warning("push: APNs failed for %s device=%s: %s", _hash_pii(to_number), device_id, exc)
        else:
            # ── FCM push ──
            if not fcm_key:
                log.debug("push: no FCM server key, skip android device=%s", device_id)
                continue
            fcm_body: dict[str, Any] = {
                "to": token,
                "collapse_key": collapse_key,
                "data": {
                    # Только тип и messageId. fromNumber отдаётся ТОЛЬКО
                    # через защищённый WS-канал (push используется
                    # лишь чтобы разбудить клиента).
                    "type": msg_type,
                    "messageId": message_id,
                },
                "priority": "high",
            }
            if not silent:
                # MESH-22: у data-only сообщения onMessageReceived вызывается и в фоне;
                # блок notification нужен только видимым уведомлениям.
                fcm_body["notification"] = {
                    "title": title,
                    "body": body,
                    "sound": "default",
                    "tag": collapse_key,
                }
            try:
                resp = await client.post(
                    "https://fcm.googleapis.com/fcm/send",
                    headers={
                        "Authorization": f"key={fcm_key}",
                        "Content-Type": "application/json",
                    },
                    json=fcm_body,
                )
                if resp.status_code == 200:
                    log.info("push: FCM sent to %s device=%s", _hash_pii(to_number), device_id)
                else:
                    log.warning("push: FCM error %d for %s", resp.status_code, _hash_pii(to_number))
            except Exception as exc:
                log.warning("push: FCM failed for %s device=%s: %s", _hash_pii(to_number), device_id, exc)


# ── Persistence: save durable state to JSON, keep volatile state in RAM ──

_PERSIST_INTERVAL = 60  # seconds between auto-saves
_persist_counter = 0

# PROD-12: формат зашифрованного state.json — магическая строка + Fernet-токен.
_STATE_MAGIC = b"PMSTATE1\n"
_state_fernet: Any = None


def _get_state_fernet() -> Any:
    """Fernet для state.json или ``None``, если STATE_ENCRYPTION_KEY не задан.

    Валидность ключа проверена в config.py при импорте (иначе процесс не стартует).
    """
    global _state_fernet
    if not settings.state_encryption_key:
        return None
    if _state_fernet is None:
        from cryptography.fernet import Fernet

        _state_fernet = Fernet(settings.state_encryption_key.encode("utf-8"))
    return _state_fernet


def _quarantine_state_file(path: Path, reason: str) -> None:
    """Битый/нерасшифровываемый state.json не затираем следующим сохранением —
    переименовываем в ``<name>.corrupt.<ts>`` для ручного разбора."""
    target = path.with_name(f"{path.name}.corrupt.{int(time.time())}")
    try:
        os.replace(path, target)
        log.warning("persistence: %s — moved state file to %s, starting with empty state", reason, target.name)
    except OSError as exc:
        log.warning("persistence: %s — could not move state file aside (%s), starting with empty state", reason, exc)


# BE-22: _save_state зовётся из cleanup (to_thread), mesh_revoke и shutdown —
# запись в общий state.tmp сериализуем, чтобы два вызова не перемешали байты.
_STATE_SAVE_LOCK = threading.Lock()


def _save_state() -> None:
    with _STATE_SAVE_LOCK:
        _save_state_unlocked()


def _save_state_unlocked() -> None:
    """Atomically save persistent domain state to disk with restrictive perms.

    The state file contains (encrypted) push tokens, user profiles, and
    public keys — all owner-only. We open the temp file via ``os.open``
    with ``O_CREAT|O_WRONLY|O_TRUNC|O_NOFOLLOW`` and mode 0600 so that:

    * Other users on the host cannot read the blob.
    * A symlink at the target path cannot trick us into writing into
      somebody else's file (the OS refuses to follow it).
    """
    path = Path(settings.persistence_file)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(path.parent, 0o700)
        except PermissionError:
            # Running as non-owner — skip; operator is responsible.
            pass
        # S10.6 / X-06: на диск идут только ключи, capabilities, push-токены и mesh;
        # профили, настройки чатов и пины — только RAM. blocked_users — под флагом.
        data: dict[str, Any] = {
            "registered_keys": registered_keys,
            "registered_capabilities": registered_capabilities,
            "registered_keys_seen": {k: int(v) for k, v in _registered_key_seen.items()},
            "registered_devices": registered_devices,  # mdev1: только публичные ключи устройств
            "push_tokens": push_tokens,
            "mesh_identities": _mesh.dump_state(),
            "mesh_revocations": _mesh.dump_revocation_state(),
            "mesh_bridge_gen": _mesh.dump_bridge_gen(),
        }
        if settings.persist_blocked_users:
            data["blocked_users"] = {k: sorted(v) for k, v in blocked_users.items() if v}
        serialised = json.dumps(data, ensure_ascii=False).encode("utf-8")
        fernet = _get_state_fernet()
        if fernet is not None:
            serialised = _STATE_MAGIC + fernet.encrypt(serialised)
        tmp = path.with_suffix(".tmp")
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        # O_NOFOLLOW is POSIX; Windows doesn't support it — harmless best-effort.
        flags |= getattr(os, "O_NOFOLLOW", 0)
        # If a stale .tmp with the wrong owner exists, unlink first so that
        # O_CREAT produces a fresh file with our mode.
        if tmp.exists() and not tmp.is_symlink():
            try:
                tmp.unlink()
            except OSError:
                pass
        fd = os.open(str(tmp), flags, 0o600)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(serialised)
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
        tmp.replace(path)
        try:
            os.chmod(path, 0o600)
        except PermissionError:
            pass
        log.debug("persistence: state saved to %s", path)
    except Exception as exc:
        log.warning("persistence: save failed: %s", exc)


def _load_state() -> None:
    """Restore persistent state from disk on startup."""
    path = Path(settings.persistence_file)
    if not path.exists():
        log.info("persistence: no state file, starting fresh")
        return
    # PROD-12: файл бывает двух форматов — старый plain JSON и
    # ``PMSTATE1\n<fernet token>``. Ошибка расшифровки/разбора → карантин файла.
    try:
        raw = path.read_bytes()
    except OSError as exc:
        log.warning("persistence: load failed: %s", exc)
        return
    fernet = _get_state_fernet()
    was_plain = not raw.startswith(_STATE_MAGIC)
    try:
        if not was_plain:
            if fernet is None:
                _quarantine_state_file(path, "state file is encrypted but STATE_ENCRYPTION_KEY is not set")
                return
            from cryptography.fernet import InvalidToken

            try:
                raw = fernet.decrypt(raw[len(_STATE_MAGIC):].strip())
            except InvalidToken:
                _quarantine_state_file(path, "state file decryption failed (wrong STATE_ENCRYPTION_KEY or corrupted)")
                return
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("top-level JSON is not an object")
    except (ValueError, UnicodeDecodeError) as exc:
        _quarantine_state_file(path, f"state file is corrupted ({type(exc).__name__})")
        return
    try:
        # S10.6 / X-06: user_profiles, chat_settings, pinned_messages — только RAM;
        # в старом state.json они игнорируются и исчезают при пересохранении.
        if settings.persist_blocked_users:
            for k, v in data.get("blocked_users", {}).items():
                blocked_users[k] = set(v)
        registered_keys.update(data.get("registered_keys", {}))
        for _n, _caps in (data.get("registered_capabilities") or {}).items():
            registered_capabilities[_n] = _normalize_capabilities(_caps)
        for _n, _devs in (data.get("registered_devices") or {}).items():
            if isinstance(_devs, dict):
                registered_devices[_n] = {
                    d: {"key": str(v.get("key", "")), "caps": _normalize_capabilities(v.get("caps")), "seen": int(v.get("seen", 0))}
                    for d, v in list(_devs.items())[:MAX_DEVICES_PER_NUMBER]
                    if isinstance(v, dict) and _DEVICE_ID_RE.match(str(d)) and _sanitize_public_key(v.get("key"))
                }
        for _n, _ts in (data.get("registered_keys_seen") or {}).items():
            try:
                _registered_key_seen[_n] = float(_ts)
            except (TypeError, ValueError):
                pass
        push_tokens.update(data.get("push_tokens", {}))
        _mesh.load_state(data.get("mesh_identities", {}))
        _mesh.load_revocation_state(data.get("mesh_revocations", {}))
        _mesh.load_bridge_gen(data.get("mesh_bridge_gen", {}))
        log.info("persistence: restored state (%d keys, %d blocked)", len(registered_keys), len(blocked_users))
    except Exception as exc:
        log.warning("persistence: load failed: %s", exc)
        return
    # Лишние ключи старого формата (RAM-only данные, блок-листы при выключенном флаге)
    # — пересохраняем файл, чтобы они исчезли с диска.
    stale_keys = {"user_profiles", "chat_settings", "pinned_messages"}
    if not settings.persist_blocked_users:
        stale_keys.add("blocked_users")
    had_stale = any(k in data for k in stale_keys)
    if had_stale:
        log.info("persistence: dropping RAM-only keys from state file, rewriting")
    if was_plain and fernet is not None:
        log.info("persistence: migrating plain state file to encrypted format")
    if had_stale or (was_plain and fernet is not None):
        _save_state()


OFFLINE_RETRY_SEC = 30.0  # Retry unacknowledged offline messages after this delay


async def _deliver_offline_queue(number: str) -> None:
    """Deliver queued messages when a user comes online.

    Messages are NOT removed from the queue here. Each message is marked with
    ``delivery_attempted_at`` and sent to the client.  The client must respond
    with an ``ack_offline`` event for every message; only then is that message
    removed (see the ``ack_offline`` handler).  Un-acked messages are retried
    by ``_cleanup_loop`` after ``OFFLINE_RETRY_SEC`` and eventually dropped
    once the TTL expires.
    """
    queue = offline_queue.get(number)
    if not queue:
        return
    session = sessions.get(number)
    if not session:
        return
    now = time.time()
    for msg in queue:
        if msg.expires_at <= now:
            continue
        msg.delivery_attempted_at = now
        delivery_payload = {**_payload_for_device(msg.payload, msg.device_blobs, session.device_id), "_offlineMsgId": msg.msg_id}
        await _safe_send(session, delivery_payload)


_cleanup_last_tick: float = 0.0
_CLEANUP_STALE_THRESHOLD_SEC = 30.0


async def _cleanup_loop() -> None:
    global _persist_counter, _cleanup_last_tick
    _rotation_counter = 0
    while True:
        _cleanup_last_tick = time.monotonic()
        _cleanup_expired_state()
        _mesh.cleanup_expired()
        # Retry delivery of unacknowledged offline messages
        await _retry_unacked_offline()
        # Rotate auth tokens (check every ~30s)
        _rotation_counter += 3
        if _rotation_counter >= 30:
            _rotation_counter = 0
            await _rotate_tokens()
        # Periodic state persistence (every ~60s at 3s tick)
        _persist_counter += 3
        if _persist_counter >= _PERSIST_INTERVAL:
            _persist_counter = 0
            await asyncio.to_thread(_save_state)
        await asyncio.sleep(3)


async def _cleanup_watchdog() -> None:
    """Ensure the cleanup/rotation loop is making forward progress.

    If _cleanup_last_tick doesn't advance for ``_CLEANUP_STALE_THRESHOLD_SEC``
    we log a CRITICAL and relaunch the task. A hung cleanup freezes token
    rotation and offline-queue eviction — worse than a crash that systemd
    would otherwise restart.
    """
    global cleanup_task
    while True:
        await asyncio.sleep(_CLEANUP_STALE_THRESHOLD_SEC)
        task = cleanup_task
        if task is None:
            continue
        now = time.monotonic()
        last = _cleanup_last_tick
        stale = last > 0 and (now - last) > _CLEANUP_STALE_THRESHOLD_SEC * 2
        if task.done() or stale:
            log.critical(
                "cleanup_loop watchdog: stale=%s done=%s elapsed=%.1fs — relaunching",
                stale, task.done(), (now - last) if last else -1.0,
            )
            if not task.done():
                task.cancel()
                try:
                    await task
                except BaseException:  # noqa: BLE001 — we must not re-raise here
                    pass
            cleanup_task = asyncio.create_task(_cleanup_loop())


async def _retry_unacked_offline() -> None:
    """Re-send offline messages whose delivery was attempted but not acked."""
    now = time.time()
    for target_number, queue in list(offline_queue.items()):
        session = sessions.get(target_number)
        if not session:
            continue
        for msg in queue:
            if msg.expires_at <= now:
                continue  # will be cleaned by _cleanup_expired_state
            if msg.delivery_attempted_at is None:
                continue  # never attempted yet — not our concern here
            if now - msg.delivery_attempted_at >= OFFLINE_RETRY_SEC:
                msg.delivery_attempted_at = now
                delivery_payload = {**_payload_for_device(msg.payload, msg.device_blobs, session.device_id), "_offlineMsgId": msg.msg_id}
                await _safe_send(session, delivery_payload)


@app.on_event("startup")
async def _startup() -> None:
    global cleanup_task, cleanup_watchdog_task, _push_client
    for warning in STARTUP_WARNINGS:
        log.warning("config: %s", warning)
    if settings.turn_urls and not settings.turn_static_auth_secret:
        log.warning(
            "config: TURN_URLS is set but TURN_STATIC_AUTH_SECRET is not — no TURN "
            "credentials will be issued and relayed calls will fail"
        )
    _load_state()
    cleanup_task = asyncio.create_task(_cleanup_loop())
    cleanup_watchdog_task = asyncio.create_task(_cleanup_watchdog())
    _push_client = httpx.AsyncClient(http2=True, timeout=15, limits=httpx.Limits(max_connections=20, max_keepalive_connections=10))


@app.on_event("shutdown")
async def _shutdown() -> None:
    global cleanup_task, cleanup_watchdog_task, _push_client
    for attr in ("cleanup_watchdog_task", "cleanup_task"):
        task = globals().get(attr)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            globals()[attr] = None
    if _push_client:
        await _push_client.aclose()
        _push_client = None
    _save_state()


# Заголовки, которые выставляет любой прокси/CDN. Если хоть один есть —
# запрос пришёл не напрямую с loopback, а через прокси.
_FORWARDING_HEADERS = ("forwarded", "x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip")


def _is_direct_loopback(request: Request) -> bool:
    """PROD-06: запрос пришёл напрямую с loopback (status.sh / setup.sh).

    Смотрим на СЫРОЙ адрес TCP-пира, а не на ``_client_ip``; плюс требуем
    отсутствия forwarding-заголовков — на случай, если перед relay когда-нибудь
    встанет локальный reverse-proxy, у которого пир всегда 127.0.0.1.
    """
    client = request.client
    peer = _parse_ip(client.host if client else "")
    if peer is None or not ipaddress.ip_address(peer).is_loopback:
        return False
    if settings.client_ip_header and request.headers.get(settings.client_ip_header.lower()):
        return False
    return not any(request.headers.get(h) for h in _FORWARDING_HEADERS)


@app.get("/api/health")
async def api_health(request: Request) -> dict[str, Any]:
    # PROD-06: публично — только признак жизни; счётчики и внутренняя
    # топология — лишь для прямого локального запроса.
    if not _is_direct_loopback(request):
        return {"ok": True, "timestamp": int(time.time())}
    return {
        "ok": True,
        "relaySessions": len(sessions),
        "offlineQueued": sum(len(q) for q in offline_queue.values()),
        "offlineQueuedBytes": _offline_queue_total_bytes,
        "offlineQueueMaxGlobalBytes": settings.offline_queue_max_global_bytes,
        "numbersApiBase": settings.numbers_api_base,
        "mesh": {
            "enabled": _mesh.is_enabled(),
            "identities": len(_mesh.mesh_identities),
            "revocations": len(_mesh.mesh_revocations),
        },
        "timestamp": int(time.time()),
    }


_DEBUG_LOOPBACK_IPS = {"127.0.0.1", "::1"}


def _debug_authorized(request: Request) -> tuple[bool, int]:
    """Gate debug endpoints by (1) loopback-only peer IP, (2) bearer token.

    Returns ``(authorised, status_code)``. ``status_code`` is meaningful only
    on rejection — callers may surface it unchanged.
    """
    if not settings.enable_debug_endpoints:
        return False, 404
    client = request.client
    peer = client.host if client else ""
    # Normalise IPv6-mapped IPv4 (e.g. "::ffff:127.0.0.1")
    if peer.startswith("::ffff:"):
        peer = peer[7:]
    if peer not in _DEBUG_LOOPBACK_IPS:
        log.warning("debug: rejected non-loopback request")
        return False, 404
    expected_token = os.environ.get("DEBUG_AUTH_TOKEN", "").strip()
    if not expected_token:
        # Misconfiguration — endpoints enabled but no token set, treat as off.
        return False, 404
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return False, 401
    provided = header[7:].strip()
    if not secrets.compare_digest(provided, expected_token):
        return False, 401
    return True, 200


@app.get("/api/debug/sessions")
async def api_debug_sessions(request: Request) -> dict[str, Any]:
    """Debug: list all active relay sessions and their state."""
    ok, status = _debug_authorized(request)
    if not ok:
        reason = "disabled" if status == 404 else "unauthorized"
        return JSONResponse({"ok": False, "reason": reason}, status_code=status)
    return {
        "ok": True,
        "sessions": {
            number: {
                "hasPublicKey": bool(s.public_key),
                "publicKeyPrefix": s.public_key[:12] + "..." if s.public_key else None,
                "connectedAt": int(s.connected_at),
                "agoSec": int(time.time() - s.connected_at),
            }
            for number, s in sessions.items()
        },
        "registeredKeys": {
            number: key[:12] + "..."
            for number, key in registered_keys.items()
        },
        "authTokens": len(auth_tokens),
        "timestamp": int(time.time()),
    }


_ALLOWED_ICE_SCHEMES: tuple[str, ...] = ("stun:", "stuns:", "turn:", "turns:")


def _sanitise_ice_servers(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop anything that isn't a well-formed STUN/TURN server entry.

    Misconfigurations or a compromised config source could otherwise push
    the browser's RTCPeerConnection into exotic URL schemes (data:, file:,
    http:) — some of which crash the RTC stack, some of which would let an
    attacker with config write-access coerce the client into exfiltration.
    We keep only canonical STUN/TURN URLs and strip every other field.
    """
    clean: list[dict[str, Any]] = []
    for entry in raw or []:
        if not isinstance(entry, dict):
            continue
        urls_raw = entry.get("urls") or entry.get("url")
        urls = urls_raw if isinstance(urls_raw, list) else [urls_raw]
        filtered: list[str] = []
        for u in urls:
            if not isinstance(u, str):
                continue
            low = u.lower().strip()
            if low.startswith(_ALLOWED_ICE_SCHEMES):
                filtered.append(u.strip())
        if not filtered:
            continue
        out: dict[str, Any] = {"urls": filtered}
        # Carry TURN credentials verbatim if they are simple strings.
        if isinstance(entry.get("username"), str):
            out["username"] = entry["username"]
        if isinstance(entry.get("credential"), str):
            out["credential"] = entry["credential"]
        clean.append(out)
    return clean


def _turn_user_label(number: str | None) -> str:
    """Opaque, stable per-account label embedded in the TURN username.

    Ties a relay allocation back to an account during abuse investigation
    without writing the phone number into coturn's log.
    """
    if not number:
        return "anon"
    digest = hashlib.sha256(f"{number}|{settings.jwt_secret}".encode("utf-8")).hexdigest()
    return f"u{digest[:12]}"


def _issue_turn_credential(label: str, ttl_sec: int) -> tuple[str, str, int]:
    """Mint a TURN REST API credential (draft-uberti-behave-turn-rest-00).

        username   = "<unix expiry>:<label>"
        credential = base64(HMAC-SHA1(static-auth-secret, username))

    coturn re-computes the HMAC with its own copy of the secret, so nothing is
    stored on either side and the pair simply stops working at <unix expiry>.
    That is what makes a credential scraped out of a client worthless — unlike
    the static `user=` account this replaces.
    """
    expires_at = int(time.time()) + max(60, int(ttl_sec))
    username = f"{expires_at}:{label}"
    digest = hmac.new(
        settings.turn_static_auth_secret.encode("utf-8"),
        username.encode("utf-8"),
        hashlib.sha1,
    ).digest()
    return username, base64.b64encode(digest).decode("ascii"), expires_at


def _ice_servers_for(auth: AuthToken | None) -> tuple[list[dict[str, Any]], int | None]:
    """STUN for everyone, TURN only for a caller holding a live session token.

    TURN is the half that costs us bandwidth and can be aimed at third parties,
    so it is handed out only against a session that passed OTP — and then only
    as a credential that expires. Returns ``(servers, turn_expiry_or_None)``.
    """
    servers = _sanitise_ice_servers(settings.ice_servers)
    if not (auth and settings.turn_static_auth_secret and settings.turn_urls):
        return servers, None
    username, credential, expires_at = _issue_turn_credential(
        _turn_user_label(auth.number), settings.turn_cred_ttl_sec
    )
    servers.append(
        {
            "urls": list(settings.turn_urls),
            "username": username,
            "credential": credential,
        }
    )
    return servers, expires_at


def _request_token(request: Request, fallback: str = "") -> str:
    """Session token from Authorization / X-Auth-Token / ?token= (in that order)."""
    header = request.headers.get("authorization", "").strip()
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    direct = request.headers.get("x-auth-token", "").strip()
    if direct:
        return direct
    if fallback:
        return fallback.strip()
    return (request.query_params.get("token") or "").strip()


@app.get("/api/config")
async def api_config(request: Request) -> dict[str, Any]:
    # TURN credentials are only included for an authenticated caller; an
    # anonymous fetch gets the STUN list. See /api/ice for the endpoint clients
    # use to refresh credentials just before a call.
    auth = _resolve_token(_request_token(request))
    # BE-24: TURN-креды из /api/config — под тем же лимитом, что /api/ice
    # (ключ — номер, не спуфируемый IP). Сверх лимита отдаём только STUN, а не
    # ошибку: конфиг нужен клиенту для старта.
    turn_auth = auth
    if auth is not None and _ip_rate_limit_hit(
        _ice_ip_hits, f"cfg:{auth.number}",
        limit=settings.ice_rate_limit_per_min, window_sec=60, now=time.time(),
    ):
        turn_auth = None
    ice_servers, ice_expires_at = _ice_servers_for(turn_auth)
    # PROD-06: web (MeshStatusBadge) и Android (fetchConfig) зовут эндпоинт без
    # токена, поэтому он остаётся публичным, но лимиты/окна отдаём только
    # при валидном bearer — анониму незачем знать пороги rate-limit.
    config: dict[str, Any] = {
        "ok": True,
        "serviceName": settings.service_name,
        "iceServers": ice_servers,
        "iceTurn": bool(ice_expires_at),
        "iceTtlSec": settings.turn_cred_ttl_sec if ice_expires_at else 0,
        "iceExpiresAt": ice_expires_at,
        "selfDestructOptions": settings.self_destruct_options,
        "media": {
            "bitrateLow": settings.media_bitrate_low,
            "bitrateMedium": settings.media_bitrate_medium,
            "bitrateHigh": settings.media_bitrate_high,
            "mediapipeBlur": settings.use_mediapipe_blur,
        },
    }
    if auth is not None:
        config.update({
            "lookupLimitPerMinute": settings.lookup_limit_per_minute,
            "otpResendSec": settings.otp_resend_sec,
            "offlineQueueTtlSec": settings.offline_queue_ttl_sec,
            "maxPinPerChat": settings.max_pin_per_chat,
        })
    if _mesh.is_enabled():
        try:
            mesh_cfg: dict[str, Any] = {
                "enabled": True,
                "relayPubkey": _mesh.relay_attestation_pubkey_b64(),
            }
            if auth is not None:
                mesh_cfg.update({
                    "attestationTtlSec": settings.mesh_attestation_ttl_sec,
                    "registerWindowSec": settings.mesh_register_timestamp_window_sec,
                    "bridgePayloadMaxBytes": settings.mesh_bridge_payload_max_bytes,
                    "powDifficultyBits": settings.mesh_pow_difficulty_bits,
                })
            config["mesh"] = mesh_cfg
        except Exception as exc:  # noqa: BLE001 — never take the endpoint down
            # Clients read their ICE servers, OTP timings and media limits from
            # here; a missing MESH_RELAY_ATTESTATION_KEY used to turn the whole
            # response into a 500 and left calls without any ICE configuration.
            log.error("config: mesh unavailable — %s", exc)
            config["mesh"] = {"enabled": False, "reason": "unavailable"}
    else:
        config["mesh"] = {"enabled": False}
    return config


@app.get("/api/ice")
async def api_ice(request: Request, token: str = "") -> JSONResponse:
    """Fresh ICE servers, including a short-lived TURN credential.

    Clients call this right before opening a PeerConnection rather than reusing
    whatever `/api/config` returned at start-up: coturn ends a relay session
    when the credential it was allocated with expires, so a call started on a
    stale credential would drop mid-conversation.
    """
    retry_after = _ip_rate_limit_hit(
        _ice_ip_hits,
        _client_ip_key(request),
        limit=settings.ice_rate_limit_per_min,
        window_sec=60,
        now=time.time(),
    )
    if retry_after:
        return JSONResponse(
            {"ok": False, "reason": "rate_limited"},
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )
    auth = _resolve_token(_request_token(request, token))
    servers, expires_at = _ice_servers_for(auth)
    return JSONResponse(
        {
            "ok": True,
            "iceServers": servers,
            # False → caller is unauthenticated (or TURN is not configured):
            # the STUN-only list still works for everything but symmetric NAT.
            "turn": bool(expires_at),
            "ttlSec": settings.turn_cred_ttl_sec if expires_at else 0,
            "expiresAt": expires_at,
        }
    )


def _audit_logs_statement() -> str:
    """S10.9: формулировка о логах — по фактическому уровню логгера."""
    tail = "no IP addresses or phone numbers in application logs"
    if log.getEffectiveLevel() >= logging.WARNING:
        return f"warnings only; {tail}"
    return f"info level; {tail}"


@app.get("/api/audit")
async def api_audit() -> dict[str, Any]:
    # S10.9: фактическое состояние хранения и логов.
    storage = (
        "messages-ram-only; files: never stored (clients send files peer-to-peer "
        "over WebRTC DataChannel, relay carries only SDP/ICE signaling; "
        "legacy-client files transit RAM queue only); persisted: public keys, "
        "capabilities, push tokens, mesh key revocations, mesh bridge-key generation "
        "per number (no mesh identity directory; state file encrypted at rest)"
    )
    if settings.persist_blocked_users:
        storage += "; block lists (until clients sync)"
    return {
        "ok": True,
        # Публичного репозитория relay пока нет — не заявляем обратное.
        "relayOpenSource": False,
        "storage": storage,
        "logs": _audit_logs_statement(),
        "securityReport": "/SECURITY_AUDIT.md",
    }


class RegisterKeyRequest(BaseModel):
    number: str
    publicKey: str
    token: str
    capabilities: Any | None = None


class LookupKeyRequest(BaseModel):
    number: str
    targetNumber: str
    token: str


@app.post("/api/keys/register")
async def api_keys_register(body: RegisterKeyRequest):
    """HTTP fallback: register public key without WebSocket."""
    auth = _resolve_token(body.token)
    if not auth:
        return JSONResponse({"ok": False, "reason": "invalid_token"}, status_code=401)
    number = normalize_number(body.number)
    if not number or number != auth.number:
        return JSONResponse({"ok": False, "reason": "number_mismatch"}, status_code=400)
    retry_after = _ip_rate_limit_hit(
        _http_fallback_hits, f"reg:{number}", limit=10, window_sec=60, now=time.time(),
    )
    if retry_after:
        return JSONResponse(
            {"ok": False, "reason": "rate_limited", "retryAfter": retry_after},
            status_code=429, headers={"Retry-After": str(retry_after)},
        )
    key = _sanitize_public_key(body.publicKey)
    if not key:
        return JSONResponse({"ok": False, "reason": "empty_key"}, status_code=400)
    registered_keys[number] = key
    registered_capabilities[number] = _normalize_capabilities(body.capabilities)
    # Also update the live session if connected
    session = sessions.get(number)
    if session:
        session.public_key = key
        session.capabilities = registered_capabilities[number]
    log.info("api: %s registered key via HTTP (%d chars)", _hash_pii(number), len(key))
    return {"ok": True}


@app.post("/api/keys/lookup")
async def api_keys_lookup(body: LookupKeyRequest):
    """HTTP fallback: lookup peer public key without WebSocket."""
    auth = _resolve_token(body.token)
    if not auth:
        return JSONResponse({"ok": False, "reason": "invalid_token"}, status_code=401)

    # Rate limit (same window as WebSocket lookup)
    now = time.time()
    window = _http_lookup_window.setdefault(auth.number, deque())
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= settings.lookup_limit_per_minute:
        return JSONResponse({"ok": False, "reason": "rate_limited"}, status_code=429)
    window.append(now)

    target = normalize_number(body.targetNumber)
    if not target:
        return JSONResponse({"ok": False, "reason": "invalid_number"}, status_code=400)
    # BE-11: как в WS lookup — заблокированному номер «офлайн и без ключа».
    if _is_blocked(auth.number, target):
        return {"ok": True, "targetNumber": target, "online": False, "publicKey": None, "capabilities": []}
    peer = sessions.get(target)
    peer_key = _lookup_public_key(target)
    is_online = bool(peer) and target not in _presence_hidden  # WEB-11
    log.debug("api: lookup %s -> %s (online=%s, hasKey=%s)", _hash_pii(auth.number), _hash_pii(target), is_online, bool(peer_key))
    return {
        "ok": True,
        "targetNumber": target,
        "online": is_online,
        "publicKey": peer_key,
        "capabilities": list(registered_capabilities.get(target, [])),
        "devices": _lookup_devices(target) if peer_key else [],  # mdev1
    }


def _is_blocked(from_number: str, to_number: str, *, either_way: bool = False) -> bool:
    """BE-11/X-04: заблокирован ли ``from_number`` получателем ``to_number``.

    ``either_way=True`` (звонки, P2P-сигналинг) — дроп, если ЛЮБОЙ из двух
    заблокировал другого: блокировка должна обрывать и сигналинг, и раскрытие IP.
    """
    if from_number in blocked_users.get(to_number, ()):
        return True
    return either_way and to_number in blocked_users.get(from_number, ())


def _sanitize_reply_to(value: Any) -> dict[str, str] | None:
    """X-03 / S5 / S10: убрать открытый текст цитаты из ``replyTo``.

    dict -> только ``messageId`` (str <= 128) и ``from`` (нормализованный номер,
    иначе поле убирается). Любой не-dict (в т.ч. голая строка) и dict без
    валидного ``messageId`` -> ``None``: вызывающий удаляет поле целиком.
    """
    if not isinstance(value, dict):
        return None
    message_id = value.get("messageId")
    if not isinstance(message_id, str) or not message_id or len(message_id) > 128:
        return None
    out: dict[str, str] = {"messageId": message_id}
    sender = normalize_number(value.get("from")) if isinstance(value.get("from"), str) else None
    if sender:
        out["from"] = sender
    return out


_CALL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MIME_RE = re.compile(r"^[\w.+-]+/[\w.+-]+$")


def _sanitize_call_id(value: Any) -> str | None:
    """Q10: callId — строка <= 64 символов [A-Za-z0-9_-], иначе None (поле вырезается)."""
    if isinstance(value, str) and _CALL_ID_RE.match(value):
        return value
    return None


def _sanitize_file_name(value: Any) -> str:
    """Q15: <= 255 символов, без управляющих символов (категория C*) и без / \\."""
    if not isinstance(value, str):
        return ""
    cleaned = "".join(
        ch for ch in value
        if ch not in "/\\" and not unicodedata.category(ch).startswith("C")
    )
    return cleaned[:255]


def _sanitize_file_size(value: Any, cap: int) -> int:
    """Q15: int в [0, cap], иначе 0 (bool не считается числом)."""
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return value if 0 <= value <= cap else 0


def _sanitize_mime_type(value: Any) -> str:
    """Q15: ``type/subtype`` по regex, <= 127 символов, иначе пустая строка."""
    if isinstance(value, str) and len(value) <= 127 and _MIME_RE.match(value):
        return value
    return ""


def _sanitize_duration(value: Any) -> int | float:
    """Q15: число >= 0 (конечное), иначе 0."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    if isinstance(value, float) and not math.isfinite(value):
        return 0
    return value if value >= 0 else 0


def _sanitize_reaction_emoji(value: Any) -> str:
    """Q15: легаси ``emoji`` — строка <= 16 символов, иначе пустая."""
    if isinstance(value, str) and len(value) <= 16:
        return value
    return ""


def _blob_too_large(blob: Any) -> bool:
    """Q5: размер JSON-сериализации ``encryptedBlob`` превышает MESSAGE_MAX_BLOB_BYTES."""
    try:
        size = len(json.dumps(blob, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        return True
    return size > settings.message_max_blob_bytes


def _apply_block_sync(
    blocked: dict[str, set[str]], owner: str, numbers: Any, unblocked: Any
) -> tuple[list[str], bool]:
    """Q11: ``set |= numbers; set -= unblocked``. Списки <= 1000, номера нормализуются,
    невалидные и собственный номер пропускаются. Размер множества ограничен
    ``MAX_BLOCKED_PER_USER``. Возвращает (итоговый список, упёрлись ли в лимит)."""

    def _clean(raw: Any) -> list[str]:
        out: list[str] = []
        if not isinstance(raw, list):
            return out
        for item in raw[:1000]:
            n = normalize_number(item) if isinstance(item, str) else None
            if n and n != owner and n not in out:
                out.append(n)
        return out

    add = _clean(numbers)
    remove = set(_clean(unblocked))
    limit_hit = False
    current = blocked.get(owner)
    # Сначала снятия — они освобождают место под добавления.
    if current is not None and remove:
        current.difference_update(remove)
    if add:
        current = blocked.setdefault(owner, set())
        for n in add:
            if n in current:
                continue
            if len(current) >= settings.max_blocked_per_user:
                limit_hit = True
                break
            current.add(n)
        if not current:
            blocked.pop(owner, None)
    return sorted(blocked.get(owner, set())), limit_hit


_CALL_ID_TTL_SEC = 600.0
# Сколько живёт пара «звонящий—вызываемый» после последнего сигнала звонка: отбой длинного
# звонка должен дойти, а отбой без звонка между этими номерами — нет.
_CALL_PAIR_TTL_SEC = 12 * 3600.0


def _note_call_pair(a: str, b: str, now: float | None = None) -> None:
    """Запомнить звонок между a и b (call_offer прошёл лимит и блок-лист)."""
    _call_pairs[frozenset((a, b))] = now or time.time()


def _call_pair_known(a: str, b: str, now: float | None = None) -> bool:
    """Был ли звонок между a и b за последние _CALL_PAIR_TTL_SEC (в любую сторону).

    Отбой/отклонение без звонка между этими номерами relay не пересылает: иначе клиент
    (например, после смены аккаунта) раскрыл бы свой номер собеседнику чужого звонка и
    связал бы номера между собой. callId не требуется — старые клиенты его не шлют.
    """
    ts = _call_pairs.get(frozenset((a, b)))
    return ts is not None and (now or time.time()) - ts < _CALL_PAIR_TTL_SEC
_CALL_ID_CACHE_MAX = 64
_CALL_RENEG_LIMIT_PER_MIN = 30  # мягкий лимит renegotiation внутри известного звонка


def _signal_rate_limited(
    event: str, number: str, now: float | None = None,
    call_id: str | None = None, target: str | None = None,
) -> bool:
    """S10.5: True, если ``number`` превысил лимит ``call_offer``/``p2p_offer`` за 60 с.

    ``call_offer`` с тройкой ``(number, target, callId)``, уже засчитанной в
    основной лимит за последние 10 минут от ПЕРВОГО появления (renegotiation /
    ICE-restart), идёт в отдельный мягкий лимит (30/мин на отправителя).
    Новый callId или другой адресат — основной лимит; без callId — всегда
    основной. Кэш — до 64 троек на отправителя, старые вытесняются.
    """
    current = now or time.time()
    key = (target, call_id)
    if event == "call_offer":
        bucket, limit = _call_offer_hits, settings.call_offer_rate_limit_per_min
        seen = _call_id_seen.get(number)
        if call_id and seen is not None:
            first = seen.get(key)
            if first is not None and current - first < _CALL_ID_TTL_SEC:
                return bool(_ip_rate_limit_hit(
                    _call_reneg_hits, number, limit=_CALL_RENEG_LIMIT_PER_MIN,
                    window_sec=60, now=current,
                ))
    elif event == "p2p_offer":
        bucket, limit = _p2p_offer_hits, settings.p2p_offer_rate_limit_per_min
    else:
        return False
    if _ip_rate_limit_hit(bucket, number, limit=limit, window_sec=60, now=current):
        return True
    if event == "call_offer" and call_id:
        seen = _call_id_seen.setdefault(number, {})
        seen[key] = current  # метка = первое появление, повтор её не продлевает
        while len(seen) > _CALL_ID_CACHE_MAX:
            seen.pop(min(seen, key=seen.get), None)
    return False


class SendMessageRequest(BaseModel):
    token: str
    toNumber: str
    encryptedBlob: dict
    # S5: объект {messageId, from}; строка принимается по типу, но relay её отбрасывает (X-03).
    replyTo: str | dict | None = None
    messageId: str | None = None


class PollMessagesRequest(BaseModel):
    token: str


@app.post("/api/messages/send")
async def api_send_message(body: SendMessageRequest, request: Request):
    """HTTP fallback: send a message when WebSocket is unavailable."""
    auth = _resolve_token(body.token)
    if not auth:
        return JSONResponse({"ok": False, "reason": "invalid_token"}, status_code=401)
    from_number = auth.number
    target = normalize_number(body.toNumber)
    if not target:
        return JSONResponse({"ok": False, "reason": "invalid_number"}, status_code=400)

    # BE-23: лимиты по IP и по номеру — HTTP-fallback не должен быть обходом
    # WS-ограничений и каналом спама в offline-очередь.
    now = time.time()
    retry_after = _ip_rate_limit_hit(
        _msg_send_ip_hits, _client_ip_key(request),
        limit=settings.message_send_ip_rate_limit_per_min, window_sec=60, now=now,
    ) or _ip_rate_limit_hit(
        _msg_send_number_hits, from_number,
        limit=settings.message_send_rate_limit_per_min, window_sec=60, now=now,
    )
    if retry_after:
        return JSONResponse(
            {"ok": False, "reason": "rate_limited", "retryAfter": retry_after},
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )

    # Q5: кап размера encryptedBlob.
    if _blob_too_large(body.encryptedBlob):
        return JSONResponse({"ok": False, "reason": "too_large"}, status_code=413)

    # BE-23: блок-лист, как в WS. Отвечаем как при постановке в очередь,
    # чтобы не раскрывать отправителю факт блокировки.
    if _is_blocked(from_number, target):
        return {"ok": True, "status": "queued"}

    # Normalize blob iv/nonce
    blob = dict(body.encryptedBlob)
    if "iv" in blob and "nonce" not in blob:
        blob["nonce"] = blob["iv"]
    elif "nonce" in blob and "iv" not in blob:
        blob["iv"] = blob["nonce"]

    outbound: dict[str, Any] = {
        "type": "message",
        "fromNumber": from_number,
        "encryptedBlob": blob,
    }
    reply_to = _sanitize_reply_to(body.replyTo)
    if reply_to:
        outbound["replyTo"] = reply_to
    if body.messageId:
        outbound["messageId"] = body.messageId

    peer = sessions.get(target)
    if peer:
        await _safe_send(peer, outbound)
        log.debug("api: message %s -> %s DELIVERED via HTTP", _hash_pii(from_number), _hash_pii(target))
        return {"ok": True, "status": "delivered"}
    else:
        queued = _enqueue_offline(from_number, target, outbound)
        log.debug("api: message %s -> %s QUEUED via HTTP (queued=%s)", _hash_pii(from_number), _hash_pii(target), queued)
        if queued is True:
            return {"ok": True, "status": "queued"}
        return {"ok": False, "status": queued or "queue_full", "reason": queued or "queue_full"}


@app.post("/api/messages/poll")
async def api_poll_messages(body: PollMessagesRequest):
    """HTTP fallback: poll for pending messages when WebSocket is unavailable."""
    auth = _resolve_token(body.token)
    if not auth:
        return JSONResponse({"ok": False, "reason": "invalid_token"}, status_code=401)
    number = auth.number
    retry_after = _ip_rate_limit_hit(
        _http_fallback_hits, f"poll:{number}", limit=30, window_sec=60, now=time.time(),
    )
    if retry_after:
        return JSONResponse(
            {"ok": False, "reason": "rate_limited", "retryAfter": retry_after},
            status_code=429, headers={"Retry-After": str(retry_after)},
        )
    queue = offline_queue.pop(number, None)
    messages = []
    if queue:
        now = time.time()
        for msg in queue:
            # Release the byte-quota for every entry we drain, regardless of
            # whether the client ultimately consumes it.
            _offline_queue_release(msg)
            if msg.expires_at > now:
                messages.append(msg.payload)
    log.info("api: poll %s -> %d messages", _hash_pii(number), len(messages))
    return {"ok": True, "messages": messages}


# ─── Mesh REST surface ───────────────────────────────────────────────────
# Mirrors the WebSocket handlers so HTTP-only clients (web, or a mobile
# client whose WebSocket happens to be down at the moment of registration)
# can still maintain mesh identities. All endpoints respect the same
# rate-limits as the WS path because they share buckets via mesh.py.


class MeshRegisterRequest(BaseModel):
    token: str
    mesh_static_pub: str
    mesh_signing_pub: str
    signature: str
    # MESH-25 / S6: каноническое имя timestamp_ms; старые клиенты шлют
    # timestamp или timestampMs (те же миллисекунды).
    timestamp_ms: int | None = None
    timestamp: int | None = None
    timestampMs: int | None = None
    nonce: str


class MeshIdentityLookupRequest(BaseModel):
    token: str
    targetNumber: str


class MeshVerifyBatchRequest(BaseModel):
    token: str
    numbers: list[str]


class MeshRevokeRequest(BaseModel):
    """Self-signed revocation submitted by the holder of the dying key.

    Token is *optional* — anonymous mesh users have no NFT-bound JWT, but
    they can still revoke an identity they minted on-device. When token
    is absent we fall back to IP-based rate limiting.
    """

    token: str | None = None
    phantomIdV2: str  # 32-char hex
    meshSigningPub: str  # base64 raw 32-byte Ed25519
    revokedAtMs: int
    reason: int  # 0..3
    signature: str  # base64 raw 64-byte Ed25519


@app.get("/api/mesh/relay-pubkey")
async def api_mesh_relay_pubkey() -> dict[str, Any]:
    """Public part of the relay attestation key (Ed25519, base64).

    Mobile clients may pin this at first launch so they can verify peers
    seen offline (scenario C in §4.3 of the plan). Safe to expose.
    """
    if not _mesh.is_enabled():
        return {"ok": False, "reason": "mesh_disabled"}
    return {
        "ok": True,
        "relayPubkey": _mesh.relay_attestation_pubkey_b64(),
        # Мост v2: X25519-ключ relay, на который запечатываются конверты (§9.2).
        "relayBoxPubkey": _mesh.relay_box_pubkey_b64(),
    }


@app.post("/api/mesh/identity")
async def api_mesh_identity_register(body: MeshRegisterRequest) -> dict[str, Any]:
    """REST fallback for ``mesh_register_identity``."""
    # MESH-25 / MESH-07: каталог mesh-идентичностей отключён (mesh анонимен).
    return JSONResponse({"ok": False, "reason": "mesh_directory_disabled"}, status_code=410)


@app.get("/api/mesh/identity/{number}")
async def api_mesh_identity_lookup(number: str, request: Request) -> dict[str, Any]:
    """REST fallback for ``mesh_identity_lookup``.

    BE-10: только с токеном сессии и под тем же лимитом на номер, что WS-путь, —
    без токена (лимит по IP) директорию mesh-идентичностей можно было перебирать.
    """
    # MESH-25 / MESH-07: каталог mesh-идентичностей отключён (mesh анонимен).
    return JSONResponse({"ok": False, "reason": "mesh_directory_disabled"}, status_code=410)


@app.post("/api/mesh/verify")
async def api_mesh_verify(body: MeshVerifyBatchRequest, request: Request) -> dict[str, Any]:
    """REST fallback for bulk verification (``mesh_verify``)."""
    # MESH-25 / MESH-07: каталог mesh-идентичностей отключён (mesh анонимен).
    return JSONResponse({"ok": False, "reason": "mesh_directory_disabled"}, status_code=410)


async def _force_disconnect_revoked(numbers: list[str], reason_code: int) -> None:
    """Notify and close every active session bound to a revoked identity.

    The revocation packet has already been registered in ``_mesh``; this
    function only handles the live-session side effects: send a final
    ``mesh_identity_revoked`` notice so the client can drop its UI state
    cleanly, then close the WebSocket. Subsequent reconnects with the
    same key will be rejected at ``mesh_register_identity`` because the
    relay refuses to mint attestations for blacklisted keys.
    """
    notice = {"type": "mesh_identity_revoked", "reasonCode": reason_code}
    for number in numbers:
        primary = sessions.get(number)
        if primary is not None:
            await _safe_send(primary, notice)
            try:
                await primary.ws.close(code=4001, reason="mesh_revoked")
            except Exception:
                pass
        for dev_session in list(multi_sessions.get(number, {}).values()):
            await _safe_send(dev_session, notice)
            try:
                await dev_session.ws.close(code=4001, reason="mesh_revoked")
            except Exception:
                pass


@app.post("/api/mesh/revoke")
async def api_mesh_revoke(body: MeshRevokeRequest, request: Request) -> dict[str, Any]:
    """REST fallback for ``mesh_revoke``.

    Accepts a self-signed revocation envelope. On success the relay:
      1. persists the blacklist entry (30-day TTL),
      2. evicts all matching identity records,
      3. force-disconnects every WebSocket session bound to the revoked
         identity so the client's UI state is reset.
    """
    if not _mesh.is_enabled():
        return JSONResponse({"ok": False, "reason": "mesh_disabled"}, status_code=403)

    if body.token:
        auth = _resolve_token(body.token)
        source_key = auth.number if auth else f"ip:{_client_ip_key(request)}"
    else:
        source_key = f"ip:{_client_ip_key(request)}"

    response, affected = _mesh.handle_revoke(
        source_key=source_key,
        payload={
            "phantomIdV2": body.phantomIdV2,
            "meshSigningPub": body.meshSigningPub,
            "revokedAtMs": body.revokedAtMs,
            "reason": body.reason,
            "signature": body.signature,
        },
    )
    if response.get("status") != "ok":
        return JSONResponse(
            {"ok": False, "reason": response.get("reason", "rejected")},
            status_code=429 if response.get("reason") == "rate_limited" else 400,
        )

    # Force-disconnect outside the handler so the response itself is sent
    # to the caller (which may BE the device that revoked itself).
    if affected:
        _spawn_tracked(
            _force_disconnect_revoked(affected, body.reason),
            label="mesh_revoke_force_disconnect",
        )
    _save_state()

    return {"ok": True, **{k: v for k, v in response.items() if k != "type"}}


def _parse_ip(value: str | None) -> str | None:
    """Канонический вид IP-адреса или ``None``, если это не IP.

    IPv4-mapped IPv6 (``::ffff:1.2.3.4``) сводится к IPv4, чтобы один и тот
    же клиент не попадал в разные rate-limit-ключи.
    """
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        addr = ipaddress.ip_address(raw)
    except ValueError:
        return None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return str(addr)


def _load_trusted_proxies() -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    """BE-01: разобрать TRUSTED_PROXIES (+ TRUSTED_PROXIES_FILE) один раз при старте.

    Невалидные записи пропускаются с предупреждением — опечатка в одной CIDR
    не должна ронять relay, но и не должна молча расширять доверие.
    """
    entries: list[str] = [e.strip() for e in settings.trusted_proxies.split(",") if e.strip()]
    if settings.trusted_proxies_file:
        try:
            for line in Path(settings.trusted_proxies_file).read_text(encoding="utf-8").splitlines():
                item = line.split("#", 1)[0].strip()
                if item:
                    entries.append(item)
        except OSError as exc:
            log.warning("config: TRUSTED_PROXIES_FILE unreadable: %s", exc)
    nets: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for entry in entries:
        try:
            net = ipaddress.ip_network(entry, strict=False)
        except ValueError:
            log.warning("config: TRUSTED_PROXIES ignores invalid entry %r", entry)
            continue
        if net.prefixlen == 0:
            # 0.0.0.0/0 или ::/0 означало бы доверие любому клиенту = спуфинг IP.
            log.warning("config: TRUSTED_PROXIES ignores catch-all entry %r", entry)
            continue
        nets.append(net)
    return tuple(nets)


_TRUSTED_PROXY_NETS = _load_trusted_proxies()


def _is_trusted_proxy(ip: str | None) -> bool:
    if not ip:
        return False
    addr = ipaddress.ip_address(ip)
    return any(addr in net for net in _TRUSTED_PROXY_NETS)


def _rate_limit_key(ip: str) -> str:
    """BE-05: ключ rate-limit'а по IP. IPv6 сворачиваем до /64 — абоненту
    обычно выдают целый /64, и иначе один клиент мог бы перебором адресов
    плодить ключи (обходить лимит и вытеснять чужие записи из словаря)."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if isinstance(addr, ipaddress.IPv6Address):
        return str(ipaddress.ip_network(f"{addr}/64", strict=False).network_address) + "/64"
    return ip


def _client_ip_key(conn: HTTPConnection) -> str:
    """IP клиента в виде ключа для rate-limit'ов (см. ``_rate_limit_key``)."""
    return _rate_limit_key(_client_ip(conn))


def _client_ip(conn: HTTPConnection) -> str:
    """IP клиента для rate-limit'ов (BE-01).

    Заголовкам верим ТОЛЬКО если TCP-пир — доверенный прокси из
    TRUSTED_PROXIES (Cloudflare / loopback). Иначе любой клиент, идущий
    напрямую на origin, подставлял бы произвольный CF-Connecting-IP / XFF
    и обходил лимиты OTP/ICE/mesh.

    Порядок для доверенного пира: CLIENT_IP_HEADER (CF-Connecting-IP) →
    X-Forwarded-For (справа налево, первый адрес не из доверенных прокси —
    левые элементы может дописать сам клиент) → X-Real-IP. Невалидный IP в
    заголовке игнорируется, fallback — адрес пира. Работает и для
    ``Request``, и для ``WebSocket``.
    """
    client = conn.client
    raw_peer = client.host if client else ""
    peer = _parse_ip(raw_peer)
    if peer is None:
        return raw_peer or "unknown"
    if not _is_trusted_proxy(peer):
        return peer

    custom_header = settings.client_ip_header
    if custom_header:
        val = _parse_ip(conn.headers.get(custom_header.lower(), "").split(",")[0])
        if val:
            return val
    fwd = conn.headers.get("x-forwarded-for", "")
    if fwd:
        hops = [_parse_ip(h) for h in fwd.split(",")]
        hops = [h for h in hops if h]
        for hop in reversed(hops):
            if not _is_trusted_proxy(hop):
                return hop
        if hops:
            # Вся цепочка из доверенных прокси — берём самый левый.
            return hops[0]
    real = _parse_ip(conn.headers.get("x-real-ip", ""))
    if real:
        return real
    return peer


def _ip_rate_limit_hit(bucket: dict[str, deque[float]], ip: str, limit: int, window_sec: int, now: float) -> int:
    """Record an attempt from ``ip`` and return ``retry_after`` seconds if the
    limit has been exceeded (0 means allowed).

    The window is a sliding deque of timestamps — O(k) per request where k is
    the current bucket size (bounded by ``limit``).
    """
    q = bucket.setdefault(ip, deque())
    cutoff = now - window_sec
    while q and q[0] < cutoff:
        q.popleft()
    if len(q) >= limit:
        oldest = q[0]
        return max(1, int(window_sec - (now - oldest)) + 1)
    q.append(now)
    return 0


@app.post("/api/auth/send-code")
async def auth_send_code(body: SendCodeRequest, request: Request):
    number = normalize_number(body.number or body.phone)
    if not number:
        return JSONResponse(
            {"ok": False, "reason": "invalid_number", "message": "Expected 111-XX-XXX-XX"},
            status_code=400,
        )

    now = time.time()

    # Global per-IP rate-limit — caps total OTP broadcasts regardless of the
    # number, so a single attacker cannot burst-send codes to hundreds of
    # victims from one IP.
    ip = _client_ip_key(request)
    retry_after = _ip_rate_limit_hit(
        _send_ip_hits, ip,
        limit=max(10, settings.verify_ip_rate_limit // 3),
        window_sec=settings.verify_ip_rate_window_sec,
        now=now,
    )
    if retry_after:
        return JSONResponse(
            {"ok": False, "reason": "rate_limited", "retryAfter": retry_after},
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )

    current = pending_otps.get(number)
    if current and current.resend_at > now:
        wait = int(current.resend_at - now) + 1
        return JSONResponse(
            {"ok": False, "reason": "rate_limited", "retryAfter": wait},
            status_code=429,
            headers={"Retry-After": str(wait)},
        )

    # BE-21: общий потолок исходящих OTP по всем IP — последний барьер против
    # массовой рассылки кодов на чужие номера (SMS-toll-fraud через Numbers API).
    retry_after = _ip_rate_limit_hit(
        _otp_global_hits, "*",
        limit=settings.otp_global_limit_per_hour, window_sec=3600, now=now,
    )
    if retry_after:
        log.warning("auth: global OTP cap reached (%d/h)", settings.otp_global_limit_per_hour)
        return JSONResponse(
            {"ok": False, "reason": "rate_limited", "retryAfter": retry_after},
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )

    success, payload, status_code, reason = await _call_numbers_api(
        settings.numbers_send_code_path,
        {
            "phone": number,
            "number": number,
            "service": settings.service_name,
        },
    )
    if not success:
        response_status = 503 if reason == "upstream_unreachable" else status_code
        # BE-08: тело ответа апстрима наружу не отдаём — только нормализованный reason.
        return JSONResponse({"ok": False, "reason": reason}, status_code=response_status)

    # Preserve any existing per-number backoff counter: if the previous session
    # was under exponential backoff because of wrong attempts, requesting a new
    # code must NOT reset that backoff — otherwise OTP_RESEND_SEC becomes a
    # bypass for the brute-force defence.
    previous_attempts = current.verify_attempts if current else 0
    pending_otps[number] = PendingOtp(
        requested_at=now,
        expires_at=now + settings.otp_ttl_sec,
        resend_at=now + settings.otp_resend_sec,
        verify_attempts=previous_attempts,
    )
    return {
        "ok": True,
        "number": number,
        "formatted": format_number(number),
        "expiresIn": settings.otp_ttl_sec,
        "retryAfter": settings.otp_resend_sec,
    }


_MIN_VERIFY_DURATION_SEC = 0.25  # timing-side-channel floor


async def _verify_finalise(start: float, response: JSONResponse | dict) -> JSONResponse | dict:
    """Pad the verify-code response time up to ``_MIN_VERIFY_DURATION_SEC``.

    Without this floor, the response latency leaks which branch was hit
    (invalid_number → fast, upstream call → slow, bad code → slow +
    backoff), giving an attacker an oracle for valid numbers / rate-limit
    state even when the error strings are identical.
    """
    elapsed = time.monotonic() - start
    remaining = _MIN_VERIFY_DURATION_SEC - elapsed
    if remaining > 0:
        await asyncio.sleep(remaining)
    return response


@app.post("/api/auth/verify-code")
async def auth_verify_code(body: VerifyCodeRequest, request: Request):
    start = time.monotonic()
    ip = _client_ip_key(request)
    number = normalize_number(body.number or body.phone)
    if not number:
        log.warning("auth: verify rejected — invalid_number")
        return await _verify_finalise(
            start,
            JSONResponse({"ok": False, "reason": "invalid_number"}, status_code=400),
        )
    if not is_otp_code(body.code):
        log.warning("auth: verify rejected — invalid_code_format number=%s", _hash_pii(number))
        return await _verify_finalise(
            start,
            JSONResponse({"ok": False, "reason": "invalid_code_format"}, status_code=400),
        )

    now = time.time()

    # Per-IP global rate-limit — prevents distributed brute-force that would
    # otherwise split attempts across thousands of numbers from one host.
    retry_after = _ip_rate_limit_hit(
        _verify_ip_hits, ip,
        limit=settings.verify_ip_rate_limit,
        window_sec=settings.verify_ip_rate_window_sec,
        now=now,
    )
    if retry_after:
        log.warning("auth: verify rate-limited retryAfter=%ds", retry_after)
        return await _verify_finalise(
            start,
            JSONResponse(
                {"ok": False, "reason": "rate_limited", "retryAfter": retry_after},
                status_code=429,
                headers={"Retry-After": str(retry_after)},
            ),
        )

    # Per-number exponential backoff — every failed attempt extends the delay
    # before the next verify is allowed, so even with unlimited IPs an
    # attacker cannot enumerate the 10^6 OTP space within its 5-minute TTL.
    next_ok = _verify_number_next_ok.get(number, 0.0)
    if now < next_ok:
        wait = int(next_ok - now) + 1
        log.warning("auth: verify backoff number=%s wait=%ds", _hash_pii(number), wait)
        return await _verify_finalise(
            start,
            JSONResponse(
                {"ok": False, "reason": "backoff", "retryAfter": wait},
                status_code=429,
                headers={"Retry-After": str(wait)},
            ),
        )

    current = pending_otps.get(number)
    if not current or current.expires_at <= now:
        pending_otps.pop(number, None)
        log.warning("auth: verify no_session number=%s", _hash_pii(number))
        return await _verify_finalise(
            start,
            JSONResponse({"ok": False, "reason": "otp_session_expired"}, status_code=409),
        )

    if current.verify_attempts >= settings.max_verify_attempts:
        log.warning("auth: verify too_many_attempts number=%s attempts=%d",
                    _hash_pii(number), current.verify_attempts)
        return await _verify_finalise(
            start,
            JSONResponse(
                {"ok": False, "reason": "too_many_attempts",
                 "message": "Слишком много попыток. Запросите код заново."},
                status_code=429,
            ),
        )
    current.verify_attempts += 1

    success, payload, status_code, reason = await _call_numbers_api(
        settings.numbers_verify_code_path,
        {
            "phone": number,
            "number": number,
            "code": body.code,
            "service": settings.service_name,
        },
    )
    if not success:
        # Exponential backoff per-number: 2s, 4s, 8s, 16s, ..., capped.
        delay = min(2 ** current.verify_attempts, settings.verify_backoff_max_sec)
        _verify_number_next_ok[number] = now + delay
        log.warning(
            "auth: verify FAIL number=%s attempts=%d reason=%s status=%d",
            _hash_pii(number), current.verify_attempts, reason, status_code,
        )
        response_status = 503 if reason == "upstream_unreachable" else status_code
        resp_payload: dict[str, Any] = {"ok": False, "reason": reason}  # BE-08: без upstream
        if reason != "upstream_unreachable":
            resp_payload["retryAfter"] = delay
        headers = {"Retry-After": str(delay)} if reason != "upstream_unreachable" else None
        return await _verify_finalise(
            start,
            JSONResponse(resp_payload, status_code=response_status, headers=headers or {}),
        )

    token = _issue_token(number)
    pending_otps.pop(number, None)
    _verify_number_next_ok.pop(number, None)
    # PROD-09: в успешных событиях IP не пишем (в отказах WARNING с ip остаётся для fail2ban).
    log.info("auth: verify OK number=%s", _hash_pii(number))
    return await _verify_finalise(
        start,
        {"ok": True, "token": token, "number": number, "expiresIn": settings.auth_token_ttl_sec},
    )


WS_AUTH_TIMEOUT_SEC = 5.0
# BE-30: сколько ждать кадр `auth` с device hint, если токен пришёл в
# заголовке/sub-protocol, а hint не передан в query. Все клиенты шлют этот
# кадр сразу после open, так что ожидание обычно — миллисекунды.
WS_HINT_WAIT_SEC = float(os.getenv("WS_HINT_WAIT_SEC", "2"))
# Hard cap per WebSocket frame. Larger payloads are refused on the parse
# path — a 1 GB JSON would otherwise blow the relay's heap since every
# client is read with ``receive_text``.
WS_MAX_MESSAGE_BYTES = int(os.getenv("WS_MAX_MESSAGE_BYTES", "262144"))
# Drop sockets that haven't sent ANYTHING (including keepalive pings) in
# this window. Prevents half-open TCP from leaking FDs.
WS_IDLE_TIMEOUT_SEC = float(os.getenv("WS_IDLE_TIMEOUT_SEC", "300"))

# Per-(number, device_id) asyncio.Lock used to serialise the "close old
# session + install new session" dance in the relay WS handler. Without
# this two near-simultaneous reconnects from the same device could each
# think they are replacing a stale session and silently overwrite one
# another — race that desync'd push_tokens + multi_sessions.
_session_locks: dict[tuple[str, str], asyncio.Lock] = {}
_session_locks_mutex: asyncio.Lock | None = None


async def _acquire_session_lock(number: str, device_id: str) -> asyncio.Lock:
    global _session_locks_mutex
    if _session_locks_mutex is None:
        _session_locks_mutex = asyncio.Lock()
    async with _session_locks_mutex:
        lock = _session_locks.get((number, device_id))
        if lock is None:
            lock = asyncio.Lock()
            _session_locks[(number, device_id)] = lock
        return lock


def _release_session_lock(number: str, device_id: str) -> None:
    """Drop an unused lock entry. Safe no-op if someone else is waiting."""
    lock = _session_locks.get((number, device_id))
    if lock is not None and not lock.locked():
        _session_locks.pop((number, device_id), None)


def _detach_session(number: str, sess: ClientSession) -> None:
    """BE-30: синхронно снять сессию из multi_sessions/sessions (до любых await).

    Иначе между удалением её токенов и закрытием сокета _rotate_tokens мог
    бы принять её за «осиротевшую» и выдать ей новый token_rotated.
    Логика промоута primary — как в finally WS-обработчика (там повторное
    снятие становится no-op).
    """
    device_sessions = multi_sessions.get(number, {})
    if device_sessions.get(sess.device_id) is sess:
        device_sessions.pop(sess.device_id, None)
    if number in multi_sessions and not multi_sessions[number]:
        multi_sessions.pop(number, None)
    if sessions.get(number) is sess:
        remaining = multi_sessions.get(number, {})
        if remaining:
            promoted = next(iter(remaining.values()))
            sessions[number] = promoted
            _sync_registered_from_primary(number, promoted)
        else:
            sessions.pop(number, None)


def _extract_bearer_from_header(header_value: str) -> str:
    """Return the bearer token from an Authorization header value.

    Accepts both ``Bearer <token>`` and ``Token <token>``. Empty string on
    miss — callers fall back to the first-message auth flow.
    """
    if not header_value:
        return ""
    lower = header_value.strip()
    if lower.lower().startswith("bearer "):
        return lower[7:].strip()
    if lower.lower().startswith("token "):
        return lower[6:].strip()
    return ""


_DEVICE_ID_HEX_LEN = 16  # 64-bit hex string, matches legacy format


def _derive_server_device_id(number: str, client_hint: str) -> str:
    """Derive a stable, server-authenticated device_id from the client hint.

    The client stores an opaque long-lived secret (generated on first connect
    — e.g. `phantom_device_id` in localStorage / UserDefaults / UUID on
    Android). The AUTHORITATIVE device_id is an HMAC of that hint keyed by
    ``jwt_secret``. An attacker who knows another user's device_id cannot
    reproduce it without the server's jwt_secret — so they cannot hijack
    push-tokens or multi-device slots registered under the victim's id.

    Clients receive the derived id in ``session_ready`` and MUST treat it as
    opaque (display-only). The hint itself remains a client-side secret that
    never leaves the device except as an input to this HMAC.
    """
    import hmac as _hmac

    hint = str(client_hint or "").strip()[:128]
    if not hint:
        return secrets.token_hex(_DEVICE_ID_HEX_LEN // 2)
    mac = _hmac.new(
        settings.jwt_secret.encode("utf-8"),
        f"device:{number}:{hint}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return mac[:_DEVICE_ID_HEX_LEN]


def _extract_protocol_bearer(ws: WebSocket) -> tuple[str, str | None]:
    """Browsers cannot set Authorization on WebSocket, but they CAN send
    ``Sec-WebSocket-Protocol``. We let clients encode the token as a
    sub-protocol of form ``bearer.<token>`` so that it never touches the
    query string (and is thus never logged).

    Returns ``(token, echo)`` where ``echo`` is the exact sub-protocol
    string we must return to the browser — RFC 6455 requires the server
    to echo one of the client-offered protocols, and Chrome/Firefox abort
    with "bad response" if the server replies with anything else.
    """
    raw = ws.headers.get("sec-websocket-protocol", "") or ""
    for part in raw.split(","):
        item = part.strip()
        if item.lower().startswith("bearer."):
            return item.split(".", 1)[1].strip(), item
    return "", None


# BE-14: те же origin'ы, что в CORS.
_WS_ALLOWED_ORIGINS = frozenset(
    o.rstrip("/") for o in (settings.app_origin, "http://127.0.0.1:5173", "http://localhost:5173") if o
)


def _ws_origin_allowed(ws: WebSocket, origin: str) -> bool:
    """Origin из списка разрешённых или same-origin (схема + Host запроса).

    Схема берётся из scope (`wss` → `https`, `ws` → `http`; uvicorn с
    --proxy-headers уже учёл X-Forwarded-Proto). Host — заголовок запроса, его
    браузер подделать не может; чужая страница пришлёт свой Origin и не пройдёт.
    """
    if origin in _WS_ALLOWED_ORIGINS:
        return True
    host = (ws.headers.get("host") or "").strip().lower()
    if not host or "/" in host:
        return False
    scheme = "https" if ws.url.scheme in ("wss", "https") else "http"
    return origin.lower() == f"{scheme}://{host}"


@app.websocket("/relay")
async def relay_socket(ws: WebSocket):
    # Enforce WSS in production
    if settings.require_wss:
        origin = str(ws.url)
        if origin.startswith("ws://") and "127.0.0.1" not in origin and "localhost" not in origin:
            await _safe_close(ws, 4403, "WSS required")
            return

    # BE-14: браузер всегда шлёт Origin — чужая страница не должна открывать
    # сокеты на relay. Нативные клиенты (OkHttp, URLSession) Origin не шлют.
    # Кроме MESSENGER_APP_ORIGIN допускается same-origin: Origin совпадает со
    # схемой и Host текущего запроса (сайт доступен и как :8443, и через
    # Cloudflare на :443 — иначе web с другого порта вечно получал 403 до accept).
    ws_origin = (ws.headers.get("origin") or "").strip().rstrip("/")
    if ws_origin and not _ws_origin_allowed(ws, ws_origin):
        # Origin — хост страницы, не персональные данные; без него причину не найти.
        log.warning("relay: ws rejected — foreign origin %s", ws_origin[:128])
        await _safe_close(ws, 4403, "origin_not_allowed")
        return

    # Source the token from headers FIRST — never from the query string,
    # which lands in nginx/proxy access logs and the browser's history.
    #
    # 1. Authorization: Bearer <jwt>     — native clients (iOS, Android).
    # 2. Sec-WebSocket-Protocol: bearer.<jwt> — browser fallback (the WebSocket
    #    constructor cannot set Authorization but CAN pass a sub-protocol).
    # 3. First inbound JSON message `{"type":"auth","token":"..."}`.
    # 4. Query string  — DEPRECATED, gated behind ALLOW_LEGACY_WS_QUERY_TOKEN.
    token = _extract_bearer_from_header(ws.headers.get("authorization", ""))
    selected_protocol: str | None = None
    if not token:
        token, selected_protocol = _extract_protocol_bearer(ws)

    # device_id is ALWAYS generated server-side to prevent spoofing
    # (a client could otherwise hijack another user's push-route by
    # supplying the victim's device_id). Legacy clients may still send
    # a device_id via query string or the auth frame — we silently drop
    # it and hand them a freshly-minted one in `session_ready`.
    client_suggested_device_id = ws.query_params.get("device_id", "") or ""

    await ws.accept(subprotocol=selected_protocol)

    # Fallback: first message carries the token.
    if not token:
        try:
            first_text = await asyncio.wait_for(ws.receive_text(), timeout=WS_AUTH_TIMEOUT_SEC)
            if len(first_text.encode("utf-8")) > WS_MAX_MESSAGE_BYTES:
                raise ValueError("auth frame too large")
            first = json.loads(first_text)
        except (asyncio.TimeoutError, WebSocketDisconnect, json.JSONDecodeError, ValueError):
            log.warning("relay: WS rejected — no token supplied within %ss", WS_AUTH_TIMEOUT_SEC)
            await _safe_close(ws, 4401, "no_token")
            return
        if isinstance(first, dict) and str(first.get("type") or "") == "auth":
            token = str(first.get("token") or "")
            # Note: any `deviceId` / `device_id` in the auth frame is ignored.
            if not client_suggested_device_id:
                client_suggested_device_id = str(
                    first.get("deviceId") or first.get("device_id") or ""
                )
        else:
            log.warning("relay: WS rejected — first message was not auth")
            await _safe_close(ws, 4401, "auth_required")
            return

    # BE-30: токен пришёл в заголовке/sub-protocol, hint в query нет — берём
    # hint из кадра `auth`, который клиенты шлют сразу после open. Раньше он
    # игнорировался, и device_id был случайным на каждое подключение, что
    # делало привязку токена к устройству невозможной. Если первый кадр —
    # не `auth`, он не теряется: обрабатывается первым в основном цикле.
    pending_raw: str | None = None
    if token and not client_suggested_device_id:
        try:
            first_text = await asyncio.wait_for(ws.receive_text(), timeout=WS_HINT_WAIT_SEC)
        except asyncio.TimeoutError:
            first_text = None
        except WebSocketDisconnect:
            return
        if first_text is not None:
            first_obj: Any = None
            if len(first_text.encode("utf-8", errors="ignore")) <= WS_MAX_MESSAGE_BYTES:
                try:
                    first_obj = json.loads(first_text)
                except (json.JSONDecodeError, ValueError):
                    first_obj = None
            if isinstance(first_obj, dict) and str(first_obj.get("type") or "") == "auth":
                client_suggested_device_id = str(
                    first_obj.get("deviceId") or first_obj.get("device_id") or ""
                )
            else:
                pending_raw = first_text

    # Legacy: query string. Accept only if explicitly enabled for a migration
    # window; we warn loudly so operators notice they're still exposed.
    if not token and settings.allow_legacy_ws_query_token:
        token = ws.query_params.get("token", "")
        if token:
            log.warning(
                "relay: WS accepting DEPRECATED query-string token — "
                "upgrade the client; this path will be removed."
            )

    if not token:
        log.warning("relay: WS rejected — no token provided")
        await _safe_close(ws, 4401, "no_token")
        return

    auth = _resolve_token(token)
    if not auth:
        log.warning("relay: WS rejected — invalid/expired token")
        await _safe_close(ws, 4401, "invalid_token")
        return

    number = auth.number
    # Always server-generated — never trust the client-supplied value.
    device_id = _derive_server_device_id(number, client_suggested_device_id)
    has_hint = bool(str(client_suggested_device_id or "").strip())
    # BE-30: токен, выпущенный для устройства, принимается только с этого
    # устройства — иначе украденный токен открывал бы сессии с любым hint.
    if auth.device_id and auth.device_id != device_id:
        if settings.enforce_token_device_binding:
            log.warning("relay: WS rejected — token bound to another device (number=%s)", _hash_pii(number))
            await _safe_close(ws, 4401, "device_mismatch")
            return
        log.warning("relay: token device mismatch tolerated (ENFORCE_TOKEN_DEVICE_BINDING=0) number=%s", _hash_pii(number))
    log.info("relay: WS accepted for number=%s device=%s", _hash_pii(number), device_id)

    # Multi-device: allow multiple simultaneous connections.
    # Serialise the "close old / install new" transition so that two
    # racing reconnects from the same device can't both think they are
    # the replacement and clobber each other's push_tokens slot.
    session_lock = await _acquire_session_lock(number, device_id)
    async with session_lock:
        existing_devices = multi_sessions.get(number, {})
        if device_id in existing_devices:
            old = existing_devices[device_id]
            await _safe_send(old, {"type": "session_replaced", "reason": "same_device_reconnect"})
            try:
                await old.ws.close(code=4001)
            except Exception:
                pass

        # Pre-populate public_key from persistent store so that lookups and
        # message relay work immediately, before the client sends "register".
        # The client will overwrite this with a fresh key via "register" shortly.
        stored_key = registered_keys.get(number)
        session = ClientSession(
            number=number, ws=ws, device_id=device_id, public_key=stored_key,
            auth_token=token, hinted=has_hint,
        )
        _last_seen[number] = time.time()
        sessions[number] = session  # backward compat: always update primary
        if number not in multi_sessions:
            multi_sessions[number] = {}
        multi_sessions[number][device_id] = session
        total_devices = sum(len(d) for d in multi_sessions.values())
        log.info(
            "relay: session opened for number=%s device=%s (devices=%d, users=%d)",
            _hash_pii(number), device_id, total_devices, len(multi_sessions),
        )
        await _safe_send(session, {"type": "session_ready", "number": number, "deviceId": device_id})
        # BE-30: стабильный hint есть, а токен ещё не привязан (или привязан к
        # другому устройству при выключенном enforce) — выдаём привязанный.
        # Прежний токен не удаляем сразу: им могут пользоваться параллельные
        # HTTP-запросы клиента. Он доживает не более _UNBOUND_GRACE_SEC.
        if has_hint and auth.device_id != device_id:
            session.auth_token = _mint_session_token(number, device_id, auth.expires_at)
            _retire_token(token, keep_if_used_by=session)
            await _safe_send(session, {"type": "token_rotated", "token": session.auth_token})

    try:
        while True:
            # Bounded read: refuse anything bigger than WS_MAX_MESSAGE_BYTES
            # before feeding it to json.loads. Also enforce an idle timeout
            # so a half-open TCP connection doesn't leak a file descriptor.
            try:
                if pending_raw is not None:
                    raw_text, pending_raw = pending_raw, None
                else:
                    raw_text = await asyncio.wait_for(ws.receive_text(), timeout=WS_IDLE_TIMEOUT_SEC)
            except asyncio.TimeoutError:
                log.info(
                    "relay: idle timeout number=%s device=%s — closing",
                    _hash_pii(number), device_id,
                )
                await _safe_close(ws, 1000, "idle")
                break
            frame_bytes = raw_text.encode("utf-8", errors="ignore")
            if len(frame_bytes) > WS_MAX_MESSAGE_BYTES:
                log.warning(
                    "relay: oversized frame number=%s device=%s size=%d max=%d",
                    _hash_pii(number), device_id, len(frame_bytes), WS_MAX_MESSAGE_BYTES,
                )
                await _safe_close(ws, 1009, "message_too_large")
                break
            try:
                payload = json.loads(raw_text)
            except (json.JSONDecodeError, ValueError):
                log.warning(
                    "relay: bad_json number=%s device=%s",
                    _hash_pii(number), device_id,
                )
                continue
            if not isinstance(payload, dict):
                continue
            event = str(payload.get("type") or "")

            # Keepalive ping — respond immediately, skip logging
            if event == "ping":
                await _safe_send(session, {"type": "pong"})
                continue

            # BE-09: общий лимит событий сессии и отдельный — на контент номера.
            now_ev = time.time()
            limited = not _ws_event_allowed(session, now_ev)
            if not limited and event in _WS_CONTENT_EVENTS:
                limited = bool(_ip_rate_limit_hit(
                    _ws_content_hits, number,
                    limit=settings.ws_content_rate_limit_per_min, window_sec=60, now=now_ev,
                ))
            if limited:
                if now_ev - session.event_notice_ts >= 1.0:
                    session.event_notice_ts = now_ev
                    await _safe_send(session, {"type": "error", "reason": "rate_limited", "event": event[:32]})
                continue

            # Clients that authenticate via Sec-WebSocket-Protocol or
            # Authorization header may still emit a belt-and-braces `auth`
            # message as the first payload (e.g. because a proxy stripped the
            # sub-protocol). Silently ignore it — the socket is already
            # authenticated, and we don't want to surface a noisy `unknown_type`
            # error back to the client.
            if event == "auth":
                continue

            log.debug("relay: %s << %s", _hash_pii(number), event)

            if event == "disconnect":
                await _safe_close(ws, 1000)
                break

            if event == "register":
                key = _sanitize_public_key(payload.get("publicKey"))
                if not key:
                    await _safe_send(session, {"type": "registered", "status": "invalid_public_key"})
                    continue
                session.public_key = key
                session.capabilities = _normalize_capabilities(payload.get("capabilities"))
                # Update registered_keys to always reflect the primary session's key.
                # This ensures lookup returns a key that the primary device can decrypt.
                primary = sessions.get(number)
                if primary is session or not primary:
                    registered_keys[number] = key
                    registered_capabilities[number] = _normalize_capabilities(payload.get("capabilities"))
                elif not primary.public_key:
                    # Primary has no key yet (register in-flight), update stored
                    registered_keys[number] = key
                    registered_capabilities[number] = _normalize_capabilities(payload.get("capabilities"))
                _register_device(number, session)  # mdev1
                log.info("relay: %s device=%s registered public key (%d chars, is_primary=%s)",
                         _hash_pii(number), session.device_id, len(key), primary is session)
                await _safe_send(session, {"type": "registered", "status": "ok"})
                # Deliver queued offline messages
                await _deliver_offline_queue(number)
                # Notify peers that this user is back online (WEB-11: кроме скрывших статус)
                for other in sessions.values():
                    if number in _presence_hidden:
                        break
                    if other.peer_id == number and other is not session:
                        await _safe_send(other, {"type": "peer_online", "number": number})
                continue

            # ── Push token registration ──
            if event == "register_push":
                push_token = str(payload.get("pushToken") or payload.get("token") or "").strip()
                platform = str(payload.get("platform") or "android")
                if push_token:
                    if number not in push_tokens:
                        push_tokens[number] = {}
                    # Store only ciphertext — memory dumps / persisted state
                    # file reveal Fernet blobs rather than live FCM/APNs tokens.
                    push_tokens[number][session.device_id] = {
                        "token": _encrypt_push_token(push_token),
                        "platform": platform,
                    }
                    log.info("relay: %s registered push token (%s, device=%s)", _hash_pii(number), platform, session.device_id)
                    await _safe_send(session, {"type": "push_registered", "status": "ok"})
                continue

            # AND-15: пользователь выключил push — relay забывает токен устройства.
            if event == "unregister_push":
                device_tokens = push_tokens.get(number)
                if device_tokens and device_tokens.pop(session.device_id, None) is not None:
                    if not device_tokens:
                        push_tokens.pop(number, None)
                    await asyncio.to_thread(_save_state)
                await _safe_send(session, {"type": "push_unregistered", "status": "ok"})
                continue

            # ── Multi-device: get active sessions ──
            if event == "get_sessions":
                device_sessions = multi_sessions.get(number, {})
                sessions_list = []
                for dev_id, dev_session in device_sessions.items():
                    push_info = push_tokens.get(number, {}).get(dev_id, {})
                    plat = push_info.get("platform", "unknown") if isinstance(push_info, dict) else "unknown"
                    sessions_list.append({
                        "deviceId": dev_id,
                        "platform": plat,
                        "lastActive": int(dev_session.connected_at),
                        "current": dev_id == session.device_id,
                    })
                await _safe_send(session, {"type": "sessions_list", "sessions": sessions_list})
                continue

            # ── Multi-device: revoke session ──
            if event == "revoke_session":
                target_device = str(payload.get("deviceId") or "")
                if not target_device:
                    await _safe_send(session, {"type": "error", "reason": "invalid_device_id"})
                    continue
                device_sessions = multi_sessions.get(number, {})
                if target_device == session.device_id:
                    # BE-30 / IOS-17: отзыв собственной сессии (logout / panic).
                    # Удаляем токен этой сессии и выпущенные для её device_id;
                    # другим живым устройствам, делившим этот токен, сразу
                    # выдаём собственные новые. Затем ack и закрытие 4401.
                    old_expiry = {
                        dev: auth_tokens[s.auth_token].expires_at
                        for dev, s in device_sessions.items()
                        if s.auth_token in auth_tokens
                    }
                    # AND-13: плюс заменённые ротацией токены номера в grace-окне —
                    # какой из них был у этого устройства, сервер не знает.
                    own = {session.auth_token} | {
                        t for t, a in auth_tokens.items()
                        if a.number == number and (a.device_id == session.device_id or a.rotated_at)
                    }
                    for t in own:
                        auth_tokens.pop(t, None)
                    push_tokens.get(number, {}).pop(session.device_id, None)
                    _detach_session(number, session)
                    for dev, other in list(device_sessions.items()):
                        if other is session or other.auth_token in auth_tokens:
                            continue
                        expires_at = old_expiry.get(dev, time.time() + settings.auth_token_ttl_sec)
                        other.auth_token = _mint_session_token(number, _session_claim(other), expires_at)
                        await _safe_send(other, {"type": "token_rotated", "token": other.auth_token})
                    registered_devices.get(number, {}).pop(session.device_id, None)  # mdev1
                    _mesh.bump_bridge_generation(number)  # ключи моста номера больше не принимаются
                    _save_state()
                    log.info("relay: %s revoked own session device=%s", _hash_pii(number), session.device_id)
                    await _safe_send(session, {"type": "session_revoked", "deviceId": target_device})
                    try:
                        await ws.close(code=4401, reason="session_revoked")
                    except Exception as exc:  # сокет уже мог быть закрыт клиентом
                        log.debug("relay: close after self-revoke failed: %s", exc)
                    break
                target_session = device_sessions.get(target_device)
                if target_session:
                    # BE-30: отзываем ВСЕ JWT номера — какие из них унёс отзываемый
                    # девайс, сервер достоверно не знает (токен входа и ротации
                    # могли быть общими). Живым устройствам, кроме отозванного,
                    # сразу выдаём собственные новые токены (срок не продлеваем).
                    old_expiry = {
                        dev: auth_tokens[s.auth_token].expires_at
                        for dev, s in device_sessions.items()
                        if s.auth_token in auth_tokens
                    }
                    dropped_tokens = _drop_number_tokens(number)
                    # До первого await — иначе ротация могла бы выдать ей токен.
                    _detach_session(number, target_session)
                    await _safe_send(target_session, {"type": "session_replaced", "reason": "revoked"})
                    try:
                        await target_session.ws.close(code=4401, reason="session_revoked")
                    except Exception:
                        pass
                    # Отозванное устройство не должно получать push'и.
                    push_tokens.get(number, {}).pop(target_device, None)
                    registered_devices.get(number, {}).pop(target_device, None)  # mdev1
                    # Ключ моста мог уйти с отозванным устройством — новое поколение.
                    _mesh.bump_bridge_generation(number)
                    _save_state()
                    for dev, remaining in list(device_sessions.items()):
                        expires_at = old_expiry.get(dev, time.time() + settings.auth_token_ttl_sec)
                        remaining.auth_token = _mint_session_token(number, _session_claim(remaining), expires_at)
                        await _safe_send(remaining, {"type": "token_rotated", "token": remaining.auth_token})
                        if _mesh.is_enabled():
                            await _safe_send(remaining, _mesh.handle_bridge_key_request(number))
                    log.info("relay: %s revoked session device=%s tokens=%d", _hash_pii(number), target_device, dropped_tokens)
                    await _safe_send(session, {"type": "session_revoked", "deviceId": target_device})
                else:
                    await _safe_send(session, {"type": "error", "reason": "device_not_found"})
                continue

            # ── WEB-11: «Скрыть в сети» ──
            if event == "set_presence":
                if payload.get("hidden") is True:
                    _presence_hidden.add(number)
                else:
                    _presence_hidden.discard(number)
                continue

            # ── Profile set/get ──
            if event in {"set_profile", "get_profile"}:
                # BE-07: без лимита get_profile перебирал бы директорию профилей.
                target_number = normalize_number(payload.get("number")) if event == "get_profile" else ""
                if target_number and target_number != number and _ip_rate_limit_hit(
                    _profile_hits, number,
                    limit=settings.profile_rate_limit_per_min, window_sec=60, now=time.time(),
                ):
                    await _safe_send(session, {"type": "error", "reason": "rate_limited", "event": event})
                    continue
                if event == "set_profile" and _ip_rate_limit_hit(
                    _profile_hits, number,
                    limit=settings.profile_rate_limit_per_min, window_sec=60, now=time.time(),
                ):
                    await _safe_send(session, {"type": "error", "reason": "rate_limited", "event": event})
                    continue

            if event == "set_profile":
                display_name = str(payload.get("displayName") or "").strip()[:64]
                status_text = str(payload.get("status") or "").strip()[:128]
                # Reject anything outside https:// or data:image/* — raw input
                # is echoed to peers, and e.g. javascript:... would turn this
                # into stored XSS on the recipient's client.
                avatar_url = _validate_avatar_url(payload.get("avatarUrl"))
                user_profiles[number] = {
                    "displayName": display_name,
                    "status": status_text,
                    "avatarUrl": avatar_url,
                }
                log.info("relay: %s set profile (name_len=%d)", _hash_pii(number), len(display_name))
                await _safe_send(session, {"type": "profile_saved", "status": "ok"})
                continue

            if event == "get_profile":
                target_number = normalize_number(payload.get("number"))
                if not target_number:
                    target_number = number
                profile = user_profiles.get(target_number, {})
                await _safe_send(session, {
                    "type": "profile",
                    "number": target_number,
                    "displayName": profile.get("displayName", ""),
                    "status": profile.get("status", ""),
                    "avatarUrl": profile.get("avatarUrl", ""),
                })
                continue

            # ── Chat settings save/get ──
            if event == "save_chat_settings":
                peer = payload.get("peerNumber", "")
                peer = normalize_number(peer) if peer else ""
                if not peer:
                    await _safe_send(session, {"type": "error", "reason": "invalid peerNumber"})
                else:
                    key = f"{number}:{peer}"
                    color = (payload.get("chatColor") or "")[:32].strip() or None
                    wallpaper = (payload.get("wallpaper") or "")[:500_000].strip() or None
                    chat_settings[key] = {"chatColor": color, "wallpaper": wallpaper}
                    log.debug("relay: %s saved chat settings for peer %s", _hash_pii(number), _hash_pii(peer))
                    await _safe_send(session, {"type": "chat_settings_saved", "status": "ok", "peerNumber": peer})
                continue

            if event == "get_chat_settings":
                peer = payload.get("peerNumber", "")
                if peer:
                    peer = normalize_number(peer) if peer else ""
                    key = f"{number}:{peer}"
                    s = chat_settings.get(key, {})
                    await _safe_send(session, {
                        "type": "chat_settings",
                        "peerNumber": peer,
                        "chatColor": s.get("chatColor"),
                        "wallpaper": s.get("wallpaper"),
                    })
                else:
                    prefix = f"{number}:"
                    all_settings = []
                    for k, v in chat_settings.items():
                        if k.startswith(prefix):
                            pn = k[len(prefix):]
                            all_settings.append({
                                "peerNumber": pn,
                                "chatColor": v.get("chatColor"),
                                "wallpaper": v.get("wallpaper"),
                            })
                    await _safe_send(session, {"type": "chat_settings_all", "settings": all_settings})
                continue

            if event == "lookup":
                now = time.time()
                while session.lookup_window and now - session.lookup_window[0] > 60:
                    session.lookup_window.popleft()
                if len(session.lookup_window) >= settings.lookup_limit_per_minute:
                    await _safe_send(
                        session,
                        {
                            "type": "lookup_result",
                            "targetNumber": payload.get("targetNumber", ""),
                            "online": False,
                            "reason": "rate_limited",
                        },
                    )
                    continue
                session.lookup_window.append(now)

                target = normalize_number(payload.get("targetNumber"))
                if not target:
                    await _safe_send(
                        session,
                        {
                            "type": "lookup_result",
                            "targetNumber": payload.get("targetNumber", ""),
                            "online": False,
                            "reason": "invalid_number",
                        },
                    )
                    continue

                # BE-11: заблокированному отвечаем как про офлайн-номер без
                # ключа — не раскрываем ни блокировку, ни присутствие.
                if _is_blocked(number, target):
                    await _safe_send(session, {
                        "type": "lookup_result",
                        "targetNumber": target,
                        "online": False,
                        "publicKey": None,
                        "capabilities": [],
                    })
                    continue
                peer = _get_any_session(target)
                peer_key = _lookup_public_key(target)
                # A peer is online if they have an active session — don't
                # require public_key to be set, because registration may
                # still be in-flight right after reconnection.  As long as
                # there is a key available (from the current or a previous
                # session) the sender can encrypt.
                is_online = _presence_visible(target)
                # X-08: номера — только как HMAC, без списка онлайн-номеров.
                log.debug(
                    "relay: lookup %s -> %s (online=%s, has_key=%s, stored_key=%s)",
                    _hash_pii(number), _hash_pii(target), is_online,
                    bool(peer and peer.public_key) if peer else False,
                    target in registered_keys,
                )
                await _safe_send(
                    session,
                    {
                        "type": "lookup_result",
                        "targetNumber": target,
                        "online": is_online,
                        "publicKey": peer_key,
                        "capabilities": list(registered_capabilities.get(target, [])),
                        # mdev1: все устройства номера — отправитель шифрует копию на каждое
                        "devices": _lookup_devices(target) if peer_key else [],
                    },
                )
                continue

            # ── Typing indicator ──
            if event == "typing":
                target = normalize_number(payload.get("toNumber"))
                if not target:
                    continue
                if _is_blocked(number, target):
                    continue
                typing_payload = {
                    "type": "typing",
                    "fromNumber": number,
                    "isTyping": bool(payload.get("isTyping", True)),
                }
                await _send_to_all_devices(target, typing_payload)
                continue

            # ── Read receipts ──
            if event == "read_receipt":
                target = normalize_number(payload.get("toNumber"))
                if not target or _is_blocked(number, target):
                    continue
                outbound = {
                    "type": "read_receipt",
                    "fromNumber": number,
                    "messageIds": payload.get("messageIds", []),
                    "timestamp": int(time.time() * 1000),
                }
                await _send_to_all_devices(target, outbound)
                continue

            # ── Delivery receipt ──
            if event == "delivery_receipt":
                target = normalize_number(payload.get("toNumber"))
                if not target or _is_blocked(number, target):
                    continue
                await _send_to_all_devices(target, {
                    "type": "delivery_receipt",
                    "fromNumber": number,
                    "messageIds": payload.get("messageIds", []),
                    "timestamp": int(time.time() * 1000),
                })
                continue

            # ── Message reactions ──
            if event == "reaction":
                target = normalize_number(payload.get("toNumber"))
                reaction_payload = {
                    "type": "reaction",
                    "fromNumber": number,
                    "messageId": payload.get("messageId", ""),
                    "emoji": _sanitize_reaction_emoji(payload.get("emoji", "")),
                    "remove": bool(payload.get("remove", False)),
                    "timestamp": int(time.time() * 1000),
                }
                # Q15: meta1-реакция — эмодзи внутри E2E-blob, relay его только пробрасывает.
                reaction_blob = payload.get("encryptedBlob")
                if isinstance(reaction_blob, dict):
                    if _blob_too_large(reaction_blob):
                        await _safe_send(session, {"type": "error", "reason": "too_large", "event": "reaction"})
                        continue
                    reaction_payload["encryptedBlob"] = reaction_blob
                if target:
                    if not _is_blocked(number, target):
                        reaction_blobs = _sanitize_device_blobs(payload.get("deviceBlobs"))  # mdev1
                        await _send_to_all_devices(target, reaction_payload,
                                                   device_blobs=reaction_blobs if isinstance(reaction_blobs, dict) else None)
                    # Sync reaction to sender's other devices
                    sync_payload = {**reaction_payload, "toNumber": target}
                    await _send_to_all_devices(number, sync_payload, skip_device=session.device_id)
                continue

            # ── Pin/unpin message ──
            if event in {"pin_message", "unpin_message"}:
                target = normalize_number(payload.get("toNumber"))
                message_id = str(payload.get("messageId", ""))
                chat_key = _chat_key(number, target) if target else None
                if not chat_key or not message_id:
                    continue
                # BE-11: заблокированный не может закреплять/откреплять в чате
                # с заблокировавшим. Ему самому эхо уходит как обычно (ниже),
                # чтобы не раскрывать блокировку; пин не сохраняется.
                pin_blocked = _is_blocked(number, target)

                if pin_blocked:
                    pin_event = {
                        "type": "message_pinned" if event == "pin_message" else "message_unpinned",
                        "messageId": message_id,
                        "chatKey": chat_key,
                    }
                    if event == "pin_message":
                        pin_event.update({"pinnedBy": number, "preview": ""})
                    else:
                        pin_event["unpinnedBy"] = number
                    await _send_to_all_devices(number, pin_event)
                    continue

                if event == "pin_message":
                    pins = pinned_messages.setdefault(chat_key, [])
                    if len(pins) >= settings.max_pin_per_chat:
                        await _safe_send(session, {"type": "error", "reason": "too_many_pins"})
                        continue
                    # X-03 / S5: preview — открытый текст сообщения; relay его
                    # не хранит и не пересылает, клиент рендерит из своей истории.
                    if not any(p.message_id == message_id for p in pins):
                        pins.append(PinnedMessage(
                            message_id=message_id,
                            pinned_by=number,
                            pinned_at=time.time(),
                            preview="",
                        ))
                    pin_event = {
                        "type": "message_pinned",
                        "messageId": message_id,
                        "pinnedBy": number,
                        "preview": "",
                    }
                else:
                    pins = pinned_messages.get(chat_key, [])
                    pinned_messages[chat_key] = [p for p in pins if p.message_id != message_id]
                    pin_event = {
                        "type": "message_unpinned",
                        "messageId": message_id,
                        "unpinnedBy": number,
                    }

                pin_event["chatKey"] = chat_key
                # Send pin event to all devices of both users
                await _send_to_all_devices(number, pin_event)
                if target:
                    await _send_to_all_devices(target, pin_event)
                continue

            # ── Get pinned messages ──
            if event == "get_pins":
                target = normalize_number(payload.get("toNumber"))
                chat_key = _chat_key(number, target) if target else None
                if chat_key:
                    pins = pinned_messages.get(chat_key, [])
                    await _safe_send(session, {
                        "type": "pinned_messages",
                        "chatKey": chat_key,
                        "pins": [
                            {"messageId": p.message_id, "pinnedBy": p.pinned_by, "pinnedAt": int(p.pinned_at * 1000), "preview": ""}
                            for p in pins
                        ],
                    })
                continue

            # ── Block / unblock user ──
            if event == "block_user":
                target = normalize_number(payload.get("number"))
                if not target:
                    await _safe_send(session, {"type": "error", "reason": "invalid_number"})
                    continue
                if (target not in blocked_users.get(number, ())
                        and len(blocked_users.get(number, ())) >= settings.max_blocked_per_user):
                    await _safe_send(session, {"type": "error", "reason": "limit", "event": "block_user"})
                    continue
                blocked_users.setdefault(number, set()).add(target)
                log.debug("relay: %s blocked %s", _hash_pii(number), _hash_pii(target))
                await _send_to_all_devices(number, {"type": "user_blocked", "number": target})
                continue

            if event == "unblock_user":
                target = normalize_number(payload.get("number"))
                if not target:
                    await _safe_send(session, {"type": "error", "reason": "invalid_number"})
                    continue
                blocked_users.get(number, set()).discard(target)
                log.debug("relay: %s unblocked %s", _hash_pii(number), _hash_pii(target))
                await _send_to_all_devices(number, {"type": "user_unblocked", "number": target})
                continue

            if event == "block_sync":
                # Q11: union + tombstones; блок-лист — источник правды на клиенте.
                synced, sync_limit = _apply_block_sync(blocked_users, number, payload.get("numbers"), payload.get("unblocked"))
                if sync_limit:
                    await _safe_send(session, {"type": "error", "reason": "limit", "event": "block_sync"})
                log.debug("relay: %s block_sync -> %d blocked", _hash_pii(number), len(synced))
                await _safe_send(session, {"type": "blocked_list", "numbers": synced})
                continue

            if event == "get_blocked":
                blocked = list(blocked_users.get(number, set()))
                await _safe_send(session, {"type": "blocked_list", "numbers": blocked})
                continue

            # ── Delete message (for all) ──
            if event == "message_delete":
                target = normalize_number(payload.get("toNumber"))
                message_ids = payload.get("messageIds", [])
                if not target or not message_ids:
                    continue
                delete_payload = {
                    "type": "message_deleted",
                    "fromNumber": number,
                    "messageIds": message_ids,
                    "timestamp": int(time.time() * 1000),
                }
                if not _is_blocked(number, target):
                    await _send_to_all_devices(target, delete_payload)
                # Sync to sender's other devices
                await _send_to_all_devices(number, delete_payload, skip_device=session.device_id)
                continue

            # ── Edit message ──
            if event == "message_edit":
                target = normalize_number(payload.get("toNumber"))
                message_id = payload.get("messageId", "")
                encrypted_blob = payload.get("encryptedBlob")
                if not target or not message_id or not encrypted_blob:
                    continue
                if _blob_too_large(encrypted_blob):
                    await _safe_send(session, {"type": "error", "reason": "too_large", "event": "message_edit"})
                    continue
                edit_payload = {
                    "type": "message_edited",
                    "fromNumber": number,
                    "messageId": message_id,
                    "encryptedBlob": encrypted_blob,
                    "timestamp": int(time.time() * 1000),
                }
                if not _is_blocked(number, target):
                    edit_blobs = _sanitize_device_blobs(payload.get("deviceBlobs"))  # mdev1
                    await _send_to_all_devices(target, edit_payload,
                                               device_blobs=edit_blobs if isinstance(edit_blobs, dict) else None)
                # Sync to sender's other devices
                await _send_to_all_devices(number, edit_payload, skip_device=session.device_id)
                continue

            # ── Call media toggle (mute/camera) ──
            if event == "call_media_toggle":
                target = normalize_number(payload.get("toNumber"))
                if not target or _is_blocked(number, target, either_way=True):
                    continue
                peer = sessions.get(target)
                if peer:
                    toggle_out: dict[str, Any] = {
                        "type": "call_media_toggle",
                        "fromNumber": number,
                        "audio": bool(payload.get("audio", True)),
                        "video": bool(payload.get("video", False)),
                    }
                    toggle_call_id = _sanitize_call_id(payload.get("callId"))
                    if toggle_call_id:
                        toggle_out["callId"] = toggle_call_id
                    await _safe_send(peer, toggle_out)
                continue

            # ── File / voice message ──
            if event in {"file_message", "voice_message"}:
                target = normalize_number(payload.get("toNumber"))
                if not target:
                    await _safe_send(session, {"type": "error", "reason": "invalid_target"})
                    continue
                if _is_blocked(number, target):
                    await _safe_send(session, {"type": "peer_offline", "toNumber": target})
                    continue

                # Q15: encryptedBlob обязателен; метаданные легаси санитизируются.
                file_blob = payload.get("encryptedBlob")
                if not isinstance(file_blob, dict):
                    await _safe_send(session, {"type": "error", "reason": "invalid_blob"})
                    continue
                if _blob_too_large(file_blob):
                    await _safe_send(session, {"type": "error", "reason": "too_large", "event": event})
                    continue
                outbound: dict[str, Any] = {
                    "type": event,
                    "fromNumber": number,
                    "encryptedBlob": file_blob,
                    "fileName": _sanitize_file_name(payload.get("fileName", "")),
                    "fileSize": _sanitize_file_size(payload.get("fileSize", 0), settings.message_max_blob_bytes),
                    "mimeType": _sanitize_mime_type(payload.get("mimeType", "")),
                    "messageId": payload.get("messageId", ""),
                }
                if event == "voice_message":
                    outbound["duration"] = _sanitize_duration(payload.get("duration", 0))

                peer = _get_any_session(target)
                need_queue = not peer
                if peer:
                    send_ok = await _send_to_all_devices(target, outbound)
                    if not send_ok:
                        need_queue = True
                        log.debug("relay: %s -> %s file/voice send failed, queueing offline", _hash_pii(number), _hash_pii(target))
                if need_queue:
                    queued = _enqueue_offline(number, target, outbound)
                    if queued is True:
                        await _safe_send(session, {
                            "type": "message_queued",
                            "toNumber": target,
                            "messageId": payload.get("messageId", ""),
                        })
                    else:
                        await _safe_send(session, {
                            "type": "queue_overflow",
                            "toNumber": target,
                            "reason": queued or "queue_full",
                            "queueSize": len(offline_queue.get(target, [])),
                            "queueMax": settings.offline_queue_max_per_user,
                        })
                # Sync file/voice to sender's other devices
                sync_msg = {**outbound, "type": "message_sync", "toNumber": target}
                await _send_to_all_devices(number, sync_msg, skip_device=session.device_id)
                continue

            # ── Direct messages + calls (with offline queue) ──
            if event in {"message", "call_offer", "call_answer", "ice_candidate", "call_reject", "call_hangup"}:
                target = normalize_number(payload.get("toNumber"))
                if not target:
                    await _safe_send(session, {"type": "error", "reason": "invalid_target"})
                    continue
                # S10.5: лимит call_offer на номер-отправитель (до блок-чека,
                # чтобы ответ не зависел от факта блокировки).
                if _signal_rate_limited(event, number, call_id=_sanitize_call_id(payload.get("callId")), target=target):
                    await _safe_send(session, {"type": "error", "reason": "rate_limited", "event": event})
                    continue
                # Block check: if sender is blocked by target, silently drop.
                # BE-11/X-04: весь сигналинг звонка режется в обе стороны.
                if _is_blocked(number, target, either_way=(event != "message")):
                    log.warning("relay: BLOCKED %s -> %s (event=%s)", _hash_pii(number), _hash_pii(target), event)
                    if event in {"message", "call_offer"}:
                        # Обычный peer_offline без reason — факт блокировки не раскрываем.
                        await _safe_send(session, {"type": "peer_offline", "toNumber": target})
                    continue
                # Отбой/отклонение — только внутри известного звонка между этой парой номеров;
                # ответ и ICE продлевают пару (длинный звонок), но не создают её.
                if event == "call_offer":
                    _note_call_pair(number, target)
                elif event in {"call_answer", "ice_candidate"}:
                    if _call_pair_known(number, target):
                        _note_call_pair(number, target)
                elif event in {"call_reject", "call_hangup"} and not _call_pair_known(number, target):
                    log.info("relay: drop %s without known call %s -> %s", event, _hash_pii(number), _hash_pii(target))
                    continue
                peer = _get_any_session(target)
                log.debug("relay: %s -> %s session_lookup: peer=%s, in_sessions=%s, in_multi=%s",
                         _hash_pii(number), _hash_pii(target), peer is not None,
                         target in sessions, target in multi_sessions)

                session.peer_id = target

                out_type = {
                    "message": "message",
                    "call_offer": "call_incoming",
                    "call_answer": "call_answer",
                    "ice_candidate": "ice_candidate",
                    "call_reject": "call_reject",
                    "call_hangup": "call_hangup",
                }[event]
                outbound: dict[str, Any] = {"type": out_type, "fromNumber": number}
                for field_name in (
                    "encryptedBlob",
                    "sdp",
                    "candidate",
                    "media",
                    "callId",
                    "replyTo",
                    "forwardFrom",
                    "selfDestruct",
                    "messageId",
                ):
                    if field_name in payload:
                        outbound[field_name] = payload[field_name]
                # X-03 / S5: текст цитаты не проходит через relay.
                if "replyTo" in outbound:
                    safe_reply = _sanitize_reply_to(outbound["replyTo"])
                    if safe_reply:
                        outbound["replyTo"] = safe_reply
                    else:
                        del outbound["replyTo"]
                if "forwardFrom" in outbound:
                    safe_fwd = normalize_number(outbound["forwardFrom"]) if isinstance(outbound["forwardFrom"], str) else None
                    if safe_fwd:
                        outbound["forwardFrom"] = safe_fwd
                    else:
                        del outbound["forwardFrom"]
                # Q10: callId — строка <= 64 символов [A-Za-z0-9_-], иначе вырезается.
                if "callId" in outbound:
                    safe_call_id = _sanitize_call_id(outbound["callId"])
                    if safe_call_id:
                        outbound["callId"] = safe_call_id
                    else:
                        del outbound["callId"]
                # Q5: кап размера encryptedBlob (кадр WS уже ограничен 256 KiB).
                if "encryptedBlob" in outbound and _blob_too_large(outbound["encryptedBlob"]):
                    await _safe_send(session, {"type": "error", "reason": "too_large", "event": event})
                    continue
                # mdev1 (WEB-16): копии сообщения на остальные устройства получателя
                device_blobs = _sanitize_device_blobs(payload.get("deviceBlobs")) if event == "message" else None
                if device_blobs == "too_large":
                    await _safe_send(session, {"type": "error", "reason": "too_large", "event": event})
                    continue

                # Normalize blob: ensure both iv and nonce exist for cross-platform compat
                blob = outbound.get("encryptedBlob")
                if isinstance(blob, dict):
                    if "iv" in blob and "nonce" not in blob:
                        blob["nonce"] = blob["iv"]
                    elif "nonce" in blob and "iv" not in blob:
                        blob["iv"] = blob["nonce"]

                if peer:
                    peer.peer_id = number
                    if event in {"call_offer", "call_answer", "ice_candidate", "call_reject", "call_hangup"}:
                        # Call signaling: send to primary device only (multi-device
                        # broadcast would break WebRTC 1:1 negotiation).
                        send_ok = await _safe_send(peer, outbound)
                        if not send_ok:
                            log.warning("relay: OFFLINE call_send_failed %s -> %s", _hash_pii(number), _hash_pii(target))
                            await _safe_send(session, {"type": "peer_offline", "toNumber": target, "reason": "send_failed"})
                    else:
                        # Messages: send to all devices of the target
                        send_ok = await _send_to_all_devices(target, outbound, device_blobs=device_blobs)
                        if not send_ok and event == "message":
                            # All sends failed (stale sessions) — fall back to offline queue
                            log.warning("relay: OFFLINE stale_session %s -> %s, queueing", _hash_pii(number), _hash_pii(target))
                            queued = _enqueue_offline(number, target, outbound, device_blobs)
                            if queued is True:
                                await _send_to_all_devices(number, {
                                    "type": "message_queued",
                                    "toNumber": target,
                                    "messageId": payload.get("messageId", ""),
                                })
                            else:
                                log.warning("relay: OFFLINE queue_reject %s -> %s reason=%s", _hash_pii(number), _hash_pii(target), queued)
                                await _safe_send(session, {"type": "queue_overflow", "toNumber": target,
                                    "reason": queued,
                                    "queueSize": len(offline_queue.get(target, [])),
                                    "queueMax": settings.offline_queue_max_per_user})
                    # Also sync to sender's other devices (for messages)
                    if event == "message":
                        sync_msg = {**outbound, "type": "message_sync", "toNumber": target}
                        await _send_to_all_devices(number, sync_msg, skip_device=session.device_id)
                    # Send delivery receipt back to sender for messages
                    if event == "message" and payload.get("messageId") and send_ok:
                        await _send_to_all_devices(number, {
                            "type": "delivery_receipt",
                            "fromNumber": target,
                            "messageIds": [payload["messageId"]],
                            "timestamp": int(time.time() * 1000),
                        })
                elif event == "message":
                    # Queue message for offline delivery
                    log.warning("relay: OFFLINE no_session %s -> %s, queueing", _hash_pii(number), _hash_pii(target))
                    queued = _enqueue_offline(number, target, outbound, device_blobs)
                    if queued is True:
                        await _send_to_all_devices(number, {
                            "type": "message_queued",
                            "toNumber": target,
                            "messageId": payload.get("messageId", ""),
                        })
                    else:
                        log.warning("relay: OFFLINE no_session+queue_reject %s -> %s reason=%s", _hash_pii(number), _hash_pii(target), queued)
                        await _safe_send(session, {"type": "queue_overflow", "toNumber": target,
                            "reason": queued,
                            "queueSize": len(offline_queue.get(target, [])),
                            "queueMax": settings.offline_queue_max_per_user})
                else:
                    log.warning("relay: OFFLINE no_session_call %s -> %s event=%s", _hash_pii(number), _hash_pii(target), event)
                    await _safe_send(session, {"type": "peer_offline", "toNumber": target, "reason": "no_session"})
                continue

            # ── Forward message ──
            if event == "forward":
                target = normalize_number(payload.get("toNumber"))
                if not target:
                    await _safe_send(session, {"type": "error", "reason": "invalid_target"})
                    continue
                if _is_blocked(number, target):
                    await _safe_send(session, {"type": "peer_offline", "toNumber": target})
                    continue
                if _blob_too_large(payload.get("encryptedBlob")):
                    await _safe_send(session, {"type": "error", "reason": "too_large", "event": "forward"})
                    continue
                peer = _get_any_session(target)
                outbound = {
                    "type": "message",
                    "fromNumber": number,
                    "encryptedBlob": payload.get("encryptedBlob"),
                    "messageId": payload.get("messageId", ""),
                }
                # X-03: forwardFrom — только нормализованный номер, иначе поле убирается.
                raw_fwd = payload.get("forwardFrom", number)
                safe_fwd_from = normalize_number(raw_fwd) if isinstance(raw_fwd, str) else None
                if safe_fwd_from:
                    outbound["forwardFrom"] = safe_fwd_from
                need_queue = not peer
                if peer:
                    send_ok = await _send_to_all_devices(target, outbound)
                    if send_ok and payload.get("messageId"):
                        await _send_to_all_devices(number, {
                            "type": "delivery_receipt",
                            "fromNumber": target,
                            "messageIds": [payload["messageId"]],
                            "timestamp": int(time.time() * 1000),
                        })
                    elif not send_ok:
                        need_queue = True
                        log.debug("relay: %s -> %s forward send failed, queueing offline", _hash_pii(number), _hash_pii(target))
                if need_queue:
                    queued = _enqueue_offline(number, target, outbound)
                    if queued is True:
                        await _send_to_all_devices(number, {
                            "type": "message_queued",
                            "toNumber": target,
                            "messageId": payload.get("messageId", ""),
                        })
                    else:
                        await _safe_send(session, {
                            "type": "queue_overflow",
                            "toNumber": target,
                            "reason": queued or "queue_full",
                            "queueSize": len(offline_queue.get(target, [])),
                            "queueMax": settings.offline_queue_max_per_user,
                        })
                # Sync forward to sender's other devices
                sync_msg = {**outbound, "type": "message_sync", "toNumber": target}
                await _send_to_all_devices(number, sync_msg, skip_device=session.device_id)
                continue

            # ── Ack offline message ──
            if event == "ack_offline":
                ack_msg_id = str(payload.get("msgId") or "")
                if not ack_msg_id:
                    continue
                queue = offline_queue.get(number)
                if queue:
                    kept: deque[OfflineMessage] = deque()
                    for msg in queue:
                        if msg.msg_id == ack_msg_id:
                            _offline_queue_release(msg)
                        else:
                            kept.append(msg)
                    if kept:
                        offline_queue[number] = kept
                    else:
                        offline_queue.pop(number, None)
                continue

            # ── Screenshot alert ──
            if event == "screenshot_alert":
                target = normalize_number(payload.get("toNumber"))
                if target and not _is_blocked(number, target):
                    await _send_to_all_devices(target, {
                        "type": "screenshot_alert",
                        "fromNumber": number,
                        "timestamp": int(time.time() * 1000),
                    })
                continue

            # ── Burn after read acknowledgment ──
            if event == "burn_read_ack":
                target = normalize_number(payload.get("toNumber"))
                msg_id = payload.get("messageId", "")
                if target and msg_id and not _is_blocked(number, target):
                    await _send_to_all_devices(target, {
                        "type": "burn_read_ack",
                        "fromNumber": number,
                        "messageId": msg_id,
                    })
                continue

            # ── P2P signaling (relay-less mode negotiation) ──
            if event in {"p2p_offer", "p2p_answer", "p2p_ice_candidate"}:
                target = normalize_number(payload.get("toNumber"))
                if not target:
                    await _safe_send(session, {"type": "error", "reason": "invalid_target"})
                    continue
                # BE-11/X-04: P2P раскрывает IP — при блокировке в любую сторону
                # молча дропаем (отправителю ничего, как будто пир не ответил).
                # S10.5: лимит p2p_offer на номер-отправитель.
                if _signal_rate_limited(event, number):
                    await _safe_send(session, {"type": "error", "reason": "rate_limited", "event": event})
                    continue
                if _is_blocked(number, target, either_way=True):
                    continue
                peer = _get_any_session(target)
                if peer:
                    out: dict[str, Any] = {"type": event, "fromNumber": number}
                    p2p_call_id = _sanitize_call_id(payload.get("callId"))
                    if p2p_call_id:
                        out["callId"] = p2p_call_id
                    if "sdp" in payload:
                        out["sdp"] = payload["sdp"]
                    if "candidate" in payload:
                        out["candidate"] = payload["candidate"]
                    await _safe_send(peer, out)
                else:
                    await _safe_send(session, {"type": "peer_offline", "toNumber": target, "reason": "no_session"})
                continue

            # ── Mesh identity registration (T3/T4 transport) ──
            # Identity-layer: clients register their (X25519, Ed25519) mesh
            # keypair and we sign a relay-attestation that mobile peers can
            # verify offline. See backend/mesh.py and §17.3 of the plan.
            # MESH-25 / MESH-07: mesh анонимен — каталог «номер ↔ mesh-ключи» не ведём
            # (регистрация не доказывала владение ключом static, а lookup связывал
            # номер с ключами, по которым узнаётся человек в эфире).
            if event == "mesh_register_identity":
                await _safe_send(session, {"type": "mesh_identity_registered", "status": "error", "reason": "mesh_directory_disabled"})
                continue

            if event == "mesh_identity_lookup":
                await _safe_send(session, {"type": "mesh_identity_lookup_result", "status": "error", "reason": "mesh_directory_disabled"})
                continue

            # Мост v2: ключ моста текущих суток для офлайн-отправки через mesh (§9.2).
            if event == "mesh_bridge_key":
                await _safe_send(session, _mesh.handle_bridge_key_request(number))
                continue

            # PEER_ANNOUNCE — clients announce mesh availability so we can
            # forward the hint to subscribers (presence is best-effort, no
            # persistence, just rate-limited fan-out for now).
            if event == "mesh_announce":
                if not _mesh.is_enabled():
                    await _safe_send(session, {"type": "error", "reason": "mesh_disabled"})
                    continue
                if not _mesh.check_announce_rate_limit(number):
                    await _safe_send(session, {"type": "error", "reason": "rate_limited"})
                    continue
                # Broadcast "I'm up on mesh" to peers we're already talking
                # to (lookup_window has them as recent contacts). v1 is
                # intentionally narrow — full discovery routing is in §11.
                announce = {
                    "type": "mesh_peer_announce",
                    "fromNumber": number,
                    "transports": payload.get("transports") or [],
                    "status": payload.get("status") or "online",
                    "timestampMs": int(time.time() * 1000),
                }
                for peer_session in list(sessions.values()):
                    if peer_session is session:
                        continue
                    if peer_session.peer_id and peer_session.peer_id == number:
                        await _safe_send(peer_session, announce)
                continue

            # mesh_bridge_forward — sender has a peer (the bridge) with
            # internet relay back to a recipient who is offline-on-mesh
            # but reachable through the relay. We treat it as a normal
            # ``message`` once gates pass: deliver to live session OR
            # enqueue offline + fire silent push.
            if event == "mesh_bridge_forward":
                # Мост v2 (wire-spec §9.2): мост пересылает непрозрачный конверт,
                # запечатанный на ключ relay. Отправитель (номер) доказан MAC ключом
                # моста; мост и узлы mesh не видят ни номеров, ни сообщения.
                sealed_b64 = payload.get("sealed")
                sealed: bytes | None = None
                if isinstance(sealed_b64, str) and len(sealed_b64) <= 4 * settings.mesh_bridge_payload_max_bytes:
                    try:
                        sealed = base64.b64decode(sealed_b64, validate=True)
                    except (ValueError, binascii.Error):
                        sealed = None
                ok, reason = _mesh.check_bridge_forward(
                    sender_number=number,
                    target_number="",
                    payload_size_bytes=len(sealed) if sealed else 1,
                )
                if not ok:
                    await _safe_send(session, {"type": "mesh_bridge_forward_ack", "status": "error", "reason": reason})
                    continue
                # Единый ack: мост не узнаёт ни результат проверки, ни онлайн ли получатель (S-29).
                await _safe_send(session, {"type": "mesh_bridge_forward_ack", "status": "ok"})
                if sealed is None:
                    # Легаси-формат с открытым originalSender не доставляем (MESH-01).
                    continue
                try:
                    env, why = _mesh.open_bridge_envelope(sealed, normalize_number)
                except Exception:
                    # Любой сбой разбора конверта не должен рвать сессию моста (review 2.1).
                    env, why = None, "error"
                if env is None:
                    log.info("mesh: bridge envelope rejected (%s)", why)
                    continue
                origin, target = env["from"], env["to"]
                if _is_blocked(origin, target) or _blob_too_large(env["blob"]):
                    continue
                # meshHops не передаём (review 2.4): число хопов и мост — метаданные местоположения.
                relay_payload: dict[str, Any] = {
                    "type": "message",
                    "fromNumber": origin,
                    "encryptedBlob": env["blob"],
                    "messageId": env["messageId"],
                    "_meshBridge": {"v": 2},
                }
                target_session = _get_any_session(target)
                if target_session:
                    await _safe_send(target_session, relay_payload)
                else:
                    _enqueue_offline(origin, target, relay_payload)
                _mesh.commit_bridge_delivery(env)
                continue

            if event == "mesh_wakeup":
                # MESH-25 / S6: каноническое toNumber, старые клиенты — targetNumber.
                target = normalize_number(payload.get("toNumber") or payload.get("targetNumber"))
                if not target:
                    await _safe_send(session, {"type": "error", "reason": "invalid_target"})
                    continue
                ok, reason = _mesh.check_wakeup_budget(
                    sender_number=number, target_number=target
                )
                if not ok:
                    await _safe_send(session, {"type": "mesh_wakeup_ack", "status": "error", "reason": reason})
                    continue
                # Same uniform-ack contract as bridge_forward.
                await _safe_send(session, {"type": "mesh_wakeup_ack", "status": "ok"})
                # BE-11: push заблокировавшему не шлём (ack тот же, молча).
                if _is_blocked(number, target):
                    continue
                _spawn_tracked(
                    _send_push_notification(
                        number,
                        target,
                        {
                            "type": "mesh_wakeup",
                            "messageId": str(payload.get("messageId") or secrets.token_hex(8)),
                        },
                    ),
                    label="mesh_wakeup_push",
                )
                continue

            # mesh_revoke — self-signed key revocation. The signature is
            # produced by the same key being killed, so verification proves
            # the legitimate owner authorised the revocation. We persist
            # the blacklist entry, drop matching identity records, and
            # force-disconnect every live session bound to the dead key.
            if event == "mesh_revoke":
                response, affected = _mesh.handle_revoke(
                    source_key=number, payload=payload
                )
                await _safe_send(session, response)
                if response.get("status") == "ok":
                    if affected:
                        _spawn_tracked(
                            _force_disconnect_revoked(affected, int(payload.get("reason") or 0)),
                            label="mesh_revoke_force_disconnect",
                        )
                    _save_state()
                continue

            await _safe_send(session, {"type": "error", "reason": "unknown_type"})

    except WebSocketDisconnect:
        log.info("relay: %s WebSocket disconnected", _hash_pii(number))
    except Exception as exc:
        log.warning("relay: %s WebSocket error: %s", _hash_pii(number), exc)
    finally:
        _last_seen[number] = time.time()
        # Remove this specific device session — but ONLY if it still points to
        # the same session object.  A rapid reconnect with the same device_id
        # will have already overwritten the entry in multi_sessions before this
        # finally block runs, so we must not blindly pop by device_id.
        device_sessions = multi_sessions.get(number, {})
        if device_sessions.get(session.device_id) is session:
            device_sessions.pop(session.device_id, None)
        if number in multi_sessions and not multi_sessions[number]:
            multi_sessions.pop(number, None)
        # BE-05: лок устройства больше не нужен, если его не занял реконнект.
        if session.device_id not in multi_sessions.get(number, {}):
            _release_session_lock(number, session.device_id)

        current = sessions.get(number)
        if current and current.ws is ws:
            # If this was the primary session, promote another device if available
            remaining = multi_sessions.get(number, {})
            if remaining:
                next_session = next(iter(remaining.values()))
                sessions[number] = next_session
                _sync_registered_from_primary(number, next_session)
                log.info("relay: promoted device %s as primary for %s", next_session.device_id, _hash_pii(number))
            else:
                sessions.pop(number, None)
                log.info("relay: all sessions removed for %s (total=%d)", _hash_pii(number), len(sessions))

        # Only send peer_offline if ALL devices are gone
        if number not in multi_sessions or not multi_sessions[number]:
            if session.peer_id:
                await _safe_send(sessions.get(session.peer_id), {"type": "peer_offline", "number": number, "reason": "disconnect"})


@app.get("/")
async def root(request: Request):
    html = _get_index_html_template()
    nonce = getattr(request.state, "csp_nonce", "")
    if html and nonce:
        html = _inject_nonce_into_html(html, nonce)
    return HTMLResponse(html or "<!-- index.html not found -->")


@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(WEB_DIR / "manifest.webmanifest")


_NO_CACHE = {"Cache-Control": "no-cache"}


def _static_or_404(name: str):
    """sw.js / envelope-v2.js: файл или честный 404 (не index.html), всегда no-cache."""
    f = WEB_DIR / name
    if not f.is_file():
        return JSONResponse({"ok": False, "reason": "not_found"}, status_code=404, headers=_NO_CACHE)
    return FileResponse(f, headers=_NO_CACHE)


@app.get("/sw.js")
async def sw():
    return _static_or_404("sw.js")


@app.get("/envelope-v2.js")
async def envelope_v2_js():
    return _static_or_404("envelope-v2.js")


@app.get("/SECURITY_AUDIT.md")
async def security_audit():
    # S10.9: файла нет — 404, а не 500.
    report = BASE_DIR / "SECURITY_AUDIT.md"
    if not report.is_file():
        return JSONResponse({"ok": False, "reason": "not_found"}, status_code=404)
    return FileResponse(report, media_type="text/markdown; charset=utf-8")


@app.get("/{path:path}")
async def fallback(path: str, request: Request):
    # Early rejection of obvious traversal payloads before touching the FS.
    if not path or path.startswith("/") or ".." in path or "\x00" in path:
        return JSONResponse({"ok": False, "reason": "bad_path"}, status_code=400)
    # PROD-05: выключенные docs не должны отдавать SPA с кодом 200.
    if not settings.enable_api_docs and path.rstrip("/") in _API_DOC_PATHS:
        return JSONResponse({"ok": False, "reason": "not_found"}, status_code=404)
    # INFRA-08: неизвестный /api/* — честный 404 JSON, а не index.html с 200
    # (мониторинг и правила WAF видят реальный ответ).
    if path == "api" or path.startswith("api/") or path == "relay" or path.startswith("relay/"):
        return JSONResponse({"ok": False, "reason": "not_found"}, status_code=404)
    web_dir_resolved = WEB_DIR.resolve()
    target = (WEB_DIR / path).resolve()
    # Strict prefix check (os.sep) — defeats symlink escape that a parent-set
    # membership test would miss (a symlink inside WEB_DIR pointing outside
    # would still pass ``WEB_DIR in target.parents`` because ``resolve()`` is
    # called on the input, not on the components).
    web_dir_str = str(web_dir_resolved)
    target_str = str(target)
    if not (target_str == web_dir_str or target_str.startswith(web_dir_str + os.sep)):
        return JSONResponse({"ok": False, "reason": "forbidden"}, status_code=403)
    if path in ("sw.js", "envelope-v2.js"):
        return _static_or_404(path)
    if target.is_file():
        return FileResponse(target)
    # SPA fallback — serve index.html with nonce
    html = _get_index_html_template()
    nonce = getattr(request.state, "csp_nonce", "")
    if html and nonce:
        html = _inject_nonce_into_html(html, nonce)
    return HTMLResponse(html or "<!-- index.html not found -->")
