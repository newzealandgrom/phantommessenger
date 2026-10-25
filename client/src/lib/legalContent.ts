/* Тексты публичных страниц /terms и /privacy (RU + EN).
 *
 * Каждое утверждение о безопасности и хранении сверено с SECURITY_AUDIT.md и CLAUDE.md
 * (см. отчёт задачи S5, плана 2026-10-23). Не писать «zero-logs», «zero-persistence»,
 * «forward secrecy везде». При изменении поведения клиентов или relay — править здесь
 * и в `legal.*` (i18n.ts, краткая модалка на экране входа) вместе. Разметка в строках:
 * [текст](url) — ссылка, **текст** — жирный. */

import type { Locale } from "./i18n";
import { isCustomOperator, siteHost } from "./operatorInfo";
import type { OperatorInfo } from "./operatorInfo";

export type LegalKind = "terms" | "privacy";

export interface LegalSection {
  h: string;
  p?: string[];
  ul?: string[];
}

export interface LegalDoc {
  title: string;
  lead: string;
  sections: LegalSection[];
}

/** Дата редакции обоих документов. */
export const LEGAL_REVISION = "2026-10-23";

export interface LegalChrome {
  home: string;
  terms: string;
  privacy: string;
  revision: string;
  openApp: string;
  audit: string;
  clients: string;
}

export const LEGAL_CHROME: Record<Locale, LegalChrome> = {
  ru: {
    home: "Phantom Messenger",
    terms: "Условия использования",
    privacy: "Политика приватности",
    revision: "Редакция от",
    openApp: "Открыть мессенджер",
    audit: "Сводка аудита безопасности",
    clients: "Документ действует для всех клиентов: веб, Android, iOS и macOS.",
  },
  en: {
    home: "Phantom Messenger",
    terms: "Terms of Use",
    privacy: "Privacy Policy",
    revision: "Revision dated",
    openApp: "Open the messenger",
    audit: "Security audit summary",
    clients: "This document applies to all clients: web, Android, iOS and macOS.",
  },
};

