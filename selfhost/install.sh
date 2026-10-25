#!/usr/bin/env bash
# Phantom Messenger — установщик собственного сервера (relay + веб-клиент + coturn + nginx/TLS).
# Лицензия: AGPL-3.0 (см. LICENSE). Запускать из распакованного релизного архива, от root.
# Повторный запуск идемпотентен: секреты сохраняются, конфиги пересоздаются, перед правкой — бэкап.
set -euo pipefail
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/relay.sh
source "$SCRIPT_DIR/lib/relay.sh"
# shellcheck source=lib/tls.sh
source "$SCRIPT_DIR/lib/tls.sh"
# shellcheck source=lib/nginx.sh
source "$SCRIPT_DIR/lib/nginx.sh"
# shellcheck source=lib/coturn.sh
source "$SCRIPT_DIR/lib/coturn.sh"

usage() {
  cat <<'USAGE'
Использование: sudo ./install.sh [параметры]
Без параметров запускается диалог. Для автоматической установки: --non-interactive + флаги.

Обязательные (в диалоге спрашиваются):
  --domain <имя>            домен сервера, например msg.example.com (A-запись → IP VPS)
  --tls <режим>             letsencrypt | cloudflare-dns | cloudflare-origin | custom
  --service-key-file <ф>    файл с ключом интеграции сервиса номеров (рекомендуется)
                            (также: переменная PM_SERVICE_KEY; --service-key <ключ> виден в ps — не рекомендуется)

Режимы TLS:
  letsencrypt               Let's Encrypt HTTP-01 (нужны :80 и A-запись домена на этот сервер)
  cloudflare-dns            Let's Encrypt DNS-01 через Cloudflare API: --cf-api-token-file <ф>
                            (токен с правом Zone:DNS:Edit; домен может быть за оранжевым облаком)
  cloudflare-origin         Cloudflare Origin Certificate + оранжевое облако (SSL Full strict):
                            --origin-cert <pem> --origin-key <key>
  custom                    свой платный сертификат: --origin-cert <fullchain.pem> --origin-key <key>

Дополнительно:
  --email <адрес>           почта для Let's Encrypt (по умолчанию = --operator-email)
  --turn-host <имя>         имя TURN-сервера, по умолчанию turn.<domain>; ТОЛЬКО DNS-only (серое облако)
  --external-ip <IPv4>      внешний IP сервера (если автоопределение не подходит; за NAT)
  --api-base <https://…>    адрес сервиса номеров (по умолчанию PM_DEFAULT_API_BASE из lib/common.sh)
  --operator-name <текст>   имя оператора для /terms и /privacy (по умолчанию = домен)
  --operator-email <адрес>  контактная почта оператора (по умолчанию = --email)
  --operator-site <https://…> сайт оператора (по умолчанию https://<domain>)
  --operator-terms-url <https://…>    страница условий (по умолчанию https://<domain>/terms)
  --operator-privacy-url <https://…>  страница политики приватности (по умолчанию https://<domain>/privacy)
  Эти данные пишутся в operator.json: веб-клиент подставляет их в /terms, /privacy и контакт,
  а приложения iOS/macOS/Android для вашего сервера ведут «Сайт / Условия / Политика» на эти адреса.
  В диалоге имя, почта и сайт оператора спрашиваются всегда (Enter — значение по умолчанию).
  --enable-ufw              включить ufw (правила добавляются всегда, если ufw установлен)
  --cf-only-443 | --no-cf-only-443
                            ufw: 443/tcp только для CIDR Cloudflare (список обновляет pm-cf-update.timer).
                            По умолчанию ВКЛ для cloudflare-origin и ВЫКЛ для cloudflare-dns
  --signer-fingerprint <SHA256:…>
                            обязательная сверка отпечатка ключа подписи релиза (die при расхождении или если
                            подпись проверить нельзя). Отпечаток — из README / независимого источника
  --no-python-ppa           Ubuntu 22.04: не подключать deadsnakes PPA (python3.12); Python >= 3.11 поставить самому
  --force                   разрешить установку версии старее установленной (downgrade)
  --allow-unsigned          разрешить установку/повторную установку без проверяемой подписи релиза
                            (небезопасно: целостность без подлинности). Подписанные релизы проверяются всегда
  --skip-key-check          не проверять ключ запросом к сервису номеров
  --le-staging              Let's Encrypt staging (для тестов; сертификат не доверенный)
  --non-interactive, --yes  без вопросов; недостающие обязательные параметры = ошибка
  --dry-run                 напечатать план действий, ничего не меняя в системе
  --render-dir <каталог>    с --dry-run: сохранить отрендеренные конфиги (nginx, coturn, env без секретов…)
  -h, --help                эта справка
USAGE
}

