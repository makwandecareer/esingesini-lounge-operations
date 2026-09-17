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
        subtitle.textContent='Age-restricted POS catalogue — pack and carton sales are stock controlled';
        await loadCatalogue();
        const items=catalogue.filter(x=>String(x.category).toUpperCase()==='CIGARETTES');
        content.innerHTML=`<div class="panel"><div class="warning">Age-restricted products. Pack and carton sales deduct inventory automatically. Selling prices are controlled by the Director.</div><div class="catalogue" style="margin-top:14px">${items.map(p=>`<div class="product"><span class="pill">CIGARETTES</span><h4>${esc(p.name)}</h4><div class="muted">${esc(p.size_label||p.serving)} · Stock ${p.stock_qty} packs</div><div class="price">Pack ${money(p.selling_price)}</div><div class="muted">Carton ${p.units_per_case||10} packs · ${p.case_price!=null?money(p.case_price):money(Number(p.selling_price||0)*(p.units_per_case||10))}</div><div class="muted">SKU: ${esc(p.sku)}</div><div style="margin-top:10px"><button class="btn secondary" ${p.stock_qty<=0?'disabled':''} onclick="addCart('${p.sku}','UNIT');show('pos')">Add Pack</button>${p.units_per_case>1?` <button class="btn secondary" ${p.stock_qty<p.units_per_case?'disabled':''} onclick="addCart('${p.sku}','CASE');show('pos')">Add Carton</button>`:''}</div></div>`).join('')||'<p class="muted">No cigarette products loaded.</p>'}</div></div>`;
      };
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',install); else install();
})();
