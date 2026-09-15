'use strict';
// Cosmetic Bot API changes only. No webhook, polling or access-policy changes.
require('dotenv').config({path:require('node:path').join(__dirname,'../.env')});
(async()=>{
  const Database=require('better-sqlite3'),path=require('node:path');
  const db=new Database(path.join(__dirname,'../database/mizanmod.db'),{readonly:true,fileMustExist:true});
  const token=db.prepare('SELECT value FROM settings WHERE key=?').get('telegram_bot_token')?.value||process.env.TELEGRAM_BOT_TOKEN;db.close();
  const url=process.env.BASE_URL;
  if(!token||!/^https:\/\//.test(url||''))throw Error('Missing bot or HTTPS configuration');
  const settings=[
    ['setMyName',{name:'MizanMod Studio'}],
    ['setMyShortDescription',{short_description:'Your ideas. Your apps. One workspace. Build and manage Android apps with MizanMod Studio.'}],
    ['setMyDescription',{description:'Welcome to MizanMod Studio. Explore designs, customize your app, manage credits and follow your builds. Tap Open Studio to begin. Only install apps you trust.'}],
    ['setMyCommands',{commands:[{command:'start',description:'Open your MizanMod workspace'},{command:'orders',description:'View recent builds'},{command:'wallet',description:'View credits and top up'},{command:'help',description:'Build and installation help'}]}],
    ['setChatMenuButton',{menu_button:{type:'web_app',text:'Open Studio',web_app:{url}}}]
  ];
  for(const [method,body] of settings){
    const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const data=await r.json();if(!r.ok||!data.ok)throw Error(method+' returned '+r.status);
    console.log('PASS:',method);
  }
})().catch(()=>{console.error('Bot profile update incomplete. Existing login/polling settings unchanged; retry this command later.');process.exitCode=1;});