DOMAIN="" ; EMAIL="" ; TLS_MODE="" ; TURN_HOST="" ; EXTERNAL_IP="" ; API_BASE=""
CF_TOKEN_FILE="" ; CERT_SRC="" ; KEY_SRC=""
SERVICE_KEY="${PM_SERVICE_KEY:-}" ; SERVICE_KEY_FILE=""
OPERATOR_NAME="" ; OPERATOR_EMAIL="" ; OPERATOR_SITE="" ; OPERATOR_TERMS_URL="" ; OPERATOR_PRIVACY_URL=""
ENABLE_UFW=0 ; SKIP_KEY_CHECK=0 ; LE_STAGING=0 ; NON_INTERACTIVE=0 ; RENDER_DIR=""
SSL_CERT="" ; SSL_KEY="" ; ENV_WORK="" ; PREV_ENV=""
CF_ONLY_443="" ; CF_ONLY_EXPLICIT=0 ; ALLOW_UNSIGNED=0 ; UNSIGNED_USED=0 ; SIGNER_FP="" ; FORCE=0 ; NO_PYTHON_PPA=0 ; PM_PYTHON=""
unset PM_SERVICE_KEY

need_arg() { [[ $# -ge 2 && -n "$2" ]] || die "Параметр $1 требует значение"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)           need_arg "$@"; DOMAIN="$(tr '[:upper:]' '[:lower:]' <<<"$2")"; shift 2 ;;
    --email)            need_arg "$@"; EMAIL="$2"; shift 2 ;;
    --tls|--ssl-mode)   need_arg "$@"; TLS_MODE="$2"; shift 2 ;;
    --cf-api-token-file) need_arg "$@"; CF_TOKEN_FILE="$2"; shift 2 ;;
    --origin-cert)      need_arg "$@"; CERT_SRC="$2"; shift 2 ;;
    --origin-key)       need_arg "$@"; KEY_SRC="$2"; shift 2 ;;
    --turn-host)        need_arg "$@"; TURN_HOST="$(tr '[:upper:]' '[:lower:]' <<<"$2")"; shift 2 ;;
    --external-ip)      need_arg "$@"; EXTERNAL_IP="$2"; shift 2 ;;
    --api-base)         need_arg "$@"; API_BASE="${2%/}"; shift 2 ;;
    --service-key)      need_arg "$@"; SERVICE_KEY="$2"; shift 2
                        print_warning "--service-key виден в списке процессов; надёжнее --service-key-file" ;;
    --service-key-file) need_arg "$@"; SERVICE_KEY_FILE="$2"; shift 2 ;;
    --operator-name)    need_arg "$@"; OPERATOR_NAME="$2"; shift 2 ;;
    --operator-email)   need_arg "$@"; OPERATOR_EMAIL="$2"; shift 2 ;;
    --operator-site)    need_arg "$@"; OPERATOR_SITE="${2%/}"; shift 2 ;;
    --operator-terms-url)   need_arg "$@"; OPERATOR_TERMS_URL="${2%/}"; shift 2 ;;
    --operator-privacy-url) need_arg "$@"; OPERATOR_PRIVACY_URL="${2%/}"; shift 2 ;;
    --enable-ufw)       ENABLE_UFW=1; shift ;;
    --skip-key-check)   SKIP_KEY_CHECK=1; shift ;;
    --cf-only-443)      CF_ONLY_443=1; CF_ONLY_EXPLICIT=1; shift ;;
    --no-cf-only-443)   CF_ONLY_443=0; shift ;;
    --allow-unsigned)   ALLOW_UNSIGNED=1; shift ;;
    --force)            FORCE=1; shift ;;
    --no-python-ppa)    NO_PYTHON_PPA=1; shift ;;
    --signer-fingerprint) need_arg "$@"; SIGNER_FP="$2"; shift 2
                        valid_fingerprint "$SIGNER_FP" || die "--signer-fingerprint: ожидается SHA256:<43 символа base64>" ;;
    --le-staging)       LE_STAGING=1; shift ;;
    --non-interactive|--yes|-y) NON_INTERACTIVE=1; shift ;;
    --dry-run)          DRY_RUN=1; shift ;;
    --render-dir)       need_arg "$@"; RENDER_DIR="$2"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *) print_error "Неизвестный параметр: $1"; usage; exit 1 ;;
  esac
