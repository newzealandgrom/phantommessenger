from __future__ import annotations

import json
import os
import secrets as _secrets
from dataclasses import dataclass
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / ".env"


def _load_env_file() -> None:
    if not ENV_FILE.exists():
        return

    # BE-19: значения, уже заданные окружением (systemd EnvironmentFile),
    # имеют приоритет над .env; кавычки и `export` разбираются, а не
    # попадают в значение.
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        if not key or not key.replace("_", "").isalnum() or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        os.environ[key] = value


def _as_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    """Булев флаг из окружения: 0/false/no/off/пусто → False, 1/true/yes/on → True.

    Нераспознанное значение → ``default`` (безопасное умолчание конкретного флага).
    """
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in ("0", "false", "no", "off", ""):
        return False
    if value in ("1", "true", "yes", "on"):
        return True
    return default


def _as_ssl_verify(name: str) -> bool | str:
    raw = os.getenv(name, "1").strip()
    if raw.lower() in ("0", "false", "no"):
        return False
    if raw.lower() in ("1", "true", "yes", ""):
        return True
    return raw  # treat as path to CA bundle


def _as_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


# Non-fatal configuration problems collected at import time and logged once the
# relay starts (config.py has no logger of its own).
STARTUP_WARNINGS: list[str] = []


def _is_static_turn_entry(entry: object) -> bool:
    """True for an ICE entry that ships a permanent TURN username/password."""
    if not isinstance(entry, dict):
        return False
    urls_raw = entry.get("urls") or entry.get("url")
    urls = urls_raw if isinstance(urls_raw, list) else [urls_raw]
    has_turn = any(
        isinstance(u, str) and u.strip().lower().startswith(("turn:", "turns:")) for u in urls
    )
    return has_turn and bool(entry.get("username") or entry.get("credential"))


def _load_turn_urls() -> list[str]:
    """TURN endpoints handed to clients together with an ephemeral credential.

    Deliberately kept out of ICE_SERVERS_JSON: the URLs are static, the
    username/credential pair minted for them never is (see
    ``_issue_turn_credential`` in main.py).
    """
    raw = os.getenv("TURN_URLS", "").strip()
    urls: list[str] = []
    for chunk in raw.split(","):
        url = chunk.strip()
        if url.lower().startswith(("turn:", "turns:")):
            urls.append(url)
    return urls


def _load_ice_servers() -> list[dict]:
    """STUN servers advertised to every client.

    TURN deliberately does NOT live here in a hardened deployment: a static
    username/credential in ICE_SERVERS_JSON is handed to everyone who ever
    opens the app, which turns the relay into a free public proxy (SRV-01).
    TURN is appended per request, with a credential that expires — see
    ``TURN_URLS`` / ``TURN_STATIC_AUTH_SECRET``.
    """
    entries: list[dict] = []
    raw = os.getenv("ICE_SERVERS_JSON", "").strip()
    if raw:
        try:
            payload = json.loads(raw)
            if isinstance(payload, list):
                entries = payload
        except json.JSONDecodeError:
            pass

    if not entries:
        # Default: STUN-only. Without TURN, calls behind symmetric NAT
        # (mobile carriers) may fail — configure TURN_URLS +
        # TURN_STATIC_AUTH_SECRET, which setup.sh does automatically.
        entries = [
            {"urls": ["stun:stun.l.google.com:19302"]},
            {"urls": ["stun:stun1.l.google.com:19302"]},
            {"urls": ["stun:stun.cloudflare.com:3478"]},
        ]

    if os.getenv("TURN_STATIC_AUTH_SECRET", "").strip():
        kept = [e for e in entries if not _is_static_turn_entry(e)]
        if len(kept) != len(entries):
            STARTUP_WARNINGS.append(
                "ICE_SERVERS_JSON still carries a static TURN credential; it was dropped "
                "in favour of ephemeral credentials. Remove it from .env."
            )
        return kept

    if any(_is_static_turn_entry(e) for e in entries):
        STARTUP_WARNINGS.append(
            "ICE_SERVERS_JSON ships a permanent TURN username/credential to every client "
            "— anyone who opens the app owns your relay. Configure TURN_STATIC_AUTH_SECRET "
            "+ TURN_URLS (setup.sh does this) to switch to expiring credentials."
        )
    return entries


_load_env_file()


