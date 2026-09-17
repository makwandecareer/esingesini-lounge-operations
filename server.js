const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is required for production.'); process.exit(1); }
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

const sessions = new Map();
const token = () => crypto.randomBytes(32).toString('hex');
const auth = (req,res,next) => {
  const t=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const s=sessions.get(t);
  if(!s) return res.status(401).json({error:'Authentication required'});
  req.user=s; next();
};
const manager = (req,res,next) => {
  if(!['OWNER','DIRECTOR','ADMINISTRATOR','MANAGER'].includes(req.user.role)) return res.status(403).json({error:'Management permission required'});
  next();
};
const director = (req,res,next) => {
  if(!['OWNER','DIRECTOR'].includes(req.user.role)) return res.status(403).json({error:'Director authorisation required'});
  next();
};
const audit = async (actor, action, entity, entityId, details={}) => {
  await pool.query(`INSERT INTO audit_log(actor,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)`,[actor,action,entity,entityId||null,details]);
};

async function migrate(){
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users(
    id BIGSERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
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
    movement_type TEXT NOT NULL,
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
    payment_method TEXT NOT NULL,
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
    payment_method TEXT NOT NULL,
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
  CREATE TABLE IF NOT EXISTS merchant_settlements(
    id BIGSERIAL PRIMARY KEY,
    business_date DATE NOT NULL,
    channel TEXT NOT NULL,
    gross_amount NUMERIC(12,2) NOT NULL CHECK (gross_amount>=0),
    fees NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (fees>=0),
    net_amount NUMERIC(12,2) NOT NULL CHECK (net_amount>=0),
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    notes TEXT,
    actor TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS size_label TEXT;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS units_per_case INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS case_price NUMERIC(12,2);
  ALTER TABLE products ADD COLUMN IF NOT EXISTS age_restricted BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS manually_added BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  const {rows:constraints}=await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid='users'::regclass AND contype='c'`);
  for(const c of constraints){ if(c.conname.toLowerCase().includes('role')) await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS "${c.conname}"`); }

  const catPath=path.join(__dirname,'data','catalogue.json');
  if(fs.existsSync(catPath)){
    const cat=JSON.parse(fs.readFileSync(catPath,'utf8'));
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      for(const p of cat){
        await client.query(`INSERT INTO products(sku,category,name,serving,selling_price,active,brand,size_label,units_per_case,case_price,age_restricted)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT(sku) DO NOTHING`,[
          p.sku,p.category,p.name,p.serving,Number(p.selling_price_zar||0),p.active!==false,p.brand||p.name,p.size_label||p.serving,
          Number(p.units_per_case||1),p.case_price_zar==null?null:Number(p.case_price_zar),!!p.age_restricted
        ]);
        await client.query(`INSERT INTO inventory(sku) VALUES($1) ON CONFLICT(sku) DO NOTHING`,[p.sku]);
      }
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }

  const {rows:[countRow]}=await pool.query(`SELECT count(*)::int AS c FROM users`);
  if(countRow.c===0){
    const email=process.env.OWNER_EMAIL, password=process.env.OWNER_PASSWORD;
    if(!email||!password) throw new Error('OWNER_EMAIL and OWNER_PASSWORD are required on first deployment.');
    const hash=await bcrypt.hash(password,12);
    await pool.query(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,'DIRECTOR')`,[email.toLowerCase(),hash]);
    await audit(email,'BOOTSTRAP_DIRECTOR','USER',email,{});
  } else {
    await pool.query(`UPDATE users SET role='DIRECTOR' WHERE role='OWNER'`);
  }
}

app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,service:'Esingesini Lounge Operations'});}catch(e){res.status(503).json({ok:false,error:'database unavailable'});}});
app.post('/api/login',async(req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||'');
  const {rows}=await pool.query(`SELECT id,email,password_hash,role,active FROM users WHERE email=$1`,[email]);
  const u=rows[0];
  if(!u||!u.active||!(await bcrypt.compare(password,u.password_hash))) return res.status(401).json({error:'Invalid credentials'});
  const t=token(); sessions.set(t,{id:u.id,email:u.email,role:u.role}); await audit(u.email,'LOGIN','SESSION',null,{});
  res.json({token:t,user:{id:u.id,email:u.email,role:u.role}});
});
app.post('/api/logout',auth,(req,res)=>{const t=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');sessions.delete(t);res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>res.json(req.user));

app.get('/api/catalogue',auth,async(req,res)=>{
  const includeInactive=['OWNER','DIRECTOR'].includes(req.user.role)&&req.query.all==='1';
  const {rows}=await pool.query(`SELECT p.sku,p.category,p.name,p.brand,p.serving,p.size_label,p.selling_price::float selling_price,p.units_per_case,
    p.case_price::float case_price,p.age_restricted,p.active,p.manually_added,i.qty::float stock_qty,i.unit_cost::float unit_cost,i.reorder_level::float reorder_level
    FROM products p JOIN inventory i USING(sku) ${includeInactive?'':'WHERE p.active=TRUE'} ORDER BY p.category,p.name,p.size_label`);
  res.json(rows);
});

app.post('/api/products',auth,director,async(req,res)=>{
  const b=req.body||{}; const sku=String(b.sku||'').trim().toUpperCase();
  if(!sku||!b.name||!b.category||!b.size_label) return res.status(400).json({error:'SKU, product name, category and size are required'});
  const price=Number(b.selling_price); if(!(price>=0)) return res.status(400).json({error:'Valid selling price required'});
  const units=Math.max(1,parseInt(b.units_per_case||1,10)); const casePrice=b.case_price===''||b.case_price==null?null:Number(b.case_price);
  try{
    await pool.query(`INSERT INTO products(sku,category,name,brand,serving,size_label,selling_price,units_per_case,case_price,age_restricted,active,manually_added)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)`,[sku,String(b.category).trim().toUpperCase(),String(b.name).trim(),String(b.brand||b.name).trim(),String(b.size_label).trim(),String(b.size_label).trim(),price,units,casePrice,!!b.age_restricted,b.active!==false]);
    await pool.query(`INSERT INTO inventory(sku,reorder_level) VALUES($1,$2)`,[sku,Number(b.reorder_level||0)]);
    await audit(req.user.email,'PRODUCT_CREATED','PRODUCT',sku,{name:b.name,size:b.size_label,price}); res.json({ok:true,sku});
  }catch(e){res.status(400).json({error:e.code==='23505'?'SKU already exists':e.message});}
});

app.put('/api/products/:sku',auth,director,async(req,res)=>{
  const sku=req.params.sku; const b=req.body||{};
  const price=Number(b.selling_price); if(!(price>=0)) return res.status(400).json({error:'Valid selling price required'});
  const units=Math.max(1,parseInt(b.units_per_case||1,10)); const casePrice=b.case_price===''||b.case_price==null?null:Number(b.case_price);
  const {rows}=await pool.query(`UPDATE products SET category=$2,name=$3,brand=$4,serving=$5,size_label=$5,selling_price=$6,units_per_case=$7,case_price=$8,age_restricted=$9,active=$10 WHERE sku=$1 RETURNING *`,
    [sku,String(b.category||'OTHER').trim().toUpperCase(),String(b.name||'').trim(),String(b.brand||b.name||'').trim(),String(b.size_label||b.serving||'').trim(),price,units,casePrice,!!b.age_restricted,b.active!==false]);
  if(!rows[0]) return res.status(404).json({error:'Product not found'});
  await pool.query(`UPDATE inventory SET reorder_level=$2,updated_at=now() WHERE sku=$1`,[sku,Number(b.reorder_level||0)]);
  await audit(req.user.email,'PRODUCT_UPDATED','PRODUCT',sku,{price,size:b.size_label,case_price:casePrice,active:b.active!==false}); res.json({ok:true});
});

app.delete('/api/products/:sku',auth,director,async(req,res)=>{
  const sku=req.params.sku;
  const {rows:[usage]}=await pool.query(`SELECT (SELECT count(*) FROM sale_items WHERE sku=$1)+(SELECT count(*) FROM stock_movements WHERE sku=$1) AS n`,[sku]);
  if(Number(usage.n)>0){
    await pool.query(`UPDATE products SET active=FALSE WHERE sku=$1`,[sku]);
    await audit(req.user.email,'PRODUCT_ARCHIVED','PRODUCT',sku,{reason:'Historical records retained'});
    return res.json({ok:true,archived:true});
  }
  const r=await pool.query(`DELETE FROM products WHERE sku=$1`,[sku]);
  if(!r.rowCount)return res.status(404).json({error:'Product not found'});
  await audit(req.user.email,'PRODUCT_DELETED','PRODUCT',sku,{});res.json({ok:true,deleted:true});
});

app.get('/api/users',auth,director,async(req,res)=>{const {rows}=await pool.query(`SELECT id,email,role,active,created_at FROM users ORDER BY id`);res.json(rows);});
app.post('/api/users',auth,director,async(req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||''), role=String(req.body.role||'').toUpperCase();
  if(!email||password.length<8||!['ADMINISTRATOR','MANAGER','CASHIER','STOCK'].includes(role)) return res.status(400).json({error:'Valid email, password (8+ chars) and staff role required'});
  try{const hash=await bcrypt.hash(password,12);const {rows:[u]}=await pool.query(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3) RETURNING id,email,role,active`,[email,hash,role]);await audit(req.user.email,'STAFF_CREATED','USER',String(u.id),{email,role});res.json({ok:true,user:u});}catch(e){res.status(400).json({error:e.code==='23505'?'Email already exists':e.message});}
});
app.put('/api/users/:id',auth,director,async(req,res)=>{
  const id=Number(req.params.id); const {rows:[target]}=await pool.query(`SELECT * FROM users WHERE id=$1`,[id]); if(!target)return res.status(404).json({error:'User not found'});
  if(['OWNER','DIRECTOR'].includes(target.role)&&target.id!==req.user.id) return res.status(403).json({error:'Director account cannot be controlled by staff'});
  const role=String(req.body.role||target.role).toUpperCase(); if(!['DIRECTOR','ADMINISTRATOR','MANAGER','CASHIER','STOCK'].includes(role))return res.status(400).json({error:'Invalid role'});
  if(target.id===req.user.id && (req.body.active===false||role!=='DIRECTOR')) return res.status(400).json({error:'Director cannot disable or demote own account'});
  await pool.query(`UPDATE users SET role=$2,active=$3 WHERE id=$1`,[id,role,req.body.active!==false]);
  if(req.body.password){if(String(req.body.password).length<8)return res.status(400).json({error:'Password must be at least 8 characters'});const hash=await bcrypt.hash(String(req.body.password),12);await pool.query(`UPDATE users SET password_hash=$2 WHERE id=$1`,[id,hash]);}
  await audit(req.user.email,'STAFF_UPDATED','USER',String(id),{role,active:req.body.active!==false});res.json({ok:true});
});

