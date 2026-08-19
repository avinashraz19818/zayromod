#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-rules.sh — Firebase Realtime Database RULES ko VPS se deploy karo
#
# Rules (database.rules.json):
#   - read: sabko (apps chalti hain)
#   - har panel ke config/push ki write: sirf auth != null (server service
#     account) → hacker kabhi link nahi badal sakta
#   - baaki sab (users registration tracking etc.): write open
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

echo "[2/4] firebase-tools deploy (pehli baar ~1 min lagta hai)..."
cd "$(dirname "$0")/.."   # project root
GOOGLE_APPLICATION_CREDENTIALS="$SA_FILE" npx --yes firebase-tools@latest deploy \
  --only database \
  --project "$PROJECT_ID" \
  --non-interactive \
  2>&1 | tail -20

echo ""
echo "[3/4] verify — 2 probe tests:"

# Probe A: panel ka CONFIG — bina auth ke BLOCK hona chahiye (401)
CODE_A=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
  -X PUT "$DB_URL/arena_probe/config.json" -d '{"registerUrl":"https://hacker.com"}')
echo "   probe A (config write, bina auth): HTTP $CODE_A  [401 = taala laga ✅]"

# Probe B: panel ke USERS — bina auth ke ALLOWED (apps ka registration)
CODE_B=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
  -X PUT "$DB_URL/arena_probe/users.json" -d '{"9999999999":{"registered":true}}')
echo "   probe B (users write, bina auth):  HTTP $CODE_B  [200 = apps chalti hain ✅]"

# Cleanup probe B ka junk
curl -s --max-time 20 -X DELETE "$DB_URL/arena_probe/users.json" > /dev/null
curl -s --max-time 20 -X DELETE "$DB_URL/arena_probe/config.json" > /dev/null
curl -s --max-time 20 -X DELETE "$DB_URL/arena_probe.json" > /dev/null

echo "[4/4] result:"
if [ "$CODE_A" = "401" ] || [ "$CODE_A" = "403" ]; then
  echo "✅✅✅ TAALA LAG GAYA! Hacker ab kisi bhi panel ka link change NAHI kar sakta."
  if [ "$CODE_B" = "200" ]; then
    echo "   (Apps read + users registration tracking ab bhi chalti hai — sab normal.)"
  else
    echo "   ⚠️  users write bhi block hui (HTTP $CODE_B) — apps ka registration"
    echo "       track hona ruk sakta hai. Rules file check karo."
  fi
  echo "   (Admin link change server token se chalta rahega.)"
else
  echo "❌ Rules kaam nahi kar rahi (config probe HTTP $CODE_A). Upar deploy ka"
  echo "   output check karo — error aayi ho to mujhe bhejo."
fi
