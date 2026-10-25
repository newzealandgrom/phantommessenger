# P2P v2 — «P2P-first»: сообщения, файлы и звонки в обход relay (спецификация, 2026-10-16)

Статус: **к реализации** (брифы web/Android/iOS выданы оркестратором). Источник правды по wire relay —
`client/src/types.ts`; этот документ описывает только DataChannel-слой и правила выбора транспорта.
Опирается на `PROTOCOL_V2_SPEC.md` (конверт v2) и `PROTOCOL_S10_SPEC.md` (meta1, keyAlert/`canSendTo`, Q9 ICE).

## 0. Цель и границы

Входит: (1) P2P DataChannel `phantom-p2p` поднимается превентивно и используется первым для текста,
реакций, квитанций, typing, edit/delete, голоса; (2) файлы любого размера идут **только** по DC, relay
их не видит и не хранит; (3) звонки — медиа никогда не идёт через relay; UI показывает путь
(«напрямую»/«через TURN»); (4) совместимость со старыми клиентами через `hello.features`.
Не входит: докачка после обрыва (v2 оставляет место — `file_accept.fromChunk`), копии файлов на свои
устройства (`message_sync`), групповые чаты, mesh.

Что НЕ меняется: конверт v2 и meta1 для содержимого, TOFU-пины, `canSendTo`, фильтр ICE-кандидатов
(host/prflx не отправляются), сигналинг `p2p_offer/p2p_answer/p2p_ice_candidate` через relay
(`backend/main.py:4219-4245`, relay SDP не разбирает), приём легаси `file_message`/meta1 `k=file` от
старых клиентов.

## 1. Факты по коду, от которых зависят решения

| Факт | Где |
|---|---|
| `peer_online` relay шлёт только сессиям с `session.peer_id == number` (тем, кто делал `lookup`/слал этому номеру) и не шлёт вовсе при `_presence_hidden` | `backend/main.py:3368-3373`, `set_presence` 3500-3505 |
| `lookup_result.online = false` при скрытом статусе | `backend/main.py:3643`, `_presence_visible` 914-917 |
| `p2p_offer` адресату без сессии → отправителю `peer_offline {reason:"no_session"}` **независимо от скрытого статуса**; адресат с сессией — `_get_any_session(target)` (произвольное устройство) | `backend/main.py:4236-4245` |
| Лимит `p2p_offer` 30/мин на номер (`rate_limited`), блок-лист в обе стороны → молчаливый дроп | `backend/main.py:4228-4233` |
| Размер любого WS-кадра ≤ `WS_MAX_MESSAGE_BYTES` (иначе close 1009) | `backend/main.py:3292-3297` |
| Web: P2P используется только если `sendRelay()` вернул false | `client/src/App.tsx:2698-2707` |
| Web/Android/iOS не принимают бинарные DC-кадры; `bufferedAmount` не учитывается | `App.tsx:3944`, `P2PManager.kt:351,375`, `P2PManager.swift:331-336` |
| iOS `CallPrivacy.p2pPolicy()` не учитывает «не контакт» (у звонков учитывает) | `CallPrivacy.swift:18-25` |
| Звонки: ICE `all` для контактов при выкл. `privateCalls`, иначе `relay` — на всех трёх платформах | web `App.tsx:2916-2925`; Android `CallViewModel.kt:129-132, 472-481`; iOS `CallView.swift:101-103` |
| Android: экран звонка показывает жёсткий текст «В ЭФИРЕ · RELAY» независимо от пути | `ui/call/redesign/CallScreens.kt:335` |

Вывод по presence: при скрытом статусе клиент **не узнаёт** онлайн собеседника ни из `lookup_result`, ни
из `peer_online`. Единственный надёжный «зонд» — сам `p2p_offer`: relay немедленно отвечает
`peer_offline/no_session`, если адресата нет. Поэтому превентивный канал строится по триггерам §3.2,
а не по presence.

## 2. Настройка и политика приватности

- Хранимый ключ прежний: web `privacySettings.p2pFallback`, Android `PrivacySettings.KEY_P2P_FALLBACK`
  (`phantom_p2p_fallback`), iOS `CallPrivacy.p2pFallbackKey`. **Дефолт — ВКЛ** (нет значения → true).
