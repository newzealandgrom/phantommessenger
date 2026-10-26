# Phantom Messenger — run your own server

A package for operators: it installs a Phantom Messenger relay, the web client and a TURN server for calls on
your own Ubuntu host and domain. The mobile and desktop apps connect to it via
"Settings -> Server -> Change server".

Russian version: [README.md](README.md)

## Read this first

- **No federation.** A server is an island: the key directory, delivery queue and call signalling live inside one
  relay. A user of your server cannot see or message a user of another server (including phantommessenger.org).
  The app uses one server for all accounts. The same number can be registered on several servers independently;
  device keys and safety numbers will differ.
- **No push notifications on your server.** FCM/APNs keys belong to the project owner and are not part of this
  package. Messages arrive while the app is open (active WebSocket) and from the offline queue on reconnect.
- **Login codes go through the project owner's numbers service (Phantom Numbers, phantomnumbers.org).** The installer obtains the integration key by itself
  (automatic registration, see below). The service sees the number, request time, your server domain and your relay's IP;
  the number's owner sees a "login request from third-party server <your domain>" message.
- **You are the operator.** Users trust you the way they trust the project on phantommessenger.org. See "What the
  operator can see".
- **The host must be dedicated.** The installer fully manages nginx and coturn (it overwrites `/etc/turnserver.conf`), takes ports 80/443/3478/5349 and stops coturn on uninstall. Other sites or a TURN server on the same host are not supported.
- `SECURITY_AUDIT.md` describes the project's own infrastructure and is **not** shipped; `/SECURITY_AUDIT.md` on
  your server returns 404.

## Requirements

