# shellcheck shell=bash
# shellcheck disable=SC2154,SC2034
# Relay: пользователь, код, venv, env, operator.json, systemd. Подключается из install.sh.

# Имя файла в --render-dir: для drop-in'ов добавляем имя каталога (<unit>.service.d__10-hardening.conf).
render_name() {
  local dir; dir="$(basename "$(dirname "$1")")"
  if [[ "$dir" == *.d ]]; then echo "${dir}__$(basename "$1")"; else basename "$1"; fi
}

# copy_install <файл-шаблон> <назначение> <режим> <владелец:группа> — без подстановок.
copy_install() {
  local src="$1" dst="$2" mode="$3" owner="$4"
  if [[ "$DRY_RUN" == "1" && -n "${RENDER_DIR:-}" ]]; then
    install -m 0644 "$src" "${RENDER_DIR}/$(render_name "$dst")"
    plan "скопировано: $(render_name "$dst") в render-dir (было бы: $dst)"
  else
    install_file "$src" "$dst" "$mode" "$owner"
  fi
}

relay_create_user() {
  print_header "Пользователь и каталоги"
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "useradd --system --user-group --home-dir $PM_STATE_DIR --no-create-home --shell /usr/sbin/nologin $PM_USER"
    plan "install -d -m 0750 -o root -g $PM_USER $PM_ETC; install -d -m 0700 $PM_SSL_DIR"
    return 0
  fi
  local created=0
  if ! id -u "$PM_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$PM_STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$PM_USER"
    created=1
    print_success "Создан системный пользователь $PM_USER"
  fi
  install -d -m 0750 -o root -g "$PM_USER" "$PM_ETC"
  # Отметка «пользователя создали мы»: uninstall --purge удаляет только такого пользователя.
  if [[ "$created" == "1" ]]; then : > "$PM_USER_MARKER"; chmod 0600 "$PM_USER_MARKER"; fi
  install -d -m 0700 -o root -g root "$PM_SSL_DIR"
  install -d -m 0755 -o root -g root "$PM_OPT"
}

# Код приложения из релиза (SCRIPT_DIR/app) → /opt/phantom-messenger.
relay_install_app() {
  print_header "Код relay и веб-клиент"
  local app="$SCRIPT_DIR/app" ts
  if [[ ! -d "$app/backend" || ! -f "$app/client/dist/index.html" ]]; then
    if [[ -d "$PM_OPT/backend" && "$DRY_RUN" != "1" ]]; then
      print_info "В пакете нет app/ — код не трогаю (обновление кода: update.sh <архив>)"
      return 0
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
      plan "(в этом каталоге нет app/ — это не релизный архив; реальный запуск потребует app/)"
      return 0
    fi
    die "Нет app/backend и app/client/dist: запускайте install.sh из распакованного релизного архива"
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "cp -a $app/backend $PM_OPT/backend (старый → backend.bak.<ts>)"
    plan "cp -a $app/client/dist $PM_OPT/client/dist (старый → dist.bak.<ts>)"
    plan "requirements.lock, scripts/turn_selftest.py, VERSION → $PM_OPT; файлы релиза по MANIFEST → $PM_OPT/selfhost (посторонние файлы из каталога архива не копируются)"
    plan "chown -R root:root $PM_OPT; chmod -R u=rwX,go=rX"
    return 0
  fi
  ts="$(date +%Y%m%d-%H%M%S)"
  install -d -m 0755 "$PM_OPT" "$PM_OPT/client" "$PM_OPT/scripts"
  if [[ -d "$PM_OPT/backend" ]]; then mv "$PM_OPT/backend" "$PM_OPT/backend.bak.$ts"; prune_backups "$PM_OPT/backend"; fi
  cp -a "$app/backend" "$PM_OPT/backend"
  if [[ -d "$PM_OPT/client/dist" ]]; then mv "$PM_OPT/client/dist" "$PM_OPT/client/dist.bak.$ts"; prune_backups "$PM_OPT/client/dist"; fi
  cp -a "$app/client/dist" "$PM_OPT/client/dist"
  cp -a "$app/requirements.lock" "$PM_OPT/requirements.lock.new"
  cp -a "$app/scripts/turn_selftest.py" "$PM_OPT/scripts/turn_selftest.py"
  cp -a "$SCRIPT_DIR/VERSION" "$PM_OPT/VERSION"
  [[ -f "$SCRIPT_DIR/BUILD_INFO" ]] && cp -a "$SCRIPT_DIR/BUILD_INFO" "$PM_OPT/BUILD_INFO"
  find "$PM_OPT/backend" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  # Пакет установщика — только файлы релиза (по MANIFEST.sha256, без app/): ключи и токены оператора,
  # лежащие рядом в каталоге архива, сюда не попадут. Установленный якорь allowed_signers сохраняется.
  install_pkg_scripts "$SCRIPT_DIR" "$PM_OPT/selfhost"
  chown -R root:root "$PM_OPT"
  chmod -R u=rwX,go=rX "$PM_OPT"
  print_success "Код выложен в $PM_OPT (версия $(head -n1 "$PM_OPT/VERSION"))"
}

