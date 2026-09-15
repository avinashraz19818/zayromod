import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/apply-studio-update.py'

class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        spec = importlib.util.spec_from_file_location('studio_updater', SCRIPT)
        self.mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.mod)
        self.app, self.bundle = self.root / 'app', self.root / 'bundle'
        self.app.mkdir(); self.bundle.mkdir()
        (self.app / '.env').write_text('PRIVATE_ENV_MUST_NOT_CHANGE')
        (self.app / 'database').mkdir()
        with sqlite3.connect(self.app / 'database/mizanmod.db') as db:
            db.executescript("CREATE TABLE orders(status TEXT);CREATE TABLE designs(name TEXT);INSERT INTO designs VALUES('existing');")
        manifest = {}
        for rel in self.mod.ALLOWED:
            src, dest = self.bundle / 'payload' / rel, self.app / rel
            src.parent.mkdir(parents=True, exist_ok=True);src.write_text('new-file')
            manifest[rel] = hashlib.sha256(src.read_bytes()).hexdigest()
            if rel != 'public/mark.svg':
                dest.parent.mkdir(parents=True, exist_ok=True);dest.write_text('old-file')
        (self.bundle / 'manifest.json').write_text(json.dumps(manifest))
        self.mod.APP = self.app
        self.mod.BACKUPS = self.root / 'backups'
        self.mod.__file__ = str(self.bundle / 'apply-update.py')
        self.actions = []

    def tearDown(self):
        self.temp.cleanup()

    def fake_run(self, args, **kwargs):
        self.actions.append(args)
        if args[-2:] == ['node', 'scripts/import-catalog.js']:
            with sqlite3.connect(self.app / 'database/mizanmod.db') as db:
                db.execute("INSERT INTO designs VALUES('new')")

    def invoke(self, health):
        with patch.object(self.mod.os, 'geteuid', return_value=0), patch.object(self.mod.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())), patch.object(self.mod, 'run', side_effect=self.fake_run), patch.object(self.mod, 'health', side_effect=health), patch.object(self.mod.sys, 'argv', ['apply-update.py']), contextlib.redirect_stdout(io.StringIO()):
            old_umask = os.umask(0o077)
            try:self.mod.main()
            finally:os.umask(old_umask)

    def test_success_preserves_secrets_and_existing_data(self):
        self.invoke(lambda:None)
        self.assertEqual((self.app / '.env').read_text(),'PRIVATE_ENV_MUST_NOT_CHANGE')
        self.assertEqual((self.app / 'public/index.html').read_text(),'new-file')
        with sqlite3.connect(self.app / 'database/mizanmod.db') as db:self.assertEqual(db.execute('SELECT name FROM designs').fetchall(),[('existing',),('new',)])
        self.assertTrue(list(self.mod.BACKUPS.glob('*/database.db')))

    def test_health_failure_restores_files_database_and_service(self):
        count=0
        def health():
            nonlocal count
            count+=1
            if count==1:raise RuntimeError('simulated health failure')
        with self.assertRaisesRegex(RuntimeError,'simulated health failure'):self.invoke(health)
        self.assertEqual((self.app / 'public/index.html').read_text(),'old-file')
        self.assertFalse((self.app / 'public/mark.svg').exists())
        self.assertEqual((self.app / '.env').read_text(),'PRIVATE_ENV_MUST_NOT_CHANGE')
        with sqlite3.connect(self.app / 'database/mizanmod.db') as db:self.assertEqual(db.execute('SELECT name FROM designs').fetchall(),[('existing',)])
        self.assertEqual(self.actions[-1],['systemctl','start','mizanmod-full'])

    def test_checksum_and_busy_order_guards_before_stop(self):
        src=self.bundle / 'payload/public/index.html';original=src.read_text();src.write_text('tampered')
        with self.assertRaisesRegex(RuntimeError,'Checksum mismatch'):self.invoke(lambda:None)
        self.assertEqual(self.actions,[])
        src.write_text(original)
        with sqlite3.connect(self.app / 'database/mizanmod.db') as db:db.execute("INSERT INTO orders VALUES('building')")
        with self.assertRaisesRegex(RuntimeError,'Pending/active orders'):self.invoke(lambda:None)
        self.assertFalse(any(a[:2]==['systemctl','stop'] for a in self.actions))

if __name__ == '__main__':unittest.main()
