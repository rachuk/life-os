#!/usr/bin/env bash
# Deploy Life OS to the server (default: ssh alias "netcup", dir /opt/life-os).
#   SSH_HOST=netcup REMOTE_DIR=/opt/life-os ./deploy/deploy.sh
# Ships the working tree (without secrets, node_modules, local data) and rebuilds the stack.
# The server keeps its own .env (never overwritten) and Docker volumes (database, media).
set -euo pipefail
SSH_HOST="${SSH_HOST:-netcup}"
REMOTE_DIR="${REMOTE_DIR:-/opt/life-os}"
cd "$(dirname "$0")/.."

echo "→ checks"
pnpm typecheck
pnpm lint

echo "→ syncing to ${SSH_HOST}:${REMOTE_DIR}"
ssh "$SSH_HOST" "mkdir -p '$REMOTE_DIR'"
rsync -az --delete \
  --exclude /node_modules --exclude /.next --exclude /.next-e2e --exclude /data --exclude /backups \
  --include '.env.example' --exclude '.env' --exclude '.env.*' \
  --exclude /.git --exclude /.playwright-mcp --exclude /test-results --exclude /playwright-report \
  --exclude '*.zip' --exclude tsconfig.tsbuildinfo \
  ./ "${SSH_HOST}:${REMOTE_DIR}/"

ssh "$SSH_HOST" bash -s "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
if [ ! -f .env ]; then
  echo "!! ${1}/.env is missing — create it from .env.example (POSTGRES_PASSWORD, APP_URL, secrets) and re-run"; exit 1
fi
docker network inspect web >/dev/null 2>&1 || { echo "!! docker network 'web' (Caddy) not found"; exit 1; }
docker compose build
docker compose up -d --remove-orphans
docker compose ps
echo "✓ deployed"
REMOTE