# venv из requirements.lock с проверкой хешей. Пересоздаётся только если lock изменился.
relay_install_venv() {
  print_header "Python-окружение (venv, --require-hashes)"
  local lock="$PM_OPT/requirements.lock" new_lock="$PM_OPT/requirements.lock.new" ts
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "${PM_PYTHON:-python3} -m venv $PM_OPT/venv && venv/bin/python -m pip install --require-hashes --only-binary=:all: -r requirements.lock"
    return 0
  fi
  [[ -f "$new_lock" ]] || new_lock="$lock"
  if [[ -x "$PM_OPT/venv/bin/python" && -f "$lock" && "$(sha256_of "$new_lock")" == "$(sha256_of "$lock")" && -f "$PM_OPT/venv/.lock.sha" \
        && "$(cat "$PM_OPT/venv/.lock.sha")" == "$(sha256_of "$lock")" ]]; then
    print_info "venv актуален (requirements.lock не менялся)"
    rm -f "$PM_OPT/requirements.lock.new"
    return 0
  fi
  if [[ -f "$PM_OPT/requirements.lock.new" ]]; then
    mv -f "$PM_OPT/requirements.lock.new" "$lock"
  fi
  ts="$(date +%Y%m%d-%H%M%S)"
  if [[ -d "$PM_OPT/venv" ]]; then mv "$PM_OPT/venv" "$PM_OPT/venv.bak.$ts"; fi
  if ! "${PM_PYTHON:-python3}" -m venv "$PM_OPT/venv" || \
     ! "$PM_OPT/venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check \
        --require-hashes --only-binary=:all: -r "$lock"; then
    print_error "Не удалось установить зависимости по хешам (pip). Возвращаю прежний venv."
    rm -rf "$PM_OPT/venv"
    [[ -d "$PM_OPT/venv.bak.$ts" ]] && mv "$PM_OPT/venv.bak.$ts" "$PM_OPT/venv"
    exit 1
  fi
  sha256_of "$lock" > "$PM_OPT/venv/.lock.sha"
  prune_backups "$PM_OPT/venv"
  "$PM_OPT/venv/bin/python" -m py_compile "$PM_OPT/backend/config.py" "$PM_OPT/backend/main.py" "$PM_OPT/backend/mesh.py"
  find "$PM_OPT/backend" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  chown -R root:root "$PM_OPT"
  print_success "venv готов, файлы проекта компилируются"
}

# gen_secret hex <байт> | base64 | fernet — в dry-run возвращает заглушку.
gen_secret() {
  local kind="$1"
  if [[ "$DRY_RUN" == "1" ]]; then echo "<будет сгенерирован>"; return 0; fi
  case "$kind" in
    hex48) openssl rand -hex 48 ;;
    hex32) openssl rand -hex 32 ;;
    base64) openssl rand -base64 32 ;;
    fernet) "$PM_OPT/venv/bin/python" -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())' ;;
    *) die "gen_secret: неизвестный вид $kind" ;;
  esac
}

# env_secret <KEY> <вид> — существующее значение сохраняется; иначе генерируется.
env_secret() {
  local key="$1" kind="$2" cur
  cur="$(read_env_value "$key" "$ENV_WORK")"
  if [[ -n "$cur" ]]; then
    return 0
  fi
  set_env "$ENV_WORK" "$key" "$(gen_secret "$kind")"
  print_info "Сгенерирован $key"
}

