'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
test('Telegram polling explicitly requests messages and preserves sanitized failures',async()=>{
  let pollOptions,handler;
  const logs=[];
  class Bot {
    constructor(token,options){
      assert.equal(options.timeoutMs,30000);
      this.api={sendMessage:async()=>{throw {errorCode:400,message:'SECRET_TOKEN'};}};
    }
    use(fn){handler=fn;}
    catch(){}
    async startPolling(source,options){pollOptions=options;}
    stop(){}
  }
  const mod={exports:{}};
  const source=fs.readFileSync(path.join(__dirname,'../utils/telegram-adapter.js'),'utf8');
  vm.runInNewContext(source,{
    module:mod,
    require:n=>n==='node-telegram-bot-api'?{Bot,InputFile:class{}}:
      n==='./telegram-access'?{telegramAllowed:()=>true}:require(n),
    console:{log:m=>logs.push(m)},setImmediate,Date
  });
  const bot=new mod.exports('SECRET_TOKEN',{polling:true});
  const errors=[];bot.on('polling_error',e=>errors.push(e.message));
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(pollOptions.allowedUpdates),'["message","callback_query"]');
  assert.equal(pollOptions.timeout,10);
  let called=false;bot.onText(/\/start/,()=>{called=true;});
  await handler({update:{message:{text:'/start',from:{id:123},chat:{type:'private'}}}});
  assert.equal(called,true);
  pollOptions.onError({errorCode:409,message:'SECRET_TOKEN'});
  pollOptions.onError({errorCode:409,message:'SECRET_TOKEN'});
  assert.equal(errors.length,1);
  assert.match(errors[0],/409/);
  await assert.rejects(bot.sendMessage('123','hello'),e=>e.message==='Telegram sendMessage failed (400)');
  assert.ok(logs.some(s=>s.includes('/start received; approved=true; private=true')));
  assert.ok(![...logs,...errors].join('').includes('SECRET_TOKEN'));
  await bot.stopPolling();
});
