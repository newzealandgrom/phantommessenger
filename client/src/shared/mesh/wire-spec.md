# PhantomMeshPacket — wire-format spec (v1)

> **Single source of truth** for the BLE / Wi-Fi Aware over-the-air format.
> All three platforms (Kotlin Android, Swift iOS, TypeScript web bridge) MUST
> produce **byte-for-byte identical** packets given the same inputs. The
> deterministic test vector at the bottom is the conformance check.
>
> See `MESH_INTEGRATION_PLAN.md` §4.2, §17.4, §19.4 for the rationale.

## 1. Field layout (all multi-byte values are big-endian)

| Offset | Size | Field                  | Notes |
|-------:|-----:|------------------------|-------|
|     0  |   1  | `version`              | `0x01` for this spec |
|     1  |   1  | `type`                 | One of `MessageType` (§3) |
|     2  |   1  | `ttl`                  | initial TTL (≤15); receivers decrement |
|     3  |   1  | `flags`                | bit-field (§4) |
|     4  |   8  | `timestamp_ms`         | unsigned milliseconds since epoch |
|    12  |   8  | `seq`                  | per-sender monotonic counter |
|    20  |   8  | `packet_id`            | random; bloom-filter dedup key |
|    28  |  16  | `sender_phantom_id`    | `phantom_id` v3 (§5) |
|    44  |  16  | `recipient_phantom_id` | all-zeros = broadcast |
|    60  |   2  | `payload_len`          | length of `payload` in bytes |
|    62  |   N  | `payload`              | `N == payload_len`, opaque to router |
|  62+N  |  64  | `signature`            | Ed25519, present iff `flags.signed` |
| 62+N+(64?) | M  | `padding`              | PKCS#7 over a fixed bucket (§6); present iff `flags.padded` |

Fixed header is **62 bytes**. Minimum packet (no payload, unsigned, unpadded) is therefore 62 bytes.

## 2. Reserved field ranges

* `version` MUST be `0x01`. Decoders reject other values.
* `ttl` MUST be `1..15`. The router decrements before retransmit; if `ttl == 0` the packet is dropped without forwarding.

## 3. `MessageType` (one byte)

