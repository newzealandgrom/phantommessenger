# shellcheck shell=bash
# shellcheck disable=SC2154,SC2034
# Общие функции установщика Phantom Messenger (selfhost). Подключается через source.
# Не запускать напрямую.

# Тесты в песочнице (только не-root!): PM_TEST_ROOT=<каталог> переносит все пути под префикс.
# Для root переменная игнорируется, поэтому реальную установку подменить ею нельзя.
if [[ -n "${PM_TEST_ROOT:-}" && "$EUID" -ne 0 ]]; then
  PM_ROOT_PREFIX="${PM_TEST_ROOT%/}"
else
  PM_ROOT_PREFIX=""; PM_TEST_ROOT=""
fi
PM_SERVICE="phantom-messenger"
PM_USER="phantom"
PM_OPT="${PM_ROOT_PREFIX}/opt/phantom-messenger"
PM_ETC="${PM_ROOT_PREFIX}/etc/phantom-messenger"
PM_ENV_FILE="${PM_ETC}/env"
PM_CONF_FILE="${PM_ETC}/install.conf"
PM_OPERATOR_FILE="${PM_ETC}/operator.json"
PM_SSL_DIR="${PM_ETC}/ssl"
PM_CF_IPS_FILE="${PM_ETC}/cf-ips.txt"
PM_USER_MARKER="${PM_ETC}/.created-user"
PM_STATE_DIR="${PM_ROOT_PREFIX}/var/lib/phantom-messenger"
PM_NGINX_CONF="${PM_ROOT_PREFIX}/etc/nginx/conf.d/phantom-messenger.conf"
PM_ACME_ROOT="${PM_ROOT_PREFIX}/var/www/acme"
PM_LOCAL_URL="http://127.0.0.1:8444"
[[ -z "$PM_TEST_ROOT" ]] || PM_LOCAL_URL="${PM_LOCAL_URL_TEST:-$PM_LOCAL_URL}"
# Адрес сервиса номеров (коды входа). Владелец подтверждает перед выпуском релиза.
PM_DEFAULT_API_BASE="https://phantomnumbers.org"
# Заголовок ключа интеграции сервиса номеров (сервис отвечает 401 api_key_missing с подсказкой X-API-Key).
PM_SERVICE_KEY_HEADER="X-API-Key"
PM_KEEP_BACKUPS=3

if [[ -t 1 ]]; then
  C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[1;33m'; C_BLU=$'\033[0;34m'; C_NC=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_NC=""
fi

print_header()  { printf '\n%s== %s ==%s\n' "$C_BLU" "$*" "$C_NC"; }
print_info()    { printf '%s[i]%s %s\n' "$C_BLU" "$C_NC" "$*"; }
print_success() { printf '%s[ok]%s %s\n' "$C_GRN" "$C_NC" "$*"; }
print_warning() { printf '%s[!]%s %s\n' "$C_YEL" "$C_NC" "$*" >&2; }
print_error()   { printf '%s[x]%s %s\n' "$C_RED" "$C_NC" "$*" >&2; }
die()           { print_error "$*"; exit 1; }

# DRY_RUN=1: действия только печатаются.
DRY_RUN="${DRY_RUN:-0}"

# run <команда...> — выполнить или (dry-run) напечатать.
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '%s[dry-run]%s %s\n' "$C_YEL" "$C_NC" "$*"
    return 0
  fi
  "$@"
}

# plan <текст> — строка плана (всегда печатается в dry-run).
plan() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '%s[dry-run]%s %s\n' "$C_YEL" "$C_NC" "$*"
  fi
}