done
cloudflare_alias() { [[ "$TLS_MODE" == "cloudflare" ]] && TLS_MODE="cloudflare-origin"; return 0; }
cloudflare_alias

# Временные файлы с секретами (рабочая копия env, бэкап прежнего env) удаляются при любом выходе.
cleanup() { rm -f "${ENV_WORK:-}" "${PREV_ENV:-}"; }
trap cleanup EXIT

have python3 || die "Не найден python3 (apt install python3): он нужен для проверок ввода и рендера шаблонов"
if [[ "$DRY_RUN" != "1" ]]; then
  require_root
fi
if [[ -n "$RENDER_DIR" ]]; then
  [[ "$DRY_RUN" == "1" ]] || die "--render-dir работает только вместе с --dry-run"
  mkdir -p "$RENDER_DIR"
fi
[[ "$DRY_RUN" == "1" ]] && print_warning "РЕЖИМ DRY-RUN: система не изменяется"

# ── Ввод ────────────────────────────────────────────────────────────────
ask() { # ask <переменная> <вопрос> [значение по умолчанию]
  local var="$1" q="$2" def="${3:-}" ans=""
  if [[ "$NON_INTERACTIVE" == "1" || ! -t 0 ]]; then return 0; fi
  if [[ -n "$def" ]]; then read -r -p "$q [$def]: " ans || true; ans="${ans:-$def}"; else read -r -p "$q: " ans || true; fi
  printf -v "$var" '%s' "$ans"
}

# Что оператор задал флагами (их в диалоге не переспрашиваем).
FLAG_OPERATOR_NAME="$OPERATOR_NAME" ; FLAG_OPERATOR_EMAIL="$OPERATOR_EMAIL" ; FLAG_OPERATOR_SITE="$OPERATOR_SITE"

# Значения по умолчанию из прошлой установки (повторный запуск).
if [[ -f "$PM_CONF_FILE" ]]; then
  [[ -n "$DOMAIN" ]]         || DOMAIN="$(conf_get DOMAIN)"
  [[ -n "$TLS_MODE" ]]       || TLS_MODE="$(conf_get TLS_MODE)"
  [[ -n "$TURN_HOST" ]]      || TURN_HOST="$(conf_get TURN_HOST)"
  [[ -n "$EMAIL" ]]          || EMAIL="$(conf_get EMAIL)"
  [[ -n "$OPERATOR_NAME" ]]  || OPERATOR_NAME="$(conf_get OPERATOR_NAME)"
  [[ -n "$OPERATOR_EMAIL" ]] || OPERATOR_EMAIL="$(conf_get OPERATOR_EMAIL)"
  [[ -n "$OPERATOR_SITE" ]]  || OPERATOR_SITE="$(conf_get OPERATOR_SITE)"
  [[ -n "$OPERATOR_TERMS_URL" ]]   || OPERATOR_TERMS_URL="$(conf_get OPERATOR_TERMS_URL)"
  [[ -n "$OPERATOR_PRIVACY_URL" ]] || OPERATOR_PRIVACY_URL="$(conf_get OPERATOR_PRIVACY_URL)"
  [[ -n "$API_BASE" ]]       || API_BASE="$(conf_get API_BASE)"
  [[ -n "$CF_ONLY_443" ]]    || CF_ONLY_443="$(conf_get CF_ONLY_443)"
fi
[[ -n "$API_BASE" ]] || API_BASE="$PM_DEFAULT_API_BASE"

if [[ -z "$DOMAIN" ]]; then ask DOMAIN "Домен сервера (например msg.example.com)"; DOMAIN="$(tr '[:upper:]' '[:lower:]' <<<"$DOMAIN")"; fi
if [[ -z "$TLS_MODE" ]]; then
  if [[ "$NON_INTERACTIVE" != "1" && -t 0 ]]; then
    cat <<'MENU'
Режим TLS:
  1) letsencrypt        — Let's Encrypt, домен указывает прямо на этот сервер
  2) cloudflare-dns     — Let's Encrypt через Cloudflare API (DNS-01)
  3) cloudflare-origin  — Cloudflare Origin Certificate + прокси Cloudflare
  4) custom             — свой сертификат (платный, от публичного CA)