# Сборка env: рабочая копия → проверки → установка в /etc/phantom-messenger/env.
relay_build_env() {
  local -; set +x      # в env попадает ключ сервиса номеров: bash -x его не печатает
  print_header "Конфигурация (/etc/phantom-messenger/env)"
  ENV_WORK="$(mktemp)"
  chmod 0600 "$ENV_WORK"
  if [[ -f "$PM_ENV_FILE" ]]; then cat "$PM_ENV_FILE" > "$ENV_WORK"; fi

  # Cloudflare: список CIDR — в файле (TRUSTED_PROXIES_FILE), его обновляет pm-cf-update.timer.
  local trusted="127.0.0.1/32,::1" ip_header="" trusted_file=""
  if [[ "$TLS_MODE" == "cloudflare-dns" || "$TLS_MODE" == "cloudflare-origin" ]]; then
    fetch_cf_ranges
    trusted_file="$PM_CF_IPS_FILE"
    ip_header="CF-Connecting-IP"
    relay_write_cf_file
  fi

  set_env "$ENV_WORK" ENV prod
  set_env "$ENV_WORK" MESSENGER_HOST 127.0.0.1
  set_env "$ENV_WORK" MESSENGER_PORT 8444
  set_env "$ENV_WORK" MESSENGER_USE_SSL 0
  set_env "$ENV_WORK" MESSENGER_APP_ORIGIN "https://${DOMAIN}"
  set_env "$ENV_WORK" REQUIRE_WSS 1
  set_env "$ENV_WORK" ALLOW_LEGACY_WS_QUERY_TOKEN 0
  set_env "$ENV_WORK" ENABLE_API_DOCS 0
  set_env "$ENV_WORK" ENABLE_DEBUG_ENDPOINTS 0
  set_env "$ENV_WORK" LOG_LEVEL WARNING
  set_env "$ENV_WORK" PERSIST_BLOCKED_USERS 1
  set_env "$ENV_WORK" PERSISTENCE_FILE "${PM_STATE_DIR}/state.json"
  set_env "$ENV_WORK" TRUSTED_PROXIES "$trusted"
  set_env "$ENV_WORK" TRUSTED_PROXIES_FILE "$trusted_file"
  set_env "$ENV_WORK" CLIENT_IP_HEADER "$ip_header"
  set_env "$ENV_WORK" NFT_NUMBERS_API_BASE "$API_BASE"
  set_env "$ENV_WORK" NFT_NUMBERS_ALLOW_PRIVATE 0
  set_env "$ENV_WORK" NFT_NUMBERS_TLS_VERIFY 1
  set_env "$ENV_WORK" NFT_NUMBERS_SERVICE_SECRET "${SERVICE_KEY:-$PM_NO_KEY_PLACEHOLDER}"
  # Заголовок ключа сервиса номеров: X-API-Key (X-Service-Secret у сервиса — легаси).
  set_env "$ENV_WORK" NFT_NUMBERS_SERVICE_SECRET_HEADER "$PM_SERVICE_KEY_HEADER"
  # Только собственный STUN: сторонние серверы раскрывали бы им IP клиентов.
  set_env "$ENV_WORK" ICE_SERVERS_JSON "[{\"urls\":[\"stun:${TURN_HOST}:3478\"]}]"
  set_env "$ENV_WORK" TURN_HOST "$TURN_HOST"
  set_env "$ENV_WORK" TURN_CRED_TTL_SEC "$(read_env_value TURN_CRED_TTL_SEC "$ENV_WORK" | grep . || echo 3600)"

  env_secret JWT_SECRET hex48
  env_secret TURN_STATIC_AUTH_SECRET hex32
  env_secret STATE_ENCRYPTION_KEY fernet
  env_secret PUSH_TOKEN_ENCRYPTION_KEY fernet
  env_secret MESH_RELAY_ATTESTATION_KEY base64
  # TURN_URLS зависит от наличия turns: (см. coturn_setup) — задаётся там через relay_set_turn_urls.

  if [[ "$DRY_RUN" == "1" ]]; then
    plan "env: ключи (значения секретов скрыты):"
    sed -E 's/^([A-Z0-9_]*(SECRET|KEY)[A-Z0-9_]*)=.*/\1=***/' "$ENV_WORK" | sed 's/^/    /'
    if [[ -n "${RENDER_DIR:-}" ]]; then
      sed -E 's/^([A-Z0-9_]*(SECRET|KEY)[A-Z0-9_]*)=.*/\1=***/' "$ENV_WORK" > "${RENDER_DIR}/env"
    fi
  fi
}