- UI: «Прямое соединение (P2P)», подпись: «Сообщения и файлы идут напрямую между устройствами, сервер
  видит только служебный сигналинг. Файлы передаются только напрямую. Собеседник-контакт может видеть ваш
  IP-адрес, если не включено „Скрывать IP“». Выкл. → `p2p_offer` не шлём и входящие игнорируем (как сейчас).
- Гейт пира (без изменений): не свой номер, не блок-лист, (контакт ИЛИ переписка в любую сторону в этой сессии —
  мы ему писали или он нам; фактическое поведение web и macOS, CR-08), `canSendTo(peer)` для новых каналов.
  Прежняя формулировка «мы ему писали» уже фактического поведения (§3.2(c) — входящее от пира тоже открывает гейт);
  соответствие Android/iOS этой формулировке не проверялось.
  macOS (18.10.2026): эквивалент «переписки» — TOFU-пин identity-ключа пира (персистентный, ставится только после
  успешной расшифровки его сообщения), иначе после перезапуска (история в RAM) offer пира отбрасывался и канал ждал таймаута.
  Web (18.10.2026) — то же: пин из `localStorage` (`pinned_identity`, стирается явным logout/panic) открывает гейт.
- ICE-политика DC = политика звонков: `relay` при `privateCalls` ИЛИ не-контакт, иначе `all` без
  host/prflx. **iOS**: `P2PManager.createPeerConnection` обязан использовать
  `CallPrivacy.callPolicy(peerIsContact:)`, а не `p2pPolicy()`. Без TURN relay-only канал не создаётся.
- Скрытый статус («Статус в сети» выкл.): автостарт по §3.2(a)(b) не сработает (relay не даёт сигналов), но
  клиент **отвечает** на входящие `p2p_offer` от пиров, прошедших гейт, и сам инициирует по (c)(d). Это
  раскрывает факт онлайна контакту, с которым уже идёт переписка. Записать в `SECURITY_AUDIT.md`.

## 3. DataChannel: установка, `hello`, транспортные правила

### 3.1 Канал
`phantom-p2p`, `ordered: true`, reliable (без `maxRetransmits`/`maxPacketLifeTime`). Один канал на номер
собеседника. `binaryType = "arraybuffer"` (web). Лимиты процесса: ≤ 32 каналов, `connecting` > 30 с → close.
TURN-креды: при `relayOnly` пересоздание за ≥ 5 мин до `expiresAt` (как сейчас).

### 3.2 Триггеры установки (инициатор — любой из триггеров ниже)
(a) `peer_online` от relay; (b) `lookup_result.online == true` при открытии чата; (c) **любое входящее
сообщение/реакция/typing от пира через relay** (надёжнее presence); (d) пользователь ставит файл в
отправку (§5) — немедленная попытка, затем повтор с backoff 5 с → 15 с → 60 с → 5 мин, пока файл в
статусе «ожидает собеседника» и чат открыт/приложение активно; (e) ручная кнопка «P2P режим» (web).
Ответ `peer_offline/no_session` на offer → пир офлайн: следующий повтор только по backoff или по новому
триггеру (c). Повторы не должны упираться в лимит 30/мин: ≤ 6 offer в минуту на номер со стороны клиента.

### 3.3 Glare (одновременные offer) — «вежливый пир»
Если пришёл `p2p_offer`, а у нас уже есть канал `connecting` c `initiator = true` к тому же номеру:
- наш номер лексикографически **больше** → мы вежливые: закрываем свой PeerConnection, отвечаем на чужой offer;
- наш номер **меньше** → игнорируем чужой offer, ждём его `p2p_answer` (вежливый пир его пришлёт).
- **«Протухший» offer** (18.10.2026): если наш номер меньше, но наш offer отправлен **≥ 3 с** назад и `p2p_answer`
  на него нет — вежливый пир его отбросил (перезагрузка/перезаход: RAM пуста и гейт §2 не пройден; рестарт
  вкладки), а его встречный offer — новый. Тогда невежливая сторона тоже уступает: закрывает свой
  PeerConnection и отвечает на чужой. Чужой offer, пришедший при **свежем** своём (< 3 с), не теряется:
  запоминается и пересматривается в момент «свой + 3 с» (если answer пришёл — игнор; нет — уступаем); такой
  отложенный offer живёт ≤ 10 с от получения. Причина: прежнее правило давало дедлок — невежливый ждал
  answer, которого не будет, до таймаута `connecting` 30 с + backoff (файл web→mac уходил через 30–45 с).
  Настоящий glare (оба живы) по-прежнему даёт один канал: answer вежливого приходит раньше 3 с. Эталон
  решения — `client/src/lib/p2pGlare.ts` (тест `npm run test:p2p-glare`), то же в Core `P2PManager.handleOffer`.
