#!/usr/bin/env bash
# Phantom Messenger — загрузчик установщика собственного сервера (одна команда на новом сервере).
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/newzealandgrom/phantommessenger/main/selfhost/get.sh)" -- [флаги install.sh]
# Без флагов install.sh сам задаст вопросы (домен, почта, режим TLS, данные оператора).
# Именно bash -c "$(curl ...)", а не `curl | bash`: stdin остаётся терминалом, и вопросы работают.
#
# Что делает: скачивает ПОСЛЕДНИЙ релиз с GitHub Releases (phantom-selfhost.tar.gz, SHA256SUMS, SHA256SUMS.sig) во временный
# каталог 0700, проверяет подпись SHA256SUMS ВСТРОЕННЫМ в этот файл ключом владельца проекта (ssh-keygen -Y verify,
# namespace phantom-selfhost) и сверяет его отпечаток, затем SHA-256 архива и пути внутри tar. Любая ошибка - остановка.
# Режима «без проверки подписи» здесь нет, подменить адрес релиза или ключ через окружение тоже нельзя: константы ниже
# неизменяемы (тесты подставляют свои значения sed-ом в собственную копию файла). Дальше - install.sh с --signer-fingerprint.
# Исходники лежат в /opt/phantom-selfhost-src/<версия>/ (каталог root; install.sh при повторном запуске ждёт архив,
# SHA256SUMS и подпись рядом с каталогом пакета - они лежат там же).
set -euo pipefail
umask 077

REPO="newzealandgrom/phantommessenger"
RELEASE_BASE="https://github.com/${REPO}/releases/latest/download"
PROTO="=https"
STABLE_NAME="phantom-selfhost.tar.gz"
SRC_ROOT="/opt/phantom-selfhost-src"
# Публичный ключ подписи релизов (тот же, что в selfhost/allowed_signers) и его отпечаток.
SIGNER_LINE='phantom-release namespaces="phantom-selfhost" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPou3Hmk957h7nid4gK7GVpBBWWpxjCvVRgezwBOqWEF'
SIGNER_FP="SHA256:SJIk2s8G8DM1FTJP4KB7gVfqU+oVBvk+PhwZMtpFMkY"