relay_set_turn_urls() {
  local with_tls="$1" urls
  urls="turn:${TURN_HOST}:3478,turn:${TURN_HOST}:3478?transport=tcp"
  [[ "$with_tls" == "1" ]] && urls="${urls},turns:${TURN_HOST}:5349?transport=tcp"
  set_env "$ENV_WORK" TURN_URLS "$urls"
}

relay_commit_env() {
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "install -m 0640 -o root -g $PM_USER <env> $PM_ENV_FILE (прежний → env.bak.<ts>, 0600)"
    rm -f "$ENV_WORK"
    return 0
  fi
  install_file "$ENV_WORK" "$PM_ENV_FILE" 0640 "root:${PM_USER}"
  rm -f "$ENV_WORK"
  # Бэкапы env — только root.
  chmod 0600 "${PM_ENV_FILE}".bak.* 2>/dev/null || true
  print_success "env записан (секреты сохраняются между запусками)"
}

# operator.json — имя/контакт оператора для /terms и /privacy.
relay_write_operator() {
  print_header "Данные оператора (operator.json)"
  local tmp
  tmp="$(mktemp)"
  python3 -I -c '
import json, sys
name, site, email, terms, privacy = sys.argv[1:6]
# Формат читают web (/terms, /privacy) и приложения iOS/macOS/Android для чужого сервера.
print(json.dumps({"version": 1, "name": name, "siteUrl": site, "contactEmail": email,
                  "termsUrl": terms, "privacyUrl": privacy, "securityReport": False},
                 ensure_ascii=False, indent=2))
' "$OPERATOR_NAME" "$OPERATOR_SITE" "$OPERATOR_EMAIL" \
    "${OPERATOR_TERMS_URL:-https://${DOMAIN}/terms}" "${OPERATOR_PRIVACY_URL:-https://${DOMAIN}/privacy}" > "$tmp"
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "operator.json → $PM_OPERATOR_FILE и $PM_OPT/client/dist/operator.json:"
    sed 's/^/    /' "$tmp"
    [[ -n "${RENDER_DIR:-}" ]] && install -m 0644 "$tmp" "${RENDER_DIR}/operator.json"
    rm -f "$tmp"
    return 0
  fi
  install_file "$tmp" "$PM_OPERATOR_FILE" 0644 root:root
  rm -f "$tmp"
  if [[ -d "$PM_OPT/client/dist" ]]; then
    install -m 0644 -o root -g root "$PM_OPERATOR_FILE" "$PM_OPT/client/dist/operator.json"
  fi
  print_success "operator.json записан"
}

# CIDR Cloudflare → файл для TRUSTED_PROXIES_FILE (по одному на строку; 0644 root, читает phantom).
relay_write_cf_file() {
  local tmp
  tmp="$(mktemp)"
  tr ',' '\n' <<<"$CF_IP_RANGES" > "$tmp"
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "$(wc -l < "$tmp" | tr -d ' ') сетей Cloudflare → $PM_CF_IPS_FILE (TRUSTED_PROXIES_FILE)"
    [[ -n "${RENDER_DIR:-}" ]] && install -m 0644 "$tmp" "${RENDER_DIR}/cf-ips.txt"
  else
    install -m 0644 -o root -g root "$tmp" "$PM_CF_IPS_FILE"
  fi
  rm -f "$tmp"
}

# Журнал-namespace phantom (volatile, RAM) должен быть настроен ДО первого запуска любого юнита
# с LogNamespace=phantom (relay и coturn): иначе journald@phantom создаст persistent-журнал по умолчанию.
relay_install_journald() {
  print_header "Журнал (namespace phantom, только RAM)"
  copy_install "$SCRIPT_DIR/templates/journald@phantom.conf" "/etc/systemd/journald@phantom.conf" 0644 root:root
  if [[ "$DRY_RUN" != "1" ]] && systemctl is-active --quiet systemd-journald@phantom.service 2>/dev/null; then
    systemctl restart systemd-journald@phantom.service || true
  fi
}