const TERMS_RU: LegalDoc = {
  title: "Условия использования",
  lead: "Phantom Messenger — эфемерный мессенджер со сквозным шифрованием. Пользуясь веб-клиентом на {{site}}, приложениями для Android, iOS или macOS, вы принимаете эти условия. Как именно обрабатываются данные — в [Политике приватности](/privacy).",
  sections: [
    {
      h: "1. Природа сервиса",
      p: [
        "Сообщения идут через relay-сервер, который пересылает зашифрованные контейнеры между устройствами. Содержимое (текст, голос, файлы) шифруется на вашем устройстве до отправки; relay видит шифртекст и метаданные доставки.",
        "Недоставленные сообщения лежат на relay только в оперативной памяти. Перезапуск сервера обнуляет очередь и текущие сессии — это часть дизайна, а не сбой. Не рассчитывайте на сервис как на архив переписки.",
      ],
    },
    {
      h: "2. Идентичность через Phantom Number",
      p: [
        "Вход — по NFT-номеру из коллекции Phantom Number в блокчейне TON. Мы не просим email, телефон или анкету. Владение номером подтверждается одноразовым кодом, который приходит в личный кабинет владельца на [phantomnumbers.org](https://phantomnumbers.org) — это отдельный сервис номеров, а не сайт мессенджера.",
        "Мессенджер не выдаёт, не отбирает и не «восстанавливает» номера. Потеряли доступ к номеру или кошельку — мы не можем вернуть аккаунт.",
      ],
    },
    {
      h: "3. Ваши обязанности",
      ul: [
        "Используйте сервис в законных целях. Запрещены угрозы, мошенничество, распространение вредоносного ПО и материалов, нарушающих закон вашей юрисдикции.",
        "Вы отвечаете за безопасность своего устройства, кошелька и ключей. Не передавайте PIN и panic-PIN другим людям.",
        "Не мешайте работе сервиса: не обходите лимиты частоты запросов, не рассылайте массовый мусор, не атакуйте relay и других пользователей. Сервис применяет лимиты на отправку сообщений, звонки и P2P-предложения.",
        "Вы сами решаете, кому доверять: сверяйте код безопасности (safety number) с собеседником, если важна подлинность ключа.",
      ],
    },
    {
      h: "4. Границы защиты",
      p: [
        "Шифрование защищает содержимое, но не всё. Сервер технически видит, кто кому пишет, когда и сколько данных; первый контакт с человеком опирается на доверие к ключу из relay (TOFU) и проверяется только ручной сверкой кода. Секретность вперёд (forward secrecy) есть только у отправителя: компрометация ключа устройства получателя раскрывает адресованные ему сообщения. В открытых mesh-комнатах шифрования нет.",
        "{{#audit}}Подробности и известные ограничения мы публикуем честно: [сводка аудита безопасности](/SECURITY_AUDIT.md).{{/audit}}",
      ],
    },
    {
      h: "5. Гарантии и ответственность",
      p: [
        "Сервис предоставляется «как есть», без гарантий доступности, доставки и сохранности эфемерных данных. Авторы не отвечают за упущенную выгоду, утрату возможности связи и косвенные убытки в пределах, допустимых применимым законом.",
        "Мобильные и десктопные клиенты получают исправления только после выпуска новых версий; web-клиент и relay обновляются на сервере сразу.{{#audit}} Актуальное состояние защиты описано в сводке аудита.{{/audit}}",
      ],
    },
    {
      h: "6. Изменения условий",
      p: [
        "Условия могут обновляться вместе с версиями приложений. О существенных изменениях мы сообщаем в клиенте и на этой странице (дата редакции указана вверху). Продолжая пользоваться сервисом после обновления, вы принимаете новую редакцию.",
      ],
    },
    {
      h: "7. Контакты",
      p: [
        "По вопросам условий, приватности, удаления данных и безопасности пишите на [{{email}}](mailto:{{email}}).",
        "{{#custom}}Этот сервер развёрнут и обслуживается независимым оператором: {{operator}} ([{{site}}]({{siteUrl}})). Условия и политика на этих страницах относятся к нему; разработчики программы Phantom Messenger этим сервером не управляют.{{/custom}}",
      ],
    },
  ],
};

