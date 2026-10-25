#!/usr/bin/env bash
# Сборщик релиза «свой сервер Phantom Messenger» (selfhost/).
#   scripts/build-selfhost-release.sh [--out DIR] [--version X.Y.Z] [--skip-client-build] [--sign-key FILE] [--allow-dirty]
# Выход (DIR, по умолчанию ./dist-selfhost):
#   phantom-selfhost-<ver>.tar.gz   — пакет (selfhost/ + app/{backend,client/dist,requirements.lock,scripts/turn_selftest.py})
#   SHA256SUMS                      — контрольная сумма архива
#   SHA256SUMS.sig                  — подпись ssh-keygen -Y sign -n phantom-selfhost (если задан --sign-key)
# В архив НЕ попадают: .env, data/, state.json, SECURITY_AUDIT.md, тесты, внутренняя документация, секреты.
# Гейт: чистое git-дерево для backend/ client/ selfhost/ requirements.lock (PM_ALLOW_DIRTY=1 или --allow-dirty
# снимает гейт; в BUILD_INFO пишется dirty=1).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist-selfhost"
VERSION=""
SKIP_BUILD=0
SIGN_KEY=""
ALLOW_DIRTY="${PM_ALLOW_DIRTY:-0}"
SIG_NAMESPACE="phantom-selfhost"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) [[ $# -ge 2 ]] || { echo "--out требует значение" >&2; exit 2; }; OUT="$2"; shift 2 ;;
    --version) [[ $# -ge 2 ]] || { echo "--version требует значение" >&2; exit 2; }; VERSION="$2"; shift 2 ;;
    --skip-client-build) SKIP_BUILD=1; shift ;;
    --sign-key) [[ $# -ge 2 ]] || { echo "--sign-key требует значение" >&2; exit 2; }; SIGN_KEY="$2"; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ОШИБКА: $*" >&2; exit 1; }
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

cd "$ROOT"
[[ -f selfhost/install.sh && -f selfhost/VERSION ]] || die "нет selfhost/ — запускайте из репозитория"
[[ -n "$VERSION" ]] || VERSION="$(head -n1 selfhost/VERSION)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || die "некорректная версия: $VERSION"
[[ -n "$SIGN_KEY" && ! -r "$SIGN_KEY" ]] && die "не читается ключ подписи: $SIGN_KEY"

# ── Гейт чистого git ────────────────────────────────────────────────────
DIRTY=0
COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo none)"
if [[ -n "$(git status --porcelain -- backend client selfhost requirements.lock scripts/turn_selftest.py 2>/dev/null)" ]]; then
  DIRTY=1
  if [[ "$ALLOW_DIRTY" != "1" ]]; then
    git status --short -- backend client selfhost requirements.lock scripts/turn_selftest.py | head -20 >&2
    die "незакоммиченные изменения в релизных путях: закоммитьте или запустите с PM_ALLOW_DIRTY=1"
  fi
  echo "!!! PM_ALLOW_DIRTY=1: сборка из незакоммиченного дерева (commit $COMMIT + изменения)" >&2
fi

# ── Веб-клиент ──────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" != "1" ]]; then
  (cd client && npm ci && npm run build)
fi
[[ -f client/dist/index.html ]] || die "нет client/dist/index.html (соберите клиент без --skip-client-build)"

# ── Stage ───────────────────────────────────────────────────────────────
NAME="phantom-selfhost-${VERSION}"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/pm-selfhost-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/$NAME"
mkdir -p "$PKG/app/backend" "$PKG/app/client" "$PKG/app/scripts"

# Установщик (selfhost/ без app/ и мусора).
(cd selfhost && find . -type f ! -path './app/*' ! -name '.DS_Store' ! -name '.shellcheckrc' ! -name '*.bak' ! -name '*.bak.*' ! -name '*.swp' -print0 \
  | while IFS= read -r -d '' f; do mkdir -p "$PKG/$(dirname "$f")"; cp -p "$f" "$PKG/$f"; done)
echo "$VERSION" > "$PKG/VERSION"

# Relay: только исходники из явного списка.
for f in __init__.py config.py main.py mesh.py; do
  [[ -f "backend/$f" ]] || die "нет backend/$f"
  cp -p "backend/$f" "$PKG/app/backend/$f"
done
cp -p requirements.lock "$PKG/app/requirements.lock"
cp -p scripts/turn_selftest.py "$PKG/app/scripts/turn_selftest.py"
cp -Rp client/dist "$PKG/app/client/dist"
find "$PKG" \( -name '.DS_Store' -o -name '__pycache__' -o -name '*.pyc' -o -name '*.map' \) -prune -exec rm -rf {} + 2>/dev/null || true
# Каталог фактических прав: файлы 0644, каталоги и скрипты 0755.
find "$PKG" -type d -exec chmod 0755 {} +
find "$PKG" -type f -exec chmod 0644 {} +
chmod 0755 "$PKG"/install.sh "$PKG"/update.sh "$PKG"/uninstall.sh "$PKG"/status.sh "$PKG"/selftest.sh \
  "$PKG"/lib/*.sh "$PKG"/templates/pm-healthcheck.sh "$PKG"/templates/pm-cf-update.sh "$PKG"/templates/certbot-hook-nginx.sh

# Воспроизводимость: в BUILD_INFO нет текущего времени. Дата сборки — SOURCE_DATE_EPOCH, если задан;
# иначе дата релиза из CHANGELOG.md (строка "## <версия> ... YYYY-MM-DD"); иначе время коммита HEAD;
# иначе 2020-01-01. Две сборки одного дерева дают побайтно одинаковый архив.
epoch_to_iso() { date -u -d "@$1" +%FT%TZ 2>/dev/null || date -u -r "$1" +%FT%TZ; }
if [[ -n "${SOURCE_DATE_EPOCH:-}" ]]; then
  [[ "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] || die "SOURCE_DATE_EPOCH должен быть числом"
  BUILD_DATE="$(epoch_to_iso "$SOURCE_DATE_EPOCH")"
else
  cl_date="$(grep -E "^## ${VERSION//./\\.}([^0-9.]|$)" selfhost/CHANGELOG.md 2>/dev/null | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -n1 || true)"
  if [[ -n "$cl_date" ]]; then
    BUILD_DATE="${cl_date}T00:00:00Z"
  else
    commit_epoch="$(git log -1 --format=%ct HEAD 2>/dev/null || true)"
    if [[ "$commit_epoch" =~ ^[0-9]+$ ]]; then BUILD_DATE="$(epoch_to_iso "$commit_epoch")"; else BUILD_DATE="2020-01-01T00:00:00Z"; fi
  fi
fi
cat > "$PKG/BUILD_INFO" <<INFO
version=$VERSION
commit=$COMMIT
dirty=$DIRTY
built_at=$BUILD_DATE
INFO

# ── Проверка состава: ничего лишнего и секретного ───────────────────────
bad="$(find "$PKG" \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name 'state.json' \
  -o -name 'SECURITY_AUDIT.md' -o -name 'releases.log' -o -name '*.sqlite*' -o -name 'test_*' -o -name '*_test.*' \) -print)"
[[ -z "$bad" ]] || die "в пакет попали запрещённые файлы:
$bad"
if grep -rIlE 'BEGIN [A-Z ]*PRIVATE KEY|(JWT_SECRET|TURN_STATIC_AUTH_SECRET|STATE_ENCRYPTION_KEY)=[A-Za-z0-9+/=_-]{16,}' "$PKG" >/dev/null 2>&1; then
  grep -rIlE 'BEGIN [A-Z ]*PRIVATE KEY|(JWT_SECRET|TURN_STATIC_AUTH_SECRET|STATE_ENCRYPTION_KEY)=[A-Za-z0-9+/=_-]{16,}' "$PKG" >&2
  die "похоже на секрет в пакете"
fi
if grep -rIl '104\.164\.55\.82' "$PKG" >/dev/null 2>&1; then die "в пакете адрес прод-сервера"; fi
for must in LICENSE README.md README.en.md install.sh app/backend/main.py app/client/dist/index.html app/requirements.lock; do
  [[ -f "$PKG/$must" ]] || die "в пакете нет $must"
done
head -n1 "$PKG/LICENSE" | grep -q 'GNU AFFERO GENERAL PUBLIC LICENSE' || die "LICENSE — не AGPL-3.0"

# ── Манифест внутри архива ──────────────────────────────────────────────
# shellcheck disable=SC2094  # MANIFEST.sha256 исключён из find, чтения собственного вывода нет
(cd "$PKG" && find . -type f ! -name MANIFEST.sha256 -print0 | LC_ALL=C sort -z \
  | while IFS= read -r -d '' f; do printf '%s  %s\n' "$(sha256_of "$f")" "${f#./}"; done > MANIFEST.sha256)

# ── Архив (воспроизводимый порядок, без владельцев и mac-метаданных) ────
find "$PKG" -exec touch -t 202001010000 {} +
mkdir -p "$OUT"
ARCHIVE="$OUT/$NAME.tar.gz"
LIST="$STAGE/list.txt"
(cd "$STAGE" && find "$NAME" -print | LC_ALL=C sort > "$LIST")
export COPYFILE_DISABLE=1
if tar --version 2>/dev/null | grep -qi bsdtar; then
  (cd "$STAGE" && tar --uid 0 --gid 0 --uname root --gname root --no-mac-metadata --no-xattrs -n -cf - -T "$LIST") | gzip -n -9 > "$ARCHIVE"
else
  (cd "$STAGE" && tar --owner=0 --group=0 --numeric-owner --no-recursion -cf - -T "$LIST") | gzip -n -9 > "$ARCHIVE"
fi

(cd "$OUT" && printf '%s  %s\n' "$(sha256_of "$ARCHIVE")" "$NAME.tar.gz" > SHA256SUMS)

if [[ -n "$SIGN_KEY" ]]; then
  rm -f "$OUT/SHA256SUMS.sig"
  (cd "$OUT" && ssh-keygen -Y sign -f "$SIGN_KEY" -n "$SIG_NAMESPACE" SHA256SUMS >/dev/null)
  [[ -f "$OUT/SHA256SUMS.sig" ]] || die "подпись не создана"
  echo "Подписано: $OUT/SHA256SUMS.sig (namespace $SIG_NAMESPACE)"
else
  echo "Подпись пропущена (--sign-key не задан): update.sh и повторный install.sh такой релиз не примут без --allow-unsigned" >&2
fi

echo "Готово: $ARCHIVE ($(du -h "$ARCHIVE" | awk '{print $1}')), версия $VERSION, commit $COMMIT, dirty=$DIRTY"
cat "$OUT/SHA256SUMS"
