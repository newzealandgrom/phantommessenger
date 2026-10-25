# shellcheck shell=bash
# shellcheck disable=SC2154,SC2034
# coturn: TURN/STUN с эфемерными кредами. Подключается из install.sh.
# Намеренно НЕ делаем (уроки прода): bps-capacity, denied-peer-ip на собственный IP, user-quota < 60.

TURN_CERT_DIR="/etc/coturn/certs"
TURN_CERT_MODE=""   # le | site | "" (turns: выключен)

turn_local_ip() {
  have ip || return 0
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}'
}

# Сертификат для turns:5349 — публично доверенный, на имя TURN_HOST.
turn_setup_cert() {
  TURN_CERT_MODE=""
  # custom: если пользовательский PEM покрывает turn-хост — используем его.
  if [[ "$TLS_MODE" == "custom" ]]; then
    cert_matches_host "$CERT_SRC" "$TURN_HOST" && rc=0 || rc=$?
    if [[ "$rc" == "0" ]]; then
      TURN_CERT_MODE="site"
      if [[ "$DRY_RUN" == "1" ]]; then
        plan "PEM оператора покрывает $TURN_HOST → копия в $TURN_CERT_DIR (root:turnserver 0640)"
      else
        install -d -m 0750 -o root -g turnserver "$TURN_CERT_DIR"
        install -m 0640 -o root -g turnserver "$SSL_CERT" "${TURN_CERT_DIR}/fullchain.pem"
        install -m 0640 -o root -g turnserver "$SSL_KEY" "${TURN_CERT_DIR}/privkey.pem"
        print_warning "turns: использует ваш PEM — после его замены перезапустите install.sh (копия в $TURN_CERT_DIR)"
      fi
      return 0
    fi
  fi
  # LE: DNS-01 при cloudflare-dns, иначе HTTP-01 (turn-хост DNS-only, :80 открыт).
  local method=webroot a
  [[ "$TLS_MODE" == "cloudflare-dns" ]] && method=dns
  if [[ "$method" == "webroot" ]]; then
    a="$(resolve_a "$TURN_HOST")"
    if [[ "$DRY_RUN" != "1" && ( -z "$a" || ( -n "$EXTERNAL_IP" && "$a" != "$EXTERNAL_IP" ) ) && ! -f "${LE_LIVE}/${TURN_HOST}/fullchain.pem" ]]; then
      print_warning "$TURN_HOST → ${a:-нет записи}, ожидается $EXTERNAL_IP: сертификат для turns: не выпускаю (turn: на 3478 работает)"
      return 0
    fi
  fi
  if ! ( tls_le_issue "$TURN_HOST" "$method" ); then
    print_warning "Сертификат Let's Encrypt для $TURN_HOST не выпущен — turns:5349 отключён, остаётся turn: на 3478"
    return 0
  fi
  TURN_CERT_MODE="le"
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "deploy-hook certbot 10-phantom-coturn.sh: копия сертификата $TURN_HOST → $TURN_CERT_DIR и restart coturn"
    return 0
  fi
  local tmp; tmp="$(mktemp)"
  render_template "$SCRIPT_DIR/templates/certbot-hook-coturn.sh.tmpl" "$tmp" "TURN_HOST=$TURN_HOST"
  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  install -m 0755 -o root -g root "$tmp" /etc/letsencrypt/renewal-hooks/deploy/10-phantom-coturn.sh
  rm -f "$tmp"
  # Первая копия сертификата (coturn ещё не запущен — restart хука безвреден).
  RENEWED_LINEAGE="${LE_LIVE}/${TURN_HOST}" /etc/letsencrypt/renewal-hooks/deploy/10-phantom-coturn.sh || true
}

