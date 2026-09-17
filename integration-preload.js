const express=require('express');
const fs=require('fs');
const path=require('path');
const {Pool}=require('pg');
const crypto=require('crypto');

const DATABASE_URL=process.env.DATABASE_URL;
const DIRECTOR_EMAIL=String(process.env.OWNER_EMAIL||'makwandegcora23@gmail.com').trim().toLowerCase();
const pool=new Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false}});
const baseStatic=express.static;

// Inject the one-system synchronization UI without replacing the existing application.
express.static=function(root,options){
  const base=baseStatic(root,options);
  return function(req,res,next){
    if((req.path==='/'||req.path==='/index.html')&&path.resolve(root)===path.resolve(__dirname,'public')){
      try{
        let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
        if(!html.includes('/integration.js')) html=html.replace('</body>','<script src="/integration.js?v=1"></script></body>');
        res.type('html').send(html);return;
      }catch(e){return next(e)}
    }
    return base(req,res,next);
  };
};

function getAuth(app){
  const stack=(app.router&&app.router.stack)||[];
  const layer=stack.find(l=>l.route&&l.route.path==='/api/me');
  return layer&&layer.route&&layer.route.stack&&layer.route.stack[0]&&layer.route.stack[0].handle;
}
const money=n=>Number(Number(n||0).toFixed(2));
const journalNo=()=>`AUTO-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

async function ensureSchema(){
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS auto_price_from_markup BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE inventory ADD COLUMN IF NOT EXISTS last_supplier_id BIGINT REFERENCES suppliers(id);
    ALTER TABLE inventory ADD COLUMN IF NOT EXISTS last_supplier_cost NUMERIC(12,2);
    ALTER TABLE inventory ADD COLUMN IF NOT EXISTS last_received_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS system_sync_log(
      id BIGSERIAL PRIMARY KEY,
      sync_type TEXT NOT NULL,
      sku TEXT,
      reference TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      actor TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function install(app){
  const auth=getAuth(app); if(!auth) throw new Error('Could not attach integration module: authentication unavailable');
  const manager=(req,res,next)=>auth(req,res,()=>['DIRECTOR','MANAGING_DIRECTOR','ADMINISTRATOR','MANAGER'].includes(req.user.role)?next():res.status(403).json({error:'Management permission required'}));
  const director=(req,res,next)=>auth(req,res,()=>req.user.role==='DIRECTOR'&&req.user.email===DIRECTOR_EMAIL?next():res.status(403).json({error:'Director authorisation required'}));
  const audit=async(actor,action,entity,id,details={})=>pool.query(`INSERT INTO audit_log(actor,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)`,[actor,action,entity,id||null,details]);

  app.get('/api/integration/status',manager,async(req,res)=>{
    const {rows:[r]}=await pool.query(`SELECT
      (SELECT count(*)::int FROM products WHERE active) products,
      (SELECT count(*)::int FROM inventory WHERE last_received_at IS NOT NULL) synced_stock_items,
      (SELECT count(*)::int FROM supplier_product_prices WHERE active) active_supplier_prices,
      (SELECT count(*)::int FROM journal_entries WHERE status='POSTED') posted_journals,
      (SELECT max(created_at) FROM system_sync_log) last_sync`);
    res.json(r);
  });

  // One write updates stock, supplier cost, weighted inventory cost, markup, optional selling price, accounting and audit together.
  app.post('/api/integration/stock-receipt',manager,async(req,res)=>{
    const b=req.body||{};
    const sku=String(b.sku||'').trim();
    const supplierId=b.supplier_id?Number(b.supplier_id):null;
    const mode=String(b.mode||'UNIT').toUpperCase();
    const qtyInput=Number(b.qty);
    const costInput=Number(b.supplier_cost);
    const markup=Number(b.target_markup_percent||0);
    const payment=String(b.payment_method||'CREDIT').toUpperCase();
    const applyPrice=b.apply_price===true;
    if(!sku||!(qtyInput>0)||!(costInput>=0)||!(markup>=0))return res.status(400).json({error:'Product, quantity, supplier cost and valid markup are required'});
    if(!['UNIT','CASE'].includes(mode))return res.status(400).json({error:'Mode must be UNIT or CASE'});
    if(!['CREDIT','CASH','EFT','CARD'].includes(payment))return res.status(400).json({error:'Invalid payment method'});
    if(applyPrice&&!(req.user.role==='DIRECTOR'&&req.user.email===DIRECTOR_EMAIL))return res.status(403).json({error:'Only the Director may apply a selling price'});

    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const {rows:[p]}=await c.query(`SELECT p.sku,p.name,p.units_per_case,p.selling_price::float,i.qty::float old_qty,i.unit_cost::float old_cost FROM products p JOIN inventory i USING(sku) WHERE p.sku=$1 FOR UPDATE`,[sku]);
      if(!p)throw new Error('Product not found');
      if(supplierId){const {rows:[s]}=await c.query(`SELECT id FROM suppliers WHERE id=$1 AND active=TRUE`,[supplierId]);if(!s)throw new Error('Supplier not found or inactive')}
      const unitsPerCase=Math.max(1,Number(p.units_per_case||1));
      const receivedUnits=mode==='CASE'?qtyInput*unitsPerCase:qtyInput;
      const supplierUnitCost=mode==='CASE'?costInput/unitsPerCase:costInput;
      const supplierCaseCost=mode==='CASE'?costInput:supplierUnitCost*unitsPerCase;
      const oldQty=Math.max(0,Number(p.old_qty||0)),oldCost=Math.max(0,Number(p.old_cost||0));
      const newQty=oldQty+receivedUnits;
      const weightedCost=newQty>0?money(((oldQty*oldCost)+(receivedUnits*supplierUnitCost))/newQty):money(supplierUnitCost);
      const recommended=money(supplierUnitCost*(1+markup/100));
      const reference=String(b.reference||'').trim()||`GRN-${Date.now().toString(36).toUpperCase()}`;
      const totalPurchase=money(receivedUnits*supplierUnitCost);

      await c.query(`UPDATE inventory SET qty=$2,unit_cost=$3,last_supplier_id=$4,last_supplier_cost=$5,last_received_at=now(),updated_at=now() WHERE sku=$1`,[sku,newQty,weightedCost,supplierId,supplierUnitCost]);
      await c.query(`UPDATE supplier_product_prices SET active=FALSE WHERE sku=$1`,[sku]);
      await c.query(`INSERT INTO supplier_product_prices(supplier_id,sku,supplier_unit_cost,supplier_case_cost,units_per_case,target_markup_percent,effective_from,active,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,current_date,TRUE,$7,$8)`,[supplierId,sku,supplierUnitCost,supplierCaseCost,unitsPerCase,markup,b.note||'Stock receipt synchronization',req.user.email]);
      await c.query(`UPDATE products SET target_markup_percent=$2,auto_price_from_markup=$3,pricing_note=$4 ${applyPrice?',selling_price=$5':''} WHERE sku=$1`,applyPrice?[sku,markup,!!b.auto_price,b.note||null,recommended]:[sku,markup,!!b.auto_price,b.note||null]);
      await c.query(`INSERT INTO stock_movements(sku,movement_type,qty,unit_cost,reference,note,actor) VALUES($1,'SYNC_RECEIPT',$2,$3,$4,$5,$6)`,[sku,receivedUnits,supplierUnitCost,reference,b.note||'Unified stock receipt',req.user.email]);

      const creditCode=payment==='CREDIT'?'2000':payment==='CASH'?'1000':'1010';
      const creditName=payment==='CREDIT'?'Accounts Payable':payment==='CASH'?'Cash on Hand':'Bank / Capitec';
      const jno=journalNo();
      const {rows:[j]}=await c.query(`INSERT INTO journal_entries(journal_no,business_date,description,reference,status,created_by) VALUES($1,current_date,$2,$3,'POSTED',$4) RETURNING id`,[jno,`Stock purchase: ${p.name}`,reference,req.user.email]);
      await c.query(`INSERT INTO journal_lines(journal_id,account_code,account_name,debit,credit,note) VALUES($1,'1200','Inventory',$2,0,$3),($1,$4,$5,0,$2,$3)`,[j.id,totalPurchase,`Automatic stock receipt ${reference}`,creditCode,creditName]);
      await c.query(`INSERT INTO system_sync_log(sync_type,sku,reference,details,actor) VALUES('STOCK_RECEIPT',$1,$2,$3,$4)`,[sku,reference,{received_units:receivedUnits,supplier_unit_cost:supplierUnitCost,weighted_cost:weightedCost,markup,recommended_price:recommended,selling_price_applied:applyPrice,payment_method:payment,journal_no:jno},req.user.email]);
      await c.query('COMMIT');
      await audit(req.user.email,'UNIFIED_STOCK_SYNC','PRODUCT',sku,{reference,receivedUnits,supplierUnitCost,weightedCost,markup,recommended,applyPrice,payment,journal_no:jno});
      res.json({ok:true,sku,reference,received_units:receivedUnits,new_stock_qty:newQty,supplier_unit_cost:money(supplierUnitCost),weighted_inventory_cost:weightedCost,target_markup_percent:markup,recommended_selling_price:recommended,selling_price:applyPrice?recommended:p.selling_price,accounting_journal:jno,total_purchase:totalPurchase});
    }catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message});}finally{c.release()}
  });

  app.get('/api/integration/sync-log',manager,async(req,res)=>{const {rows}=await pool.query(`SELECT * FROM system_sync_log ORDER BY id DESC LIMIT 100`);res.json(rows)});

  app.put('/api/integration/auto-price/:sku',director,async(req,res)=>{
    await pool.query(`UPDATE products SET auto_price_from_markup=$2 WHERE sku=$1`,[req.params.sku,req.body.enabled===true]);
    await audit(req.user.email,'AUTO_PRICE_POLICY_CHANGED','PRODUCT',req.params.sku,{enabled:req.body.enabled===true});
    res.json({ok:true});
  });
}

const proto=express.application;
const priorListen=proto.listen;
proto.listen=function(...args){
  if(!this.__integrationInstalled){this.__integrationInstalled=true;install(this)}
  return priorListen.apply(this,args);
};
ensureSchema().catch(e=>console.error('Integration schema upgrade failed:',e));
