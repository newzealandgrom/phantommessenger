#!/usr/bin/env bash
# Обновление установленного сервера из релизного архива.
#   sudo update.sh [--yes] [--allow-unsigned] [--signer-fingerprint SHA256:…] [--require-signature] [--sha256 <hex>] [--force] <phantom-selfhost-X.Y.Z.tar.gz>
#   sudo update.sh --check
# Проверки: архив копируется в защищённый stage (0700) и все проверки идут по копии; SHA256SUMS рядом с
# архивом (или --sha256); подпись SHA256SUMS.sig (ssh-keygen -Y verify) по allowed_signers УСТАНОВЛЕННОГО
# пакета ($PM_OPT/selfhost) — якорь из скачанного архива игнорируется. Если в якоре есть ключ, подпись
# ОБЯЗАТЕЛЬНА (отказ без неё); обойти можно только явным --allow-unsigned. Затем манифест внутри архива. Сохраняются: env, operator.json,
# state, сертификаты. Затем: stage → backend/ + client/dist (+ venv, если изменился lock) →
# py_compile → restart → health-gate 15 с → автооткат при провале.
set -euo pipefail
umask 022
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

ARCHIVE="" ; SHA_EXPECT="" ; ASSUME_YES=0 ; REQUIRE_SIG=0 ; FORCE=0 ; CHECK=0 ; ALLOW_UNSIGNED=0 ; UNSIGNED_USED=0 ; SIGNER_FP=""
# Якорь доверия — только установленный пакет, а не каталог, из которого запущен скрипт.
ALLOWED_SIGNERS="$PM_OPT/selfhost/allowed_signers"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --require-signature) REQUIRE_SIG=1; shift ;;
    --sha256) [[ $# -ge 2 ]] || die "--sha256 требует значение"; SHA_EXPECT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --allow-unsigned) ALLOW_UNSIGNED=1; shift ;;
    --signer-fingerprint) [[ $# -ge 2 ]] || die "--signer-fingerprint требует значение"; SIGNER_FP="$2"; shift 2
                          valid_fingerprint "$SIGNER_FP" || die "--signer-fingerprint: ожидается SHA256:<43 символа base64>" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) die "Неизвестный параметр: $1" ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done

installed_version() { head -n1 "$PM_OPT/VERSION" 2>/dev/null || echo "?"; }

if [[ "$CHECK" == "1" ]]; then
  print_info "Установлена версия: $(installed_version)"
  if [[ -n "${PM_RELEASES_API:-}" ]]; then
    # Например: PM_RELEASES_API=https://api.github.com/repos/<владелец>/<репо>/releases/latest
    tag="$(curl -fsS -m 15 "$PM_RELEASES_API" 2>/dev/null | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("tag_name",""))' || true)"
    if [[ -n "$tag" ]]; then print_info "Последний релиз: $tag"; else print_warning "Не удалось получить $PM_RELEASES_API"; fi
  else
    print_info "Источник релизов не настроен. Скачайте архив вручную и запустите: update.sh <архив>"
    print_info "(по желанию: PM_RELEASES_API=<URL GitHub Releases API> для --check)"
  fi
  exit 0
fi

require_root
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || die "Укажите архив: update.sh <phantom-selfhost-X.Y.Z.tar.gz>"
[[ -d "$PM_OPT/backend" ]] || die "Сервер не установлен ($PM_OPT/backend нет) — используйте install.sh"
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"
ADIR="$(dirname "$ARCHIVE")"; ABASE="$(basename "$ARCHIVE")"

if [[ "$SCRIPT_DIR" != "$PM_OPT/selfhost" ]]; then
  print_warning "update.sh запущен не из установленного пакета ($PM_OPT/selfhost). Якорь доверия (allowed_signers) всё равно берётся из установленного пакета, а не из этого каталога. Надёжнее: sudo $PM_OPT/selfhost/update.sh"
fi
[[ -f "$ALLOWED_SIGNERS" ]] || die "Нет установленного якоря доверия $ALLOWED_SIGNERS — проверить подпись нельзя. Переустановите пакет install.sh из проверенного архива."

# ── 1. Stage (0700): копия архива и контрольных файлов; все проверки — по копии (нет TOCTOU) ──────
STAGE="$(mktemp -d "${TMPDIR:-/var/tmp}/pm-update.XXXXXX")"
chmod 0700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
cp -p "$ARCHIVE" "$STAGE/$ABASE"
[[ -f "$ADIR/SHA256SUMS" ]] && cp -p "$ADIR/SHA256SUMS" "$STAGE/SHA256SUMS"
[[ -f "$ADIR/SHA256SUMS.sig" ]] && cp -p "$ADIR/SHA256SUMS.sig" "$STAGE/SHA256SUMS.sig"
ARCHIVE="$STAGE/$ABASE"

# ── 2. Целостность и подпись ────────────────────────────────────────────
print_header "Проверка архива"
actual="$(sha256_of "$ARCHIVE")"
if [[ -n "$SHA_EXPECT" ]]; then
  [[ "$actual" == "$SHA_EXPECT" ]] || die "SHA-256 архива не совпал с --sha256"
  print_success "SHA-256 совпал с указанным"
elif [[ -f "$STAGE/SHA256SUMS" ]]; then
  expected="$(awk -v f="$ABASE" '{n=$2; sub(/^\*/, "", n)} n == f {print $1; exit}' "$STAGE/SHA256SUMS")"
  [[ -n "$expected" ]] || die "В SHA256SUMS нет строки для $ABASE"
  [[ "$actual" == "$expected" ]] || die "SHA-256 архива не совпал с SHA256SUMS — архив повреждён или подменён"
  print_success "SHA-256 совпал с SHA256SUMS"
else
  die "Нет SHA256SUMS рядом с архивом и не задан --sha256: целостность не проверить"
fi

if [[ -n "$SIGNER_FP" ]]; then
  anchor_has_key "$ALLOWED_SIGNERS" || die "--signer-fingerprint указан, но в установленном allowed_signers нет ключа"
  fp="$(anchor_fingerprint "$ALLOWED_SIGNERS")"
  [[ "$fp" == "$SIGNER_FP" ]] || die "Отпечаток установленного ключа подписи ($fp) не совпадает с --signer-fingerprint ($SIGNER_FP) — обновление отменено"
  print_success "Отпечаток ключа подписи совпал с --signer-fingerprint"
fi
if anchor_has_key "$ALLOWED_SIGNERS"; then
  # В якоре есть ключ владельца релизов: подпись обязательна.
  if [[ -f "$STAGE/SHA256SUMS.sig" && -f "$STAGE/SHA256SUMS" ]]; then
    verify_sums_signature "$ALLOWED_SIGNERS" "$STAGE/SHA256SUMS" "$STAGE/SHA256SUMS.sig" \
      || die "Подпись SHA256SUMS НЕ прошла проверку по установленному ключу — обновление отменено"
    sig_expected="$(awk -v f="$ABASE" '{n=$2; sub(/^\*/, "", n)} n == f {print $1; exit}' "$STAGE/SHA256SUMS")"
    [[ -n "$sig_expected" && "$actual" == "$sig_expected" ]] || die "Архив не совпадает с хешем в ПОДПИСАННОМ SHA256SUMS — обновление отменено"
    print_success "Подпись релиза верна (ssh-keygen -Y verify, ключ установленного пакета), архив совпадает с подписанным SHA256SUMS"
  elif [[ "$ALLOW_UNSIGNED" == "1" && -z "$SIGNER_FP" ]]; then
    UNSIGNED_USED=1
    print_warning "!!! --allow-unsigned: обновление БЕЗ проверки подписи. Проверена только контрольная сумма (целостность), подлинность релиза НЕ проверена — вы запускаете чужой код от root."
  elif [[ -n "$SIGNER_FP" ]]; then
    die "Указан --signer-fingerprint, но подписи SHA256SUMS.sig нет — проверить нельзя (--allow-unsigned с ним несовместим)"
  else
    die "Нет подписи SHA256SUMS.sig (или SHA256SUMS) рядом с архивом: релизы подписываются всегда, обновление без подписи отклонено. Явный опт-аут: --allow-unsigned (небезопасно)."
  fi
else
  [[ "$REQUIRE_SIG" == "1" ]] && die "В установленном $ALLOWED_SIGNERS нет ключа подписи — проверить подпись нельзя (--require-signature)"
  print_warning "В установленном пакете нет ключа подписи релизов — подлинность архива не проверяется (только SHA-256)"
fi

# ── 3. Распаковка копии ─────────────────────────────────────────────────
mkdir "$STAGE/x"
while IFS= read -r member; do
  case "$member" in /*|*..*) die "Небезопасный путь в архиве: $member" ;; esac
done < <(tar -tzf "$ARCHIVE")
tar -xzf "$ARCHIVE" -C "$STAGE/x" --no-same-owner --no-same-permissions
NEW="$(find "$STAGE/x" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[[ -n "$NEW" && -f "$NEW/MANIFEST.sha256" && -d "$NEW/app/backend" ]] || die "Архив не похож на релиз phantom-selfhost"
verify_manifest "$NEW" "$NEW/MANIFEST.sha256" || die "Манифест архива не сходится"
print_success "Манифест архива сходится"
# Якорь из архива не принимается: показываем отпечаток, если он отличается от установленного.
if anchor_has_key "$NEW/allowed_signers" && have ssh-keygen && ! cmp -s "$NEW/allowed_signers" "$ALLOWED_SIGNERS"; then
  print_warning "Ключ подписи в архиве ($(anchor_fingerprint "$NEW/allowed_signers")) отличается от установленного — он НЕ применяется. Смена ключа — только вручную после независимой сверки отпечатка."
fi

OLD_V="$(installed_version)"; NEW_V="$(head -n1 "$NEW/VERSION")"
print_info "Версия: $OLD_V → $NEW_V"
if [[ "$FORCE" != "1" && "$OLD_V" != "?" && "$OLD_V" != "$NEW_V" ]] && \
   [[ "$(printf '%s\n%s\n' "$OLD_V" "$NEW_V" | sort -V | head -n1)" == "$NEW_V" ]]; then
  die "Новая версия не новее установленной (используйте --force для понижения)"
fi
if [[ "$ASSUME_YES" != "1" && -t 0 ]]; then
  a=""
  read -r -p "Установить $NEW_V? Relay будет перезапущен (сессии и offline-очередь в RAM сбросятся). [y/N]: " a || true
  [[ "$a" =~ ^[YyДд] ]] || die "Отменено"
fi

# ── 3. Применение с откатом ─────────────────────────────────────────────
TS="$(date +%Y%m%d-%H%M%S)"
BK_BACKEND="$PM_OPT/backend.bak.$TS"; BK_DIST="$PM_OPT/client/dist.bak.$TS"; BK_VENV=""
BK_LOCK="$PM_OPT/requirements.lock.bak.$TS"
rollback() {
  print_error "Откат на версию $OLD_V…"
  systemctl stop "$PM_SERVICE" || true
  if [[ -d "$BK_BACKEND" ]]; then rm -rf "$PM_OPT/backend"; mv "$BK_BACKEND" "$PM_OPT/backend"; fi
  if [[ -d "$BK_DIST" ]]; then rm -rf "$PM_OPT/client/dist"; mv "$BK_DIST" "$PM_OPT/client/dist"; fi
  if [[ -n "$BK_VENV" && -d "$BK_VENV" ]]; then rm -rf "$PM_OPT/venv"; mv "$BK_VENV" "$PM_OPT/venv"; fi
  [[ -f "$BK_LOCK" ]] && mv -f "$BK_LOCK" "$PM_OPT/requirements.lock"
  systemctl start "$PM_SERVICE" || true
  if wait_health 20; then print_warning "Откат выполнен, relay работает на $OLD_V"; else print_error "После отката relay не отвечает: journalctl --namespace=phantom -u $PM_SERVICE"; fi
  log_release "update $OLD_V -> $NEW_V ROLLBACK"
  exit 1
}

print_header "Применение"
mv "$PM_OPT/backend" "$BK_BACKEND"
mv "$PM_OPT/client/dist" "$BK_DIST"
cp -a "$PM_OPT/requirements.lock" "$BK_LOCK"
cp -a "$NEW/app/backend" "$PM_OPT/backend"
cp -a "$NEW/app/client/dist" "$PM_OPT/client/dist"
cp -a "$NEW/app/scripts/turn_selftest.py" "$PM_OPT/scripts/turn_selftest.py"
find "$PM_OPT/backend" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
[[ -f "$PM_OPERATOR_FILE" ]] && install -m 0644 -o root -g root "$PM_OPERATOR_FILE" "$PM_OPT/client/dist/operator.json"

if ! cmp -s "$NEW/app/requirements.lock" "$PM_OPT/requirements.lock"; then
  print_info "requirements.lock изменился — пересоздаю venv (--require-hashes)"
  BK_VENV="$PM_OPT/venv.bak.$TS"
  mv "$PM_OPT/venv" "$BK_VENV"
  cp -a "$NEW/app/requirements.lock" "$PM_OPT/requirements.lock"
  if ! "$(pm_find_python || echo python3)" -m venv "$PM_OPT/venv" || ! "$PM_OPT/venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check \
       --require-hashes --only-binary=:all: -r "$PM_OPT/requirements.lock"; then
    print_error "pip не смог установить зависимости по хешам"
    rollback
  fi
  sha256_of "$PM_OPT/requirements.lock" > "$PM_OPT/venv/.lock.sha"
fi

if ! "$PM_OPT/venv/bin/python" -m py_compile "$PM_OPT/backend/config.py" "$PM_OPT/backend/main.py" "$PM_OPT/backend/mesh.py"; then
  print_error "py_compile не прошёл"
  rollback
fi
find "$PM_OPT/backend" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

systemctl restart "$PM_SERVICE"
if ! wait_health 15; then
  print_error "Health-gate не пройден за 15 с. Журнал:"
  relay_journal 30 >&2
  rollback
fi
print_success "relay отвечает на версии $NEW_V"

# Версия и скрипты пакета (templates применяются только повторным запуском install.sh).
cp -a "$NEW/VERSION" "$PM_OPT/VERSION"
[[ -f "$NEW/BUILD_INFO" ]] && cp -a "$NEW/BUILD_INFO" "$PM_OPT/BUILD_INFO"
# Пакет установщика: только файлы релиза (по MANIFEST), установленный якорь allowed_signers сохраняется.
install_pkg_scripts "$NEW" "$PM_OPT/selfhost"
chown -R root:root "$PM_OPT"; chmod -R u=rwX,go=rX "$PM_OPT"
log_release "update $OLD_V -> $NEW_V OK sha256=$actual"

prune_backups "$PM_OPT/backend"; prune_backups "$PM_OPT/client/dist"; prune_backups "$PM_OPT/venv"; prune_backups "$PM_OPT/requirements.lock"
print_info "Бэкапы предыдущей версии: $PM_OPT/backend.bak.*, $PM_OPT/client/dist.bak.* (хранится $PM_KEEP_BACKUPS последних)"
print_info "Если в релизе изменились шаблоны nginx/systemd/coturn — примените их: sudo $PM_OPT/selfhost/install.sh (параметры возьмутся из $PM_CONF_FILE)"
