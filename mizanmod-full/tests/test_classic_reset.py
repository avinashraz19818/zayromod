import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

class ClassicResetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.app, self.bundle = root/'app',root/'bundle'
        self.app.mkdir();self.bundle.mkdir()
        spec = importlib.util.spec_from_file_location('reset',Path(__file__).resolve().parents[1]/'scripts/classic-reset.py')
        self.mod = importlib.util.module_from_spec(spec);spec.loader.exec_module(self.mod)
        self.mod.APP=self.app;self.mod.BACKUPS=root/'backups';self.mod.__file__=str(self.bundle/'classic-reset.py')
        manifest={}
        for rel in self.mod.ALLOWED:
            for prefix,value in [(self.app,'OLD'),(self.bundle/'payload','CLASSIC')]:
                p=prefix/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value)
            manifest[rel]=hashlib.sha256(b'CLASSIC').hexdigest()
        (self.bundle/'manifest.json').write_text(json.dumps(manifest))
        (self.app/'.env').write_text('KEEP_PRIVATE_VALUES')
        (self.app/'database').mkdir();(self.app/'templates/assets').mkdir(parents=True)
        for name in ['design.html','alternate.html','orphan.html','loading.html','custom-loader.html']:
            (self.app/'templates'/name).write_text(name)
        (self.app/'templates/assets/sound.mp3').write_bytes(b'SHARED_AUDIO')
        with sqlite3.connect(self.app/'database/mizanmod.db') as db:
            db.executescript("CREATE TABLE designs(id INTEGER PRIMARY KEY,popup_html_file TEXT,fake_popup_html_file TEXT);CREATE TABLE orders(id INTEGER PRIMARY KEY,design_id INTEGER REFERENCES designs(id),status TEXT);CREATE TABLE design_preview_images(design_id INTEGER REFERENCES designs(id));CREATE TABLE settings(key TEXT,value TEXT);CREATE TABLE users(id INTEGER);INSERT INTO users VALUES(42);INSERT INTO settings VALUES('loading_html_file','custom-loader.html');INSERT INTO designs VALUES(1,'design.html','alternate.html');INSERT INTO design_preview_images VALUES(1);")
        self.commands=[]

    def tearDown(self):self.tmp.cleanup()

    def invoke(self,health=lambda:None):
        old=os.umask(0o077)
        try:
            with patch.object(self.mod.os,'geteuid',return_value=0),patch.object(self.mod.sys,'argv',['classic-reset.py','--delete-designs']),patch.object(self.mod,'run',side_effect=lambda args:self.commands.append(args)),patch.object(self.mod,'healthy',side_effect=health),contextlib.redirect_stdout(io.StringIO()):self.mod.main()
        finally:os.umask(old)

    def test_delete_and_restore_classic_preserves_loaders_assets_users_env(self):
        self.invoke()
        self.assertEqual((self.app/'public/index.html').read_text(),'CLASSIC')
        for name in ['design.html','alternate.html','orphan.html']:self.assertFalse((self.app/'templates'/name).exists())
        for name in ['loading.html','custom-loader.html']:self.assertTrue((self.app/'templates'/name).exists())
        self.assertEqual((self.app/'templates/assets/sound.mp3').read_bytes(),b'SHARED_AUDIO')
        self.assertEqual((self.app/'.env').read_text(),'KEEP_PRIVATE_VALUES')
        with sqlite3.connect(self.app/'database/mizanmod.db') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM designs').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT id FROM users').fetchone()[0],42)
        self.assertTrue(list(self.mod.BACKUPS.glob('*/database.db')))

    def test_linked_orders_block_deletion_but_allow_ui_restore(self):
        with sqlite3.connect(self.app/'database/mizanmod.db') as db:db.execute("INSERT INTO orders VALUES(1,1,'done')")
        self.invoke()
        self.assertEqual((self.app/'public/index.html').read_text(),'CLASSIC')
        self.assertTrue((self.app/'templates/design.html').exists())
        with sqlite3.connect(self.app/'database/mizanmod.db') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM designs').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT count(*) FROM orders').fetchone()[0],1)

    def test_failure_rolls_back_catalog_html_and_ui(self):
        def fail():raise RuntimeError('simulated health failure')
        with self.assertRaisesRegex(RuntimeError,'simulated health failure'):self.invoke(fail)
        self.assertEqual((self.app/'public/index.html').read_text(),'OLD')
        self.assertEqual((self.app/'templates/design.html').read_text(),'design.html')
        with sqlite3.connect(self.app/'database/mizanmod.db') as db:self.assertEqual(db.execute('SELECT count(*) FROM designs').fetchone()[0],1)
        self.assertEqual(self.commands[-1],['systemctl','start','mizanmod-full'])

if __name__=='__main__':unittest.main()