def _resolve_env_mode() -> str:
    raw = os.getenv("ENV") or os.getenv("MESSENGER_ENV") or ""
    return raw.strip().lower()


# SSRF allow-list for NFT_NUMBERS_API_BASE. Metadata endpoints across all
# major clouds are hard-banned; in prod we additionally refuse RFC1918 /
# loopback / link-local unless the operator explicitly opts in via
# NFT_NUMBERS_ALLOW_PRIVATE=1 (for single-host deployments where the
# Numbers API sits on localhost and the attack surface is the operator
# themselves, not the network).
_SSRF_BANNED_HOSTS: frozenset[str] = frozenset(
    {
        # AWS / GCP / Azure / Alibaba / OpenStack IMDS endpoints.
        "169.254.169.254",
        "fd00:ec2::254",
        "100.100.100.200",
        "metadata.google.internal",
        "metadata.goog",
        "metadata",
    }
)


def _is_loopback_host(host: str) -> bool:
    """Литеральный loopback-адрес или ``localhost`` (без DNS-резолва)."""
    from ipaddress import ip_address

    if host == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def _validate_numbers_api_base(raw: str, env_mode: str) -> str:
    """Reject URLs that would turn the relay into an SSRF proxy.

    Tests the scheme, hostname and — in prod — the IP family. The raw
    string is returned unchanged on success (callers subsequently strip
    the trailing slash). On failure we raise ``RuntimeError`` so the
    process exits before we serve a single request.
    """
    from ipaddress import ip_address
    from urllib.parse import urlparse

    value = (raw or "").strip()
    if not value:
        return value
    try:
        parsed = urlparse(value)
    except ValueError as exc:
        raise RuntimeError(f"NFT_NUMBERS_API_BASE is malformed: {exc}") from exc
    scheme = (parsed.scheme or "").lower()
    if scheme not in {"http", "https"}:
        raise RuntimeError(
            f"NFT_NUMBERS_API_BASE must use http:// or https:// (got scheme={scheme!r})."
        )
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        raise RuntimeError("NFT_NUMBERS_API_BASE has no hostname.")
    if env_mode == "prod" and scheme != "https" and not _is_loopback_host(host):
        # PROD-19: открытый http в проде допустим только до loopback
        # (Numbers API на том же хосте) — трафик не покидает машину.
        raise RuntimeError(
            "NFT_NUMBERS_API_BASE must be https:// in production (ENV=prod) "
            "unless it points at a loopback host (127.0.0.0/8, ::1, localhost)."
        )
    tls_verify_off = os.getenv("NFT_NUMBERS_TLS_VERIFY", "1").strip().lower() in {"0", "false", "no"}
    if scheme == "https" and tls_verify_off and not _is_loopback_host(host):
        # BE-17: без проверки сертификата TLS до внешнего хоста — это MITM на
        # OTP и service-secret. Отключать проверку допустимо только для loopback.
        if env_mode == "prod":
            raise RuntimeError(
                "NFT_NUMBERS_TLS_VERIFY=0 is allowed only for a loopback "
                "NFT_NUMBERS_API_BASE (127.0.0.0/8, ::1, localhost)."
            )
        STARTUP_WARNINGS.append(
            "NFT_NUMBERS_TLS_VERIFY=0 for a non-loopback Numbers API host — dev only."
        )
    if host in _SSRF_BANNED_HOSTS:
        raise RuntimeError(
            f"NFT_NUMBERS_API_BASE points at a cloud metadata endpoint ({host}) — refused."
        )
    allow_private = os.getenv("NFT_NUMBERS_ALLOW_PRIVATE", "0") not in {"0", "false", "False"}
    try:
        ip = ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        if ip in (ip_address("169.254.169.254"), ip_address("100.100.100.200")):
            raise RuntimeError("NFT_NUMBERS_API_BASE points at a metadata IP — refused.")
        if env_mode == "prod":
            # Private / link-local / loopback are acceptable only when the
            # operator explicitly opts in. The common legitimate case is
            # relay + Numbers API on the same host reached via 127.0.0.1.
            if (ip.is_private or ip.is_loopback or ip.is_link_local) and not allow_private:
                raise RuntimeError(
                    f"NFT_NUMBERS_API_BASE host {host} is private/loopback/link-local; "
                    "set NFT_NUMBERS_ALLOW_PRIVATE=1 if this is intentional."
                )
    return value