require_root() {
  [[ -z "$PM_TEST_ROOT" ]] || return 0
  if [[ "$EUID" -ne 0 ]]; then
    die "Запустите от root: sudo $0"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# ── Контрольные суммы (Linux: sha256sum, macOS: shasum) ─────────────────
sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# verify_manifest <каталог> <файл-манифест> — проверка "<sha256>  <относительный путь>".
verify_manifest() {
  local dir="$1" manifest="$2" line sum path actual bad=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    sum="${line%%  *}"
    path="${line#*  }"
    path="${path#./}"
    case "$path" in /*|*..*) print_error "Недопустимый путь в манифесте: $path"; return 1 ;; esac
    if [[ ! -f "$dir/$path" ]]; then
      print_error "Нет файла из манифеста: $path"; bad=1; continue
    fi
    actual="$(sha256_of "$dir/$path")"
    if [[ "$actual" != "$sum" ]]; then
      print_error "Контрольная сумма не совпала: $path"; bad=1
    fi
  done < "$manifest"
  return "$bad"
}

# ── Валидация ввода (всё, что попадёт в nginx/JSON/env/unit) ────────────
valid_domain() {
  [[ ${#1} -le 253 ]] && [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}
# Правила e-mail и URL совпадают с проверкой operator.json в web (client/src/lib/operatorInfo.ts):
# файл, не прошедший её, веб и приложения игнорируют целиком.
valid_email() {
  [[ ${#1} -le 200 ]] && [[ "$1" =~ ^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}$ ]]
}
# Только https, без userinfo, пробелов, скобок и кавычек; ≤ 200 символов.
valid_https_url() {
  [[ ${#1} -le 200 ]] && [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%/+@:,=?#\&\;!*-]*)?$ ]]
}
valid_https_base() {
  [[ ${#1} -le 200 ]] && [[ "$1" =~ ^https://[a-z0-9.-]+(:[0-9]{1,5})?$ ]]
}
# Свободный текст (имя оператора): без управляющих символов, кавычек, бэкслэшей и $`, а также без
# Unicode-категорий Cf (bidi U+202A-202E/2066-2069, zero-width, BOM, U+061C), Cs (суррогаты),
# Co (private use), Cn (не назначены), Zl/Zp — чтобы имя нельзя было визуально подменить.
valid_text() {
  local s="$1"
  [[ -n "$s" && ${#s} -le 120 ]] || return 1
  [[ "$s" != *[$'\001'-$'\037\177']* ]] || return 1
  [[ "$s" != *[\"\\\`\$\'\<\>\&]* ]] || return 1
  have python3 || return 1
  python3 -I -c '
import sys, unicodedata
bad = {"Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"}
sys.exit(1 if any(unicodedata.category(c) in bad for c in sys.argv[1]) else 0)
' "$s"
}
# Имя оператора попадает в текст страниц /terms, /privacy: дополнительно без [ ] ( ) *.
valid_operator_name() {
  valid_text "$1" && [[ "$1" != *[\[\]\(\)\*]* ]]
}
valid_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local i
  for i in 1 2 3 4; do (( BASH_REMATCH[i] <= 255 )) || return 1; done
}

# ── Подстановка в шаблоны: @@KEY@@ → значение ───────────────────────────
# render_template <шаблон> <выход> [KEY=VAL ...]; значения передаются python через окружение
# (export в subshell), а не через argv — секреты не видны в /proc/*/cmdline.
# Перевод строки в значении запрещён. После подстановки не должно остаться @@.
render_template() {
  local tmpl="$1" out="$2"; shift 2
  local kv key val
  [[ -f "$tmpl" ]] || die "Нет шаблона: $tmpl"
  for kv in "$@"; do
    val="${kv#*=}"
    [[ "$val" != *$'\n'* ]] || die "Значение ${kv%%=*} содержит перевод строки"
  done
  (
    for kv in "$@"; do
      key="${kv%%=*}"; val="${kv#*=}"
      [[ "$key" =~ ^[A-Z0-9_]+$ ]] || exit 3
      export "PMR_${key}=${val}"
    done
    python3 -I -c '
import os, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
def sub(m):
    return os.environ.get("PMR_" + m.group(1), m.group(0))
text = re.sub(r"@@([A-Z0-9_]+)@@", sub, text)
left = sorted(set(re.findall(r"@@[A-Z0-9_]+@@", text)))
if left:
    sys.stderr.write("LEFT:" + " ".join(left) + "\n")
    sys.exit(4)
sys.stdout.write(text)
' "$tmpl" > "$out"
  ) || die "Не удалось отрендерить $tmpl (неподставленные поля или ошибка)"
}

# ── Файлы и бэкапы ──────────────────────────────────────────────────────
# prune_backups <путь> — оставить PM_KEEP_BACKUPS последних <путь>.bak.*
prune_backups() {
  local base="$1" f n=0
  # shellcheck disable=SC2012
  while IFS= read -r f; do
    n=$((n + 1))
    (( n > PM_KEEP_BACKUPS )) && rm -rf -- "$f"
  done < <(ls -1dt "${base}".bak.* 2>/dev/null)
  return 0
}

# install_file <источник> <назначение> <режим> <владелец:группа>
# Если назначение уже есть и отличается — бэкап <назначение>.bak.<ts>.
install_file() {
  local src="$1" dst="$2" mode="$3" owner="$4" ts
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "install -m $mode -o ${owner%%:*} -g ${owner##*:} $(basename "$src") -> $dst"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  if [[ -f "$dst" ]] && ! cmp -s "$src" "$dst"; then
    ts="$(date +%Y%m%d-%H%M%S)"
    cp -a "$dst" "${dst}.bak.${ts}"
    chmod 0600 "${dst}.bak.${ts}"
    prune_backups "$dst"
  fi
  install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dst"
}

# ── Файл env: чтение/запись без sed -i (одинаково на GNU и BSD) ─────────
read_env_value() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || return 0
  awk -F= -v k="$key" '$1 == k {print substr($0, index($0, "=") + 1)}' "$file" | tail -n1
}

# set_env <файл> <ключ> <значение> — значение без перевода строки.
set_env() {
  local file="$1" key="$2" value="$3" tmp
  [[ "$value" != *$'\n'* ]] || die "Значение $key содержит перевод строки"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "Недопустимое имя переменной: $key"
  tmp="$(mktemp)"
  grep -v "^${key}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

# ── apt ─────────────────────────────────────────────────────────────────
wait_for_apt_locks() {
  local timeout="${1:-600}" waited=0
  have fuser || return 0
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || \
        fuser /var/lib/dpkg/lock >/dev/null 2>&1 || \
        fuser /var/lib/apt/lists/lock >/dev/null 2>&1 || \
        fuser /var/cache/apt/archives/lock >/dev/null 2>&1; do
    if (( waited >= timeout )); then
      print_error "Таймаут ожидания блокировок apt/dpkg (${timeout} с)"
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
  return 0
}

apt_install() {
  if [[ "$DRY_RUN" == "1" ]]; then
    plan "apt-get install -y --no-install-recommends $*"
    return 0
  fi
  wait_for_apt_locks 600
  (umask 022; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@")
}

# ── Сеть ────────────────────────────────────────────────────────────────
port_busy() {
  have ss || return 1
  ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
}

# Внешний IPv4: адрес источника маршрута; если он приватный (NAT) — HTTPS-запрос к api.ipify.org.
detect_external_ip() {
  local ip=""
  if have ip; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}')"
  fi
  if [[ -n "$ip" ]] && python3 -c 'import ipaddress, sys; sys.exit(0 if ipaddress.ip_address(sys.argv[1]).is_global else 1)' "$ip" 2>/dev/null; then
    echo "$ip"; return 0
  fi
  ip="$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  if valid_ipv4 "$ip"; then echo "$ip"; fi
}

resolve_a() {
  if have getent; then
    getent ahostsv4 "$1" 2>/dev/null | awk '{print $1; exit}'
  elif have dig; then
    dig +short A "$1" | head -1
  fi
}

# Актуальные CIDR Cloudflare; встроенный список — запасной.
CF_IP_RANGES_FALLBACK="173.245.48.0/20,103.21.244.0/22,103.22.200.0/22,103.31.4.0/22,141.101.64.0/18,108.162.192.0/18,190.93.240.0/20,188.114.96.0/20,197.234.240.0/22,198.41.128.0/17,162.158.0.0/15,104.16.0.0/13,104.24.0.0/14,172.64.0.0/13,131.0.72.0/22,2400:cb00::/32,2606:4700::/32,2803:f800::/32,2405:b500::/32,2405:8100::/32,2a06:98c0::/29,2c0f:f248::/32"
fetch_cf_ranges() {
  local v4 v6 joined
  CF_IP_RANGES="$CF_IP_RANGES_FALLBACK"
  v4="$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v4 2>/dev/null || true)"
  v6="$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v6 2>/dev/null || true)"
  joined="$(printf '%s\n%s\n' "$v4" "$v6" | python3 -c '
import ipaddress, sys
nets = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        nets.append(str(ipaddress.ip_network(line)))
    except ValueError:
        sys.exit(1)
if len(nets) < 10:
    sys.exit(1)
print(",".join(nets))
' 2>/dev/null || true)"
  if [[ -n "$joined" ]]; then
    CF_IP_RANGES="$joined"
    print_info "Cloudflare CIDR: свежий список"
  else
    print_warning "Не удалось получить список Cloudflare по HTTPS — использую встроенный"
  fi
}

# ── Здоровье relay ──────────────────────────────────────────────────────
# wait_health [секунды] — ждёт ok:true от /api/health и /api/config на loopback.
wait_health() {
  local limit="${1:-30}" waited=0
  while (( waited < limit )); do
    if curl -fsS -m 3 "${PM_LOCAL_URL}/api/health" 2>/dev/null | grep -q '"ok":true' && \
       curl -fsS -m 5 "${PM_LOCAL_URL}/api/config" 2>/dev/null | grep -q '"ok":true'; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

relay_journal() {
  journalctl --namespace=phantom -u "$PM_SERVICE" -n "${1:-30}" --no-pager 2>/dev/null || true
}

# Чтение значения из install.conf без выполнения файла (KEY=VALUE, одинарные кавычки не нужны).
conf_get() {
  read_env_value "$1" "$PM_CONF_FILE"
}

# ── Пакет установщика и якорь доверия ────────────────────────────────────
# anchor_has_key <файл allowed_signers> — есть ли непустая, не комментарий строка.
anchor_has_key() {
  [[ -f "$1" ]] && grep -qvE '^[[:space:]]*(#|$)' "$1"
}

# anchor_fingerprint <файл allowed_signers> — SHA256-отпечаток первого ключа (формат allowed_signers с options).
anchor_fingerprint() {
  have ssh-keygen || return 0
  awk '!/^[[:space:]]*(#|$)/ {for (i = 1; i <= NF; i++) if ($i ~ /^(ssh-|sk-|ecdsa-)/) {print $i " " $(i+1); exit}}' "$1" \
    | ssh-keygen -lf - 2>/dev/null | awk '{print $2; exit}'
}

# abs_dir <путь> — абсолютный физический каталог файла/каталога (без realpath, работает на macOS).
abs_dir() {
  local p="$1"
  [[ -d "$p" ]] || p="$(dirname "$p")"
  (cd "$p" 2>/dev/null && pwd -P)
}

# path_inside <файл> <каталог> — лежит ли файл внутри каталога.
path_inside() {
  local d f
  d="$(abs_dir "$2")" || return 1
  f="$(abs_dir "$1")" || return 1
  [[ "$f" == "$d" || "$f" == "$d"/* ]]
}

# install_pkg_scripts <src> <dst> — копирует в dst ТОЛЬКО файлы релиза (по MANIFEST.sha256, без app/;
# без манифеста — по явному списку). Посторонние файлы из каталога архива (ключи, токены) не копируются.
# Установленный якорь allowed_signers (если в нём есть ключ) сохраняется, а не берётся из src.
install_pkg_scripts() {
  local src="$1" dst="$2" line rel keep=""
  if anchor_has_key "$dst/allowed_signers"; then
    keep="$(mktemp)"; cp -p "$dst/allowed_signers" "$keep"
  fi
  rm -rf "$dst"
  install -d -m 0755 "$dst"
  if [[ -f "$src/MANIFEST.sha256" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      rel="${line#*  }"; rel="${rel#./}"
      case "$rel" in app/*|/*|*..*) continue ;; esac
      install -d -m 0755 "$dst/$(dirname "$rel")"
      cp -p "$src/$rel" "$dst/$rel"
    done < "$src/MANIFEST.sha256"
    cp -p "$src/MANIFEST.sha256" "$dst/MANIFEST.sha256"
  else
    for rel in install.sh update.sh uninstall.sh status.sh selftest.sh README.md README.en.md LICENSE VERSION \
               CHANGELOG.md BUILD_INFO allowed_signers lib templates; do
      [[ -e "$src/$rel" ]] && cp -Rp "$src/$rel" "$dst/$rel"
    done
  fi
  chmod -R go-w,u+rwX "$dst"
  if [[ -n "$keep" ]]; then
    cp -p "$keep" "$dst/allowed_signers"; rm -f "$keep"
  fi
}

# verify_sums_signature <anchor> <SHA256SUMS> <SHA256SUMS.sig> — ssh-keygen -Y verify.
verify_sums_signature() {
  have ssh-keygen || die "Нужен ssh-keygen (apt install openssh-client) для проверки подписи релиза"
  ssh-keygen -Y verify -f "$1" -I "phantom-release" -n "phantom-selfhost" -s "$3" < "$2" >/dev/null 2>&1
}

# valid_fingerprint <SHA256:…> — формат отпечатка ssh-keygen -l.
valid_fingerprint() { [[ "$1" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]]; }

# version_older <новая> <установленная> — 0, если новая версия СТРОГО старше установленной (sort -V).
version_older() {
  [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$1" ]]
}

# log_release <действие> — строка в $PM_ETC/releases.log; UNSIGNED_USED=1 помечает установку без подписи.
log_release() {
  local mark=""
  [[ -d "$PM_ETC" ]] || return 0
  [[ "${UNSIGNED_USED:-0}" == "1" ]] && mark=" UNSIGNED"
  printf '%s %s%s\n' "$(date -u +%FT%TZ)" "$1" "$mark" >> "$PM_ETC/releases.log"
}
