"""Isolated dry run: deliberately fake root, systemd and local health HTTP."""
import importlib.util,tempfile,pathlib,zipfile,sqlite3,subprocess,io
repo=pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d)
 with zipfile.ZipFile(repo/'handoff/MizanMod-Package-Pool.zip') as z:z.extractall(root)
 base=root/'MizanMod-Package-Pool';app=root/'app';app.mkdir()
 spec=importlib.util.spec_from_file_location('installer',base/'apply-package-pool.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.APP=app
 for rel in ['server.js','utils/telegram.js']:
  p=app/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(subprocess.check_output(['git','show','a28cf9d:mizanmod-full/'+rel],cwd=repo))
 for rel in ['.env','public/index.html','public/admin/index.html']:
  p=app/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('custom preserved '+rel)
 (app/'database').mkdir()
 with sqlite3.connect(app/'database/mizanmod.db') as db:db.executescript('CREATE TABLE orders(status TEXT); CREATE TABLE package_pool(state TEXT);')
 originalPath=m.Path
 m.Path=lambda p:root/'private-backups' if str(p)=='/var/lib/mizanmod-full/package-pool-backups' else originalPath(p)
 m.os.geteuid=lambda:0
 commands=[];m.run=lambda args:commands.append(args)
 m.urllib.request.urlopen=lambda *a,**kw:io.BytesIO(b'{"status":"ok"}')
 m.main()
 assert all((app/rel).read_text()=='custom preserved '+rel for rel in ['.env','public/index.html','public/admin/index.html'])
 assert ['systemctl','stop','mizanmod-full'] in commands
 with sqlite3.connect(app/'database/mizanmod.db') as db:db.execute("INSERT INTO package_pool VALUES('reserved')")
 m.main()
 with sqlite3.connect(app/'database/mizanmod.db') as db:assert db.execute('SELECT count(*) FROM package_pool').fetchone()[0]==1
 commands.clear()
 with sqlite3.connect(app/'database/mizanmod.db') as db:db.execute("INSERT INTO orders VALUES('building')")
 try:m.main();raise AssertionError('Expected idle refusal')
 except RuntimeError as e:assert 'Finish pending' in str(e)
 assert ['systemctl','stop','mizanmod-full'] not in commands
 commands.clear();(app/'server.js').write_text('// customized backend')
 try:m.main();raise AssertionError('Expected hash refusal')
 except RuntimeError as e:assert 'refusing overwrite' in str(e)
 assert not commands
 print('PASS: installer dry run, protected files/stock, idempotency, active-build and changed-backend refusal')
