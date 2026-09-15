'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
require('dotenv').config({path:path.join(__dirname,'..','.env')});
const env=process.env;
const checks=[];
function check(name,fn) {try{fn();checks.push({name,ok:true});}catch{checks.push({name,ok:false});}}
function must(v){if(!v)throw Error();}
check('Node 22.13+',()=>{const [a,b]=process.versions.node.split('.').map(Number);must(a>22 || (a===22&&b>=13));});
check('Dedicated session/content secrets',()=>{must(env.SESSION_SECRET?.length>=32&&env.CONTENT_ENCRYPTION_PASSWORD?.length>=32);must(env.SESSION_SECRET!==env.CONTENT_ENCRYPTION_PASSWORD);});
check('Bcrypt admin login',()=>must(env.ADMIN_USERNAME&&/^\$2[aby]\$(1[0-5])\$[./A-Za-z0-9]{53}$/.test(env.ADMIN_PASSWORD_HASH||'')));
check('Distinct admin/client HTTPS origins',()=>{const a=new URL(env.ADMIN_ORIGIN),b=new URL(env.BASE_URL);must(a.protocol==='https:'&&b.protocol==='https:'&&a.origin!==b.origin);must(a.pathname==='/'&&b.pathname==='/');must(!a.username&&!b.username&&!a.password&&!b.password);});
check('Telegram bot and client access policy',()=>{must(/^\d+:[\w-]+$/.test(env.TELEGRAM_BOT_TOKEN||''));must(/^(\*|\d+(\s*,\s*\d+)*)$/.test((env.TELEGRAM_ALLOWED_IDS||'').trim()));});
check('New Firebase project and database URL',()=>{must(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.FIREBASE_PROJECT_ID||''));const u=new URL(env.FIREBASE_DATABASE_URL);must(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash);must(u.hostname.endsWith('.firebaseio.com')||u.hostname.endsWith('.firebasedatabase.app'));});
check('Service account belongs to configured Firebase project',()=>{must(path.isAbsolute(env.GOOGLE_APPLICATION_CREDENTIALS||''));const sa=JSON.parse(fs.readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS));must(sa.type==='service_account'&&sa.project_id===env.FIREBASE_PROJECT_ID&&sa.client_email);crypto.createPrivateKey(sa.private_key);});
check('Android platform and build tools 35',()=>{must(path.isAbsolute(env.ANDROID_HOME||''));fs.accessSync(path.join(env.ANDROID_HOME,'platforms/android-35/android.jar'));for(const tool of ['zipalign','apksigner','aapt'])fs.accessSync(path.join(env.ANDROID_HOME,'build-tools/35.0.0',tool),fs.constants.X_OK);});
check('Java 17+',()=>{const r=spawnSync('java',['-version'],{encoding:'utf8',timeout:5000});const v=Number((String(r.stderr||r.stdout).match(/version "(\d+)/)||[])[1]);must(r.status===0&&v>=17);});
check('Keystore file/password/alias',()=>{must(path.isAbsolute(env.KEYSTORE_PATH||'')&&env.KEYSTORE_PASSWORD&&env.KEY_PASSWORD&&env.KEYSTORE_ALIAS);const r=spawnSync('keytool',['-list','-keystore',env.KEYSTORE_PATH,'-alias',env.KEYSTORE_ALIAS,'-storepass:env','KEYSTORE_PASSWORD'],{env,stdio:'ignore',timeout:15000});must(r.status===0);});
check('Android wrapper/loading template and original media pack',()=>{const root=path.resolve(__dirname,'..');fs.accessSync(path.join(root,'android-project/gradlew'),fs.constants.X_OK);fs.accessSync(path.join(root,'templates/loading.html'));const manifest=require('../docs/assets-manifest.json');for(const file of manifest)fs.accessSync(path.join(root,file.path));});
for(const c of checks)console.log(`${c.ok?'PASS':'MISSING'}  ${c.name}`);
if(checks.some(c=>!c.ok))process.exitCode=1;
else if(process.argv.includes('--live')) {
  (async()=>{
    // This command explicitly opts into remote tests; local doctor never contacts either service.
    const {firebaseRequest}=require('../utils/runtime-links');
    const location=['mizanmod_setup_check',crypto.randomUUID()];
    let written=false;
    try {
      const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`,{signal:AbortSignal.timeout(15000)});
      const info=await response.json();must(response.ok&&info.ok&&info.result?.is_bot);
      console.log('PASS  Telegram bot token verified');
      written=true;
      await firebaseRequest(location,'PUT',{probe:'MizanMod',at:Date.now()});
      const value=await firebaseRequest(location);must(value?.probe==='MizanMod');
      console.log('PASS  Firebase authenticated write/read');
    } catch { console.error('FAIL  Remote check failed; inspect credentials, permissions and connectivity. No secrets printed.');process.exitCode=1; }
    finally {
      if(written) {try{await firebaseRequest(location,'DELETE');console.log('PASS  Firebase test-node cleanup');}catch{console.error('FAIL  Test-node cleanup; remove only mizanmod_setup_check/'+location[1]+' in the new project.');process.exitCode=1;}}
    }
  })();
}