const TERMS_EN: LegalDoc = {
  title: "Terms of Use",
  lead: "Phantom Messenger is an ephemeral end-to-end encrypted messenger. By using the web client at {{site}} or the Android, iOS or macOS apps you accept these terms. How data is handled is described in the [Privacy Policy](/privacy).",
  sections: [
    {
      h: "1. Nature of the service",
      p: [
        "Messages travel through a relay server that forwards encrypted containers between devices. Content (text, voice, files) is encrypted on your device before sending; the relay sees ciphertext and delivery metadata.",
        "Undelivered messages sit on the relay in RAM only. A server restart clears the queue and active sessions — that is by design, not a fault. Do not rely on the service as an archive of your conversations.",
      ],
    },
    {
      h: "2. Identity via Phantom Number",
      p: [
        "You sign in with an NFT number from the Phantom Number collection on the TON blockchain. We do not ask for an email, phone number or profile form. Ownership is confirmed with a one-time code delivered to the owner's cabinet at [phantomnumbers.org](https://phantomnumbers.org) — a separate numbers service, not the messenger's website.",
        "The messenger does not issue, revoke or \"recover\" numbers. If you lose access to the number or the wallet, we cannot restore the account.",
      ],
    },
    {
      h: "3. Your responsibilities",
      ul: [
        "Use the service lawfully. Threats, fraud, malware and content that breaks the law of your jurisdiction are prohibited.",
        "You are responsible for your device, wallet and keys. Never share your PIN or panic PIN.",
        "Do not disrupt the service: do not bypass rate limits, mass-send junk, or attack the relay or other users. The service applies rate limits to sending, calls and P2P offers.",
        "You decide whom to trust: compare the safety number with your contact if the authenticity of their key matters.",
      ],
    },
    {
      h: "4. Limits of protection",
      p: [
        "Encryption protects content, not everything. The server can technically see who writes to whom, when, and how much data; a first contact relies on trusting the key delivered by the relay (TOFU) and is verified only by comparing the code manually. Forward secrecy exists for the sender only: compromise of the recipient's device key exposes messages addressed to it. Open mesh rooms are not encrypted.",
        "{{#audit}}We publish the details and known limitations openly: [security audit summary](/SECURITY_AUDIT.md).{{/audit}}",
      ],
    },
    {
      h: "5. Warranties and liability",
      p: [
        "The service is provided \"as is\", without guarantees of availability, delivery or preservation of ephemeral data. The authors are not liable for lost profits, loss of the ability to communicate or indirect damages, to the extent permitted by applicable law.",
        "Mobile and desktop clients receive fixes only after new versions are released; the web client and the relay are updated on the server immediately.{{#audit}} The current state of protection is described in the audit summary.{{/audit}}",
      ],
    },
    {
      h: "6. Changes to the terms",
      p: [
        "The terms may change along with app versions. We announce material changes in the client and on this page (the revision date is shown at the top). Continuing to use the service after an update means you accept the new revision.",
      ],
    },
    {
      h: "7. Contacts",
      p: [
        "For questions about the terms, privacy, data deletion and security, write to [{{email}}](mailto:{{email}}).",
        "{{#custom}}This server is deployed and run by an independent operator: {{operator}} ([{{site}}]({{siteUrl}})). The terms and policy on these pages apply to that operator; the developers of the Phantom Messenger software do not manage this server.{{/custom}}",
      ],
    },
  ],
};

