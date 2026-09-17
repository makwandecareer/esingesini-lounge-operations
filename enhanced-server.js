const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required for production.');
  process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const sessions = new Map();
const audit = async (actor, action, entity, entityId, details={}) => {
  await pool.query(
    `INSERT INTO audit_log(actor, action, entity, entity_id, details)
     VALUES ($1,$2,$3,$4,$5)`,
    [actor, action, entity, entityId || null, details]
  );
};

function token() { return crypto.randomBytes(32).toString('hex'); }
function auth(req,res,next){
  const t=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const s=sessions.get(t);
  if(!s) return res.status(401).json({error:'Authentication required'});
  req.user=s; next();
}
function manager(req,res,next){
  if(!['OWNER','DIRECTOR','ADMINISTRATOR','MANAGER'].includes(req.user.role)) return res.status(403).json({error:'Manager permission required'});
  next();
}

async function migrate(){
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users(
    id BIGSERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('OWNER','MANAGER','CASHIER','STOCK')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS products(
    sku TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    serving TEXT NOT NULL,
    selling_price NUMERIC(12,2) NOT NULL CHECK (selling_price>=0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS inventory(
    sku TEXT PRIMARY KEY REFERENCES products(sku) ON DELETE CASCADE,
    qty NUMERIC(14,3) NOT NULL DEFAULT 0,
    unit_cost NUMERIC(12,2),
    reorder_level NUMERIC(14,3) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS stock_movements(
    id BIGSERIAL PRIMARY KEY,
    sku TEXT NOT NULL REFERENCES products(sku),
    movement_type TEXT NOT NULL CHECK (movement_type IN ('OPENING','RECEIPT','SALE','WASTAGE','BREAKAGE','ADJUSTMENT')),
    qty NUMERIC(14,3) NOT NULL,
    unit_cost NUMERIC(12,2),
    reference TEXT,
    note TEXT,
    actor TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sales(
    id BIGSERIAL PRIMARY KEY,
    receipt_no TEXT UNIQUE NOT NULL,
    payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH','CARD','EFT')),
    subtotal NUMERIC(12,2) NOT NULL,
    cash_tendered NUMERIC(12,2),
    change_due NUMERIC(12,2),
    actor TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sale_items(
    id BIGSERIAL PRIMARY KEY,
    sale_id BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    sku TEXT NOT NULL REFERENCES products(sku),
    qty NUMERIC(14,3) NOT NULL,
    unit_price NUMERIC(12,2) NOT NULL,
    line_total NUMERIC(12,2) NOT NULL
  );
  CREATE TABLE IF NOT EXISTS expenses(
    id BIGSERIAL PRIMARY KEY,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount>=0),
    payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH','CARD','EFT')),
    reference TEXT,
    actor TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS cashups(
    id BIGSERIAL PRIMARY KEY,
    business_date DATE NOT NULL,
    opening_float NUMERIC(12,2) NOT NULL DEFAULT 0,
    expected_cash NUMERIC(12,2) NOT NULL,
    actual_cash NUMERIC(12,2) NOT NULL,
    variance NUMERIC(12,2) NOT NULL,
    card_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    eft_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    notes TEXT,
    actor TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS infrastructure_status(
    id BIGSERIAL PRIMARY KEY,
    battery_percent NUMERIC(5,2),
    solar_kw NUMERIC(8,2),
    water_percent NUMERIC(5,2),
    internet_status TEXT,
    note TEXT,
    actor TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS audit_log(
    id BIGSERIAL PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  `);

  const cat = JSON.parse(fs.readFileSync(path.join(__dirname,'data','catalogue.json'),'utf8'));
  const client = await pool.connect();
  try{
    await client.query('BEGIN');
    for(const p of cat){
      await client.query(
        `INSERT INTO products(sku,category,name,serving,selling_price,active)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(sku) DO NOTHING`,
        [p.sku,p.category,p.name,p.serving,p.selling_price_zar,p.active]
      );
      await client.query(`INSERT INTO inventory(sku) VALUES($1) ON CONFLICT(sku) DO NOTHING`,[p.sku]);
    }
    await client.query('COMMIT');
  }catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  const {rows:[countRow]}=await pool.query(`SELECT count(*)::int AS c FROM users`);
  if(countRow.c===0){
    const email=process.env.OWNER_EMAIL;
    const password=process.env.OWNER_PASSWORD;
    if(!email || !password) throw new Error('OWNER_EMAIL and OWNER_PASSWORD are required on first deployment.');
    const hash=await bcrypt.hash(password,12);
    await pool.query(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,'OWNER')`,[email.toLowerCase(),hash]);
    await audit(email,'BOOTSTRAP_OWNER','USER',email,{});
  }
}

app.get('/health', async (req,res)=>{
  try{ await pool.query('SELECT 1'); res.json({ok:true,service:'Esingesini Lounge Operations'}); }
  catch(e){ res.status(503).json({ok:false,error:'database unavailable'}); }
});

app.post('/api/login', async (req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase();
  const password=String(req.body.password||'');
  const {rows}=await pool.query(`SELECT id,email,password_hash,role,active FROM users WHERE email=$1`,[email]);
  const u=rows[0];
  if(!u || !u.active || !(await bcrypt.compare(password,u.password_hash))) return res.status(401).json({error:'Invalid credentials'});
  const t=token(); sessions.set(t,{id:u.id,email:u.email,role:u.role});
  await audit(u.email,'LOGIN','SESSION',null,{});
  res.json({token:t,user:{email:u.email,role:u.role}});
});
app.post('/api/logout',auth,(req,res)=>{
  const t=(req.headers.authorization||'').replace(/^Bearer\s+/i,''); sessions.delete(t); res.json({ok:true});
});

app.get('/api/catalogue', async (req,res)=>{
  const {rows}=await pool.query(`SELECT p.sku,p.category,p.name,p.serving,p.selling_price::float AS selling_price,
    i.qty::float AS stock_qty,i.unit_cost::float AS unit_cost,i.reorder_level::float AS reorder_level
    FROM products p JOIN inventory i USING(sku) WHERE p.active=TRUE AND p.selling_price IS NOT NULL AND p.selling_price>0 ORDER BY p.category,p.name`);
  res.json(rows);
});

app.get('/api/dashboard',auth, async (req,res)=>{
  const {rows:[s]}=await pool.query(`
    SELECT COALESCE(sum(subtotal),0)::float sales,
      COALESCE(sum(subtotal) FILTER(WHERE payment_method='CASH'),0)::float cash,
      COALESCE(sum(subtotal) FILTER(WHERE payment_method='CARD'),0)::float card,
      COALESCE(sum(subtotal) FILTER(WHERE payment_method='EFT'),0)::float eft,
      count(*)::int transactions
    FROM sales WHERE created_at::date=current_date`);
  const {rows:[e]}=await pool.query(`SELECT COALESCE(sum(amount),0)::float expenses FROM expenses WHERE created_at::date=current_date`);
  const {rows:[st]}=await pool.query(`SELECT COALESCE(sum(COALESCE(unit_cost,0)*qty),0)::float stock_value,
    count(*) FILTER(WHERE qty<=reorder_level)::int low_stock FROM inventory`);
  const {rows:[infra]}=await pool.query(`SELECT * FROM infrastructure_status ORDER BY id DESC LIMIT 1`);
  res.json({...s,...e,...st,infrastructure:infra||null});
});

app.post('/api/stock/receive',auth,manager, async (req,res)=>{
  const {sku,qty,unit_cost,reference,note}=req.body;
  const q=Number(qty), c=Number(unit_cost);
  if(!sku || !(q>0) || !(c>=0)) return res.status(400).json({error:'sku, positive qty and unit_cost required'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const r=await client.query(`UPDATE inventory SET qty=qty+$2,unit_cost=$3,updated_at=now() WHERE sku=$1 RETURNING *`,[sku,q,c]);
    if(!r.rowCount) throw new Error('Unknown SKU');
    await client.query(`INSERT INTO stock_movements(sku,movement_type,qty,unit_cost,reference,note,actor) VALUES($1,'RECEIPT',$2,$3,$4,$5,$6)`,
      [sku,q,c,reference||null,note||null,req.user.email]);
    await client.query('COMMIT');
    await audit(req.user.email,'STOCK_RECEIVED','PRODUCT',sku,{qty:q,unit_cost:c,reference});
    res.json({ok:true,inventory:r.rows[0]});
  }catch(e){ await client.query('ROLLBACK'); res.status(400).json({error:e.message}); } finally{ client.release(); }
});

app.post('/api/stock/adjust',auth,manager, async (req,res)=>{
  const {sku,qty_delta,type,note}=req.body;
  const q=Number(qty_delta);
  if(!sku || !['WASTAGE','BREAKAGE','ADJUSTMENT','OPENING'].includes(type) || !Number.isFinite(q) || q===0)
    return res.status(400).json({error:'Valid sku, type and non-zero qty_delta required'});
  const {rows}=await pool.query(`UPDATE inventory SET qty=qty+$2,updated_at=now() WHERE sku=$1 AND qty+$2>=0 RETURNING *`,[sku,q]);
  if(!rows[0]) return res.status(400).json({error:'Unknown SKU or insufficient stock'});
  await pool.query(`INSERT INTO stock_movements(sku,movement_type,qty,note,actor) VALUES($1,$2,$3,$4,$5)`,[sku,type,q,note||null,req.user.email]);
  await audit(req.user.email,'STOCK_ADJUSTED','PRODUCT',sku,{qty_delta:q,type,note});
  res.json({ok:true,inventory:rows[0]});
});

app.post('/api/sales',auth, async (req,res)=>{
  const items=Array.isArray(req.body.items)?req.body.items:[];
  const method=req.body.payment_method;
  if(!['CASH','CARD','EFT'].includes(method) || !items.length) return res.status(400).json({error:'Items and payment method required'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    let subtotal=0; const priced=[];
    for(const item of items){
      const qty=Number(item.qty);
      if(!(qty>0)) throw new Error('Invalid quantity');
      const {rows}=await client.query(`SELECT p.sku,p.name,p.selling_price::float,i.qty::float stock_qty
        FROM products p JOIN inventory i USING(sku) WHERE p.sku=$1 AND p.active=TRUE FOR UPDATE`,[item.sku]);
      const p=rows[0]; if(!p) throw new Error('Unknown product '+item.sku);
      if(p.stock_qty<qty) throw new Error('Insufficient stock for '+p.name);
      const line=Number((p.selling_price*qty).toFixed(2)); subtotal+=line; priced.push({...p,qty,line});
    }
    subtotal=Number(subtotal.toFixed(2));
    const tender=req.body.cash_tendered==null?null:Number(req.body.cash_tendered);
    if(method==='CASH' && (!(tender>=subtotal))) throw new Error('Cash tendered is below total');
    const change=method==='CASH'?Number((tender-subtotal).toFixed(2)):null;
    const ref='ES-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();
    const {rows:[sale]}=await client.query(`INSERT INTO sales(receipt_no,payment_method,subtotal,cash_tendered,change_due,actor)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,receipt_no,created_at`,[ref,method,subtotal,tender,change,req.user.email]);
    for(const p of priced){
      await client.query(`INSERT INTO sale_items(sale_id,sku,qty,unit_price,line_total) VALUES($1,$2,$3,$4,$5)`,
        [sale.id,p.sku,p.qty,p.selling_price,p.line]);
      await client.query(`UPDATE inventory SET qty=qty-$2,updated_at=now() WHERE sku=$1`,[p.sku,p.qty]);
      await client.query(`INSERT INTO stock_movements(sku,movement_type,qty,reference,actor) VALUES($1,'SALE',$2,$3,$4)`,
        [p.sku,-p.qty,ref,req.user.email]);
    }
    await client.query('COMMIT');
    await audit(req.user.email,'SALE_COMPLETED','SALE',ref,{payment_method:method,subtotal});
    res.json({ok:true,receipt_no:ref,total:subtotal,cash_tendered:tender,change_due:change,created_at:sale.created_at});
  }catch(e){ await client.query('ROLLBACK'); res.status(400).json({error:e.message}); } finally{ client.release(); }
});

app.post('/api/expenses',auth,manager, async (req,res)=>{
  const {category,description,payment_method,reference}=req.body; const amount=Number(req.body.amount);
  if(!category||!description||!(amount>=0)||!['CASH','CARD','EFT'].includes(payment_method))
    return res.status(400).json({error:'Valid expense fields required'});
  const {rows:[row]}=await pool.query(`INSERT INTO expenses(category,description,amount,payment_method,reference,actor)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[category,description,amount,payment_method,reference||null,req.user.email]);
  await audit(req.user.email,'EXPENSE_RECORDED','EXPENSE',String(row.id),{amount,payment_method});
  res.json({ok:true,expense:row});
});

app.post('/api/cashups',auth,manager, async (req,res)=>{
  const date=req.body.business_date || new Date().toISOString().slice(0,10);
  const opening=Number(req.body.opening_float||0), actual=Number(req.body.actual_cash);
  if(!Number.isFinite(actual)) return res.status(400).json({error:'actual_cash required'});
  const {rows:[tot]}=await pool.query(`SELECT
    COALESCE(sum(subtotal) FILTER(WHERE payment_method='CASH'),0)::float cash_sales,
    COALESCE(sum(subtotal) FILTER(WHERE payment_method='CARD'),0)::float card_sales,
    COALESCE(sum(subtotal) FILTER(WHERE payment_method='EFT'),0)::float eft_sales
    FROM sales WHERE created_at::date=$1`,[date]);
  const {rows:[exp]}=await pool.query(`SELECT COALESCE(sum(amount),0)::float cash_expenses FROM expenses WHERE created_at::date=$1 AND payment_method='CASH'`,[date]);
  const expected=Number((opening+tot.cash_sales-exp.cash_expenses).toFixed(2));
  const variance=Number((actual-expected).toFixed(2));
  const {rows:[row]}=await pool.query(`INSERT INTO cashups(business_date,opening_float,expected_cash,actual_cash,variance,card_total,eft_total,notes,actor)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [date,opening,expected,actual,variance,tot.card_sales,tot.eft_sales,req.body.notes||null,req.user.email]);
  await audit(req.user.email,'CASHUP_COMPLETED','CASHUP',String(row.id),{date,variance});
  res.json({ok:true,cashup:row,cash_sales:tot.cash_sales,cash_expenses:exp.cash_expenses});
});

app.post('/api/infrastructure',auth,manager, async (req,res)=>{
  const vals=[req.body.battery_percent,req.body.solar_kw,req.body.water_percent].map(v=>v==null?null:Number(v));
  const {rows:[row]}=await pool.query(`INSERT INTO infrastructure_status(battery_percent,solar_kw,water_percent,internet_status,note,actor)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[vals[0],vals[1],vals[2],req.body.internet_status||null,req.body.note||null,req.user.email]);
  await audit(req.user.email,'INFRASTRUCTURE_UPDATED','INFRASTRUCTURE',String(row.id),{});
  res.json({ok:true,status:row});
});

app.get('/api/audit',auth,manager, async (req,res)=>{
  const {rows}=await pool.query(`SELECT id,actor,action,entity,entity_id,details,created_at FROM audit_log ORDER BY id DESC LIMIT 200`);
  res.json(rows);
});

const migrateEnhancements = require('./enhancements')({app,pool,audit,auth});

app.use((req,res,next)=>{
  if(req.path.startsWith('/api/') || req.path==='/health') return next();
  res.sendFile(path.join(__dirname,'public','index.html'));
});
app.use((req,res)=>res.status(404).json({error:'Not found'}));

migrate().then(migrateEnhancements).then(()=>{
  app.listen(PORT,()=>console.log(`Esingesini Lounge Operations listening on ${PORT}`));
}).catch(err=>{ console.error(err); process.exit(1); });
