#!/bin/bash
# Managed by phantom-selfhost. После обновления сертификата certbot: проверить и перечитать nginx.
set -euo pipefail
nginx -t >/dev/null 2>&1 || exit 0
systemctl reload nginx
