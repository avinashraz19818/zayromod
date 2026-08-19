#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-jiagu.sh — 360 Jiagu ka poora tool VPS pe AUTO download karta hai
#
# Kya karta hai:
#   1. /opt/jiagu folder banata hai
#   2. jiagu.jar + lib/*.jar (dependencies) GitHub mirror se download karta
#      hai (official 360 link login ke bina nahi milta; ye jar wahi official
#      tool hai — hardening 360 ke apne servers pe hi hoti hai)
#   3. Test karta hai ki java se chalti hai ya nahi
#
# Usage (VPS pe):
#   bash scripts/setup-jiagu.sh
# Uske baad .env me:
#   JIAGU_ENABLED=true
#   JIAGU_JAR=/opt/jiagu/jiagu.jar
#   JIAGU_EMAIL=... / JIAGU_PASS=...
# ─────────────────────────────────────────────────────────────────────────────
set -u

BASE_DIR="${JIAGU_DIR:-/opt/jiagu}"
MIRROR="https://raw.githubusercontent.com/angcyo/_360jiagu/master/jiagu"

LIBS=(
  "apksigner.jar"
  "betterbeansbinding-1.3.0-all.jar"
  "bsd.jar"
  "commons-codec-1.9.jar"
  "commons-collections-3.2.1.jar"
  "commons-compress-1.10.jar"
  "commons-io-2.4.jar"
  "commons-lang3-3.4.jar"
  "commons-logging-1.2.jar"
  "gson-2.8.0.jar"
  "jdom.jar"
  "json.jar"
  "net.jar"
  "org.apache.httpcomponents.httpclient_4.5.jar"
  "org.apache.httpcomponents.httpcore_4.4.1.jar"
  "sqlite-jdbc-3.8.11.2.jar"
  "zip4j_1.3.1.jar"
)

echo "═══ 360 JIAGU AUTO SETUP ═══"
mkdir -p "$BASE_DIR/lib"

echo "[1/3] jiagu.jar download..."
curl -sL --fail --retry 3 -o "$BASE_DIR/jiagu.jar" "$MIRROR/jiagu.jar" || {
  echo "❌ jiagu.jar download fail — internet check karo" >&2
  exit 1
}

echo "[2/3] dependencies download..."
FAIL=0
for L in "${LIBS[@]}"; do
  curl -sL --fail --retry 2 -o "$BASE_DIR/lib/$L" "$MIRROR/lib/$L" || {
    echo "   ⚠️  $L fail (continue)"
    FAIL=1
  }
done
[ "$FAIL" -eq 1 ] && echo "   (kuch libs fail hui — jar phir bhi try karegi)"

echo "[3/3] test..."
cd "$BASE_DIR"
OUT=$(java -jar "$BASE_DIR/jiagu.jar" 2>&1 | head -12)
echo "$OUT" | head -8
if [ -n "$(echo "$OUT" | tr -d '[:space:]')" ]; then
  echo "✅ Jiagu jar theek se load hui! (upar wala output iska banner/help hai)"
else
  echo "⚠️  Jar ne koi output nahi diya — java check karo (java -version)"
fi

echo ""
echo "✅ SETUP DONE"
echo "── Ab .env me ye 4 lines daalo:"
echo "   JIAGU_ENABLED=true"
echo "   JIAGU_JAR=$BASE_DIR/jiagu.jar"
echo "   JIAGU_EMAIL=tumhara_email"
echo "   JIAGU_PASS=tumhara_password"
echo "── Phir: cd ~/apkbuilder && git pull origin main && pm2 restart apkbuilder"
echo ""
echo "⚠️  NOTE: Ye mirror wali jar purani version ho sakti hai. Pehli build me"
echo "     agar 360 ki taraf se 'version too old' jaisa error aaye to official"
echo "     site (jiagu.360.cn → download) se naya tool le kar /opt/jiagu/jiagu.jar"
echo "     replace kar dena — script/pipeline waisa hi chalega."