MENU
    ask TLS_MODE "Выбор (1-4 или имя)" "1"
    case "$TLS_MODE" in 1) TLS_MODE=letsencrypt ;; 2) TLS_MODE=cloudflare-dns ;; 3) TLS_MODE=cloudflare-origin ;; 4) TLS_MODE=custom ;; esac
  fi
fi
cloudflare_alias
[[ -n "$TLS_MODE" ]] || die "Не задан режим TLS (--tls letsencrypt|cloudflare-dns|cloudflare-origin|custom)"
case "$TLS_MODE" in
  cloudflare-dns)   [[ -n "$CF_TOKEN_FILE" ]] || ask CF_TOKEN_FILE "Файл с Cloudflare API-токеном (Zone:DNS:Edit)" ;;
  cloudflare-origin|custom)
    [[ -n "$CERT_SRC" ]] || ask CERT_SRC "Файл сертификата (PEM, fullchain)"
    [[ -n "$KEY_SRC" ]]  || ask KEY_SRC "Файл закрытого ключа (PEM)" ;;
esac
[[ -n "$EMAIL" ]] || ask EMAIL "Почта для Let's Encrypt и уведомлений об истечении" "${OPERATOR_EMAIL}"
# Данные оператора (operator.json → /terms, /privacy, контакт и «Сайт/Условия/Политика» в приложениях):
# в диалоге спрашиваются всегда, если не заданы флагами; прежние значения и вычисляемые — по умолчанию.
if [[ "$NON_INTERACTIVE" != "1" && -t 0 ]]; then
  print_header "Оператор сервера"
  print_info "Эти данные увидят пользователи на страницах /terms и /privacy и в разделе «О приложении»."
fi
[[ -n "$FLAG_OPERATOR_NAME" ]]  || ask OPERATOR_NAME "Имя оператора сервера" "${OPERATOR_NAME:-$DOMAIN}"
[[ -n "$OPERATOR_NAME" ]] || OPERATOR_NAME="$DOMAIN"
[[ -n "$FLAG_OPERATOR_EMAIL" ]] || ask OPERATOR_EMAIL "Контактная почта оператора (вопросы, удаление данных)" "${OPERATOR_EMAIL:-$EMAIL}"
[[ -n "$OPERATOR_EMAIL" ]] || OPERATOR_EMAIL="$EMAIL"
[[ -n "$EMAIL" ]] || EMAIL="$OPERATOR_EMAIL"
[[ -n "$OPERATOR_EMAIL" ]] || die "Не задана контактная почта оператора (--operator-email или --email)"
[[ -n "$FLAG_OPERATOR_SITE" ]]  || ask OPERATOR_SITE "Сайт оператора" "${OPERATOR_SITE:-https://${DOMAIN}}"
[[ -n "$OPERATOR_SITE" ]] || OPERATOR_SITE="https://${DOMAIN}"
OPERATOR_SITE="${OPERATOR_SITE%/}"
[[ -n "$TURN_HOST" ]] || TURN_HOST="turn.${DOMAIN}"
# ufw 443 только для Cloudflare: для Origin Certificate прямой заход браузеров всё равно не принимается.
if [[ -z "$CF_ONLY_443" ]]; then
  case "$TLS_MODE" in cloudflare-origin) CF_ONLY_443=1 ;; *) CF_ONLY_443=0 ;; esac
fi
if [[ "$CF_ONLY_443" == "1" && "$TLS_MODE" != cloudflare-* ]]; then
  if [[ "$CF_ONLY_EXPLICIT" == "1" ]]; then die "--cf-only-443 имеет смысл только в режимах cloudflare-dns / cloudflare-origin"; fi
  CF_ONLY_443=0
fi

# Ключ сервиса номеров: файл → переменная/флаг → прежний env → скрытый ввод.
if [[ -n "$SERVICE_KEY_FILE" ]]; then
  [[ -r "$SERVICE_KEY_FILE" ]] || die "Не читается файл ключа: $SERVICE_KEY_FILE"
  SERVICE_KEY="$(tr -d '[:space:]' < "$SERVICE_KEY_FILE")"
fi
if [[ -z "$SERVICE_KEY" && -f "$PM_ENV_FILE" ]]; then
  SERVICE_KEY="$(read_env_value NFT_NUMBERS_SERVICE_SECRET "$PM_ENV_FILE")"
fi
if [[ -z "$SERVICE_KEY" && "$NON_INTERACTIVE" != "1" && -t 0 ]]; then
  read -r -s -p "Ключ интеграции сервиса номеров (ввод скрыт): " SERVICE_KEY || true; echo