app.get('/api/dashboard',auth,async(req,res)=>{
  const {rows:[s]}=await pool.query(`SELECT COALESCE(sum(subtotal),0)::float sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='CASH'),0)::float cash,COALESCE(sum(subtotal) FILTER(WHERE payment_method='CARD'),0)::float card,COALESCE(sum(subtotal) FILTER(WHERE payment_method='EFT'),0)::float eft,count(*)::int transactions FROM sales WHERE created_at::date=current_date`);
  const {rows:[e]}=await pool.query(`SELECT COALESCE(sum(amount),0)::float expenses FROM expenses WHERE created_at::date=current_date`);
  const {rows:[st]}=await pool.query(`SELECT COALESCE(sum(COALESCE(unit_cost,0)*qty),0)::float stock_value,count(*) FILTER(WHERE active=TRUE AND qty<=reorder_level)::int low_stock FROM inventory JOIN products USING(sku)`);
  const {rows:[infra]}=await pool.query(`SELECT * FROM infrastructure_status ORDER BY id DESC LIMIT 1`);res.json({...s,...e,...st,infrastructure:infra||null});
});

app.get('/api/billing',auth,manager,async(req,res)=>{
  const date=req.query.date||new Date().toISOString().slice(0,10);
  const {rows:[sales]}=await pool.query(`SELECT COALESCE(sum(subtotal),0)::float total_sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='CASH'),0)::float cash_sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='CARD'),0)::float card_sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='EFT'),0)::float eft_sales,count(*)::int transactions FROM sales WHERE created_at::date=$1`,[date]);
  const {rows:[exp]}=await pool.query(`SELECT COALESCE(sum(amount),0)::float expenses,COALESCE(sum(amount) FILTER(WHERE payment_method='CASH'),0)::float cash_expenses FROM expenses WHERE created_at::date=$1`,[date]);
  const {rows:settlements}=await pool.query(`SELECT id,business_date,channel,gross_amount::float gross_amount,fees::float fees,net_amount::float net_amount,reference,status,notes,actor,created_at FROM merchant_settlements WHERE business_date=$1 ORDER BY id DESC`,[date]);
  const {rows:[sett]}=await pool.query(`SELECT COALESCE(sum(net_amount) FILTER(WHERE channel='CAPITEC_CARD'),0)::float capitec_card_net,COALESCE(sum(net_amount) FILTER(WHERE channel='CAPITEC_EFT'),0)::float capitec_eft_net,COALESCE(sum(net_amount) FILTER(WHERE channel='CASH_BANKING'),0)::float cash_banked FROM merchant_settlements WHERE business_date=$1`,[date]);
  const {rows:[cu]}=await pool.query(`SELECT * FROM cashups WHERE business_date=$1 ORDER BY id DESC LIMIT 1`,[date]);
  res.json({date,...sales,...exp,...sett,unsettled_card:Number((sales.card_sales-sett.capitec_card_net).toFixed(2)),unsettled_eft:Number((sales.eft_sales-sett.capitec_eft_net).toFixed(2)),cash_available:Number((sales.cash_sales-exp.cash_expenses-sett.cash_banked).toFixed(2)),cashup:cu||null,settlements});
});

