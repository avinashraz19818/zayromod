#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-jiagu.sh — OFFICIAL 360 Jiagu tool VPS pe AUTO download karta hai
#
# Source: 360 ka official download link (idocking/360jiagu Dockerfile se —
# down.360safe.com/360Jiagu/360jiagubao_linux_64.zip, ~270MB)
#
# Kya karta hai:
#   1. Official Linux package download (270MB — ek baar)
#   2. Extract karke /opt/jiagu me jiagu.jar + lib/ rakhta hai
#   3. Java se test karta hai
#
# Usage (VPS pe, project folder se):
#   bash scripts/setup-jiagu.sh
#
# Uske baad .env me:
#   JIAGU_ENABLED=true
#   JIAGU_JAR=/opt/jiagu/jiagu.jar
#   JIAGU_EMAIL=... / JIAGU_PASS=...
# ─────────────────────────────────────────────────────────────────────────────
set -u

BASE_DIR="${JIAGU_DIR:-/opt/jiagu}"
WORK_DIR="$(mktemp -d)"
OFFICIAL_ZIP="https://down.360safe.com/360Jiagu/360jiagubao_linux_64.zip"

echo "═══ 360 JIAGU OFFICIAL SETUP ═══"
echo "[1/4] official Linux package download (~270MB, ek baar)..."
curl -sL --fail --retry 3 -o "$WORK_DIR/jiagu.zip" "$OFFICIAL_ZIP" || {
  echo "❌ download fail — internet check karo" >&2
  rm -rf "$WORK_DIR"
  exit 1
}

echo "[2/4] extract..."
mkdir -p "$WORK_DIR/ext"
cd "$WORK_DIR/ext"
if command -v 7z >/dev/null 2>&1; then
  7z x "$WORK_DIR/jiagu.zip" -y >/dev/null 2>&1 || { echo "❌ 7z extract fail"; rm -rf "$WORK_DIR"; exit 1; }
elif command -v unzip >/dev/null 2>&1; then
  unzip -q "$WORK_DIR/jiagu.zip" || { echo "❌ unzip extract fail"; rm -rf "$WORK_DIR"; exit 1; }
else
  apt-get install -y -qq unzip >/dev/null 2>&1
  unzip -q "$WORK_DIR/jiagu.zip" || { echo "❌ unzip extract fail"; rm -rf "$WORK_DIR"; exit 1; }
fi

JAR_PATH="$(find . -name 'jiagu.jar' | head -1)"
if [ -z "$JAR_PATH" ]; then
  echo "❌ jiagu.jar extract me nahi mila" >&2
  rm -rf "$WORK_DIR"
  exit 1
fi

mkdir -p "$BASE_DIR"
echo "   jar mili: $JAR_PATH"
cp "$JAR_PATH" "$BASE_DIR/jiagu.jar"

LIB_PATH="$(dirname "$JAR_PATH")/lib"
if [ -d "$LIB_PATH" ]; then
  rm -rf "$BASE_DIR/lib"
  cp -r "$LIB_PATH" "$BASE_DIR/lib"
  echo "   lib/ copied ($(ls "$BASE_DIR/lib" | wc -l) files)"
fi

echo "[3/4] test..."
OUT=$(java -jar "$BASE_DIR/jiagu.jar" 2>&1 | head -12)
echo "$OUT" | head -8
if [ -n "$(echo "$OUT" | tr -d '[:space:]')" ]; then
  echo "✅ Jiagu jar theek se load hui!"
else
  echo "⚠️  Jar ne koi output nahi diya — java check karo (java -version)"
fi

rm -rf "$WORK_DIR"

echo ""
echo "✅ SETUP DONE (OFFICIAL tool)"
echo "── Ab .env me ye 4 lines daalo:"
echo "   JIAGU_ENABLED=true"
echo "   JIAGU_JAR=$BASE_DIR/jiagu.jar"
echo "   JIAGU_EMAIL=tumhara_email"
echo "   JIAGU_PASS=tumhara_password"
echo "── Phir: cd ~/apkbuilder && pm2 restart apkbuilder"
echo "── Phir admin panel se REBUILD karo — build log me '360 Jiagu:"
echo "   protected + signed' aana chahiye."