# Обновление списка Cloudflare + (опц.) ufw 443 только для Cloudflare.
relay_install_cf_updater() {
  [[ "$TLS_MODE" == cloudflare-* ]] || return 0
  print_header "Cloudflare: список CIDR и ufw 443"
  local t="$SCRIPT_DIR/templates"
  copy_install "$t/pm-cf-update.sh" "/usr/local/sbin/pm-cf-update.sh" 0750 root:root
  copy_install "$t/pm-cf-update.service" "/etc/systemd/system/pm-cf-update.service" 0644 root:root
  copy_install "$t/pm-cf-update.timer" "/etc/systemd/system/pm-cf-update.timer" 0644 root:root
  run systemctl daemon-reload
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "systemctl enable --now pm-cf-update.timer; pm-cf-update.sh --no-restart (ufw 443 только для CIDR Cloudflare: CF_ONLY_443=$CF_ONLY_443)"
    return 0
  fi
  systemctl enable --now pm-cf-update.timer >/dev/null 2>&1 || true
  /usr/local/sbin/pm-cf-update.sh --no-restart || print_warning "pm-cf-update.sh завершился с ошибкой (см. journalctl -u pm-cf-update)"
}

relay_install_units() {
  print_header "systemd: relay"
  local t="$SCRIPT_DIR/templates"
  copy_install "$t/phantom-messenger.service" "/etc/systemd/system/${PM_SERVICE}.service" 0644 root:root
  copy_install "$t/phantom-messenger-10-hardening.conf" "/etc/systemd/system/${PM_SERVICE}.service.d/10-hardening.conf" 0644 root:root
  copy_install "$t/phantom-messenger-30-lognamespace.conf" "/etc/systemd/system/${PM_SERVICE}.service.d/30-lognamespace.conf" 0644 root:root
  copy_install "$t/pm-healthcheck.sh" "/usr/local/sbin/pm-healthcheck.sh" 0750 root:root
  copy_install "$t/pm-healthcheck.service" "/etc/systemd/system/pm-healthcheck.service" 0644 root:root
  copy_install "$t/pm-healthcheck.timer" "/etc/systemd/system/pm-healthcheck.timer" 0644 root:root
  run systemctl daemon-reload
}

# Запуск relay и health-gate; при провале на повторной установке — откат env.
relay_start() {
  print_header "Запуск relay"
  local prev_env="${1:-}"
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "systemctl enable $PM_SERVICE; systemctl restart $PM_SERVICE; ждать /api/health и /api/config до 30 с"
    plan "systemctl enable --now pm-healthcheck.timer"
    return 0
  fi
  systemctl enable "$PM_SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$PM_SERVICE"
  if wait_health 30; then
    print_success "relay отвечает (/api/health, /api/config)"
    systemctl enable --now pm-healthcheck.timer >/dev/null 2>&1 || true
    return 0
  fi
  print_error "relay не ответил за 30 с. Журнал:"
  relay_journal 30 >&2
  if [[ -n "$prev_env" && -f "$prev_env" ]]; then
    print_warning "Возвращаю прежний env: $prev_env"
    install -m 0640 -o root -g "$PM_USER" "$prev_env" "$PM_ENV_FILE"
    systemctl restart "$PM_SERVICE" || true
    if wait_health 20; then print_warning "Прежняя конфигурация восстановлена и работает"; fi
  fi
  exit 1
}

# Поле error ответа сервиса номеров (недоверенный ввод, stdin): верхний уровень или detail.error (HTTPException FastAPI).
# В вывод - только безопасные символы, не более 64 (как autoreg_clean); фильтр в Python - без SIGPIPE под pipefail.
relay_key_error() {
  python3 -I -c '
import json, re, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = None
v = None
if isinstance(d, dict):
    v = d.get("error")
    if not isinstance(v, str) and isinstance(d.get("detail"), dict):
        v = d["detail"].get("error")
print(re.sub(r"[^A-Za-z0-9_.-]", "", v)[:64] if isinstance(v, str) else "")
' 2>/dev/null || true
}

