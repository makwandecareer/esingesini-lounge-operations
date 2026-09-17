(()=>{
  const isExec=()=>user&&['DIRECTOR','MANAGING_DIRECTOR'].includes(user.role);
  const isFinance=()=>user&&['DIRECTOR','MANAGING_DIRECTOR','ACCOUNTANT'].includes(user.role);
  const style=document.createElement('style');
  style.textContent='.executive-only,.finance-access{display:none!important}body.is-executive .executive-only{display:block!important}body.has-finance .finance-access{display:block!important}';
  document.head.appendChild(style);
  const oldApply=window.applyRole||applyRole;
  window.applyRole=function(){oldApply();document.body.classList.toggle('is-executive',isExec());document.body.classList.toggle('has-finance',isFinance());
    document.querySelectorAll('.nav').forEach(b=>{
      const p=b.dataset.page;
      if(['billing','suppliers','purchaseorders','reports','alerts','expenses','cashup','recentSales','audit'].includes(p)) b.style.display=isExec()?'block':'none';
      if(['pricing','accounting'].includes(p)) b.style.display=isFinance()?'block':'none';
      if(['director','products','staff','administration','openingstock','settings'].includes(p)) b.style.display=isDirector()?'block':'none';
    });
  };
  const oldShow=window.show||show;
  window.show=async function(p){
    if(['billing','suppliers','purchaseorders','reports','alerts','expenses','cashup','recentSales','audit'].includes(p)&&!isExec())return;
    if(['pricing','accounting'].includes(p)&&!isFinance())return;
    return oldShow(p);
  };
})();
