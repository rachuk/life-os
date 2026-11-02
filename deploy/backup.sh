#!/usr/bin/env bash
# Nightly Postgres dump for Life OS (keeps 14 days). Cron example:
#   20 3 * * * cd /opt/life-os && ./deploy/backup.sh >> /var/log/lifeos-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
f="backups/lifeos-$(date +%F).sql.gz"
docker compose exec -T db pg_dump -U lifeos -d lifeos --no-owner | gzip > "$f"
find backups -name 'lifeos-*.sql.gz' -mtime +14 -delete
echo "$(date -Is) backup ok: $f ($(du -h "$f" | cut -f1))"
