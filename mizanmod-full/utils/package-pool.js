'use strict';
const pools=new WeakMap();
const JAVA_WORDS=new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null _').split(' '));
function validPackage(name){return typeof name==='string'&&name.length<=255&&/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(name)&&!name.split('.').some(s=>JAVA_WORDS.has(s));}
function parseBulk(text){
  if(typeof text!=='string'||text.length>100000)throw Error('Paste up to 100,000 characters.');
  const names=[],invalid=[];
  text.split(/\r?\n|[,;]/).forEach((value,i)=>{
    let line=value.trim();
    if(!line||/^(?:📦\s*)?(?:allocated packages|package names|packages)\s*:?$/i.test(line))return;
    line=line.replace(/^(?:[•●▪◦*\-]|\d+[.)])\s*/, '').trim();
    if(validPackage(line))names.push(line);else invalid.push({line:i+1,value:line.slice(0,180)});
  });
  if(names.length+invalid.length>1000)throw Error('Maximum 1,000 package names per batch.');
  return {names,invalid};
}
function parseIds(text){
  const ids=String(text||'').split(/[\s,]+/).filter(Boolean);
  if(ids.length>50||ids.some(id=>!/^\d{1,19}$/.test(id)||/^0+$/.test(id)))throw Error('Use numeric Telegram user IDs only, separated by commas. Wildcard access is not allowed for package admins.');
  return [...new Set(ids)];
}
function createPool(db){
  if(pools.has(db))return pools.get(db);
  db.exec(`CREATE TABLE IF NOT EXISTS package_pool(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_name TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','reserved')),
    order_id INTEGER UNIQUE,
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    allocated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS package_pool_fifo ON package_pool(state,id);
  CREATE INDEX IF NOT EXISTS orders_package_name_pool ON orders(package_name);
  CREATE TABLE IF NOT EXISTS package_pool_meta(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL DEFAULT 0,alerted_epoch INTEGER NOT NULL DEFAULT -1,lease_until INTEGER NOT NULL DEFAULT 0);
  INSERT OR IGNORE INTO package_pool_meta(id) VALUES(1);`);
  const available=()=>db.prepare("SELECT count(*) AS n FROM package_pool WHERE state='available'").get().n;
  const admins=()=>{
    const row=db.prepare("SELECT value FROM settings WHERE key='package_admin_ids'").get();
    const text=row?row.value:(process.env.TELEGRAM_PACKAGE_ADMIN_IDS||process.env.TELEGRAM_APPROVER_IDS||process.env.TELEGRAM_ADMIN_CHAT_ID||'');
    try{return parseIds(text);}catch{return [];}
  };
  const api={
    admins,
    isAdmin:id=>admins().includes(String(id)),
    setAdmins(text){const ids=parseIds(text);db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('package_admin_ids',?)").run(ids.join(','));return ids;},
    stats(){const all=db.prepare('SELECT count(*) AS total,sum(state=\'available\') AS available,sum(state=\'reserved\') AS reserved FROM package_pool').get();return {total:all.total,available:all.available||0,reserved:all.reserved||0};},
    list(state,offset=0){
      const filter=['available','reserved'].includes(state)?state:null;
      const skip=Math.max(0,Math.min(1000000,Math.trunc(Number(offset)||0)));
      return db.prepare(`SELECT * FROM package_pool ${filter?'WHERE state=?':''} ORDER BY id LIMIT 50 OFFSET ?`).all(...(filter?[filter,skip]:[skip]));
    },
    add(text,by){
      const parsed=parseBulk(text);
      return db.transaction(()=>{
        const wasEmpty=available()===0,added=[],duplicates=[],used=[];
        for(const name of parsed.names){
          if(db.prepare('SELECT 1 FROM package_pool WHERE package_name=?').get(name)){duplicates.push(name);continue;}
          if(db.prepare('SELECT 1 FROM orders WHERE package_name=?').get(name)){used.push(name);continue;}
          db.prepare('INSERT INTO package_pool(package_name,added_by) VALUES(?,?)').run(name,String(by));added.push(name);
        }
        if(wasEmpty&&added.length)db.prepare('UPDATE package_pool_meta SET epoch=epoch+1,lease_until=0 WHERE id=1').run();
        return {added,duplicates,used,invalid:parsed.invalid,...api.stats()};
      }).immediate();
    },
    remove(id){const r=db.prepare("DELETE FROM package_pool WHERE id=? AND state='available'").run(id);if(!r.changes)throw Error('Only unused packages can be removed. Reserved packages stay with their order.');return api.stats();},
    createOrder({needsPackage,fallbackName,insert,charge}){
      return db.transaction(()=>{
        const item=needsPackage?db.prepare("SELECT * FROM package_pool WHERE state='available' ORDER BY id LIMIT 1").get():null;
        if(needsPackage&&!item){const e=Error('Package names are out of stock. Please contact the admin. No coins deducted.');e.code='PACKAGE_POOL_EMPTY';throw e;}
        const name=item?item.package_name:fallbackName;
        const id=Number(insert(name));
        if(!Number.isSafeInteger(id)||id<=0)throw Error('Invalid order ID');
        if(item){
          const result=db.prepare("UPDATE package_pool SET state='reserved',order_id=?,allocated_at=CURRENT_TIMESTAMP WHERE id=? AND state='available'").run(id,item.id);
          if(result.changes!==1)throw Error('Package allocation conflict');
        }
        if(charge)charge(id);
        return {orderId:id,packageName:name,remaining:available()};
      }).immediate();
    },
    claimAlert(now=Date.now()){
      return db.transaction(()=>{
        if(available())return null;
        const row=db.prepare('SELECT * FROM package_pool_meta WHERE id=1').get();
        if(row.alerted_epoch===row.epoch||row.lease_until>now)return null;
        db.prepare('UPDATE package_pool_meta SET lease_until=? WHERE id=1').run(now+60000);
        return row.epoch;
      }).immediate();
    },
    delivered(epoch){db.prepare('UPDATE package_pool_meta SET alerted_epoch=?,lease_until=0 WHERE id=1 AND epoch=?').run(epoch,epoch);}
  };
  pools.set(db,api);return api;
}
module.exports={createPool,parseBulk,validPackage,parseIds};
