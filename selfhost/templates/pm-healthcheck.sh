#!/bin/bash
# Мониторинг relay/nginx/coturn (ставится в /usr/local/sbin; запускается pm-healthcheck.timer раз в 5 минут).
# Проверяет: /api/health и /api/config на 127.0.0.1:8444, активность сервисов, coturn :3478/udp,
# срок сертификатов (< 21 дня — тревога), свободное место на / (< 10 % — тревога).
# Результат — строка в журнале юнита и /run/pm-health.status. Тревога: код выхода 1 и, если в
# /etc/phantom-messenger/healthcheck.env задан ALERT_WEBHOOK, POST {"text": "..."}.
set -uo pipefail

BASE="${PM_LOCAL_BASE_URL:-http://127.0.0.1:8444}"
STATUS_FILE=/run/pm-health.status
ALERT_WEBHOOK=""
# shellcheck disable=SC1091
[[ -r /etc/phantom-messenger/healthcheck.env ]] && . /etc/phantom-messenger/healthcheck.env

fails=()
has() { local body; body="$(curl -fsS -m 5 "$BASE$1" 2>/dev/null)" || return 1; grep -qF -- "$2" <<<"$body"; }

has /api/health '"ok":true' || fails+=("relay /api/health")
has /api/config '"ok":true' || fails+=("relay /api/config")
for u in phantom-messenger nginx coturn; do
  systemctl is-active --quiet "$u" || fails+=("$u inactive")
done
ss -Hlun 'sport = :3478' 2>/dev/null | grep -q . || fails+=("coturn :3478/udp not listening")

cert_days() {
  local end; end="$(openssl x509 -in "$1" -noout -enddate 2>/dev/null | cut -d= -f2-)" || return 1
  [[ -n "$end" ]] || return 1
  echo $(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
}
site_cert="$(awk '$1 == "ssl_certificate" {gsub(";", "", $2); print $2; exit}' /etc/nginx/conf.d/phantom-messenger.conf 2>/dev/null)"
for c in "$site_cert" /etc/coturn/certs/fullchain.pem; do
  [[ -n "$c" && -r "$c" ]] || continue
  d="$(cert_days "$c")" || { fails+=("cert $c unreadable"); continue; }
  (( d < 21 )) && fails+=("cert $(basename "$(dirname "$c")")/$(basename "$c") expires in ${d}d")
done

free_pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
(( 100 - free_pct < 10 )) && fails+=("disk / ${free_pct}% used")

now="$(date -u +%FT%TZ)"
if (( ${#fails[@]} == 0 )); then
  echo "$now ok" > "$STATUS_FILE"
  exit 0
fi
msg="phantom-messenger healthcheck FAIL: $(IFS='; '; echo "${fails[*]}")"
echo "$now $msg" > "$STATUS_FILE"
echo "$msg" >&2
if [[ -n "$ALERT_WEBHOOK" ]]; then
  python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$msg" \
    | curl -fsS -m 10 -H 'Content-Type: application/json' --data-binary @- "$ALERT_WEBHOOK" >/dev/null 2>&1 || true
fi
exit 1
