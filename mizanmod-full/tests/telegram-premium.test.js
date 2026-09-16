'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(behavior){
  const calls=[],warnings=[];
  class Bot{constructor(){this.api={sendMessage:async args=>{calls.push(args);return behavior(args,calls.length);}};}use(){}catch(){}stop(){}}
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/telegram-adapter.js'),'utf8'),{
    module:mod,require:n=>n==='node-telegram-bot-api'?{Bot,InputFile:class{}}:require(n),
    console:{log(){},warn:m=>warnings.push(m)},setImmediate,Date
  });
  return {bot:new mod.exports('SECRET',{polling:false}),calls,warnings};
}
const message='<b>Welcome</b> <tg-emoji emoji-id="5413694143601842851">👋</tg-emoji>';
test('custom-emoji rejection retries ordinary emoji once without stripping other formatting',async()=>{
  const f=fixture((args,n)=>{if(n===1)throw {errorCode:400,description:'CUSTOM_EMOJI_INVALID'};return {message_id:7};});
  assert.equal((await f.bot.sendMessage(123,message,{parse_mode:'HTML'})).message_id,7);
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].text,'<b>Welcome</b> 👋');assert.equal(f.calls[1].parse_mode,'HTML');
  assert.equal(f.warnings.length,1);assert.ok(!f.warnings[0].includes('SECRET'));
});
test('ambiguous network errors are not retried as emoji fallback',async()=>{
  const f=fixture(()=>{throw {code:'ETIMEOUT',message:'SECRET'};});
  await assert.rejects(f.bot.sendMessage(123,message,{parse_mode:'HTML'}),/ETIMEOUT/);
  assert.equal(f.calls.length,1);
});
test('successful premium message retains custom emoji markup',async()=>{
  const f=fixture(()=>({message_id:8}));
  await f.bot.sendMessage(123,message,{parse_mode:'HTML'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].text,message);
});