Если канал уже `open` — входящий offer от того же номера = запрос пересоздания (ICE-restart): принять только
если `remoteDescSet` и старый канал `failed/closed`, иначе игнор. Автостарт по (a)(b) по-прежнему делает
только лексикографически меньший (без изменений), (c)(d)(e) — любой.

### 3.4 `hello` (первый кадр после `open`, текст JSON)
```
{ "type":"hello", "version":2,
  "features":["messages","delivery_ack","files_v1","events_v1"],
  "deviceId":"<hex16 — свой device_id из ?device_id=>",
  "maxChunk":65536, "maxInflight":3 }
```
- Старые клиенты шлют `{"type":"hello","version":1}` (web — с `features:["messages","delivery_ack"]`) и
  игнорируют неизвестные типы и бинарные кадры → безопасно. Пока `hello` от пира не получен (≤ 5 с после
  `open`) — считать `features = ["messages"]`.
- `files_v1` отсутствует у пира → файлы по DC не предлагать; UI: «Собеседник использует старую версию
  приложения — отправка файлов недоступна» (файл остаётся в «ожидает»; при появлении канала с `files_v1`
  уйдёт). `events_v1` отсутствует → реакции/квитанции/typing/edit/delete — через relay.
- `deviceId` нужен для мульти-девайса (§3.6). Неизвестные поля игнорируются.
- **Ответный `hello`** (23.10.2026): на **первый** `hello` пира в канале сторона один раз отправляет свой
  `hello` ещё раз (если свой первый уже ушёл; иначе он уйдёт по `open`). Повторный `hello` пира ответа не
  вызывает → каждая сторона шлёт ≤ 2 `hello`, обмен конечен. Приёмник обязан терпеть повторный `hello`
  (обновить features/deviceId, ничего не сбрасывать) — старые клиенты так и делают. Причина: iOS/macOS до
  23.10.2026 назначали delegate DC отвечающей стороны на main с задержкой, а RTCDataChannel без delegate
  молча теряет кадры — `hello` инициатора (web/Android шлют его сразу в `open`) пропадал, через 5 с канал
  считался «старой версией» без `files_v1`, файлы не уходили. Их собственный `hello` приходит уже после
  назначения delegate, поэтому ответ до них доходит. Новые iOS/macOS назначают delegate синхронно в
  `peerConnection(_:didOpen:)` (`Core/P2PManager.swift`). Реализации: web `buildHelloFrame`/`parseHelloFrame`
  (`client/src/lib/p2pFile.ts`, тест `npm run test:p2p-file`), Android `P2PManager.handleHello`, Core
  `P2PManager.didReceiveMessage`.

### 3.5 Выбор транспорта (единая функция на платформу, напр. `pickTransport(peer, kind)`)
```
canP2P(peer) = dc.open && helloReceived && canSendTo(peer) && !blocked(peer)
multiDevice(peer) = (lookup_result.devices.length > 1)        // peerDevices из последнего lookup
text/voice/edit/reaction/delete/receipts/typing:
    if canP2P && !multiDevice && feature ∋ нужный  → DC (fallback relay при ошибке send)
    else → relay (как сейчас: WS → offline-очередь; Android ещё HTTP)
file:  только DC (§5); нет канала → «ожидает собеседника»
call:  как сейчас (§7)
```
- Текст по DC: `{type:"message", messageId, encryptedBlob}` (meta1 внутри) — без изменений формата. Статус
  `sent` при успешном `dc.send`; `delivered` по `delivery_ack` (Android/iOS добавляют отправку и приём
  `delivery_ack`, как web `App.tsx:3961-3975`). Если за 10 с нет `delivery_ack` или DC закрылся до него —
  повторить через relay с тем же `messageId` (возможен дубль P2P+relay).
