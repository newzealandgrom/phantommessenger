# shellcheck shell=bash
# shellcheck disable=SC2154,SC2034
# TLS: 4 режима сертификата сайта. Подключается из install.sh.
#   letsencrypt        — Let's Encrypt HTTP-01 (webroot через nginx :80)
#   cloudflare-dns     — Let's Encrypt DNS-01 через Cloudflare API-токен (домен может быть за оранжевым облаком)
#   cloudflare-origin  — Cloudflare Origin Certificate + оранжевое облако (PEM из дашборда Cloudflare)
#   custom             — свой PEM (платный сертификат публичного CA)

LE_LIVE="/etc/letsencrypt/live"
CF_INI="${PM_ETC}/cloudflare.ini"

# 0 — имя покрыто сертификатом, 1 — нет, 2 — openssl не умеет -checkhost.
cert_matches_host() {
  local cert="$1" host="$2" out
  out="$(openssl x509 -in "$cert" -noout -checkhost "$host" 2>&1)" || true
  case "$out" in
    *"does match certificate"*) return 0 ;;
    *"does NOT match"*) return 1 ;;
    *) return 2 ;;
  esac
}

# Публичный ключ сертификата и закрытого ключа должны совпадать.
cert_key_pair_ok() {
  local a b
  a="$(openssl x509 -in "$1" -noout -pubkey 2>/dev/null | openssl sha256 2>/dev/null)" || return 1
  b="$(openssl pkey -in "$2" -pubout 2>/dev/null | openssl sha256 2>/dev/null)" || return 1
  [[ -n "$a" && "$a" == "$b" ]]
}

tls_validate_inputs() {
  case "$TLS_MODE" in
    letsencrypt) ;;
    cloudflare-dns)
      [[ -n "$CF_TOKEN_FILE" && -r "$CF_TOKEN_FILE" ]] || die "--tls cloudflare-dns: нужен --cf-api-token-file <файл с токеном Zone:DNS:Edit>"
      local tok; tok="$(tr -d '[:space:]' < "$CF_TOKEN_FILE")"
      [[ "$tok" =~ ^[A-Za-z0-9_-]{20,100}$ ]] || die "Токен Cloudflare в $CF_TOKEN_FILE выглядит неверно (ожидается API-токен, не Global API Key)"
      ;;
    cloudflare-origin|custom)
      [[ -n "$CERT_SRC" && -r "$CERT_SRC" ]] || die "--tls $TLS_MODE: нужен --origin-cert <fullchain.pem>"
      [[ -n "$KEY_SRC" && -r "$KEY_SRC" ]] || die "--tls $TLS_MODE: нужен --origin-key <privkey.pem>"
      openssl x509 -in "$CERT_SRC" -noout >/dev/null 2>&1 || die "$CERT_SRC — не PEM-сертификат"
      cert_key_pair_ok "$CERT_SRC" "$KEY_SRC" || die "Закрытый ключ не соответствует сертификату"
      openssl x509 -in "$CERT_SRC" -noout -checkend 86400 >/dev/null 2>&1 || die "Сертификат $CERT_SRC истёк или истекает в ближайшие сутки"
      cert_matches_host "$CERT_SRC" "$DOMAIN" && rc=0 || rc=$?
      case "$rc" in
        1) die "Сертификат не покрывает $DOMAIN" ;;
        2) print_warning "openssl не поддерживает -checkhost — соответствие имени не проверено" ;;
      esac
      if [[ "$TLS_MODE" == "custom" ]]; then
        openssl verify -untrusted "$CERT_SRC" "$CERT_SRC" >/dev/null 2>&1 || \
          print_warning "Цепочка сертификата не проверяется системными CA (нужен fullchain от публичного CA — приложения не примут иное)"
      fi
      ;;
    *) die "Неизвестный режим TLS: $TLS_MODE (letsencrypt | cloudflare-dns | cloudflare-origin | custom)" ;;
  esac
  if [[ "$TLS_MODE" == cloudflare-* && "$TURN_HOST" == "$DOMAIN" ]]; then
    die "TURN-хост не может совпадать с доменом сайта за Cloudflare: Cloudflare не проксирует UDP/TURN. Задайте --turn-host turn.${DOMAIN} (DNS only)."
  fi
}

