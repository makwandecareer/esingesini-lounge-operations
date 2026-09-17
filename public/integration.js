(()=>{
  const oldShow=show;
  const oldReceiving=pages.receiving;

  pages.receiving=async()=>{
    title.textContent='Stock Receiving & System Sync';
    subtitle.textContent='One entry updates stock, supplier cost, markup, accounting and reporting';
    const [suppliers,status]=await Promise.all([api('/api/suppliers'),api('/api/integration/status')]);
    await loadCatalogue();
    content.innerHTML=`
      <div class="warning"><b>ONE SYSTEM / ONE SOURCE OF TRUTH.</b> When stock is received here, the system updates inventory quantity, supplier price history, weighted stock cost, markup, recommended selling price, accounting journal, stock valuation and management reports automatically.</div>
      <div class="metrics">
        ${metric('Active Products',status.products)}
        ${metric('Stock Items Synced',status.synced_stock_items)}
        ${metric('Supplier Prices',status.active_supplier_prices)}
        ${metric('Posted Journals',status.posted_journals)}
      </div>
      <div class="panel"><h3>Receive Real Stock</h3>
        <div class="three">
          <label>Supplier<select id="syncSupplier"><option value="">No supplier selected</option>${suppliers.filter(s=>s.active).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
          <label>Product<select id="syncSku">${catalogue.filter(p=>p.active!==false).map(p=>`<option value="${p.sku}">${esc(p.name)} · ${esc(p.size_label||p.serving)}</option>`).join('')}</select></label>
          <label>Purchase Mode<select id="syncMode"><option value="UNIT">Individual Unit</option><option value="CASE">Full Case / Carton</option></select></label>
          <label>Quantity<input id="syncQty" type="number" min="0" step="1"></label>
          <label>Real Supplier Cost per Selected Mode<input id="syncCost" type="number" step="0.01"></label>
          <label>Target Markup %<input id="syncMarkup" type="number" step="0.01" value="30"></label>
          <label>Payment Method<select id="syncPayment"><option value="CREDIT">Supplier Credit / Accounts Payable</option><option value="CASH">Cash</option><option value="EFT">EFT / Bank</option><option value="CARD">Card / Bank</option></select></label>
          <label>Supplier Invoice / GRN Reference<input id="syncRef"></label>
          <label>Note<input id="syncNote"></label>
        </div>
        ${isDirector()?`<label style="margin-top:10px"><span>Director Selling Price Authority</span><select id="syncApply"><option value="false">Update cost + markup only; keep current selling price</option><option value="true">Apply recommended selling price immediately</option></select></label>`:''}
        <button class="btn" style="margin-top:12px" onclick="receiveAndSyncStock()">Receive Stock & Synchronise Entire System</button>
        <div id="syncMsg" class="msg"></div><div id="syncResult"></div>
      </div>
      <div class="panel"><h3>What Updates Automatically</h3>
        ${line('Inventory','Physical quantity + weighted average cost')}
        ${line('Supplier Pricing','Latest supplier unit/case cost and price history')}
        ${line('Profit Control','Target markup + recommended selling price')}
        ${line('Accounting','Inventory debit + Cash/Bank/Accounts Payable credit')}
        ${line('Reports','Stock value, COGS basis, gross profit and finance dashboard')}
        ${line('Audit','Stock movement + synchronization log + audit trail')}
      </div>`;
  };

  window.receiveAndSyncStock=async()=>{
    try{
      const body={
        supplier_id:syncSupplier.value||null,
        sku:syncSku.value,
        mode:syncMode.value,
        qty:Number(syncQty.value),
        supplier_cost:Number(syncCost.value),
        target_markup_percent:Number(syncMarkup.value||0),
        payment_method:syncPayment.value,
        reference:syncRef.value,
        note:syncNote.value,
        apply_price:isDirector()&&document.getElementById('syncApply')?.value==='true'
      };
      const r=await api('/api/integration/stock-receipt',{method:'POST',body:JSON.stringify(body)});
      flash('syncMsg','Stock received and the entire system was synchronised.');
      syncResult.innerHTML=`<div class="credentials"><b>Synchronization Complete</b><br>
        Reference: <code>${esc(r.reference)}</code><br>
        New stock: <b>${r.new_stock_qty}</b> units<br>
        Supplier unit cost: <b>${money(r.supplier_unit_cost)}</b><br>
        Weighted inventory cost: <b>${money(r.weighted_inventory_cost)}</b><br>
        Target markup: <b>${Number(r.target_markup_percent).toFixed(1)}%</b><br>
        Recommended selling price: <b>${money(r.recommended_selling_price)}</b><br>
        Active selling price: <b>${money(r.selling_price)}</b><br>
        Accounting journal: <code>${esc(r.accounting_journal)}</code><br>
        Purchase value: <b>${money(r.total_purchase)}</b></div>`;
      await loadCatalogue();
    }catch(e){flash('syncMsg',e.message,false)}
  };

  // Keep route permissions intact while making the synchronized receiving page the normal stock-entry path.
  window.show=async function(p){return oldShow(p)};
})();
