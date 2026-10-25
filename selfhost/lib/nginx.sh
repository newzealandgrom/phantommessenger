# shellcheck shell=bash
# shellcheck disable=SC2154,SC2034
# nginx: :80 (ACME + редирект) и :443 (TLS → relay). Подключается из install.sh.

nginx_listen6() {
  # IPv6-слушатель только если в системе есть IPv6-интерфейсы (иначе bind() падает).
  if [[ -s /proc/net/if_inet6 ]]; then echo "listen [::]:$1;"; fi
}

# OCSP stapling — только там, где в сертификате сайта есть цепочка (letsencrypt, custom с fullchain);
# для Origin Certificate Cloudflare и режима cloudflare-dns клиентам сертификат показывает edge Cloudflare.
# Одной строкой (render_template не принимает переводы строк). Нужны DNS-резолверы из /etc/resolv.conf.
nginx_stapling_line() {
  local ns="" addr resolv="${PM_RESOLV_CONF:-/etc/resolv.conf}"
  case "$TLS_MODE" in letsencrypt|custom) ;; *) echo "# ssl_stapling не используется в режиме $TLS_MODE"; return 0 ;; esac
  if [[ -r "$resolv" ]]; then
    # IPv4 — как есть; IPv6 — в квадратных скобках; link-local с зоной (%) пропускаем; не более двух.
    while IFS= read -r addr; do
      case "$addr" in
        *%*) continue ;;
        *:*) ns="${ns}[${addr}] " ;;
        *)   ns="${ns}${addr} " ;;
      esac
      [[ "$(wc -w <<<"$ns")" -ge 2 ]] && break
    done < <(awk '$1 == "nameserver" && $2 ~ /^[0-9a-fA-F:.%a-zA-Z0-9]+$/ {print $2}' "$resolv")
  fi
  # Без резолвера stapling не включаем (nginx не сможет получить OCSP-ответ).
  if [[ -z "$ns" ]]; then echo "# ssl_stapling не включён: нет подходящих DNS-резолверов в /etc/resolv.conf"; return 0; fi
  echo "ssl_stapling on; ssl_stapling_verify on; ssl_trusted_certificate ${SSL_CERT}; resolver ${ns}valid=300s; resolver_timeout 5s;"
}

# nginx_compose <файл> [https] — склеивает http-часть (+ turn-блок) и, при необходимости, https-часть.
nginx_compose() {
  local out="$1" with_https="${2:-}" t="$SCRIPT_DIR/templates" part
  local l80 l443
  l80="$(nginx_listen6 80)"; l443="$(nginx_listen6 443)"
  : > "$out"
  part="$(mktemp)"
  render_template "$t/nginx-http.conf.tmpl" "$part" "DOMAIN=$DOMAIN" "ACME_ROOT=$PM_ACME_ROOT" "LISTEN6_80=$l80"
  cat "$part" >> "$out"
  if [[ "$TURN_HOST" != "$DOMAIN" ]]; then
    render_template "$t/nginx-http-turn.conf.tmpl" "$part" "TURN_HOST=$TURN_HOST" "ACME_ROOT=$PM_ACME_ROOT" "LISTEN6_80=$l80"
    cat "$part" >> "$out"
  fi
  if [[ -n "$with_https" ]]; then
    local cf_line="# CF-Connecting-IP от Cloudflare передаётся как есть (CLIENT_IP_HEADER в env)"
    if [[ "$TLS_MODE" != cloudflare-* ]]; then
      cf_line='proxy_set_header CF-Connecting-IP "";'
    fi
    render_template "$t/nginx-https.conf.tmpl" "$part" "DOMAIN=$DOMAIN" "SSL_CERT=$SSL_CERT" "SSL_KEY=$SSL_KEY" \
      "TLS_MODE=$TLS_MODE" "LISTEN6_443=$l443" "STAPLING_LINE=$(nginx_stapling_line)" "CF_HEADER_LINE=$cf_line"
    cat "$part" >> "$out"
  fi
  rm -f "$part"
}

nginx_prepare() {
  print_header "nginx"
  apt_install nginx
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "mkdir -p $PM_ACME_ROOT; убрать стандартный сайт nginx (sites-enabled/default), если это штатная ссылка"
    return 0
  fi
  install -d -m 0755 "$PM_ACME_ROOT"
  # Штатный сайт Ubuntu слушает :80 default_server и отдаёт «Welcome to nginx» по IP.
  if [[ -L /etc/nginx/sites-enabled/default && "$(readlink /etc/nginx/sites-enabled/default)" == "/etc/nginx/sites-available/default" ]]; then
    rm -f /etc/nginx/sites-enabled/default
    print_info "Убрана штатная ссылка sites-enabled/default (файл sites-available/default сохранён)"
  fi
  systemctl enable nginx >/dev/null 2>&1 || true
}

# nginx_apply <https|""> — записать конфиг, проверить и перечитать; при ошибке вернуть прежний.
nginx_apply() {
  local mode="${1:-}" tmp prev=""
  tmp="$(mktemp)"
  nginx_compose "$tmp" "$mode"
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "nginx.conf (${mode:-только :80}) → $PM_NGINX_CONF; nginx -t && systemctl reload nginx"
    if [[ -n "${RENDER_DIR:-}" ]]; then
      cp "$tmp" "${RENDER_DIR}/phantom-messenger.nginx.conf"
    fi
    rm -f "$tmp"
    return 0
  fi
  if [[ -f "$PM_NGINX_CONF" ]]; then
    prev="$(mktemp)"; cp -a "$PM_NGINX_CONF" "$prev"
  fi
  install_file "$tmp" "$PM_NGINX_CONF" 0644 root:root
  rm -f "$tmp"
  if ! nginx -t >/dev/null 2>&1; then
    nginx -t >&2 || true
    if [[ -n "$prev" ]]; then cp -a "$prev" "$PM_NGINX_CONF"; else rm -f "$PM_NGINX_CONF"; fi
    [[ -n "$prev" ]] && rm -f "$prev"
    die "nginx -t не прошёл — конфиг отменён"
  fi
  [[ -n "$prev" ]] && rm -f "$prev"
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  print_success "nginx: конфиг применён (${mode:-только :80})"
}