# DNS: A-запись домена и turn-хоста.
tls_check_dns() {
  print_header "DNS"
  local a
  a="$(resolve_a "$DOMAIN")"
  case "$TLS_MODE" in
    letsencrypt|custom)
      if [[ -z "$a" && "$TLS_MODE" == "letsencrypt" && "$DRY_RUN" != "1" ]]; then
        die "$DOMAIN не резолвится: создайте A-запись $DOMAIN → ${EXTERNAL_IP:-IP сервера} (DNS only) и повторите"
      elif [[ -z "$a" ]]; then
        print_warning "$DOMAIN не резолвится — выпуск сертификата и работа клиентов невозможны до появления A-записи"
      elif [[ -n "$EXTERNAL_IP" && "$a" != "$EXTERNAL_IP" ]]; then
        if [[ "$TLS_MODE" == "letsencrypt" ]]; then
          die "$DOMAIN → $a, а внешний IP сервера $EXTERNAL_IP: HTTP-01 не пройдёт. Исправьте A-запись (DNS only) или укажите --external-ip."
        fi
        print_warning "$DOMAIN → $a, внешний IP сервера $EXTERNAL_IP"
      else
        print_success "$DOMAIN → $a"
      fi
      ;;
    *) print_info "$DOMAIN → ${a:-нет A-записи} (режим $TLS_MODE: домен может быть проксирован Cloudflare)" ;;
  esac
  tls_check_turn_dns
}

# Имя для звонков (STUN/TURN) при TURN_HOST_AUTO=1 (не задано флагом --turn-host). За Cloudflare - всегда turn.<домен>
# (выставляется в install.sh до проверок). Без Cloudflare: turn.<домен>, если указывает на сервер (отдельный сертификат,
# turns:), иначе имя сайта, если указывает оно (хватает одной A-записи, turns: выключен); иначе имя не меняется.
tls_choose_turn_host() {
  [[ "${TURN_HOST_AUTO:-0}" == "1" && -n "$EXTERNAL_IP" ]] || return 0
  [[ "$TLS_MODE" != cloudflare-* ]] || return 0
  local h
  for h in "turn.${DOMAIN}" "$DOMAIN"; do
    if [[ "$(resolve_a "$h")" == "$EXTERNAL_IP" ]]; then
      if [[ "$h" == "$DOMAIN" && "$TURN_HOST" != "$DOMAIN" ]]; then
        print_info "Звонки (STUN/TURN) пойдут через $DOMAIN: он указывает прямо на сервер, отдельная запись turn.${DOMAIN} не нужна"
      fi
      TURN_HOST="$h"
      return 0
    fi
  done
}

# Запись имени для звонков указывает на сервер (без внешнего IP - хотя бы резолвится).
turn_dns_ok() {
  local t
  t="$(resolve_a "$TURN_HOST")"
  [[ -n "$t" && ( -z "$EXTERNAL_IP" || "$t" == "$EXTERNAL_IP" ) ]]
}

# Без записи имени для звонков звонки не соединяются. В диалоге установщик ждёт, пока оператор её создаст
# (Enter - проверить снова, n - продолжить без звонков); без диалога - предупреждение и напоминание в итоге (TURN_DNS_OK=0).
tls_check_turn_dns() {
  local t ans
  while :; do
    tls_choose_turn_host
    t="$(resolve_a "$TURN_HOST")"
    if turn_dns_ok; then TURN_DNS_OK=1; print_success "$TURN_HOST → $t (звонки)"; return 0; fi
    TURN_DNS_OK=0
    if [[ -z "$t" ]]; then
      print_warning "$TURN_HOST не резолвится: создайте A-запись $TURN_HOST → ${EXTERNAL_IP:-IP сервера} (в Cloudflare — DNS only, серое облако). Без неё звонки не соединяются"
    else
      print_warning "$TURN_HOST → $t, а внешний IP сервера $EXTERNAL_IP: звонки не соединятся. Запись должна указывать прямо на сервер (в Cloudflare — DNS only, серое облако)"
    fi
    [[ "$DRY_RUN" != "1" && "$NON_INTERACTIVE" != "1" && -t 0 ]] || return 0
    read -r -p "Создайте запись и нажмите Enter — проверю снова (новая запись появляется не сразу); n — продолжить без звонков: " ans || return 0
    ! answer_no "$ans" || return 0
    if have resolvectl; then resolvectl flush-caches >/dev/null 2>&1 || true; fi
  done
}

