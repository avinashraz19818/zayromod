'use strict';
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.sidebar a.nav-link:not([href])').forEach(link=>{
    link.setAttribute('role','button');link.tabIndex=0;
    link.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();link.click();}});
  });
  const input=document.getElementById('catalogSearch'),grid=document.getElementById('designsGrid'),status=document.getElementById('catalogSearchStatus');
  if(input&&grid){
    const filter=()=>{
      const term=input.value.trim().toLocaleLowerCase();let visible=0,total=0;
      grid.querySelectorAll('.design-card').forEach(card=>{
        total++;const match=(card.querySelector('h3')?.textContent||'').toLocaleLowerCase().includes(term);
        card.hidden=!match;if(match)visible++;
      });
      if(status)status.textContent=term?`${visible} of ${total} designs match your search`:'';
    };
    input.addEventListener('input',filter);
    new MutationObserver(filter).observe(grid,{childList:true});
  }
});
