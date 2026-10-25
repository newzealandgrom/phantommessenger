## S9. Протокол конверта v2 (черновик оркестратора, 2026-10-12)

Цель: закрыть X-01 «единый протокол» и X-02 — привязать каждое сообщение к identity-ключу отправителя, сделать подмену ключа relay'ем обнаруживаемой автоматически. Wire остаётся JSON `encryptedBlob`, relay прозрачен.

### S9.1 Ключи
- **Identity-ключ устройства** `id` = уже существующий персистентный статический P-256 ключ (web IndexedDB per-number, Android EncryptedSharedPreferences, iOS Keychain). Регистрируется на relay через `register` (как сейчас), это же ключ в `lookup_result`, safety number и fingerprint.
- **Эфемерный ключ** `eph` = новая P-256 пара на каждое сообщение, приватная часть затирается.
- Публичные ключи на wire — raw uncompressed x963 (65 байт, `0x04‖X‖Y`), base64 standard с padding (как сейчас).

### S9.2 EncryptedBlob v2
```
{
  "version": 2,
  "senderPublicKey":   base64(raw65(eph_pub_A)),   // имя поля как в v1 — старые парсеры не падают
  "senderIdentityKey": base64(raw65(id_pub_A)),
  "nonce": base64(12 байт), "iv": то же значение (дубликат для совместимости парсеров),
  "cipher": base64(ciphertext ‖ tag16)
}
```

### S9.3 Вывод ключа (отправитель A → получатель B, номера `from`, `to` — нормализованные строки, как в v1)
- `ss1 = ECDH(eph_priv_A, id_pub_B)` — 32 байта X-координаты (как сейчас в v1).
- `ss2 = ECDH(id_priv_A, id_pub_B)` — 32 байта.
- `ikm = ss1 ‖ ss2` (64 байта).
- `salt = SHA-256(UTF8("phantom-v2-salt"))` (32 байта, константа).
- `info = UTF8("phantom-v2:" + from + ":" + to) ‖ raw65(id_pub_A) ‖ raw65(id_pub_B) ‖ raw65(eph_pub_A)`.
- `key = HKDF-SHA256(ikm, salt, info, L=32)`.
- AES-256-GCM, nonce 12 байт случайный, tag 16 байт.
- **AD** = `UTF8("phantom-v2-ad:" + from + ":" + to)` — короткий, детерминированный. (Ключи уже вошли в `info`, дублировать в AD не нужно.)
- Получатель B: `ss1 = ECDH(id_priv_B, eph_pub_A)`, `ss2 = ECDH(id_priv_B, id_pub_A)`, далее то же. Если расшифровка не удалась — сообщение показывается как «[Не удалось расшифровать]» (как в v1).

### S9.4 Проверка identity-ключа у получателя (TOFU)
- Хранилище `pinnedIdentity[number] = fingerprint(raw65)` (fingerprint как в S3: `hex(SHA-256(raw65))[:32]`), persist: web localStorage per-account `phantom_<n>_pinned_identity`, Android encrypted prefs `pinned_identity_<self>`, iOS UserDefaults `phantom_pinned_identity_<self>` (не секрет). Стирается при logout/panic.
- При приёме v2 от `from` (≠ свой номер):
  1. нет пина → закрепить `senderIdentityKey` (TOFU), сообщение принять.
  2. пин совпадает → ок.
  3. пин НЕ совпадает → сообщение всё равно расшифровать и показать, но: сбросить `verified[from]`, перезакрепить новый ключ, показать в чате системное сообщение «Ключ безопасности собеседника изменился — проверьте код безопасности заново» (то же, что в S3), и отправить `lookup`.
- Сверка с relay: если `senderIdentityKey` ≠ текущий ключ из `lookup_result` для `from` — это признак подмены ключа relay'ем (MITM) или смены устройства у собеседника: системное сообщение «Ключ собеседника не совпадает с ключом с сервера» + сброс verified. Исходящие при этом шифруются на `senderIdentityKey` из входящего v2? НЕТ — исходящие по-прежнему на ключ из `lookup_result` (иначе атакующий, узнав номер, навяжет свой ключ одним сообщением). Пользователь видит предупреждение и решает сам (сверка safety number).
- `message_sync` (копии своих исходящих с других устройств) и `from == self`: TOFU не применяется.