# Решение по ответу проверки ключа (чистая функция, без сети и без побочных эффектов):
#   key_check_decision <источник ключа> <HTTP-код> <error> <no_autoregister 0|1>
# Источник: selfhost (ключ авторегистрации из install.conf) | manual | fresh (ключ только что выдан авторегистрацией).
# Печатает действие: ok | reregister | rejected | noautoreg | disabled | limited | unreachable | unexpected.
# 401/403 сервис отдаёт и для отозванного/снятого, и для заблокированного сервера (неразличимо); ключ авторегистрации
# в этом случае перерегистрируется (заблокированному домену сервис откажет на verify), ручной ключ молча не подменяется.
key_check_decision() {
  local src="$1" http="$2" err="$3" no_autoreg="${4:-0}"
  case "$http" in
    422|400) echo ok ;;
    401|403)
      if [[ "$src" != "selfhost" ]]; then echo rejected
      elif [[ "$no_autoreg" == "1" ]]; then echo noautoreg
      else echo reregister; fi ;;
    503) if [[ "$err" == "selfhost_disabled" ]]; then echo disabled; else echo unexpected; fi ;;
    429) echo limited ;;
    000) echo unreachable ;;
    *)   echo unexpected ;;
  esac
}

# Проверка ключа сервиса номеров: POST /api/verify-code с пустым телом.
#   422 — ключ принят; 401/403 — ключ неверен/отозван (ключ авторегистрации → AUTOREG_NEEDED=1); прочее — предупреждение.
# Аргумент: источник ключа (по умолчанию KEY_SOURCE); после только что выполненной авторегистрации — fresh.
relay_check_service_key() {
  local -; set +x
  local src="${1:-$KEY_SOURCE}"
  print_header "Проверка ключа сервиса номеров"
  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ -z "$SERVICE_KEY" ]]; then plan "проверка ключа - после авторегистрации"; else
      plan "POST ${API_BASE}/api/verify-code {} с заголовком ${PM_SERVICE_KEY_HEADER} (ключ — через stdin curl, не в argv) → ожидается 422"
      [[ "$src" != "selfhost" ]] || plan "ответ 401/403 (ключ авторегистрации отозван: сервер снят с регистрации или ключ сменён) → регистрация заново после выпуска TLS"; fi
    return 0
  fi
  if [[ -z "$SERVICE_KEY" ]]; then
    print_info "Ключа сервиса номеров пока нет (его выдаст авторегистрация или он не задан)"
    return 0
  fi
  if [[ "$SKIP_KEY_CHECK" == "1" ]]; then
    print_warning "Проверка ключа пропущена (--skip-key-check)"
    return 0
  fi
  local out code err
  out="$(printf 'header = "%s: %s"\n' "$PM_SERVICE_KEY_HEADER" "$SERVICE_KEY" | \
    curl -sS -m 15 -w $'\n%{http_code}' -K - -H 'Content-Type: application/json' \
      -X POST --data '{}' "${API_BASE}/api/verify-code" 2>/dev/null)" || out=$'\n000'
  code="${out##*$'\n'}"
  [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
  err="$(printf '%s' "${out%$'\n'*}" | relay_key_error)"
  case "$(key_check_decision "$src" "$code" "$err" "${NO_AUTOREGISTER:-0}")" in
    ok)          print_success "Ключ принят сервисом номеров (HTTP $code)" ;;
    reregister)  print_warning "Ключ сервиса номеров отозван (сервер снят с регистрации или ключ сменён, HTTP $code) — регистрирую сервер заново (новый ключ — после выпуска TLS)"
                 KEY_REVOKED=1; AUTOREG_NEEDED=1 ;;
    noautoreg)   die "Сервис номеров отклонил ключ авторегистрации (HTTP $code): он отозван (сервер снят с регистрации или ключ сменён). Запустите установку без --no-autoregister - сервер зарегистрируется заново." ;;
    rejected)    [[ "$src" != "fresh" ]] || die "Сервис номеров отклонил только что выданный ключ (HTTP $code). Напишите на admin@phantommessenger.org и укажите домен."
                 die "Сервис номеров отклонил ключ (HTTP $code): ключ неверен, отозван или не активирован. Повторите с верным ключом." ;;
    disabled)    print_error "Сервис номеров сейчас не принимает сторонние серверы (выключено владельцем сервиса, HTTP 503 selfhost_disabled): вход по кодам на этом сервере не работает, ключ сохранён. Вопросы: admin@phantommessenger.org" ;;
    limited)     print_warning "Сервис номеров ответил 429 (лимит) — ключ не проверен, продолжаю" ;;
    unreachable) print_warning "Сервис номеров недоступен ($API_BASE) — ключ не проверен, продолжаю" ;;
    *)           print_warning "Неожиданный ответ сервиса номеров: HTTP $code${err:+ $err} — ключ не проверен" ;;
  esac
}
