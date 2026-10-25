# shellcheck shell=bash
# shellcheck disable=SC2154,SC2034
# Автоматическая регистрация сервера в сервисе номеров (протокол — docs/SELFHOST.md сервиса номеров, §1).
# Подключается через source из install.sh. Не запускать напрямую.
#
# Правила секрета client_secret (утечка снова открывает перехват ключа домена):
#   - 32 случайных байта, живут только в локальной переменной shell этой функции;
#   - не пишутся на диск, в журнал, в argv процессов (тело запросов - через stdin curl `--data-binary @-`,
#     printf - встроенная команда bash, поэтому argv не создаёт), не попадают в --dry-run и status.sh;
#   - после verify - unset.
# Ключ интеграции (api_key) приходит один раз: сразу пишется в env и в вывод не попадает.

# (PM_WELLKNOWN_ROOT и PM_CHALLENGE_PREFIX заданы в lib/common.sh)

# Каталог челленджа: root:root 0755, файлы 0644; nginx отдаёт только location ^~ /.well-known/phantom-numbers/.
autoreg_prepare_dir() {
  install -d -m 0755 "$PM_WELLKNOWN_ROOT"
}

# Удалить файлы челленджа (токен одноразовый). Вызывается после verify и из trap установщика.
autoreg_cleanup_challenge() {
  [[ -d "$PM_WELLKNOWN_ROOT" ]] || return 0
  find "$PM_WELLKNOWN_ROOT" -mindepth 1 -maxdepth 1 -type f -delete 2>/dev/null || true
  return 0
}

# Поле верхнего уровня JSON-ответа из stdin (строка/число), иначе пусто. Имя поля - в argv (не секрет).
autoreg_json_get() {
  python3 -I -c '
import json, sys
try:
    d = json.load(sys.stdin)
    v = d.get(sys.argv[1]) if isinstance(d, dict) else None
except Exception:
    v = None
print(v if isinstance(v, (str, int)) and not isinstance(v, bool) else "")
' "$1"
}

# autoreg_post <путь API>; JSON-тело - со stdin (вызывать через `< <(printf ...)`, не через конвейер: нужны переменные результата). Результат: AUTOREG_HTTP (код) и AUTOREG_BODY (тело ответа).
# Тело ответа verify содержит api_key: в вывод не печатается.
autoreg_post() {
  local -; set +x      # bash -x не должен печатать тела запросов (секрет, ключ)
  local path="$1" proto="=https" out
  [[ -z "${PM_TEST_ROOT:-}" ]] || proto="=http,https"      # мок сервиса номеров - только в тестовом режиме (не root)
  out="$(curl -sS -m 30 --proto "$proto" --max-redirs 0 -H 'Content-Type: application/json' \
          --data-binary @- -w $'\n%{http_code}' "${API_BASE}${path}" 2>/dev/null)" || out=$'\n000'
  AUTOREG_HTTP="${out##*$'\n'}"
  AUTOREG_BODY="${out%$'\n'*}"
  [[ "$AUTOREG_HTTP" =~ ^[0-9]{3}$ ]] || AUTOREG_HTTP=000
}

# Ответ сервера недоверенный: в сообщения для терминала root попадают только безопасные символы и не более 64 штук
# (иначе escape-последовательности в error/reason - инъекция в терминал).
autoreg_clean() { tr -cd 'A-Za-z0-9_.-' | head -c 64; }