- Голосовые (≤ 140 КиБ, meta1 `k=voice`): как текст — DC, если `canP2P`, иначе relay. Обоснование: голос —
  сообщение, должен доходить офлайн-собеседнику через RAM-очередь relay; лимит кадра его уже вмещает;
  отдельный файловый протокол для него избыточен. Файлы, напротив, идут только DC (§5).
- Дедуп на приёме по `messageId` для всех типов и обоих транспортов (есть на всех платформах; web —
  внутри `handleIncomingEnvelope`, Android `hasMessage`, iOS по `id/wireId`).

### 3.6 Мульти-девайс (mdev1)
P2P-канал один на номер и relay доставляет `p2p_offer` произвольному устройству
(`_get_any_session`). Правило: если у собеседника > 1 устройства (`lookup_result.devices`), текст и
события идут через relay с `deviceBlobs` (все устройства получат); **файл** уходит на то устройство, с
которым открыт DC (`hello.deviceId`). UI под пузырём файла: «Доставлено на одно устройство собеседника».
Если `hello.deviceId` не совпадает ни с одним `devices[].deviceId` из lookup — канал всё равно валиден
(ключ проверяется на уровне конверта v2/TOFU), но подсказка показывается.

### 3.7 События по DC (`events_v1`)
Кадры — те же JSON, что уходят на relay (`RelayOutbound` в `types.ts`), **без** `toNumber` и `deviceBlobs`:
`typing`, `read_receipt`, `delivery_receipt`, `message_edit`, `message_delete`, `reaction`, `burn_read_ack`,
`screenshot_alert`. Приёмник подставляет `fromNumber = peer` (значение из кадра игнорируется — пир не
может выдать себя за другого) и отдаёт **тот же обработчик**, что для relay-кадра. Кадр > 256 КиБ,
неизвестный `type`, бинарный кадр с неизвестным `fileId` → дроп без разрыва канала. `canSendTo` не
применяется к `read_receipt`/`delivery_receipt`/`typing` (как у relay, Q7).

## 4. Крипто файлов (`files_v1`)

### 4.1 Почему своё шифрование поверх DTLS
Relay видит SDP и теоретически может подменить DTLS-отпечатки (MITM DTLS); SAS звонков это выявляет, у DC
сверки нет. Поэтому содержимое файла шифруется ключом, который передаётся в конверте v2 (ECDH с identity-
ключом собеседника + TOFU) — relay/TURN/MITM DTLS видят только шифртекст и размеры.

