#!/usr/bin/env bash
# Самопроверка снаружи: DNS, TLS 1.3, публичный health, WebSocket Origin, TURN, ключ сервиса номеров.
# Запуск на сервере: sudo /opt/phantom-messenger/selfhost/selftest.sh   (код выхода 1 при провалах)
# A && B || C здесь безопасно: ok/pass/fail/warn всегда возвращают 0.
# shellcheck disable=SC2015
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

PASS=0; FAIL=0; WARN=0
pass() { print_success "$*"; PASS=$((PASS + 1)); }
fail() { print_error "$*"; FAIL=$((FAIL + 1)); }
warn() { print_warning "$*"; WARN=$((WARN + 1)); }

DOMAIN="$(conf_get DOMAIN)"; TURN_HOST="$(conf_get TURN_HOST)"
EXTERNAL_IP="$(conf_get EXTERNAL_IP)"; API_BASE="$(conf_get API_BASE)"; TLS_MODE="$(conf_get TLS_MODE)"
[[ -n "$DOMAIN" ]] || die "Нет $PM_CONF_FILE — сервер не установлен install.sh"

print_header "1. DNS"
a="$(resolve_a "$DOMAIN")"; t="$(resolve_a "$TURN_HOST")"
[[ -n "$a" ]] && pass "$DOMAIN → $a" || fail "$DOMAIN не резолвится"
if [[ -z "$t" ]]; then fail "$TURN_HOST не резолвится"
elif [[ -n "$EXTERNAL_IP" && "$t" != "$EXTERNAL_IP" ]]; then fail "$TURN_HOST → $t, а IP сервера $EXTERNAL_IP"
else pass "$TURN_HOST → $t"; fi
if [[ -n "$t" ]]; then
  fetch_cf_ranges
  if python3 -I -c '
import ipaddress, sys
ip = ipaddress.ip_address(sys.argv[1])
sys.exit(0 if any(ip in ipaddress.ip_network(n) for n in sys.argv[2].split(",")) else 1)
' "$t" "$CF_IP_RANGES"; then fail "$TURN_HOST указывает на Cloudflare (оранжевое облако): TURN/UDP через прокси не работает — переключите запись в DNS only"; else pass "$TURN_HOST не за Cloudflare"; fi
fi

print_header "2. TLS"
out="$(openssl s_client -connect "${DOMAIN}:443" -servername "$DOMAIN" -tls1_3 </dev/null 2>&1 || true)"
if grep -q 'TLSv1.3' <<<"$out"; then pass "TLS 1.3 доступен (нужен iOS/macOS)"; else fail "TLS 1.3 не согласован"; fi
if grep -q 'Verify return code: 0' <<<"$out"; then pass "цепочка сертификата проверена системными CA"; else
  if [[ "$TLS_MODE" == "cloudflare-origin" ]]; then pass "проверка цепочки пропущена: edge Cloudflare сам предъявляет публичный сертификат (проверьте режим Full strict)"; else
    fail "цепочка сертификата не проходит проверку системными CA (self-signed/без промежуточного — приложения не подключатся)"; fi
fi

print_header "3. Публичный HTTPS"
base="https://${DOMAIN}"
curl -fsS -m 10 "$base/api/health" 2>/dev/null | grep -q '"ok":true' && pass "$base/api/health" || fail "$base/api/health"
curl -fsS -m 10 "$base/api/config" 2>/dev/null | grep -q '"ok":true' && pass "$base/api/config" || fail "$base/api/config"
code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$base/" 2>/dev/null || echo 000)"; [[ "$code" == "200" ]] && pass "веб-клиент: GET / → 200" || fail "GET / → $code"
for pg in terms privacy operator.json; do
  code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$base/$pg" 2>/dev/null || echo 000)"; [[ "$code" == "200" ]] && pass "GET /$pg → 200" || fail "GET /$pg → $code"
done
code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$base/SECURITY_AUDIT.md" 2>/dev/null || echo 000)"
[[ "$code" == "404" ]] && pass "/SECURITY_AUDIT.md → 404 (документ аудита чужого сервера не публикуется)" || warn "/SECURITY_AUDIT.md → $code (ожидался 404)"

print_header "4. WebSocket / Origin"
PYBIN="$PM_OPT/venv/bin/python"
if [[ -x "$PYBIN" ]]; then
  ws_out="$("$PYBIN" -I - "$DOMAIN" <<'PY' 2>&1
