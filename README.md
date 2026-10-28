# Phantom Messenger — self-hosted server / сервер для самостоятельного размещения

Языки: [RU](#ru) · [EN](#en)

## RU

Phantom Messenger — эфемерный мессенджер с E2E-шифрованием. Здесь лежит серверная часть для самостоятельного размещения:
relay (FastAPI), веб-клиент (React/Vite), TURN-сервер для звонков и установщик для Ubuntu. Приложения (Android, iOS, macOS)
подключаются к вашему серверу через «Настройки → Сервер → Сменить сервер».

### Что подготовить

1. **VPS** с Ubuntu 22.04, 24.04 или 26.04 LTS: 1 vCPU, от 1 ГБ RAM, 10 ГБ диска. Сервер должен быть выделенным (установщик
   сам настраивает nginx и coturn). Доступ по SSH под root или с `sudo`.
2. **Домен** (лучше поддомен), например `msg.example.com`, и **две DNS-записи**: `msg.example.com` и `turn.msg.example.com`
   (для звонков) — обе типа **A** на IP сервера, вторая всегда **DNS only**. Подробно — [DNS-записи](#dns-записи) ниже.
3. **Открытые порты** у провайдера VPS: `80/tcp`, `443/tcp`, `3478/tcp+udp`, `5349/tcp`, `49152–65535/udp`.
4. **Почта** — для Let's Encrypt и контакта оператора на страницах `/terms` и `/privacy`.

### DNS-записи

Создайте **до установки** две записи типа **A** на IP сервера (у регистратора домена или в Cloudflare):

| Имя | Тип | Значение | Для чего | Cloudflare |
|---|---|---|---|---|
| `msg.example.com` | A | IP сервера | сайт, веб-клиент, подключение приложений | режим TLS `1` — **DNS only** (серое облако); режимы `2`–`3` — можно проксировать (оранжевое) |
| `turn.msg.example.com` | A | IP сервера | звонки: на этом имени работают STUN и TURN (coturn) | всегда **DNS only** (серое облако) |

У большинства регистраторов в поле «Имя» пишут только левую часть: для домена `example.com` — `msg` и `turn.msg`.

**Зачем вторая запись.** Приложения и браузер соединяют звонки через STUN/TURN вашего сервера по имени `turn.<ваш домен>`.
Cloudflare не пропускает UDP, поэтому звонки не могут идти через оранжевое облако — отсюда отдельное имя в сером.
Без этой записи сайт, вход и сообщения работают, а **звонки не соединяются** (P2P-передача файлов между разными сетями — тоже).

**Установщик это имя не спрашивает**: он сам берёт `turn.<домен>`, показывает его в плане («TURN-хост») и после подтверждения
проверяет DNS. Если записи нет, он только предупреждает и продолжает установку. Звонки заработают, как только запись
появится (перезапускать ничего не нужно); TLS-вариант `turns:` включит повторный запуск той же командой. Другое имя — флаг `--turn-host`.

Проверка: `nslookup turn.msg.example.com` (или `dig +short turn.msg.example.com`) должна показать IP сервера; после установки
обе записи проверяет `sudo /opt/phantom-messenger/selfhost/selftest.sh`.

### Установка — одна команда

Зайдите на сервер по SSH и вставьте в терминал (без флагов):

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/newzealandgrom/phantommessenger/main/selfhost/get.sh)"
```

Команда скачивает последний релиз, **проверяет его подпись** зашитым в загрузчик ключом (отпечаток
`SHA256:SJIk2s8G8DM1FTJP4KB7gVfqU+oVBvk+PhwZMtpFMkY`) и запускает установщик. Любая ошибка проверки останавливает установку.
Сам загрузчик `get.sh` подписью не защищён — ему доверяют через HTTPS к GitHub (ветка `main`); подпись проверяется у архива
релиза. Кому этого мало — [ручная установка с проверкой подписи](#ручная-установка-с-проверкой-подписи) ниже.

Установщик сам задаст вопросы в терминале (Enter — значение по умолчанию в скобках):

| Вопрос | Что ответить | Пример |
|---|---|---|
| Домен сервера | ваш поддомен | `msg.example.com` |
| Режим TLS (1–4) | `1` — Let's Encrypt, если домен указывает прямо на сервер; `2` — Let's Encrypt через Cloudflare API; `3` — Cloudflare Origin Certificate; `4` — свой сертификат | `1` |
| Почта для Let's Encrypt | ваш e-mail | `you@example.com` |
| Имя оператора сервера | как вас видят пользователи в `/terms` | `Ivan Petrov` |
| Контактная почта оператора | для вопросов и удаления данных | `you@example.com` |
| Сайт оператора | ваш сайт или сервер | `https://msg.example.com` |
| Продолжить? [y/N] | посмотрите план и введите `y` | `y` |

Имя для звонков (`turn.<домен>`) установщик не спрашивает — запись нужно создать заранее, см. [DNS-записи](#dns-записи).

В режимах `2`–`4` дополнительно спросят файл токена Cloudflare (Zone:DNS:Edit) либо файлы сертификата и ключа.
Ключ сервиса номеров **вводить не нужно**: установщик сам регистрирует ваш сервер в сервисе номеров (Phantom Numbers) — для этого
порт 443 должен быть доступен из интернета.

Установка занимает несколько минут. В конце установщик печатает адрес сервера и команды проверки.

### Что будет установлено

relay Phantom Messenger (systemd-сервис `phantom-messenger`, отдельный пользователь, песочница) и веб-клиент; nginx с TLS 1.3 на
80/443; coturn (TURN/STUN) для звонков; сертификаты Let's Encrypt с автообновлением; ufw-правила (ufw сам не включается, пока вы
не попросите `--enable-ufw`); таймер самопроверки. Код — в `/opt/phantom-messenger`, конфиг и секреты — в `/etc/phantom-messenger`.

### Проверка

```bash
sudo /opt/phantom-messenger/selfhost/status.sh     # сервисы, сертификаты, порты, источник ключа номеров
sudo /opt/phantom-messenger/selfhost/selftest.sh   # снаружи: DNS, TLS 1.3, HTTPS, WebSocket, TURN, ключ номеров
```

Откройте `https://ваш-домен` в браузере — должен загрузиться веб-клиент. В приложении: «Настройки → Сервер → Сменить сервер» →
`https://ваш-домен`.

### Коды входа

Коды входа отправляет сервис номеров Phantom Numbers (phantomnumbers.org). Ключ интеграции выдаётся **автоматически** при установке
(после подтверждения владения доменом); коды для ваших пользователей приходят с пометкой «сторонний сервер». Лимиты для сторонних серверов
жёсткие; если нужен больший лимит — напишите на admin@phantommessenger.org и укажите домен. Сервер, который 3 суток не отвечает и не
запрашивает коды, снимается с регистрации автоматически (вернуться — с версии 0.1.1 достаточно запустить команду установки ещё раз;
`--reregister` — ручная ротация ключа). Подробности — в
[selfhost/README.md](selfhost/README.md#ключ-сервиса-номеров).

### Обновление и удаление

```bash
# обновление: та же команда установки (секреты и ключ сохраняются, relay перезапустится)
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/newzealandgrom/phantommessenger/main/selfhost/get.sh)"
# удаление (--purge — вместе с секретами и данными)
sudo /opt/phantom-messenger/selfhost/uninstall.sh
```

### Для опытных: без вопросов, с флагами

Все ответы можно передать флагами — те же вопросы пропускаются (флаги идут после `--`):

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/newzealandgrom/phantommessenger/main/selfhost/get.sh)" -- \
  --non-interactive --domain msg.example.com --email you@example.com --tls letsencrypt \
  --operator-name "Ivan Petrov" --operator-email you@example.com --operator-site https://msg.example.com
```

Список флагов: `install.sh --help`, [selfhost/README.md](selfhost/README.md). Проверить план без изменений: добавьте `--dry-run`.

### Ручная установка с проверкой подписи

Скачайте со страницы [Releases](https://github.com/newzealandgrom/phantommessenger/releases) файлы `phantom-selfhost-X.Y.Z.tar.gz`,
`SHA256SUMS`, `SHA256SUMS.sig`, проверьте подпись и запустите установщик — шаги подробно описаны в
[selfhost/README.md](selfhost/README.md#проверка-релиза-релизы-всегда-подписаны) (English: [selfhost/README.en.md](selfhost/README.en.md)).

### О проекте

- **Что видит оператор:** метаданные соединений (IP, номера, время, кто кому пишет, размер), публичные ключи, токены push; содержимое
  сообщений зашифровано end-to-end и оператору недоступно. Подробности — в selfhost/README.md.
- **Федерации нет:** каждый сервер — отдельный «остров», пользователи разных серверов друг друга не видят.
- **Лицензия:** GNU AGPL-3.0, см. [LICENSE](LICENSE); шрифты веб-клиента — SIL OFL 1.1 ([client/src/fonts/OFL.txt](client/src/fonts/OFL.txt)).
  Уязвимости: [SECURITY.md](SECURITY.md).

## EN

Phantom Messenger is an ephemeral end-to-end encrypted messenger. This repository contains the server side for self-hosting: the relay
(FastAPI), the web client (React/Vite), a TURN server for calls and an Ubuntu installer. The apps (Android, iOS, macOS) connect to your server via
"Settings → Server → Change server".

### What to prepare

1. **A VPS** running Ubuntu 22.04, 24.04 or 26.04 LTS: 1 vCPU, 1 GB+ RAM, 10 GB disk. It must be dedicated (the installer configures nginx and
   coturn itself). SSH access as root or with `sudo`.
2. **A domain** (preferably a subdomain), e.g. `msg.example.com`, and **two DNS records**: `msg.example.com` and `turn.msg.example.com`
   (for calls), both **A** records to the server IP, the second always **DNS only**. Details: [DNS records](#dns-records) below.
3. **Open ports** at your VPS provider: `80/tcp`, `443/tcp`, `3478/tcp+udp`, `5349/tcp`, `49152–65535/udp`.
4. **An e-mail** for Let's Encrypt and the operator contact shown on `/terms` and `/privacy`.

### DNS records

**Before installing**, create two **A** records pointing at the server IP (at your registrar or in Cloudflare):

| Name | Type | Value | Purpose | Cloudflare |
|---|---|---|---|---|
| `msg.example.com` | A | server IP | site, web client, app connections | TLS mode `1`: **DNS only** (grey cloud); modes `2`–`3`: may be proxied (orange) |
| `turn.msg.example.com` | A | server IP | calls: STUN and TURN (coturn) answer on this name | always **DNS only** (grey cloud) |

Most registrars want only the left part in the "Name" field: for `example.com` that is `msg` and `turn.msg`.

**Why the second record.** The apps and browsers connect calls through your server's STUN/TURN at `turn.<your domain>`.
Cloudflare does not pass UDP, so calls cannot go through the orange cloud - hence a separate grey-cloud name. Without this
record the site, sign-in and messages work, but **calls do not connect** (nor do P2P file transfers between different networks).

**The installer does not ask for this name**: it uses `turn.<domain>`, shows it in the plan ("TURN host") and checks DNS after
you confirm. If the record is missing it only warns and carries on. Calls start working as soon as the record appears (nothing
to restart); run the same command again to also enable the TLS variant `turns:`. Use `--turn-host` for a different name.

Check: `nslookup turn.msg.example.com` (or `dig +short turn.msg.example.com`) must print the server IP; after installation
`sudo /opt/phantom-messenger/selfhost/selftest.sh` checks both records.

### Install — one command

SSH to the server and paste (no flags):

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/newzealandgrom/phantommessenger/main/selfhost/get.sh)"
```

It downloads the latest release, **verifies its signature** with the key built into the loader (fingerprint
`SHA256:SJIk2s8G8DM1FTJP4KB7gVfqU+oVBvk+PhwZMtpFMkY`) and starts the installer. Any verification error stops the installation.
The loader `get.sh` itself is not signed - it is trusted via HTTPS to GitHub (branch `main`); the signature is verified on the release
archive. If that is not enough, see [Manual install with signature verification](#manual-install-with-signature-verification) below.

The installer asks its questions in the terminal (Enter accepts the default shown in brackets):

| Question | Answer | Example |
|---|---|---|
| Server domain | your subdomain | `msg.example.com` |
| TLS mode (1–4) | `1` Let's Encrypt when the domain points straight at the server; `2` Let's Encrypt via Cloudflare API; `3` Cloudflare Origin Certificate; `4` your own certificate | `1` |
| E-mail for Let's Encrypt | your e-mail | `you@example.com` |
| Operator name | how users see you on `/terms` | `Ivan Petrov` |
| Operator contact e-mail | for questions and data deletion | `you@example.com` |
| Operator site | your site or the server | `https://msg.example.com` |
| Continue? [y/N] | review the plan and type `y` | `y` |

The installer does not ask for the calls name (`turn.<domain>`) - create that record beforehand, see [DNS records](#dns-records).

Modes `2`–`4` additionally ask for the Cloudflare token file (Zone:DNS:Edit) or the certificate and key files. You do **not** enter a numbers
service key: the installer registers your server with the Phantom Numbers service by itself (port 443 must be reachable from the internet).

Installation takes a few minutes; at the end it prints the server address and check commands.

### What gets installed

The Phantom Messenger relay (systemd service `phantom-messenger`, dedicated user, sandboxed) and web client; nginx with TLS 1.3 on 80/443;
coturn (TURN/STUN) for calls; Let's Encrypt certificates with auto-renewal; ufw rules (ufw is not enabled unless you pass `--enable-ufw`); a
self-check timer. Code lives in `/opt/phantom-messenger`, config and secrets in `/etc/phantom-messenger`.

### Check

```bash
sudo /opt/phantom-messenger/selfhost/status.sh     # services, certificates, ports, numbers-key source
sudo /opt/phantom-messenger/selfhost/selftest.sh   # from outside: DNS, TLS 1.3, HTTPS, WebSocket, TURN, numbers key
```

Open `https://your-domain` in a browser - the web client should load. In the app: "Settings → Server → Change server" → `https://your-domain`.

### Login codes

Login codes are delivered by the Phantom Numbers service (phantomnumbers.org). The integration key is issued **automatically** during
installation (after you prove domain ownership); codes for your users carry a "third-party server" note. Limits for third-party servers are
strict; for a higher limit write to admin@phantommessenger.org with your domain. A server that does not answer and requests no codes for
3 days is unregistered automatically (to come back, since 0.1.1 just run the install command again; `--reregister` is for manual key rotation). Details: [selfhost/README.en.md](selfhost/README.en.md).

### Update and uninstall

```bash
# update: run the same install command (secrets and the key are kept, the relay restarts)
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/newzealandgrom/phantommessenger/main/selfhost/get.sh)"
# uninstall (--purge also removes secrets and data)
sudo /opt/phantom-messenger/selfhost/uninstall.sh
```

### Advanced: unattended, with flags

Every answer can be passed as a flag - the matching questions are skipped (flags go after `--`):

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/newzealandgrom/phantommessenger/main/selfhost/get.sh)" -- \
  --non-interactive --domain msg.example.com --email you@example.com --tls letsencrypt \
  --operator-name "Ivan Petrov" --operator-email you@example.com --operator-site https://msg.example.com
```

All flags: `install.sh --help`, [selfhost/README.en.md](selfhost/README.en.md). Add `--dry-run` to see the plan without changes.

### Manual install with signature verification

Download `phantom-selfhost-X.Y.Z.tar.gz`, `SHA256SUMS` and `SHA256SUMS.sig` from [Releases](https://github.com/newzealandgrom/phantommessenger/releases),
verify the signature and run the installer - see [selfhost/README.en.md](selfhost/README.en.md).

### About

- **What the operator can see:** connection metadata (IP, numbers, timing, who talks to whom, sizes), public keys, push tokens; message content is
  end-to-end encrypted and not readable by the operator. See selfhost/README.en.md.
- **No federation:** every server is an isolated island; users of different servers cannot reach each other.
- **License:** GNU AGPL-3.0, see [LICENSE](LICENSE); web client fonts are SIL OFL 1.1 ([client/src/fonts/OFL.txt](client/src/fonts/OFL.txt)).
  Vulnerabilities: [SECURITY.md](SECURITY.md).
