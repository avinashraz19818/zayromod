'use strict';
document.addEventListener('DOMContentLoaded',()=>{
  const main=document.querySelector('main.main'),sidebar=document.querySelector('.sidebar');
  if(!main||!sidebar||document.getElementById('sec-package-pool'))return;
  const section=document.createElement('section');section.id='sec-package-pool';section.className='section';
  section.innerHTML=`<div class="topbar"><h1>Package names<small>FIFO allocation for real APKs · reserved names stay with their order</small></h1><button class="btn btn-outline" id="pkg-refresh">Refresh</button></div>
    <div class="pkg-counts"><div class="card"><b id="pkg-available">—</b><span>Available</span></div><div class="card"><b id="pkg-reserved">—</b><span>Reserved / used</span></div><div class="card"><b id="pkg-total">—</b><span>Total stored</span></div></div>
    <p id="pkg-result" role="status" aria-live="polite"></p>
    <div class="card"><h3>Bulk add packages</h3><p class="hint">One name per line. Bullets and “📦 Allocated Packages:” are accepted. Input order is preserved. Invalid and duplicate names are reported, not allocated.</p><label for="pkg-input">Package names</label><textarea id="pkg-input" rows="8" maxlength="100000" placeholder="com.mizan.a1&#10;com.mizan.a2&#10;com.mizan.sec"></textarea><button class="btn btn-primary" id="pkg-add">Add to pool</button></div>
    <div class="card"><h3>Telegram package admins</h3><p class="hint">Only these numeric user IDs can add names through the bot and receive stock alerts. Send /myid to the bot to find your ID. This is separate from public client access and credit approvals.</p><label for="pkg-admins">Numeric IDs, separated by commas</label><input id="pkg-admins" autocomplete="off" placeholder="123456789"><button class="btn btn-outline" id="pkg-save-admins">Save package admins</button></div>
    <div class="card"><div class="pkg-table-head"><h3>Stored packages</h3><label>Show <select id="pkg-filter"><option value="available">Available (next first)</option><option value="reserved">Reserved / used</option><option value="all">All</option></select></label></div><div class="pkg-table-wrap"><table><thead><tr><th>Position</th><th>Package name</th><th>Status</th><th>Order</th><th>Action</th></tr></thead><tbody id="pkg-rows"></tbody></table></div><div class="pkg-pages"><button class="btn btn-outline" id="pkg-prev">Previous</button><span id="pkg-page"></span><button class="btn btn-outline" id="pkg-next">Next</button></div></div>`;
  main.append(section);
  const link=document.createElement('a');link.className='nav-link';link.dataset.sec='package-pool';link.textContent='📦 Package names';link.tabIndex=0;link.setAttribute('role','button');
  sidebar.insertBefore(link,sidebar.querySelector('.nav-foot'));
  const el=id=>document.getElementById(id);let offset=0,busy=false;
  const say=(text,error=false)=>{el('pkg-result').textContent=text;el('pkg-result').className=error?'pkg-error':'pkg-success';};
  async function request(url,method='GET',body){
    const response=await fetch(url,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    const data=await response.json();if(!response.ok||data.error)throw Error(data.error||'Request failed');return data;
  }
  async function load(){
    try{
      const state=el('pkg-filter').value,data=await request('/api/admin/packages?state='+state+'&offset='+offset);
      for(const key of ['available','reserved','total'])el('pkg-'+key).textContent=data[key];
      if(document.activeElement!==el('pkg-admins'))el('pkg-admins').value=data.admin_ids.join(', ');
      const rows=el('pkg-rows');rows.replaceChildren();
      data.items.forEach(item=>{
        const row=document.createElement('tr');
        for(const text of [item.id,item.package_name,item.state,item.order_id?'#'+item.order_id:'—']){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}
        const action=document.createElement('td');
        if(item.state==='available'){
          const button=document.createElement('button');button.className='btn btn-outline';button.textContent='Remove';
          button.onclick=async()=>{if(!confirm('Remove unused package '+item.package_name+'?'))return;try{await request('/api/admin/packages/'+item.id,'DELETE');await load();}catch(e){say(e.message,true);}};
          action.append(button);
        }else action.textContent='Reserved permanently';
        row.append(action);rows.append(row);
      });
      if(!data.items.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=5;cell.textContent='No packages in this view.';row.append(cell);rows.append(row);}
      const total=state==='all'?data.total:data[state];el('pkg-prev').disabled=offset===0;el('pkg-next').disabled=offset+50>=total;el('pkg-page').textContent='Page '+(offset/50+1);
    }catch(e){say(e.message,true);}
  }
  link.onclick=()=>{if(typeof window.showSec==='function')window.showSec('package-pool',link);load();};
  link.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();link.click();}};
  el('pkg-refresh').onclick=load;
  el('pkg-filter').onchange=()=>{offset=0;load();};
  el('pkg-prev').onclick=()=>{offset=Math.max(0,offset-50);load();};el('pkg-next').onclick=()=>{offset+=50;load();};
  el('pkg-add').onclick=async()=>{
    if(busy)return;busy=true;el('pkg-add').disabled=true;
    try{
      const data=await request('/api/admin/packages','POST',{packages:el('pkg-input').value});
      say(`Added ${data.added.length} · duplicates ${data.duplicates.length} · already used ${data.used.length} · invalid ${data.invalid.length}`+(data.invalid.length?'\nInvalid: '+data.invalid.slice(0,10).map(x=>x.value).join(', '):''));
      if(!data.invalid.length)el('pkg-input').value='';offset=0;await load();
    }catch(e){say(e.message,true);}finally{busy=false;el('pkg-add').disabled=false;}
  };
  el('pkg-save-admins').onclick=async()=>{try{await request('/api/admin/packages/admins','POST',{ids:el('pkg-admins').value});say('Telegram package admins saved.');await load();}catch(e){say(e.message,true);}};
});