# Понятное объяснение отказа: autoreg_explain <http> <error> <reason>
autoreg_explain() {
  local http="$1" err="$2" reason="$3"
  case "$http:$err" in
    503:selfhost_registration_disabled)
      print_error "Сервис номеров сейчас не принимает регистрацию новых серверов (выключена владельцем сервиса, HTTP 503). Повторите позже: sudo ./install.sh --reregister (или получите ключ вручную: admin@phantommessenger.org)" ;;
    503:*)
      print_error "Сервис номеров временно недоступен (HTTP 503, ${err:-без кода}). Повторите позже: sudo ./install.sh --reregister" ;;
    429:rate_limited)
      print_error "Превышен лимит регистраций сервиса номеров (с одного IP - 5 в час). Повторите через час: sudo ./install.sh --reregister" ;;
    429:busy)
      print_error "Сервис номеров занят проверками (busy) - попытки исчерпаны. Повторите через несколько минут: sudo ./install.sh --reregister" ;;
    400:domain_reserved|400:domain_invalid|400:domain_too_long)
      print_error "Сервис номеров не принял домен ${DOMAIN} (${err}). Домены phantommessenger.org/phantomnumbers.org и похожие на них, IP, localhost и служебные зоны регистрировать нельзя" ;;
    400:domain_not_allowed)
      print_error "Домен ${DOMAIN} не принят: домены на бесплатном хостинге или DDNS (github.io, duckdns и т.п.) сервис номеров не регистрирует - нужен свой домен" ;;
    400:challenge_not_found)
      print_error "Сервис номеров не принял токен проверки (истёк, использован или не совпал секрет). Повторите: sudo ./install.sh --reregister" ;;
    400:challenge_failed)
      case "$reason" in
        unresolvable)      print_error "Сервис номеров не смог разрешить DNS-имя ${DOMAIN}: проверьте A-запись домена" ;;
        forbidden_address) print_error "${DOMAIN} указывает на непубличный адрес (локальный/частный) - сервис номеров не ходит на такие адреса" ;;
        unreachable)       print_error "Сервис номеров не достучался до https://${DOMAIN}:443 (порт 443 закрыт у провайдера/в файрволе?)" ;;
        tls_error)         print_error "Сервис номеров не принял TLS-сертификат ${DOMAIN}: нужен сертификат публичного CA, действительный для этого имени" ;;
        body_mismatch)     print_error "Файл проверки отдан, но тело не совпало с ожидаемым (кэш CDN или чужой ответ)" ;;
        *)                 print_error "Сервис номеров не получил файл проверки (${reason:-bad_response}). Возможные причины: ответ не 200, редирект, Cloudflare/CDN отдаёт кэшированную страницу, либо домен заблокирован владельцем сервиса" ;;
      esac
      if [[ "$TLS_MODE" == cloudflare-* ]]; then
        print_info "Cloudflare: добавьте Cache Rule - обход кэша (Bypass) для ${PM_CHALLENGE_PREFIX}* и повторите: sudo ./install.sh --reregister"
      fi ;;
    000:*)
      print_error "Сервис номеров недоступен по сети (${API_BASE}). Проверьте исходящий HTTPS с сервера и повторите: sudo ./install.sh --reregister" ;;
    *)
      print_error "Неожиданный ответ сервиса номеров: HTTP ${http} ${err:-}" ;;
  esac
}

