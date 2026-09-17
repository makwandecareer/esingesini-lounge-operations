(()=>{
  function install(){
    const nav=document.querySelector('nav');
    if(!nav||document.querySelector('[data-page="cigarettes"]')) return;
    const pos=document.querySelector('[data-page="pos"]');
    const btn=document.createElement('button');
    btn.className='nav'; btn.dataset.page='cigarettes'; btn.textContent='Cigarettes';
    if(pos) pos.insertAdjacentElement('afterend',btn); else nav.appendChild(btn);
    btn.onclick=()=>show('cigarettes');
    if(typeof pages==='object'){
      pages.cigarettes=async()=>{
        title.textContent='Cigarettes';
        subtitle.textContent='Age-restricted cigarette catalogue — each brand and variant listed separately';
        const rows=await api('/api/catalogue');
        const items=rows.filter(x=>String(x.category).toUpperCase()==='CIGARETTES');
        content.innerHTML=`<div class="panel"><div class="warning">Age-restricted products. Each pack is tracked separately. Director approval is required for selling-price changes.</div><div class="catalogue" style="margin-top:14px">${items.map(p=>`<div class="product"><span class="pill">CIGARETTES</span><h4>${esc(p.name)}</h4><div class="muted">${esc(p.size_label||p.serving)} · Carton ${p.units_per_case||10} packs · Stock ${p.stock_qty}</div><div class="price">${Number(p.selling_price||0)>0?money(p.selling_price):'PRICE NOT SET'}</div><div class="muted">SKU: ${esc(p.sku)}</div></div>`).join('')||'<p class="muted">No cigarette products loaded.</p>'}</div></div>`;
      };
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',install); else install();
})();