### S9.5 Совместимость и выбор версии
- `register` → relay получает новое поле `capabilities: ["env2"]`; relay хранит рядом с `registered_keys[number]` и возвращает в `lookup_result` как `capabilities: [...]` (отсутствие поля = старый клиент). HTTP `/api/keys/lookup` — то же поле.
- Отправитель использует v2, если у собеседника в последнем `lookup_result` есть `"env2"`; иначе v1 (как сегодня: эфемерный ключ, `version: 1`).
- Получатель принимает и v1, и v2. **Защита от даунгрейда:** клиент помнит `peerEnv2[number] = true` после первого v2 от этого номера (persist вместе с пином); если затем приходит v1 от него — расшифровать и показать, но добавить системное сообщение «Собеседник прислал сообщение по старому протоколу» (однократно на сессию).
- Relay: `encryptedBlob` прозрачен; проверить лимиты размера блоба и pydantic-модели (`extra` поля) на WS и HTTP `/api/messages/send`, `message_sync`, offline-очередь, `forward`, mesh-bridge — везде v2 должен проходить без изменений.
- P2P и mesh-bridge используют тот же encrypt/decrypt.

### S9.6 Тест-векторы (эталон генерирует оркестратор на Python/cryptography; все платформы обязаны: (а) расшифровать эталонный blob и получить plaintext; (б) при фиксированных ключах/nonce получить побайтово тот же `cipher`, если тестовая обвязка позволяет задать nonce и eph-ключ; иначе только (а) + round-trip своим encrypt)
Приватные скаляры (32 байта, hex):
- id_A: `0101…01` (32 байта 0x01), id_B: `0202…02` (0x02), eph_A: `0303…03` (0x03).
- from = `1001`, to = `1002`, plaintext = UTF8(`hello v2`), nonce = `000102030405060708090a0b`.
Эталонные `senderPublicKey`, `senderIdentityKey`, `cipher` — в файле `spec-v2-vector.json` рядом.

### S9.7 Что НЕ меняется
- `senderPublicKey` входящего никогда не используется как ключ собеседника (S1). Safety number S3, replyTo S5, гейты S4, device binding — без изменений.
- Расшифровка v1 остаётся: `SHA-256(ECDH(static, senderPublicKey) ‖ "direct:from:to")`, AD `msg:from:to` (как сегодня).