| | |
|---|---|
| OS | Ubuntu 22.04, 24.04 or 26.04 LTS. The relay needs Python ≥ 3.11: 24.04 (3.12) and 26.04 (3.14) use the system one; Ubuntu 22.04 is experimental: system Python 3.10 is too old, so the installer adds Python 3.12 from the deadsnakes PPA (key verified by its full fingerprint, dedicated `Signed-By` keyring, apt pinning: only `python3.12*` is taken from the PPA; `uninstall.sh` removes the PPA; opt out with `--no-python-ppa` and install Python ≥ 3.11 yourself). Verified on a live system: 26.04 only; 22.04 and 24.04 not yet. Debian 12 is untested. |
| Resources | 1 vCPU, >= 1 GB RAM (2 GB better), 10 GB disk. amd64 primary, arm64 best effort. |
| Host | a dedicated VPS: the installer takes ports 80/443 (nginx) and 3478/5349 (coturn) |
| Domain | a subdomain such as `msg.example.com` (a subdomain is recommended: the server's HSTS covers nested names) and `turn.msg.example.com` for TURN |
| Ports | 80/tcp, 443/tcp, 3478/tcp+udp, 5349/tcp, 49152-65535/udp - also open them at your VPS provider |
| Key | none needed: the installer registers the server with the numbers service itself (see "Numbers service key"); port 443 must be reachable from the internet |

## Installation - one command

On a fresh server (Ubuntu 22.04 / 24.04 / 26.04), as root or via `sudo`, with no flags:

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/newzealandgrom/phantommessenger/main/selfhost/get.sh)"
```

`get.sh` downloads the latest release, verifies its signature with the key built into it (fingerprint below) and its SHA-256, then runs
`install.sh`, which **asks the questions itself**: domain, TLS mode, e-mail, operator name/e-mail/site - and asks you to confirm the plan. You
do not enter a numbers service key. Flags (for automation) go after `--`, e.g. `... )" -- --non-interactive --domain msg.example.com --email you@example.com --tls letsencrypt`.
To update, run the same command. Details and sample answers: the [main README](../README.md).
`get.sh` itself is not signed - it is trusted via HTTPS to GitHub (branch `main`); the signature with the built-in key
(fingerprint `SHA256:SJIk2s8G8DM1FTJP4KB7gVfqU+oVBvk+PhwZMtpFMkY`) is verified on the release archive. If that is not enough, see [Manual installation](#manual-installation) below.

## Manual installation

```bash
tar xzf phantom-selfhost-X.Y.Z.tar.gz
cd phantom-selfhost-X.Y.Z
sudo ./install.sh --dry-run --non-interactive --domain msg.example.com --email you@example.com \
  --tls letsencrypt \
  --signer-fingerprint SHA256:SJIk2s8G8DM1FTJP4KB7gVfqU+oVBvk+PhwZMtpFMkY   # print the plan, change nothing
sudo ./install.sh                                                  # interactive
sudo ./install.sh --non-interactive --domain msg.example.com --email you@example.com \
  --tls letsencrypt \
  --signer-fingerprint SHA256:SJIk2s8G8DM1FTJP4KB7gVfqU+oVBvk+PhwZMtpFMkY      # unattended
```

### Verifying a release (releases are always signed)

Every release is signed by the project owner (`ssh-keygen -Y`, namespace `phantom-selfhost`). Signing key fingerprint:

```
SHA256:SJIk2s8G8DM1FTJP4KB7gVfqU+oVBvk+PhwZMtpFMkY
```

Before unpacking, verify the archive and signature, obtaining the fingerprint independently of the archive (project
site, repository):

```bash
sha256sum -c SHA256SUMS
# allowed_signers: a file holding the owner's public key (phantom-release namespaces="phantom-selfhost" ssh-ed25519 ...)
ssh-keygen -lf allowed_signers          # must print the fingerprint above
ssh-keygen -Y verify -f allowed_signers -I phantom-release -n phantom-selfhost -s SHA256SUMS.sig < SHA256SUMS
```

After that the package enforces it. `update.sh` and a **repeated** `install.sh` (run from an unpacked archive over an
installed server) refuse to proceed without a valid signature. The key comes from the **installed** package
(`/opt/phantom-messenger/selfhost/allowed_signers`), never from the downloaded archive, so a forged archive carrying
its own key fails. For a repeated `install.sh` keep `phantom-selfhost-X.Y.Z.tar.gz`, `SHA256SUMS` and
`SHA256SUMS.sig` next to the package directory. For the **first** install there is no installed key and the archive's own key is used, so pass
`--signer-fingerprint SHA256:SJIk2s8G8DM1FTJP4KB7gVfqU+oVBvk+PhwZMtpFMkY` (with the archive, `SHA256SUMS` and `SHA256SUMS.sig` next to the package directory): a
mismatching fingerprint, or a signature that cannot be checked, stops the installer. `update.sh` accepts the same
flag. Releases older than the installed one are refused (`--force` to downgrade deliberately).
`--allow-unsigned` exists but is unsafe (it is recorded in `releases.log` and shown by `status.sh`): only integrity is checked,
not authenticity, and foreign code runs as root.

After installation **delete the source files holding secrets** (certificate key, numbers key file, Cloudflare
token): the installer copies them into `/etc/phantom-messenger` (0600/0640), the originals stay where you put them
(`shred -u file`). Only release files are copied into `/opt/phantom-messenger/selfhost`.

Main flags (`./install.sh --help` lists all): `--domain`, `--tls letsencrypt|cloudflare-dns|cloudflare-origin|custom`,
`--email`, `--service-key-file` (a manual key: disables automatic registration; or `PM_SERVICE_KEY`; `--service-key` is visible in `ps`), `--no-autoregister` (do not register; without a key the install ends with a warning and sign-in codes will not work), `--reregister` (manual key rotation: a new key, the old one stops working; not needed after the server was unregistered - see below), `--cf-api-token-file`
(Zone:DNS:Edit token, for `cloudflare-dns`), `--origin-cert`/`--origin-key` (for `cloudflare-origin` and `custom`),
`--turn-host` (default `turn.<domain>`, **DNS-only**), `--external-ip`, `--api-base`, `--operator-name`,
`--operator-email`, `--operator-site` (asked in the dialog; written to `operator.json`: shown on `/terms` and `/privacy` and in the iOS/macOS/Android apps connected to your server), `--operator-terms-url`/`--operator-privacy-url` (default `https://<domain>/terms`, `/privacy`), `--enable-ufw`, `--skip-key-check`,
`--cf-only-443`/`--no-cf-only-443` (ufw: 443/tcp only for Cloudflare CIDRs, refreshed daily by `pm-cf-update.timer`; TURN ports are not restricted; default **on** for `cloudflare-origin`, **off** for `cloudflare-dns`; effective only while ufw is enabled), `--allow-unsigned` (unsafe, see above), `--le-staging`, `--non-interactive`, `--dry-run`, `--render-dir DIR` (with `--dry-run`: rendered configs without
secrets).

Re-running is safe: secrets are kept, configs are regenerated (old ones saved as `*.bak.<timestamp>`), `nginx -t`
runs before reload, relay health is checked after start, and the previous `env` is restored on failure.

## TLS modes and DNS

The apps accept only `https://` with a certificate that validates against the system root CAs. Self-signed
certificates and private roots do not work. A Cloudflare Origin Certificate works only behind the orange cloud.

| Mode | Site certificate | DNS |
|---|---|---|
| `letsencrypt` | Let's Encrypt, HTTP-01 | `msg.example.com` A -> server IP (DNS only), port 80 free |
| `cloudflare-dns` | Let's Encrypt, DNS-01 via Cloudflare API | `msg...` may be proxied |
| `cloudflare-origin` | Origin Certificate from the Cloudflare dashboard | `msg...` proxied |
| `custom` | your paid PEM | A -> server IP |

**The TURN host must be DNS-only** (grey cloud): Cloudflare does not proxy UDP/STUN. Create an A record
`turn.<domain>` -> server IP. The `turns:` certificate is issued separately (Let's Encrypt); if it cannot be
issued, plain `turn:` on 3478 remains.

Cloudflare checklist (`cloudflare-*` modes): site record proxied, `turn...` DNS only; SSL/TLS **Full (strict)**;
**WebSockets On**; Cache Rule **Bypass** for `/api/*`; **TLS 1.3 On** (iOS and macOS require it); restrict
inbound 443 to Cloudflare ranges with `--cf-only-443` (on by default for `cloudflare-origin`).

## Numbers service key

Login codes are sent and verified by the project owner's numbers service. **By default the key is obtained automatically**: after
the TLS certificate is issued the installer registers your server with the numbers service (like Let's Encrypt HTTP-01):

1. it generates a one-time secret (32 random bytes; kept only in the installer's memory, never written to disk, process arguments or
   logs) and sends the service its hash;
2. it receives a token and publishes `https://<domain>/.well-known/phantom-numbers/<token>` (nginx serves only this prefix from a
   dedicated directory `/var/www/phantom-wellknown`, uncached, never proxied to the relay);
3. the numbers service downloads the file, confirms you own the domain and issues the key once; the file is removed immediately, the key
   is written to `/etc/phantom-messenger/env` (0640 root:phantom) and never printed.

**What the numbers service sees:** your server domain, the operator contact e-mail, software name and version
(`phantom-messenger-selfhost`), the server IP (request source) and afterwards the numbers that codes are requested for and request
times. It does not receive messages, chat contacts or keys.

**Limits and blocking.** Your server is a third-party one: codes carry a "third-party server <domain>" note and strict limits apply
(5 code requests/min and 30/h per domain, a shared cap for all third-party servers, at most 3 sender domains per number per day). The
numbers service owner can list third-party servers and block a domain (and its subdomains): the key stops working and sign-in codes
disappear. For a large server (higher limits) ask the owner for a regular key at admin@phantommessenger.org and pass it with
`--service-key-file`.

**Availability check.** Once a day the numbers service opens `https://<domain>/api/health`. If the server does not answer for 3 days in a row and requested no codes during that time, its registration is removed automatically: the key stops working, the domain is not blocked. Since version 0.1.1 it is enough to run the install command again: the installer sees that the auto-registration key was revoked (HTTP 401/403) and registers the server again (`--reregister` is only for manual rotation of a working key):

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/newzealandgrom/phantommessenger/main/selfhost/get.sh)"
```

A manual key (`--service-key-file`) is never replaced on 401/403: the install stops with an error. If the service has closed (503 `selfhost_registration_closed`) or switched off (503 `selfhost_disabled`) third-party servers, or the server is blocked, the installer says so - write to admin@phantommessenger.org.

If Cloudflare bot protection sits in front of your server, do not block `/api/health` for it. The numbers service owner can temporarily close registration of new third-party servers or switch them off entirely.

Rules:
- the key lives only in `/etc/phantom-messenger/env`; never put it in command arguments, repositories or logs;
- repeated `install.sh` and `update.sh` keep a working key and do not register again (`install.sh` replaces a revoked auto-registration key by itself); `--reregister` issues a new key (the old one is revoked);
- if registration fails (registration disabled by the service - 503, registration rate limit 5/h per IP, the file could not be
  fetched because of DNS/firewall/cache, domain blocked) the install still finishes and the relay starts, but sign-in codes will not
  work; fix the cause and run the install again (same options); with `--non-interactive` the install then exits with code 3 (not 0);
- in `cloudflare-*` modes add a Cache Rule "Bypass cache" for `/.well-known/phantom-numbers/*` (otherwise Cloudflare may serve the numbers
  service a cached response);
- domains on free hosting or DDNS (github.io, duckdns, etc.) are not accepted by the numbers service (`domain_not_allowed`) - use your own domain;
- `--reregister` refuses when a manual key is installed (so it is not replaced by a key with the strict third-party limits); only `--force` overrides;
- HTTP `401/403` on sign-in means the key was revoked, replaced or the domain is blocked - run the install again (auto-registration key) or ask the owner;
- `status.sh` shows the key source ("auto-registration" or "manual"), `selftest.sh` checks the key itself.

## What is installed

Code in `/opt/phantom-messenger` (root:root, read-only); config and secrets in `/etc/phantom-messenger`
(`env` 0640 root:phantom); state in `/var/lib/phantom-messenger/state.json` (encrypted with
`STATE_ENCRYPTION_KEY`); services `phantom-messenger` (user `phantom`, sandboxed), `nginx`, `coturn`,
`pm-healthcheck.timer`; relay and coturn logs in RAM only (namespace `phantom`): `journalctl --namespace=phantom -u phantom-messenger` and `journalctl --namespace=phantom -u coturn` (plain `journalctl -u ...` is empty).
**Back up `/etc/phantom-messenger/env`**: without `STATE_ENCRYPTION_KEY` the state cannot be read, and changing
`JWT_SECRET` signs everyone out.

## What the operator can see

The relay keeps messages in RAM until delivery; a restart drops sessions and the offline queue. On disk: public
keys, capabilities, push tokens (none on your server), mesh key revocations and block lists (encrypted state
file). Technically you can see: client IP addresses (nginx/relay while handling connections, coturn during
calls via TURN); numbers, who writes to whom and when, message size bucket, service events (typing, receipts,
reactions, edits, deletes); public keys and capabilities, profiles and settings in RAM; call SDP/ICE (including
participants' IPs) and TURN traffic volume; numbers in the mesh bridge.

You cannot see message, voice or file contents (end-to-end; files travel over a DataChannel, not through the
relay) or call media (TURN relays ciphertext). You could substitute a contact's key at first contact; users
detect this by comparing safety numbers. You can refuse service. The default log level is `LOG_LEVEL=WARNING`
(no IPs or numbers); verbose levels record more metadata - enable them knowingly and tell your users on `/privacy`.

## Check, update, uninstall

```bash
sudo /opt/phantom-messenger/selfhost/status.sh
sudo /opt/phantom-messenger/selfhost/selftest.sh     # DNS, TLS 1.3, HTTPS, WebSocket Origin, TURN, numbers key
sudo /opt/phantom-messenger/selfhost/update.sh phantom-selfhost-X.Y.Z.tar.gz   # SHA256SUMS[.sig] next to it
sudo /opt/phantom-messenger/selfhost/uninstall.sh [--purge]
```

`update.sh` verifies SHA-256 and the signature (a signature is mandatory: the key comes from the installed
`allowed_signers`), checks the manifest, backs up `backend.bak.*` / `client/dist.bak.*`, restarts the relay, waits up to
15 s for health and rolls back on failure. Updates restart the relay: clients reconnect, the RAM offline queue is lost.

Renewing the `turns:` certificate (Let's Encrypt, about every 60 days) restarts coturn - coturn cannot reload a
certificate in place - so **active TURN calls are dropped at that moment** (clients reconnect). Renewal runs at night
via the certbot timer; `pm-healthcheck` warns 21 days before expiry.

`cloudflare-*` modes: the Cloudflare CIDR list lives in `/etc/phantom-messenger/cf-ips.txt` (`TRUSTED_PROXIES_FILE`);
`pm-cf-update.timer` refreshes it daily and, with `--cf-only-443`, the ufw rules for 443; if the list changes the relay
is restarted to re-read it.

## License

The package and relay code are licensed under **GNU AGPL-3.0** (full text in `LICENSE`). If you modify the code
and offer the service to users over a network, you must offer those users the source of your modified version
under AGPL-3.0. Running unmodified code does not require this, but the source should remain reachable (for
example, link the project repository on your server's page).