const PRIVACY_RU: LegalDoc = {
  title: "Политика приватности",
  lead: "Принцип сервиса — минимум данных на сервере и никаких учётных записей с личными данными. Ниже — что именно видит и хранит сервер, что остаётся на вашем устройстве на каждой платформе и где защита заканчивается. Условия — на странице [Условия использования](/terms).{{#custom}} Описание инфраструктуры ниже (Cloudflare, шифрование файла состояния ключом сервера, «наш сервер») относится к серверу phantommessenger.org; у оператора этого сервера ({{operator}}) конфигурация может отличаться — уточняйте у него: {{email}}.{{/custom}}",
  sections: [
    {
      h: "1. Коротко",
      ul: [
        "Содержимое сообщений шифруется на вашем устройстве; relay его не читает.",
        "Сообщения лежат на сервере только в оперативной памяти до доставки; перезапуск сервера их стирает.",
        "На диске сервера — только публичные ключи, возможности клиента, push-токены, отзывы mesh-ключей, поколение ключа моста и (пока включён флаг) блок-листы.",
        "Ни рекламы, ни продажи данных, ни сторонних аналитиков.",
        "Мы не заявляем «ноль логов» и «ноль данных»: сервер и инфраструктура видят метаданные, см. разделы 2 и 4.",
      ],
    },
    {
      h: "2. Что видит сервер (relay)",
      p: [
        "Чтобы доставить сообщение, relay обязан знать:",
      ],
      ul: [
        "номера отправителя и получателя, время и размер зашифрованного блоба;",
        "факт реакции, прочтения, набора текста и удаления (идентификаторы сообщений, без содержимого);",
        "сигналинг звонков и P2P — SDP и ICE (метаданные транспорта; сами медиа и содержимое P2P-канала через relay не идут);",
        "IP-адрес вашего соединения: его видят Cloudflare и веб-сервер перед relay. Прикладной журнал relay ведётся на уровне предупреждений, без IP и номеров в успешных событиях.",
      ],
    },
    {
      h: "3. Чего сервер не видит",
      ul: [
        "Текст, голос и файлы — они зашифрованы (конверт v2: эфемерный ключ P-256 на каждое сообщение плюс постоянный ключ устройства, HKDF-SHA256, AES-256-GCM).",
        "С собеседниками на актуальных версиях клиентов (возможность meta1) внутри шифртекста лежат также имя и тип файла, размер, длительность голосового, цитата, таймер самоуничтожения, пересылка и эмодзи реакций. Клиенты старых версий отправляют часть этих метаданных открыто.",
        "Файлы между клиентами с возможностью files_v1 передаются только напрямую (или через TURN в зашифрованном виде) и на relay не попадают. Файлы от старых клиентов (до 140 КиБ) проходят через оперативную память relay в зашифрованном виде.",
        "Контакты, их имена, заметки и настройки чатов хранятся только на вашем устройстве. Профиль, который вы публикуете для собеседников, и закреплённые сообщения relay держит только в памяти.",
      ],
    },
    {
      h: "4. Что хранится на сервере постоянно",
      p: [
        "На диск relay записывается файл состояния. В нём:",
      ],
      ul: [
        "публичные ключи устройств и возможности клиента (capabilities) — они нужны, чтобы собеседник мог зашифровать сообщение для вас;",
        "push-токены (Android и iOS — если приложение зарегистрировало токен для уведомлений);",
        "отзывы mesh-ключей и номер поколения ключа моста для вашего номера;",
        "блок-листы — пока на сервере включён соответствующий флаг; источником правды остаётся клиент, и мы планируем это отключить после выхода обновлённых мобильных клиентов.",
      ],
    },
    {
      h: "5. Журналы и инфраструктура",
      ul: [
        "Журналы relay и TURN-сервера (coturn) хранятся только в оперативной памяти и не дольше суток. Журнал клиентских IP в coturn отключён; веб-сервер перед relay не пишет IP клиентов в журнал доступа.",
        "Cloudflare и веб-сервер перед relay видят IP-адреса клиентов; при звонках через TURN сервер ретранслирует шифрованный трафик и видит IP-адреса сторон.",
        "Каталог mesh-идентичностей на сервере отключён: relay не знает, какой mesh-участник чей номер.",
        "Состояние на диске шифруется ключом сервера (Fernet), когда он задан; на нашем сервере он задан.",
      ],
    },
    {
      h: "6. Что хранится на вашем устройстве",
      p: [
        "История переписки через сервер на всех клиентах (веб, Android, iOS, macOS) хранится только в оперативной памяти: после закрытия вкладки или перезапуска приложения её нет. Исключения: «Избранное» на Android и iOS сохраняется на устройстве в зашифрованном виде; история mesh — только при включённом «Сохранять историю mesh» (по умолчанию выключено), зашифрована на устройстве. Вложения: на Android расшифрованные файлы лежат в закрытом каталоге приложения вне резервных копий до удаления сообщения, выхода или panic; на iOS и macOS каталог вложений очищается при запуске, выходе и panic. Веб хранит черновик неотправленного сообщения в sessionStorage вкладки.",
        "**Веб.** Постоянный ключ устройства — неизвлекаемый ключ WebCrypto в IndexedDB (хранилище `phantom-keystore`) до выхода или panic. Контакты, настройки и отметки «проверено» — в localStorage. Токен сессии держится в памяти страницы; чтобы перезагрузка (F5) не требовала входа заново, он на короткое время передаётся в память Service Worker по одноразовому коду и не пишется на диск. История переписки живёт только в памяти вкладки. Service Worker и IndexedDB не являются границей доверия: скрипт того же сайта, включая расширение браузера с доступом к странице, может запросить расшифровку.",
        "**Android.** Ключ устройства и mesh-хранилища — в EncryptedSharedPreferences, пароли mesh-комнат — в Android Keystore. Окно приложения защищено флагом FLAG_SECURE (скриншоты блокируются). Подробности про вложения и «Избранное» — выше, в начале этого раздела.",
        "**iOS.** Ключ устройства и токен — в Keychain (ключ — в Secure Enclave), пароли mesh-комнат — в Keychain. Скриншот не запрещён: приложение лишь обнаруживает его и предупреждает собеседника. Зашифрованные mesh-файлы лежат вне резервных копий.",
        "**macOS.** Ключ и токен — в Keychain в режиме data-protection (доступны, пока вы вошли в систему; без синхронизации iCloud; Secure Enclave не используется). Вложения лежат в каталоге песочницы приложения (см. начало раздела). Уведомления только локальные, по умолчанию без текста.",
        "**Во всех клиентах:** PIN и panic-PIN хранятся только как хэш PBKDF2-HMAC-SHA256 с солью. История mesh сохраняется на устройстве только если вы включили «Сохранять историю mesh» (по умолчанию выключено), и тогда она зашифрована.",
      ],
    },
    {
      h: "7. Выход и удаление данных",
      ul: [
        "«Выйти» стирает данные аккаунта на этом устройстве. На вебе «Выйти» не отзывает сессию на relay — токен истекает сам (по умолчанию через 2 часа); на Android, iOS и macOS сессия при выходе отзывается.",
        "Panic-PIN, 10-я неверная попытка PIN и «Удалить аккаунт» стирают данные приложения на устройстве; panic дополнительно отзывает активную сессию на relay.",
        "Выключение push на Android отзывает токен на relay.",
        "Публичные ключи и поколение ключа моста остаются на сервере постоянно — без них вам нельзя написать. Запрос на удаление отправьте на [{{email}}](mailto:{{email}}).",
      ],
    },
    {
      h: "8. Уведомления (push)",
      ul: [
        "Android: уведомления доставляет Google Firebase Cloud Messaging; Google видит токен устройства и факт уведомления. Текст сообщения в push не передаётся.",
        "Веб: если вы разрешили уведомления в браузере, по умолчанию они без текста сообщения; если вы включили превью, в уведомлении показываются до 100 символов текста.",
        "iOS: удалённые push сейчас не доставляются (APNs на сервере не настроен). macOS: только локальные уведомления.",
      ],
    },
    {
      h: "9. Звонки и прямые соединения (P2P)",
      ul: [
        "Звонки идут по WebRTC с шифрованием DTLS-SRTP; relay пересылает только сигналинг. Код звонка из 6 цифр позволяет сверить его с собеседником голосом и выявить подмену.",
        "Если не включено «Скрывать IP в звонках», собеседник-контакт видит ваш IP-адрес. С включённой настройкой, а также для звонков не от контакта, трафик идёт только через TURN, без прямых адресов.",
        "Прямое соединение (P2P) в веб-клиенте включено по умолчанию и поднимается только с контактами и собеседниками, которым вы писали; его можно выключить в настройках. При выключенном «Статусе в сети» клиент всё равно отвечает на P2P-предложение контакта, и тот узнаёт, что вы онлайн.",
      ],
    },
    {
      h: "10. Mesh (Android и iOS)",
      ul: [
        "Mesh работает по Bluetooth LE без интернета и анонимен: идентификатор участника выводится из его ключей, не связан с номером и меняется раз в сутки. Выбранный ник виден всем рядом.",
        "Все пакеты подписаны; личные сообщения шифруются сессией Noise. Открытые комнаты (без пароля) не шифруются — это общий эфир. Комнаты с паролем шифруются ключом из названия и пароля: тот, кто их знает, читает и пишет.",
        "Через мост в интернет передаётся запечатанный на ключ relay конверт; relay при этом видит номера отправителя и получателя и номер владельца моста.",
      ],
    },
    {
      h: "11. Третьи стороны",
      ul: [
        "Cloudflare — доставка трафика до сервера; видит IP клиентов.",
        "Сервис Phantom Number ([phantomnumbers.org](https://phantomnumbers.org)) — выдача одноразового кода при входе; ему передаётся ваш номер.",
        "Google Firebase Cloud Messaging — только для push на Android.",
        "Блокчейн TON публичен: владение NFT-номером видно всем.",
        "Рекламных и аналитических сервисов нет.",
      ],
    },
    {
      h: "12. Известные ограничения",
      p: [
        "Секретность вперёд — только у отправителя; первый контакт — TOFU; relay видит метаданные; блокировка приложения не отменяет доступ к устройству с root-правами.{{#audit}} Полный список — в [сводке аудита безопасности](/SECURITY_AUDIT.md).{{/audit}}",
      ],
    },
    {
      h: "13. Изменения и контакты",
      p: [
        "Политика обновляется вместе с клиентами и сервером; дата редакции указана вверху. Канал связи с оператором описан в разделе «Контакты» [Условий использования](/terms).",
      ],
    },
  ],
};

