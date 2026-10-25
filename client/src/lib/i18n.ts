/* Phantom Messenger — простой i18n со словарём в коде, auto-detect и persistence */

import { createContext, createElement, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";

export type Locale = "ru" | "en";

const STORAGE_KEY = "phantom_locale";

export function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const candidates = [
    navigator.language,
    ...((navigator as any).languages || []),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    const lc = c.toLowerCase();
    if (lc.startsWith("ru")) return "ru";
  }
  return "en";
}

export function getStoredLocale(): Locale | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "ru" || v === "en") return v;
  } catch { /* ignore */ }
  return null;
}

export function setStoredLocale(loc: Locale): void {
  try { localStorage.setItem(STORAGE_KEY, loc); } catch { /* ignore */ }
}

export function initialLocale(): Locale {
  return getStoredLocale() ?? detectBrowserLocale();
}

/* === MESSAGES === */
type Dict = Record<string, string>;

const MESSAGES: Record<Locale, Dict> = {
  ru: {
    // common
    "common.back": "Назад",

    // голосовые сообщения (VoiceRecorderBar)
    "voice.cancel": "Удалить запись",
    "voice.sending": "Отправка…",
    "voice.inCall": "Во время звонка запись голосового недоступна",
    "voice.notReady": "Дождитесь готовности шифрования и откройте чат",
    "voice.send": "Отправить",
    "voice.pause": "Пауза",
    "voice.resume": "Продолжить запись",
    "voice.play": "Прослушать",
    "voice.stopPlay": "Остановить",
    "voice.bar": "Идёт запись голосового сообщения",
    "voice.holdHint": "Удерживайте для записи",
    "voice.slideCancel": "Влево — отмена",
    "voice.slideLock": "Вверх — без рук",
    "voice.tooShort": "Запись слишком короткая",
    "voice.micDenied": "Нет доступа к микрофону. Разрешите его в настройках браузера.",
    "voice.unsupported": "Запись голоса не поддерживается этим браузером",
    "voice.limit": "Достигнут лимит голосового. Отправьте или удалите запись.",
    "voice.interrupted": "Запись остановлена. Отправьте или удалите её.",
    "voice.msgPlay": "Воспроизвести",
    "voice.msgPause": "Пауза",
    "voice.seek": "Перемотка",
    "voice.speed": "Скорость воспроизведения: {rate}",
    "voice.playFailed": "Не удалось воспроизвести",
    "voice.retry": "Повторить",
    "voice.updateBrowser": "Запись голоса недоступна: обновите браузер",
    "common.cancel": "Отмена",
    "common.save": "Сохранить",
    "common.next": "Далее",
    "common.start": "Начать",
    "common.skip": "Пропустить",
    "common.gotIt": "Понятно",
    "common.continue": "Продолжить",
    "common.close": "Закрыть",
    "common.delete": "Удалить",
    "common.deleteForMe": "Удалить у меня",
    "common.deleteForAll": "Удалить у всех",
    "common.send": "Отправить",
    "common.open": "Открыть",
    "common.you": "Вы: ",
    "common.online": "в сети",
    "common.offline": "не в сети",
    "common.connecting": "соединение...",
    "common.searching": "Поиск...",
    "common.loading": "Загрузка...",
    "common.draft": "Черновик: ",
    "common.typing": "печатает...",
    "common.unknown": "Неизвестно",
    "common.now": "сейчас",
    "common.refresh": "Обновить",
    "common.add": "Добавить",
    "common.enable": "Включить",
    "common.disable": "Отключить",
    "common.activate": "Активировать",
    "common.confirm": "Подтвердить",
    "common.error": "Ошибка",
    "common.success": "Готово",

    // splash
    "splash.title": "Phantom",
    "splash.tag": "Эфемерный мессенджер",

    // onboarding
    "onb.skip": "Пропустить",
    "onb.next": "Далее",
    "onb.start": "Начать",
    "onb.1.title": "Эфемерность",
    "onb.1.body": "Сервер хранит сообщения только в оперативной памяти до доставки и не пишет IP и номера в журналы приложения.",
    "onb.1.chip": "RAM до доставки · без IP в журналах",
    "onb.2.title": "Шифрование E2E",
    "onb.2.body": "ECDH P-256 + AES-256-GCM, эфемерный ключ на каждое сообщение. Утечка ключа отправителя не раскрывает прошлые сообщения; ключ получателя защищайте — он расшифровывает адресованное ему.",
    "onb.2.chip": "ECDH P-256 · AES-256-GCM",
    "onb.3.title": "NFT = Identity",
    "onb.3.body": "Phantom Number — твой 10-значный номер на блокчейне TON. Не email, не телефон, его нельзя забрать.",
    "onb.3.chip": "TON · NFT Numbers",

    // welcome
    "welcome.title": "Добро пожаловать",
    "welcome.tag": "Войди со своим Phantom Number",
    "welcome.cardTitle": "С Phantom Number",
    "welcome.cardSub": "NFT идентичность · TON",
    "welcome.cardBody.before": "Нужен NFT Number с ",
    "welcome.cardBody.after": ". После OTP — relay-чаты, голос и видео-звонки.",
    "welcome.cta": "Войти по номеру",
    "welcome.shieldNote": "Сообщения шифруются end-to-end. Серверу видны только зашифрованные blob'ы.",
    "welcome.legal": "Условия и приватность",

    // auth
    "auth.step1": "Шаг 1 из 2",
    "auth.step2": "Шаг 2 из 2",
    "auth.numTitle": "Phantom Number",
    "auth.codeTitle": "Код подтверждения",
    "auth.headEnter": "Введи номер",
    "auth.headEnterSub": "10 цифр твоего NFT-номера. Например: 111-00-234-56",
    "auth.cta.send": "Получить код",
    "auth.cta.sending": "Отправка...",
    "auth.cta.verify": "Войти",
    "auth.cta.verifying": "Проверка...",

    // otp
    "otp.title": "OTP",
    "otp.sub": "Код отправлен в личный кабинет номера",
    "otp.notReceived": "Не пришёл? ",
    "otp.resendIn": "Запросить заново через 0:",
    "otp.resendNow": "Запросить заново",

    // sidebar
    "sidebar.searchPlaceholder": "Поиск чатов и сообщений",
    "sidebar.filter.all": "Все",
    "sidebar.filter.unread": "Непрочитанные",
    "sidebar.filter.contacts": "Контакты",
    "sidebar.filter.archive": "Архив",
    "sidebar.empty.noChats": "Нет чатов",
    "sidebar.empty.archive": "Архив пуст",
    "sidebar.empty.startChat": "Начать новый чат",
    "sidebar.search.writeTo": "Написать",
    "sidebar.search.newChatByNumber": "Новый чат по номеру",
    "sidebar.foot.me": "Я",
    "sidebar.foot.id": "phantom-id ",
    "sidebar.fab.newChat": "Новый чат",
    "sidebar.tooltip.newChat": "Новый чат",
    "sidebar.tooltip.menu": "Меню",
    "sidebar.tooltip.settings": "Настройки",

    // chat header / panel
    "chat.tooltip.search": "Поиск в чате",
    "chat.tooltip.audio": "Аудио звонок",
    "chat.tooltip.video": "Видео звонок",
    "chat.tooltip.more": "Ещё",
    "chat.status.online": "в сети",
    "chat.status.recently": "был(а) недавно",
    "chat.empty.title": "Phantom",
    "chat.empty.body": "Выбери чат слева или начни новый. Сообщения шифруются end-to-end и хранятся только в памяти вкладки.",
    "chat.empty.serverPrefix": "TLS 1.3",
    "chat.pinned.title": "Закреплённые сообщения",
    "chat.pinned.unpin": "Открепить",
    "chat.deleteMsg.title": "Удалить сообщение?",
    "chat.deleteMsg.warn": "Это действие необратимо.",
    "chat.composer.placeholder": "Сообщение...",
    "chat.composer.send": "Отправить",
    "chat.composer.attach": "Прикрепить",
    "chat.composer.timer": "Самоуничтожение",
    "chat.composer.voice": "Голосовое сообщение",
    "chat.encryption": "Шифрование активно",

    // call overlay
    "call.incoming": "входящий звонок",
    "call.sas": "Код звонка",
    "call.sas.hint": "Сверьте код с собеседником голосом. Если коды разные — звонок перехвачен, положите трубку.",
    "call.path.direct": "Напрямую",
    "call.path.direct.hint": "Аудио и видео идут напрямую между устройствами, сервер их не получает.",
    "call.path.turn": "Через TURN",
    "call.path.turn.hint": "Аудио и видео идут через TURN-сервер в зашифрованном виде; TURN видит IP-адреса сторон, но не содержимое.",
    "call.calling": "вызов...",
    "call.reconnecting": "переподключение...",
    "call.failed": "не удалось соединиться",
    "call.btn.reject": "Отклонить",
    "call.btn.accept": "Принять",
    "call.btn.end": "Завершить",
    "call.btn.message": "Сообщение",
    "call.btn.muteOn": "Отключить микрофон",
    "call.btn.muteOff": "Включить микрофон",
    "call.btn.videoOn": "Выключить камеру",
    "call.btn.videoOff": "Включить камеру",
    "call.btn.switchCamera": "Переключить камеру",
    "call.cameraOff": "Камера отключена",
    "call.peerMutedMic": "Собеседник отключил микрофон",
    "call.inCall": "В процессе разговора",
    "call.crypto": "ECDH · DTLS-SRTP",
    "call.btn.add": "Добавить",

    // app lock
    "lock.title": "Phantom",
    "lock.sub": "Введи PIN для разблокировки",

    // privacy modal
    "privacy.heading": "Privacy Notice",
    "privacy.e2eTitle": "Сквозное шифрование",
    "privacy.e2eBody": "E2E: ECDH P-256 + AES-256-GCM, эфемерный ключ на каждое сообщение. Сервер не видит текст, но видит, кто, кому и когда пишет.",
    "privacy.ephTitle": "Эфемерность",
    "privacy.ephBody": "При закрытии вкладки переписка исчезает навсегда.",
    "privacy.sdTitle": "Самоуничтожающиеся сообщения",
    "privacy.sdBody": "Установите таймер — сообщения удаляются автоматически.",
    "privacy.anonTitle": "Конфиденциальность",
    "privacy.anonBody": "Для максимальной анонимности используйте Tor/VPN.",

    // session replaced
    "session.replaced.title": "Сеанс завершён",
    "session.replaced.body": "Вход выполнен с другого устройства. Переподключиться?",
    "session.replaced.logout": "Выйти",
    "session.replaced.reconnect": "Переподключиться",

    // drag & drop
    "drag.hereFile": "Перетащите файлы сюда",

    // profile / settings
    "profile.idCard": "ID Card",
    "profile.title": "Профиль",
    "profile.stamp": "::МОЙ ПРОФИЛЬ::",
    "profile.section.vibe": "vibe",
    "profile.section.settings": "настройки",
    "profile.row.security": "Безопасность",
    "profile.row.security.sub": "App Lock · Panic-PIN",
    "profile.row.server": "Сервер",
    "profile.row.devices": "Устройства",
    "profile.row.devices.sub": "{n} активных сессий",
    "profile.row.privacy": "Приватность",
    "profile.row.privacy.sub": "Read receipts · Typing",
    "profile.row.appearance": "Оформление",
    "profile.row.notifications": "Уведомления",
    "profile.row.notifications.sub": "Включены",
    "profile.row.language": "Язык",
    "profile.row.language.sub": "Русский",
    "profile.row.about": "О приложении",
    "profile.row.logout": "Выйти",
    "accounts.title": "Аккаунты",
    "accounts.add": "Добавить аккаунт",
    "accounts.limit": "Не больше 3 аккаунтов",
    "accounts.duplicate": "Этот номер уже добавлен",
    "accounts.connecting": "Подключение…",
    "accounts.active": "Активный",
    "accounts.hint": "Сообщения для неактивных аккаунтов приходят после переключения на них",
    "accounts.logout": "Выйти",
    "accounts.removeTitle": "Выйти из аккаунта?",
    "accounts.removeBody": "Данные аккаунта {number} и его ключ будут удалены с этого устройства. Сессия на сервере не отзывается сразу и истечёт по сроку действия токена.",
    "accounts.callBusy": "Завершите звонок, чтобы переключить аккаунт",
    "accounts.sessionExpired": "Сессия {number} истекла — войдите снова",
    "accounts.sessionEnded": "Сессия {number} завершена сервером, войдите снова",
    "accounts.adding": "Добавление аккаунта",
    "accounts.switchTo": "Переключиться на {number}",
    "profile.more.copyNumber": "Копировать номер",
    "profile.more.copyLink": "Копировать ссылку phantom://",
    "profile.more.copied": "Скопировано",
    "profile.more.copyFailed": "Не удалось скопировать",
    "profile.qrLink": "Ввести phantom://",
    "profile.newChat": "Новый чат",

    // settings root
    "settings.title": "Настройки",
    "settings.crumb": "Profile",

    // settings.security
    "set.sec.title": "Безопасность",
    "set.sec.crumb": "Profile · Settings",
    "set.sec.note": "Приложение блокируется PIN-кодом. Биометрия отключена в Phantom — PIN надёжнее, его нельзя приложить силой.",
    "set.sec.appLock": "App Lock",
    "set.sec.appLock.statusOn": "PIN включён · {n} символов",
    "set.sec.appLock.timeout": "Блокировка через {n} мин",
    "set.sec.appLock.disable": "Отключить блокировку",
    "set.sec.pinLength": "Длина PIN:",
    "set.sec.pin6": "6 символов",
    "set.sec.pin12": "12 символов",
    "set.sec.pin24": "24 символа",
    "set.sec.lockAfter": "Блокировать через:",
    "set.sec.t1m": "1 мин",
    "set.sec.t5m": "5 мин",
    "set.sec.t10m": "10 мин",
    "set.sec.t30m": "30 мин",
    "set.sec.t1h": "1 час",
    "set.sec.pinPlaceholder": "Введите PIN ({n} символов)",
    "set.sec.enableLock": "Включить блокировку",
    "set.sec.panic": "Panic-PIN",
    "set.sec.panic.active": "Panic-PIN активен",
    "set.sec.panic.activeSub": "При вводе — все данные стираются",
    "set.sec.panic.desc": "Альтернативный PIN, при вводе которого все данные стираются и показывается пустой экран входа.",
    "set.sec.panic.placeholder": "Введите Panic PIN",
    "set.sec.panic.activate": "Активировать Panic Mode",
    "set.sec.messages": "Сообщения",
    "set.sec.selfDestruct": "Self-destruct по умолчанию",
    "set.sec.selfDestruct.off": "Выключено",
    "set.sec.selfDestruct.sec": "{n} сек",
    "set.sec.screenshots": "Уведомления о скриншотах",
    "set.sec.screenshots.sub": "Сообщать собеседнику при скриншоте",
    "set.sec.hidePreview": "Скрыть превью",
    "set.sec.hidePreview.sub": "Не показывать содержимое в push",
    "set.sec.danger": "Опасная зона",
    "set.sec.clearChats": "Очистить все чаты",
    "set.sec.clearChats.sub": "Только на этом устройстве",
    "set.sec.clearChats.confirmTitle": "Очистить все чаты",
    "set.sec.clearChats.confirmBody": "Все сообщения будут удалены на этом устройстве. Контакты и настройки сохранятся.",
    "set.sec.clearChats.confirmCta": "Очистить",
    "set.sec.deleteAcc": "Удалить аккаунт",
    "set.sec.deleteAcc.sub": "Безвозвратно",
    "set.sec.deleteAcc.confirmTitle": "Удаление аккаунта",
    "set.sec.deleteAcc.confirmBody": "Все данные на этом устройстве будут удалены. Действие необратимо.",
    "set.sec.deleteAcc.multi": "Удалить все аккаунты",
    "set.sec.deleteAcc.multi.sub": "Все аккаунты браузера · безвозвратно",
    "set.sec.deleteAcc.confirmTitleMulti": "Удалить все аккаунты?",
    "set.sec.deleteAcc.confirmBodyMulti": "Будут удалены все аккаунты этого браузера (во всех вкладках) вместе с ключами, контактами и настройками на этом устройстве. Действие необратимо. Чтобы выйти только из одного номера, используйте «Выйти» в разделе «Аккаунты».",
    "set.logout.confirmTitle": "Выход из аккаунта",
    "set.logout.confirmBody": "Все данные на этом устройстве будут удалены. Вы уверены?",

    // privacy settings
    "set.priv.title": "Приватность",
    "set.priv.hideOnline": "Скрыть «в сети»",
    "set.priv.hideOnline.sub": "Контакты не видят ваш статус",
    "set.priv.readReceipts": "Уведомления о прочтении",
    "set.priv.readReceipts.sub": "Не отправлять отметки read",
    "set.priv.typing": "Индикатор «печатает»",
    "set.priv.typing.sub": "Не отправлять typing-сигнал",
    "set.priv.bar": "Burn After Read (по умолчанию)",
    "set.priv.bar.sub": "Сжигать сообщения после прочтения",
    "set.priv.network": "Звонки и P2P",
    "set.priv.privateCalls": "Скрывать IP в звонках",
    "set.priv.privateCalls.sub": "Звонки только через TURN-сервер: собеседник не видит ваш IP. Звонки не от контактов идут так всегда.",
    "set.priv.p2p": "Прямое соединение (P2P)",
    "set.priv.p2p.sub": "Сообщения и файлы идут напрямую между устройствами, сервер видит только служебный сигналинг. Файлы передаются только напрямую. Собеседник-контакт может видеть ваш IP-адрес, если не включено «Скрывать IP в звонках».",

    // appearance
    "set.app.title": "Оформление",
    "set.app.theme": "Тема",
    "set.app.themeLight": "☀ Светлая",
    "set.app.themeDark": "🌙 Тёмная",
    "set.app.themeSystem": "⚙ Системная",
    "set.app.sdTimer": "Self-destruct таймер",
    "sd.5s": "5 сек",
    "sd.30s": "30 сек",
    "sd.1m": "1 мин",
    "sd.5m": "5 мин",
    "sd.off": "Выкл",

    // devices
    "set.dev.title": "Устройства",
    "set.dev.refresh": "Обновить список",
    "set.dev.empty": "Нет активных сеансов. Нажмите «Обновить».",
    "set.dev.current": "текущий",
    "set.dev.terminate": "Завершить",
    "set.dev.activeAt": "Активен: ",

    // about
    "set.about.title": "О приложении",
    "set.about.version": "Версия",
    "set.about.crypto": "Шифрование",
    "set.about.storage": "Хранение",
    "set.about.storage.sub": "Сообщения — только RAM до доставки; на нашем сервере в зашифрованном виде хранятся ключи, capabilities, push-токены, mesh-identity, блок-листы",
    "set.about.theme": "Тема",
    "set.about.phantomNumber": "Phantom Number",
    "set.about.status": "Статус",

    // server
    "set.srv.title": "Сервер",
    "set.srv.note": "Веб-версия работает на том сервере, где открыта. Все сообщения проходят через relay зашифрованными — он видит метаданные, но не контент.",
    "set.srv.current": "Текущий сервер",

    // notifications
    "set.notif.title": "Уведомления",
    "set.notif.push": "Push-уведомления",
    "set.notif.push.granted": "Включены · браузер разрешил",
    "set.notif.push.disabled": "Выключены вручную",
    "set.notif.push.denied": "Заблокировано в настройках браузера",
    "set.notif.push.default": "Браузер пока не запрашивал разрешение",
    "set.notif.hide": "Скрывать превью",
    "set.notif.hide.sub": "Не показывать текст в push",

    // language
    "set.lang.title": "Язык",
    "set.lang.ru": "🇷🇺 Русский",
    "set.lang.en": "🇬🇧 English",
    "set.lang.note": "Сменить язык можно в любой момент. Phantom автоматически выбирает язык по настройкам браузера при первом входе.",

    // contacts
    "contacts.title": "Контакты ({n})",
    "contacts.empty": "Нет сохранённых контактов. Откройте чат и сохраните контакт.",
    "contacts.add": "Добавить контакт",
    "contacts.namePlaceholder": "Имя контакта",

    // newchat
    "newchat.title": "Связаться",
    "newchat.crumb": "Новый чат",
    "newchat.section": "Phantom Number",
    "newchat.hint": "Введите 10-значный номер собеседника",
    "newchat.fromContacts": "Из контактов",

    // legal modal
    "legal.eyebrow": "PHANTOM MESSENGER · v1.0.0",
    "legal.title": "Условия и приватность",
    "legal.short": "Кратко",
    "legal.short.1": "Мы не храним вашу переписку: сервер держит сообщения только в оперативной памяти до доставки.",
    "legal.short.2": "Мы не видим содержимое сообщений — всё шифруется на вашем устройстве (E2E, ECDH P-256 + AES-256-GCM).",
    "legal.short.3": "Мы не запрашиваем email, телефон и анкету — вход по NFT-номеру с TON.",
    "legal.short.4": "Мы не используем рекламу, не продаём данные и не имеем третьих сторон-аналитиков.",
    "legal.h1": "1. Природа сервиса",
    "legal.p1": "Phantom Messenger — это эфемерный мессенджер. Сервис работает через relay-сервер, который пересылает зашифрованные «контейнеры» между устройствами. Содержимое сообщений (текст, голос, файлы) шифруется на вашем устройстве до отправки (E2E: ECDH P-256 + AES-256-GCM, эфемерный ключ на каждое сообщение); relay видит только шифртекст и метаданные доставки. Перезапуск сервера приводит к потере очереди недоставленных сообщений и текущих сессий — это часть дизайна, а не сбой.",
    "legal.h2": "2. Идентичность через Phantom Number",
    "legal.p2.1": "Идентификация — через NFT-номер из коллекции ",
    "legal.p2.2": " на блокчейне TON. Вы единственный владелец своего номера. Сервис не выдаёт, не блокирует и не «восстанавливает» номера — только проверяет владение через одноразовый код, отправленный в личный кабинет владельца NFT.",
    "legal.h3": "3. Что мы видим, а что нет",
    "legal.p3a": "Не видим:",
    "legal.p3a.body": " текст, файлы, голос; с собеседниками на текущей версии приложения — также имена и типы файлов, длительность голосовых, эмодзи реакций, цитаты и таймеры самоуничтожения; имена контактов, заметки, персональные настройки чатов.",
    "legal.p3b": "Технически видим, потому что иначе пакет не доставить:",
    "legal.p3b.body": " номера отправителя и получателя, время и размер шифр-блоба, факт реакции, прочтения, набора текста и удаления (без содержимого), сигналинг звонков, IP-адрес соединения. На диске нашего сервера хранятся только публичные ключи, возможности клиента (capabilities), push-токены, отзывы mesh-ключей, поколение ключа моста и (пока включён флаг) блок-листы; файл состояния шифруется ключом сервера. Каталога mesh-идентичностей на сервере нет. Сообщения лежат только в оперативной памяти до доставки. Прикладной журнал сервера не содержит IP и номеров.",
    "legal.h4": "4. Хранение и удаление",
    "legal.p4.1": "Переписка хранится только в памяти вкладки. Контакты, аватары, настройки и ключ устройства хранятся в браузере до выхода из аккаунта.",
    "legal.p4.2": "Выход стирает данные аккаунта на этом устройстве; panic-PIN и «Удалить аккаунт» стирают все данные приложения в браузере.",
    "legal.p4.3": "Прикладной журнал сервера ведётся на уровне предупреждений, успешные события — без IP и номеров; содержимое не логируется. Инфраструктура перед сервером (Cloudflare, TURN) видит IP-адреса соединений.",
    "legal.p4.4": "Уведомления браузера, если вы их разрешили, по умолчанию без текста сообщения; если вы включили превью, показываются до 100 символов текста.",
    "legal.h5": "5. Звонки и медиа",
    "legal.p5": "Аудио- и видео-звонки идут поверх WebRTC с DTLS-SRTP. Сервер участвует только как сигнальный посредник и опциональный TURN-relay. Голосовые сообщения и файлы шифруются E2E так же, как и текст.",
    "legal.h6": "6. Ваши обязанности",
    "legal.p6.1": "Используйте сервис в законных целях. Запрещены угрозы, мошенничество, распространение вредоносного ПО и материалов, нарушающих закон вашей юрисдикции.",
    "legal.p6.2": "Вы отвечаете за безопасность своего устройства, NFT-кошелька и приватного ключа. Сервис не имеет к ним доступа и не может «восстановить» аккаунт.",
    "legal.p6.3": "Не передавайте свой PIN/Panic-PIN другим лицам.",
    "legal.h7": "7. Гарантии и ответственность",
    "legal.p7": "Сервис предоставляется «как есть», без гарантий доступности или сохранности эфемерных данных. Авторы не несут ответственности за упущенную выгоду, утрату возможности связи и косвенные убытки, в пределах, разрешённых применимым законодательством.",
    "legal.h8": "8. Изменения",
    "legal.p8": "Условия могут обновляться вместе с версиями приложения. О существенных изменениях мы сообщим внутри клиента. Дальнейшее использование сервиса после обновления означает согласие с новой редакцией.",
    "legal.h9": "9. Контакты",
    "legal.p9": "По вопросам приватности, удаления данных и условий пишите на {email}.",
    "legal.operator": "Этот сервер обслуживает независимый оператор: {name}. Его условия и политика приватности открываются по ссылкам ниже.",
    "legal.meta": "Редакция от 2026-10-23. Phantom Messenger — открытый relay, сквозное шифрование содержимого.",
    "legal.full": "Открыть полностью:",
    "legal.fullTerms": "Условия использования",
    "legal.fullPrivacy": "Политика приватности",
  },
  en: {
    // common
    "common.back": "Back",

    // voice messages (VoiceRecorderBar)
    "voice.cancel": "Delete recording",
    "voice.sending": "Sending…",
    "voice.inCall": "Voice recording is unavailable during a call",
    "voice.notReady": "Wait until encryption is ready and open a chat",
    "voice.send": "Send",
    "voice.pause": "Pause",
    "voice.resume": "Resume recording",
    "voice.play": "Listen",
    "voice.stopPlay": "Stop",
    "voice.bar": "Recording a voice message",
    "voice.holdHint": "Hold to record",
    "voice.slideCancel": "Slide left to cancel",
    "voice.slideLock": "Slide up to lock",
    "voice.tooShort": "Recording is too short",
    "voice.micDenied": "Microphone access denied. Allow it in your browser settings.",
    "voice.unsupported": "Voice recording is not supported by this browser",
    "voice.limit": "Voice message limit reached. Send or delete the recording.",
    "voice.interrupted": "Recording stopped. Send or delete it.",
    "voice.msgPlay": "Play",
    "voice.msgPause": "Pause",
    "voice.seek": "Seek",
    "voice.speed": "Playback speed: {rate}",
    "voice.playFailed": "Couldn't play",
    "voice.retry": "Retry",
    "voice.updateBrowser": "Voice recording is unavailable: update your browser",
    "common.cancel": "Cancel",
    "common.save": "Save",
    "common.next": "Next",
    "common.start": "Start",
    "common.skip": "Skip",
    "common.gotIt": "Got it",
    "common.continue": "Continue",
    "common.close": "Close",
    "common.delete": "Delete",
    "common.deleteForMe": "Delete for me",
    "common.deleteForAll": "Delete for everyone",
    "common.send": "Send",
    "common.open": "Open",
    "common.you": "You: ",
    "common.online": "online",
    "common.offline": "offline",
    "common.connecting": "connecting...",
    "common.searching": "Search...",
    "common.loading": "Loading...",
    "common.draft": "Draft: ",
    "common.typing": "typing...",
    "common.unknown": "Unknown",
    "common.now": "now",
    "common.refresh": "Refresh",
    "common.add": "Add",
    "common.enable": "Enable",
    "common.disable": "Disable",
    "common.activate": "Activate",
    "common.confirm": "Confirm",
    "common.error": "Error",
    "common.success": "Done",

    // splash
    "splash.title": "Phantom",
    "splash.tag": "Ephemeral messenger",

    // onboarding
    "onb.skip": "Skip",
    "onb.next": "Next",
    "onb.start": "Start",
    "onb.1.title": "Ephemerality",
    "onb.1.body": "The server keeps messages only in RAM until delivery and doesn't write IPs or numbers to its application logs.",
    "onb.1.chip": "RAM until delivery · no IPs in logs",
    "onb.2.title": "End-to-end encryption",
    "onb.2.body": "ECDH P-256 + AES-256-GCM with an ephemeral key per message. A leaked sender key doesn't expose past messages; protect the recipient key — it decrypts everything sent to it.",
    "onb.2.chip": "ECDH P-256 · AES-256-GCM",
    "onb.3.title": "NFT = Identity",
    "onb.3.body": "Phantom Number — your 10-digit number on TON blockchain. Not an email, not a phone, no one can take it from you.",
    "onb.3.chip": "TON · NFT Numbers",

    // welcome
    "welcome.title": "Welcome",
    "welcome.tag": "Sign in with your Phantom Number",
    "welcome.cardTitle": "With Phantom Number",
    "welcome.cardSub": "NFT identity · TON",
    "welcome.cardBody.before": "You'll need an NFT Number from ",
    "welcome.cardBody.after": ". After OTP — relay chats, voice and video calls.",
    "welcome.cta": "Sign in by number",
    "welcome.shieldNote": "Messages are end-to-end encrypted. The server only sees encrypted blobs.",
    "welcome.legal": "Terms & Privacy",

    // auth
    "auth.step1": "Step 1 of 2",
    "auth.step2": "Step 2 of 2",
    "auth.numTitle": "Phantom Number",
    "auth.codeTitle": "Verification code",
    "auth.headEnter": "Enter your number",
    "auth.headEnterSub": "10 digits of your NFT number. e.g. 111-00-234-56",
    "auth.cta.send": "Get code",
    "auth.cta.sending": "Sending...",
    "auth.cta.verify": "Sign in",
    "auth.cta.verifying": "Verifying...",

    // otp
    "otp.title": "OTP",
    "otp.sub": "The code was sent to the number's owner cabinet",
    "otp.notReceived": "Didn't get it? ",
    "otp.resendIn": "Resend in 0:",
    "otp.resendNow": "Resend now",

    // sidebar
    "sidebar.searchPlaceholder": "Search chats and messages",
    "sidebar.filter.all": "All",
    "sidebar.filter.unread": "Unread",
    "sidebar.filter.contacts": "Contacts",
    "sidebar.filter.archive": "Archive",
    "sidebar.empty.noChats": "No chats yet",
    "sidebar.empty.archive": "Archive is empty",
    "sidebar.empty.startChat": "Start a new chat",
    "sidebar.search.writeTo": "Message",
    "sidebar.search.newChatByNumber": "New chat by number",
    "sidebar.foot.me": "Me",
    "sidebar.foot.id": "phantom-id ",
    "sidebar.fab.newChat": "New chat",
    "sidebar.tooltip.newChat": "New chat",
    "sidebar.tooltip.menu": "Menu",
    "sidebar.tooltip.settings": "Settings",

    // chat header / panel
    "chat.tooltip.search": "Search in chat",
    "chat.tooltip.audio": "Audio call",
    "chat.tooltip.video": "Video call",
    "chat.tooltip.more": "More",
    "chat.status.online": "online",
    "chat.status.recently": "last seen recently",
    "chat.empty.title": "Phantom",
    "chat.empty.body": "Pick a chat on the left or start a new one. Messages are end-to-end encrypted and kept only in this tab's memory.",
    "chat.empty.serverPrefix": "TLS 1.3",
    "chat.pinned.title": "Pinned messages",
    "chat.pinned.unpin": "Unpin",
    "chat.deleteMsg.title": "Delete message?",
    "chat.deleteMsg.warn": "This action can't be undone.",
    "chat.composer.placeholder": "Message...",
    "chat.composer.send": "Send",
    "chat.composer.attach": "Attach",
    "chat.composer.timer": "Self-destruct",
    "chat.composer.voice": "Voice message",
    "chat.encryption": "Encryption is active",

    // call overlay
    "call.incoming": "incoming call",
    "call.sas": "Call code",
    "call.sas.hint": "Compare this code with your peer by voice. If the codes differ, the call is intercepted — hang up.",
    "call.path.direct": "Direct",
    "call.path.direct.hint": "Audio and video go directly between the devices; the server does not receive them.",
    "call.path.turn": "Via TURN",
    "call.path.turn.hint": "Audio and video are relayed encrypted through a TURN server; TURN sees both parties' IP addresses, not the content.",
    "call.calling": "calling...",
    "call.reconnecting": "reconnecting...",
    "call.failed": "couldn't connect",
    "call.btn.reject": "Reject",
    "call.btn.accept": "Accept",
    "call.btn.end": "End",
    "call.btn.message": "Message",
    "call.btn.muteOn": "Mute mic",
    "call.btn.muteOff": "Unmute mic",
    "call.btn.videoOn": "Turn camera off",
    "call.btn.videoOff": "Turn camera on",
    "call.btn.switchCamera": "Switch camera",
    "call.cameraOff": "Camera is off",
    "call.peerMutedMic": "The other party muted their mic",
    "call.inCall": "In call",
    "call.crypto": "ECDH · DTLS-SRTP",
    "call.btn.add": "Add participant",

    // app lock
    "lock.title": "Phantom",
    "lock.sub": "Enter your PIN to unlock",

    // privacy modal
    "privacy.heading": "Privacy Notice",
    "privacy.e2eTitle": "End-to-end encryption",
    "privacy.e2eBody": "E2E: ECDH P-256 + AES-256-GCM with an ephemeral key per message. The server can't read content but sees who writes to whom and when.",
    "privacy.ephTitle": "Ephemerality",
    "privacy.ephBody": "Closing the tab wipes the conversation forever.",
    "privacy.sdTitle": "Self-destructing messages",
    "privacy.sdBody": "Set a timer — messages will be removed automatically.",
    "privacy.anonTitle": "Anonymity",
    "privacy.anonBody": "For maximum anonymity use Tor or a VPN.",

    // session replaced
    "session.replaced.title": "Session ended",
    "session.replaced.body": "Signed in from another device. Reconnect?",
    "session.replaced.logout": "Sign out",
    "session.replaced.reconnect": "Reconnect",

    // drag & drop
    "drag.hereFile": "Drop files here",

    // profile / settings
    "profile.idCard": "ID Card",
    "profile.title": "Profile",
    "profile.stamp": "::MY PROFILE::",
    "profile.section.vibe": "vibe",
    "profile.section.settings": "settings",
    "profile.row.security": "Security",
    "profile.row.security.sub": "App Lock · Panic-PIN",
    "profile.row.server": "Server",
    "profile.row.devices": "Devices",
    "profile.row.devices.sub": "{n} active sessions",
    "profile.row.privacy": "Privacy",
    "profile.row.privacy.sub": "Read receipts · Typing",
    "profile.row.appearance": "Appearance",
    "profile.row.notifications": "Notifications",
    "profile.row.notifications.sub": "Enabled",
    "profile.row.language": "Language",
    "profile.row.language.sub": "English",
    "profile.row.about": "About",
    "profile.row.logout": "Sign out",
    "accounts.title": "Accounts",
    "accounts.add": "Add account",
    "accounts.limit": "No more than 3 accounts",
    "accounts.duplicate": "This number is already added",
    "accounts.connecting": "Connecting…",
    "accounts.active": "Active",
    "accounts.hint": "Messages for inactive accounts arrive after you switch to them",
    "accounts.logout": "Sign out",
    "accounts.removeTitle": "Sign out of this account?",
    "accounts.removeBody": "Data and the key of account {number} will be removed from this device. The session on the server is not revoked immediately and expires with the token.",
    "accounts.callBusy": "End the call to switch accounts",
    "accounts.sessionExpired": "Session {number} expired — sign in again",
    "accounts.sessionEnded": "Session {number} was ended by the server, sign in again",
    "accounts.adding": "Adding an account",
    "accounts.switchTo": "Switch to {number}",
    "profile.more.copyNumber": "Copy number",
    "profile.more.copyLink": "Copy phantom:// link",
    "profile.more.copied": "Copied",
    "profile.more.copyFailed": "Could not copy",
    "profile.qrLink": "Enter phantom://",
    "profile.newChat": "New chat",

    // settings root
    "settings.title": "Settings",
    "settings.crumb": "Profile",

    // settings.security
    "set.sec.title": "Security",
    "set.sec.crumb": "Profile · Settings",
    "set.sec.note": "The app is locked with a PIN. Biometrics is intentionally disabled — a PIN can't be forced from a sleeping user.",
    "set.sec.appLock": "App Lock",
    "set.sec.appLock.statusOn": "PIN is on · {n} characters",
    "set.sec.appLock.timeout": "Lock after {n} min",
    "set.sec.appLock.disable": "Disable lock",
    "set.sec.pinLength": "PIN length:",
    "set.sec.pin6": "6 characters",
    "set.sec.pin12": "12 characters",
    "set.sec.pin24": "24 characters",
    "set.sec.lockAfter": "Lock after:",
    "set.sec.t1m": "1 min",
    "set.sec.t5m": "5 min",
    "set.sec.t10m": "10 min",
    "set.sec.t30m": "30 min",
    "set.sec.t1h": "1 h",
    "set.sec.pinPlaceholder": "Enter PIN ({n} characters)",
    "set.sec.enableLock": "Enable lock",
    "set.sec.panic": "Panic-PIN",
    "set.sec.panic.active": "Panic-PIN is active",
    "set.sec.panic.activeSub": "When entered — wipes all data",
    "set.sec.panic.desc": "An alternative PIN that, when entered, wipes all data and shows an empty sign-in screen.",
    "set.sec.panic.placeholder": "Enter Panic PIN",
    "set.sec.panic.activate": "Activate Panic Mode",
    "set.sec.messages": "Messages",
    "set.sec.selfDestruct": "Default self-destruct",
    "set.sec.selfDestruct.off": "Off",
    "set.sec.selfDestruct.sec": "{n} sec",
    "set.sec.screenshots": "Screenshot alerts",
    "set.sec.screenshots.sub": "Notify your peer when you take a screenshot",
    "set.sec.hidePreview": "Hide preview",
    "set.sec.hidePreview.sub": "Don't show contents in push",
    "set.sec.danger": "Danger zone",
    "set.sec.clearChats": "Clear all chats",
    "set.sec.clearChats.sub": "On this device only",
    "set.sec.clearChats.confirmTitle": "Clear all chats",
    "set.sec.clearChats.confirmBody": "All messages will be wiped on this device. Contacts and settings stay.",
    "set.sec.clearChats.confirmCta": "Clear",
    "set.sec.deleteAcc": "Delete account",
    "set.sec.deleteAcc.sub": "Permanent",
    "set.sec.deleteAcc.confirmTitle": "Delete account",
    "set.sec.deleteAcc.confirmBody": "All data on this device will be wiped. This action can't be undone.",
    "set.sec.deleteAcc.multi": "Delete all accounts",
    "set.sec.deleteAcc.multi.sub": "All accounts in this browser · permanent",
    "set.sec.deleteAcc.confirmTitleMulti": "Delete all accounts?",
    "set.sec.deleteAcc.confirmBodyMulti": "All accounts in this browser (in all tabs) will be deleted together with their keys, contacts and settings on this device. This can't be undone. To sign out of just one number, use “Sign out” in the “Accounts” section.",
    "set.logout.confirmTitle": "Sign out",
    "set.logout.confirmBody": "All data on this device will be wiped. Are you sure?",

    // privacy settings
    "set.priv.title": "Privacy",
    "set.priv.hideOnline": "Hide \"online\"",
    "set.priv.hideOnline.sub": "Contacts won't see your status",
    "set.priv.readReceipts": "Read receipts",
    "set.priv.readReceipts.sub": "Don't send read marks",
    "set.priv.typing": "Typing indicator",
    "set.priv.typing.sub": "Don't send typing signals",
    "set.priv.bar": "Burn After Read (default)",
    "set.priv.bar.sub": "Erase messages after reading",
    "set.priv.network": "Calls and P2P",
    "set.priv.privateCalls": "Hide IP in calls",
    "set.priv.privateCalls.sub": "Calls go only through the TURN server: the other side can't see your IP. Calls with non-contacts always do.",
    "set.priv.p2p": "Direct connection (P2P)",
    "set.priv.p2p.sub": "Messages and files go directly between devices; the server only sees service signaling. Files are sent only directly. A contact may see your IP address unless \"Hide IP in calls\" is on.",

    // appearance
    "set.app.title": "Appearance",
    "set.app.theme": "Theme",
    "set.app.themeLight": "☀ Light",
    "set.app.themeDark": "🌙 Dark",
    "set.app.themeSystem": "⚙ System",
    "set.app.sdTimer": "Self-destruct timer",
    "sd.5s": "5 sec",
    "sd.30s": "30 sec",
    "sd.1m": "1 min",
    "sd.5m": "5 min",
    "sd.off": "Off",

    // devices
    "set.dev.title": "Devices",
    "set.dev.refresh": "Refresh",
    "set.dev.empty": "No active sessions. Tap \"Refresh\".",
    "set.dev.current": "current",
    "set.dev.terminate": "Terminate",
    "set.dev.activeAt": "Active: ",

    // about
    "set.about.title": "About",
    "set.about.version": "Version",
    "set.about.crypto": "Encryption",
    "set.about.storage": "Storage",
    "set.about.storage.sub": "Messages: RAM only until delivery; our server keeps keys, capabilities, push tokens, mesh identities and block lists in encrypted form",
    "set.about.theme": "Theme",
    "set.about.phantomNumber": "Phantom Number",
    "set.about.status": "Status",

    // server
    "set.srv.title": "Server",
    "set.srv.note": "The web client runs on the server it was opened from. All messages go through the relay encrypted — it sees metadata, not contents.",
    "set.srv.current": "Current server",

    // notifications
    "set.notif.title": "Notifications",
    "set.notif.push": "Push notifications",
    "set.notif.push.granted": "Enabled · browser allowed",
    "set.notif.push.disabled": "Disabled manually",
    "set.notif.push.denied": "Blocked in browser settings",
    "set.notif.push.default": "Browser hasn't been asked yet",
    "set.notif.hide": "Hide preview",
    "set.notif.hide.sub": "Don't show text in push",

    // language
    "set.lang.title": "Language",
    "set.lang.ru": "🇷🇺 Русский",
    "set.lang.en": "🇬🇧 English",
    "set.lang.note": "You can change the language anytime. Phantom auto-picks it from your browser settings on first sign-in.",

    // contacts
    "contacts.title": "Contacts ({n})",
    "contacts.empty": "No saved contacts. Open a chat and save the contact.",
    "contacts.add": "Add contact",
    "contacts.namePlaceholder": "Contact name",

    // newchat
    "newchat.title": "Reach out",
    "newchat.crumb": "New chat",
    "newchat.section": "Phantom Number",
    "newchat.hint": "Enter the 10-digit Phantom Number",
    "newchat.fromContacts": "From contacts",

    // legal modal
    "legal.eyebrow": "PHANTOM MESSENGER · v1.0.0",
    "legal.title": "Terms & Privacy",
    "legal.short": "TL;DR",
    "legal.short.1": "We don't store your conversations: the server keeps messages only in RAM until delivery.",
    "legal.short.2": "We can't see message contents — everything is encrypted on your device (E2E, ECDH P-256 + AES-256-GCM).",
    "legal.short.3": "We don't ask for an email, phone number or profile form — sign-in is by NFT number on TON.",
    "legal.short.4": "No ads, no data sales, no third-party analytics.",
    "legal.h1": "1. Nature of the service",
    "legal.p1": "Phantom Messenger is an ephemeral messenger. The relay forwards encrypted blobs between devices. Message content (text, voice, files) is encrypted on your device before sending (E2E: ECDH P-256 + AES-256-GCM, an ephemeral key per message); the relay only sees ciphertext and delivery metadata. A relay restart drops the queue of undelivered messages and active sessions — that's by design.",
    "legal.h2": "2. Identity via Phantom Number",
    "legal.p2.1": "Identity is verified by an NFT number from the ",
    "legal.p2.2": " collection on the TON blockchain. You are the sole owner of your number. The service does not issue, suspend or \"recover\" numbers — it only verifies ownership via a one-time code sent to the cabinet of the NFT owner.",
    "legal.h3": "3. What we see and what we don't",
    "legal.p3a": "We don't see:",
    "legal.p3a.body": " text, files, voice; with contacts on the current app version — also file names and types, voice durations, reaction emoji, quotes and self-destruct timers; contact names, notes, per-chat settings.",
    "legal.p3b": "Technically visible because otherwise we couldn't deliver:",
    "legal.p3b.body": " sender and receiver numbers, time and size of the encrypted blob, the fact of a reaction, read receipt, typing or deletion (without content), call signaling, connection IP. On our server's disk there are only public keys, client capabilities, push tokens, mesh key revocations, the bridge key generation and (while a flag is on) block lists; the state file is encrypted with a server key. There is no catalog of mesh identities on the server. Messages live only in RAM until delivery. The server's application log contains no IPs or numbers.",
    "legal.h4": "4. Storage and deletion",
    "legal.p4.1": "Conversations live only in tab memory. Contacts, avatars, settings and the device key are stored in the browser until you sign out.",
    "legal.p4.2": "Signing out wipes this account's data on the device; panic-PIN and \"Delete account\" wipe all app data in the browser.",
    "legal.p4.3": "The server's application log runs at warning level, successful events carry no IPs or numbers; content is never logged. Infrastructure in front of it (Cloudflare, TURN) sees connection IPs.",
    "legal.p4.4": "Browser notifications, if you allowed them, carry no message text by default; if you turn on previews, up to 100 characters of the text are shown.",
    "legal.h5": "5. Calls and media",
    "legal.p5": "Audio and video calls go over WebRTC with DTLS-SRTP. The server only acts as a signaling proxy and optional TURN relay. Voice messages and files are E2E-encrypted just like text.",
    "legal.h6": "6. Your responsibilities",
    "legal.p6.1": "Use the service for lawful purposes. Threats, fraud, malware and content violating your local laws are forbidden.",
    "legal.p6.2": "You are responsible for your device, NFT wallet and private key. The service has no access and cannot \"recover\" an account.",
    "legal.p6.3": "Don't share your PIN or Panic-PIN.",
    "legal.h7": "7. Warranties and liability",
    "legal.p7": "The service is provided \"as is\", without guarantees of availability or preservation of ephemeral data. Authors aren't liable for lost profits, lost ability to communicate or indirect damages, to the extent permitted by applicable law.",
    "legal.h8": "8. Changes",
    "legal.p8": "Terms may evolve with new versions. We'll announce material changes inside the client. Continued use after the update implies consent with the new revision.",
    "legal.h9": "9. Contacts",
    "legal.p9": "For questions about privacy, data deletion and the terms, write to {email}.",
    "legal.operator": "This server is run by an independent operator: {name}. Its terms and privacy policy open from the links below.",
    "legal.meta": "Revision dated 2026-10-23. Phantom Messenger — open relay, end-to-end encrypted content.",
    "legal.full": "Read in full:",
    "legal.fullTerms": "Terms of Use",
    "legal.fullPrivacy": "Privacy Policy",
  },
};

export function tx(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const dict = MESSAGES[locale] || MESSAGES.en;
  let s = dict[key] ?? MESSAGES.en[key] ?? key;
  if (params) {
    for (const k of Object.keys(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(params[k]));
    }
  }
  return s;
}

interface I18nCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18nCtx | null>(null);

export function I18nProvider(props: PropsWithChildren) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale());

  useEffect(() => {
    try { document.documentElement.lang = locale; } catch { /* ignore */ }
  }, [locale]);

  const value = useMemo<I18nCtx>(() => ({
    locale,
    setLocale: (l: Locale) => { setStoredLocale(l); setLocaleState(l); },
    t: (key, params) => tx(locale, key, params),
  }), [locale]);

  return createElement(Ctx.Provider, { value }, props.children as any);
}

export function useT(): I18nCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // безопасный fallback без провайдера
    const loc = initialLocale();
    return {
      locale: loc,
      setLocale: () => {},
      t: (key, params) => tx(loc, key, params),
    };
  }
  return ctx;
}