fi

# ── Валидация (всё, что попадёт в конфиги) ──────────────────────────────
valid_domain "$DOMAIN"            || die "Некорректный домен: '${DOMAIN}' (ожидается msg.example.com)"
valid_domain "$TURN_HOST"         || die "Некорректный TURN-хост: '${TURN_HOST}'"
valid_email "$EMAIL"              || die "Некорректная почта: '${EMAIL}'"
valid_email "$OPERATOR_EMAIL"     || die "Некорректная почта оператора: '${OPERATOR_EMAIL}'"
valid_operator_name "$OPERATOR_NAME" || die "Имя оператора: 1-120 символов, без кавычек, \\, \$, \`, <, >, &, [, ], (, ), *"
valid_https_url "$OPERATOR_SITE"  || die "Адрес сайта оператора должен быть https://… (без пробелов и скобок, до 200 символов): '${OPERATOR_SITE}'"
[[ -z "$OPERATOR_TERMS_URL" ]]   || valid_https_url "$OPERATOR_TERMS_URL"   || die "Некорректный --operator-terms-url: '${OPERATOR_TERMS_URL}'"
[[ -z "$OPERATOR_PRIVACY_URL" ]] || valid_https_url "$OPERATOR_PRIVACY_URL" || die "Некорректный --operator-privacy-url: '${OPERATOR_PRIVACY_URL}'"
valid_https_base "$API_BASE"      || die "Адрес сервиса номеров должен быть https://хост[:порт]: '${API_BASE}'"
[[ -n "$EXTERNAL_IP" ]] && { valid_ipv4 "$EXTERNAL_IP" || die "Некорректный --external-ip"; }
[[ "$SERVICE_KEY" =~ ^[A-Za-z0-9_.:-]{1,200}$ ]] || die "Ключ сервиса номеров не задан или содержит недопустимые символы (--service-key-file / PM_SERVICE_KEY)"
tls_validate_inputs

# Файлы с ключами/токенами внутри каталога пакета: в /opt копируются только файлы релиза, но сами исходники
# остаются на диске в каталоге архива, пока их не удалят.
KEY_SOURCES=()
for f in "$CERT_SRC" "$KEY_SRC" "$SERVICE_KEY_FILE" "$CF_TOKEN_FILE"; do
  [[ -n "$f" && -e "$f" ]] || continue
  KEY_SOURCES+=("$f")
  if path_inside "$f" "$SCRIPT_DIR"; then
    print_warning "Файл с секретом лежит внутри каталога пакета: $f — в /opt он НЕ копируется, но после установки удалите его (shred -u)"
  fi
done

