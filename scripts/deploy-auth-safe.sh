#!/usr/bin/env bash
# Safe deployment for the auth hardening. This script deliberately does not
# pull settings, restore Firebase links, create an order, or start a build.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$APP_DIR"

if [[ ! -f package.json || ! -f database/apkbuilder.db ]]; then
  echo "Not an APK Builder checkout: $APP_DIR" >&2
  exit 1
fi

# Keep the live database out of normal source updates. The deployment commit
# does not change the DB blob; this guard also protects a locally modified DB.
git update-index --skip-worktree database/apkbuilder.db 2>/dev/null || true

mkdir -p backups
chmod 700 backups
backup="backups/pre-auth-$(date +%Y%m%d-%H%M%S).db"
python3 - "$backup" <<'PY'
import sqlite3
import sys

src = sqlite3.connect("database/apkbuilder.db")
dst = sqlite3.connect(sys.argv[1])
try:
    src.backup(dst)
finally:
    dst.close()
    src.close()
PY
chmod 600 "$backup"
echo "Database backup created: $backup"

# npm ci is safe while the current PM2 process is running. If it fails, the
# script exits before reload, so the already-running app is not interrupted.
npm ci

# Refuse a production reload when the required auth configuration is absent.
node - <<'NODE'
require('dotenv').config();
const bcrypt = require('bcryptjs');
const secret = String(process.env.SESSION_SECRET || '').trim();
const hash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
if (secret.length < 32) throw new Error('SESSION_SECRET missing or shorter than 32 characters');
if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash) || bcrypt.getRounds(hash) < 10) {
  throw new Error('ADMIN_PASSWORD_HASH invalid or weaker than bcrypt cost 10');
}
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
  const base = new URL(process.env.BASE_URL || '');
  if (base.protocol !== 'https:') throw new Error('BASE_URL must use HTTPS in production');
}
console.log('Production auth environment check passed');
NODE

# Only now reload the application. No settings pull or build command is run.
pm2 reload apkbuilder --update-env
sleep 3
pm2 status

# Read-only compatibility check for an existing completed APK order. Wait for
# the reloaded process instead of assuming it is listening immediately.
old_path="$(python3 - <<'PY'
import sqlite3

db = sqlite3.connect("database/apkbuilder.db")
row = db.execute("""
    SELECT firebase_path FROM orders
    WHERE status='done' AND apk_file IS NOT NULL
    ORDER BY id DESC LIMIT 1
""").fetchone()
print(row[0] if row else '')
db.close()
PY
)"
app_port="${PORT:-$(node -e "require('dotenv').config(); process.stdout.write(String(process.env.PORT || 3000))")}"
wait_for_content() {
  local url="$1"
  local output="$2"
  local attempt
  for attempt in $(seq 1 20); do
    if curl -fsS --max-time 3 "$url" -o "$output" 2>/dev/null \
      && [[ "$(wc -c < "$output")" -gt 16 ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if [[ -n "$old_path" ]]; then
  wait_for_content "http://127.0.0.1:${app_port}/api/app-content/${old_path}?compat-check=1" \
    /tmp/zayro-legacy-popup.bin
  wait_for_content "http://127.0.0.1:${app_port}/api/app-content/${old_path}/loading?compat-check=1" \
    /tmp/zayro-legacy-loading.bin
  rm -f /tmp/zayro-legacy-popup.bin /tmp/zayro-legacy-loading.bin
  echo "Existing APK compatibility check passed: $old_path"
else
  echo "No completed APK order found; compatibility check skipped"
fi

echo "Safe auth deployment completed; no settings/build command was run."
