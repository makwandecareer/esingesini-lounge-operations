const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const DIRECTOR_EMAIL = String(process.env.OWNER_EMAIL || 'makwandegcora23@gmail.com').trim().toLowerCase();
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized:false } });
const originalExpress = express;
const originalStatic = express.static;
let capturedApp = null;

// Serve the existing application but inject the finance/pricing upgrade without replacing it.
express.static = function(root, options){
  const base = originalStatic(root, options);
  return function(req,res,next){
    if((req.path==='/' || req.path==='/index.html') && path.resolve(root)===path.resolve(__dirname,'public')){
      try{
        let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
        html=html.replace('</body>','<script src="/accounting.js?v=3"></script></body>');
        res.type('html').send(html); return;
      }catch(e){ return next(e); }
    }
    return base(req,res,next);
  };
};

function getAuth(app){
  const stack=(app.router&&app.router.stack)||[];
  const layer=stack.find(l=>l.route&&l.route.path==='/api/me');
  return layer&&layer.route&&layer.route.stack&&layer.route.stack[0]&&layer.route.stack[0].handle;
}
const money2=n=>Number(Number(n||0).toFixed(2));
const tempPassword=()=>`Es!${crypto.randomBytes(7).toString('base64url')}7`;

async function ensureAccounting(){
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS target_markup_percent NUMERIC(8,2) NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS pricing_note TEXT;
    CREATE TABLE IF NOT EXISTS supplier_product_prices(
      id BIGSERIAL PRIMARY KEY,
      supplier_id BIGINT REFERENCES suppliers(id),
      sku TEXT NOT NULL REFERENCES products(sku),
      supplier_unit_cost NUMERIC(12,2),
      supplier_case_cost NUMERIC(12,2),
      units_per_case INTEGER NOT NULL DEFAULT 1,
      target_markup_percent NUMERIC(8,2) NOT NULL DEFAULT 0,
      effective_from DATE NOT NULL DEFAULT current_date,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS spp_sku_idx ON supplier_product_prices(sku,active,effective_from DESC,id DESC);
    CREATE TABLE IF NOT EXISTS journal_entries(
      id BIGSERIAL PRIMARY KEY,
      journal_no TEXT UNIQUE NOT NULL,
      business_date DATE NOT NULL DEFAULT current_date,
      description TEXT NOT NULL,
      reference TEXT,
      status TEXT NOT NULL DEFAULT 'POSTED',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS journal_lines(
      id BIGSERIAL PRIMARY KEY,
      journal_id BIGINT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_code TEXT NOT NULL,
      account_name TEXT NOT NULL,
      debit NUMERIC(14,2) NOT NULL DEFAULT 0,
      credit NUMERIC(14,2) NOT NULL DEFAULT 0,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS chart_of_accounts(
      account_code TEXT PRIMARY KEY,
      account_name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    INSERT INTO chart_of_accounts(account_code,account_name,account_type) VALUES
      ('1000','Cash on Hand','ASSET'),('1010','Bank / Capitec','ASSET'),('1200','Inventory','ASSET'),
      ('1300','Event Receivables','ASSET'),('2000','Accounts Payable','LIABILITY'),('3000','Owner Equity','EQUITY'),
      ('4000','Bar & Food Sales','INCOME'),('4100','Event Revenue','INCOME'),('5000','Cost of Goods Sold','EXPENSE'),
      ('6000','Operating Expenses','EXPENSE'),('6100','Merchant Fees','EXPENSE'),('6200','Stock Variance / Loss','EXPENSE')
    ON CONFLICT(account_code) DO NOTHING;
  `);
}

function install(app){
  const auth=getAuth(app);
  if(!auth) throw new Error('Could not attach accounting module: authentication route unavailable');
  const finance=(req,res,next)=>auth(req,res,()=>['DIRECTOR','MANAGING_DIRECTOR','ACCOUNTANT'].includes(req.user.role)?next():res.status(403).json({error:'Finance permission required'}));
  const dir=(req,res,next)=>auth(req,res,()=>req.user.role==='DIRECTOR'&&req.user.email===DIRECTOR_EMAIL?next():res.status(403).json({error:'Director authorisation required'}));
  const audit=async(actor,action,entity,id,details={})=>pool.query(`INSERT INTO audit_log(actor,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)`,[actor,action,entity,id||null,details]);

  app.get('/api/accounting/pricing',finance,async(req,res)=>{
    const {rows}=await pool.query(`
      SELECT p.sku,p.category,p.name,p.size_label,p.units_per_case,p.selling_price::float selling_price,
        i.unit_cost::float inventory_unit_cost,p.target_markup_percent::float target_markup_percent,
        s.id supplier_id,s.name supplier_name,sp.supplier_unit_cost::float supplier_unit_cost,
        sp.supplier_case_cost::float supplier_case_cost,
        COALESCE(sp.supplier_unit_cost,i.unit_cost,0)::float cost_basis,
        CASE WHEN COALESCE(sp.supplier_unit_cost,i.unit_cost,0)>0 THEN ROUND(((p.selling_price-COALESCE(sp.supplier_unit_cost,i.unit_cost))/COALESCE(sp.supplier_unit_cost,i.unit_cost))*100,2)::float ELSE 0 END actual_markup_percent,
        CASE WHEN p.selling_price>0 AND COALESCE(sp.supplier_unit_cost,i.unit_cost,0)>0 THEN ROUND(((p.selling_price-COALESCE(sp.supplier_unit_cost,i.unit_cost))/p.selling_price)*100,2)::float ELSE 0 END gross_margin_percent,
        ROUND((COALESCE(sp.supplier_unit_cost,i.unit_cost,0)*(1+p.target_markup_percent/100)),2)::float recommended_price
      FROM products p JOIN inventory i USING(sku)
      LEFT JOIN LATERAL (SELECT * FROM supplier_product_prices x WHERE x.sku=p.sku AND x.active=TRUE ORDER BY effective_from DESC,id DESC LIMIT 1) sp ON TRUE
      LEFT JOIN suppliers s ON s.id=sp.supplier_id
      WHERE p.active=TRUE ORDER BY p.category,p.name,p.size_label
    `); res.json(rows);
  });

  app.put('/api/accounting/pricing/:sku',dir,async(req,res)=>{
    const sku=req.params.sku,b=req.body||{},supplierId=b.supplier_id?Number(b.supplier_id):null,unitCost=Number(b.supplier_unit_cost),caseCost=b.supplier_case_cost===''||b.supplier_case_cost==null?null:Number(b.supplier_case_cost),markup=Number(b.target_markup_percent||0);
    if(!(unitCost>=0)||!(markup>=0)) return res.status(400).json({error:'Valid supplier cost and markup required'});
    const {rows:[p]}=await pool.query(`SELECT units_per_case FROM products WHERE sku=$1`,[sku]); if(!p)return res.status(404).json({error:'Product not found'});
    await pool.query(`UPDATE supplier_product_prices SET active=FALSE WHERE sku=$1`,[sku]);
    await pool.query(`INSERT INTO supplier_product_prices(supplier_id,sku,supplier_unit_cost,supplier_case_cost,units_per_case,target_markup_percent,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[supplierId,sku,unitCost,caseCost,p.units_per_case,markup,b.notes||null,req.user.email]);
    await pool.query(`UPDATE products SET target_markup_percent=$2,pricing_note=$3 WHERE sku=$1`,[sku,markup,b.notes||null]);
    const recommended=money2(unitCost*(1+markup/100));
    if(b.apply_price===true){await pool.query(`UPDATE products SET selling_price=$2 WHERE sku=$1`,[sku,recommended]);}
    await audit(req.user.email,'SUPPLIER_PRICE_AND_MARKUP_UPDATED','PRODUCT',sku,{supplier_id:supplierId,supplier_unit_cost:unitCost,markup,recommended,applied:!!b.apply_price});
    res.json({ok:true,recommended_price:recommended,applied:!!b.apply_price});
  });

  app.get('/api/accounting/supplier-price-history/:sku',finance,async(req,res)=>{
    const {rows}=await pool.query(`SELECT sp.*,s.name supplier_name FROM supplier_product_prices sp LEFT JOIN suppliers s ON s.id=sp.supplier_id WHERE sp.sku=$1 ORDER BY sp.id DESC LIMIT 100`,[req.params.sku]);res.json(rows);
  });

  app.post('/api/accounting/accountants',dir,async(req,res)=>{
    const b=req.body||{},email=String(b.email||'').trim().toLowerCase(); if(!email||!b.full_name)return res.status(400).json({error:'Accountant name and email required'});
    const pw=String(b.password||'')||tempPassword(); const emp=String(b.employee_no||'').trim()||`ACC-${Date.now().toString().slice(-6)}`;
    try{const hash=await bcrypt.hash(pw,12);const {rows:[u]}=await pool.query(`INSERT INTO users(email,password_hash,role,active,full_name,employee_no,phone,job_title,department,hire_date,access_note,must_change_password) VALUES($1,$2,'ACCOUNTANT',TRUE,$3,$4,$5,$6,'Finance',$7,$8,TRUE) RETURNING id,email,role,full_name,employee_no`,[email,hash,b.full_name,emp,b.phone||null,b.job_title||'Accountant',b.hire_date||null,b.access_note||null]);await audit(req.user.email,'ACCOUNTANT_REGISTERED','USER',String(u.id),{email,employee_no:emp});res.json({ok:true,user:u,temporary_password:pw});}catch(e){res.status(400).json({error:e.code==='23505'?'Email already exists':e.message});}
  });
  app.get('/api/accounting/accountants',dir,async(req,res)=>{const {rows}=await pool.query(`SELECT id,email,role,active,full_name,employee_no,phone,job_title,department,last_login_at,created_at FROM users WHERE role='ACCOUNTANT' ORDER BY id`);res.json(rows);});
  app.put('/api/accounting/accountants/:id',dir,async(req,res)=>{const id=Number(req.params.id);const active=req.body.active!==false;let generated=null;if(req.body.generate_password){generated=tempPassword();const hash=await bcrypt.hash(generated,12);await pool.query(`UPDATE users SET password_hash=$2,must_change_password=TRUE WHERE id=$1 AND role='ACCOUNTANT'`,[id,hash]);}await pool.query(`UPDATE users SET active=$2 WHERE id=$1 AND role='ACCOUNTANT'`,[id,active]);await audit(req.user.email,'ACCOUNTANT_ACCESS_UPDATED','USER',String(id),{active});res.json({ok:true,temporary_password:generated});});

  app.get('/api/accounting/dashboard',finance,async(req,res)=>{
    const from=req.query.from||new Date().toISOString().slice(0,10),to=req.query.to||from;
    const {rows:[sales]}=await pool.query(`SELECT COALESCE(sum(s.subtotal-s.discount_amount) FILTER(WHERE s.status='COMPLETED'),0)::float revenue,COALESCE(sum(si.qty*COALESCE(i.unit_cost,0)) FILTER(WHERE s.status='COMPLETED'),0)::float cogs FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id LEFT JOIN inventory i ON i.sku=si.sku WHERE s.created_at::date BETWEEN $1 AND $2`,[from,to]);
    const {rows:[exp]}=await pool.query(`SELECT COALESCE(sum(amount),0)::float expenses FROM expenses WHERE created_at::date BETWEEN $1 AND $2`,[from,to]);
    const {rows:[fees]}=await pool.query(`SELECT COALESCE(sum(fees),0)::float merchant_fees FROM merchant_settlements WHERE business_date BETWEEN $1 AND $2`,[from,to]);
    const {rows:[stock]}=await pool.query(`SELECT COALESCE(sum(qty*COALESCE(unit_cost,0)),0)::float stock_value FROM inventory`);
    const {rows:[events]}=await pool.query(`SELECT COALESCE(sum(balance),0)::float event_receivables FROM events WHERE balance>0 AND status NOT IN('CANCELLED','COMPLETED')`);
    const {rows:[cash]}=await pool.query(`SELECT COALESCE(sum(subtotal-discount_amount) FILTER(WHERE payment_method='CASH' AND status='COMPLETED'),0)::float cash_sales FROM sales WHERE created_at::date BETWEEN $1 AND $2`,[from,to]);
    const {rows:[cashExp]}=await pool.query(`SELECT COALESCE(sum(amount),0)::float cash_expenses FROM expenses WHERE payment_method='CASH' AND created_at::date BETWEEN $1 AND $2`,[from,to]);
    const {rows:[banked]}=await pool.query(`SELECT COALESCE(sum(net_amount),0)::float cash_banked FROM merchant_settlements WHERE channel='CASH_BANKING' AND business_date BETWEEN $1 AND $2`,[from,to]);
    const {rows:[card]}=await pool.query(`SELECT COALESCE(sum(subtotal-discount_amount) FILTER(WHERE payment_method='CARD' AND status='COMPLETED'),0)::float card_sales FROM sales WHERE created_at::date BETWEEN $1 AND $2`,[from,to]);
    const {rows:[cardSett]}=await pool.query(`SELECT COALESCE(sum(net_amount),0)::float card_settled FROM merchant_settlements WHERE channel='CAPITEC_CARD' AND business_date BETWEEN $1 AND $2`,[from,to]);
    const gross=sales.revenue-sales.cogs,net=gross-exp.expenses-fees.merchant_fees;
    res.json({from,to,revenue:sales.revenue,cogs:sales.cogs,gross_profit:money2(gross),gross_margin_percent:sales.revenue?money2(gross/sales.revenue*100):0,expenses:exp.expenses,merchant_fees:fees.merchant_fees,net_operating_result:money2(net),stock_value:stock.stock_value,event_receivables:events.event_receivables,cash_expected_on_hand:money2(cash.cash_sales-cashExp.cash_expenses-banked.cash_banked),card_outstanding:money2(card.card_sales-cardSett.card_settled)});
  });

  app.get('/api/accounting/chart-of-accounts',finance,async(req,res)=>{const {rows}=await pool.query(`SELECT * FROM chart_of_accounts WHERE active=TRUE ORDER BY account_code`);res.json(rows);});
  app.get('/api/accounting/journals',finance,async(req,res)=>{const {rows}=await pool.query(`SELECT je.*,COALESCE(sum(jl.debit),0)::float debit,COALESCE(sum(jl.credit),0)::float credit FROM journal_entries je LEFT JOIN journal_lines jl ON jl.journal_id=je.id GROUP BY je.id ORDER BY je.id DESC LIMIT 100`);res.json(rows);});
  app.post('/api/accounting/journals',finance,async(req,res)=>{
    const b=req.body||{},lines=Array.isArray(b.lines)?b.lines:[];if(!b.description||lines.length<2)return res.status(400).json({error:'Description and at least two journal lines required'});
    const debit=money2(lines.reduce((a,x)=>a+Number(x.debit||0),0)),credit=money2(lines.reduce((a,x)=>a+Number(x.credit||0),0));if(debit<=0||debit!==credit)return res.status(400).json({error:'Journal must balance: total debits must equal total credits'});
    const c=await pool.connect();try{await c.query('BEGIN');const no='JRN-'+Date.now().toString(36).toUpperCase();const {rows:[j]}=await c.query(`INSERT INTO journal_entries(journal_no,business_date,description,reference,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[no,b.business_date||new Date().toISOString().slice(0,10),b.description,b.reference||null,req.user.email]);for(const l of lines){await c.query(`INSERT INTO journal_lines(journal_id,account_code,account_name,debit,credit,note) VALUES($1,$2,$3,$4,$5,$6)`,[j.id,l.account_code,l.account_name,Number(l.debit||0),Number(l.credit||0),l.note||null]);}await c.query('COMMIT');await audit(req.user.email,'JOURNAL_POSTED','JOURNAL',no,{debit,credit});res.json({ok:true,journal:j});}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message});}finally{c.release();}
  });
  app.get('/api/accounting/trial-balance',finance,async(req,res)=>{const {rows}=await pool.query(`SELECT jl.account_code,jl.account_name,COALESCE(sum(jl.debit),0)::float debit,COALESCE(sum(jl.credit),0)::float credit,(COALESCE(sum(jl.debit),0)-COALESCE(sum(jl.credit),0))::float balance FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id WHERE je.status='POSTED' GROUP BY jl.account_code,jl.account_name ORDER BY jl.account_code`);const debit=money2(rows.reduce((a,x)=>a+Number(x.debit),0)),credit=money2(rows.reduce((a,x)=>a+Number(x.credit),0));res.json({rows,total_debit:debit,total_credit:credit,balanced:debit===credit});});
}

// Patch app creation/listen while preserving Express itself.
const appProto=express.application;
const originalListen=appProto.listen;
appProto.listen=function(...args){
  if(!this.__accountingInstalled){this.__accountingInstalled=true;install(this);}
  return originalListen.apply(this,args);
};

ensureAccounting().catch(e=>console.error('Accounting schema upgrade failed:',e));