const PRIVACY_EN: LegalDoc = {
  title: "Privacy Policy",
  lead: "The service is built on minimal server-side data and no accounts with personal details. Below is exactly what the server sees and stores, what stays on your device on each platform, and where protection ends. The terms are on the [Terms of Use](/terms) page.{{#custom}} The description of the infrastructure below (Cloudflare, encryption of the state file with a server key, \"our server\") applies to the phantommessenger.org server; the operator of this server ({{operator}}) may run a different configuration — ask them: {{email}}.{{/custom}}",
  sections: [
    {
      h: "1. In short",
      ul: [
        "Message content is encrypted on your device; the relay cannot read it.",
        "Messages sit on the server in RAM only until delivered; a server restart erases them.",
        "On the server's disk there are only public keys, client capabilities, push tokens, mesh key revocations, the bridge key generation and (while a flag is on) block lists.",
        "No ads, no data sales, no third-party analytics.",
        "We do not claim \"zero logs\" or \"zero data\": the server and its infrastructure see metadata, see sections 2 and 4.",
      ],
    },
    {
      h: "2. What the server (relay) sees",
      p: [
        "To deliver a message the relay has to know:",
      ],
      ul: [
        "sender and recipient numbers, and the time and size of the encrypted blob;",
        "the fact of a reaction, read receipt, typing or deletion (message identifiers, no content);",
        "call and P2P signaling — SDP and ICE (transport metadata; call media and P2P channel content do not pass through the relay);",
        "your connection's IP address: it is visible to Cloudflare and the web server in front of the relay. The relay's application log runs at warning level, with no IPs or numbers in successful events.",
      ],
    },
    {
      h: "3. What the server does not see",
      ul: [
        "Text, voice and files — they are encrypted (envelope v2: an ephemeral P-256 key per message plus the device's persistent key, HKDF-SHA256, AES-256-GCM).",
        "With contacts on current client versions (the meta1 capability) the file name and type, size, voice duration, quote, self-destruct timer, forward marker and reaction emoji are also inside the ciphertext. Older client versions send part of this metadata in the clear.",
        "Files between clients that support files_v1 go only directly (or through TURN, encrypted) and never reach the relay. Files from older clients (up to 140 KiB) pass through the relay's RAM in encrypted form.",
        "Contacts, their names, notes and chat settings are stored only on your device. The profile you publish to contacts and pinned messages are kept by the relay in memory only.",
      ],
    },
    {
      h: "4. What the server stores permanently",
      p: [
        "The relay writes a state file to disk. It contains:",
      ],
      ul: [
        "devices' public keys and client capabilities — they are needed so that a contact can encrypt a message to you;",
        "push tokens (Android and iOS — if the app registered a token for notifications);",
        "mesh key revocations and the bridge key generation for your number;",
        "block lists — while the corresponding server flag is on; the client remains the source of truth and we plan to switch this off after updated mobile clients ship.",
      ],
    },
    {
      h: "5. Logs and infrastructure",
      ul: [
        "Relay and TURN server (coturn) logs are kept in RAM only, for no more than a day. The client-IP log in coturn is disabled; the web server in front of the relay does not write client IPs to its access log.",
        "Cloudflare and the web server in front of the relay see client IP addresses; for calls over TURN the server relays encrypted traffic and sees the parties' IPs.",
        "The server-side catalog of mesh identities is disabled: the relay does not know which mesh participant belongs to which number.",
        "The on-disk state is encrypted with a server key (Fernet) when one is set; on our server it is set.",
      ],
    },
    {
      h: "6. What is stored on your device",
      p: [
        "On all clients (web, Android, iOS, macOS) the history of conversations that go through the server is kept in memory only: it is gone after the tab is closed or the app restarts. Exceptions: \"Saved Messages\" on Android and iOS is stored on the device in encrypted form; mesh history only if \"Save mesh history\" is on (off by default), encrypted on the device. Attachments: on Android decrypted files stay in the app's private directory, excluded from backups, until the message is deleted, you log out or trigger panic; on iOS and macOS the attachments directory is cleared at launch, logout and panic. The web client keeps the unsent draft in the tab's sessionStorage.",
        "**Web.** The persistent device key is a non-extractable WebCrypto key in IndexedDB (the `phantom-keystore` store) until you log out or trigger panic. Contacts, settings and \"verified\" marks are in localStorage. The session token lives in page memory; so that a reload (F5) does not force a new sign-in, it is briefly handed to the Service Worker's memory under a one-time code and is not written to disk. Conversation history lives in tab memory only. The Service Worker and IndexedDB are not a trust boundary: a script from the same site, including a browser extension with page access, can request decryption.",
        "**Android.** The device key and mesh stores are in EncryptedSharedPreferences, mesh room passwords in the Android Keystore. The app window is protected with FLAG_SECURE (screenshots are blocked). Attachments and \"Saved Messages\" are described at the start of this section.",
        "**iOS.** The device key and token are in the Keychain (the key in the Secure Enclave), mesh room passwords in the Keychain. Screenshots are not prevented: the app only detects one and warns the contact. Encrypted mesh files are kept out of backups.",
        "**macOS.** The key and token are in the Keychain in data-protection mode (available while you are logged in to the OS; no iCloud sync; the Secure Enclave is not used). Attachments sit in the app sandbox directory (see the start of this section). Notifications are local only and carry no text by default.",
        "**On all clients:** the PIN and panic PIN are stored only as a salted PBKDF2-HMAC-SHA256 hash. Mesh history is kept on the device only if you turn on \"Save mesh history\" (off by default), and then it is encrypted.",
      ],
    },
    {
      h: "7. Logout and deletion",
      ul: [
        "\"Log out\" erases the account's data on this device. On the web, logging out does not revoke the session on the relay — the token simply expires (2 hours by default); on Android, iOS and macOS the session is revoked on logout.",
        "A panic PIN, the 10th wrong PIN attempt and \"Delete account\" erase the app's data on the device; panic also revokes the active session on the relay.",
        "Turning push off on Android revokes the token on the relay.",
        "Public keys and the bridge key generation stay on the server permanently — without them you could not be written to. Send a deletion request to [{{email}}](mailto:{{email}}).",
      ],
    },
    {
      h: "8. Notifications (push)",
      ul: [
        "Android: notifications are delivered by Google Firebase Cloud Messaging; Google sees the device token and the fact of a notification. The message text is not sent in the push.",
        "Web: if you allowed notifications in the browser, they carry no message text by default; if you turn on previews, up to 100 characters of the text are shown.",
        "iOS: remote push is not delivered at the moment (APNs is not configured on the server). macOS: local notifications only.",
      ],
    },
    {
      h: "9. Calls and direct connections (P2P)",
      ul: [
        "Calls use WebRTC with DTLS-SRTP encryption; the relay forwards signaling only. A 6-digit call code lets you compare it with your contact by voice and detect tampering.",
        "Unless \"Hide IP in calls\" is on, a contact on the call sees your IP address. With the setting on, and for calls from non-contacts, traffic goes through TURN only, with no direct addresses.",
        "Direct connection (P2P) in the web client is on by default and is set up only with contacts and with people you have written to; you can turn it off in settings. With \"Online status\" off, the client still answers a contact's P2P offer, so the contact learns that you are online.",
      ],
    },
    {
      h: "10. Mesh (Android and iOS)",
      ul: [
        "Mesh works over Bluetooth LE without the internet and is anonymous: a participant's identifier is derived from their keys, is not tied to a number and changes daily. The nickname you choose is visible to everyone nearby.",
        "All packets are signed; private messages are encrypted with a Noise session. Open rooms (no password) are not encrypted — they are a shared channel. Password rooms are encrypted with a key derived from the name and password: anyone who knows them can read and write.",
        "A bridge to the internet passes an envelope sealed to the relay's key; the relay then sees the sender and recipient numbers and the bridge owner's number.",
      ],
    },
    {
      h: "11. Third parties",
      ul: [
        "Cloudflare — traffic delivery to the server; sees client IPs.",
        "The Phantom Number service ([phantomnumbers.org](https://phantomnumbers.org)) — issues the one-time code at sign-in; your number is passed to it.",
        "Google Firebase Cloud Messaging — Android push only.",
        "The TON blockchain is public: ownership of an NFT number is visible to everyone.",
        "There are no advertising or analytics services.",
      ],
    },
    {
      h: "12. Known limitations",
      p: [
        "Forward secrecy exists for the sender only; a first contact is TOFU; the relay sees metadata; app lock does not protect against root access to the device.{{#audit}} The full list is in the [security audit summary](/SECURITY_AUDIT.md).{{/audit}}",
      ],
    },
    {
      h: "13. Changes and contacts",
      p: [
        "The policy is updated together with the clients and the server; the revision date is shown at the top. The way to reach the operator is described in the \"Contacts\" section of the [Terms of Use](/terms).",
      ],
    },
  ],
};

