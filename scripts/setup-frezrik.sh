#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-frezrik.sh — Frezrik/Jiagu (open-source DEX packer) VPS pe install
#
# Frezrik/Jiagu: 403-star open-source APK hardening (Apache-2.0). DEX ko
# AES se encrypt karta hai + shell dex loader (InMemoryDexClassLoader).
# Decompile karne pe sirf shell dikhta hai — asli code kuch nahi.
#
# Koi account/login NAHI chahiye (360 jaisa jhanjhat nahi).
# Download: GitHub tarball (~15MB) se JiaguTool nikal kar /opt/frezrik me.
#
# Usage (VPS, project folder se):
#   bash scripts/setup-frezrik.sh
#
# Uske baad .env me (optional — default auto-detect):
#   FREZRIK_ENABLED=true
#   FREZRIK_JAR=/opt/frezrik/pack.jar
# ─────────────────────────────────────────────────────────────────────────────
set -u

BASE_DIR="${FREZRIK_DIR:-/opt/frezrik}"
TARBALL_URL="https://github.com/Frezrik/Jiagu/archive/refs/heads/main.tar.gz"

echo "═══ FREZRIK JIAGU SETUP (open-source DEX packer) ═══"
echo "[1/3] download (~15MB)..."
WORK="$(mktemp -d)"
curl -sL --fail --retry 3 -o "$WORK/jiagu.tar.gz" "$TARBALL_URL" || {
  echo "❌ download fail — internet check karo" >&2
  rm -rf "$WORK"
  exit 1
}

echo "[2/3] extract..."
tar xzf "$WORK/jiagu.tar.gz" -C "$WORK" "Jiagu-main/JiaguTool"
if [ ! -f "$WORK/Jiagu-main/JiaguTool/pack.jar" ]; then
  echo "❌ pack.jar extract me nahi mila" >&2
  rm -rf "$WORK"
  exit 1
fi

rm -rf "$BASE_DIR"
mkdir -p "$BASE_DIR"
cp -r "$WORK/Jiagu-main/JiaguTool/." "$BASE_DIR/"
chmod +x "$BASE_DIR/bin/linux/apksigner" 2>/dev/null || true
chmod +x "$BASE_DIR/bin/linux/zipalign" 2>/dev/null || true
rm -rf "$WORK"

echo "[3/3] test..."
java -jar "$BASE_DIR/pack.jar" 2>&1 | head -5 || true

echo ""
echo "✅ SETUP DONE"
echo "   pack.jar: $BASE_DIR/pack.jar"
echo ""
echo "── .env me (optional, default auto-detect hota hai):"
echo "   FREZRIK_ENABLED=true"
echo "   FREZRIK_JAR=$BASE_DIR/pack.jar"
echo "── Phir: cd ~/apkbuilder && pm2 restart apkbuilder"
echo "── Rebuild karo — build log me 'Frezrik Jiagu: packed' aana chahiye."
echo ""
echo "NOTE: pack.jar ka apna apksigner PATH me na ho to bhi dikkat nahi —"
echo "      pipeline apne zipalign+apksigner (Android SDK) se sign karta hai."