# relay_autoregister: регистрация -> файл челленджа -> verify (ретраи на 429 busy) -> ключ в SERVICE_KEY/env.
# Возврат 0 - ключ получен; 1 - не удалось (сообщение уже выведено; ключ остаётся прежним).
relay_autoregister() {
  local -; set +x      # bash -x не должен печатать client_secret и api_key
  print_header "Регистрация сервера в сервисе номеров"
  cat <<NOTICE
Сервису номеров ($API_BASE) будут переданы: домен ${DOMAIN}, контактная почта оператора, название и версия ПО
(phantom-messenger-selfhost $(head -n1 "$SCRIPT_DIR/VERSION" 2>/dev/null)) и - как адрес запроса - IP этого сервера. Сервис сам скачает файл
https://${DOMAIN}${PM_CHALLENGE_PREFIX}<токен>, чтобы убедиться, что домен ваш.
Важно: коды входа для ваших пользователей приходят с пометкой «сторонний сервер ${DOMAIN}»; для сторонних серверов действуют
жёсткие лимиты, а владелец сервиса номеров может заблокировать сервер (тогда вход по кодам перестанет работать).
NOTICE
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "client_secret: 32 случайных байта (только в памяти shell; на диск, в argv и в вывод не попадает), client_commitment = base64url(sha256)"
    plan "POST ${API_BASE}/api/selfhost/register {domain, contact_email, software, version, client_commitment} -> challenge_token"
    plan "файл ${PM_WELLKNOWN_ROOT}/<token> (root:root 0644, тело phantom-numbers-challenge=<token>); nginx: location ^~ ${PM_CHALLENGE_PREFIX}"
    plan "POST ${API_BASE}/api/selfhost/verify {domain, challenge_token, client_secret, ...}; до 5 попыток на 429 busy (2, 4, 8, 16 с)"
    plan "api_key -> NFT_NUMBERS_SERVICE_SECRET в env (заголовок ${PM_SERVICE_KEY_HEADER}); файл челленджа удаляется сразу после verify; unset client_secret"
    return 0
  fi

  local secret_std secret commit ver token path body attempt max=5 delay rc=1 http err reason key
  local base="${PM_AUTOREG_BACKOFF_BASE:-2}"
  [[ -z "${PM_TEST_ROOT:-}" ]] && base=2          # ослаблять задержки можно только в тестовом режиме
  ver="$(head -n1 "$SCRIPT_DIR/VERSION" 2>/dev/null || true)"
  [[ "$ver" =~ ^[0-9A-Za-z.+-]{1,32}$ ]] || ver=""

  secret_std="$(openssl rand -base64 32)" || { print_error "openssl rand не сработал"; return 1; }
  secret="$(printf '%s' "$secret_std" | tr '+/' '-_' | tr -d '=')"
  commit="$(printf '%s' "$secret_std" | openssl base64 -d -A | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  unset secret_std
  if [[ ! "$secret" =~ ^[A-Za-z0-9_-]{43}$ || ! "$commit" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
    unset secret commit; print_error "Не удалось сформировать секрет регистрации"; return 1
  fi
  autoreg_prepare_dir

  # 1. register
  body="$(printf '{"domain":"%s","contact_email":"%s","software":"phantom-messenger-selfhost","version":"%s","client_commitment":"%s"}' \
          "$DOMAIN" "$OPERATOR_EMAIL" "$ver" "$commit")"
  [[ -n "$ver" ]] || body="$(printf '{"domain":"%s","contact_email":"%s","software":"phantom-messenger-selfhost","client_commitment":"%s"}' "$DOMAIN" "$OPERATOR_EMAIL" "$commit")"
  autoreg_post /api/selfhost/register < <(printf '%s' "$body")
  unset body commit
  http="$AUTOREG_HTTP"
  err="$(printf '%s' "$AUTOREG_BODY" | autoreg_json_get error | autoreg_clean)"
  reason="$(printf '%s' "$AUTOREG_BODY" | autoreg_json_get reason | autoreg_clean)"
  if [[ "$http" != "200" ]]; then
    autoreg_explain "$http" "$err" "$reason"; unset secret; return 1
  fi
  token="$(printf '%s' "$AUTOREG_BODY" | autoreg_json_get challenge_token)"
  path="$(printf '%s' "$AUTOREG_BODY" | autoreg_json_get challenge_path)"
  if [[ ! "$token" =~ ^[A-Za-z0-9_-]{16,64}$ || "$path" != "${PM_CHALLENGE_PREFIX}${token}" ]]; then
    print_error "Сервис номеров вернул непонятный челлендж - регистрация прервана"; unset secret; return 1
  fi

  # 2. файл челленджа (удаляется сразу после verify, при любом исходе)
  printf 'phantom-numbers-challenge=%s\n' "$token" > "$PM_WELLKNOWN_ROOT/$token"
  chmod 0644 "$PM_WELLKNOWN_ROOT/$token"
  if [[ -z "${PM_TEST_ROOT:-}" ]]; then
    # Локальная проверка: nginx отдаёт файл (loopback, сертификат не проверяем - это проверка собственного конфига).
    if ! curl -ksS -m 10 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}${path}" 2>/dev/null | grep -qx "phantom-numbers-challenge=${token}"; then
      print_warning "nginx локально не отдал файл проверки (${path}); сервис номеров, скорее всего, тоже его не получит"
    fi
  fi

  # 3. verify (ретраи только на 429 busy)
  delay="$base"; attempt=1
  while :; do
    body="$(printf '{"domain":"%s","challenge_token":"%s","client_secret":"%s","contact_email":"%s"%s}' \
            "$DOMAIN" "$token" "$secret" "$OPERATOR_EMAIL" "${ver:+,\"version\":\"$ver\"}")"
    autoreg_post /api/selfhost/verify < <(printf '%s' "$body")
    unset body
    http="$AUTOREG_HTTP"
    err="$(printf '%s' "$AUTOREG_BODY" | autoreg_json_get error | autoreg_clean)"
    reason="$(printf '%s' "$AUTOREG_BODY" | autoreg_json_get reason | autoreg_clean)"
    if [[ "$http" == "429" && "$err" == "busy" && "$attempt" -lt "$max" ]]; then
      print_info "Сервис номеров занят (busy), повтор через ${delay} с (попытка ${attempt}/${max})"
      sleep "$delay"; delay=$((delay * 2)); attempt=$((attempt + 1)); continue
    fi
    break
  done
  unset secret                                   # секрет больше не нужен
  rm -f "$PM_WELLKNOWN_ROOT/$token"              # токен одноразовый
  if [[ "$http" == "200" ]]; then
    key="$(printf '%s' "$AUTOREG_BODY" | autoreg_json_get api_key)"
    AUTOREG_BODY=""
    if [[ "$key" =~ ^[A-Za-z0-9_.:-]{1,200}$ ]]; then
      SERVICE_KEY="$key"; KEY_SOURCE="selfhost"; rc=0
      print_success "Сервер зарегистрирован в сервисе номеров (ключ получен и сохраняется в env; в терминал не печатается)"
    else
      print_error "Сервис номеров вернул ключ неожиданного вида - регистрация прервана"
    fi
    unset key
  else
    AUTOREG_BODY=""
    autoreg_explain "$http" "$err" "$reason"
  fi
  return "$rc"
}

# Ключ получен - сразу записать в env (он показывается сервисом один раз), не дожидаясь конца установки.
autoreg_persist_key() {
  local -; set +x
  set_env "$ENV_WORK" NFT_NUMBERS_SERVICE_SECRET "$SERVICE_KEY"
  install_file "$ENV_WORK" "$PM_ENV_FILE" 0640 "root:${PM_USER}"
  chmod 0600 "${PM_ENV_FILE}".bak.* 2>/dev/null || true
  # Откат relay_start к прежнему env не должен терять только что выданный (а прежний уже отозван) ключ.
  if [[ -n "${PREV_ENV:-}" && -f "$PREV_ENV" ]]; then set_env "$PREV_ENV" NFT_NUMBERS_SERVICE_SECRET "$SERVICE_KEY"; fi
}