# ── Проверка пакета (целостность и подпись) ─────────────────────────────
# Якорь доверия — allowed_signers УСТАНОВЛЕННОГО пакета ($PM_OPT/selfhost); из распакованного архива
# он берётся только при первой установке (информативно, с отпечатком для ручной сверки).
verify_package() {
  print_header "Проверка пакета установщика"
  local installed_anchor="$PM_OPT/selfhost/allowed_signers" anchor strict=0
  local parent name archive sums sig want have_sum fp
  if [[ "$SCRIPT_DIR" == "$PM_OPT/selfhost" ]]; then
    print_info "Запуск из установленного пакета ($PM_OPT/selfhost) — перепроверка архива не требуется"
    return 0
  fi
  if [[ ! -f "$SCRIPT_DIR/MANIFEST.sha256" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then print_warning "Нет MANIFEST.sha256: это не релизный архив (для реального запуска он обязателен)"; return 0; fi
    die "Нет MANIFEST.sha256: запускайте install.sh только из релизного архива"
  fi
  verify_manifest "$SCRIPT_DIR" "$SCRIPT_DIR/MANIFEST.sha256" || die "Файлы пакета не совпадают с MANIFEST.sha256 — архив повреждён или изменён"
  print_success "MANIFEST.sha256 сходится"

  # Не принимать старый (пусть и подписанный) релиз поверх нового: защита от отката на уязвимую версию.
  local old_v new_v
  old_v="$(head -n1 "$PM_OPT/VERSION" 2>/dev/null || true)"; new_v="$(head -n1 "$SCRIPT_DIR/VERSION")"
  if [[ -n "$old_v" ]] && version_older "$new_v" "$old_v"; then
    if [[ "$FORCE" == "1" ]]; then print_warning "--force: установка версии $new_v поверх более новой $old_v (downgrade)"
    else die "Версия пакета $new_v старее установленной $old_v (откат на старый релиз запрещён; --force для понижения)"; fi
  fi

  anchor="$SCRIPT_DIR/allowed_signers"
  if anchor_has_key "$installed_anchor"; then anchor="$installed_anchor"; strict=1; fi
  parent="$(dirname "$SCRIPT_DIR")"; name="$(basename "$SCRIPT_DIR")"
  archive="$parent/$name.tar.gz"; sums="$parent/SHA256SUMS"; sig="$parent/SHA256SUMS.sig"

  if [[ -n "$SIGNER_FP" ]]; then
    anchor_has_key "$anchor" || die "--signer-fingerprint указан, но в allowed_signers нет ключа для проверки"
    fp="$(anchor_fingerprint "$anchor")"
    [[ "$fp" == "$SIGNER_FP" ]] || die "Отпечаток ключа подписи ($fp) не совпадает с --signer-fingerprint ($SIGNER_FP) — установка отменена"
    print_success "Отпечаток ключа подписи совпал с --signer-fingerprint"
  fi

  if anchor_has_key "$anchor" && [[ -f "$archive" && -f "$sums" && -f "$sig" ]]; then
    verify_sums_signature "$anchor" "$sums" "$sig" || die "Подпись SHA256SUMS НЕ прошла проверку — установка отменена"
    want="$(awk -v f="$name.tar.gz" '{n=$2; sub(/^\*/, "", n)} n == f {print $1; exit}' "$sums")"
    have_sum="$(sha256_of "$archive")"
    [[ -n "$want" && "$want" == "$have_sum" ]] || die "SHA-256 архива не совпал с подписанным SHA256SUMS"
    tar -xzOf "$archive" "$name/MANIFEST.sha256" 2>/dev/null | cmp -s - "$SCRIPT_DIR/MANIFEST.sha256" \
      || die "Каталог пакета не соответствует подписанному архиву ($archive)"
    print_success "Подпись релиза верна, архив и каталог пакета совпадают"
    fp="$(anchor_fingerprint "$anchor")"
    [[ -n "$fp" ]] && print_info "Отпечаток ключа подписи: $fp"
    if [[ "$strict" != "1" && -z "$SIGNER_FP" ]]; then
      print_warning "Первая установка: ключ подписи взят из САМОГО архива — проверена лишь самосогласованность, не подлинность. Сверьте отпечаток выше с опубликованным в README независимо от архива или укажите --signer-fingerprint."
    fi
    return 0
  fi
  if [[ -n "$SIGNER_FP" ]]; then
    die "Указан --signer-fingerprint, но подпись проверить нельзя: рядом с каталогом пакета нет ${name}.tar.gz, SHA256SUMS и SHA256SUMS.sig (в $parent)"
  fi

  if [[ "$strict" == "1" ]]; then
    if [[ "$ALLOW_UNSIGNED" == "1" ]]; then
      UNSIGNED_USED=1
      print_warning "!!! --allow-unsigned: повторная установка из архива БЕЗ проверки подписи релиза. Целостность проверена только по MANIFEST из того же архива, подлинность — НЕ проверена."
      return 0
    fi
    die "Повторная установка из архива требует подписанного релиза: положите рядом с каталогом пакета ${name}.tar.gz, SHA256SUMS и SHA256SUMS.sig (в $parent) — либо запустите с --allow-unsigned (небезопасно)"
  fi
  print_warning "Подпись релиза НЕ проверена (рядом с каталогом пакета нет ${name}.tar.gz / SHA256SUMS / SHA256SUMS.sig), ключ подписи мог бы быть взят только из самого архива. Перед установкой сверьте архив по README или запустите с --signer-fingerprint ${SIGNER_FP:-SHA256:…} и подписью рядом."
  if [[ "$ALLOW_UNSIGNED" == "1" ]]; then UNSIGNED_USED=1; fi
}

# ── Предполётная проверка ───────────────────────────────────────────────
preflight() {
  print_header "Проверка системы"
  local os_id="" os_ver="" py_ok=0 mem_kb=0 py_cmd=""
  pm_os_detect; os_id="$PM_OS_ID"; os_ver="$PM_OS_VER"
  case "${os_id}:${os_ver}" in
    ubuntu:22.04|ubuntu:24.04|ubuntu:26.04) print_success "ОС: Ubuntu ${os_ver} (поддерживается)" ;;
    debian:12)    print_warning "ОС: Debian 12 — не проверялась на хешах lock (Python 3.11); возможны отличия" ;;
    :)            print_warning "ОС не определена (проверка на macOS/без /etc/os-release — только для dry-run)" ;;
    *)            if [[ "$DRY_RUN" == "1" ]]; then print_warning "ОС ${os_id} ${os_ver} не поддерживается (нужна Ubuntu 22.04, 24.04 или 26.04)"; else
                    die "ОС ${os_id} ${os_ver} не поддерживается: нужна Ubuntu 22.04, 24.04 или 26.04 LTS (Debian 12 — best effort)"; fi ;;
  esac
  if py_cmd="$(pm_find_python)"; then py_ok=1; fi
  if [[ "$py_ok" == "1" ]]; then print_success "Python: $("$py_cmd" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"; else
    if [[ "$os_id" == "ubuntu" && "$NO_PYTHON_PPA" != "1" ]]; then print_info "Python < 3.11: на шаге «Пакеты» будет подключён deadsnakes PPA (python3.12)";
    elif [[ "$DRY_RUN" == "1" ]]; then print_warning "Нужен Python >= 3.11"; else die "Нужен Python >= 3.11 (Ubuntu 22.04: python3.12 из deadsnakes; 24.04: python3.12)"; fi; fi
  if [[ -r /proc/meminfo ]]; then
    mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
    (( mem_kb >= 900000 )) || print_warning "Мало памяти ($((mem_kb / 1024)) МБ): рекомендуется ≥ 1 ГБ (relay держит очереди в RAM)"
  fi
  if [[ "$DRY_RUN" != "1" ]]; then
    have systemctl || die "Нужен systemd"
    [[ -d "$SCRIPT_DIR/app" || -d "$PM_OPT/backend" ]] || die "Нет app/ рядом с install.sh — запускайте из релизного архива"
    local p
    for p in 80 443; do
      if port_busy "$p" && ! ss -Hltnp "sport = :$p" 2>/dev/null | grep -q nginx; then
        die "Порт $p занят не nginx — освободите его (установщик рассчитан на выделенный сервер)"
      fi
    done
  fi
  [[ -n "$EXTERNAL_IP" ]] || EXTERNAL_IP="$(detect_external_ip || true)"
  if [[ -n "$EXTERNAL_IP" ]]; then print_success "Внешний IP: $EXTERNAL_IP"; else
    print_warning "Внешний IP не определён (укажите --external-ip)"; fi
}

