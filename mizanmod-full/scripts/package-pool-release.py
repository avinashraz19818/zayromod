#!/usr/bin/env python3
"""Reproducible narrow update archive; base must be the deployed classic release."""
import hashlib,json,subprocess,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[2]
app=root/'mizanmod-full'
files=['server.js','utils/telegram.js','utils/package-pool.js','utils/package-pool-bot.js','utils/package-pool-http.js','public/admin/package-pool.js','public/admin/package-pool.css']
manifest={}
for rel in files:
    previous=None
    if rel in ['server.js','utils/telegram.js']:
        previous=hashlib.sha256(subprocess.check_output(['git','show','a28cf9d:mizanmod-full/'+rel],cwd=root)).hexdigest()
    manifest[rel]={'sha256':hashlib.sha256((app/rel).read_bytes()).hexdigest(),'previous':previous}
archive=root/'handoff/MizanMod-Package-Pool.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    def add(name,data):
        info=zipfile.ZipInfo('MizanMod-Package-Pool/'+name,date_time=(2026,9,16,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,data)
    add('manifest.json',json.dumps(manifest,indent=2)+'\n')
    add('apply-package-pool.py',(app/'scripts/apply-package-pool.py').read_bytes())
    add('README.md',(app/'docs/PACKAGE-POOL.md').read_bytes())
    for rel in files:add('payload/'+rel,(app/rel).read_bytes())
checksum=hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(checksum+'  '+archive.name+'\n')
print(checksum,archive.stat().st_size)