if [[ -t 1 ]]; then R=$'\033[0;31m'; G=$'\033[0;32m'; N=$'\033[0m'; else R=""; G=""; N=""; fi
info() { printf '%s[i]%s %s\n' "$G" "$N" "$*"; }
die()  { printf '%s[x]%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# Всё выполняется внутри функции, которая читается целиком до запуска: при `curl | bash` скрипт читается из stdin, а
# ниже stdin подменяется терминалом (exec 0</dev/tty) - иначе bash продолжил бы читать СКРИПТ с терминала.
main() {
  # ── Среда ─────────────────────────────────────────────────────────────────────────────────────
  [[ "$EUID" -eq 0 ]] || die "Запустите от root: sudo bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/${REPO}/main/selfhost/get.sh)\" -- [флаги]"
  os_id=""; os_ver=""
  # shellcheck disable=SC1091
  if [[ -r /etc/os-release ]]; then
    os_id="$(. /etc/os-release; echo "${ID:-}")"; os_ver="$(. /etc/os-release; echo "${VERSION_ID:-}")"
  fi
  case "${os_id}:${os_ver}" in
    ubuntu:22.04|ubuntu:24.04|ubuntu:26.04) ;;
    *) die "Поддерживаются Ubuntu 22.04, 24.04 и 26.04 LTS (найдено: ${os_id:-?} ${os_ver:-?})" ;;
  esac
  # Флаги, ослабляющие проверку, здесь недопустимы: подпись проверяет сам загрузчик.
  for a in "$@"; do
    case "$a" in
      --allow-unsigned) die "get.sh всегда проверяет подпись релиза: --allow-unsigned не поддерживается" ;;
      --signer-fingerprint|--signer-fingerprint=*) die "get.sh сам передаёт --signer-fingerprint (отпечаток зашит в загрузчик)" ;;
    esac
  done
  need=()
  command -v curl >/dev/null 2>&1 || need+=(curl ca-certificates)
  command -v ssh-keygen >/dev/null 2>&1 || need+=(openssh-client)
  command -v tar >/dev/null 2>&1 || need+=(tar)
  command -v sha256sum >/dev/null 2>&1 || need+=(coreutils)
  if (( ${#need[@]} )); then
    info "Ставлю недостающее: ${need[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${need[@]}"
  fi

  TMP="$(mktemp -d /var/tmp/pm-get.XXXXXX)"; chmod 0700 "$TMP"
  trap 'rm -rf "$TMP"' EXIT

  # ── Отпечаток встроенного ключа ──────────────────────────────────────────────────────────────
  SIGNERS="$TMP/allowed_signers"
  printf '%s\n' "$SIGNER_LINE" > "$SIGNERS"
  got_fp="$(awk '{for (i = 1; i <= NF; i++) if ($i ~ /^(ssh-|sk-|ecdsa-)/) {print $i " " $(i+1); exit}}' "$SIGNERS" | ssh-keygen -lf - 2>/dev/null | awk '{print $2; exit}' || true)"
  [[ -n "$got_fp" ]] || die "Встроенный ключ подписи не читается"
  [[ "$got_fp" == "$SIGNER_FP" ]] || die "Отпечаток ключа подписи ($got_fp) не совпал с ожидаемым ($SIGNER_FP) - остановка"
  info "Ключ подписи релизов: $got_fp"

  # ── Скачивание ───────────────────────────────────────────────────────────────────────────────
  # Ретраи - только на сетевые сбои и 408/429/5xx (без --retry-all-errors: 404 = «нет релиза», повторять бессмысленно).
  # Вместо жёсткого общего таймаута - обрыв при < 1 КиБ/с дольше 60 с; -m - верхняя граница одной попытки.
  dl() { # dl <имя> <лимит байт>
    curl -fsSL --proto "$PROTO" --tlsv1.2 --max-redirs 5 --connect-timeout 20 --speed-limit 1024 --speed-time 60 -m 1800 \
      --retry 3 --retry-delay 2 --retry-connrefused --max-filesize "$2" -o "$TMP/$1" "$RELEASE_BASE/$1" \
      || die "Не удалось скачать $RELEASE_BASE/$1 (нет релиза, сеть или GitHub недоступен)"
  }
  info "Скачиваю последний релиз ($RELEASE_BASE)"
  dl SHA256SUMS 65536
  dl SHA256SUMS.sig 16384
  dl "$STABLE_NAME" 209715200

  # ── Подпись, хеш, пути ───────────────────────────────────────────────────────────────────────
  ssh-keygen -Y verify -f "$SIGNERS" -I phantom-release -n phantom-selfhost -s "$TMP/SHA256SUMS.sig" < "$TMP/SHA256SUMS" >/dev/null 2>&1 \
    || die "Подпись SHA256SUMS НЕ прошла проверку встроенным ключом - установка остановлена"
  info "Подпись релиза верна"
  want="$(awk -v f="$STABLE_NAME" '{n=$2; sub(/^\*/, "", n)} n == f {print $1; exit}' "$TMP/SHA256SUMS")"
  have="$(sha256sum "$TMP/$STABLE_NAME" | awk '{print $1}')"
  [[ "$want" =~ ^[0-9a-f]{64}$ && "$want" == "$have" ]] || die "SHA-256 архива не совпал с подписанным SHA256SUMS - архив подменён или повреждён"
  info "SHA-256 архива совпал с подписанным"

  top=""
  while IFS= read -r m; do
    case "$m" in /*|*..*) die "Небезопасный путь в архиве: $m" ;; esac
    t="${m%%/*}"
    if [[ -z "$top" ]]; then top="$t"; fi
    [[ "$t" == "$top" ]] || die "В архиве больше одного верхнего каталога"
  done < <(tar -tzf "$TMP/$STABLE_NAME")
  [[ "$top" =~ ^phantom-selfhost-[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || die "Неожиданное имя каталога в архиве: ${top:-пусто}"
  if tar -tvzf "$TMP/$STABLE_NAME" | cut -c1 | grep -qE '[lhcbp]'; then die "В архиве есть ссылки или специальные файлы - отказ"; fi
  VER="${top#phantom-selfhost-}"

  umask 022      # файлы пакета в /opt - читаемые, как в обычной распаковке
  # ── Размещение ───────────────────────────────────────────────────────────────────────────────
  # /opt/phantom-selfhost-src/<версия>/: каталог root (не домашний каталог, не /tmp), по версиям, чтобы SHA256SUMS разных
  # релизов не смешивались; рядом с каталогом пакета - архив под ожидаемым install.sh именем, SHA256SUMS и подпись.
  DEST="$SRC_ROOT/$VER"
  install -d -m 0755 -o root -g root "$SRC_ROOT"
  rm -rf "$DEST"
  install -d -m 0755 -o root -g root "$DEST"
  tar -xzf "$TMP/$STABLE_NAME" -C "$DEST" --no-same-owner --no-same-permissions
  install -m 0644 "$TMP/$STABLE_NAME" "$DEST/$top.tar.gz"
  install -m 0644 "$TMP/SHA256SUMS" "$DEST/SHA256SUMS"
  install -m 0644 "$TMP/SHA256SUMS.sig" "$DEST/SHA256SUMS.sig"
  [[ -x "$DEST/$top/install.sh" ]] || chmod 0755 "$DEST/$top/install.sh"
  info "Релиз $VER распакован в $DEST/$top"

  # Вопросы install.sh читают stdin: при `curl | bash` stdin - не терминал, берём /dev/tty, если он есть.
  if [[ ! -t 0 ]] && ( : < /dev/tty ) 2>/dev/null; then exec 0< /dev/tty; fi

  cd "$DEST/$top"
  rc=0
  ./install.sh --signer-fingerprint "$SIGNER_FP" "$@" || rc=$?
  exit "$rc"
}

main "$@"