summary() {
  print_header "План"
  cat <<PLAN
  Домен:            $DOMAIN
  TLS:              $TLS_MODE
  TURN-хост:        $TURN_HOST (только DNS-only)
  Сервис номеров:   $API_BASE
  Оператор:         $OPERATOR_NAME <$OPERATOR_EMAIL>, $OPERATOR_SITE
  Условия/политика: ${OPERATOR_TERMS_URL:-https://${DOMAIN}/terms} , ${OPERATOR_PRIVACY_URL:-https://${DOMAIN}/privacy}
  Код:              $PM_OPT (root:root, только чтение), пользователь $PM_USER
  Конфиг/секреты:   $PM_ETC (env 0640 root:$PM_USER)
  State:            $PM_STATE_DIR
  Порты:            80/tcp, 443/tcp, 3478/tcp+udp, 5349/tcp, 49152-65535/udp
PLAN
  if [[ "$DRY_RUN" != "1" && "$NON_INTERACTIVE" != "1" && -t 0 ]]; then
    local a=""; read -r -p "Продолжить? [y/N]: " a || true
    [[ "$a" =~ ^[YyДд] ]] || die "Отменено"
  fi
}

save_conf() {
  if [[ "$DRY_RUN" == "1" ]]; then plan "сохранить параметры (без секретов) в $PM_CONF_FILE"; return 0; fi
  local tmp; tmp="$(mktemp)"
  {
    echo "# Параметры установки (без секретов). Читается install.sh/status.sh/selftest.sh/update.sh."
    echo "DOMAIN=$DOMAIN"; echo "TLS_MODE=$TLS_MODE"; echo "TURN_HOST=$TURN_HOST"; echo "EMAIL=$EMAIL"
    echo "EXTERNAL_IP=$EXTERNAL_IP"; echo "API_BASE=$API_BASE"; echo "CF_ONLY_443=$CF_ONLY_443"
    echo "OPERATOR_NAME=$OPERATOR_NAME"; echo "OPERATOR_EMAIL=$OPERATOR_EMAIL"; echo "OPERATOR_SITE=$OPERATOR_SITE"
    echo "OPERATOR_TERMS_URL=$OPERATOR_TERMS_URL"; echo "OPERATOR_PRIVACY_URL=$OPERATOR_PRIVACY_URL"
    echo "INSTALLED_AT=$(date -u +%FT%TZ)"
  } > "$tmp"
  install_file "$tmp" "$PM_CONF_FILE" 0644 root:root
  rm -f "$tmp"
  log_release "install ${NEW_VERSION:-$(head -n1 "$SCRIPT_DIR/VERSION" 2>/dev/null)}"
}

cloudflare_checklist() {
  [[ "$TLS_MODE" == cloudflare-* ]] || return 0
  cat <<CHK

Чек-лист Cloudflare (SSL/TLS и DNS), без него вход и звонки работать не будут:
  - запись $DOMAIN — проксируется (оранжевое облако); $TURN_HOST — DNS only (серое облако);
  - SSL/TLS → Overview → режим Full (strict);
  - Network → WebSockets: включено;
  - Rules → Cache Rules: обход кэша (Bypass) для /api/*;
  - TLS 1.3 включён (SSL/TLS → Edge Certificates);
$( if [[ "$CF_ONLY_443" == "1" ]]; then
     echo "  - ufw: 443/tcp открыт только для CIDR Cloudflare (--cf-only-443; нужен включённый ufw, список обновляет pm-cf-update.timer);"
   else
     echo "  - по желанию: --cf-only-443 откроет 443/tcp в ufw только для CIDR Cloudflare;"
   fi )
CHK
}

next_steps() {
  print_header "Готово"
  cat <<DONE
Сервер: https://${DOMAIN}
Проверка:        sudo ${PM_OPT}/selfhost/selftest.sh
Статус:           sudo ${PM_OPT}/selfhost/status.sh
Журнал relay:     journalctl --namespace=phantom -u ${PM_SERVICE} -n 50
Журнал coturn:    journalctl --namespace=phantom -u coturn -n 50   (обычный journalctl -u пуст: журналы только в RAM)
Приложения:       «Настройки → Сервер → Сменить сервер» → https://${DOMAIN}
Секреты лежат в ${PM_ENV_FILE} (0640 root:${PM_USER}) и в терминал не печатаются.
Push-уведомлений на этом сервере нет (ключи FCM/APNs принадлежат владельцу приложения).
DONE
  cloudflare_checklist
  if (( ${#KEY_SOURCES[@]} > 0 )); then
    printf '\nУдалите исходные файлы с секретами (копии установлены в %s, права 0600/0640):\n  shred -u' "$PM_ETC"
    printf ' %q' "${KEY_SOURCES[@]}"; echo
  fi
}

main() {
  preflight
  verify_package
  summary
  tls_check_dns
  if [[ "$DRY_RUN" != "1" && -f "$PM_ENV_FILE" ]]; then
    PREV_ENV="$(mktemp)"; cp -a "$PM_ENV_FILE" "$PREV_ENV"; chmod 0600 "$PREV_ENV"
  fi

  print_header "Пакеты"
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "apt-get update"
  else
    wait_for_apt_locks 600; DEBIAN_FRONTEND=noninteractive apt-get update -qq
  fi
  apt_install ca-certificates curl openssl python3 certbot
  pm_ensure_python
  [[ "$TLS_MODE" == "cloudflare-dns" ]] && apt_install python3-certbot-dns-cloudflare

  relay_create_user
  relay_install_journald
  relay_install_app
  relay_install_venv
  relay_check_service_key
  relay_build_env
  relay_write_operator

  # Let's Encrypt HTTP-01: пока сертификата нет, nginx отдаёт только :80 (ACME); затем полный конфиг с TLS.
  nginx_prepare
  if [[ "$TLS_MODE" == "letsencrypt" && ! -f "${LE_LIVE}/${DOMAIN}/fullchain.pem" ]]; then
    nginx_apply ""
  fi
  tls_issue_site
  nginx_apply https
  coturn_setup
  tls_install_hooks

  relay_commit_env
  relay_install_units
  firewall_setup
  relay_install_cf_updater
  save_conf
  relay_start "$PREV_ENV"
  rm -f "$PREV_ENV"; PREV_ENV=""
  next_steps
  [[ "$DRY_RUN" == "1" ]] && print_warning "DRY-RUN завершён: ничего не изменено"
  return 0
}

main