## S9-ПРАВКИ (после ревью архитектора — ОБЯЗАТЕЛЬНЫ, имеют приоритет над текстом выше)
P1. Метки KDF/AD с номером версии: `info = UTF8("phantom-env:2:" + from + ":" + to) ‖ raw65(id_pub_A) ‖ raw65(id_pub_B) ‖ raw65(eph_pub_A)`; `AD = UTF8("phantom-env-ad:2:" + from + ":" + to)`; `salt = SHA-256(UTF8("phantom-v2-salt"))` (32 байта, передавать как байты). `from`/`to` — те же строки, что `fromNumber`/`toNumber` конверта relay; forward/bridge перешифровывают на новую пару.
P2. Оба публичных ключа входящего v2 проходят проверку «валидная точка P-256, не бесконечность» ДО любого ECDH (web `_assertValidP256Point`, Android `importRawPublicKey`+Conscrypt, iOS `P256.KeyAgreement.PublicKey(x963Representation:)`). Ошибка = «[Не удалось расшифровать]», без пина.
P3. Модели blob на всех платформах: `senderIdentityKey: String?` (nil = v1); любая пересборка/пересылка blob (forward, повтор, bridge, P2P) сохраняет `version` и `senderIdentityKey` как есть. Web `types.ts`: `version: 1 | 2; senderIdentityKey?: string`. Получатель ветвит по `version`: 2 → v2; 1/отсутствует → v1; ≥3 → «[Неподдерживаемая версия сообщения — обновите приложение]» без попытки v1. Отправитель v2 ставит и `nonce`, и `iv` (одно значение) сам, не полагаясь на relay.
P4. HKDF: Android и iOS переиспользуют существующий `MeshCrypto.hkdfSha256` (RFC 5869), не пишут вторую копию. Web: `subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])` → `deriveBits({name:'HKDF', hash:'SHA-256', salt, info}, key, 256)` → AES-GCM key; при отсутствии HKDF в `subtle` — ручной extract/expand через `subtle.sign('HMAC')`.
P5. iOS: кэш `ss2` per-peer в RAM (ключ кэша — fingerprint id_pub_B), сброс при `wipeKeys` и смене ключа (две SE-операции на сообщение иначе).
P6. TOFU: `pinnedIdentity[number]` — МНОЖЕСТВО до 8 fingerprint'ов (FIFO). Пин создаётся ТОЛЬКО из `senderIdentityKey` успешно расшифрованного v2 (GCM-тег прошёл). Входящий v2: fp ∈ множеству → ок; ∉ → добавить, сбросить `verified[from]`, системное сообщение «У собеседника появилось новое устройство или изменился ключ безопасности — проверьте код безопасности», отправить `lookup`. Пины не удаляются (кроме logout/panic).
P7. Сверка с relay: ЛИПКИЙ баннер в чате «Ключ с сервера не совпадает ни с одним ключом, которым собеседник подписывал сообщения» показывается, пока множество пинов непусто И fingerprint(`lookup_result.publicKey`) ∉ множеству; при баннере нельзя выставить `verified`. Исходящие — по-прежнему на ключ из `lookup_result`.
P8. TOFU, даунгрейд-проверки и баннеры НЕ применяются к: `message_sync`, `from == self`, сообщениям с маркером `_meshBridge`. Bridge (BLE) — фаза 1: всегда v1 (кодек `BridgePacketCodec` не трогать).
P9. Негоциация: `register` (WS и HTTP `/api/keys/register`, `RegisterKeyRequest`) получает `capabilities: ["env2"]`; relay хранит ОТДЕЛЬНЫЙ словарь `registered_capabilities[number]` (не менять форму `registered_keys` — совместимость state.json при откате), обновляет по тому же правилу primary-сессии, персистит в state.json, отдаёт в `lookup_result` (WS и HTTP) как `capabilities`; отсутствие поля при register = `[]`. Неизвестные значения игнорируются; ≤8 строк по ≤16 символов; в логи не писать. Отправитель шлёт v2, если `capabilities` последнего `lookup_result` содержит `env2` ИЛИ `peerEnv2[number] == true` (от номера уже приходил v2; persist вместе с пинами, сброс только logout/panic). Входящий v1 от номера с `peerEnv2` → показать, плюс однократное за сессию системное «Сообщение пришло по старому протоколу (возможно, с другого устройства собеседника)».
P10. Relay `lookup`: отдавать `registered_keys.get(target)` первым; ключ живой сессии — только если это primary (сейчас `_get_any_session` может отдать ключ произвольного устройства).
P11. Тест-векторы: `spec-v2-vector.json` содержит x/y (base64url) всех ключей, промежуточные `ss1/ss2/salt/info/ad/key`, негативные: (г) blob с подменённым `senderIdentityKey` (скаляр 0x04…) → ошибка GCM; (д) `from`/`to` переставлены → ошибка; v1-вектор для регрессии. Платформы обязаны: (а) расшифровать эталон; (б) при фиксированных ключах/nonce получить тот же `cipher` (web — в Node над чистой функцией `deriveV2Key`, Android/iOS — в тестах через импорт скаляров); (в) KDF на фиксированном ikm; (г)/(д) негатив; round-trip своим encrypt/decrypt.
P12. `file_message`, `voice_message`, `message_edit`, P2P — тот же encrypt и те же правила версии. Safety number считается от identity-ключей (уже так).