app.post('/api/merchant-settlements',auth,manager,async(req,res)=>{
  const b=req.body||{}; const date=b.business_date||new Date().toISOString().slice(0,10); const channel=String(b.channel||'').toUpperCase();
  if(!['CAPITEC_CARD','CAPITEC_EFT','CASH_BANKING'].includes(channel)) return res.status(400).json({error:'Invalid settlement channel'});
  const gross=Number(b.gross_amount),fees=Number(b.fees||0),net=b.net_amount===''||b.net_amount==null?Number((gross-fees).toFixed(2)):Number(b.net_amount);
  if(!(gross>=0)||!(fees>=0)||!(net>=0)) return res.status(400).json({error:'Valid settlement amounts required'});
  const status=String(b.status||'PENDING').toUpperCase(); if(!['PENDING','SETTLED','RECONCILED'].includes(status)) return res.status(400).json({error:'Invalid settlement status'});
  const {rows:[row]}=await pool.query(`INSERT INTO merchant_settlements(business_date,channel,gross_amount,fees,net_amount,reference,status,notes,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[date,channel,gross,fees,net,b.reference||null,status,b.notes||null,req.user.email]);
  await audit(req.user.email,'MERCHANT_SETTLEMENT_RECORDED','SETTLEMENT',String(row.id),{channel,gross,fees,net,status}); res.json({ok:true,settlement:row});
});

app.delete('/api/merchant-settlements/:id',auth,director,async(req,res)=>{
  const {rows:[row]}=await pool.query(`DELETE FROM merchant_settlements WHERE id=$1 RETURNING *`,[Number(req.params.id)]); if(!row)return res.status(404).json({error:'Settlement not found'});
  await audit(req.user.email,'MERCHANT_SETTLEMENT_REMOVED','SETTLEMENT',String(row.id),{channel:row.channel,net_amount:row.net_amount});res.json({ok:true});
});

app.post('/api/stock/receive',auth,manager,async(req,res)=>{
  const {sku,reference,note}=req.body; let qty=Number(req.body.qty), unitCost=Number(req.body.unit_cost); const mode=String(req.body.mode||'UNIT').toUpperCase();
  const {rows:[p]}=await pool.query(`SELECT units_per_case FROM products WHERE sku=$1`,[sku]);if(!p)return res.status(400).json({error:'Unknown SKU'});
  if(mode==='CASE'){const cases=qty;if(!(cases>0)||!(unitCost>=0))return res.status(400).json({error:'Positive case quantity and case cost required'});qty=cases*p.units_per_case;unitCost=unitCost/p.units_per_case;}
  if(!(qty>0)||!(unitCost>=0))return res.status(400).json({error:'Positive quantity and cost required'});
  const client=await pool.connect();try{await client.query('BEGIN');const {rows:[inv]}=await client.query(`UPDATE inventory SET qty=qty+$2,unit_cost=$3,updated_at=now() WHERE sku=$1 RETURNING *`,[sku,qty,unitCost]);await client.query(`INSERT INTO stock_movements(sku,movement_type,qty,unit_cost,reference,note,actor) VALUES($1,'RECEIPT',$2,$3,$4,$5,$6)`,[sku,qty,unitCost,reference||null,note||null,req.user.email]);await client.query('COMMIT');await audit(req.user.email,'STOCK_RECEIVED','PRODUCT',sku,{qty,unit_cost:unitCost,mode});res.json({ok:true,inventory:inv});}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

app.post('/api/stock/adjust',auth,manager,async(req,res)=>{const {sku,type,note}=req.body,q=Number(req.body.qty_delta);if(!sku||!['WASTAGE','BREAKAGE','ADJUSTMENT','OPENING'].includes(type)||!Number.isFinite(q)||q===0)return res.status(400).json({error:'Valid sku, type and non-zero qty_delta required'});const {rows}=await pool.query(`UPDATE inventory SET qty=qty+$2,updated_at=now() WHERE sku=$1 AND qty+$2>=0 RETURNING *`,[sku,q]);if(!rows[0])return res.status(400).json({error:'Unknown SKU or insufficient stock'});await pool.query(`INSERT INTO stock_movements(sku,movement_type,qty,note,actor) VALUES($1,$2,$3,$4,$5)`,[sku,type,q,note||null,req.user.email]);await audit(req.user.email,'STOCK_ADJUSTED','PRODUCT',sku,{qty_delta:q,type,note});res.json({ok:true,inventory:rows[0]});});

app.post('/api/sales',auth,async(req,res)=>{
  const items=Array.isArray(req.body.items)?req.body.items:[], method=req.body.payment_method;if(!['CASH','CARD','EFT'].includes(method)||!items.length)return res.status(400).json({error:'Items and payment method required'});
  const client=await pool.connect();try{await client.query('BEGIN');let subtotal=0;const priced=[];
    for(const item of items){const count=Number(item.qty);if(!(count>0))throw new Error('Invalid quantity');const {rows}=await client.query(`SELECT p.sku,p.name,p.selling_price::float,p.case_price::float,p.units_per_case,i.qty::float stock_qty FROM products p JOIN inventory i USING(sku) WHERE p.sku=$1 AND p.active=TRUE FOR UPDATE`,[item.sku]);const p=rows[0];if(!p)throw new Error('Unknown product '+item.sku);const isCase=String(item.mode||'UNIT').toUpperCase()==='CASE';const stockQty=isCase?count*p.units_per_case:count;if(p.stock_qty<stockQty)throw new Error('Insufficient stock for '+p.name);const price=isCase?(p.case_price==null?p.selling_price*p.units_per_case:p.case_price):p.selling_price;const line=Number((price*count).toFixed(2));subtotal+=line;priced.push({...p,count,stockQty,price,line,isCase});}
    subtotal=Number(subtotal.toFixed(2));const tender=req.body.cash_tendered==null?null:Number(req.body.cash_tendered);if(method==='CASH'&&!(tender>=subtotal))throw new Error('Cash tendered is below total');const change=method==='CASH'?Number((tender-subtotal).toFixed(2)):null;const ref='ES-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();const {rows:[sale]}=await client.query(`INSERT INTO sales(receipt_no,payment_method,subtotal,cash_tendered,change_due,actor) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,receipt_no,created_at`,[ref,method,subtotal,tender,change,req.user.email]);
    for(const p of priced){await client.query(`INSERT INTO sale_items(sale_id,sku,qty,unit_price,line_total) VALUES($1,$2,$3,$4,$5)`,[sale.id,p.sku,p.stockQty,p.price,p.line]);await client.query(`UPDATE inventory SET qty=qty-$2,updated_at=now() WHERE sku=$1`,[p.sku,p.stockQty]);await client.query(`INSERT INTO stock_movements(sku,movement_type,qty,reference,actor,note) VALUES($1,'SALE',$2,$3,$4,$5)`,[p.sku,-p.stockQty,ref,req.user.email,p.isCase?'CASE SALE':'UNIT SALE']);}
    await client.query('COMMIT');await audit(req.user.email,'SALE_COMPLETED','SALE',ref,{payment_method:method,subtotal});res.json({ok:true,receipt_no:ref,total:subtotal,cash_tendered:tender,change_due:change,created_at:sale.created_at});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

app.post('/api/expenses',auth,manager,async(req,res)=>{const {category,description,payment_method,reference}=req.body,amount=Number(req.body.amount);if(!category||!description||!(amount>=0)||!['CASH','CARD','EFT'].includes(payment_method))return res.status(400).json({error:'Valid expense fields required'});const {rows:[row]}=await pool.query(`INSERT INTO expenses(category,description,amount,payment_method,reference,actor) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[category,description,amount,payment_method,reference||null,req.user.email]);await audit(req.user.email,'EXPENSE_RECORDED','EXPENSE',String(row.id),{amount,payment_method});res.json({ok:true,expense:row});});
app.post('/api/cashups',auth,manager,async(req,res)=>{const date=req.body.business_date||new Date().toISOString().slice(0,10),opening=Number(req.body.opening_float||0),actual=Number(req.body.actual_cash);if(!Number.isFinite(actual))return res.status(400).json({error:'actual_cash required'});const {rows:[tot]}=await pool.query(`SELECT COALESCE(sum(subtotal) FILTER(WHERE payment_method='CASH'),0)::float cash_sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='CARD'),0)::float card_sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='EFT'),0)::float eft_sales FROM sales WHERE created_at::date=$1`,[date]);const {rows:[exp]}=await pool.query(`SELECT COALESCE(sum(amount),0)::float cash_expenses FROM expenses WHERE created_at::date=$1 AND payment_method='CASH'`,[date]);const expected=Number((opening+tot.cash_sales-exp.cash_expenses).toFixed(2)),variance=Number((actual-expected).toFixed(2));const {rows:[row]}=await pool.query(`INSERT INTO cashups(business_date,opening_float,expected_cash,actual_cash,variance,card_total,eft_total,notes,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[date,opening,expected,actual,variance,tot.card_sales,tot.eft_sales,req.body.notes||null,req.user.email]);await audit(req.user.email,'CASHUP_COMPLETED','CASHUP',String(row.id),{date,variance});res.json({ok:true,cashup:row,cash_sales:tot.cash_sales,cash_expenses:exp.cash_expenses});});
app.post('/api/infrastructure',auth,manager,async(req,res)=>{const vals=[req.body.battery_percent,req.body.solar_kw,req.body.water_percent].map(v=>v==null?null:Number(v));const {rows:[row]}=await pool.query(`INSERT INTO infrastructure_status(battery_percent,solar_kw,water_percent,internet_status,note,actor) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[vals[0],vals[1],vals[2],req.body.internet_status||null,req.body.note||null,req.user.email]);await audit(req.user.email,'INFRASTRUCTURE_UPDATED','INFRASTRUCTURE',String(row.id),{});res.json({ok:true,status:row});});
app.get('/api/audit',auth,manager,async(req,res)=>{const {rows}=await pool.query(`SELECT id,actor,action,entity,entity_id,details,created_at FROM audit_log ORDER BY id DESC LIMIT 300`);res.json(rows);});

app.use((req,res,next)=>{if(req.path.startsWith('/api/')||req.path==='/health')return next();res.sendFile(path.join(__dirname,'public','index.html'));});

migrate().then(()=>app.listen(PORT,()=>console.log(`Esingesini Lounge Operations listening on ${PORT}`))).catch(err=>{console.error(err);process.exit(1);});
