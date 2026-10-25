# Changelog

## Не выпущено

- Ubuntu 22.04 / 24.04 / 26.04: определение ОС (`pm_os_detect`), выбор интерпретатора Python ≥ 3.11 (`pm_find_python`,
  `pm_ensure_python` в `lib/common.sh`); на 22.04 (python3 = 3.10, а `requirements.lock` требует 3.11+) ставится `python3.12`
  из deadsnakes PPA, флаг `--no-python-ppa` запрещает PPA. `requirements.lock` без изменений: хеши есть для CPython 3.11-3.14
  (проверено `pip download --require-hashes`), на 26.04 / Python 3.14 relay и 5 офлайн-тестов проходят. `update.sh` пересоздаёт venv тем же интерпретатором.
- Ревью SEC2: deadsnakes PPA подключается без `add-apt-repository`: ключ с keyserver.ubuntu.com по HTTPS проверяется по полному
  отпечатку (`F23C5A6C…6A755776`, при расхождении die), keyring `/etc/apt/keyrings/deadsnakes.gpg` + `deadsnakes.sources` с `Signed-By`,
  `/etc/apt/preferences.d/deadsnakes` (весь PPA 100, `python3.12*`/`libpython3.12*` 500); `uninstall.sh` снимает только то, что поставил установщик
  (метка "Managed by phantom-selfhost"). Интерпретатор Python ищется по абсолютным путям `/usr/bin/python3*` (владелец root, без записи
  группе/всем, включая каталоги выше), PATH/шимы/pyenv/venv игнорируются. `firewall_setup`: порты SSH из `sshd -T` и `ss -tlnp` (все);
  если определить нельзя — с `--enable-ufw` установка останавливается, без него разрешается 22/tcp с предупреждением.
- Исправлено: `firewall_setup` при выключенном ufw и `--cf-only-443` не заданном возвращал 1 (`[[ ]] &&` в конце функции) —
  `set -e` молча обрывал установку до запуска relay; `sshd -T | awk …exit` под `pipefail` изредка давал 141 (SIGPIPE) и тоже обрывал установку.

- Безопасность (ревью H3): в `/opt/.../selfhost` копируются только файлы релиза по `MANIFEST.sha256` (ключи рядом с
  архивом не попадают); подпись обязательна, если в установленном `allowed_signers` есть ключ (`--allow-unsigned` —
  явный опт-аут); якорь доверия берётся из установленного пакета; повторный `install.sh` проверяет манифест и подпись;
  архив в `update.sh` копируется в stage 0700 и проверяется по копии; coturn пишет журнал в namespace `phantom`;
  секрет TURN не передаётся через argv; `--cf-only-443` + `pm-cf-update.timer` (список CIDR в `TRUSTED_PROXIES_FILE`);
  `server_tokens off`, OCSP stapling (letsencrypt/custom); `BUILD_INFO` без текущего времени (воспроизводимый архив);
  `valid_text` отвергает Unicode Cf/Cs/Co/Cn; `uninstall.sh` не удаляет пользователя, существовавшего до установки.

- `operator.json` версии 1: `version`, `termsUrl`, `privacyUrl` (по умолчанию `https://<domain>/terms`, `/privacy`);
  веб-клиент и приложения для чужого сервера читают его для `/terms`, `/privacy`, контакта и ссылок «Сайт / Условия / Политика».
- Диалог всегда спрашивает имя, контактную почту и сайт оператора; флаги `--operator-terms-url`, `--operator-privacy-url`;
  строгая валидация (https, без скобок и пробелов, имя без `[ ] ( ) *`).
- Ключ сервиса номеров — заголовок `X-API-Key` (в проверке установщика, в `selftest.sh` и в env `NFT_NUMBERS_SERVICE_SECRET_HEADER`).

## 0.1.0 — первая версия установщика

- `install.sh`: relay (user `phantom`, hardening), nginx (TLS 1.2/1.3 → 127.0.0.1:8444), coturn с эфемерными
  кредами, 4 режима TLS (Let's Encrypt HTTP-01, Let's Encrypt DNS-01 через Cloudflare, Cloudflare Origin
  Certificate, свой сертификат), журнал relay в volatile-namespace, healthcheck-таймер.
- `update.sh` (SHA-256, подпись `ssh-keygen -Y`, автооткат), `uninstall.sh [--purge]`, `status.sh`, `selftest.sh`.
- `install.sh --dry-run [--render-dir DIR]` — план и отрендеренные конфиги без изменений в системе.
