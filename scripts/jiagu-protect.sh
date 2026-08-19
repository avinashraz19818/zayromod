#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# jiagu-protect.sh — 360 Jiagu hardening step (build pipeline se call hota hai)
#
# Usage:
#   bash scripts/jiagu-protect.sh <jiagu.jar> <input.apk> <output.apk> \
#        <keystore> <storepass> <alias> <keypass>
#
# Env (apkbuilder set karta hai):
#   JIAGU_USER — 360 jiagu account username
#   JIAGU_PASS — 360 jiagu account password
#
# Note: jiagu ke flags version ke hisaab se thode alag ho sakte hain
# (kuch versions me -jiagu ke baad -autosign hota hai, kuch me -importsign
#  pehle karna padta hai). Login/importsign fail ho to bhi harden try karta
#  hai; harden fail ho to script exit 1 karta hai aur apkbuilder normal
#  signing fallback pe chala jata hai.
# ─────────────────────────────────────────────────────────────────────────────
set -u

JAR="$1"
IN="$2"
OUT="$3"
KS="$4"
KSPASS="$5"
ALIAS="$6"
KEYPASS="$7"

if [ ! -f "$JAR" ]; then echo "jiagu jar not found: $JAR" >&2; exit 1; fi
if [ ! -f "$IN" ]; then echo "input apk not found: $IN" >&2; exit 1; fi

# 1) Login (pehli baar jaroori; fail ho to bhi aage badho)
if [ -n "${JIAGU_USER:-}" ] && [ -n "${JIAGU_PASS:-}" ]; then
  echo "[jiagu] login..."
  java -jar "$JAR" -login "$JIAGU_USER" "$JIAGU_PASS" >/dev/null 2>&1 || echo "[jiagu] login fail (ignore)"
fi

# 2) Keystore import (360 isse autosign ke liye use karta hai)
if [ -f "$KS" ]; then
  echo "[jiagu] importsign..."
  java -jar "$JAR" -importsign "$KS" "$KSPASS" "$ALIAS" "$KEYPASS" >/dev/null 2>&1 || echo "[jiagu] importsign fail (ignore)"
fi

# 3) Harden + autosign — ye fail hona allowed nahi (fallback node me hai)
echo "[jiagu] hardening $IN ..."
rm -f "$OUT"
java -jar "$JAR" -jiagu "$IN" "$OUT" -autosign

if [ ! -f "$OUT" ]; then
  echo "[jiagu] output nahi bana" >&2
  exit 1
fi

echo "[jiagu] done: $OUT"
exit 0
