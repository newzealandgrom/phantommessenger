#!/bin/bash
# Managed by phantom-selfhost. Для режимов cloudflare-*: обновляет список CIDR Cloudflare
#   • /etc/phantom-messenger/cf-ips.txt — читает relay (TRUSTED_PROXIES_FILE) при старте; если список
#     изменился, relay перезапускается (клиенты переподключатся, offline-очередь в RAM сбросится);
#   • правила ufw "443/tcp from <CIDR>" с комментарием pm-cf, если в install.conf CF_ONLY_443=1.
# Запускается pm-cf-update.timer раз в сутки; при ошибке скачивания/валидации ничего не меняет.
# Usage: pm-cf-update.sh [--no-restart]   (--no-restart — при установке, relay ещё не запущен)
set -uo pipefail
umask 022

ETC=/etc/phantom-messenger
FILE="$ETC/cf-ips.txt"
CONF="$ETC/install.conf"
PORT=443
TAG="pm-cf"
RESTART=1
[[ "${1:-}" == "--no-restart" ]] && RESTART=0

log() { echo "[pm-cf-update $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

exec 9>/run/pm-cf-update.lock
flock -n 9 || { log "уже выполняется"; exit 0; }

cf_only=0
if [[ -r "$CONF" ]] && grep -qx 'CF_ONLY_443=1' "$CONF"; then cf_only=1; fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fetch() { curl -fsS --max-time 20 --retry 3 --retry-delay 2 --proto '=https' --tlsv1.2 "$1"; }

have_fresh=1
if ! { fetch https://www.cloudflare.com/ips-v4 > "$tmp/v4" && fetch https://www.cloudflare.com/ips-v6 > "$tmp/v6"; }; then
  have_fresh=0
fi

# Валидация: только корректные глобальные CIDR, без supernet'ов, разумное количество.
if [[ "$have_fresh" == "1" ]]; then
  if ! python3 -I - "$tmp/v4" "$tmp/v6" > "$tmp/want" <<'PY'
import ipaddress, sys
out = []
for path, ver, minpref, lo, hi in ((sys.argv[1], 4, 8, 5, 64), (sys.argv[2], 6, 16, 2, 64)):
    items = open(path).read().split()
    if not lo <= len(items) <= hi:
        sys.exit(f"v{ver}: подозрительное количество сетей: {len(items)}")
    for s in items:
        n = ipaddress.ip_network(s, strict=True)
        if n.version != ver or n.prefixlen < minpref or not n.is_global:
            sys.exit(f"v{ver}: отвергнута сеть {s}")
        out.append(str(n))
print("\n".join(sorted(set(out))))
PY
  then have_fresh=0; fi
fi

changed=0
if [[ "$have_fresh" == "1" ]]; then
  if ! cmp -s "$tmp/want" "$FILE" 2>/dev/null; then
    install -m 0644 -o root -g root "$tmp/want" "$FILE.new" && mv -f "$FILE.new" "$FILE"
    changed=1
    log "cf-ips.txt обновлён ($(wc -l < "$FILE") сетей)"
  fi
else
  log "WARN: список Cloudflare не получен/не прошёл проверку — cf-ips.txt не меняю"
  [[ -s "$FILE" ]] && sort -u "$FILE" > "$tmp/want" || exit 2
fi

rc=0
if [[ "$cf_only" == "1" ]]; then
  if ! command -v ufw >/dev/null 2>&1; then log "ERROR: ufw не установлен, CF_ONLY_443=1"; exit 3; fi
  ufw status | awk -v p="$PORT/tcp" -v t="# $TAG" '
    index($0, t) && ($1 == p || $1 == p" (v6)") {
      for (i = 2; i <= NF; i++) if ($i ~ /^[0-9a-fA-F:.]+\/[0-9]+$/) { print $i; break }
    }' | sort -u > "$tmp/have"
  comm -23 "$tmp/want" "$tmp/have" > "$tmp/add"
  comm -13 "$tmp/want" "$tmp/have" > "$tmp/del"
  # Сначала добавляем (нет окна, когда Cloudflare отрезан), потом удаляем устаревшие.
  while read -r cidr; do
    [[ -n "$cidr" ]] || continue
    ufw allow proto tcp from "$cidr" to any port "$PORT" comment "$TAG" >/dev/null || { log "ERROR: add $cidr"; rc=3; }
  done < "$tmp/add"
  if [[ $rc -eq 0 ]]; then
    while read -r cidr; do
      [[ -n "$cidr" ]] || continue
      ufw --force delete allow proto tcp from "$cidr" to any port "$PORT" comment "$TAG" >/dev/null \
        || ufw --force delete allow proto tcp from "$cidr" to any port "$PORT" >/dev/null \
        || { log "ERROR: delete $cidr"; rc=3; }
    done < "$tmp/del"
  else
    log "ошибки при добавлении — удаление устаревших пропущено"
  fi
  log "ufw 443: add=$(wc -l < "$tmp/add") del=$(wc -l < "$tmp/del")"
fi

if [[ "$changed" == "1" && "$RESTART" == "1" ]] && systemctl is-active --quiet phantom-messenger; then
  log "список изменился — перезапускаю relay, чтобы он перечитал TRUSTED_PROXIES_FILE"
  systemctl restart phantom-messenger || rc=4
fi
exit $rc