certbot_email_args() {
  if [[ -n "$EMAIL" ]]; then printf '%s\n' --email "$EMAIL"; else printf '%s\n' --register-unsafely-without-email; fi
}

# tls_le_issue <хост> <webroot|dns>
tls_le_issue() {
  local host="$1" method="$2" args=() line
  if [[ -f "${LE_LIVE}/${host}/fullchain.pem" ]]; then
    print_info "Сертификат Let's Encrypt для $host уже есть — выпуск пропущен"
    return 0
  fi
  while IFS= read -r line; do args+=("$line"); done < <(certbot_email_args)
  args+=(--non-interactive --agree-tos --key-type ecdsa -d "$host")
  [[ "${LE_STAGING:-0}" == "1" ]] && args+=(--staging)
  case "$method" in
    webroot) args=(certonly --webroot -w "$PM_ACME_ROOT" "${args[@]}") ;;
    dns)     args=(certonly --dns-cloudflare --dns-cloudflare-credentials "$CF_INI" --dns-cloudflare-propagation-seconds 30 "${args[@]}") ;;
    *) die "tls_le_issue: метод $method" ;;
  esac
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "certbot ${args[*]}"
    return 0
  fi
  certbot "${args[@]}"
}

# Токен Cloudflare → /etc/phantom-messenger/cloudflare.ini (0600), из файла, не из argv.
tls_write_cf_credentials() {
  [[ "$TLS_MODE" == "cloudflare-dns" ]] || return 0
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "dns_cloudflare_api_token (из $CF_TOKEN_FILE) → $CF_INI (0600)"
    return 0
  fi
  local tmp; tmp="$(mktemp)"
  chmod 0600 "$tmp"
  printf 'dns_cloudflare_api_token = %s\n' "$(tr -d '[:space:]' < "$CF_TOKEN_FILE")" > "$tmp"
  install -m 0600 -o root -g root "$tmp" "$CF_INI"
  rm -f "$tmp"
}

# Сертификат сайта: выставляет SSL_CERT / SSL_KEY.
tls_issue_site() {
  print_header "TLS-сертификат сайта ($TLS_MODE)"
  case "$TLS_MODE" in
    letsencrypt)
      tls_le_issue "$DOMAIN" webroot
      SSL_CERT="${LE_LIVE}/${DOMAIN}/fullchain.pem"; SSL_KEY="${LE_LIVE}/${DOMAIN}/privkey.pem"
      ;;
    cloudflare-dns)
      tls_write_cf_credentials
      tls_le_issue "$DOMAIN" dns
      SSL_CERT="${LE_LIVE}/${DOMAIN}/fullchain.pem"; SSL_KEY="${LE_LIVE}/${DOMAIN}/privkey.pem"
      ;;
    cloudflare-origin|custom)
      SSL_CERT="${PM_SSL_DIR}/origin.pem"; SSL_KEY="${PM_SSL_DIR}/origin.key"
      if [[ "$DRY_RUN" == "1" ]]; then
        plan "install -m 0600 $CERT_SRC → $SSL_CERT; $KEY_SRC → $SSL_KEY"
      else
        install -m 0600 -o root -g root "$CERT_SRC" "$SSL_CERT"
        install -m 0600 -o root -g root "$KEY_SRC" "$SSL_KEY"
        print_success "Сертификат и ключ установлены в $PM_SSL_DIR (0600)"
      fi
      ;;
  esac
}

# Хуки обновления certbot: nginx reload (+ coturn, см. coturn.sh).
tls_install_hooks() {
  [[ "$TLS_MODE" == "letsencrypt" || "$TLS_MODE" == "cloudflare-dns" || "${TURN_CERT_MODE:-}" == "le" ]] || return 0
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "certbot deploy-hook: /etc/letsencrypt/renewal-hooks/deploy/10-phantom-nginx.sh (reload nginx)"
    return 0
  fi
  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  install -m 0755 -o root -g root "$SCRIPT_DIR/templates/certbot-hook-nginx.sh" /etc/letsencrypt/renewal-hooks/deploy/10-phantom-nginx.sh
  systemctl enable --now certbot.timer >/dev/null 2>&1 || true
}