### 4.2 `file_offer`
Текстовый кадр DC: `{ "type":"file_offer", "messageId":"<uuid>", "fileId":"<hex32>", "encryptedBlob": <v2> }`.
Plaintext конверта (тот же encrypt, что для `message`; from/to = свои номера) = `0x00` ‖ компактный JSON:
```
{ "k":"file_offer", "id":"<messageId>", "fileId":"<hex32 = 16 случайных байт>",
  "name":"<≤255>", "mime":"type/subtype", "size":<int ≥ 1>,
  "sha256":"<hex64 от plaintext всего файла>",
  "key":"<base64 std, 32 байта>", "nonceBase":"<base64 std, 8 байт>",
  "chunk":<int 1..65536>,
  "text":"<подпись, опц.>", "replyTo":{"messageId","from"} (опц.), "sd":<1..604800|"read"> (опц.) }
```
- Валидация как в meta1 (Q5/Q19): `name` без Cc/Cf и `/ \`, ≤ 255; `mime` ≤ 127 по regex — только подсказка;
  `size ≥ 1`; `chunk` 1..65536; `key` 32 Б, `nonceBase` 8 Б, `fileId` 16 Б, `sha256` 32 Б, `id == messageId`
  снаружи, `fileId` внутри == снаружи (Q3/Q4: защита от перестановки). Нарушение → `file_abort {reason:"invalid"}`.
- `k=file_offer`, пришедший через relay (не DC) → дроп (Q3). `k=file` (легаси meta1 ≤ 140 КиБ) по DC —
  принимать как сейчас (старые клиенты так не шлют по DC, но правило единое: диспетчер один).
- Конверт v2 обеспечивает: TOFU/keyAlert, привязку к номерам (`info`/AD), подлинность отправителя.

### 4.3 Чанки (бинарные кадры DC)
```
frame = fileId(16) ‖ ctr(4, BE, от 0) ‖ AES-256-GCM(key, nonce, plaintext_i, AD) ‖ tag(16)
nonce = nonceBase(8) ‖ ctr(4, BE)                       — 12 байт, уникален при уникальном ctr
AD    = UTF8("phantom-p2p-file:1:" + from + ":" + to) ‖ fileId(16) ‖ ctr(4, BE)
plaintext_i = file[ctr*chunk : min((ctr+1)*chunk, size)],  n = ceil(size/chunk), 0 ≤ ctr < n
```
Обоснование: ключ случайный на файл и нигде не переиспользуется → `nonceBase ‖ ctr` гарантирует
уникальность nonce (≤ 2^32 чанков); `fileId‖ctr` в AD исключает подстановку чанка другого файла или
перестановку чанков даже при равном ключе; номера в AD — та же дисциплина, что у v2/meta1
(`from`/`to` как в конверте `file_offer`). GCM аутентифицирует каждый чанк, `sha256` подтверждает
целостность и полноту (защита от усечения: `file_end` без последних чанков → несовпадение `n` и sha256).
Размер кадра ≤ 20 + 65536 + 16 = 65 572 Б. Чанк-размер объявляет отправитель (`chunk`), по умолчанию 65536;
получатель обязан принимать любой 1..65536.

### 4.4 Управляющие кадры (текст JSON)
```
file_accept {type, fileId}                          — получатель готов (проверил диск/лимиты)
file_end    {type, fileId}                          — отправитель передал n чанков
file_done   {type, fileId, messageId}               — sha256 и n сошлись; файл сохранён
file_abort  {type, fileId, reason}                  — любая сторона; reason ∈ {
   "declined","busy","disk_full","too_large","unsupported","timeout","invalid","cancelled","protocol","io" }
file_cancel = file_abort{reason:"cancelled"}        — отдельного типа нет
```
Неизвестный `reason` → показывать «Передача прервана», канал не рвать.

### 4.5 Лимиты и защита
- Параллельно ≤ 3 входящих и ≤ 3 исходящих передач на пира; 4-й `file_offer` → `file_abort busy`.
- Таймауты: ожидание `file_accept` 30 с; нет чанков 60 с (приём) / нет `file_done` 60 с после `file_end`
  (отправка) → `abort timeout`; `connecting` канал — 30 с.
- Backpressure: отправитель не вызывает `send`, если `bufferedAmount > 1 МиБ`; продолжает по
  `bufferedAmountLowThreshold = 256 КиБ` (web `onbufferedamountlow`, Android `onBufferedAmountChange` +
  `bufferedAmount()`, iOS `dataChannelDidChangeBufferedAmount`). Чтение файла — потоково (web
  `File.slice`, Android `InputStream`, iOS `FileHandle`), не целиком в память.
- Диск: перед `file_accept` — свободно ≥ `size + 64 МиБ` (Android `StatFs`, iOS
  `volumeAvailableCapacityForImportantUsage`), иначе `disk_full`. Web: RAM/Blob; при `size > 2 ГиБ` →
  `too_large` (ограничение Blob в браузерах).
- Входящий чанк: `fileId` неизвестен/не в состоянии `receiving` → дроп; `ctr != expected` → `abort protocol`;
  длина plaintext ≠ ожидаемой → `abort protocol`; GCM fail → `abort invalid`, частичный файл удалить.
- `file_offer` принимается только по DC, прошедшему `hello`, от номера, прошедшего гейт §2 и не в
  блок-листе; конверт прошёл GCM и TOFU (новый пин → правила S9 P6, keyAlert — как для текста; приём не
  блокируется, блокируется только отправка).
- Имя файла санитизируется на диске (Android: как сейчас `file_<msgId>.<ext>`; iOS `AttachmentStore.safeName`;
  web — только для `download` атрибута). `mime` для открытия — по сниффингу (web `sniffFile`), не доверять.
- Не логировать имена файлов, размеры, номера, адреса.

## 5. State-машины

### 5.1 Отправитель
```
queued ──(dc open ∧ files_v1 ∧ canSendTo)──▶ offered ──file_accept──▶ sending ──последний чанк──▶ ended
  │  ▲ backoff §3.2(d)                          │ timeout/abort        │ dc close → re-offer (≤ 3 раза)   │
  │  └──────────── dc close ───────────────────┘                      ▼                                   ▼ file_done
  └──(пользователь «Отменить»)──▶ cancelled                        failed                               delivered
