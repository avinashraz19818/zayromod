'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
test('Studio welcome escapes identity and does not emit unconfigured support links',async()=>{
  const clients=[];
  class FakeBot extends EventEmitter{
    constructor(){super();this.rules=[];clients.push(this);}
    onText(regex,fn){this.rules.push([regex,fn]);}
    async sendMessage(chat,text,options){this.sent={chat,text,options};return {message_id:1};}
  }
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/telegram.js'),'utf8'),{
    module:mod,process:{env:{BASE_URL:'https://app.example.test'}},console,
    require:n=>n==='./telegram-adapter'?FakeBot:n==='./telegram-access'?{telegramAllowed:()=>true}:require(n)
  });
  mod.exports.initBot('12345:synthetic',null);
  const bot=clients[0];
  await bot.rules.find(([regex])=>regex.test('/start'))[1]({chat:{id:123,type:'private'},from:{id:123,first_name:'A&B <owner>'},text:'/start'});
  assert.match(bot.sent.text,/MizanMod Studio/);
  assert.match(bot.sent.text,/A&amp;B &lt;owner&gt;/);
  assert.doesNotMatch(bot.sent.text,/100%|Antivirus|VIP|╔/);
  const buttons=bot.sent.options.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length,3);
  for(const button of buttons)assert.match(button.web_app.url,/^https:\/\/app.example.test/);
});