| Value | Name                          | Description |
|-----:|--------------------------------|-------------|
| 0x01 | `TEXT_MESSAGE`                 | Encrypted ChatMessage payload |
| 0x02 | `ACK_DELIVERED`                | Delivery receipt |
| 0x03 | `ACK_READ`                     | Read receipt |
| 0x04 | `NOISE_HANDSHAKE_INIT`         | Noise XX message 1 |
| 0x05 | `NOISE_HANDSHAKE_RESP`         | Noise XX message 2 |
| 0x06 | `NOISE_HANDSHAKE_FINAL`        | Noise XX message 3 |
| 0x07 | `PEER_ANNOUNCE`                | Signed presence beacon |
| 0x08 | `IDENTITY_CHALLENGE`           | Verify request (§4.3 scenario C) |
| 0x09 | `IDENTITY_PROOF`               | Verify response with attestation |
| 0x0A | `PING`                         | Liveness probe |
| 0x0B | `PONG`                         | Liveness response |
| 0x0C | `STORE_FORWARD_OFFER`          | "I have N pending for X" |
| 0x0D | `STORE_FORWARD_REQUEST`        | "Send me what you have for X" |
| 0x0E | `BRIDGE_FORWARD`               | Onion-wrapped relay carriage |
| 0x10 | `FILE_OFFER`                   | (Wi-Fi Aware) file metadata |
| 0x11 | `FILE_CHUNK`                   | (Wi-Fi Aware) file slice |
| 0x12 | `CHANNEL_MESSAGE`              | broadcast (#mesh, #geohash) — PoW required (§S-16) |
| 0x13 | `REACTION`                     | Emoji reaction to a target message (Сессия #9 §25.2) |
| 0x14 | `MESH_KEY_REVOCATION`          | Self-signed revocation (§S-09) |
| 0x15 | `TYPING`                       | Typing indicator for DM, no payload (Сессия #9 §25.2) |
| 0x16 | `VOICE_MESSAGE`                | PTT voice clip, AAC 8 kHz mono 8 kbps ≤ 5 sec (Сессия #9 §25.3) |
| 0x17 | `PHOTO_MESSAGE`                | Heavy-compressed JPEG thumbnail (Сессия #9 §25.3 Tier 3) |

> `0x0F EMERGENCY_WIPE_SIGNAL` is **reserved-but-forbidden** in MVP per §17 S-33 — decoders MUST reject packets with `type == 0x0F`.

### 3.1 Payload formats for new types (Сессия #9)

#### `0x13 REACTION` — emoji reaction to a target message
```
1B target_id_len || target_id_hex_ascii (≤255B) ||
1B emoji_len || emoji_utf8 (≤255B)
```
Recipient is the room/peer that owns the target message. Dedup by `(sender_phantom_id, emoji)` per target. Re-pressing the same emoji is a no-op.

#### `0x14 MESH_KEY_REVOCATION` — self-signed key revocation (§S-09)
```
1B schema_version (=0x01) || 16B phantom_id_v2 ||
8B revoked_at_ms_be || 1B reason ||
32B mesh_signing_pub || 64B Ed25519 signature
```
Total payload = 122 bytes. The signature covers `domain || phantom_id_v2 || revoked_at_ms_be || reason || mesh_signing_pub` where `domain = "phantom-mesh-revoke:v1\0"`. Reason: `0=Manual, 1=KeyRotation, 2=DeviceLost, 3=Other`. Local TTL on each receiver: 30 days. Recipient = `0x00 × 16` (broadcast).

#### `0x15 TYPING` — DM typing indicator
Empty payload. Recipient = peer's `phantom_id_v2`. **Signed plaintext — never sent inside Noise.** The Noise transport nonce is implicit and strictly sequential; a single-packet TYPING overtaking the fragments of a media DM desynchronised the counter and silently killed the DM session. Receivers require `verified` only (§7.1); the "is typing" metadata is visible to radio neighbours (accepted). Sender throttles to one packet per 3 seconds per peer. Receiver auto-expires the indicator after 5 seconds if no fresh ping.

#### `0x16 VOICE_MESSAGE` — PTT voice clip
```
1B codec_id (=0x01 AAC-LC) || 4B duration_ms_be || N bytes audio_data
```
Encoded via Noise XX session. Default: AAC-LC 8 kHz mono 8 kbps, max 5 seconds. Caps: ~5500 audio bytes (fits in one mesh fragment-group of 16 × 373 B = 5968 B minus 5 B header). Voice is **not queued** behind a pending Noise handshake — clips go stale.

#### `0x17 PHOTO_MESSAGE` — heavy-compressed JPEG thumbnail
```
1B format (=0x01 JPEG) || 2B width_be || 2B height_be || N bytes JPEG
```
Encoded via Noise XX session. Iterative compression target ≤ 5500 bytes (fits one mesh fragment-group). Typical: 200×200 px @ JPEG quality 30 ≈ 3-6 KB. Full-resolution sharing planned via Wi-Fi Aware NDP (Phase 5).

### 3.2 §S-13 padding randomisation (Сессия #9)

The encoder picks the smallest enclosing `paddingBuckets` size **most of the time**, but with probability **1/4** steps up to the next bucket. Without this, a passive observer groups packets by size class (128/256/512/…) and learns the size distribution. The 1/4 step-up makes a 100-byte payload sometimes ride 128 B, sometimes 256 B, with no way to know which class the original sat in.

Bandwidth cost: ~25% larger packets on average. The PKCS#7 `padLen` constraint (1..255) is checked — if step-up would overflow, the encoder falls back to the smallest enclosing bucket.

## 4. `flags` (one byte)

| Bit | Mask | Name        | Meaning |
|----:|------|-------------|---------|
|  0  | 0x01 | `SIGNED`    | Ed25519 signature present after payload |
|  1  | 0x02 | `ENCRYPTED` | Payload is Noise/AEAD ciphertext |
|  2  | 0x04 | `FRAGMENTED`| Payload is one fragment of a larger message |
|  3  | 0x08 | `PADDED`    | PKCS#7 padding follows signature |
|  4..7 | 0xF0 | reserved (MUST be 0) | |

If `SIGNED`, the signature is computed over the **entire prefix** (header + payload) **before** padding is applied. Padding does not enter the signature.

**`SIGNED` is mandatory for every packet type** (MESH-02, X-07), including `NOISE_*`, `NOISE_REKEY_HINT`, `STORE_FORWARD_*`, `BRIDGE_FORWARD` and `MESH_KEY_REVOCATION`. Receivers MUST drop a packet without `SIGNED` or without a 64-byte signature **before** dedup and before any other processing (Android: `MeshRouter.Action.DROPPED_UNSIGNED`). There is no "unsigned" mode; stripping the flag from a signed packet therefore never yields a deliverable packet.

## 5. `phantom_id` (v3, self-certifying — MESH-03, MESH-07)

```
phantom_id = SHA-256(
    "phantom-mesh-id:v3\x00" ||
    mesh_signing_pub_raw(32)  ||  // Ed25519
    mesh_static_pub_raw(32)       // X25519 (Noise static)
)[:16]
```

The id is derived **only from the two public keys** — no phone/NFT number (mesh is an anonymous network; before v3 the
id was `SHA-256("phantom-mesh-id:v2\0" ‖ number ‖ signing_pub)[:16]`, so a passive BLE sniffer could recover the NFT
number from an announce by trying all 10^7 numbers). Field names in the code may still say `phantomIdV2`; the value is v3.

- **Self-certifying.** A receiver pins a new id only if `phantom_id == SHA-256(domain ‖ signing_pub ‖ static_pub)[:16]`
  for the keys carried in the `PEER_ANNOUNCE` payload (constant-time compare); otherwise the announce is dropped
  (`DROPPED_BAD_SIGNATURE`) before any state change. Taking over somebody else's id therefore requires their keys —
  the "first announce wins" race is closed. The same check is repeated for every announce of a known id.
- **Rotation (all identities, MESH-07).** Every mesh identity — anonymous and logged-in alike — is replaced by a fresh
  key pair (and therefore a new id) once it is older than **24 h**: on mesh enable / auto-restore and, while mesh
  runs, by a timer check every 10 min (rotation restarts the radio session: new beacon id, new `inst`, all Noise
  sessions dropped). A nickname the user chose is kept and is visible in announces, so it links identities across
  rotations — the UI says so; password-room ids are stable as well. Peers see a
  new id; old pins and Noise sessions with the previous id become unreachable. Nothing in the mesh identity refers to the
  NFT number, and the relay keeps no directory of mesh keys (registration/lookup are disabled, MESH-25).
- Test vector: `documentation/mesh_bridge_v2_vector.json` → `phantom_id_v3`.

## 6. Padding buckets

Compatible decoders MUST accept any of the following final packet sizes (header + payload + signature + padding). Encoders SHOULD round up to the smallest enclosing bucket and apply PKCS#7 padding to fill it:

`{128, 256, 512, 1024, 2048}`

Bucket selection leaks an order-of-magnitude size hint (§S-13); per-recipient bucket randomisation is left to phase 2.

## 7. Signature payload (`flags.SIGNED`)

```
sig_input = "phantom-mesh-sig:v1\x00"  ||
            type(1)                    ||
            session_id(8)              ||  // ALWAYS 0x00×8 (MESH-10, wire v3)
            header(60)                 ||  // header through payload_len, TTL byte zeroed
            payload(N)
signature = Ed25519.sign(mesh_signing_priv, sig_input)
```

**TTL normalisation:** the `ttl` byte at offset 2 of the wire header is zeroed in `sig_input` on **both** the sender and the verifier. The mesh router decrements TTL on every hop, so a signature that included the live TTL would only verify at the first receiver and break multi-hop flooding. This is a deliberate spec decision — every other header byte is preserved exactly.

**`session_id` in `sig_input` is always eight zero bytes (MESH-10, wire v3).** Earlier builds put the Noise `session_id` there for `ENCRYPTED` packets; a transit node has no such session, so it could not verify and dropped encrypted DMs (no multi-hop). Binding to the session is carried by the AEAD associated data (§7.2), so the outer signature only authenticates the sender. Verifiers MUST use zeros for every packet type.

Domain separation defeats cross-protocol signature reuse (§S-04). Verification MUST fail if `signature.length != 64` or any non-TTL header field is altered.

Relays (TTL-flood, store-and-forward, `BRIDGE_FORWARD`) MUST re-emit the packet byte-for-byte except the `ttl` byte (decremented) and the PKCS#7 tail (re-padded). No signed field — flags, timestamp, seq, ids, payload, signature — may be rebuilt on the way.

### 7.1 Authentication requirements (X-07 / MESH-02, MESH-03)

**Key resolution and pinning.**
- The verifying key is the sender's `mesh_signing_pub` **pinned** in the local peer registry for `sender_phantom_id`.
- An unknown `sender_phantom_id` is admitted only through a `PEER_ANNOUNCE` whose signature verifies against the `signing_pub` carried in its own payload **and whose id is the v3 derivation of the announced `(signing_pub, static_pub)` (§5)** (TOFU); the pair is then pinned. `NOISE_HANDSHAKE_*` addressed to us from an unknown sender is **held** (see below); every other type from an unknown sender is dropped (`DROPPED_UNKNOWN_SENDER`).
- **Handshake hold (M3).** A first `NOISE_HANDSHAKE_*` often overtakes the sender's `PEER_ANNOUNCE`. Such packets (addressed to us, unknown sender) are held for at most **10 s**, for at most **16 senders × 3 packets**, without touching dedup state. After a successful TOFU of that sender the held packets are re-processed from the start — the signature is now checked against the pinned key; anything not released within 10 s (or failing verification) is dropped.
- **TOFU limits (MESH-06 residual).** At most **30 new TOFU pins per minute** per node; announces of unknown senders over the budget are dropped **before** signature verification and change no state. The peer registry holds at most **2048** pins; when full, the **least-recently-seen "TOFU-only" pin that has not been seen for at least 1 h** is evicted (trust = TOFU, no attested number, no DM history with that peer); verified pins and peers with DM history are never evicted, and if no candidate exists the new TOFU is rejected. `last_seen` of a known peer is refreshed (`max(last_seen, now)`) by every verified, dedup-committed `PEER_ANNOUNCE`, so active neighbours (heartbeat every 30 s) are never eviction candidates. Up to 4096 evicted ids are remembered; a later TOFU of such an id raises a UI event (`REPINNED_AFTER_EVICTION`). Eviction does not touch dedup state. Together with the TOFU rate this keeps a flood of self-signed ids from permanently closing the registry to new contacts or from pushing a victim's dedup high-water out of the bounded caches. Registry writes to disk are debounced (~2 s); a registry wipe (logout/panic) cancels any pending write.
- **Hold race.** The "is the sender known?" re-check and the enqueue happen under the same lock that a successful TOFU takes to mark held packets for release; a handshake whose sender became known in between is processed immediately instead of waiting out the hold.
- **Pins are never overwritten.** Since v3 an announce for a known id with a different `signing_pub` or `static_pub` fails the id derivation check (§5) and is dropped as `DROPPED_BAD_SIGNATURE` without a UI event (it can only be forged, never legitimate); the `DROPPED_KEY_CONFLICT` branch remains for a hash collision only. The old pin stays in force. The only ways a pin disappears are an accepted revocation (below) and, when the registry is full, eviction of an unverified TOFU pin without DM history that has not been seen for ≥ 1 h (see "TOFU limits"); the next TOFU of that id is surfaced in the UI (`REPINNED_AFTER_EVICTION`).
- **Legitimate rotation** happens only via an accepted `MESH_KEY_REVOCATION` (signed by the pinned key, MESH-04): the pin is deleted, packets from the revoked id are dropped while the revocation is active, and the next verified announce after that is a fresh TOFU (also surfaced in the UI). Since `phantom_id_v2` depends on `signing_pub`, a new key normally means a new id anyway.
- The router delivers packets with two flags: `verified` (signature checked against the pin / TOFU key; for reassembled fragments — every fragment) and `encrypted` (payload carried `ENCRYPTED` and was opened by the Noise session with the sender).

**Application-layer rules.**
- Every consumer drops `verified = false`, for all types.
- A packet is **addressed** when `recipient ≠ 0x00×16` and `recipient` is not one of our subscribed room ids (`roomRecipientId(name[, password])`). Addressed `TEXT_MESSAGE`, `VOICE_MESSAGE`, `PHOTO_MESSAGE`, `PHOTO_MESSAGE_FULL`, `SCREENSHOT_ALERT`, `REACTION` and `LIVE_AUDIO_CHUNK` are accepted **only with `encrypted = true`**.
- `TYPING` (always signed plaintext) and room / broadcast `LIVE_AUDIO_CHUNK`, `CHANNEL_MESSAGE`, `CHANNEL_ANNOUNCE`, `REACTION`, `PEER_ANNOUNCE` require `verified` only.
- `NOISE_HANDSHAKE_*`: verified, addressed to us, not encrypted. The session is accepted only if the Noise remote static equals the pinned `static_pub` of the sender; handshake packets from an id without a pin are held by the router (see "Handshake hold") and reach the Noise layer only after TOFU; as a second line, the Noise layer itself waits up to **10 s** for a pin before comparing, otherwise refuses.
- `NOISE_REKEY_HINT`: verified, addressed to us; payload = `timestamp_ms(8 BE)` of the packet that failed to decrypt. The receiver ignores the hint if that timestamp is older than the creation time of its current session with the peer (the failure belonged to an older session, or the hint is a replay) or if the payload is not 8 bytes; otherwise it evicts its session for that peer at most **once per 30 s**.
- `ENCRYPTED` packets are opened (and may trigger a hint) only if addressed to us (`recipient == our id`, not broadcast, not a room id); any other `ENCRYPTED` packet is forwarded/dropped silently (no hint amplification).
- A transport **replay** (`counter` already seen or older than the window, §7.2) is dropped silently and never triggers a hint.
- **Decrypt failure with an existing session** (tag failure, stale session): if the packet was `verified`, the receiver sends `NOISE_REKEY_HINT` to the sender, at most **once per 30 s** per peer, so the session is re-established instead of staying dead until its 24 h lifetime. (Without a session the receiver buffers the packet for 5 s and sends a hint, throttled to once per 3 s.) Session eviction on a changed `inst` in `PEER_ANNOUNCE` happens only for verified announces and only when `inst` actually differs from the previous one.

**Dedup and `seq` (MESH-06, minimal part).**
- Order: unsigned drop → own echo → revocation gate → **read-only** duplicate check (`packet_id` seen within 60 s, `(sender, seq)` seen within 60 s, or `seq < high_water[sender] − 8`) → timestamp window (±10 min, MESH-06; was ±12 h) → signature / TOFU → **commit** (`seq`, `packet_id`, `high_water`). A packet with a bad signature, from an unknown sender, or with a key conflict changes no dedup or registry state.
- Dedup state is bounded: at most 4096 senders (LRU by last commit; evicts that sender's seq cache and high-water) and 16384 `packet_id` entries.
- Sender `seq` is monotonic across restarts: initial `seq = max(saved_reserved + 1, now_ms << 16)`; the sender persists a reservation in blocks of 1024 **before** issuing seqs from the block. The header format is unchanged (no epoch field).

**Resource limits (MESH-12, MESH-13, MESH-14).**
- Before signature verification the token bucket (capacity 200, refill 100/s) is kept **per ingress link** (BLE
  peripheral / central id), never per claimed sender id — otherwise a forger could drain a victim's bucket with junk
  signatures (crypto review M1). A per-sender bucket (same numbers) is charged only **after** a successful signature
  check. A link that produced ≥ 50 bad signatures within a minute is ignored for 5 min. Over-budget packets change
  no dedup/registry state. Forwarding (TTL flood) jitter never blocks
  the single inbound consumer.
- Incoming Noise handshakes: at most 16 responder states in total and 1 per peer, counted separately from our own
  outgoing handshakes (`MAX_INFLIGHT` applies only to outgoing); a new `INIT` from a peer replaces that peer's
  previous responder state.
- Fragment reassembly: at most 16 groups per sender and 256 groups in total (oldest group evicted). A fragment whose
  `type`/`total`/`recipient`/`flags` differ from the group it claims to belong to is dropped; the group is kept.
- Live audio playback queue: at most 8 pending chunks, the oldest is dropped.

**Residual risks (accepted, see SECURITY_AUDIT.md).**
- The id is self-certifying since v3 (§5), so the first-announce race is closed. A pin still says nothing about *who* the person is (mesh is anonymous): recognising a contact requires SAS/QR verification.
- `sender_phantom_id` is visible in every packet header for the lifetime of the identity (≤ 24 h): a node in radio range can link the packets of one identity within that window.
- Registry eviction only forgets a pin; with self-certifying ids a re-pin after eviction yields the same keys, so it cannot be hijacked. Because ids rotate daily, a pin not seen for **> 26 h** may be evicted when the registry is full **regardless** of DM history or verification (crypto review 2.6); trust does not survive rotation (re-verify after a rotation).
- Open rooms (no password) are plaintext by design. Password rooms are encrypted (§7.3), but the key is derived from the password only: anyone who knows name + password reads and writes the room, and there is no forward secrecy for room traffic.
- The Noise handshake is bound to the Ed25519 identity through the pin: the remote static must equal the pinned `static_pub`, which is part of the self-certifying id (§5). There is no relay attestation in mesh (anonymous by design).
- Encrypted DMs are relayed by transit nodes since wire v3 (`session_id` in `sig_input` is zero, §7). A transit node verifies the sender signature only if it has a pin for the sender; otherwise the packet is dropped there like any packet of an unknown sender.
- Replay after a receiver restart: dedup state is RAM-only, so after the receiver restarts a recorded signed packet within the ±10 min timestamp window is accepted once more (also after its sender's dedup entry is LRU-evicted). Encrypted DMs are additionally protected by the transport replay window (§7.2) while the session lives.
- Devices whose clock is off by more than 10 min cannot exchange mesh packets until the clock is corrected.

### 7.2 Noise transport messages v2 — explicit counter (MESH-11, MESH-09)

After the XX handshake both sides `Split()` into a send and a receive CipherState (key `k`, unchanged). The payload of
every `ENCRYPTED` packet is

```
payload = counter(8, big-endian) || ChaCha20-Poly1305(k, nonce(counter), plaintext, ad)
nonce(c) = 0x00×4 || c (8 bytes little-endian)            // Noise ChaChaPoly nonce, unchanged
ad       = "phantom-mesh-aead:v2\x00" || type(1) || session_id(8)   // session_id = h[0..8]
```

- **Sender.** `counter` is taken and incremented atomically under the CipherState lock (one value is never used twice,
  also with concurrent senders); the counter is consumed even if the transport later fails. `counter ≥ 2^60` → refuse
  and re-handshake.
- **Receiver.** Reject `len(payload) < 8 + 16`, `counter ≥ 2^60`, a counter older than the window
  (`counter + 1024 ≤ highest`) and a counter already seen inside the window (bitmap of 1024, as WireGuard/DTLS). Only
  after a successful AEAD open is the counter marked as seen and `highest` advanced. A lost or reordered packet no
  longer desynchronises the session; a replayed ciphertext is rejected.
- **Destroyed state.** `destroy()` zeroes the key and marks the CipherState destroyed under the same lock; every later
  encrypt/decrypt throws (fail-closed; no encryption with a zero key).
- The domain `…aead:v2` differs from v1 on purpose: packets of builds with implicit nonces fail cleanly.
- Test vector: `documentation/mesh_v3_vector.json` → `transport_v2` (generator `mesh_v3_vector_gen.py`).

### 7.3 Password rooms room-v1 — encrypted (MESH-08)

Open rooms (no password) are unchanged: `rid = SHA-256("phantom-channel:" || utf8(name))[:16]`, plaintext payloads,
announced in `CHANNEL_ANNOUNCE`. For a room **with a password**:

```
room_key = PBKDF2-HMAC-SHA256(P = utf8(NFC(password)), S = "phantom-room:v1\x00" || utf8(NFC(name)), c = 100000, dkLen = 32)
rid      = HMAC-SHA256(room_key, "phantom-room-rid:v1")[:16]      // recipient_phantom_id of the room
enc_key  = HMAC-SHA256(room_key, "phantom-room-enc:v1")            // 32 bytes
payload  = 0x01 || nonce(12, random) || ChaCha20-Poly1305(enc_key, nonce, inner_payload, aad)
aad      = "phantom-room-msg:v1\x00" || type(1) || sender_phantom_id(16) || rid(16)
```

- Applies to every packet addressed to `rid`: `CHANNEL_MESSAGE`, room `LIVE_AUDIO_CHUNK`, room `REACTION`.
  `inner_payload` is exactly what the open-room payload would be (the `CHANNEL_MESSAGE` JSON with PoW, the audio chunk,
  the reaction JSON); PoW is verified after decryption. The packet stays `SIGNED`, without `ENCRYPTED` (that flag means
  Noise); the router classifies it as a room packet (`isSubscribedChannel` matches `rid`).
- Encryption happens before fragmentation; the receiver decrypts the reassembled payload. A payload that does not start
  with `0x01` or fails the tag is dropped silently.
- Room reactions in a password room are addressed to `rid` (never to the open id of the same name).
- **Reaction context (crypto review M3).** A `REACTION` is applied only within the context it arrived in and is stored by `(context, target_message_id)`: a password room — only a room-v1 packet to that room's `rid`; an open room — only a packet to that room's open id; a DM — only `encrypted` from that peer and only to a message of that DM thread; `recipient = 0x00×16` — only to broadcast messages. Anything else is dropped.
- **Room names** (both platforms): 1–32 characters of `[a-z0-9_-]` (ASCII, lower-case), no normalisation needed. Names outside the rule cannot be created, joined or shown from `CHANNEL_ANNOUNCE`. The room-v1 vector uses a Cyrillic name only to test NFC/UTF-8 handling of the KDF.
- Senders refuse (and the UI reports) a payload whose final wire size would exceed 16 fragments; the 4000-byte text limit is a UI hint, the authoritative check is on the serialised payload.
- Encryption with a room key is fail-closed: without the room keys nothing is sent (no plaintext fallback); room keys are wiped on leave and a wiped key cannot be used.
- `room_key`, `rid` and `enc_key` are derived once per joined room and cached in memory; the password is stored only
  in Keystore/Keychain as before. Offline guessing of the password from `rid` costs one PBKDF2 (100 000 iterations) per guess.
- Password rooms are **never** announced in `CHANNEL_ANNOUNCE` (MESH-26); geohash rooms (`g…`) are not announced either.
- Compatibility: rooms with a password created by older builds used `SHA-256(... || 0x00 || password)` and were not
  delivered by the router at all (MESH-08 bug); there is no migration — members rejoin with the same name and password.
- Test vector: `documentation/mesh_v3_vector.json` → `room_v1`.

## 8. Deterministic test vector

The following inputs MUST produce the byte sequence below on every platform.

```
version              = 0x01
type                 = 0x01 (TEXT_MESSAGE)
ttl                  = 0x07
flags                = 0x00 (no signature, no padding)
timestamp_ms         = 1_777_191_234_567   ; 0x000001 9D C8 DA 2C 07
seq                  = 42                  ; 0x00..00 0x2A
packet_id            = 0xDE AD BE EF CA FE F0 0D
sender_phantom_id    = 0x11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00
recipient_phantom_id = 0x00 (16 bytes, broadcast)
payload              = "hi mesh" (UTF-8)   ; 0x68 69 20 6D 65 73 68 (7 bytes)
```

Encoded packet (hex, 69 bytes total):

```
01 01 07 00
00 00 01 9D C8 DA 2C 07
00 00 00 00 00 00 00 2A
DE AD BE EF CA FE F0 0D
11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 07
68 69 20 6D 65 73 68
```

Both Kotlin (`PhantomMeshPacketTest.testGoldenVector`) and Swift (`PhantomMeshPacketTests.testGoldenVector`) execute this vector and assert exact equality. Drift here means cross-platform mesh interop is broken.

### Test vector — `phantom_id` v3

```
mesh_signing_pub = d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737   (Ed25519, seed 0x11×32)
mesh_static_pub  = 0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20   (X25519, seed 0x22×32)

phantom_id (16 B) = 2a56ea7fcd16ca12b5b14df7f151019e
```

Source of truth: `documentation/mesh_bridge_v2_vector.json` → `phantom_id_v3`. The v2 vector (number-based) is obsolete.

## 9.1 Application-layer fragmentation (`flags.FRAGMENTED`)

When the encoded packet (header + payload + signature + padding) would exceed
the negotiated BLE link MTU (worst case ~180 B with MTU=185, comfortable case
~510 B with MTU=517), the sender MUST split the **plaintext** application
payload into chunks and emit one mesh packet per chunk with `flags.FRAGMENTED`
set. Each fragment carries a tiny extra header inside the `payload` field so
the receiver can reassemble:

```
Inside the `payload` field of a FRAGMENTED packet:

| Offset | Size | Field              | Notes |
|-------:|-----:|--------------------|-------|
|     0  |   8  | fragment_group_id  | shared by every fragment of one logical message |
|     8  |   2  | fragment_index     | uint16 BE, 0-based, < fragment_total |
|    10  |   2  | fragment_total     | uint16 BE, 1..16 inclusive (cap) |
|    12  |   N  | chunk_data         | the actual fragment of the original payload |
```

The 12-byte fragment header is **part of `payload_len`** at the wire level —
i.e. the outer header sees a payload of `12 + chunk_data.length` bytes, the
signature covers the whole packet including these 12 bytes, and PKCS#7
padding follows the signature exactly as for unfragmented packets.

### Rules

* `fragment_total` MUST be in `1..16`. A receiver MUST drop the entire group
  if any fragment claims a different `fragment_total` than its peers. The
  cap (16) bounds memory usage on tiny embedded receivers.
* Each fragment has its **own** `seq` and `packet_id` so per-sender dedup
  treats them as distinct (they are — each is signed independently). The
  `fragment_group_id` is what ties them together.
* All fragments of one group MUST agree on:
  - `type` (the outer `MessageType`)
  - `sender_phantom_id`
  - `recipient_phantom_id`
  - `fragment_total`
  - `flags & (FLAG_SIGNED | FLAG_ENCRYPTED)` (consistent across the group)
* Each fragment is **signed individually** under `FLAG_SIGNED`. Verification
  happens before reassembly — a bad signature on any fragment kills the
  whole group.
* When `FLAG_ENCRYPTED` is set, **the entire reassembled plaintext** is what
  Noise opens — i.e. fragmentation happens **after** encryption, so each
  fragment's `chunk_data` is opaque AEAD ciphertext bytes; the AEAD tag
  attaches to the full ciphertext at the end of the last fragment.

### Reassembly

* Buffer key = `(sender_phantom_id, fragment_group_id)` (16 + 8 = 24 B).
* Buffer holds an array of fragments indexed by `fragment_index`.
* Group is complete when all `fragment_total` slots are filled. Concatenate
  `chunk_data` in ascending index order to recover the original payload.
* **Timeout:** drop incomplete groups after **30 seconds** of inactivity.
* **Per-sender cap:** at most **16 in-flight groups** per sender; on overflow
  evict the oldest group (LRU).
* **Per-group cap:** `fragment_total <= 16`; receivers MUST reject packets
  with `fragment_total > 16` or `fragment_index >= fragment_total`.

### Recovered packet

After reassembly the router synthesises a "virtual" `PhantomMeshPacket`
inheriting:

* `type`, `sender_phantom_id`, `recipient_phantom_id` — from the first
  fragment seen
* `flags` — same as a normal packet **without** `FLAG_FRAGMENTED` set
* `payload` — the concatenated `chunk_data`
* `verified=true` iff every fragment passed `FLAG_SIGNED` verification

The virtual packet is then handed to the normal "deliver / decrypt /
forward" pipeline — the application layer is unaware of fragmentation.

### Outbound fragmentation budget (BLE)

* `MAX_FRAGMENT_PAYLOAD` is computed from negotiated link MTU:
  `chunk_size = padding_bucket - header(62) - signature(64) - frag_hdr(12) - 1` (PKCS#7 marker)
  For the canonical 512-B bucket: `chunk_size = 512 - 62 - 64 - 12 - 1 = 373` bytes.
* Senders SHOULD pad each fragment to the smallest enclosing bucket
  (`{128, 256, 512, 1024, 2048}`) — a single oversized payload typically
  produces N fragments of identical bucket size for traffic-analysis
  resistance.
* If the entire encoded packet (no `FRAGMENTED`) fits within the smallest
  bucket the application allows (typically 512 B), fragmentation is skipped
  — there is no value in inflating one packet to two.

### Test guidance

A round-trip test fixture — split a 1500-byte plaintext into ⌈1500/373⌉ = 5
fragments, shuffle, drop one, re-deliver after timeout — is the conformance
check; both Kotlin (`FragmentReassemblyTest.kt`) and Swift
(`FragmentReassemblyTests.swift`) ship one.

## 9.2 `BRIDGE_FORWARD` payload v2 — sealed envelope (MESH-01, MESH-21)

A logged-in sender without internet hands a message for an NFT number to any mesh node with internet ("bridge"). The
bridge and every mesh node see only an opaque blob; the relay learns sender and recipient, checks that the sender owns
the number and delivers a normal `message` from that number.

**Bridge key (online, beforehand).** WS `{"type":"mesh_bridge_key"}` → `{"type":"mesh_bridge_key","status":"ok",
"epoch":E,"key":b64(32),"validDays":7,"relayBoxPubkey":b64(32)}` where `epoch = floor(unix_seconds / 86400)` and
`key = HMAC-SHA256(K_bridge_relay, "phantom-bridge-key:v1\0" ‖ number ‖ E(4 BE))`. The client stores `(epoch, key,
relayBoxPubkey)` in Keystore/Keychain, refreshes it after every `register`, and wipes it on logout/panic. A key is
accepted by the relay for envelopes with `epoch ∈ [today − 6, today]` (7 days). The key also depends on a per-number generation kept by the relay; it is incremented on `revoke_session` (logout, panic, revoking a device), so all bridge keys handed out before become invalid at once (the relay pushes a fresh `mesh_bridge_key` to the remaining live sessions). `GET /api/mesh/relay-pubkey` also returns
`relayBoxPubkey`.

**Envelope (sender).**

```
blob     = UTF-8 JSON text of the relay EncryptedBlob for the recipient (same as for a normal relay message)
mac      = HMAC-SHA256(key, "phantom-bridge-env:v2\0" ‖ lp(from) ‖ lp(to) ‖ lp(messageId) ‖ ts(8 BE) ‖ epoch(4 BE) ‖ SHA-256(blob))
           lp(x) = uint16 BE length ‖ ASCII bytes;  from/to = 10-digit numbers "111…";  messageId ≤ 64 printable ASCII
inner    = UTF-8 JSON {"v":2,"from":…,"to":…,"messageId":…,"ts":<ms>,"epoch":E,"blob":"<blob text>","mac":"<b64>"}
           (key order and whitespace are free; the relay parses JSON, the MAC covers the blob text byte-for-byte)
eph      = fresh X25519 key pair per envelope (MUST: the AEAD nonce is all-zero, so reusing eph reuses the key/nonce)
k        = HKDF-SHA256(ikm = X25519(eph_sk, relayBoxPubkey), salt = eph_pub ‖ relayBoxPubkey, info = "phantom-bridge-seal:v2", L = 32)
payload  = 0x02 ‖ eph_pub(32) ‖ ChaCha20-Poly1305(k, nonce = 0x00×12, inner, aad = "phantom-bridge-seal:v2\0" ‖ eph_pub)
```

The mesh packet is `BRIDGE_FORWARD`, `SIGNED` (like every packet), not `ENCRYPTED`, `recipient = 0x00×16`, TTL-flooded.
`payload` is limited by the router (16 fragments) and by `MESH_BRIDGE_PAYLOAD_MAX_BYTES` (8192) on the relay.

**Bridge node.** If bridging is enabled and the relay socket is up, it sends
`{"type":"mesh_bridge_forward","sealed":"<b64 of payload>"}` without parsing the payload (no `meshHops`: hop count is location metadata). Quotas before forwarding: ≤ 6 envelopes per minute per mesh sender id and ≤ 20 per minute in total; the relay additionally limits 30/min per bridge session before the MAC check and 30/min per verified `from` after it. Every
bridge that sees the packet may forward it; the relay delivers once.

**Relay.** Uniform `mesh_bridge_forward_ack {status:"ok"}` (the bridge learns nothing about the result). Then: open the
seal → `v == 2`, valid numbers, `from ≠ to` → `ts ∈ [now − 1 h, now + 10 min]` → epoch window → MAC with
`key(from, epoch)` (constant time) → dedup `(from, messageId)` (committed after delivery, kept 2 h, RAM) → per-`from` limit → block list `from → to` → deliver
`{"type":"message","fromNumber":from,"encryptedBlob":blob,"messageId":…,"_meshBridge":{"v":2}}` (or offline queue +
the normal push). The legacy v1 payload (open `original_sender`/`to_number`) is no longer delivered.

**Privacy.** Mesh nodes and the bridge see only the size bucket and the timing of the sealed blob. The relay sees what it
sees for any relay message (sender, recipient, size, time) **plus** which bridge (its number, from the WS session)
forwarded the envelope — i.e. that the sender was within mesh range of that subscriber at that time; several bridges
allow coarse triangulation. A bridge that cooperates with the relay can link the sender's current mesh id (outer
signature) with the number. A garbage flood from anonymous mesh nodes can exhaust bridge quotas (DoS, not forgery). Forward secrecy across the bridge is that of the relay
envelope used inside `blob`. A stolen bridge key lets its holder send as that number through bridges until the key
expires (≤ 7 days) or the number revokes a session (generation bump); the recipient's key-change alert still applies to the inner E2E blob.

Test vector: `documentation/mesh_bridge_v2_vector.json` → `bridge_v2` (generator `mesh_bridge_v2_vector_gen.py`; the
relay test opens `sealed_hex` with `relay_seed_hex`).

## 9. Noise XX golden vectors

Inputs (raw 32-byte seeds, **before** RFC 7748 §5 clamping):

```
init_static_seed     = 0x11 × 32
init_ephemeral_seed  = 0x22 × 32
resp_static_seed     = 0x33 × 32
resp_ephemeral_seed  = 0x44 × 32

prologue (38 B) = 50 48 41 4E 54 4F 4D 2D 4D 45 53 48 2D 4E 4F 49
                  53 45 2D 58 58 2D 76 31 00 01 01 01 01 01 00 00
                  00 00 00 00 00 00
                = "PHANTOM-MESH-NOISE-XX-v1\x00" || 0x01 0x01 0x01 0x01 0x01 || 0x00*8

protocol_name = "Noise_XX_25519_ChaChaPoly_SHA256"   (32 ASCII bytes — no SHA fold)
```

Derived public keys (after clamping the seeds):

```
init.static.pub  = 7B 4E 90 9B BE 7F FE 44 C4 65 A2 20 03 7D 60 8E
                   E3 58 97 D3 1E F9 72 F0 7F 74 89 2C B0 F7 3F 13
init.ephem.pub   = 0F AA 68 4E D2 88 67 B9 7F 4A 6A 2D EE 5D F8 CE
                   97 4E 76 B7 01 8E 3F 22 A1 C4 CF 26 78 57 0F 20
resp.static.pub  = 7B 0D 47 D9 34 27 F8 31 11 60 78 1C 7C 73 3F D8
                   9F 88 97 0A EF 49 0D 8A A0 EE 19 A4 CB 8A 1B 14
resp.ephem.pub   = FF 2E E4 56 01 EC 1B 67 31 0C 77 90 40 45 85 AE
                   69 73 31 EE E1 C1 F8 CF 24 19 73 1C 1F FF 3E 6B
```

Handshake messages (initiator/responder payloads `"phantom-init-1"`, `"phantom-resp-2"`, `"phantom-init-3"` UTF-8):

```
msg1 (46 B, -> e + payload-plain) =
   0F AA 68 4E D2 88 67 B9 7F 4A 6A 2D EE 5D F8 CE
   97 4E 76 B7 01 8E 3F 22 A1 C4 CF 26 78 57 0F 20
   70 68 61 6E 74 6F 6D 2D 69 6E 69 74 2D 31

msg2 (110 B, <- e, ee, s+TAG, es, payload+TAG) =
   FF 2E E4 56 01 EC 1B 67 31 0C 77 90 40 45 85 AE
   69 73 31 EE E1 C1 F8 CF 24 19 73 1C 1F FF 3E 6B
   5C DA 1C 2D 80 29 87 7D 73 FA D6 28 23 94 6C CD
   0C 5D A3 5C 12 91 00 F4 3D 33 A5 9C F1 9E A8 FC
   52 33 AA 8F 83 94 65 57 A3 2D 29 01 86 2C 98 01
   8D F9 50 7F AB FA 7C F8 A9 85 4F A3 96 2E E6 66
   5F 84 F4 65 4D 81 A2 5A 01 92 0C D6 25 7E

msg3 (78 B, -> s+TAG, se, payload+TAG) =
   F4 E4 98 8E 97 BD CB F0 F7 99 D0 2D D2 24 26 24
   BD A7 2D 20 0E 97 E3 22 C4 F7 23 21 38 96 A3 1E
   91 7A 32 10 80 A7 70 A0 08 AF 0A 14 79 FD D1 39
   8B 65 31 A0 29 E1 40 20 FD 54 95 BB 85 51 55 4C
   E9 D1 DC 36 D4 8E 92 E5 4D 7D C7 A8 38 25
```

Final symmetric state (after split):

```
handshake_hash h  = 50 AC 39 E3 B7 7C F6 F0 49 42 D1 10 F5 2D 57 6A
                    D1 ED 77 6F 35 EA 48 FC 4E A5 EC E3 09 E7 EA 2F

split.k1 (init.send / resp.recv) =
   14 13 99 B1 49 03 4C 67 1C C5 2B 0E C1 FC B7 12
   62 D7 AD 66 90 8D 69 3B EB E6 1B 7B 96 34 4A 35

split.k2 (init.recv / resp.send) =
   60 52 7C C7 E2 D7 9C DA DD D5 16 60 08 5B 84 3C
   CD 6F 6C 53 94 7F C6 C3 CF 13 A1 1B 0E B9 AF 74
```

Cipher nonce convention (Noise §5.1): 12 bytes = `0x00 × 4 || counter as little-endian uint64`, counter starts at 0 and increments per direction.

Reference triangle that signed off these vectors on **2026-04-26**:

| Platform | Implementation | File | Outcome |
|----------|----------------|------|---------|
| Swift    | CryptoKit       | `Mesh/Crypto/NoiseHandshake.swift` (run via `/tmp/noise_smoke/main.swift`) | PASS |
| Python   | pyca/cryptography | `/tmp/noise_smoke/noise_xx_reference.py`                                   | PASS |
| Kotlin   | RFC 7748 BigInteger + JCE ChaCha20-Poly1305 | `app/.../test/.../NoiseHandshakeGoldenVectorTest.kt`             | PASS (pending `./gradlew test`) |

If any of the three drifts, mesh interop is silently broken across platforms.

## 10. BLE GATT: `IdentityBeacon` characteristic (IOS-37)

Characteristic `6c702e6d-7368-616e-746f-6d6d65730003` (read, no pairing). Layout is unchanged: `version(1) = 0x01 ‖ id(16)` = 17 bytes.

**Value of `id` (changed in IOS-37).** It is an **ephemeral radio session id**: 16 random bytes (CSPRNG) generated at every transport start and re-generated lazily at read time once it is older than **15 minutes** (or after a clock rollback). It is **not** `phantom_id_v2`, is not derived from any key, and carries no identity. Before IOS-37 the beacon returned the persistent `phantom_id_v2`, so any BLE scanner that connected could read it and track a person (including the persistent anonymous identity).

**Receiver rules.**
- A central MUST NOT treat the beacon `id` as a peer identity. Only the length (≥ 17 bytes) is checked; shorter beacons drop the link as before.
- Link ↔ peer mapping (`PeerInfo.phantomId`, proximity/RSSI binding) comes from the first **verified** `PEER_ANNOUNCE` received on that link directly (`ttl` equals the sender's initial TTL, router action `DELIVERED_AND_FORWARDED`, i.e. signature checked and no key conflict). The mapping is reset when the link is re-established. Routing and sending use the link id (BLE MAC / CBPeripheral UUID), never the beacon.
- Beacon values are not used for dedup of connections or own-device filtering (both work on the link id).

**Compatibility.** No format change. An old client connecting to a new one reads a random id instead of `phantom_id_v2`: it only uses it for a proximity (RSSI) hint in the UI, so the new peer shows no distance bucket on old clients until they upgrade. A new client connecting to an old one ignores the old beacon value and learns the peer from its announce. DM, rooms, PTT and photo are unaffected.

**Anonymous identity lifetime.** A persisted anonymous identity (`anon:<hex>`, new keys and `phantom_id_v2`) older than **24 h** is replaced on the next mesh enable / auto-restore; manual rotation (`MESH_KEY_REVOCATION`) is unchanged. Since v3 the same 24 h rotation applies to the identity of logged-in users (§5). A new `phantom_id_v2` is a different id, not a key change for a pinned id, so no pin conflict arises; old pins and Noise sessions with the previous id simply become unreachable.

**Residual risk (accepted).** The ephemeral beacon only removes the zero-effort tracking by reading one characteristic. A node that connects, subscribes to TX and listens still sees `sender_phantom_id` in every packet header and in `PEER_ANNOUNCE` (needed for signature verification and TOFU), so a connected participant can track the **current** id for ≤ 24 h (§5). Hiding it requires a protocol redesign (rotating sender ids, announce only after a handshake) and is out of scope. The UI states this in the mesh settings. BLE address privacy (MAC randomisation) is controlled by the OS and not by the app.