def _resolve_jwt_secret(env_mode: str) -> str:
    raw = os.getenv("JWT_SECRET", "").strip()
    if raw:
        return raw
    if env_mode == "prod":
        raise RuntimeError(
            "JWT_SECRET must be set in production. "
            "Run `setup.sh` (it generates one automatically) or set it manually in .env."
        )
    # Dev fallback: deterministic-per-process random secret so that dev sessions
    # survive across the process lifetime without forcing the developer to set
    # the variable. Not persisted — every `uvicorn --reload` tick gets a fresh
    # secret, which is exactly what we want for dev.
    return _secrets.token_urlsafe(48)


def _resolve_service_secret(env_mode: str) -> str:
    value = os.getenv("NFT_NUMBERS_SERVICE_SECRET", "").strip()
    if not value and env_mode == "prod":
        raise RuntimeError(
            "NFT_NUMBERS_SERVICE_SECRET must be set in production — otherwise anyone "
            "with network access to the NFT Numbers API can trigger OTP delivery. "
            "Run `setup.sh` to generate one or set it manually in .env."
        )
    return value


_ENV_MODE = _resolve_env_mode()


def _resolve_state_encryption_key(env_mode: str) -> str:
    """PROD-12: Fernet-ключ шифрования state.json (urlsafe-base64, 32 байта).

    Пусто → state.json пишется открытым JSON (прежнее поведение); в проде —
    предупреждение при старте. Невалидный ключ → отказ стартовать: молча
    откатиться на plaintext или потерять уже зашифрованный файл хуже.
    """
    value = os.getenv("STATE_ENCRYPTION_KEY", "").strip()
    if not value:
        if env_mode == "prod":
            STARTUP_WARNINGS.append(
                "STATE_ENCRYPTION_KEY is not set — state.json (profiles, public keys, "
                "block lists, mesh identities) is stored as plain JSON on disk"
            )
        return ""
    try:
        from cryptography.fernet import Fernet

        Fernet(value.encode("utf-8"))
    except Exception as exc:  # noqa: BLE001 — любой сбой разбора = невалидный ключ
        raise RuntimeError(
            "STATE_ENCRYPTION_KEY is not a valid Fernet key (urlsafe-base64, 32 bytes): "
            f"{type(exc).__name__}"
        ) from None
    return value


