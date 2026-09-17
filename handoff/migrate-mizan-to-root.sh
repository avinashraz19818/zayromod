#!/usr/bin/env bash
# Move only the full app. Preserve external SDK/key/HOME and the uppercase source folder.
set -Eeuo pipefail
umask 077
APP=/opt/mizanmod-full
DEST=/root/mizan
SERVICE=mizanmod-full
CONF=/etc/systemd/system/mizanmod-full.service.d/zz-root-location.conf
[[ $EUID -eq 0 ]] || { echo 'STOP: Run as root.'; exit 1; }
for tool in python3 setfacl getfacl flock curl tar; do
  command -v "$tool" >/dev/null || { echo "STOP: Missing $tool (install acl for setfacl/getfacl)."; exit 1; }
done
exec 9>/run/lock/mizan-location-migration.lock
flock -n 9 || { echo 'STOP: Another migration is running.'; exit 1; }
[[ -d "$APP" && ! -L "$APP" && -f "$APP/server.js" && -f "$APP/.env" ]] || { echo 'STOP: Existing app missing or already a symlink.'; exit 1; }
[[ ! -e "$DEST" && ! -L "$DEST" && ! -e "$CONF" && ! -L "$CONF" ]] || { echo 'STOP: Destination or migration override already exists; nothing overwritten.'; exit 1; }
[[ $(systemctl show "$SERVICE" -p User --value) == mizanmods ]] || { echo 'STOP: Unexpected service user.'; exit 1; }
[[ $(systemctl show "$SERVICE" -p WorkingDirectory --value) == "$APP" ]] || { echo 'STOP: Unexpected service working directory.'; exit 1; }
[[ $(stat -c %d "$APP") == $(stat -c %d /root) ]] || { echo 'STOP: Cross-filesystem migration requires a different procedure.'; exit 1; }
systemctl is-active --quiet "$SERVICE"
idle() {
  python3 - "$APP/database/mizanmod.db" <<'PY'
import sqlite3,sys,pathlib
with sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True) as db:
    count=db.execute("SELECT count(*) FROM orders WHERE status IN ('pending','queued','building','processing')").fetchone()[0]
    if count:sys.exit('STOP: Finish pending/active builds first.')
PY
}
idle
BACKUP=$(mktemp -d /var/lib/mizanmod-full/location-backup-XXXXXXXX)
chmod 700 "$BACKUP"
getfacl -p /root > "$BACKUP/root.acl"
cp -a /etc/systemd/system/mizanmod-full.service "$BACKUP/"
cp -a /etc/systemd/system/mizanmod-full.service.d "$BACKUP/drop-ins"
STOPPED=0
MOVED=0
ACL_CHANGED=0
CONF_WRITTEN=0
rollback() {
  local rc=$?
  trap - EXIT
  [[ $rc -eq 0 || $STOPPED -eq 0 ]] && exit "$rc"
  set +e
  echo 'Migration failed. Stopping service before rollback...'
  if ! systemctl stop "$SERVICE"; then
    echo 'STOP: Cannot stop service safely. No data moved back. Manual repair required.'
    exit 1
  fi
  if [[ $MOVED -eq 1 ]]; then
    if [[ -L "$APP" && $(readlink "$APP") == "$DEST" ]]; then rm -- "$APP"; fi
    if [[ -e "$APP" || -L "$APP" ]] || ! mv -T -- "$DEST" "$APP"; then
      echo 'STOP: Location rollback failed. Service stays stopped; keep current database.'
      exit 1
    fi
  fi
  if [[ $CONF_WRITTEN -eq 1 ]]; then rm -f -- "$CONF"; fi
  if [[ $ACL_CHANGED -eq 1 ]]; then setfacl --restore="$BACKUP/root.acl"; fi
  systemctl daemon-reload
  systemctl start "$SERVICE"
  echo 'Rollback attempted using CURRENT files/database, not the backup. Check systemctl status.'
  echo "Private backup: $BACKUP"
  exit "$rc"
}
trap rollback EXIT
STOPPED=1
systemctl stop "$SERVICE"
idle
# Full private snapshot while SQLite and build workers are stopped. Never auto-restore it.
tar --acls --xattrs -cpf "$BACKUP/app.tar" -C /opt mizanmod-full
sha256sum "$APP/.env" "$APP/public/index.html" "$APP/public/admin/index.html" > "$BACKUP/protected.sha256"
mv -T -- "$APP" "$DEST"
MOVED=1
ln -s -- "$DEST" "$APP"
ACL_CHANGED=1
# Traverse only; do not give the service user directory-listing access to host /root.
setfacl -m u:mizanmods:--x /root
CONF_WRITTEN=1
cat > "$CONF" <<'UNIT'
[Service]
WorkingDirectory=/root/mizan
ExecStart=
ExecStart=/usr/bin/node --env-file=/root/mizan/.env /root/mizan/server.js
# Hide other home contents; expose only this app inside the service namespace.
ProtectHome=tmpfs
BindPaths=/root/mizan
ReadWritePaths=/root/mizan
UNIT
chmod 644 "$CONF"
sha256sum -c "$BACKUP/protected.sha256"
systemctl daemon-reload
systemctl start "$SERVICE"
healthy=0
for ((i=0; i<30; i++)); do
  if curl --silent --fail --max-time 2 -H 'Host: admin.mizammod.site' http://127.0.0.1:3100/healthz |
    python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("status")=="ok" else 1)' 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
[[ $healthy -eq 1 ]] || { echo 'STOP: Health check failed.'; exit 1; }
systemctl is-active --quiet "$SERVICE"
pid=$(systemctl show "$SERVICE" -p MainPID --value)
[[ "$pid" =~ ^[1-9][0-9]*$ && $(readlink -f "/proc/$pid/cwd") == "$DEST" ]] || { echo 'STOP: Running process not in expected directory.'; exit 1; }
sha256sum -c "$BACKUP/protected.sha256"
STOPPED=0
trap - EXIT
printf '\nPASS: Running app is now /root/mizan (service user remains mizanmods).\n'
printf 'Compatibility link: /opt/mizanmod-full -> /root/mizan\n'
printf 'Uppercase /root/Mizan, SDK, signing key and external service HOME untouched.\n'
printf 'Private backup: %s\n' "$BACKUP"
printf 'Do not restore the old DB after new orders. Do not git-add/push the live folder: it contains secrets.\n'
printf 'Existing updater scripts may need adapting for the new location. Do not reinstall over the symlink.\n'
systemctl show "$SERVICE" --no-pager -p ActiveState -p MainPID -p WorkingDirectory -p User
