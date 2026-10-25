#!/usr/bin/env bash
# Удаление сервера Phantom Messenger.
#   sudo uninstall.sh [--yes] [--purge]
# Без --purge: останавливает и отключает сервисы, убирает конфиги nginx/coturn/unit'ы и код в /opt;
# СОХРАНЯЕТ env, operator.json, state, сертификаты (можно установить заново без потери ключей).
# С --purge: дополнительно удаляет env (секреты!), state (ключи/capabilities пользователей на сервере),
# TLS-файлы, сертификаты certbot этого сервера и системного пользователя. Пакеты apt не удаляются.
# Правила ufw не удаляются — команды печатаются в конце.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

PURGE=0 ; ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "Неизвестный параметр: $a" ;;
  esac
done
require_root

DOMAIN="$(conf_get DOMAIN)"; TURN_HOST="$(conf_get TURN_HOST)"
echo "Будет удалён сервер Phantom Messenger${DOMAIN:+ ($DOMAIN)}."
[[ "$PURGE" == "1" ]] && print_warning "--purge: секреты, state и сертификаты будут УДАЛЕНЫ без возможности восстановления"
if [[ "$ASSUME_YES" != "1" ]]; then
  [[ -t 0 ]] || die "Нет терминала: используйте --yes"
  ans=""
  read -r -p "Продолжить? [y/N]: " ans || true
  [[ "$ans" =~ ^[YyДд] ]] || die "Отменено"
fi
# Скрипт сам лежит в /opt/phantom-messenger/selfhost — запускаем копию из временного каталога
# (он удаляется после завершения), иначе удаление $PM_OPT вырвет файл из-под работающего скрипта.
if [[ "$SCRIPT_DIR" == "$PM_OPT"/* && -z "${PM_UNINSTALL_COPY:-}" ]]; then
  tmpd="$(mktemp -d)"
  cp -a "$SCRIPT_DIR/." "$tmpd/"
  rc=0
  PM_UNINSTALL_COPY=1 "$tmpd/uninstall.sh" --yes "$@" || rc=$?
  rm -rf "$tmpd"
  exit "$rc"
fi
OUR_TURN_CONF=0
grep -q 'Managed by phantom-selfhost' /etc/turnserver.conf 2>/dev/null && OUR_TURN_CONF=1
# Пользователя phantom удаляем только если его создал установщик (отметка при установке).
CREATED_USER=0
[[ -f "$PM_USER_MARKER" ]] && CREATED_USER=1

print_header "Остановка сервисов"
systemctl disable --now pm-healthcheck.timer pm-cf-update.timer >/dev/null 2>&1 || true
systemctl disable --now "$PM_SERVICE" >/dev/null 2>&1 || true
# coturn останавливаем только если его конфиг наш (установщик рассчитан на выделенный сервер).
if [[ "$OUR_TURN_CONF" == "1" ]]; then
  systemctl stop coturn >/dev/null 2>&1 || true
  systemctl disable coturn >/dev/null 2>&1 || true
else
  print_warning "/etc/turnserver.conf не от установщика — coturn не трогаю"
fi
print_success "relay и healthcheck остановлены"

print_header "Конфиги"
rm -f "/etc/systemd/system/${PM_SERVICE}.service" /etc/systemd/system/pm-healthcheck.service /etc/systemd/system/pm-healthcheck.timer \
  /etc/systemd/system/pm-cf-update.service /etc/systemd/system/pm-cf-update.timer /usr/local/sbin/pm-cf-update.sh
rm -rf "/etc/systemd/system/${PM_SERVICE}.service.d" /etc/systemd/system/coturn.service.d/10-hardening.conf
rm -f /etc/systemd/journald@phantom.conf /usr/local/sbin/pm-healthcheck.sh /run/pm-health.status
systemctl daemon-reload
rm -f "$PM_NGINX_CONF" "${PM_NGINX_CONF}".bak.* /etc/letsencrypt/renewal-hooks/deploy/10-phantom-nginx.sh /etc/letsencrypt/renewal-hooks/deploy/10-phantom-coturn.sh
if have nginx && nginx -t >/dev/null 2>&1; then systemctl reload nginx >/dev/null 2>&1 || true; fi
# turnserver.conf удаляем только если это наш файл.
if [[ "$OUR_TURN_CONF" == "1" ]]; then rm -f /etc/turnserver.conf /etc/turnserver.conf.bak.*; fi
# deadsnakes PPA — только если его подключил установщик (метка в файле pinning).
if grep -q "$PM_APT_MARK" "$PM_DEADSNAKES_PREFS" 2>/dev/null; then
  rm -f "$PM_DEADSNAKES_PREFS" "$PM_DEADSNAKES_SOURCES" "$PM_DEADSNAKES_KEYRING"
  print_info "deadsnakes PPA отключён (источник, pinning, keyring); пакеты python3.12 не удалены: apt remove python3.12 python3.12-venv — при необходимости"
fi
rm -rf "$PM_OPT"
print_success "Конфиги и код удалены ($PM_OPT)"

if [[ "$PURGE" == "1" ]]; then
  print_header "Purge"
  for host in "$DOMAIN" "$TURN_HOST"; do
    [[ -n "$host" && -d "/etc/letsencrypt/live/$host" ]] && certbot delete --non-interactive --cert-name "$host" >/dev/null 2>&1 || true
  done
  rm -rf "$PM_ETC" "$PM_STATE_DIR" "${PM_ROOT_PREFIX}/etc/coturn/certs"
  if [[ "$CREATED_USER" == "1" ]] && id -u "$PM_USER" >/dev/null 2>&1; then
    userdel "$PM_USER" >/dev/null 2>&1 || true
    print_success "env, operator.json, state, TLS-файлы, сертификаты certbot и пользователь $PM_USER удалены"
  else
    print_success "env, operator.json, state, TLS-файлы и сертификаты certbot удалены (пользователь $PM_USER существовал до установки — не удалён)"
  fi
else
  print_info "Сохранено: $PM_ETC (env, operator.json, ssl), $PM_STATE_DIR (state), сертификаты Let's Encrypt. Для полного удаления: uninstall.sh --purge"
fi

cat <<'FW'

Правила ufw (если добавлялись установщиком) удалите вручную:
  sudo ufw delete allow 80/tcp; sudo ufw delete allow 443/tcp
  sudo ufw delete allow 3478/tcp; sudo ufw delete allow 3478/udp
  sudo ufw delete allow 5349/tcp; sudo ufw delete allow 49152:65535/udp
  (--cf-only-443) правила 443 с комментарием pm-cf: sudo ufw status numbered | grep pm-cf
Пакеты (nginx, coturn, certbot) не удалялись: sudo apt remove nginx coturn certbot — при необходимости.
FW
