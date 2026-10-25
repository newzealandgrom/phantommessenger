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
- **Login codes go through the project owner's numbers service (Phantom Numbers, phantomnumbers.org).** You need an integration key (see
  below). The service sees the number, request time, your integration name (= your server) and your relay's IP;
  the number's owner sees a "login request from <your server>" message.
- **You are the operator.** Users trust you the way they trust the project on phantommessenger.org. See "What the
  operator can see".
- **The host must be dedicated.** The installer fully manages nginx and coturn (it overwrites `/etc/turnserver.conf`), takes ports 80/443/3478/5349 and stops coturn on uninstall. Other sites or a TURN server on the same host are not supported.
- `SECURITY_AUDIT.md` describes the project's own infrastructure and is **not** shipped; `/SECURITY_AUDIT.md` on
  your server returns 404.

## Requirements

| | |
|---|---|
| OS | Ubuntu 24.04 LTS (Python 3.12). Debian 12 is untested. Ubuntu 22.04 is unsupported. |
| Resources | 1 vCPU, >= 1 GB RAM (2 GB better), 10 GB disk. amd64 primary, arm64 best effort. |
| Host | a dedicated VPS: the installer takes ports 80/443 (nginx) and 3478/5349 (coturn) |
| Domain | a subdomain such as `msg.example.com` (a subdomain is recommended: the server's HSTS covers nested names) and `turn.msg.example.com` for TURN |
| Ports | 80/tcp, 443/tcp, 3478/tcp+udp, 5349/tcp, 49152-65535/udp - also open them at your VPS provider |
| Key | an integration key for the numbers service (see "Numbers service key") |

## Installation

```bash
tar xzf phantom-selfhost-X.Y.Z.tar.gz
cd phantom-selfhost-X.Y.Z
sudo ./install.sh --dry-run --non-interactive --domain msg.example.com --email you@example.com \
  --tls letsencrypt --service-key-file /root/numbers.key \
  --signer-fingerprint SHA256:SJIk2s8G8DM1FTJP4KB7gVfqU+oVBvk+PhwZMtpFMkY   # print the plan, change nothing
sudo ./install.sh                                                  # interactive
sudo ./install.sh --non-interactive --domain msg.example.com --email you@example.com \
  --tls letsencrypt --service-key-file /root/numbers.key \
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
`--email`, `--service-key-file` (or `PM_SERVICE_KEY`; `--service-key` is visible in `ps`), `--cf-api-token-file`
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

Login codes are sent and verified by the project owner's numbers service. The integration key is issued manually
by the owner (tell them your server domain and a contact). Rules: keep it only in `/etc/phantom-messenger/env`
(0640 root:phantom); never put it in command arguments, repositories or logs; one key per server; HTTP `401/403`
on sign-in means the key was revoked or replaced - request a new one and run
`sudo ./install.sh --service-key-file <file>`. Request limits are set by the numbers service.

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
