"""Phantom Mesh integration — backend slice (T3/T4 transport).

Implements the *identity* and *bridge* primitives that make the mesh fabric
trustworthy without leaking metadata to the relay. The wire/transport layer
(BLE, Wi-Fi Aware, Noise XX) lives in the mobile clients; the relay only
keeps a thin attestation/discovery layer:

* Issue Ed25519 ``relay-attestation`` blobs that bind a phantom number to a
  ``mesh_signing_pub`` + ``mesh_static_pub`` key pair (§17.3 of the plan).
* Resolve mesh identities for friends-of-friends look-ups when the
  device returns to internet (sceanrio C of §4.3).
* Forward bridged messages on behalf of an internet-deprived sender
  through a peer that has connectivity (§4.6 onion-bridge model).
* Issue silent ``mesh_wakeup`` push notifications so backgrounded
  recipients can re-establish a relay socket and pull bridged traffic.

Everything in this module is *additive* — the rest of the relay does not
depend on it. ``handle_*`` helpers expect references to the existing main
state (sessions, push delivery, send wrapper) so we don't have circular
imports and don't duplicate state.

CHECKPOINT (Sess #1, 2026-04-26): wire format & rate-limits match
``MESH_INTEGRATION_PLAN.md`` §4.3, §17.3, §17.18, §17.19, §19.7.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .config import settings


log = logging.getLogger("phantom.relay.mesh")


# ─── Bind context strings (domain separation) ───────────────────────────
# These MUST match the strings used by mobile clients when generating
# Ed25519 signatures and verifying relay attestations. Any drift breaks
# cross-platform interop. See §19.4 (signature domain separation) and
# §17.3 (relay-attestation envelope).

_BIND_CONTEXT = b"phantom-mesh-bind:v1\x00"
_ATTESTATION_CONTEXT = b"phantom-relay-attest:v1\x00"
_REVOKE_CONTEXT = b"phantom-mesh-revoke:v1\x00"

# Replay-cache window for registration nonces (24h, §17.5). Combined with
# the strict timestamp window (settings.mesh_register_timestamp_window_sec)
# this defends against rebroadcast attacks even when the attacker captures
# a valid ``mesh_register_identity`` payload.
_REPLAY_CACHE_TTL_SEC = 24 * 3600

# A revocation record lives 30 days from the moment it was signed by the
# device that owned the key. After that the key is naturally expired
# (well past attestation TTL pivot windows) so we can stop carrying the
# blacklist entry. Matches §S-09 in MESH_INTEGRATION_PLAN.
_REVOCATION_TTL_SEC = 30 * 86400


# ─── In-memory state ────────────────────────────────────────────────────


@dataclass(slots=True)
class MeshIdentity:
    """Persistent record bound to one phantom number.

    ``previous_*`` fields keep the keys from the last rotation alive for
    a short cooldown so peers caching the old keys can transparently
    resolve a sender that has just rotated (§17.18 — max 2 active keys
    simultaneously, current + previous 48h).
    """

    number: str
    mesh_static_pub: str  # base64 raw 32-byte X25519 public key
    mesh_signing_pub: str  # base64 raw 32-byte Ed25519 public key
    signature: str  # base64 raw 64-byte Ed25519 signature over bind blob
    registered_at_ms: int
    expires_at_ms: int  # mesh_attestation_ttl_sec ahead of registered_at_ms
    attestation: str  # base64 raw bytes — the relay-attestation envelope
    rotation_count: int = 0  # how many times this number has rotated keys
    previous_signing_pub: str | None = None
    previous_static_pub: str | None = None
    previous_expires_at_ms: int | None = None  # current_at + 48h


@dataclass(slots=True)
class MeshRevocation:
    """Self-signed revocation for a mesh signing key.

    Holders that observe a revocation packet on the mesh wire (or hit the
    REST endpoint) MUST drop sessions keyed by ``mesh_signing_pub`` and
    refuse to process new packets signed by it until the device rotates
    keys. The relay treats the record as ground truth because the
    signature was produced by the *original* key — only the legitimate
    holder of the secret could have signed the revocation.
    """

    phantom_id_v2: str  # 32-char hex, sha256(number || signing_pub)[:16]
    mesh_signing_pub: str  # base64 raw 32-byte Ed25519 public key (the dead key)
    revoked_at_ms: int
    reason: int  # 0=user_initiated, 1=key_compromise, 2=device_lost, 3=other
    signature: str  # base64 raw 64-byte Ed25519 signature
    expires_at_ms: int  # revoked_at_ms + 30 days


# All keyed by phantom *number* (10-digit normalised form, see normalize_number).
mesh_identities: dict[str, MeshIdentity] = {}

# Revocations keyed by mesh_signing_pub (base64). The signing-pub is the
# stable handle: after a key rotation the same number can have a new
# signing-pub but old one is still in the blacklist for 30 days.
mesh_revocations: dict[str, MeshRevocation] = {}

# Sliding windows for rate-limiting. Per-source is the WS session number
# (or HTTP client IP for REST fallbacks). Per-recipient is the actual
# bridge target (S-14 — battery-drain DoS protection).
_register_window: dict[str, deque[float]] = {}
_lookup_window: dict[str, deque[float]] = {}
_bridge_window: dict[str, deque[float]] = {}
_wakeup_window: dict[str, deque[float]] = {}
_wakeup_recipient_window: dict[str, deque[float]] = {}
# MESH-22: бюджет на пару (отправитель, получатель) — один отправитель не может
# исчерпать общий часовой бюджет получателя.
_wakeup_pair_window: dict[str, deque[float]] = {}
_revoke_window: dict[str, deque[float]] = {}

# Replay cache: maps the registration ``nonce`` to its expiry. Must be
# bounded to keep memory predictable; we evict on every check (lazy GC).
_replay_cache: dict[str, float] = {}

# BE-05: верхняя граница числа ключей в каждом словаре окон/реплей-кэша.
_BUCKET_MAX_KEYS = 50_000


# ─── Relay attestation key (Ed25519) ────────────────────────────────────
#
# The relay holds a long-lived Ed25519 key. Every device-bound mesh
# identity gets a *relay-attestation* signed by it; mobile clients ship
# the public part embedded in the binary (or fetched at first boot via
# /api/mesh/relay-pubkey) so they can verify peers seen for the first
# time without needing to call back to the relay (scenario C of §4.3).
#
# In production the secret MUST be set via MESH_RELAY_ATTESTATION_KEY
# (base64 of 32 raw bytes). For dev we generate an ephemeral one and log
# a warning — clients that pinned the previous public key will reject
# attestations after a relay restart, which is fine for dev but would
# break a real fleet.

_relay_attestation_secret: bytes | None = None
_relay_attestation_public: bytes | None = None


def _ensure_attestation_key() -> tuple[bytes, bytes]:
    """Return (private, public) raw Ed25519 keys, lazy-loaded."""
    global _relay_attestation_secret, _relay_attestation_public
    if _relay_attestation_secret is not None and _relay_attestation_public is not None:
        return _relay_attestation_secret, _relay_attestation_public

    raw = settings.mesh_relay_attestation_key
    if raw:
        try:
            decoded = base64.b64decode(raw, validate=True)
        except Exception as exc:
            raise RuntimeError(
                f"MESH_RELAY_ATTESTATION_KEY is not valid base64: {exc}"
            ) from exc
        if len(decoded) != 32:
            raise RuntimeError(
                "MESH_RELAY_ATTESTATION_KEY must decode to 32 bytes "
                f"(got {len(decoded)})."
            )
        _relay_attestation_secret = decoded
    else:
        if (settings.env_mode or "").lower() == "prod":
            raise RuntimeError(
                "MESH_RELAY_ATTESTATION_KEY must be set in production. "
                "Generate with: "
                "python -c \"import base64,os;print(base64.b64encode(os.urandom(32)).decode())\""
            )
        log.warning(
            "mesh: MESH_RELAY_ATTESTATION_KEY not set — generating ephemeral "
            "Ed25519 key. Mesh attestations issued by THIS process will not "
            "verify after a restart; set the env variable for stable peers."
        )
        _relay_attestation_secret = secrets.token_bytes(32)

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization as _ser

    sk = Ed25519PrivateKey.from_private_bytes(_relay_attestation_secret)
    _relay_attestation_public = sk.public_key().public_bytes(
        encoding=_ser.Encoding.Raw,
        format=_ser.PublicFormat.Raw,
    )
    log.info(
        "mesh: relay attestation pubkey = %s",
        base64.b64encode(_relay_attestation_public).decode("ascii"),
    )
    return _relay_attestation_secret, _relay_attestation_public


def relay_attestation_pubkey_b64() -> str:
    """Public part of the relay attestation key, base64. Safe to expose."""
    _, pub = _ensure_attestation_key()
    return base64.b64encode(pub).decode("ascii")


def is_enabled() -> bool:
    return bool(settings.mesh_enabled)


# ─── Persistence integration helpers ────────────────────────────────────
#
# main.py owns the JSON state file. We expose two helpers that it splices
# into ``_save_state``/``_load_state``. Format:
#
#   "mesh_identities": {
#       "<number>": { "mesh_static_pub": ..., "mesh_signing_pub": ...,
#                     "signature": ..., "registered_at_ms": ...,
#                     "expires_at_ms": ..., "attestation": ...,
#                     "rotation_count": ..., "previous_signing_pub": ...,
#                     "previous_static_pub": ..., "previous_expires_at_ms": ...
#                   },
#       ...
#   }


def dump_state() -> dict[str, Any]:
    """Serialise mesh identities for the persistence file."""
    return {
        n: {
            "mesh_static_pub": ident.mesh_static_pub,
            "mesh_signing_pub": ident.mesh_signing_pub,
            "signature": ident.signature,
            "registered_at_ms": ident.registered_at_ms,
            "expires_at_ms": ident.expires_at_ms,
            "attestation": ident.attestation,
            "rotation_count": ident.rotation_count,
            "previous_signing_pub": ident.previous_signing_pub,
            "previous_static_pub": ident.previous_static_pub,
            "previous_expires_at_ms": ident.previous_expires_at_ms,
        }
        for n, ident in mesh_identities.items()
    }


def dump_revocation_state() -> dict[str, Any]:
    """Serialise mesh revocations for the persistence file."""
    return {
        signing_pub: {
            "phantom_id_v2": rec.phantom_id_v2,
            "revoked_at_ms": rec.revoked_at_ms,
            "reason": rec.reason,
            "signature": rec.signature,
            "expires_at_ms": rec.expires_at_ms,
        }
        for signing_pub, rec in mesh_revocations.items()
    }


def load_state(blob: dict[str, Any]) -> None:
    """Restore mesh identities from the persistence file."""
    if not isinstance(blob, dict):
        return
    restored = 0
    for number, raw in blob.items():
        if not isinstance(raw, dict):
            continue
        try:
            mesh_identities[number] = MeshIdentity(
                number=number,
                mesh_static_pub=str(raw["mesh_static_pub"]),
                mesh_signing_pub=str(raw["mesh_signing_pub"]),
                signature=str(raw["signature"]),
                registered_at_ms=int(raw["registered_at_ms"]),
                expires_at_ms=int(raw["expires_at_ms"]),
                attestation=str(raw["attestation"]),
                rotation_count=int(raw.get("rotation_count", 0)),
                previous_signing_pub=raw.get("previous_signing_pub") or None,
                previous_static_pub=raw.get("previous_static_pub") or None,
                previous_expires_at_ms=(
                    int(raw["previous_expires_at_ms"])
                    if raw.get("previous_expires_at_ms") is not None
                    else None
                ),
            )
            restored += 1
        except (KeyError, ValueError, TypeError) as exc:
            log.warning("mesh: skipping malformed identity for %s: %s", hashlib.sha256(str(number).encode()).hexdigest()[:12], exc)
    if restored:
        log.info("mesh: restored %d identities", restored)


def load_revocation_state(blob: dict[str, Any]) -> None:
    """Restore mesh revocations from the persistence file."""
    if not isinstance(blob, dict):
        return
    restored = 0
    for signing_pub, raw in blob.items():
        if not isinstance(raw, dict):
            continue
        try:
            mesh_revocations[signing_pub] = MeshRevocation(
                phantom_id_v2=str(raw["phantom_id_v2"]),
                mesh_signing_pub=signing_pub,
                revoked_at_ms=int(raw["revoked_at_ms"]),
                reason=int(raw.get("reason", 0)),
                signature=str(raw["signature"]),
                expires_at_ms=int(raw["expires_at_ms"]),
            )
            restored += 1
        except (KeyError, ValueError, TypeError) as exc:
            log.warning("mesh: skipping malformed revocation: %s", exc)
    if restored:
        log.info("mesh: restored %d revocations", restored)


# ─── Crypto helpers ─────────────────────────────────────────────────────


def _b64_decode_strict(value: str, expected_len: int, label: str) -> bytes:
    """Validate-and-decode base64. Raises ValueError on size mismatch."""
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise ValueError(f"{label} is not valid base64: {exc}") from exc
    if len(decoded) != expected_len:
        raise ValueError(
            f"{label} expected {expected_len} bytes, got {len(decoded)}"
        )
    return decoded


def _verify_register_signature(
    *,
    number: str,
    mesh_static_pub_b64: str,
    mesh_signing_pub_b64: str,
    timestamp_ms: int,
    signature_b64: str,
) -> bool:
    """Verify the Ed25519 binding signature for a registration request.

    The signature payload (per §4.3 + §19.4) is:

        BIND_CONTEXT || number || mesh_static_pub || mesh_signing_pub || ts_be8

    where ``ts_be8`` is the 8-byte big-endian millisecond timestamp. Mobile
    clients construct exactly the same buffer before signing.
    """
    try:
        signing_pub = _b64_decode_strict(mesh_signing_pub_b64, 32, "mesh_signing_pub")
        static_pub = _b64_decode_strict(mesh_static_pub_b64, 32, "mesh_static_pub")
        sig = _b64_decode_strict(signature_b64, 64, "signature")
    except ValueError as exc:
        log.info("mesh: register signature pre-check failed: %s", exc)
        return False

    payload = b"".join([
        _BIND_CONTEXT,
        number.encode("ascii"),
        static_pub,
        signing_pub,
        int(timestamp_ms).to_bytes(8, "big", signed=False),
    ])

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    try:
        Ed25519PublicKey.from_public_bytes(signing_pub).verify(sig, payload)
        return True
    except Exception as exc:
        # PROD-09: номер в журнал не пишем — только короткий хэш
        log.warning("mesh: register signature invalid for %s: %s", hashlib.sha256(number.encode()).hexdigest()[:12], exc)
        return False


def _verify_revocation_signature(
    *,
    phantom_id_v2_hex: str,
    revoked_at_ms: int,
    reason: int,
    mesh_signing_pub_b64: str,
    signature_b64: str,
) -> bool:
    """Verify the self-signed revocation envelope.

    The signature payload (per §S-09 + §19.4) is:

        REVOKE_CONTEXT || phantom_id_v2 (16 raw bytes from hex) ||
        revoked_at_ms_be8 || reason_u8 || mesh_signing_pub (32 raw bytes)

    The same key being revoked is the one that signs the revocation —
    this is intentional: only the legitimate owner of the secret could
    have produced the signature, and after broadcasting it becomes
    public knowledge that the key is dead.
    """
    try:
        signing_pub = _b64_decode_strict(mesh_signing_pub_b64, 32, "mesh_signing_pub")
        sig = _b64_decode_strict(signature_b64, 64, "signature")
        phantom_id_v2 = bytes.fromhex(phantom_id_v2_hex)
        if len(phantom_id_v2) != 16:
            raise ValueError("phantom_id_v2 must decode to 16 bytes")
    except ValueError as exc:
        log.info("mesh: revoke signature pre-check failed: %s", exc)
        return False

    payload = b"".join([
        _REVOKE_CONTEXT,
        phantom_id_v2,
        int(revoked_at_ms).to_bytes(8, "big", signed=False),
        int(reason).to_bytes(1, "big", signed=False),
        signing_pub,
    ])

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    try:
        Ed25519PublicKey.from_public_bytes(signing_pub).verify(sig, payload)
        return True
    except Exception as exc:
        log.info("mesh: revoke signature invalid: %s", exc)
        return False


def _issue_relay_attestation(
    *,
    number: str,
    mesh_static_pub_b64: str,
    mesh_signing_pub_b64: str,
    issued_at_ms: int,
    expires_at_ms: int,
) -> str:
    """Sign a relay-attestation envelope. Returns base64-raw bytes.

    Wire layout (verified by mobile clients with the relay public key):

        ATTESTATION_CONTEXT || number || mesh_static_pub || mesh_signing_pub
        || issued_at_ms_be8 || expires_at_ms_be8 || sig(64)

    The body and signature are concatenated and base64-encoded so the
    blob is one opaque field on the wire.
    """
    sk_raw, _ = _ensure_attestation_key()
    static_pub = base64.b64decode(mesh_static_pub_b64)
    signing_pub = base64.b64decode(mesh_signing_pub_b64)
    body = b"".join([
        _ATTESTATION_CONTEXT,
        number.encode("ascii"),
        static_pub,
        signing_pub,
        int(issued_at_ms).to_bytes(8, "big", signed=False),
        int(expires_at_ms).to_bytes(8, "big", signed=False),
    ])
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    sk = Ed25519PrivateKey.from_private_bytes(sk_raw)
    sig = sk.sign(body)
    return base64.b64encode(body + sig).decode("ascii")


# ─── Rate-limiting helpers ──────────────────────────────────────────────


def _slide_window(
    bucket: dict[str, deque[float]],
    key: str,
    *,
    window_sec: float,
    limit: int,
    now: float | None = None,
) -> bool:
    """Generic sliding-window rate-limit. Returns ``True`` if allowed.

    The implementation evicts stale timestamps lazily per call so the
    bucket only grows up to ``limit`` per active key. Caller is
    responsible for choosing meaningful ``key`` (e.g. ``number`` or
    ``ip``).
    """
    if limit <= 0:
        return True
    ts = now if now is not None else time.time()
    window = bucket.setdefault(key, deque())
    cutoff = ts - window_sec
    while window and window[0] < cutoff:
        window.popleft()
    if len(window) >= limit:
        return False
    window.append(ts)
    return True


def _gc_replay_cache(now: float) -> None:
    expired = [n for n, exp in _replay_cache.items() if exp <= now]
    for n in expired:
        _replay_cache.pop(n, None)


# ─── Handler API (called from main.py WebSocket loop) ───────────────────
#
# Each handler returns a dict to send back to the client (or None to send
# nothing). The caller is responsible for transport (await _safe_send).


def handle_register_identity(
    *,
    number: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Process ``mesh_register_identity`` from a client WS session.

    Expected payload fields (all strings unless noted):
        mesh_static_pub  — base64 raw X25519 public key (32 bytes)
        mesh_signing_pub — base64 raw Ed25519 public key (32 bytes)
        signature        — base64 raw Ed25519 signature (64 bytes) over
                           BIND_CONTEXT||number||static_pub||signing_pub||ts_be8
        timestamp_ms     — int, when the client signed (milliseconds since epoch);
                           aliases accepted: timestampMs, timestamp (тоже ms)
        nonce            — string, replay-cache key (32 hex chars or similar)

    Response:
        type: mesh_identity_registered, status: "ok"|"error"
        relayAttestation: base64 (when ok)
        relayPubkey: base64 (when ok) — for clients that need it inline
        expiresAtMs: int (when ok)
        reason: short code (when error)
    """
    if not is_enabled():
        return {"type": "mesh_identity_registered", "status": "error", "reason": "mesh_disabled"}

    static_pub = str(payload.get("mesh_static_pub") or payload.get("meshStaticPub") or "").strip()
    signing_pub = str(payload.get("mesh_signing_pub") or payload.get("meshSigningPub") or "").strip()
    signature = str(payload.get("signature") or "").strip()
    nonce = str(payload.get("nonce") or "").strip()

    try:
        # MESH-25 / S6: каноническое timestamp_ms; Android/iOS исторически
        # шлют то же значение в миллисекундах под именем timestamp.
        timestamp_ms = int(
            payload.get("timestamp_ms")
            or payload.get("timestampMs")
            or payload.get("timestamp")
            or 0
        )
    except (TypeError, ValueError):
        timestamp_ms = 0

    if not static_pub or not signing_pub or not signature or not nonce or timestamp_ms <= 0:
        return {"type": "mesh_identity_registered", "status": "error", "reason": "missing_fields"}

    now = time.time()
    now_ms = int(now * 1000)

    # Timestamp window — protects against capture-then-replay (§17.6).
    drift_ms = abs(now_ms - timestamp_ms)
    window_ms = settings.mesh_register_timestamp_window_sec * 1000
    if drift_ms > window_ms:
        return {"type": "mesh_identity_registered", "status": "error", "reason": "timestamp_out_of_window"}

    # Replay cache — at most one registration per nonce within 24h.
    _gc_replay_cache(now)
    if nonce in _replay_cache:
        return {"type": "mesh_identity_registered", "status": "error", "reason": "nonce_replay"}

    # Per-number rate-limit (§17.18 — keys rotation must be expensive).
    if not _slide_window(
        _register_window,
        number,
        window_sec=86400.0,
        limit=settings.mesh_register_rate_limit_per_day,
        now=now,
    ):
        return {"type": "mesh_identity_registered", "status": "error", "reason": "rate_limited"}

    # Refuse to mint an attestation for a key that the legitimate owner
    # has previously revoked (§S-09). The blacklist persists for 30 days,
    # which forces compromised devices to rotate to a fresh key pair
    # rather than re-registering the burned one.
    if is_revoked(signing_pub):
        return {"type": "mesh_identity_registered", "status": "error", "reason": "key_revoked"}

    # Cryptographic verification (§4.3.A signature).
    if not _verify_register_signature(
        number=number,
        mesh_static_pub_b64=static_pub,
        mesh_signing_pub_b64=signing_pub,
        timestamp_ms=timestamp_ms,
        signature_b64=signature,
    ):
        return {"type": "mesh_identity_registered", "status": "error", "reason": "bad_signature"}

    expires_at_ms = now_ms + settings.mesh_attestation_ttl_sec * 1000
    try:
        attestation_b64 = _issue_relay_attestation(
            number=number,
            mesh_static_pub_b64=static_pub,
            mesh_signing_pub_b64=signing_pub,
            issued_at_ms=now_ms,
            expires_at_ms=expires_at_ms,
        )
    except Exception as exc:
        log.error("mesh: attestation signing failed for %s: %s", number, exc)
        return {"type": "mesh_identity_registered", "status": "error", "reason": "attestation_failed"}

    previous = mesh_identities.get(number)
    rotation_count = (previous.rotation_count + 1) if previous else 0
    # Keep the previous keys alive for 48h so peers caching them still
    # match; new identities can't have a "previous" yet.
    previous_signing_pub: str | None = None
    previous_static_pub: str | None = None
    previous_expires_at_ms: int | None = None
    if previous and previous.mesh_signing_pub != signing_pub:
        previous_signing_pub = previous.mesh_signing_pub
        previous_static_pub = previous.mesh_static_pub
        previous_expires_at_ms = now_ms + 48 * 3600 * 1000

    mesh_identities[number] = MeshIdentity(
        number=number,
        mesh_static_pub=static_pub,
        mesh_signing_pub=signing_pub,
        signature=signature,
        registered_at_ms=now_ms,
        expires_at_ms=expires_at_ms,
        attestation=attestation_b64,
        rotation_count=rotation_count,
        previous_signing_pub=previous_signing_pub,
        previous_static_pub=previous_static_pub,
        previous_expires_at_ms=previous_expires_at_ms,
    )
    _replay_cache[nonce] = now + _REPLAY_CACHE_TTL_SEC

    log.info("mesh: %s registered (rotation=%d)", number[:3] + "***", rotation_count)
    return {
        "type": "mesh_identity_registered",
        "status": "ok",
        "relayAttestation": attestation_b64,
        "relayPubkey": relay_attestation_pubkey_b64(),
        "expiresAtMs": expires_at_ms,
        "rotationCount": rotation_count,
    }


