#!/usr/bin/env python3
"""Narrow stock update; never overwrite panels, configuration or restore live DB."""
import contextlib,hashlib,json,os,shutil,sqlite3,subprocess,sys,time,urllib.request,uuid
from pathlib import Path
APP=Path('/opt/mizanmod-full')
SERVICE='mizanmod-full'
ALLOWED={'server.js','utils/telegram.js','utils/package-pool.js','utils/package-pool-bot.js','utils/package-pool-http.js','public/admin/package-pool.js','public/admin/package-pool.css'}
def run(args):subprocess.run(args,check=True)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def idle():
    with contextlib.closing(sqlite3.connect((APP/'database/mizanmod.db').as_uri()+'?mode=ro',uri=True)) as db:
        if db.execute("SELECT count(*) FROM orders WHERE status IN ('pending','queued','building','processing')").fetchone()[0]:raise RuntimeError('Finish pending/active builds first. No update performed.')
def main():
    if os.geteuid()!=0:raise RuntimeError('Run as root.')
    os.umask(0o077)
    base=Path(__file__).resolve().parent
    manifest=json.loads((base/'manifest.json').read_text())
    if set(manifest)!=ALLOWED:raise RuntimeError('Unexpected payload.')
    metadata={}
    for rel,item in manifest.items():
        src,dst=base/'payload'/rel,APP/rel
        if src.is_symlink() or not src.is_file() or not src.resolve().is_relative_to((base/'payload').resolve()):raise RuntimeError('Unsafe payload.')
        if dst.is_symlink() or not dst.resolve().is_relative_to(APP.resolve()):raise RuntimeError('Unsafe destination: '+rel)
        if digest(src)!=item['sha256']:raise RuntimeError('Payload checksum mismatch: '+rel)
        if dst.exists() and digest(dst) not in [item['sha256'],item.get('previous')]:raise RuntimeError('Customized/unexpected code; refusing overwrite: '+rel)
        if item.get('previous') and not dst.is_file():raise RuntimeError('Required existing file missing: '+rel)
        if rel.endswith('.js'):run(['node','--check',str(src)])
        st=dst.stat() if dst.exists() else (APP/'server.js').stat()
        metadata[rel]=(st.st_uid,st.st_gid,st.st_mode&0o777 if dst.exists() else 0o644,dst.exists())
    protected=[APP/'.env',APP/'public/index.html',APP/'public/admin/index.html']
    unchanged={p:digest(p) for p in protected}
    idle();run(['systemctl','is-active','--quiet',SERVICE])
    backup=Path('/var/lib/mizanmod-full/package-pool-backups')/(time.strftime('%Y%m%d-%H%M%S')+'-'+str(uuid.uuid4())[:8])
    backup.mkdir(parents=True,mode=0o700)
    for rel in ALLOWED:
        if (APP/rel).exists():
            dest=backup/'code'/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(APP/rel,dest)
    (backup/'metadata.json').write_text(json.dumps(metadata,indent=2))
    print('Private code + DB backup:',backup,flush=True)
    run(['systemctl','stop',SERVICE])
    try:idle()
    except Exception:
        run(['systemctl','start',SERVICE]);raise
    try:
        with contextlib.closing(sqlite3.connect((APP/'database/mizanmod.db').as_uri()+'?mode=ro',uri=True)) as source,contextlib.closing(sqlite3.connect(backup/'mizanmod.db')) as target:source.backup(target)
        for rel in ALLOWED:
            dst=APP/rel;dst.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(base/'payload'/rel,dst)
            uid,gid,mode,_=metadata[rel];os.chown(dst,uid,gid);os.chmod(dst,mode)
        if any(digest(p)!=h for p,h in unchanged.items()):raise RuntimeError('Protected file unexpectedly changed.')
        run(['systemctl','start',SERVICE])
        healthy=False
        for _ in range(20):
            try:
                request=urllib.request.Request('http://127.0.0.1:3100/healthz',headers={'Host':'admin.mizammod.site'})
                with urllib.request.urlopen(request,timeout=2) as response:
                    if json.load(response).get('status')=='ok':healthy=True;break
            except Exception:time.sleep(1)
        if not healthy:raise RuntimeError('Health check failed.')
        run(['systemctl','is-active','--quiet',SERVICE])
        with contextlib.closing(sqlite3.connect((APP/'database/mizanmod.db').as_uri()+'?mode=ro',uri=True)) as db:
            count=db.execute("SELECT count(*) FROM package_pool WHERE state='available'").fetchone()[0]
        print('PASS: Package pool installed. Available names:',count)
        print('Add your real names in Admin > Package names. Empty stock blocks NEW real builds.')
        print('Client/admin HTML, env, signing key and deleted designs preserved.')
    except Exception:
        run(['systemctl','stop',SERVICE])
        print('STOP: Service left stopped. Keep the current DB and reserved package rows. Do NOT restore the old DB or old allocation code; share the error for a forward repair.',file=sys.stderr)
        raise
if __name__=='__main__':
    try:main()
    except Exception as e:print('STOP:',e,file=sys.stderr);sys.exit(1)