coturn_setup() {
  print_header "TURN (coturn)"
  apt_install coturn
  local secret ext_line="" tls_block="" local_ip
  secret="$(read_env_value TURN_STATIC_AUTH_SECRET "$ENV_WORK")"
  [[ -n "$secret" ]] || die "Нет TURN_STATIC_AUTH_SECRET (сначала relay_build_env)"
  turn_setup_cert

  if [[ -n "$EXTERNAL_IP" ]]; then
    local_ip="$(turn_local_ip)"
    if [[ -n "$local_ip" && "$local_ip" != "$EXTERNAL_IP" ]]; then
      ext_line="external-ip=${EXTERNAL_IP}/${local_ip}"
    else
      ext_line="external-ip=${EXTERNAL_IP}"
    fi
  else
    print_warning "Внешний IP не определён — external-ip в coturn не задан (за NAT укажите --external-ip)"
  fi
  if [[ -n "$TURN_CERT_MODE" ]]; then
    tls_block="cert=${TURN_CERT_DIR}/fullchain.pem
pkey=${TURN_CERT_DIR}/privkey.pem
no-tlsv1
no-tlsv1_1
cipher-list=ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"
    relay_set_turn_urls 1
  else
    tls_block="# turns: выключен — нет публично доверенного сертификата на ${TURN_HOST}"
    relay_set_turn_urls 0
  fi

  # Секрет в turnserver.conf: файл 0640 root:turnserver; в argv не попадает.
  local conf; conf="$(mktemp)"
  render_template "$SCRIPT_DIR/templates/turnserver.conf.tmpl" "$conf" \
    "TURN_HOST=$TURN_HOST" "TURN_SECRET=$secret" "EXTERNAL_IP_LINE=$ext_line"
  printf '%s\n' "$tls_block" >> "$conf"
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "turnserver.conf (user-quota=60, total-quota=1200, max-bps=1000000, без bps-capacity, без denied-peer-ip на свой IP) → /etc/turnserver.conf"
    [[ -n "${RENDER_DIR:-}" ]] && sed -E 's/^(static-auth-secret)=.*/\1=***/' "$conf" > "${RENDER_DIR}/turnserver.conf"
    copy_install "$SCRIPT_DIR/templates/coturn-10-hardening.conf" /etc/systemd/system/coturn.service.d/10-hardening.conf 0644 root:root
    plan "enable+restart coturn"
    rm -f "$conf"
    return 0
  fi
  install_file "$conf" /etc/turnserver.conf 0640 root:turnserver
  rm -f "$conf"
  copy_install "$SCRIPT_DIR/templates/coturn-10-hardening.conf" /etc/systemd/system/coturn.service.d/10-hardening.conf 0644 root:root
  [[ -f /etc/default/coturn ]] && sed -i.bak 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn && rm -f /etc/default/coturn.bak
  systemctl daemon-reload
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn || true
  sleep 2
  if systemctl is-active --quiet coturn; then
    print_success "coturn запущен (realm=$TURN_HOST, эфемерные креды, песочница)"
  else
    print_error "coturn не запустился — journalctl -u coturn -n 50"
  fi
}

# Файрвол: правила только добавляются; включение — по --enable-ufw.
# CF_ONLY_443=1 (режимы cloudflare-*): 443/tcp открывается не всем, а только CIDR Cloudflare —
# правила создаёт и поддерживает pm-cf-update.sh (relay_install_cf_updater). Порты TURN не ограничиваются.
firewall_setup() {
  print_header "Файрвол"
  local rules=("80/tcp" "443/tcp" "3478/tcp" "3478/udp" "5349/tcp" "49152:65535/udp")
  if [[ "$CF_ONLY_443" == "1" ]]; then
    rules=("80/tcp" "3478/tcp" "3478/udp" "5349/tcp" "49152:65535/udp")
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "ufw allow ${rules[*]} (и порт SSH)"
    [[ "$CF_ONLY_443" == "1" ]] && plan "443/tcp: общее правило удаляется, остаются только правила from <CIDR Cloudflare> (pm-cf-update.sh)"
    [[ "$ENABLE_UFW" == "1" ]] && plan "ufw --force enable (по --enable-ufw)"
    return 0
  fi
  if ! have ufw; then
    if [[ "$ENABLE_UFW" == "1" || "$CF_ONLY_443" == "1" ]]; then apt_install ufw; else
      print_info "ufw не установлен. Откройте порты на своём файрволе/в панели VPS: ${rules[*]}"; return 0
    fi
  fi
  local ssh_port r
  ssh_port="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')"
  ssh_port="${ssh_port:-22}"
  ufw allow "${ssh_port}/tcp" >/dev/null
  for r in "${rules[@]}"; do ufw allow "$r" >/dev/null; done
  if [[ "$CF_ONLY_443" == "1" ]]; then
    ufw --force delete allow 443/tcp >/dev/null 2>&1 || true
    ufw --force delete allow 443 >/dev/null 2>&1 || true
  fi
  print_success "ufw: добавлены правила ${rules[*]} (+ ${ssh_port}/tcp)"
  if [[ "$ENABLE_UFW" == "1" ]]; then
    ufw --force enable >/dev/null
    print_success "ufw включён"
  elif ufw status 2>/dev/null | grep -q inactive; then
    print_info "ufw выключен; правила сохранены. Включить: sudo ufw enable (убедитесь, что SSH-порт $ssh_port разрешён)"
    [[ "$CF_ONLY_443" == "1" ]] && print_warning "Ограничение 443 до Cloudflare НЕ действует, пока ufw выключен"
  fi
}
