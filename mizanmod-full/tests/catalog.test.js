'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Database=require('better-sqlite3'),path=require('node:path'),fs=require('node:fs'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const {importCatalog,planCatalog}=require('../scripts/import-catalog');
test('catalog covers every non-loading template with real pairs, never loader files',()=>{
  const source=require('../docs/template-catalog.json'),catalog=require('../docs/publish-catalog.json');
  const files=new Set(catalog.flatMap(d=>[d.file,d.alternate].filter(Boolean)));
  assert.equal(files.size,68);
  assert.equal(catalog.length,43);
  for(const item of source)assert.equal(files.has(item.file),item.role!=='loading');
  const db=new Database(':memory:');db.exec('CREATE TABLE designs(popup_html_file TEXT,fake_popup_html_file TEXT)');
  const plan=planCatalog(db,root);
  const hash=file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,'templates',file))).digest('hex');
  const covered=new Set(plan.planned.flatMap(d=>[d.file,d.alternate].filter(Boolean).map(hash)));
  assert.equal(plan.planned.length,31);
  for(const item of source.filter(d=>d.role!=='loading'))assert.ok(covered.has(hash(item.file)),item.file);
  db.close();
});
test('catalog publication is additive, priced, transactional and idempotent',()=>{
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE designs(id INTEGER PRIMARY KEY,name TEXT,description TEXT,price_coins INTEGER,original_price_coins INTEGER,fake_price_coins INTEGER,type TEXT,java_type TEXT,category TEXT,variant TEXT,popup_html_file TEXT,fake_popup_html_file TEXT,active INTEGER);
    CREATE TABLE users(id INTEGER PRIMARY KEY,coins INTEGER);INSERT INTO users VALUES(12,987);`);
  db.prepare('INSERT INTO designs(id,name,price_coins,active,popup_html_file) VALUES(1,?,?,?,?)').run('Existing client design',77,0,'mizanmod-template-001.html');
  const first=importCatalog(db,root);assert.ok(first.inserted>0);assert.ok(first.skipped>0);
  assert.deepEqual(db.prepare('SELECT name,price_coins,active FROM designs WHERE id=1').get(),{name:'Existing client design',price_coins:77,active:0});
  assert.equal(db.prepare('SELECT coins FROM users WHERE id=12').get().coins,987);
  assert.equal(db.prepare('SELECT count(*) AS n FROM designs WHERE id>1 AND (active<>1 OR price_coins NOT IN (5,10) OR fake_price_coins<>5)').get().n,0);
  const count=db.prepare('SELECT count(*) AS n FROM designs').get().n;
  assert.equal(importCatalog(db,root).inserted,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM designs').get().n,count);
  db.close();
});
test('restored panels retain scripts, branding and Telegram deep-link navigation',()=>{
  for(const name of ['public/index.html','public/admin/index.html']){
    const html=fs.readFileSync(path.join(root,name),'utf8');
    assert.match(html,/mizan-theme.css\?v=classic-3/);
    for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(script[1],{filename:name});
    assert.doesNotMatch(html,/<div class="brand-mark">Z<\/div>/);
  }
  const client=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  assert.doesNotMatch(client,/id="catalogSearch"|class="mizan-rail"/);assert.match(client,/location.hash.slice\(1\)/);
  assert.match(fs.readFileSync(path.join(root,'public/mizan-theme.css'),'utf8'),/prefers-reduced-motion/);
});