const LEGAL_DOCS: Record<LegalKind, Record<Locale, LegalDoc>> = {
  terms: { ru: TERMS_RU, en: TERMS_EN },
  privacy: { ru: PRIVACY_RU, en: PRIVACY_EN },
};

/** Подстановка данных оператора (/operator.json) в шаблон документа.
 *  Токены: {{site}} — хост сайта, {{siteUrl}}, {{email}}, {{operator}}; блоки
 *  {{#audit}}…{{/audit}} (есть сводка аудита) и {{#custom}}…{{/custom}} (сервер не прод).
 *  Значения прошли строгую проверку в operatorInfo.ts (нет разметки/пробелов/скобок);
 *  подстановка однопроходная — вставленный текст повторно не раскрывается. */
export function fillLegalText(text: string, op: OperatorInfo): string {
  const custom = isCustomOperator(op);
  const blocks = text.replace(/\{\{#(audit|custom)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, tag: string, body: string) =>
    (tag === "audit" ? op.securityReport : custom) ? body : "");
  const vals: Record<string, string> = {
    site: siteHost(op), siteUrl: op.siteUrl, email: op.contactEmail, operator: op.name,
  };
  return blocks.replace(/\{\{(site|siteUrl|email|operator)\}\}/g, (_m, k: string) => vals[k] ?? "");
}

export function getLegalDoc(kind: LegalKind, locale: Locale, op: OperatorInfo): LegalDoc {
  const d = LEGAL_DOCS[kind][locale];
  const fill = (xs: string[] | undefined): string[] | undefined =>
    xs?.map((x) => fillLegalText(x, op)).filter((x) => x.trim().length > 0);
  return {
    title: d.title,
    lead: fillLegalText(d.lead, op),
    sections: d.sections.map((sec) => ({ h: sec.h, p: fill(sec.p), ul: fill(sec.ul) })),
  };
}

/** Путь → вид страницы (без регистрации; завершающий слэш допускается). */
export function legalKindFromPath(pathname: string): LegalKind | null {
  const p = pathname.replace(/\/+$/, "").toLowerCase();
  if (p === "/terms") return "terms";
  if (p === "/privacy") return "privacy";
  return null;
}
