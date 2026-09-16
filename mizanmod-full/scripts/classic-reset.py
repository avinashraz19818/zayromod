#!/usr/bin/env python3
"""Restore pre-Studio panels; remove live design catalog/HTML only if no orders reference designs."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid

APP = Path('/opt/mizanmod-full')
SERVICE = 'mizanmod-full'
ALLOWED = {'public/index.html', 'public/admin/index.html', 'public/mizan-theme.css'}
BACKUPS = Path('/var/lib/mizanmod-full/classic-reset-backups')

def metadata(p):
    stat = p.stat()
    return {'uid': stat.st_uid, 'gid': stat.st_gid, 'mode': stat.st_mode & 0o777}

def copy_preserving(src, dest, meta):
    shutil.copyfile(src, dest)
    os.chown(dest, meta['uid'], meta['gid'])
    os.chmod(dest, meta['mode'])

def candidates(app, db):
    folder = app / 'templates'
    if folder.is_symlink() or not folder.resolve().is_relative_to(app.resolve()):
        raise RuntimeError('Unsafe template directory.')
    protected = {'loading.html'}
    record = db.execute("SELECT value FROM settings WHERE key='loading_html_file'").fetchone()
    if record and record[0]:
        protected.add(Path(record[0]).name)
    catalog = app / 'docs/template-catalog.json'
    if catalog.exists():
        for entry in json.loads(catalog.read_text()):
            if entry.get('role') == 'loading':
                protected.add(entry['file'])
    result = []
    for file in folder.iterdir():
        if file.name in protected or file.suffix.lower() not in ('.html', '.htm'):
            continue
        if file.is_symlink() or not file.is_file():
            raise RuntimeError('Non-regular HTML path found; review before deletion.')
        result.append(file)
    # Never follow catalog-controlled paths outside the template root.
    for row in db.execute('SELECT popup_html_file,fake_popup_html_file FROM designs'):
        for name in row:
            if not name or name in protected:
                continue
            if Path(name).name != name or Path(name).suffix.lower() not in ('.html', '.htm'):
                raise RuntimeError('Unexpected design file reference; deletion needs manual review.')
    return sorted(result)

def delete_designs(db, files):
    if db.execute('SELECT count(*) FROM orders').fetchone()[0]:
        return None
    count = db.execute('SELECT count(*) FROM designs').fetchone()[0]
    db.execute('BEGIN IMMEDIATE')
    try:
        # Recheck inside the write transaction; never delete order history.
        if db.execute('SELECT count(*) FROM orders').fetchone()[0]:
            db.rollback()
            return None
        db.execute('DELETE FROM design_preview_images')
        db.execute('DELETE FROM designs')
        for file in files:
            file.unlink()
        db.commit()
        return count
    except Exception:
        db.rollback()
        raise

def run(args):
    subprocess.run(args, check=True)

def healthy():
    for _ in range(20):
        try:
            req = urllib.request.Request('http://127.0.0.1:3100/healthz', headers={'Host': 'admin.mizammod.site'})
            with urllib.request.urlopen(req, timeout=2) as response:
                if json.load(response).get('status') == 'ok':
                    run(['systemctl', 'is-active', '--quiet', SERVICE])
                    return
        except Exception:
            time.sleep(1)
    raise RuntimeError('Service health check failed.')

def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run as root on the Mizan VPS.')
    if sys.argv[1:] != ['--delete-designs']:
        raise RuntimeError('Explicit confirmation required: --delete-designs')
    os.umask(0o077)
    bundle = Path(__file__).resolve().parent
    manifest = json.loads((bundle / 'manifest.json').read_text())
    if set(manifest) != ALLOWED:
        raise RuntimeError('Unexpected reset manifest.')
    for rel, digest in manifest.items():
        src, dest = bundle / 'payload' / rel, APP / rel
        if not src.is_file() or src.is_symlink() or not src.resolve().is_relative_to((bundle/'payload').resolve()):
            raise RuntimeError('Unsafe payload.')
        if not dest.is_file() or dest.is_symlink() or not dest.resolve().is_relative_to(APP.resolve()):
            raise RuntimeError('Expected existing panel file missing/unsafe.')
        if hashlib.sha256(src.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Payload checksum mismatch.')
    database = APP / 'database/mizanmod.db'
    if APP.is_symlink() or database.is_symlink() or not database.is_file():
        raise RuntimeError('Expected independent database missing/unsafe.')
    with contextlib.closing(sqlite3.connect(database.as_uri()+'?mode=ro',uri=True)) as db:
        if db.execute("SELECT count(*) FROM orders WHERE status IN ('pending','queued','building','processing')").fetchone()[0]:
            raise RuntimeError('Active/pending builds exist. Finish them before resetting.')
    run(['systemctl', 'is-active', '--quiet', SERVICE])
    env_hash = hashlib.sha256((APP / '.env').read_bytes()).digest()
    BACKUPS.mkdir(parents=True,exist_ok=True,mode=0o700)
    backup = BACKUPS / (time.strftime('%Y%m%d-%H%M%S')+'-'+str(uuid.uuid4())[:8])
    backup.mkdir(mode=0o700)
    print('Private backup:', backup, flush=True)
    ready = False
    run(['systemctl', 'stop', SERVICE])
    try:
        with contextlib.closing(sqlite3.connect(database)) as db:
            db.execute('PRAGMA foreign_keys=ON')
            if db.execute("SELECT count(*) FROM orders WHERE status IN ('pending','queued','building','processing')").fetchone()[0]:
                raise RuntimeError('A build appeared before shutdown; reset cancelled.')
            orders = db.execute('SELECT count(*) FROM orders').fetchone()[0]
            files = [] if orders else candidates(APP, db)
            originals = [APP/rel for rel in ALLOWED]+files
            state = {'files':{},'database':metadata(database)}
            with contextlib.closing(sqlite3.connect(backup/'database.db')) as target:
                db.backup(target)
            for file in originals:
                rel = str(file.relative_to(APP))
                saved = backup/'files'/rel
                saved.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(file,saved)
                state['files'][rel] = metadata(file)
            (backup/'state.json').write_text(json.dumps(state,indent=2))
            ready = True
            for rel in ALLOWED:
                copy_preserving(bundle/'payload'/rel,APP/rel,state['files'][rel])
            deleted = delete_designs(db,files)
        if hashlib.sha256((APP/'.env').read_bytes()).digest() != env_hash:
            raise RuntimeError('Unexpected environment change detected.')
        run(['systemctl','start',SERVICE])
        healthy()
        print('PASS: Previous panel layout restored with MizanMod branding.')
        if deleted is None:
            print('DESIGNS NOT DELETED:', orders, 'existing orders reference the catalog. Order history preserved.')
        else:
            print('PASS: Deleted', deleted, 'catalog entries and', len(files), 'live design HTML files.')
        print('Preserved: bot code/settings, env, Firebase, keystore, users/orders, shared assets, loading templates.')
        print('Private backup retained; deleted designs are not available to the live app.')
    except Exception:
        if ready:
            # Stop first, then restore the consistent pre-reset DB and all touched files.
            run(['systemctl','stop',SERVICE])
            for rel, meta in state['files'].items():
                copy_preserving(backup/'files'/rel, APP/rel, meta)
            for suffix in ('-wal','-shm'):
                Path(str(database)+suffix).unlink(missing_ok=True)
            copy_preserving(backup/'database.db', database, state['database'])
        run(['systemctl','start',SERVICE])
        print('Reset failed; previous state restored when a complete backup was available.',flush=True)
        raise

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('STOP:',str(error),file=sys.stderr)
        sys.exit(1)
