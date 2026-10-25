# Phantom Messenger — self-hosted server / сервер для самостоятельного размещения

## RU

Phantom Messenger — эфемерный мессенджер с E2E-шифрованием. Здесь лежит серверная часть для самостоятельного
размещения: relay (FastAPI) и веб-клиент (React/Vite), плюс установщик для Ubuntu (`selfhost/`).

- **Коды входа** отправляются через сервис номеров Phantom Numbers (phantomnumbers.org) по ключу оператора. Чтобы получить ключ,
  напишите на admin@phantommessenger.org.
- **Установка:** см. [selfhost/README.md](selfhost/README.md) (English: [selfhost/README.en.md](selfhost/README.en.md)).
- **Что видит оператор:** метаданные соединений (IP, номера, время, кто кому пишет, размер), публичные ключи,
  токены push; содержимое сообщений зашифровано end-to-end и оператору недоступно. Подробности — в selfhost/README.md.
- **Федерации нет:** каждый сервер — отдельный «остров», пользователи разных серверов друг друга не видят.
- **Лицензия:** GNU AGPL-3.0, см. [LICENSE](LICENSE); шрифты веб-клиента — SIL OFL 1.1 ([client/src/fonts/OFL.txt](client/src/fonts/OFL.txt)). Уязвимости: [SECURITY.md](SECURITY.md).

## EN

Phantom Messenger is an ephemeral end-to-end encrypted messenger. This repository contains the server side for
self-hosting: the relay (FastAPI), the web client (React/Vite) and an Ubuntu installer (`selfhost/`).

- **Login codes** are delivered through the Phantom Numbers service (phantomnumbers.org) using an operator key. To obtain a key,
  write to admin@phantommessenger.org.
- **Install:** see [selfhost/README.en.md](selfhost/README.en.md).
- **What the operator can see:** connection metadata (IP, numbers, timing, who talks to whom, sizes), public keys,
  push tokens; message content is end-to-end encrypted and not readable by the operator. See selfhost/README.en.md.
- **No federation:** every server is an isolated island; users of different servers cannot reach each other.
- **License:** GNU AGPL-3.0, see [LICENSE](LICENSE); web client fonts are SIL OFL 1.1 ([client/src/fonts/OFL.txt](client/src/fonts/OFL.txt)). Vulnerabilities: [SECURITY.md](SECURITY.md).
