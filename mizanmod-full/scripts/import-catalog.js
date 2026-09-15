'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const Database=require('better-sqlite3');
function planCatalog(db, root) {
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'docs/publish-catalog.json'),'utf8'));
  const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const existing=db.prepare('SELECT popup_html_file,fake_popup_html_file FROM designs').all();
  const knownFiles=new Set(),knownPairs=new Set(),coveredAlternates=new Set();
  const fileHash=name=>{
    if(!name)return '';
    const file=path.resolve(root,'templates',name);
    if(!file.startsWith(path.resolve(root,'templates')+path.sep)||!fs.existsSync(file))return null;
    return sha(file);
  };
  for(const row of existing){
    for(const name of [row.popup_html_file,row.fake_popup_html_file])if(name)knownFiles.add(name);
    const primary=fileHash(row.popup_html_file),alternate=fileHash(row.fake_popup_html_file);
    if(primary&&alternate!==null)knownPairs.add(primary+'|'+alternate);
    if(alternate)coveredAlternates.add(alternate);
  }
  const planned=[];let skipped=0;
  for(const item of catalog) {
    for(const name of [item.file,item.alternate].filter(Boolean)) {
      if(!/^mizanmod-template-\d{3}\.html$/.test(name))throw Error('Unexpected template filename');
      fs.accessSync(path.join(root,'templates',name));
    }
    const hash=fileHash(item.file),altHash=fileHash(item.alternate),pair=hash+'|'+altHash;
    // Equal primary HTML with DIFFERENT alternate content is a distinct bundle.
    if(knownFiles.has(item.file)||knownPairs.has(pair)||(item.role==='alternate'&&coveredAlternates.has(hash))){skipped++;continue;}
    planned.push({...item,price:item.role==='alternate'?5:10});
    knownFiles.add(item.file);knownPairs.add(pair);
    if(item.alternate){knownFiles.add(item.alternate);coveredAlternates.add(altHash);}
  }
  return {planned,skipped};
}
function importCatalog(db,root){
  return db.transaction(()=>{
    const plan=planCatalog(db,root);
    const insert=db.prepare(`INSERT INTO designs(name,description,price_coins,original_price_coins,fake_price_coins,type,java_type,category,variant,popup_html_file,fake_popup_html_file,active)
      VALUES(?,?,?,0,5,'normal',?,?,'real',?,?,1)`);
    for(const item of plan.planned) {
      insert.run(item.name,'MizanMod Studio library. '+(item.role==='alternate'?'Standalone API design.':'Primary design'+(item.alternate?' with paired alternate.':'.')),item.price,item.category==='dhani'?'dhani':'normal',item.category,item.file,item.alternate||'');
    }
    return {inserted:plan.planned.length,skipped:plan.skipped};
  }).immediate();
}
if(require.main===module){
  process.umask(0o077);
  const root=path.resolve(__dirname,'..');let db;
  (async()=>{
    db=new Database(path.join(root,'database/mizanmod.db'),{fileMustExist:true});
    db.pragma('busy_timeout = 5000');
    if(db.prepare("SELECT count(*) AS n FROM orders WHERE status IN ('pending','queued','building','processing')").get().n)throw Error('Active/pending orders exist; finish them before catalog import.');
    const dir=path.join(root,'secrets');fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const backup=path.join(dir,'catalog-before-'+Date.now()+'-'+crypto.randomUUID()+'.db');
    await db.backup(backup);fs.chmodSync(backup,0o600);
    const result=importCatalog(db,root);
    console.log('Catalog import:',result.inserted,'published;',result.skipped,'existing/duplicate designs preserved.');
    console.log('Prices: primary 10 coins; alternate/API 5 coins. Existing prices unchanged.');
    console.log('Private database backup:',backup);
  })().catch(e=>{console.error('Catalog import stopped:',e.message);process.exitCode=1;}).finally(()=>db?.close());
}
module.exports={planCatalog,importCatalog};
