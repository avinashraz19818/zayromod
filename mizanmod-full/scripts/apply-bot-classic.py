#!/usr/bin/env python3
"""Bot-only update: no catalog, frontend, env, keystore or database writes."""
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

APP=Path('/opt/mizanmod-full')
ALLOWED={'utils/telegram.js','utils/telegram-adapter.js','scripts/configure-bot.js'}
SERVICE='mizanmod-full'

def run(args):subprocess.run(args,check=True)

def idle():
    with contextlib.closing(sqlite3.connect((APP/'database/mizanmod.db').as_uri()+'?mode=ro',uri=True)) as db:
        if db.execute("SELECT count(*) FROM orders WHERE status IN ('pending','queued','building','processing')").fetchone()[0]:
            raise RuntimeError('Finish active/pending builds before updating.')

def main():
    if os.geteuid()!=0:raise RuntimeError('Run as root on the VPS.')
    os.umask(0o077)
    base=Path(__file__).resolve().parent
    manifest=json.loads((base/'manifest.json').read_text())
    if set(manifest)!=ALLOWED:raise RuntimeError('Unexpected payload.')
    for rel,digest in manifest.items():
        source,dest=base/'payload'/rel,APP/rel
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to((base/'payload').resolve()):raise RuntimeError('Unsafe source path.')
        if dest.is_symlink() or not dest.is_file() or not dest.resolve().is_relative_to(APP.resolve()):raise RuntimeError('Existing bot file missing/unsafe.')
        if hashlib.sha256(source.read_bytes()).hexdigest()!=digest:raise RuntimeError('Checksum mismatch.')
        run(['node','--check',str(source)])
    idle()
    run(['systemctl','is-active','--quiet',SERVICE])
    env_hash=hashlib.sha256((APP/'.env').read_bytes()).digest()
    backup=Path('/var/lib/mizanmod-full/bot-backups')/(time.strftime('%Y%m%d-%H%M%S')+'-'+str(uuid.uuid4())[:8])
    backup.mkdir(parents=True,mode=0o700)
    metadata={}
    for rel in ALLOWED:
        dest=backup/rel;dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(APP/rel,dest)
        stat=(APP/rel).stat();metadata[rel]=(stat.st_uid,stat.st_gid,stat.st_mode&0o777)
    print('Private bot-code backup:',backup,flush=True)
    run(['systemctl','stop',SERVICE])
    try:
        idle()
        for rel in ALLOWED:
            dest=APP/rel
            shutil.copyfile(base/'payload'/rel,dest)
            uid,gid,mode=metadata[rel];os.chown(dest,uid,gid);os.chmod(dest,mode)
        if hashlib.sha256((APP/'.env').read_bytes()).digest()!=env_hash:raise RuntimeError('Unexpected env change.')
        run(['systemctl','start',SERVICE])
        healthy=False
        for _ in range(20):
            try:
                req=urllib.request.Request('http://127.0.0.1:3100/healthz',headers={'Host':'admin.mizammod.site'})
                with urllib.request.urlopen(req,timeout=2) as response:
                    if json.load(response).get('status')=='ok':healthy=True;break
            except Exception:time.sleep(1)
        if not healthy:raise RuntimeError('Service health check failed.')
        run(['systemctl','is-active','--quiet',SERVICE])
        print('PASS: Classic MizanMod bot messages + custom-emoji support installed.')
        print('Panel, deleted designs, env and signing settings were not changed.')
        print('Run configure-bot.js next, then send a NEW /start. Emoji rendering depends on Telegram eligibility.')
    except Exception:
        run(['systemctl','stop',SERVICE])
        for rel in ALLOWED:
            shutil.copyfile(backup/rel,APP/rel)
            uid,gid,mode=metadata[rel];os.chown(APP/rel,uid,gid);os.chmod(APP/rel,mode)
        run(['systemctl','start',SERVICE])
        print('Previous bot code restored.',flush=True)
        raise

if __name__=='__main__':
    try:main()
    except Exception as error:print('STOP:',str(error),file=sys.stderr);sys.exit(1)
