'use strict';
const {createPool}=require('./package-pool');
const Telegram=require('./telegram-adapter');
async function notifyEmpty(db){
  const pool=createPool(db),recipients=pool.admins();
  if(!recipients.length)return;
  const token=db.prepare("SELECT value FROM settings WHERE key='telegram_bot_token'").get()?.value||process.env.TELEGRAM_BOT_TOKEN;
  if(!token)return;
  const epoch=pool.claimAlert();if(epoch===null)return;
  try{
    const sender=new Telegram(token,{polling:false});
    for(const id of recipients)await sender.sendMessage(id,'📦 MizanMod: Package names khatam ho gaye.\n\nNew real APK builds are blocked until you refill the pool. Existing orders keep their reserved package.\n\nUse /addpackages or Admin → Package names.');
    pool.delivered(epoch);
  }catch{console.warn('[Package pool] Empty-stock alert failed; will retry without exposing credentials.');}
}
function registerPackageCommands(bot,db){
  if(!db)return;
  const pool=createPool(db),pending=new Map();
  const allowed=msg=>msg.chat?.type==='private'&&pool.isAdmin(msg.from?.id);
  const reply=(msg,text)=>bot.sendMessage(msg.chat.id,text);
  const result=async(msg,text)=>{
    try{
      const r=pool.add(text,'telegram:'+msg.from.id);
      await reply(msg,`📦 Package pool updated\nAdded: ${r.added.length}\nDuplicates skipped: ${r.duplicates.length}\nAlready used in orders: ${r.used.length}\nInvalid lines: ${r.invalid.length}\nAvailable: ${r.available}\nReserved: ${r.reserved}`+(r.invalid.length?'\n\nInvalid (first 8):\n'+r.invalid.slice(0,8).map(x=>x.value).join('\n'):''));
    }catch(e){await reply(msg,e.message);}
  };
  bot.onText(/^\/myid(?:@\w+)?\s*$/i,async msg=>{if(msg.chat?.type==='private')await reply(msg,'Your Telegram user ID: '+msg.from.id);});
  bot.onText(/^\/packages(?:@\w+)?\s*$/i,async msg=>{
    if(!allowed(msg))return reply(msg,'Package management is admin-only. Ask the web admin to authorize your numeric Telegram ID. Use /myid to see it.');
    const s=pool.stats(),next=pool.list('available').slice(0,10);
    await reply(msg,`📦 Package stock\nAvailable: ${s.available}\nReserved: ${s.reserved}\nTotal: ${s.total}\n\nNext names (FIFO):\n`+next.map(p=>'• '+p.package_name).join('\n')+'\n\n/addpackages to add names.');
  });
  bot.onText(/^\/addpackages(?:@\w+)?(?:\s+([\s\S]*))?$/i,async(msg,match)=>{
    if(!allowed(msg))return reply(msg,'Package management is admin-only. Use /myid and authorize that ID in the web admin Package names section.');
    if(match[1]?.trim()){pending.delete(String(msg.from.id));return result(msg,match[1]);}
    pending.set(String(msg.from.id),Date.now()+10*60000);
    await reply(msg,'Paste the package names in your next message (one per line). Bullets and the “Allocated Packages:” heading are accepted.\n\n/cancelpackages to cancel.');
  });
  bot.onText(/^\/cancelpackages(?:@\w+)?\s*$/i,async msg=>{if(allowed(msg)){pending.delete(String(msg.from.id));await reply(msg,'Package entry cancelled.');}});
  bot.onText(/^[\s\S]+$/,async msg=>{
    if(!allowed(msg)||msg.text.startsWith('/'))return;
    const id=String(msg.from.id),until=pending.get(id);if(!until)return;
    pending.delete(id);if(until<Date.now())return reply(msg,'Entry expired. Send /addpackages again.');
    await result(msg,msg.text);
  });
}
module.exports={notifyEmpty,registerPackageCommands};
