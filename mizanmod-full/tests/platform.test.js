'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');
const root = path.resolve(__dirname, '..');
process.env.CONTENT_ENCRYPTION_PASSWORD = crypto.randomBytes(32).toString('hex');
test('HTML processing uses independent server bridge and no embedded account defaults', () => {
  process.env.BASE_URL = 'https://app.example.test';
  const { injectParams } = require('../utils/htmlprocessor');
  const html = injectParams('<html><body><h1>Welcome</h1></body></html>', {
    registerUrl:'https://example.com/register',depositUrl:'https://example.com/deposit',wingoUrl:'https://example.com/home',firebasePath:'mizanmod_test',brandTitle:'MizanMod',minDeposit:0
  });
  assert.match(html, /app\.example\.test/);
  assert.match(html, /RTDB SHIM/);
  assert.doesNotMatch(html,/AIza[\w-]{20,}/);
});
test('encrypted content round-trips with new configured secret and unique per-build keys', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mizanmod-encryption-'));
  try {
    const api = require('../utils/encrypt'), file = path.join(dir,'content.bin');
    const key=api.generateBuildPassword(); assert.notEqual(key,api.generateBuildPassword());
    await api.encryptHtmlToBin('<h1>MizanMod</h1>',file,key);
    assert.equal(api.decryptHtmlFromBin(file,key),'<h1>MizanMod</h1>');
    assert.throws(()=>api.decryptHtmlFromBin(file,'wrong-key'));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('Telegram adapter preserves call contracts without network traffic', async () => {
  const Adapter = require('../utils/telegram-adapter');
  const bot = new Adapter('12345:synthetic-test-token', {polling:false});
  let payload; bot.client.api.sendMessage = async p=>{payload=p;return {message_id:1};};
  const result = await bot.sendMessage('123','Hello',{parse_mode:'HTML'});
  assert.equal(result.message_id,1);assert.deepEqual(payload,{chat_id:'123',text:'Hello',parse_mode:'HTML'});
  await bot.stopPolling();
});
test('full platform cold start, independent database, admin CRUD, Telegram-only sessions and isolation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mizanmod-platform-'));
  for(const name of ['server.js','database','utils','public','templates','package.json']) fs.cpSync(path.join(root,name),path.join(dir,name),{recursive:true,filter:p=>!p.endsWith('.db')&&!p.includes('.db-')});
  fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'dir');
  const port=34000+Math.floor(Math.random()*20000), base=`http://127.0.0.1:${port}`;
  const password=crypto.randomBytes(20).toString('hex'), botToken=crypto.randomBytes(24).toString('hex');
  const child=spawn(process.execPath,['server.js'],{cwd:dir,env:{...process.env,NODE_ENV:'development',HOST:'127.0.0.1',PORT:String(port),BASE_URL:base,ADMIN_ORIGIN:base,SESSION_SECRET:crypto.randomBytes(32).toString('hex'),ADMIN_PASSWORD_HASH:bcrypt.hashSync(password,10),TELEGRAM_BOT_TOKEN:botToken,TELEGRAM_ALLOWED_IDS:'123',BOT_POLLING_ENABLED:'false',TRUST_PROXY_HOPS:'0'},stdio:['ignore','pipe','pipe']});
  let log='';child.stderr.on('data',b=>log+=b.toString());
  try {
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Startup timeout: '+log)),10000);
      child.once('exit',c=>{clearTimeout(timeout);reject(Error('Server exited: '+c+' '+log));});
      child.stdout.on('data',b=>{if(b.toString().includes('running on port')){clearTimeout(timeout);resolve();}});
    });
    const req=async(url,method='GET',body,cookie)=>fetch(base+url,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual'});
    assert.equal((await req('/healthz')).status,200);
    for(const url of ['/api/login','/api/register','/auth/google','/auth/tg'])assert.equal((await req(url)).status,410);
    assert.equal((await req('/api/designs')).status,401);
    assert.equal((await req('/api/admin/users')).status,403);
    assert.equal((await req('/api/admin/firebase/selftest')).status,403);
    const denied=await req('/api/auth/telegram-webapp','POST',{initData:'user=invalid'}); assert.equal(denied.status,401);
    const auth=await req('/api/admin/login','POST',{username:'admin',password});assert.equal(auth.status,200);
    const cookie=auth.headers.get('set-cookie').split(';')[0];
    const designs=await (await req('/api/admin/designs','GET',null,cookie)).json();assert.deepEqual(designs,[]);
    const users=await (await req('/api/admin/users','GET',null,cookie)).json();assert.deepEqual(users,[]);
    const data = new FormData();data.set('name','Independent design');data.set('price_coins','10');data.set('popup_html',new Blob(['<html><body>MizanMod sample</body></html>'],{type:'text/html'}),'design.html');
    const added=await (await fetch(base+'/api/admin/designs',{method:'POST',headers:{Cookie:cookie},body:data})).json();assert.ok(added.success,JSON.stringify(added));
    assert.equal((await (await req('/api/admin/designs','GET',null,cookie)).json()).length,1);
    const sign=(id,date=Math.floor(Date.now()/1000))=>{
      const p=new URLSearchParams({auth_date:String(date),user:JSON.stringify({id,first_name:'Client'})});
      const secret=crypto.createHmac('sha256','WebAppData').update(botToken).digest();
      const msg=[...p.keys()].sort().map(k=>`${k}=${p.get(k)}`).join('\n');
      p.set('hash',crypto.createHmac('sha256',secret).update(msg).digest('hex'));return p.toString();
    };
    assert.equal((await req('/api/auth/telegram-webapp','POST',{initData:sign(456)})).status,403);
    assert.equal((await req('/api/auth/telegram-webapp','POST',{initData:sign(123,1)})).status,401);
    const tg=await req('/api/auth/telegram-webapp','POST',{initData:sign(123)});assert.equal(tg.status,200);
    const clientCookie=tg.headers.get('set-cookie').split(';')[0];
    assert.equal((await req('/api/admin/users','GET',null,clientCookie)).status,403);
    assert.equal((await req('/api/designs','GET',null,clientCookie)).status,200);
    const list=await (await req('/api/orders','GET',null,clientCookie)).json();assert.deepEqual(list,[]);
    assert.equal((await req('/api/admin/designs/'+added.id,'DELETE',null,cookie)).status,200);
  } finally {
    child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('requested media pack is complete and byte-identical to its manifest', () => {
  const manifest = require('../docs/assets-manifest.json');
  assert.equal(manifest.length, 38);
  for (const item of manifest) {
    assert.ok(!/\.(html|htm|bin|db|sqlite|p12|jks)$/i.test(item.path));
    const data = fs.readFileSync(path.join(root,item.path));
    assert.equal(data.length,item.bytes,item.path);
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'),item.sha256,item.path);
  }
  assert.ok(!fs.existsSync(path.join(root,'android-project/app/src/main/assets/loading.bin')));
});

test('private setup preserves only explicit signing values and refuses overwrites', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mizanmod-setup-'));
  try {
    fs.copyFileSync(path.join(root,'.env.example'),path.join(dir,'.env.example'));
    const key=path.join(dir,'existing-key.p12');fs.writeFileSync(key,'TEST KEY BYTES, NOT A REAL KEYSTORE');
    const old=path.join(dir,'previous.env');
    fs.writeFileSync(old,`KEYSTORE_PATH=${key}\nKEYSTORE_ALIAS=existing\nKEYSTORE_PASSWORD=unique-store-secret\nKEY_PASSWORD=unique-key-secret\nADMIN_TOKEN=must-not-copy\nFIREBASE_PROJECT_ID=must-not-copy\n`);
    const {setupPrivate}=require('../scripts/setup-private');
    setupPrivate(dir,old);
    const env=require('dotenv').parse(fs.readFileSync(path.join(dir,'.env')));
    assert.equal(env.KEYSTORE_PATH,key);assert.equal(env.KEYSTORE_ALIAS,'existing');
    assert.equal(env.KEYSTORE_PASSWORD,'unique-store-secret');assert.equal(env.KEY_PASSWORD,'unique-key-secret');
    assert.equal(env.FIREBASE_PROJECT_ID,'');assert.equal(env.ADMIN_TOKEN,undefined);
    assert.ok(env.SESSION_SECRET.length>=32);assert.notEqual(env.SESSION_SECRET,env.CONTENT_ENCRYPTION_PASSWORD);
    assert.equal(fs.statSync(path.join(dir,'.env')).mode&0o777,0o600);
    assert.equal(fs.statSync(path.join(dir,'secrets/admin-access.txt')).mode&0o777,0o600);
    assert.equal(fs.readFileSync(key,'utf8'),'TEST KEY BYTES, NOT A REAL KEYSTORE');
    assert.throws(()=>setupPrivate(dir,old),/refusing/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('all bundled templates parse and bootstrap against the independent runtime bridge', () => {
  const vm=require('node:vm');
  const {injectParams}=require('../utils/htmlprocessor');
  const catalog=require('../docs/template-catalog.json');
  assert.equal(catalog.length,69);
  process.env.BASE_URL='https://app.example.test';
  for(const item of catalog) {
    const source=fs.readFileSync(path.join(root,'templates',item.file),'utf8');
    const result=injectParams(source,{registerUrl:'https://example.com/register',depositUrl:'https://example.com/deposit',wingoUrl:'https://example.com/game',firebasePath:'mizanmod_test',brandTitle:'MizanMod',minDeposit:0});
    const scripts=[...result.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(m=>! /\bsrc\s*=/i.test(m[1]));
    for(const script of scripts)new vm.Script(script[2],{filename:item.file});
    assert.match(scripts[0][2],/RTDB SHIM/);
    assert.doesNotMatch(result, /AIza[\w-]{20,}|https:\/\/[^\s"']+\.firebaseio\.com/);
    const context=vm.createContext({});
    vm.runInContext('var window=this;',context);
    vm.runInContext(scripts[0][2],context);
    vm.runInContext('var rtdb=null;firebase.initializeApp({});rtdb=firebase.database();',context);
    assert.equal(vm.runInContext('rtdb.__mizanmodShim',context),true,item.file);
  }
});
