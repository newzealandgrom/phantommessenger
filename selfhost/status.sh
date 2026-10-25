#!/usr/bin/env bash
# Состояние установленного сервера Phantom Messenger: сервисы, health, сертификаты, порты, диск.
# Запуск: sudo /opt/phantom-messenger/selfhost/status.sh   (код выхода 1 при проблемах)
# A && B || C здесь безопасно: ok/pass/fail/warn всегда возвращают 0.
# shellcheck disable=SC2015
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

FAILS=0
ok()   { print_success "$*"; }
bad()  { print_error "$*"; FAILS=$((FAILS + 1)); }

DOMAIN="$(conf_get DOMAIN)"
TURN_HOST="$(conf_get TURN_HOST)"
print_header "Phantom Messenger — статус"
[[ -f "$PM_OPT/VERSION" ]] && print_info "Версия: $(head -n1 "$PM_OPT/VERSION")  домен: ${DOMAIN:-?}  TLS: $(conf_get TLS_MODE)"

print_info "Журналы только в RAM: journalctl --namespace=phantom -u $PM_SERVICE  |  journalctl --namespace=phantom -u coturn"
[[ "$(conf_get CF_ONLY_443)" == "1" ]] && print_info "ufw: 443/tcp открыт только для CIDR Cloudflare (pm-cf-update.timer)"
if [[ -r "$PM_ETC/releases.log" ]] && grep -v ROLLBACK "$PM_ETC/releases.log" | tail -n1 | grep -q ' UNSIGNED$'; then
  print_warning "Последняя установка/обновление выполнены с --allow-unsigned (подпись релиза не проверялась): $(grep -v ROLLBACK "$PM_ETC/releases.log" | tail -n1 | cut -c1-20)"
fi
for u in "$PM_SERVICE" nginx coturn; do
  if systemctl is-active --quiet "$u"; then ok "$u: active"; else bad "$u: не активен"; fi
done
for t in pm-healthcheck.timer certbot.timer pm-cf-update.timer; do
  if systemctl is-active --quiet "$t"; then ok "$t: active"
  elif [[ "$t" == pm-cf-update.timer && "$(conf_get TLS_MODE)" != cloudflare-* ]]; then :
  else print_warning "$t: не активен"; fi
done

if curl -fsS -m 5 "$PM_LOCAL_URL/api/health" 2>/dev/null | grep -q '"ok":true'; then ok "relay /api/health (127.0.0.1:8444)"; else bad "relay /api/health не отвечает"; fi
if curl -fsS -m 8 "$PM_LOCAL_URL/api/config" 2>/dev/null | grep -q '"ok":true'; then ok "relay /api/config"; else bad "relay /api/config: ok != true (проверьте env: journalctl --namespace=phantom -u $PM_SERVICE; coturn: -u coturn)"; fi
if [[ -n "$DOMAIN" ]]; then
  if curl -fsS -m 10 "https://${DOMAIN}/api/health" 2>/dev/null | grep -q '"ok":true'; then ok "публично: https://${DOMAIN}/api/health"; else bad "публично https://${DOMAIN}/api/health не отвечает"; fi
fi

cert_info() { # cert_info <путь> <метка>
  local f="$1" end days
  [[ -r "$f" ]] || { print_warning "$2: файл $f не найден"; return; }
  end="$(openssl x509 -in "$f" -noout -enddate 2>/dev/null | cut -d= -f2-)"
  days=$(( ($(date -d "$end" +%s 2>/dev/null || echo 0) - $(date +%s)) / 86400 ))
  if (( days < 0 )); then bad "$2: истёк ($end)"; elif (( days < 21 )); then print_warning "$2: истекает через ${days} дн. ($end)"; else ok "$2: ${days} дн. до истечения"; fi
}
site_cert="$(awk '$1 == "ssl_certificate" {gsub(";", "", $2); print $2; exit}' "$PM_NGINX_CONF" 2>/dev/null)"
[[ -n "$site_cert" ]] && cert_info "$site_cert" "сертификат сайта"
cert_info /etc/coturn/certs/fullchain.pem "сертификат turns:" 

if ss -Hlun 'sport = :3478' 2>/dev/null | grep -q .; then ok "coturn слушает 3478/udp"; else bad "coturn: 3478/udp не слушает"; fi
if ss -Hltn 'sport = :5349' 2>/dev/null | grep -q .; then ok "coturn слушает 5349/tcp (turns)"; else print_warning "coturn: 5349/tcp не слушает (turns отключён)"; fi
for p in 80 443; do
  if ss -Hltn "sport = :$p" 2>/dev/null | grep -q .; then ok "порт $p слушается"; else bad "порт $p не слушается"; fi
done
[[ -r /run/pm-health.status ]] && print_info "healthcheck: $(cat /run/pm-health.status)"
print_info "Диск /: $(df -h / | awk 'NR==2 {print $5 " занято, свободно " $4}'); память: $(free -m 2>/dev/null | awk '/Mem:/ {print $7 " МБ доступно из " $2}')"
[[ -n "$TURN_HOST" ]] && print_info "TURN-хост: $TURN_HOST"

if (( FAILS > 0 )); then print_error "Проблем: $FAILS"; exit 1; fi
print_success "Всё в порядке"
