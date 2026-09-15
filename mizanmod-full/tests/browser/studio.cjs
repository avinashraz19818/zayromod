// Mocked API and Telegram fixtures: visual/UI regression, not live integration.
const {chromium}=require('playwright');

const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'../../public');
const designs=[{id:1,name:'MizanMod Forest',price_coins:10,category:'mizanmod',fake_popup_html_file:'alternate.html',fake_price_coins:5},{id:2,name:'MizanMod Obsidian',price_coins:10,category:'mizanmod'},{id:3,name:'MizanMod Violet',price_coins:10,category:'mizanmod'}];
(async()=>{
for(const [name,width,height,admin] of [['client-desktop',1440,1100,false],['client-mobile',390,844,false],['admin-desktop',1440,1100,true],['admin-mobile',390,844,true]]){
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE || undefined,args:['--no-sandbox'],headless:true});
 const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.Telegram={WebApp:{initData:'synthetic-preview-data',ready(){},expand(){},colorScheme:'dark'}};});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.hostname!=='studio.test')return route.fulfill({status:200,contentType:'application/javascript',body:''});
  if(url.pathname.startsWith('/api/')){
   let data={};
   if(url.pathname==='/api/me')data=admin?{isAdmin:true}:{id:1,username:'Studio Preview',coins:50};
   else if(url.pathname==='/api/auth/telegram-webapp')data={success:true,user:{id:1,username:'Studio Preview',coins:50}};
   else if(url.pathname==='/api/designs'||url.pathname==='/api/admin/designs')data=designs;
   else if(url.pathname==='/api/admin/dashboard')data={stats:{total_users:12,users_today:2,total_orders:8,total_apks_built:6,active_designs:43,total_user_coins:120,pending_coin_requests:0},recent_orders:[]};
   else if(url.pathname.includes('orders')||url.pathname.includes('coin-requests'))data=[];
   else if(url.pathname==='/api/settings/payment')data={coin_rate:1};
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  }
  const rel=url.pathname==='/'?'index.html':url.pathname==='/admin/'?'admin/index.html':url.pathname.slice(1);
  const file=path.join(root,rel);if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
  const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
  return route.fulfill({status:200,contentType:types[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
 });
 await page.goto('http://studio.test'+(admin?'/admin/':'/'));await page.waitForLoadState('networkidle');
 if(!admin){await page.waitForSelector('.design-card');await page.fill('#catalogSearch','Forest');assert.equal(await page.locator('.design-card:visible').count(),1);await page.fill('#catalogSearch','');assert.equal(await page.locator('.design-card:visible').count(),3);await page.evaluate(()=>showPage('orders'));assert(await page.locator('#page-orders').isVisible());await page.evaluate(()=>showPage('home'));}
 else{await page.waitForFunction(()=>document.querySelector('#loginOverlay').style.display==='none');await page.locator('.mizan-admin-banner button').first().click();assert(await page.locator('#sec-designs').isVisible());await page.evaluate(()=>showSec('dashboard'));}
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' overflow');
 await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR || require('os').tmpdir(),'mizan-'+name+'.png'),fullPage:true});
 assert.deepEqual(errors,[],name+' page errors');console.log('PASS',name,'navigation/search/overflow and no page errors');await page.close();await browser.close();
}
})().catch(e=>{console.error(e);process.exit(1)});
