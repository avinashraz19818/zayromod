#!/usr/bin/env python3
"""Fixed-target, allowlisted MizanMod Studio update. Run only while no builds/orders are active."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid

APP = Path('/opt/mizanmod-full')
BACKUPS = Path('/var/lib/mizanmod-full/studio-backups')
SERVICE = 'mizanmod-full'
ALLOWED = {
    'public/index.html', 'public/admin/index.html', 'public/mizan-theme.css',
    'public/js/mizan-workspace.js', 'public/mark.svg', 'public/studio-art.svg',
    'public/bot-avatar.png', 'utils/telegram.js', 'utils/telegram-adapter.js',
    'scripts/import-catalog.js', 'scripts/configure-bot.js',
    'docs/publish-catalog.json', 'docs/STUDIO-UPDATE.md', 'docs/VERIFICATION.md',
    'tests/catalog.test.js', 'tests/telegram-polling.test.js', 'tests/browser/studio.cjs',
    'tests/bot-studio.test.js',
}

def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def db_path(app):
    return app / 'database/mizanmod.db'

def idle(app):
    file = db_path(app)
    if not file.is_file() or file.is_symlink():
        raise RuntimeError('Existing independent database not found or is symlinked.')
    with sqlite3.connect(file.as_uri() + '?mode=ro', uri=True) as db:
        n = db.execute("SELECT count(*) FROM orders WHERE status IN ('pending','queued','building','processing')").fetchone()[0]
        if n:
            raise RuntimeError('Pending/active orders exist. Finish them first; no update performed.')

def validate_payload(bundle, app):
    manifest = json.loads((bundle / 'manifest.json').read_text())
    if set(manifest) != ALLOWED:
        raise RuntimeError('Unexpected update file list.')
    for rel, expected in manifest.items():
        src, dest = bundle / 'payload' / rel, app / rel
        if not src.is_file() or src.is_symlink() or not src.resolve().is_relative_to((bundle / 'payload').resolve()):
            raise RuntimeError('Invalid update source: ' + rel)
        if not dest.resolve().is_relative_to(app.resolve()) or dest.is_symlink():
            raise RuntimeError('Unsafe destination: ' + rel)
        if hashlib.sha256(src.read_bytes()).hexdigest() != expected:
            raise RuntimeError('Checksum mismatch: ' + rel)
    return manifest

def health():
    for _ in range(30):
        try:
            req = urllib.request.Request('http://127.0.0.1:3100/healthz', headers={'Host': 'admin.mizammod.site'})
            with urllib.request.urlopen(req, timeout=2) as response:
                data = json.load(response)
                if response.status == 200 and data.get('service') == 'MizanMod' and data.get('status') == 'ok':
                    run(['systemctl', 'is-active', '--quiet', SERVICE])
                    return
        except Exception:
            time.sleep(1)
    raise RuntimeError('Updated service did not pass the local health check.')

def rollback(backup):
    backup = backup.resolve()
    if not backup.is_relative_to(BACKUPS.resolve()) or backup == BACKUPS.resolve():
        raise RuntimeError('Invalid rollback path.')
    state = json.loads((backup / 'state.json').read_text())
    if set(state['files']) != ALLOWED or not state.get('ready'):
        raise RuntimeError('Backup incomplete; refusing automatic rollback.')
    run(['systemctl', 'stop', SERVICE])  # Never restore a database while the server is running.
    for rel, meta in state['files'].items():
        dest = APP / rel
        if dest.is_symlink() or not dest.resolve().is_relative_to(APP.resolve()):
            raise RuntimeError('Unsafe rollback destination.')
        if meta is None:
            dest.unlink(missing_ok=True)
        else:
            shutil.copyfile(backup / 'files' / rel, dest)
            os.chown(dest, meta['uid'], meta['gid']); os.chmod(dest, meta['mode'])
    # DB snapshot is transaction-consistent and from before import, with the service stopped.
    # A later manual rollback would undo post-update activity: only permit it after operator review.
    for suffix in ('-wal', '-shm'):
        Path(str(db_path(APP)) + suffix).unlink(missing_ok=True)
    shutil.copyfile(backup / 'database.db', db_path(APP))
    meta = state['database']
    os.chown(db_path(APP), meta['uid'], meta['gid']); os.chmod(db_path(APP), meta['mode'])
    run(['systemctl', 'start', SERVICE])
    health()
    print('Previous files and pre-update database restored. Env/signing settings unchanged.')

def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run this updater as root on the Mizan VPS.')
    os.umask(0o077)
    if len(sys.argv) > 1:
        raise RuntimeError('No command-line options supported. Manual database rollback requires reviewing newer activity first.')
    if APP.is_symlink() or not (APP / '.env').is_file():
        raise RuntimeError('Expected existing /opt/mizanmod-full installation not found.')
    bundle = Path(__file__).resolve().parent
    manifest = validate_payload(bundle, APP)
    for rel in manifest:
        if rel.endswith('.js') or rel.endswith('.cjs'):
            run(['node', '--check', str(bundle / 'payload' / rel)], stdout=subprocess.DEVNULL)
    idle(APP)
    run(['systemctl', 'is-active', '--quiet', SERVICE])
    original_env = hashlib.sha256((APP / '.env').read_bytes()).digest()
    user = pwd.getpwnam('mizanmods')
    BACKUPS.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup = BACKUPS / (time.strftime('%Y%m%d-%H%M%S') + '-' + str(uuid.uuid4())[:8])
    backup.mkdir(mode=0o700)
    print('Private rollback backup:', backup, flush=True)
    state = {'ready': False, 'files': {}}
    stopped = False
    try:
        run(['systemctl', 'stop', SERVICE]); stopped = True
        idle(APP)
        meta = db_path(APP).stat()
        state['database'] = {'uid': meta.st_uid, 'gid': meta.st_gid, 'mode': meta.st_mode & 0o777}
        source = sqlite3.connect(db_path(APP))
        target = sqlite3.connect(backup / 'database.db')
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
        for rel in manifest:
            dest = APP / rel
            if dest.exists():
                meta = dest.stat()
                state['files'][rel] = {'uid': meta.st_uid, 'gid': meta.st_gid, 'mode': meta.st_mode & 0o777}
                saved = backup / 'files' / rel; saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(dest, saved)
            else:
                state['files'][rel] = None
        state['ready'] = True
        (backup / 'state.json').write_text(json.dumps(state, indent=2))
        for rel in manifest:
            dest = APP / rel
            missing = []; parent = dest.parent
            while not parent.exists():
                missing.append(parent); parent = parent.parent
            for parent in reversed(missing):
                parent.mkdir(mode=0o755); os.chown(parent, user.pw_uid, user.pw_gid)
            shutil.copyfile(bundle / 'payload' / rel, dest)
            os.chown(dest, user.pw_uid, user.pw_gid); os.chmod(dest, 0o644)
        run(['runuser', '-u', 'mizanmods', '--', 'npm', 'test'], cwd=APP)
        run(['runuser', '-u', 'mizanmods', '--', 'node', 'scripts/import-catalog.js'], cwd=APP)
        if hashlib.sha256((APP / '.env').read_bytes()).digest() != original_env:
            raise RuntimeError('Environment changed unexpectedly; stop and inspect.')
        run(['systemctl', 'start', SERVICE]); health()
        print('PASS: Studio UI/bot code installed, catalog published and local health verified.')
        print('Next: refresh the panels, run scripts/configure-bot.js, then test /start and a real APK.')
    except Exception:
        if state.get('ready'):
            print('Update failed; attempting automatic rollback.', flush=True)
            rollback(backup)
        elif stopped:
            run(['systemctl', 'start', SERVICE])
        raise

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('STOP:', str(error), file=sys.stderr)
        sys.exit(1)
