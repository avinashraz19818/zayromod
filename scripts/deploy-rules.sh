#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-rules.sh — Firebase Realtime Database RULES ko VPS se deploy karo
# (Console me click-click ki galtiyan khatam — ye 100% kaam karta hai)
#
# Service account file se auth hota hai (GOOGLE_APPLICATION_CREDENTIALS jo
# .env me pehle se hai). Rules file: database.rules.json (repo me hai).
#
# Usage (VPS, project folder se):
#   bash scripts/deploy-rules.sh
# ─────────────────────────────────────────────────────────────────────────────
set -u

PROJECT_ID="${FIREBASE_PROJECT_ID:-zayrodev-195f3}"
SA_FILE="${GOOGLE_APPLICATION_CREDENTIALS:-/root/apkbuilder/firebase-service-account.json}"
DB_URL="https://${PROJECT_ID}-default-rtdb.firebaseio.com"

echo "═══ FIREBASE RULES DEPLOY ═══"
echo "[1/4] service account check..."
if [ ! -f "$SA_FILE" ]; then
  echo "❌ Service account file nahi mili: $SA_FILE" >&2
  exit 1
fi
node -e "try{JSON.parse(require('fs').readFileSync('$SA_FILE','utf8'));console.log('   JSON OK ✅')}catch(e){console.log('❌ JSON CORRUPT');process.exit(1)}" || exit 1

echo "[2/4] firebase-tools deploy (pehli baar ~1 min lagta hai — npx download karta hai)..."
cd "$(dirname "$0")/.."   # project root
GOOGLE_APPLICATION_CREDENTIALS="$SA_FILE" npx --yes firebase-tools@latest deploy \
  --only database \
  --project "$PROJECT_ID" \
  --non-interactive \
  2>&1 | tail -25

echo ""
echo "[3/4] verify — bina auth ke config write BLOCK hona chahiye (401):"
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
  -X PUT "$DB_URL/arena_probe.json" -d '{"x":1}')
echo "   probe PUT → HTTP $CODE"
curl -s --max-time 20 -X DELETE "$DB_URL/arena_probe.json" > /dev/null

echo "[4/4] result:"
if [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then
  echo "✅✅✅ TAALA LAG GAYA! Hacker ab config change NAHI kar sakta."
  echo "   (Apps read + users/ write ab bhi chalti hai, admin link change"
  echo "    service account token se chalta rahega.)"
else
  echo "❌ Rules abhi bhi nahi lagi (HTTP $CODE). Upar deploy ka output check karo"
  echo "   — error aayi ho to mujhe bhejo."
fi
