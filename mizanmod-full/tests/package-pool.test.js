'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Database=require('better-sqlite3');
const {Worker}=require('node:worker_threads');
const {createPool,parseBulk}=require('../utils/package-pool');
function init(file=':memory:'){
  const db=new Database(file);db.pragma('journal_mode=WAL');db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT,package_name TEXT,status TEXT DEFAULT 'building');CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,coins INTEGER);INSERT OR IGNORE INTO users VALUES(1,1000);");return db;
}
function create(db,pool,needsPackage=true){return pool.createOrder({needsPackage,fallbackName:'com.generated.fake',insert:name=>db.prepare('INSERT INTO orders(package_name) VALUES(?)').run(name).lastInsertRowid,charge:()=>{if(!db.prepare('UPDATE users SET coins=coins-10 WHERE id=1 AND coins>=10').run().changes)throw Error('Insufficient coins');}});}
test('bulk parser accepts requested heading/bullets in original order; invalid packages rejected',()=>{
  const parsed=parseBulk('📦 Allocated Packages:\n\n• com.mizan.a7\n• com.mizan.a1\n• com.mizan.sec\ncom.1bad\ncom.class\n<script>');
  assert.deepEqual(parsed.names,['com.mizan.a7','com.mizan.a1','com.mizan.sec']);assert.equal(parsed.invalid.length,3);
});
test('FIFO allocation, duplicate prevention, permanent reservations and empty-stock accounting',()=>{
  const db=init(),pool=createPool(db);
  db.prepare('INSERT INTO orders(package_name) VALUES(?)').run('com.already.used');
  const result=pool.add('com.mizan.a7\ncom.mizan.a1\ncom.mizan.a7\ncom.already.used','test');
  assert.equal(result.added.length,2);assert.equal(result.duplicates.length,1);assert.equal(result.used.length,1);
  const first=create(db,pool);assert.equal(first.packageName,'com.mizan.a7');
  db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(first.orderId);
  assert.equal(pool.stats().reserved,1);
  assert.equal(db.prepare('SELECT package_name FROM orders WHERE id=?').get(first.orderId).package_name,first.packageName);
  const second=create(db,pool);assert.equal(second.packageName,'com.mizan.a1');
  const before=db.prepare('SELECT coins FROM users WHERE id=1').get().coins,count=db.prepare('SELECT count(*) n FROM orders').get().n;
  assert.throws(()=>create(db,pool),e=>e.code==='PACKAGE_POOL_EMPTY');
  assert.equal(db.prepare('SELECT coins FROM users WHERE id=1').get().coins,before);assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n,count);
  db.prepare('DELETE FROM orders WHERE id=?').run(first.orderId);
  assert.equal(pool.add('com.mizan.a7','test').duplicates.length,1);
  assert.throws(()=>pool.remove(1),/Only unused/);
  assert.equal(create(db,pool,false).packageName,'com.generated.fake');assert.equal(pool.stats().reserved,2);db.close();
});
test('charge failure rolls back both order and allocation',()=>{
  const db=init(),pool=createPool(db);pool.add('com.mizan.one','test');db.prepare('UPDATE users SET coins=0').run();
  assert.throws(()=>create(db,pool),/Insufficient/);assert.equal(pool.stats().available,1);assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n,0);db.close();
});
test('empty alerts dedupe across requests, rearm after refill and retry lease expiry',()=>{
  const db=init(),pool=createPool(db);
  const epoch=pool.claimAlert(100);assert.equal(epoch,0);assert.equal(pool.claimAlert(101),null);assert.equal(pool.claimAlert(60101),0);
  pool.delivered(0);assert.equal(pool.claimAlert(200000),null);
  pool.add('com.mizan.one','test');assert.equal(pool.claimAlert(300000),null);create(db,pool);
  assert.equal(pool.claimAlert(300001),1);pool.delivered(1);assert.equal(pool.claimAlert(900000),null);db.close();
});
test('package admin permissions reject wildcard access and remain separate from clients',()=>{
  const db=init(),pool=createPool(db);pool.setAdmins('123, 456,123');assert.equal(pool.isAdmin(123),true);assert.equal(pool.isAdmin(999),false);assert.throws(()=>pool.setAdmins('*'),/numeric/);pool.setAdmins('');assert.deepEqual(pool.admins(),[]);db.close();
});
test('concurrent SQLite connections never allocate the same package twice',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mizan-pool-')),file=path.join(dir,'db.sqlite');
  const db=init(file);createPool(db).add(Array.from({length:8},(_,i)=>'com.concurrent.a'+i).join('\n'),'test');
  try{
    const code=`const {parentPort,workerData:d}=require('node:worker_threads');const Database=require(d.sqlite);const db=new Database(d.file);const pool=require(d.pool).createPool(db);const r=pool.createOrder({needsPackage:true,insert:n=>db.prepare('INSERT INTO orders(package_name) VALUES(?)').run(n).lastInsertRowid});db.close();parentPort.postMessage(r);`;
    const results=await Promise.all(Array.from({length:8},()=>new Promise((resolve,reject)=>{
      const w=new Worker(code,{eval:true,workerData:{file,sqlite:require.resolve('better-sqlite3'),pool:require.resolve('../utils/package-pool')}});
      w.once('message',resolve);w.once('error',reject);w.once('exit',c=>{if(c)reject(Error('Worker exited '+c));});
    })));
    assert.equal(new Set(results.map(x=>x.packageName)).size,8);assert.equal(createPool(db).stats().available,0);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Telegram package commands require private admin access and accept bulk follow-up',async()=>{
  const db=init(),pool=createPool(db);pool.setAdmins('123');
  const rules=[],sent=[];const bot={onText:(rx,fn)=>rules.push([rx,fn]),sendMessage:async(id,text)=>sent.push({id,text})};
  require('../utils/package-pool-bot').registerPackageCommands(bot,db);
  const dispatch=async(id,text,type='private')=>{const msg={from:{id},chat:{id,type},text};for(const [rx,fn]of rules){const match=rx.exec(text);if(match)await fn(msg,match);}};
  await dispatch(999,'/addpackages\ncom.bad.attack');assert.equal(pool.stats().total,0);
  await dispatch(123,'/addpackages\ncom.bad.group','group');assert.equal(pool.stats().total,0);
  await dispatch(123,'/addpackages');await dispatch(123,'📦 Allocated Packages:\n• com.mizan.one\n• com.mizan.two');assert.equal(pool.stats().available,2);
  assert.match(sent.at(-1).text,/Added: 2/);db.close();
});