@dataclass(slots=True, frozen=True)
class Settings:
    host: str
    port: int
    app_origin: str
    env_mode: str
    numbers_api_base: str
    numbers_send_code_path: str
    numbers_verify_code_path: str
    service_secret: str
    service_secret_header: str
    service_name: str
    jwt_secret: str
    auth_token_ttl_sec: int
    otp_ttl_sec: int
    otp_resend_sec: int
    max_verify_attempts: int
    verify_ip_rate_limit: int
    verify_ip_rate_window_sec: int
    verify_backoff_max_sec: int
    lookup_limit_per_minute: int
    media_bitrate_low: int
    media_bitrate_medium: int
    media_bitrate_high: int
    use_mediapipe_blur: bool
    ice_servers: list[dict]
    turn_urls: list[str]
    turn_static_auth_secret: str
    turn_cred_ttl_sec: int
    ice_rate_limit_per_min: int
    offline_queue_ttl_sec: int
    offline_queue_max_per_user: int
    offline_queue_max_global_bytes: int
    offline_queue_max_payload_bytes: int
    max_pin_per_chat: int
    self_destruct_options: list[int]
    require_wss: bool
    numbers_api_verify_ssl: bool | str
    enable_debug_endpoints: bool
    persistence_file: str
    # PROD-12: Fernet-ключ шифрования state.json; пусто → plain JSON.
    state_encryption_key: str
    auth_token_rotation_sec: int
    allow_legacy_ws_query_token: bool
    # Mesh integration (T3/T4 transport, see MESH_INTEGRATION_PLAN.md)
    mesh_enabled: bool
    mesh_relay_attestation_key: str  # Ed25519 secret key (base64), 32 raw bytes; empty → ephemeral
    mesh_attestation_ttl_sec: int  # Lifetime of relay-attestation issued to a mesh-identity
    mesh_register_rate_limit_per_day: int  # Max identity rotations per number/day (S-18)
    mesh_register_timestamp_window_sec: int  # Accept registration timestamps within ±N sec (S-06)
    mesh_lookup_rate_limit_per_minute: int  # GET /api/mesh/identity/{number} per source
    mesh_verify_max_batch: int  # POST /api/mesh/verify max numbers per request
    mesh_bridge_forward_rate_limit_per_min: int  # mesh_bridge_forward per source/min (S-08)
    mesh_bridge_payload_max_bytes: int  # Hard cap on bridged payload size
    mesh_wakeup_rate_limit_per_min: int  # mesh_wakeup per source/min
    mesh_wakeup_per_recipient_per_hour: int  # Global cap on wakeups per recipient (S-14 budget)
    mesh_wakeup_per_pair_per_hour: int  # MESH-22: cap per (sender, recipient) pair
    mesh_revoke_rate_limit_per_day: int  # mesh_revoke per source/day (S-09)
    mesh_pow_difficulty_bits: int  # PoW for CHANNEL_MESSAGE (S-16); 0 disables verification
    # Reverse-proxy chain — за Cloudflare setup.sh выставляет полный CF CIDR,
    # на прямом VPS остаётся только loopback. Используется в _client_ip().
    trusted_proxies: str
    client_ip_header: str  # CF-Connecting-IP за CF, пустая = X-Forwarded-For (default)
    # Необязательный файл с CIDR доверенных прокси (по одному на строку, # — комментарий);
    # мержится с TRUSTED_PROXIES при старте. Удобно для длинного списка CF CIDR.
    trusted_proxies_file: str
    # Swagger/ReDoc/OpenAPI-схема (PROD-05): по умолчанию выключены везде,
    # включаются только явным ENABLE_API_DOCS=1 на dev-стенде.
    enable_api_docs: bool
    # BE-23: лимиты HTTP-fallback отправки сообщений (/api/messages/send).
    message_send_rate_limit_per_min: int  # на номер отправителя
    message_send_ip_rate_limit_per_min: int  # на IP клиента
    # S10 / Q5: максимальный размер encryptedBlob (JSON-сериализация, байт).
    message_max_blob_bytes: int
    # S10.5: лимиты частоты сигналинга на номер-отправитель (окно 60 с).
    call_offer_rate_limit_per_min: int
    p2p_offer_rate_limit_per_min: int
    # S10 / Q11: сохранять ли blocked_users в state.json (до релиза клиентов с block_sync).
    persist_blocked_users: bool
    # Верхняя граница размера блок-листа одного пользователя (защита RAM/state.json).
    max_blocked_per_user: int
    registered_key_ttl_sec: int
    ws_event_rate_per_sec: int
    ws_event_burst: int
    ws_content_rate_limit_per_min: int
    profile_rate_limit_per_min: int
    otp_global_limit_per_hour: int
    # BE-30: токен с claim device_id принимается только с того же устройства.
    # Выключать (0) только на время раскатки клиентов без стабильного hint.
    enforce_token_device_binding: bool