def _serialize_identity(ident: MeshIdentity) -> dict[str, Any]:
    body: dict[str, Any] = {
        "number": ident.number,
        "meshStaticPub": ident.mesh_static_pub,
        "meshSigningPub": ident.mesh_signing_pub,
        "signature": ident.signature,
        # MESH-24: registeredAtMs и rotationCount не отдаём — история ротаций
        # чужого номера никому из клиентов не нужна.
        "expiresAtMs": ident.expires_at_ms,
        "relayAttestation": ident.attestation,
    }
    if ident.previous_signing_pub and ident.previous_expires_at_ms:
        body["previous"] = {
            "meshSigningPub": ident.previous_signing_pub,
            "meshStaticPub": ident.previous_static_pub,
            "expiresAtMs": ident.previous_expires_at_ms,
        }
    return body


def handle_identity_lookup(
    *,
    source_key: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Process ``mesh_identity_lookup`` (single number).

    ``source_key`` is the rate-limit bucket — usually the requester
    number for WS or the IP for REST fallback.
    """
    if not is_enabled():
        return {"type": "mesh_identity_lookup_result", "status": "error", "reason": "mesh_disabled"}

    target = str(payload.get("targetNumber") or payload.get("number") or "").strip()
    if not target:
        return {"type": "mesh_identity_lookup_result", "status": "error", "reason": "missing_target"}

    if not _slide_window(
        _lookup_window,
        source_key,
        window_sec=60.0,
        limit=settings.mesh_lookup_rate_limit_per_minute,
    ):
        return {"type": "mesh_identity_lookup_result", "status": "error", "reason": "rate_limited"}

    ident = mesh_identities.get(target)
    if not ident:
        return {
            "type": "mesh_identity_lookup_result",
            "status": "ok",
            "targetNumber": target,
            "found": False,
        }

    return {
        "type": "mesh_identity_lookup_result",
        "status": "ok",
        "targetNumber": target,
        "found": True,
        "identity": _serialize_identity(ident),
    }


def handle_verify_batch(
    *,
    source_key: str,
    numbers: list[str],
) -> dict[str, Any]:
    """Process ``POST /api/mesh/verify`` — bulk identity resolution.

    Capped at ``settings.mesh_verify_max_batch`` per request. Per-source
    rate-limited so a single client cannot drain the directory.
    """
    if not is_enabled():
        return {"status": "error", "reason": "mesh_disabled"}

    if not isinstance(numbers, list) or not numbers:
        return {"status": "error", "reason": "missing_numbers"}

    if len(numbers) > settings.mesh_verify_max_batch:
        return {"status": "error", "reason": "batch_too_large"}

    # Reuse the per-minute lookup bucket — bulk and single share the same
    # source-side budget so attackers cannot bypass via batching.
    if not _slide_window(
        _lookup_window,
        source_key,
        window_sec=60.0,
        limit=settings.mesh_lookup_rate_limit_per_minute,
    ):
        return {"status": "error", "reason": "rate_limited"}

    results: dict[str, Any] = {}
    for raw in numbers:
        n = str(raw or "").strip()
        if not n:
            continue
        ident = mesh_identities.get(n)
        results[n] = _serialize_identity(ident) if ident else None
    return {"status": "ok", "identities": results}


def check_announce_rate_limit(number: str) -> bool:
    """Pure rate check — main.py decides what to do with announces.

    PEER_ANNOUNCE is reflective info (the user is up, supports certain
    transports). Storing it server-side beyond a short cache makes the
    relay a tracking surface, so we accept-and-fanout without persistence
    at this layer (announces should be re-broadcast through mesh, not
    relay).
    """
    return _slide_window(
        _wakeup_window,  # reuse the wakeup bucket — same physical entity
        f"announce:{number}",
        window_sec=60.0,
        limit=12,
    )


def check_bridge_forward(
    *,
    sender_number: str,
    target_number: str,
    payload_size_bytes: int,
) -> tuple[bool, str | None]:
    """Pre-flight checks for ``mesh_bridge_forward``.

    Returns ``(allowed, reason)``. The actual delivery (look up the
    target's session, push to offline queue, fire silent push) is left
    to main.py because it owns the live session map and offline queue.

    The wire-level payload is opaque (E2E encrypted from sender to
    final recipient — bridge relay does not see plaintext); we still
    bound the byte budget per §17.8 to keep the relay from amplifying
    DoS traffic.
    """
    if not is_enabled():
        return False, "mesh_disabled"
    if payload_size_bytes <= 0:
        return False, "missing_payload"
    if payload_size_bytes > settings.mesh_bridge_payload_max_bytes:
        return False, "payload_too_large"
    if not _slide_window(
        _bridge_window,
        sender_number,
        window_sec=60.0,
        limit=settings.mesh_bridge_forward_rate_limit_per_min,
    ):
        return False, "rate_limited"
    return True, None


def check_wakeup_budget(
    *,
    sender_number: str,
    target_number: str,
) -> tuple[bool, str | None]:
    """Per-source AND per-recipient budget checks for ``mesh_wakeup``.

    The recipient-side cap (§17.14) is the load-bearing one — without it
    a hostile sender could spam wakeups to drain a victim's battery.
    """
    if not is_enabled():
        return False, "mesh_disabled"
    if not _slide_window(
        _wakeup_window,
        sender_number,
        window_sec=60.0,
        limit=settings.mesh_wakeup_rate_limit_per_min,
    ):
        return False, "rate_limited"
    if not _slide_window(
        _wakeup_pair_window,
        f"{sender_number}>{target_number}",
        window_sec=3600.0,
        limit=settings.mesh_wakeup_per_pair_per_hour,
    ):
        return False, "rate_limited"
    if not _slide_window(
        _wakeup_recipient_window,
        target_number,
        window_sec=3600.0,
        limit=settings.mesh_wakeup_per_recipient_per_hour,
    ):
        return False, "recipient_budget_exhausted"
    return True, None


# ─── Cleanup hook (called periodically from main.py cleanup loop) ───────


def cleanup_expired(now: float | None = None) -> None:
    """Drop stale registrations, expired previous-key cooldowns, and expired
    revocations.

    Mesh identities are technically valid until ``expires_at_ms``; after
    that the relay refuses to hand them out (clients must rotate). We
    don't aggressively delete the record — keeping it lets the relay
    answer "yes, this number existed but has expired" — but we do clear
    the previous-key bookkeeping once it lapses to keep memory small.

    Revocations live for 30 days from the moment they were signed. After
    that the underlying signing key has been considered dead long enough
    that the blacklist entry adds no security value.
    """
    ts_ms = int((now if now is not None else time.time()) * 1000)
    for ident in mesh_identities.values():
        if (
            ident.previous_expires_at_ms is not None
            and ident.previous_expires_at_ms <= ts_ms
        ):
            ident.previous_signing_pub = None
            ident.previous_static_pub = None
            ident.previous_expires_at_ms = None

    expired_signing_pubs = [
        sp for sp, rec in mesh_revocations.items() if rec.expires_at_ms <= ts_ms
    ]
    for sp in expired_signing_pubs:
        mesh_revocations.pop(sp, None)

    # BE-05: GC скользящих окон rate-limit'а и реплей-кэша. Окно каждого
    # словаря — максимальное из используемых с ним в _slide_window.
    now_s = ts_ms / 1000.0
    for bucket, window_sec in (
        (_register_window, 86400.0),
        (_lookup_window, 60.0),
        (_bridge_window, 60.0),
        (_wakeup_window, 60.0),  # общий с announce, оба по 60 с
        (_wakeup_recipient_window, 3600.0),
        (_wakeup_pair_window, 3600.0),
        (_revoke_window, 86400.0),
        (_bridge_key_window, 3600.0),
        (_bridge_from_window, 60.0),
    ):
        _prune_window(bucket, window_sec, now_s)
    _gc_replay_cache(now_s)
    _gc_bridge_seen(now_s)
    _cap_keys(_replay_cache, lambda exp: exp)


def _prune_window(bucket: dict[str, deque[float]], window_sec: float, now: float) -> None:
    """Удалить просроченные метки и пустые ключи, затем ограничить размер."""
    cutoff = now - window_sec
    for key in list(bucket.keys()):
        q = bucket.get(key)
        if q is None:
            continue
        while q and q[0] < cutoff:
            q.popleft()
        if not q:
            bucket.pop(key, None)
    _cap_keys(bucket, lambda q: q[-1] if q else 0.0)


def _cap_keys(bucket: dict[str, Any], sort_key: Any) -> None:
    """Выкинуть самые «старые» по ``sort_key`` записи сверх _BUCKET_MAX_KEYS."""
    excess = len(bucket) - _BUCKET_MAX_KEYS
    if excess <= 0:
        return
    victims = sorted(bucket.keys(), key=lambda k: sort_key(bucket[k]))[:excess]
    for key in victims:
        bucket.pop(key, None)


# ─── Revocation API ─────────────────────────────────────────────────────


def is_revoked(mesh_signing_pub_b64: str) -> bool:
    """Return True if the given signing key is on the revocation list."""
    rec = mesh_revocations.get(mesh_signing_pub_b64)
    if rec is None:
        return False
    if rec.expires_at_ms <= int(time.time() * 1000):
        # Lazy GC — entry expired between cleanup runs.
        mesh_revocations.pop(mesh_signing_pub_b64, None)
        return False
    return True


def handle_revoke(
    *,
    source_key: str,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    """Process ``mesh_revoke`` (WS or REST).

    Expected payload fields:
        phantomIdV2     — 32-char hex, sha256(number || signing_pub)[:16]
        meshSigningPub  — base64 raw 32-byte Ed25519 (the revoked key)
        revokedAtMs     — int, milliseconds since epoch
        reason          — int, 0..3 (see MeshRevocation.reason)
        signature       — base64 raw 64-byte Ed25519 self-signature

    Returns ``(response, affected_numbers)`` — affected_numbers is a
    list of phantom numbers whose currently-bound mesh identity matches
    the revoked signing pub. The caller (main.py) uses this list to
    force-disconnect live sessions and notify them of the revocation.

    ``source_key`` is the rate-limit bucket: the registered phantom
    number for WS or the IP for REST.
    """
    if not is_enabled():
        return ({"type": "mesh_revoked_ack", "status": "error", "reason": "mesh_disabled"}, [])

    phantom_id_v2 = str(payload.get("phantomIdV2") or payload.get("phantom_id_v2") or "").strip().lower()
    signing_pub = str(payload.get("meshSigningPub") or payload.get("mesh_signing_pub") or "").strip()
    signature = str(payload.get("signature") or "").strip()

    try:
        revoked_at_ms = int(payload.get("revokedAtMs") or payload.get("revoked_at_ms") or 0)
    except (TypeError, ValueError):
        revoked_at_ms = 0

    try:
        reason = int(payload.get("reason") or 0)
    except (TypeError, ValueError):
        reason = 0

    if not phantom_id_v2 or not signing_pub or not signature or revoked_at_ms <= 0:
        return ({"type": "mesh_revoked_ack", "status": "error", "reason": "missing_fields"}, [])

    if reason < 0 or reason > 3:
        return ({"type": "mesh_revoked_ack", "status": "error", "reason": "invalid_reason"}, [])

    now = time.time()
    now_ms = int(now * 1000)

    # Timestamp window — accept revocations within ±90 days. Wider than
    # registration window because revocations may originate from devices
    # whose clocks have drifted while offline; the signature does the
    # heavy lifting against forgery.
    drift_ms = abs(now_ms - revoked_at_ms)
    if drift_ms > 90 * 86400 * 1000:
        return ({"type": "mesh_revoked_ack", "status": "error", "reason": "timestamp_out_of_window"}, [])

    # Per-source rate-limit — accepts up to N revocations/day to soak up
    # legitimate device-loss flows without letting an attacker enumerate
    # the directory by spamming bogus revocations.
    if not _slide_window(
        _revoke_window,
        source_key,
        window_sec=86400.0,
        limit=settings.mesh_revoke_rate_limit_per_day,
        now=now,
    ):
        return ({"type": "mesh_revoked_ack", "status": "error", "reason": "rate_limited"}, [])

    if not _verify_revocation_signature(
        phantom_id_v2_hex=phantom_id_v2,
        revoked_at_ms=revoked_at_ms,
        reason=reason,
        mesh_signing_pub_b64=signing_pub,
        signature_b64=signature,
    ):
        return ({"type": "mesh_revoked_ack", "status": "error", "reason": "bad_signature"}, [])

    # Idempotent: if we already have a revocation for this key, return
    # ok with the existing record's timestamp so re-broadcasts don't
    # bump the rate-limit counter from the caller's perspective.
    existing = mesh_revocations.get(signing_pub)
    if existing is not None and existing.revoked_at_ms <= revoked_at_ms:
        affected = [n for n, ident in mesh_identities.items() if ident.mesh_signing_pub == signing_pub]
        return (
            {
                "type": "mesh_revoked_ack",
                "status": "ok",
                "phantomIdV2": existing.phantom_id_v2,
                "revokedAtMs": existing.revoked_at_ms,
                "expiresAtMs": existing.expires_at_ms,
                "duplicate": True,
            },
            affected,
        )

    expires_at_ms = revoked_at_ms + _REVOCATION_TTL_SEC * 1000
    mesh_revocations[signing_pub] = MeshRevocation(
        phantom_id_v2=phantom_id_v2,
        mesh_signing_pub=signing_pub,
        revoked_at_ms=revoked_at_ms,
        reason=reason,
        signature=signature,
        expires_at_ms=expires_at_ms,
    )

    # Find every identity record currently bound to the revoked key —
    # we delete them so subsequent lookups return "not found" and the
    # caller can force-disconnect any live session for the same number.
    affected_numbers: list[str] = []
    for n, ident in list(mesh_identities.items()):
        if ident.mesh_signing_pub == signing_pub:
            affected_numbers.append(n)
            # Drop the active record so identity_lookup stops handing it
            # out. The previous-key cooldown is also wiped because the
            # entire identity is dead.
            mesh_identities.pop(n, None)

    log.info(
        "mesh: revoked signing_pub (reason=%d, affected_numbers=%d)",
        reason,
        len(affected_numbers),
    )

    return (
        {
            "type": "mesh_revoked_ack",
            "status": "ok",
            "phantomIdV2": phantom_id_v2,
            "revokedAtMs": revoked_at_ms,
            "expiresAtMs": expires_at_ms,
            "affectedNumbers": len(affected_numbers),
        },
        affected_numbers,
    )


# ─── Анонимный mesh: мост v2 (MESH-01 ч.2, MESH-21, MESH-25) ───────────────
#
# Mesh — анонимная сеть: relay больше не ведёт каталог «номер ↔ mesh-ключи»
# (регистрация и lookup отключены, MESH-25 закрыт удалением). Мосту нужен
# только способ доказать relay, что офлайн-отправитель владеет номером:
#
#   bridge_key(number, epoch) = HMAC-SHA256(K_bridge, "phantom-bridge-key:v1\0" ‖ number ‖ epoch(4 BE))
#
# Клиент получает его по WS (`mesh_bridge_key`), пока онлайн; офлайн подписывает
# им конверт и запечатывает конверт на X25519-ключ relay — узлы mesh и мост видят
# только шифртекст. Формат — wire-spec §9.2, эталон documentation/mesh_bridge_v2_vector.json.

_RELAY_BOX_INFO = b"phantom-relay-box:v1"
_BRIDGE_SECRET_INFO = b"phantom-bridge-secret:v1"
_BRIDGE_KEY_CONTEXT = b"phantom-bridge-key:v1\x00"
_BRIDGE_MAC_CONTEXT = b"phantom-bridge-env:v2\x00"
_BRIDGE_SEAL_INFO = b"phantom-bridge-seal:v2"
_BRIDGE_SEAL_AAD = b"phantom-bridge-seal:v2\x00"
BRIDGE_SCHEMA_V2 = 0x02
BRIDGE_KEY_VALID_DAYS = 7
BRIDGE_TS_PAST_MS = 3600 * 1000
BRIDGE_TS_FUTURE_MS = 600 * 1000
_BRIDGE_SEEN_TTL_SEC = 2 * 3600.0
_BRIDGE_SEEN_MAX = 100_000

_relay_box_secret: Any = None
_relay_box_public: bytes | None = None
_bridge_secret: bytes | None = None
_bridge_seen: dict[str, float] = {}
_bridge_key_window: dict[str, deque[float]] = {}
# Поколение ключа моста на номер (review 2.3): растёт при logout/panic/отзыве устройства —
# все выданные раньше ключи номера перестают приниматься. Хранится в state.json.
bridge_gen: dict[str, int] = {}
# Лимит доставок через мост на отправителя после проверки MAC (review 2.2, 2.8).
_bridge_from_window: dict[str, deque[float]] = {}
BRIDGE_FROM_LIMIT_PER_MIN = 30


def _hkdf32(ikm: bytes, salt: bytes, info: bytes) -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt or None, info=info).derive(ikm)


def _relay_box() -> tuple[Any, bytes]:
    """X25519-ключ relay для запечатанных конвертов моста (из сида аттестации)."""
    global _relay_box_secret, _relay_box_public
    if _relay_box_secret is None or _relay_box_public is None:
        from cryptography.hazmat.primitives import serialization as _ser
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

        seed, _ = _ensure_attestation_key()
        sk = X25519PrivateKey.from_private_bytes(_hkdf32(seed, b"", _RELAY_BOX_INFO))
        _relay_box_secret = sk
        _relay_box_public = sk.public_key().public_bytes(_ser.Encoding.Raw, _ser.PublicFormat.Raw)
    return _relay_box_secret, _relay_box_public


def relay_box_pubkey_b64() -> str:
    _, pub = _relay_box()
    return base64.b64encode(pub).decode("ascii")


def current_bridge_epoch(now: float | None = None) -> int:
    return int((now if now is not None else time.time()) // 86400)


def bridge_key_for(number: str, epoch: int) -> bytes:
    global _bridge_secret
    if _bridge_secret is None:
        seed, _ = _ensure_attestation_key()
        _bridge_secret = _hkdf32(seed, b"", _BRIDGE_SECRET_INFO)
    import hmac as _hmac

    msg = _BRIDGE_KEY_CONTEXT + number.encode("ascii") + int(epoch).to_bytes(4, "big")
    gen = bridge_gen.get(number, 0)
    if gen:
        # Поколение 0 — без суффикса (совместимо с эталоном); иначе gen(4 BE) в конце.
        msg += int(gen).to_bytes(4, "big")
    return _hmac.new(_bridge_secret, msg, hashlib.sha256).digest()


def bump_bridge_generation(number: str) -> None:
    """Отозвать все ключи моста номера (logout/panic/отзыв устройства)."""
    bridge_gen[number] = (bridge_gen.get(number, 0) + 1) & 0xFFFFFFFF


def dump_bridge_gen() -> dict[str, int]:
    return {n: g for n, g in bridge_gen.items() if g}


def load_bridge_gen(blob: Any) -> None:
    if not isinstance(blob, dict):
        return
    for n, g in blob.items():
        if isinstance(n, str) and isinstance(g, int) and not isinstance(g, bool) and 0 < g < 2**32:
            bridge_gen[n] = g


def handle_bridge_key_request(number: str) -> dict[str, Any]:
    """WS ``mesh_bridge_key``: ключ моста текущих суток для аутентифицированного номера."""
    if not is_enabled():
        return {"type": "mesh_bridge_key", "status": "error", "reason": "mesh_disabled"}
    if not _slide_window(_bridge_key_window, number, window_sec=3600.0, limit=30):
        return {"type": "mesh_bridge_key", "status": "error", "reason": "rate_limited"}
    epoch = current_bridge_epoch()
    return {
        "type": "mesh_bridge_key",
        "status": "ok",
        "epoch": epoch,
        "key": base64.b64encode(bridge_key_for(number, epoch)).decode("ascii"),
        "validDays": BRIDGE_KEY_VALID_DAYS,
        "relayBoxPubkey": relay_box_pubkey_b64(),
    }


def _lp(raw: bytes) -> bytes:
    return len(raw).to_bytes(2, "big") + raw


def bridge_mac_input(
    from_number: str, to_number: str, message_id: str, ts_ms: int, epoch: int, blob: bytes
) -> bytes:
    return (
        _BRIDGE_MAC_CONTEXT
        + _lp(from_number.encode("ascii"))
        + _lp(to_number.encode("ascii"))
        + _lp(message_id.encode("ascii"))
        + int(ts_ms).to_bytes(8, "big")
        + int(epoch).to_bytes(4, "big")
        + hashlib.sha256(blob).digest()
    )


def seal_bridge_envelope(inner: bytes, box_pub: bytes, eph_secret: bytes | None = None) -> bytes:
    """Запечатать конверт на ключ relay (клиентская операция; здесь — для тестов и эталона)."""
    from cryptography.hazmat.primitives import serialization as _ser
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

    eph = X25519PrivateKey.from_private_bytes(eph_secret) if eph_secret else X25519PrivateKey.generate()
    eph_pub = eph.public_key().public_bytes(_ser.Encoding.Raw, _ser.PublicFormat.Raw)
    shared = eph.exchange(X25519PublicKey.from_public_bytes(box_pub))
    key = _hkdf32(shared, eph_pub + box_pub, _BRIDGE_SEAL_INFO)
    ct = ChaCha20Poly1305(key).encrypt(b"\x00" * 12, inner, _BRIDGE_SEAL_AAD + eph_pub)
    return bytes([BRIDGE_SCHEMA_V2]) + eph_pub + ct


def _gc_bridge_seen(now: float) -> None:
    for k in [k for k, exp in _bridge_seen.items() if exp <= now]:
        _bridge_seen.pop(k, None)
    if len(_bridge_seen) > _BRIDGE_SEEN_MAX:
        for k, _ in sorted(_bridge_seen.items(), key=lambda kv: kv[1])[: len(_bridge_seen) - _BRIDGE_SEEN_MAX]:
            _bridge_seen.pop(k, None)


def open_bridge_envelope(
    sealed: bytes,
    normalize: Callable[[str | None], str | None],
    now: float | None = None,
) -> tuple[dict[str, Any] | None, str]:
    """Вскрыть и проверить конверт моста v2. Возвращает (конверт, "ok") или (None, причина).

    Порядок: размер/версия → X25519+HKDF+ChaChaPoly → поля → окно времени и эпохи →
    MAC ключом моста заявленного отправителя → dedup (from, messageId).
    """
    import hmac as _hmac
    import json as _json

    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

    ts_now = now if now is not None else time.time()
    if len(sealed) < 1 + 32 + 16 or len(sealed) > settings.mesh_bridge_payload_max_bytes:
        return None, "size"
    if sealed[0] != BRIDGE_SCHEMA_V2:
        return None, "version"
    eph_pub, ct = sealed[1:33], sealed[33:]
    sk, box_pub = _relay_box()
    try:
        shared = sk.exchange(X25519PublicKey.from_public_bytes(eph_pub))
        key = _hkdf32(shared, eph_pub + box_pub, _BRIDGE_SEAL_INFO)
        inner = ChaCha20Poly1305(key).decrypt(b"\x00" * 12, ct, _BRIDGE_SEAL_AAD + eph_pub)
        env = _json.loads(inner.decode("utf-8"))
    except Exception:
        return None, "seal"
    if not isinstance(env, dict) or env.get("v") != 2:
        return None, "fields"
    from_n, to_n = env.get("from"), env.get("to")
    msg_id, ts_ms, epoch = env.get("messageId"), env.get("ts"), env.get("epoch")
    blob_s, mac_b64 = env.get("blob"), env.get("mac")
    if not (
        isinstance(from_n, str) and from_n.isascii() and normalize(from_n) == from_n
        and isinstance(to_n, str) and to_n.isascii() and normalize(to_n) == to_n
        and from_n != to_n
        and isinstance(msg_id, str) and 1 <= len(msg_id) <= 64 and msg_id.isascii() and msg_id.isprintable()
        and isinstance(ts_ms, int) and not isinstance(ts_ms, bool) and 0 <= ts_ms < 2**63
        and isinstance(epoch, int) and not isinstance(epoch, bool) and 0 <= epoch < 2**32
        and isinstance(blob_s, str) and isinstance(mac_b64, str)
    ):
        return None, "fields"
    now_ms = int(ts_now * 1000)
    if ts_ms < now_ms - BRIDGE_TS_PAST_MS or ts_ms > now_ms + BRIDGE_TS_FUTURE_MS:
        return None, "stale"
    cur_epoch = current_bridge_epoch(ts_now)
    if epoch > cur_epoch or epoch <= cur_epoch - BRIDGE_KEY_VALID_DAYS:  # ровно 7 суток: cur-6…cur
        return None, "epoch"
    try:
        mac = base64.b64decode(mac_b64, validate=True)
    except Exception:
        return None, "fields"
    try:
        blob_bytes = blob_s.encode("utf-8")  # одиночный суррогат → UnicodeEncodeError
    except UnicodeEncodeError:
        return None, "fields"
    expected = _hmac.new(
        bridge_key_for(from_n, epoch),
        bridge_mac_input(from_n, to_n, msg_id, ts_ms, epoch, blob_bytes),
        hashlib.sha256,
    ).digest()
    if not _hmac.compare_digest(expected, mac):
        return None, "mac"
    try:
        blob = _json.loads(blob_s)
    except Exception:
        return None, "blob"
    if not isinstance(blob, dict):
        return None, "blob"
    seen_key = f"{from_n}:{msg_id}"
    _gc_bridge_seen(ts_now)
    if seen_key in _bridge_seen:
        return None, "duplicate"
    if not _slide_window(_bridge_from_window, from_n, window_sec=60.0, limit=BRIDGE_FROM_LIMIT_PER_MIN, now=ts_now):
        return None, "rate_limited"
    return {"from": from_n, "to": to_n, "messageId": msg_id, "blob": blob}, "ok"


def commit_bridge_delivery(env: dict[str, Any], now: float | None = None) -> None:
    """Зафиксировать (from, messageId) после доставки/постановки в очередь."""
    ts_now = now if now is not None else time.time()
    _bridge_seen[f"{env['from']}:{env['messageId']}"] = ts_now + _BRIDGE_SEEN_TTL_SEC