```
UI (по-русски): `queued` → «Ожидает собеседника» (кнопка «Отменить»); `offered` → «Соединение…»; `sending`
→ «Отправка 37 %» (progress); `ended` → «Проверка…»; `delivered` → «Доставлено»; `failed` → «Не отправлено ·
<причина>» (кнопка «Повторить»); `cancelled` → «Отменено». `multiDevice` → подпись «Доставлено на одно
устройство собеседника».

### 5.2 Получатель
```
offered ──проверки §4.5 ok──▶ receiving ──n чанков + file_end──▶ verifying ──sha256 ok──▶ done
   │ busy/disk_full/invalid        │ timeout/protocol/invalid/dc close        │ mismatch
   ▼                               ▼                                           ▼
 abort(reason)                   failed (частичный файл удалён)              abort invalid
```
Файл сначала пишется в `<путь>.part`, по `done` переименовывается. Пузырь появляется на `offered`
(имя/размер из `file_offer`) с прогрессом «Приём 37 %»; `failed` → «Передача прервана».

### 5.3 Хранение
- Android: `noBackupFilesDir/phantom_files/<number>/file_<msgId>.<ext>` (как сейчас, `ChatViewModel.kt:3340`),
  потоковая запись `FileOutputStream`, затем `AttachmentOpener` без изменений.
- iOS: **новый каталог** `Application Support/attachments/<self>/<sha256(messageId)[..32]>/<safeName>` с
  `FileProtectionType.complete`, `isExcludedFromBackup = true`, потоковая запись `FileHandle`; QuickLook
  открывает оттуда. `AttachmentStore` (`ChatRoomView.swift:65-95`, сейчас `tmp/attachments`) расширяется:
  `tmp` остаётся для легаси ≤ 140 КиБ в `fileData`. Удаление сообщения/logout/panic — удалить каталог.
- Web: чанки → `Blob(parts, {type: sniffedMime})` → `URL.createObjectURL`; в `ChatMessage.fileUrl`
  (новое поле); `fileData` (data: URL) — только легаси. `revokeObjectURL` при удалении/logout. История RAM.
- Поля `ChatMessage` на всех платформах: `transport?: "p2p"|"relay"`, `progress?: 0..1`,
  `transferState?: "waiting_peer"|"offered"|"transferring"|"verifying"|"done"|"failed"|"cancelled"`,
  `fileId?`.

## 6. Relay

Изменений кода relay для v1 файлов **нет**: (а) ответ отправителю при офлайн адресате уже есть
(`peer_offline/no_session`, `backend/main.py:4244`); (б) `p2p_*` кадры — только SDP/ICE, ограничены
`WS_MAX_MESSAGE_BYTES`; (в) файлы по relay больше не отправляются новыми клиентами — обновить
`SECURITY_AUDIT.md` (строки 33, 62-65, 103, 108: «P2P включён по умолчанию», «файлы между клиентами
`files_v1` проходят только напрямую/через TURN в шифрованном виде; relay видит SDP/ICE и факт
соединения; файлы от легаси-клиентов по-прежнему проходят через RAM-очередь relay») и строку `storage`
в `GET /api/audit` (`backend/main.py:2057-2061`) — добавить «files: never stored; legacy-only transit».
Опционально (отдельный шаг, не блокирует): `p2p_offer.deviceId` для адресной доставки устройству.

## 7. Звонки

### 7.1 Текущая политика (проверено по коду, баг не найден)
- web `App.tsx:2916-2925`: `relayOnly = privateCalls || !contact`; иначе `iceTransportPolicy:"all"`.
- Android `CallViewModel.kt:129-132` `shouldForceRelay`, `472-481` `RELAY`/`ALL`; `policy == null → relay`
  (ставит `MainActivity`). `IceCandidateFilter` убирает host/prflx.
- iOS `CallView.swift:101-103` → `CallPrivacy.callPolicy(peerIsContact:)` (`CallPrivacy.swift:18-20`).
Итого: контакт + `privateCalls` выкл → `all`: srflx через STUN даёт прямое соединение, TURN — только
fallback NAT. Не-контакт → `relay`. **Исключение — P2P DC на iOS** (`p2pPolicy()` без проверки контакта) —
исправляется в этом релизе.

### 7.2 Заявление (в `SECURITY_AUDIT.md`)
Медиа звонков (аудио/видео) и содержимое DC **никогда** не проходят через relay-сервер: relay пересылает
только SDP/ICE-сигналинг. При пути «через TURN» coturn ретранслирует DTLS-SRTP/DTLS-SCTP шифртекст и видит
IP-адреса сторон. SAS `phantom-call-sas-v1` сверяет DTLS-отпечатки (защита от подмены SDP relay'ем).

### 7.3 Индикатор пути в UI звонка
`callPath ∈ {"", "direct", "turn"}` в состоянии звонка; определяется после `connected` и при каждой смене
`iceConnectionState` (плюс опрос раз в 5 с): по `getStats()` найти `transport.selectedCandidatePairId`
(web/Android: отчёт `candidate-pair` с `nominated && state=="succeeded"`; iOS `RTCStatisticsReport`
аналогично); `localCandidate.candidateType == "relay" || remoteCandidate.candidateType == "relay"` → `turn`,
иначе `direct`. Подпись: «Напрямую» / «Через TURN» рядом с кодом звонка (web `CallOverlay.tsx:150-170`,
Android `CallScreens.kt:386-387` и замена жёсткого «В ЭФИРЕ · RELAY» `:335`, iOS `CallScreens.swift:317-318`).
Адреса/кандидаты не логировать. Код звонков иначе не трогать.

### 7.4 Ренеготиация и ICE-рестарт в звонке (17.10.2026, после инцидента с квотой coturn)
Единые правила для web / Android / iOS (perfect negotiation, W3C):
- **Роли.** Вызываемый — «вежливый», инициатор — «невежливый» (фиксируется при начале звонка:
  web `isCallerRef`, iOS `isOutgoingCall`, Android `callerNumber.isEmpty()`). Повторный `call_offer` в идущем
  звонке (ICE-рестарт, добавление видео): если у нас самого висит неотвеченный offer (`have-local-offer`) или
  offer создаётся прямо сейчас, вежливый делает `rollback` (только из `have-local-offer`, в `stable` rollback —
  ошибка) и отвечает на чужой; невежливый чужой offer игнорирует — вежливый откатится и ответит на наш.
  `call_answer` применяется только в `have-local-offer`; запоздавший — отбрасывается.
- **ICE-рестарт.** `disconnected` часто временный: рестарт только если состояние держится 5 с (web
  `ICE_DISCONNECT_TIMEOUT_MS`, iOS `iceDisconnectGraceSeconds`, Android `iceRestartJob`); `failed` — сразу.
  Рестарт не начинается, пока идёт любая негоциация (`signalingState != stable` или offer в полёте — флаг
  держится и на время запроса `/api/ice`); если за время запроса пришёл и был применён offer собеседника,
  свой рестарт отменяется. Перед рестартом креды TURN освежаются (`/api/ice`, `setConfiguration`), но при сбое
  запроса действующие серверы не трогаются. Offer рестарта — без `OfferToReceive*` (направления трансиверов
  сохраняются). Лимит попыток: web 2, Android 2, iOS 3; при исчерпании — `call_hangup` собеседнику и
  завершение, а не тихий выход.
- **Пин DTLS-отпечатка удалённой стороны (CR-01, 18.10.2026).** На время звонка первый `a=fingerprint` (sha-256) из
  SDP собеседника фиксируется — для вызываемого уже из входящего offer, до «Принять»; любой последующий offer/answer
  (ренеготиация, ICE-рестарт, повторный `call_incoming`) с другим отпечатком или без него → `call_hangup` и завершение
  звонка. Иначе relay или MITM, подменив отпечаток в ренеготиации после сверки кода звонка, перехватит DTLS-SRTP.
  У вызывающего пин берётся из первого answer; при новом `callId` и завершении звонка сбрасывается. Входящий offer
  без sha-256-отпечатка на web/Android/iOS не звонит (`call_hangup` сразу), на macOS звонит и отвергается при «Принять».
  Отпечатком считается только первая строка `a=fingerprint:sha-256` (битое значение в ней — отказ) на всех платформах. ICE-рестарт тем же PeerConnection отпечаток не меняет —
  проверка проходит, glare и рестарт не затронуты. Первый отпечаток пин не аутентифицирует — это делает сверка кода
  звонка голосом. **Реализовано: все платформы.** Чистая функция `acceptRemoteFingerprint(pinned, sdp)` рядом с
  `sdpFingerprint` (null/nil — отказ): web `client/src/lib/callSas.ts` (обёртка `acceptRemoteCallSdp` в `App.tsx`:
  `call_incoming` — новый, повторный до «Принять», ренеготиация; `call_answer`; `answerCall` до создания PeerConnection),
  Android `data/crypto/CallSas.kt` (обёртка `CallViewModel.acceptRemoteSdp`: `CallIncoming`, `acceptCallNow`,
  ренеготиация, `CallAnswer`), iOS `Core/CallSas.swift` (обёртка `CallViewModel.acceptRemoteFingerprint` в
  `CallView.swift`: `handleIncomingCall`, повторный offer в `.ringing`, `acceptCall`, `handleCallAnswer`,
  `handleRenegotiationOffer`), macOS `mac/PhantomMac/Calls/CallSession.swift` (`acceptRemoteFingerprint`). Тесты:
  `client/scripts/test-call-pin.mjs` (`npm run test:call-pin`), `DtlsPinTest.kt`, `scratchpad/ios-dev/dtls_pin_test.swift`,
  `mac/tests/call_logic_test.swift`.
- **Отправка offer.** Только после успешного `setLocalDescription`; если за это время состояние ушло из
  `stable` (чужой offer принят), свой offer не отправляется — libwebrtc/браузер сами повторно запросят
  негоциацию (`negotiationneeded`), когда вернётся `stable`.
- **TURN на проде.** Клиент одновременно держит несколько аллокаций (P2P-канал + звонок + рестарты, по TURN-URL
  на каждую сеть), поэтому `user-quota` coturn ≥ 60, а `bps-capacity` не используется (он резервирует
  `max-bps` на сессию и ограничивал весь сервер шестью аллокациями). Проверка — `scripts/turn_selftest.py`.

## 8. Совместимость и миграция
- Старый ↔ новый: `hello v1` → только `messages`; файлы по DC не предлагаются; текст по DC как раньше.
- Новый отправляет файл старому: UI «Собеседник использует старую версию…», файл ждёт.
- Легаси приём `file_message`/meta1 `k=file` через relay — остаётся на всех платформах (от старых клиентов).
- `p2pFallback` выкл. у одной стороны → всё через relay; файлы «ожидают» бесконечно → UI показывает
  «Прямое соединение выключено у вас» (если выкл. у нас) — кнопка в настройки.
- Версионирование: `hello.version = 2`; будущие изменения кадров — новые `features` (`files_v2`), старые
  поддерживаются ≥ один релиз.

## 9. Эталон
`documentation/p2p_file_vector.json` (генератор `scripts/gen_p2p_file_vector.py`, запуск
`venv/bin/python -I scripts/gen_p2p_file_vector.py documentation/protocol_v2_vector.json documentation/p2p_file_vector.json`):
фиксированные `key`, `nonceBase`, `fileId`, `from=1001`, `to=1002`, `chunk=16`, файл 40 байт → 3 чанка
(16/16/8) с hex шифртекста кадров, `sha256`, JSON `file_offer` до шифрования и его конверт v2 на ключах
`protocol_v2_vector.json` (расшифровывается как получатель `id_B`), sha256 кадра для 64 КиБ нулевого
чанка, негативы: чужой `ctr` в AD, чужой `fileId`, усечение (2 чанка + `file_end`). Платформы обязаны:
(а) расшифровать `file_offer`; (б) побайтово совпасть по кадрам 0..2 при заданных key/nonceBase;
(в) собрать файл и сверить sha256; (г) негативы дают ошибку GCM / `protocol`.