settings = Settings(
    host=os.getenv("MESSENGER_HOST", "0.0.0.0"),
    port=_as_int("MESSENGER_PORT", 8787),
    app_origin=os.getenv("MESSENGER_APP_ORIGIN", "http://127.0.0.1:8787"),
    env_mode=_ENV_MODE,
    numbers_api_base=_validate_numbers_api_base(
        os.getenv("NFT_NUMBERS_API_BASE", "http://127.0.0.1:8000"),
        _ENV_MODE,
    ).rstrip("/"),
    numbers_send_code_path=os.getenv("NFT_NUMBERS_SEND_CODE_PATH", "/api/request-code"),
    numbers_verify_code_path=os.getenv("NFT_NUMBERS_VERIFY_CODE_PATH", "/api/verify-code"),
    service_secret=_resolve_service_secret(_ENV_MODE),
    service_secret_header=os.getenv("NFT_NUMBERS_SERVICE_SECRET_HEADER", "X-Service-Secret"),
    service_name=os.getenv("MESSENGER_SERVICE_NAME", "phantom-messenger"),
    jwt_secret=_resolve_jwt_secret(_ENV_MODE),
    auth_token_ttl_sec=_as_int("MESSENGER_TOKEN_TTL_SEC", 7200),
    otp_ttl_sec=_as_int("OTP_TTL_SEC", 300),
    otp_resend_sec=_as_int("OTP_RESEND_SEC", 60),  # как в .env.example
    max_verify_attempts=_as_int("MAX_VERIFY_ATTEMPTS", 10),
    verify_ip_rate_limit=_as_int("VERIFY_IP_RATE_LIMIT", 30),
    verify_ip_rate_window_sec=_as_int("VERIFY_IP_RATE_WINDOW_SEC", 60),
    verify_backoff_max_sec=_as_int("VERIFY_BACKOFF_MAX_SEC", 600),
    lookup_limit_per_minute=_as_int("LOOKUP_RATE_LIMIT_PER_MINUTE", 5),
    media_bitrate_low=_as_int("MEDIA_BITRATE_LOW_BPS", 250_000),
    media_bitrate_medium=_as_int("MEDIA_BITRATE_MEDIUM_BPS", 700_000),
    media_bitrate_high=_as_int("MEDIA_BITRATE_HIGH_BPS", 1_500_000),
    use_mediapipe_blur=os.getenv("ENABLE_MEDIAPIPE_BLUR", "1") not in {"0", "false", "False"},
    ice_servers=_load_ice_servers(),
    turn_urls=_load_turn_urls(),
    turn_static_auth_secret=os.getenv("TURN_STATIC_AUTH_SECRET", "").strip(),
    # Lifetime of a minted TURN credential. coturn caps a relay session to the
    # remaining lifetime of the credential it was allocated with, so this is
    # also the longest a single relayed call runs before an ICE restart has to
    # pick up a fresh one — clients refresh well before that.
    turn_cred_ttl_sec=_as_int("TURN_CRED_TTL_SEC", 3600),
    # Cap on credential minting per source IP (GET /api/ice, /api/config).
    ice_rate_limit_per_min=_as_int("ICE_RATE_LIMIT_PER_MINUTE", 60),
    offline_queue_ttl_sec=_as_int("OFFLINE_QUEUE_TTL_SEC", 86400),
    offline_queue_max_per_user=_as_int("OFFLINE_QUEUE_MAX_PER_USER", 100),
    # Global cap on the total size of the offline queue across ALL users.
    # Prevents OOM-DoS (10k users × 100 msg × 1 MB = 1 TB RAM without a cap).
    # 128 МиБ по умолчанию: прод-юнит ограничен MemoryMax=512M.
    offline_queue_max_global_bytes=_as_int("OFFLINE_QUEUE_MAX_GLOBAL_BYTES", 128 * 1024 * 1024),
    # Per-payload cap — enforced BEFORE adding to the queue, so a single
    # oversized message cannot push the global budget over the limit.
    offline_queue_max_payload_bytes=_as_int("OFFLINE_QUEUE_MAX_PAYLOAD_BYTES", 1024 * 1024),
    max_pin_per_chat=_as_int("MAX_PIN_PER_CHAT", 50),
    self_destruct_options=[5, 30, 60, 300, 3600],
    # Default ON in production (prevents metadata MITM on cafe/airport Wi-Fi).
    # Explicit REQUIRE_WSS=0 is respected for dev/local bind-mount scenarios.
    require_wss=os.getenv(
        "REQUIRE_WSS",
        "0" if _ENV_MODE in ("", "dev", "development", "test") else "1",
    ) not in {"0", "false", "False"},
    numbers_api_verify_ssl=_as_ssl_verify("NFT_NUMBERS_TLS_VERIFY"),
    enable_debug_endpoints=os.getenv("ENABLE_DEBUG_ENDPOINTS", "0") not in {"0", "false", "False"},
    persistence_file=os.getenv("PERSISTENCE_FILE", str(BASE_DIR / "data" / "state.json")),
    state_encryption_key=_resolve_state_encryption_key(_ENV_MODE),
    auth_token_rotation_sec=_as_int("AUTH_TOKEN_ROTATION_SEC", 3600),
    allow_legacy_ws_query_token=os.getenv("ALLOW_LEGACY_WS_QUERY_TOKEN", "0") not in {"0", "false", "False"},
    # Mesh defaults — conservative limits chosen per MESH_INTEGRATION_PLAN.md §17.
    # Operators can disable mesh entirely with MESH_ENABLED=0 to keep the relay
    # surface minimal until clients ship the v1.1 integration.
    mesh_enabled=os.getenv("MESH_ENABLED", "1") not in {"0", "false", "False"},
    mesh_relay_attestation_key=os.getenv("MESH_RELAY_ATTESTATION_KEY", "").strip(),
    mesh_attestation_ttl_sec=_as_int("MESH_ATTESTATION_TTL_SEC", 90 * 86400),  # 90 days
    mesh_register_rate_limit_per_day=_as_int("MESH_REGISTER_RATE_LIMIT_PER_DAY", 2),
    mesh_register_timestamp_window_sec=_as_int("MESH_REGISTER_TIMESTAMP_WINDOW_SEC", 120),
    mesh_lookup_rate_limit_per_minute=_as_int("MESH_LOOKUP_RATE_LIMIT_PER_MINUTE", 30),
    mesh_verify_max_batch=_as_int("MESH_VERIFY_MAX_BATCH", 100),
    mesh_bridge_forward_rate_limit_per_min=_as_int("MESH_BRIDGE_FORWARD_RATE_LIMIT_PER_MIN", 30),
    mesh_bridge_payload_max_bytes=_as_int("MESH_BRIDGE_PAYLOAD_MAX_BYTES", 8192),
    mesh_wakeup_rate_limit_per_min=_as_int("MESH_WAKEUP_RATE_LIMIT_PER_MIN", 5),
    mesh_wakeup_per_recipient_per_hour=_as_int("MESH_WAKEUP_PER_RECIPIENT_PER_HOUR", 5),
    mesh_wakeup_per_pair_per_hour=_as_int("MESH_WAKEUP_PER_PAIR_PER_HOUR", 2),
    mesh_revoke_rate_limit_per_day=_as_int("MESH_REVOKE_RATE_LIMIT_PER_DAY", 5),
    mesh_pow_difficulty_bits=_as_int("MESH_POW_DIFFICULTY_BITS", 18),
    trusted_proxies=os.getenv("TRUSTED_PROXIES", "127.0.0.1/32,::1").strip(),
    client_ip_header=os.getenv("CLIENT_IP_HEADER", "").strip(),
    trusted_proxies_file=os.getenv("TRUSTED_PROXIES_FILE", "").strip(),
    enable_api_docs=_env_bool("ENABLE_API_DOCS", False),
    message_send_rate_limit_per_min=_as_int("MESSAGE_SEND_RATE_LIMIT_PER_MIN", 60),
    message_send_ip_rate_limit_per_min=_as_int("MESSAGE_SEND_IP_RATE_LIMIT_PER_MIN", 120),
    message_max_blob_bytes=_as_int("MESSAGE_MAX_BLOB_BYTES", 262144),
    call_offer_rate_limit_per_min=_as_int("CALL_OFFER_RATE_LIMIT_PER_MIN", 10),
    p2p_offer_rate_limit_per_min=_as_int("P2P_OFFER_RATE_LIMIT_PER_MIN", 30),
    persist_blocked_users=_env_bool("PERSIST_BLOCKED_USERS", True),
    max_blocked_per_user=_as_int("MAX_BLOCKED_PER_USER", 2000),
    # BE-15: ключ номера, не появлявшегося дольше TTL, удаляется из registered_keys.
    # BE-09: общий token-bucket на WS-сессию + окно на контентные события номера.
    ws_event_rate_per_sec=max(_as_int("WS_EVENT_RATE_PER_SEC", 30), 1),
    ws_event_burst=max(_as_int("WS_EVENT_BURST", 200), 10),
    ws_content_rate_limit_per_min=max(_as_int("WS_CONTENT_RATE_LIMIT_PER_MIN", 120), 10),
    # BE-07: get_profile/set_profile на номер (свой профиль — без лимита на чтение).
    # BE-21: суммарный исход OTP по всем IP в час.
    otp_global_limit_per_hour=max(_as_int("OTP_GLOBAL_LIMIT_PER_HOUR", 600), 10),
    profile_rate_limit_per_min=max(_as_int("PROFILE_RATE_LIMIT_PER_MIN", 30), 5),
    registered_key_ttl_sec=max(_as_int("REGISTERED_KEY_TTL_SEC", 180 * 86400), 7 * 86400),
    enforce_token_device_binding=_env_bool("ENFORCE_TOKEN_DEVICE_BINDING", True),
)