import asyncio, sys
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus
domain = sys.argv[1]
uri = f"wss://{domain}/relay?device_id=0123456789abcdef"
async def probe(origin):
    try:
        async with connect(uri, origin=origin, open_timeout=10) as ws:
            return "open"
    except InvalidStatus as e:
        return f"http{e.response.status_code}"
    except Exception as e:  # noqa: BLE001
        return f"err:{type(e).__name__}"
async def main():
    print("same-origin:", await probe(f"https://{domain}"))
    print("foreign-origin:", await probe("https://evil.invalid"))
asyncio.run(main())
PY
)"
  grep -q 'same-origin: open' <<<"$ws_out" && pass "WS с Origin сервера принимается" || fail "WS с Origin https://$DOMAIN отклонён: $(grep same-origin <<<"$ws_out")"
  grep -q 'foreign-origin: open' <<<"$ws_out" && fail "WS принимает чужой Origin" || pass "WS с чужим Origin отклоняется ($(grep foreign-origin <<<"$ws_out" | cut -d: -f2- | tr -d ' '))"
else
  warn "venv не найден — проверка WebSocket пропущена"
fi

print_header "5. TURN"
if [[ -f "$PM_OPT/scripts/turn_selftest.py" && -x "$PYBIN" ]]; then
  turn_secret="$(read_env_value TURN_STATIC_AUTH_SECRET "$PM_ENV_FILE")"
  if [[ -z "$turn_secret" ]]; then warn "нет TURN_STATIC_AUTH_SECRET — проверка TURN пропущена (нужен root)"; else
    if TURN_STATIC_AUTH_SECRET="$turn_secret" "$PYBIN" -I "$PM_OPT/scripts/turn_selftest.py" --host "$TURN_HOST"; then
      pass "turn_selftest.py: эфемерные креды, политика пиров, 16 параллельных аллокаций"
    else fail "turn_selftest.py провален (см. вывод выше; частые причины: UDP 3478 закрыт файрволом провайдера, TURN-хост за Cloudflare)"; fi
  fi
else warn "turn_selftest.py недоступен — проверка TURN пропущена"; fi

print_header "6. Ключ сервиса номеров"
_xt="$-"; set +x      # bash -x не должен печатать ключ
key="$(read_env_value NFT_NUMBERS_SERVICE_SECRET "$PM_ENV_FILE")"
if [[ "$key" == "$PM_NO_KEY_PLACEHOLDER" ]]; then fail "ключ сервиса номеров не получен (вход по кодам не работает): повторите установку той же командой или sudo $PM_OPT/selfhost/install.sh --reregister"
elif [[ -z "$key" ]]; then warn "нет ключа в env (нужен root)"; else
  # Заголовок — тот, что relay реально шлёт сервису (env), по умолчанию X-API-Key.
  hdr="$(read_env_value NFT_NUMBERS_SERVICE_SECRET_HEADER "$PM_ENV_FILE")"; hdr="${hdr:-$PM_SERVICE_KEY_HEADER}"
  code="$(printf 'header = "%s: %s"\n' "$hdr" "$key" | curl -sS -m 15 -o /dev/null -w '%{http_code}' -K - -H 'Content-Type: application/json' -X POST --data '{}' "${API_BASE}/api/verify-code" 2>/dev/null || echo 000)"
  case "$code" in
    422|400) pass "ключ принят сервисом номеров ($API_BASE, заголовок $hdr)" ;;
    401|403) if [[ "$(conf_get KEY_SOURCE)" == "selfhost" ]]; then
               fail "ключ авторегистрации отклонён (HTTP $code): сервер снят с регистрации или ключ сменён — запустите установку ещё раз (sudo $PM_OPT/selfhost/install.sh), она зарегистрирует сервер заново"
             else fail "ключ отклонён (HTTP $code): отозван или заменён — запросите новый у владельца сервиса номеров"; fi ;;
    429) warn "сервис номеров ответил 429 (лимит) — повторите позже" ;;
    *) warn "сервис номеров: HTTP $code" ;;
  esac
fi

unset key; [[ "$_xt" != *x* ]] || set -x

print_header "Итог"
echo "PASS=$PASS WARN=$WARN FAIL=$FAIL"
(( FAIL == 0 ))
