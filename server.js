const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const DIRECTOR_EMAIL = String(process.env.OWNER_EMAIL || 'makwandegcora23@gmail.com').trim().toLowerCase();
if (!DATABASE_URL) { console.error('DATABASE_URL is required for production.'); process.exit(1); }
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1m' }));

const sessions = new Map();
const token = () => crypto.randomBytes(32).toString('hex');
const tempPassword = () => `Es!${crypto.randomBytes(6).toString('base64url')}9`;
const auth = (req,res,next) => {
  const t=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const s=sessions.get(t);
  if(!s) return res.status(401).json({error:'Authentication required'});
  req.user=s; next();
};
const managementRoles = ['DIRECTOR','MANAGING_DIRECTOR','ADMINISTRATOR','MANAGER'];
const manager = (req,res,next) => {
  if(!managementRoles.includes(req.user.role)) return res.status(403).json({error:'Management permission required'});
  next();
};
const director = (req,res,next) => {
  if(req.user.role!=='DIRECTOR' || req.user.email!==DIRECTOR_EMAIL) return res.status(403).json({error:'Director authorisation required'});
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
  ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_no TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS hire_date DATE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS access_note TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
  `);

  const catPath=path.join(__dirname,'data','catalogue.json');
  if(fs.existsSync(catPath)){
    const cat=JSON.parse(fs.readFileSync(catPath,'utf8'));
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      for(const p of cat){
        await client.query(`INSERT INTO products(sku,category,name,serving,selling_price,active,brand,size_label,units_per_case,case_price,age_restricted)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(sku) DO NOTHING`,[
          p.sku,p.category,p.name,p.serving,Number(p.selling_price_zar||0),p.active!==false,p.brand||p.name,p.size_label||p.serving,
          Number(p.units_per_case||1),p.case_price_zar==null?null:Number(p.case_price_zar),!!p.age_restricted
        ]);
        await client.query(`INSERT INTO inventory(sku) VALUES($1) ON CONFLICT(sku) DO NOTHING`,[p.sku]);
      }
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }

  const {rows:[directorRow]}=await pool.query(`SELECT id FROM users WHERE lower(email)=lower($1)`,[DIRECTOR_EMAIL]);
  if(!directorRow){
    const password=process.env.OWNER_PASSWORD;
    if(!password) throw new Error('OWNER_PASSWORD is required to create the Director account.');
    const hash=await bcrypt.hash(password,12);
    await pool.query(`INSERT INTO users(email,password_hash,role,active,full_name,job_title,department,must_change_password) VALUES($1,$2,'DIRECTOR',TRUE,'Makwande Gcora','Director','Executive',FALSE)`,[DIRECTOR_EMAIL,hash]);
    await audit(DIRECTOR_EMAIL,'BOOTSTRAP_DIRECTOR','USER',DIRECTOR_EMAIL,{});
  }
  await pool.query(`UPDATE users SET role='DIRECTOR',active=TRUE,must_change_password=FALSE WHERE lower(email)=lower($1)`,[DIRECTOR_EMAIL]);
  await pool.query(`UPDATE users SET role='MANAGING_DIRECTOR' WHERE role='OWNER' AND lower(email)<>lower($1)`,[DIRECTOR_EMAIL]);
}

app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,service:'Esingesini Lounge Operations'});}catch(e){res.status(503).json({ok:false,error:'database unavailable'});}});
app.post('/api/login',async(req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||'');
  const {rows}=await pool.query(`SELECT id,email,password_hash,role,active,must_change_password FROM users WHERE lower(email)=lower($1)`,[email]);
  const u=rows[0];
  if(!u||!u.active||!(await bcrypt.compare(password,u.password_hash))) return res.status(401).json({error:'Invalid credentials'});
  await pool.query(`UPDATE users SET last_login_at=now() WHERE id=$1`,[u.id]);
  const session={id:u.id,email:u.email.toLowerCase(),role:u.role,must_change_password:u.must_change_password};
  const t=token(); sessions.set(t,session); await audit(u.email,'LOGIN','SESSION',null,{});
  res.json({token:t,user:session});
});
app.post('/api/logout',auth,(req,res)=>{const t=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');sessions.delete(t);res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>res.json(req.user));
app.post('/api/change-password',auth,async(req,res)=>{
  const current=String(req.body.current_password||''), next=String(req.body.new_password||'');
  if(next.length<10) return res.status(400).json({error:'New password must be at least 10 characters'});
  const {rows:[u]}=await pool.query(`SELECT password_hash FROM users WHERE id=$1`,[req.user.id]);
  if(!u||!(await bcrypt.compare(current,u.password_hash))) return res.status(400).json({error:'Current password is incorrect'});
  const hash=await bcrypt.hash(next,12); await pool.query(`UPDATE users SET password_hash=$2,must_change_password=FALSE WHERE id=$1`,[req.user.id,hash]);
  req.user.must_change_password=false; await audit(req.user.email,'PASSWORD_CHANGED','USER',String(req.user.id),{}); res.json({ok:true});
});

app.get('/api/catalogue',auth,async(req,res)=>{
  const includeInactive=req.user.role==='DIRECTOR'&&req.query.all==='1';
  const {rows}=await pool.query(`SELECT p.sku,p.category,p.name,p.brand,p.serving,p.size_label,p.selling_price::float selling_price,p.units_per_case,
    p.case_price::float case_price,p.age_restricted,p.active,p.manually_added,i.qty::float stock_qty,i.unit_cost::float unit_cost,i.reorder_level::float reorder_level
    FROM products p JOIN inventory i USING(sku) ${includeInactive?'':'WHERE p.active=TRUE'} ORDER BY p.category,p.name,p.size_label`);
  res.json(rows);
});
app.post('/api/products',auth,director,async(req,res)=>{
  const b=req.body||{},sku=String(b.sku||'').trim().toUpperCase(),price=Number(b.selling_price),units=Math.max(1,parseInt(b.units_per_case||1,10));
  if(!sku||!b.name||!b.category||!b.size_label||!(price>=0)) return res.status(400).json({error:'SKU, name, category, size and valid price are required'});
  const casePrice=b.case_price===''||b.case_price==null?null:Number(b.case_price);
  try{await pool.query(`INSERT INTO products(sku,category,name,brand,serving,size_label,selling_price,units_per_case,case_price,age_restricted,active,manually_added) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)`,[sku,String(b.category).toUpperCase(),String(b.name),String(b.brand||b.name),String(b.size_label),String(b.size_label),price,units,casePrice,!!b.age_restricted,b.active!==false]);await pool.query(`INSERT INTO inventory(sku,reorder_level) VALUES($1,$2)`,[sku,Number(b.reorder_level||0)]);await audit(req.user.email,'PRODUCT_CREATED','PRODUCT',sku,{price});res.json({ok:true,sku});}catch(e){res.status(400).json({error:e.code==='23505'?'SKU already exists':e.message});}
});
app.put('/api/products/:sku',auth,director,async(req,res)=>{
  const b=req.body||{},price=Number(b.selling_price),units=Math.max(1,parseInt(b.units_per_case||1,10)),casePrice=b.case_price===''||b.case_price==null?null:Number(b.case_price);
  if(!(price>=0))return res.status(400).json({error:'Valid selling price required'});
  const r=await pool.query(`UPDATE products SET category=$2,name=$3,brand=$4,serving=$5,size_label=$5,selling_price=$6,units_per_case=$7,case_price=$8,age_restricted=$9,active=$10 WHERE sku=$1`,[req.params.sku,String(b.category||'OTHER').toUpperCase(),String(b.name||''),String(b.brand||b.name||''),String(b.size_label||''),price,units,casePrice,!!b.age_restricted,b.active!==false]);
  if(!r.rowCount)return res.status(404).json({error:'Product not found'});await pool.query(`UPDATE inventory SET reorder_level=$2,updated_at=now() WHERE sku=$1`,[req.params.sku,Number(b.reorder_level||0)]);await audit(req.user.email,'PRODUCT_UPDATED','PRODUCT',req.params.sku,{price,casePrice});res.json({ok:true});
});
app.delete('/api/products/:sku',auth,director,async(req,res)=>{const sku=req.params.sku;const {rows:[u]}=await pool.query(`SELECT (SELECT count(*) FROM sale_items WHERE sku=$1)+(SELECT count(*) FROM stock_movements WHERE sku=$1) n`,[sku]);if(Number(u.n)>0){await pool.query(`UPDATE products SET active=FALSE WHERE sku=$1`,[sku]);await audit(req.user.email,'PRODUCT_ARCHIVED','PRODUCT',sku,{});return res.json({ok:true,archived:true});}const r=await pool.query(`DELETE FROM products WHERE sku=$1`,[sku]);if(!r.rowCount)return res.status(404).json({error:'Product not found'});await audit(req.user.email,'PRODUCT_DELETED','PRODUCT',sku,{});res.json({ok:true});});

app.get('/api/users',auth,director,async(req,res)=>{const {rows}=await pool.query(`SELECT id,email,role,active,full_name,employee_no,phone,job_title,department,hire_date,access_note,must_change_password,last_login_at,created_at FROM users ORDER BY CASE role WHEN 'DIRECTOR' THEN 1 WHEN 'MANAGING_DIRECTOR' THEN 2 WHEN 'ADMINISTRATOR' THEN 3 WHEN 'MANAGER' THEN 4 ELSE 5 END,id`);res.json(rows);});
app.post('/api/users',auth,director,async(req,res)=>{
  const b=req.body||{},email=String(b.email||'').trim().toLowerCase(),role=String(b.role||'').toUpperCase();
  if(!email||!['MANAGING_DIRECTOR','ADMINISTRATOR','MANAGER','CASHIER','STOCK'].includes(role))return res.status(400).json({error:'Valid staff email and authorised role required'});
  const pw=String(b.password||'')||tempPassword(); if(pw.length<8)return res.status(400).json({error:'Temporary password must be at least 8 characters'});
  const employeeNo=String(b.employee_no||'').trim()||`ES-${Date.now().toString().slice(-6)}`;
  try{const hash=await bcrypt.hash(pw,12);const {rows:[u]}=await pool.query(`INSERT INTO users(email,password_hash,role,active,full_name,employee_no,phone,job_title,department,hire_date,access_note,must_change_password) VALUES($1,$2,$3,TRUE,$4,$5,$6,$7,$8,$9,$10,TRUE) RETURNING id,email,role,active,full_name,employee_no,job_title,department`,[email,hash,role,b.full_name||null,employeeNo,b.phone||null,b.job_title||null,b.department||'Operations',b.hire_date||null,b.access_note||null]);await audit(req.user.email,'STAFF_REGISTERED','USER',String(u.id),{email,role,employee_no:employeeNo});res.json({ok:true,user:u,temporary_password:pw});}catch(e){res.status(400).json({error:e.code==='23505'?'Email already exists':e.message});}
});
app.put('/api/users/:id',auth,director,async(req,res)=>{
  const id=Number(req.params.id);const {rows:[target]}=await pool.query(`SELECT * FROM users WHERE id=$1`,[id]);if(!target)return res.status(404).json({error:'User not found'});
  if(target.email.toLowerCase()===DIRECTOR_EMAIL||target.role==='DIRECTOR'){if(target.id!==req.user.id)return res.status(403).json({error:'Director account is protected'});if(req.body.active===false||String(req.body.role||'DIRECTOR').toUpperCase()!=='DIRECTOR')return res.status(400).json({error:'Director cannot be disabled or demoted'});}
  const role=String(req.body.role||target.role).toUpperCase();if(!['DIRECTOR','MANAGING_DIRECTOR','ADMINISTRATOR','MANAGER','CASHIER','STOCK'].includes(role))return res.status(400).json({error:'Invalid role'});
  await pool.query(`UPDATE users SET role=$2,active=$3,full_name=COALESCE($4,full_name),phone=COALESCE($5,phone),job_title=COALESCE($6,job_title),department=COALESCE($7,department),access_note=COALESCE($8,access_note) WHERE id=$1`,[id,role,req.body.active!==false,req.body.full_name??null,req.body.phone??null,req.body.job_title??null,req.body.department??null,req.body.access_note??null]);
  let generated=null;if(req.body.generate_password||req.body.password){generated=req.body.password||tempPassword();if(String(generated).length<8)return res.status(400).json({error:'Password must be at least 8 characters'});const hash=await bcrypt.hash(String(generated),12);await pool.query(`UPDATE users SET password_hash=$2,must_change_password=TRUE WHERE id=$1`,[id,hash]);}
  await audit(req.user.email,'STAFF_ACCESS_UPDATED','USER',String(id),{role,active:req.body.active!==false});res.json({ok:true,temporary_password:generated});
});
app.get('/api/administration',auth,director,async(req,res)=>{const {rows}=await pool.query(`SELECT role,count(*)::int total,count(*) FILTER(WHERE active)::int active FROM users GROUP BY role ORDER BY role`);res.json({director_email:DIRECTOR_EMAIL,hierarchy:['DIRECTOR','MANAGING_DIRECTOR','ADMINISTRATOR','MANAGER','CASHIER','STOCK'],summary:rows});});

app.get('/api/dashboard',auth,async(req,res)=>{const {rows:[s]}=await pool.query(`SELECT COALESCE(sum(subtotal),0)::float sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='CASH'),0)::float cash,COALESCE(sum(subtotal) FILTER(WHERE payment_method='CARD'),0)::float card,COALESCE(sum(subtotal) FILTER(WHERE payment_method='EFT'),0)::float eft,count(*)::int transactions FROM sales WHERE created_at::date=current_date`);const {rows:[e]}=await pool.query(`SELECT COALESCE(sum(amount),0)::float expenses FROM expenses WHERE created_at::date=current_date`);const {rows:[st]}=await pool.query(`SELECT COALESCE(sum(COALESCE(unit_cost,0)*qty),0)::float stock_value,count(*) FILTER(WHERE active=TRUE AND qty<=reorder_level)::int low_stock FROM inventory JOIN products USING(sku)`);const {rows:[infra]}=await pool.query(`SELECT * FROM infrastructure_status ORDER BY id DESC LIMIT 1`);res.json({...s,...e,...st,infrastructure:infra||null});});
app.get('/api/billing',auth,manager,async(req,res)=>{const date=req.query.date||new Date().toISOString().slice(0,10);const {rows:[sales]}=await pool.query(`SELECT COALESCE(sum(subtotal),0)::float total_sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='CASH'),0)::float cash_sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='CARD'),0)::float card_sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='EFT'),0)::float eft_sales,count(*)::int transactions FROM sales WHERE created_at::date=$1`,[date]);const {rows:[exp]}=await pool.query(`SELECT COALESCE(sum(amount),0)::float expenses,COALESCE(sum(amount) FILTER(WHERE payment_method='CASH'),0)::float cash_expenses FROM expenses WHERE created_at::date=$1`,[date]);const {rows:settlements}=await pool.query(`SELECT id,business_date,channel,gross_amount::float gross_amount,fees::float fees,net_amount::float net_amount,reference,status,notes,actor,created_at FROM merchant_settlements WHERE business_date=$1 ORDER BY id DESC`,[date]);const {rows:[sett]}=await pool.query(`SELECT COALESCE(sum(net_amount) FILTER(WHERE channel='CAPITEC_CARD'),0)::float capitec_card_net,COALESCE(sum(net_amount) FILTER(WHERE channel='CAPITEC_EFT'),0)::float capitec_eft_net,COALESCE(sum(net_amount) FILTER(WHERE channel='CASH_BANKING'),0)::float cash_banked FROM merchant_settlements WHERE business_date=$1`,[date]);res.json({date,...sales,...exp,...sett,unsettled_card:Number((sales.card_sales-sett.capitec_card_net).toFixed(2)),unsettled_eft:Number((sales.eft_sales-sett.capitec_eft_net).toFixed(2)),cash_available:Number((sales.cash_sales-exp.cash_expenses-sett.cash_banked).toFixed(2)),settlements});});
app.post('/api/merchant-settlements',auth,manager,async(req,res)=>{const b=req.body||{},date=b.business_date||new Date().toISOString().slice(0,10),channel=String(b.channel||'').toUpperCase();if(!['CAPITEC_CARD','CAPITEC_EFT','CASH_BANKING'].includes(channel))return res.status(400).json({error:'Invalid settlement channel'});const gross=Number(b.gross_amount),fees=Number(b.fees||0),net=b.net_amount===''||b.net_amount==null?Number((gross-fees).toFixed(2)):Number(b.net_amount),status=String(b.status||'PENDING').toUpperCase();if(!(gross>=0)||!(fees>=0)||!(net>=0)||!['PENDING','SETTLED','RECONCILED'].includes(status))return res.status(400).json({error:'Valid settlement fields required'});const {rows:[row]}=await pool.query(`INSERT INTO merchant_settlements(business_date,channel,gross_amount,fees,net_amount,reference,status,notes,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[date,channel,gross,fees,net,b.reference||null,status,b.notes||null,req.user.email]);await audit(req.user.email,'MERCHANT_SETTLEMENT_RECORDED','SETTLEMENT',String(row.id),{channel,net});res.json({ok:true,settlement:row});});
app.delete('/api/merchant-settlements/:id',auth,director,async(req,res)=>{const {rows:[row]}=await pool.query(`DELETE FROM merchant_settlements WHERE id=$1 RETURNING *`,[Number(req.params.id)]);if(!row)return res.status(404).json({error:'Settlement not found'});await audit(req.user.email,'MERCHANT_SETTLEMENT_REMOVED','SETTLEMENT',String(row.id),{});res.json({ok:true});});
app.post('/api/stock/receive',auth,manager,async(req,res)=>{const {sku,reference,note}=req.body;let qty=Number(req.body.qty),unitCost=Number(req.body.unit_cost);const mode=String(req.body.mode||'UNIT').toUpperCase();const {rows:[p]}=await pool.query(`SELECT units_per_case FROM products WHERE sku=$1`,[sku]);if(!p)return res.status(400).json({error:'Unknown SKU'});if(mode==='CASE'){if(!(qty>0)||!(unitCost>=0))return res.status(400).json({error:'Positive case quantity and cost required'});qty*=p.units_per_case;unitCost/=p.units_per_case;}if(!(qty>0)||!(unitCost>=0))return res.status(400).json({error:'Positive quantity and cost required'});const c=await pool.connect();try{await c.query('BEGIN');const {rows:[inv]}=await c.query(`UPDATE inventory SET qty=qty+$2,unit_cost=$3,updated_at=now() WHERE sku=$1 RETURNING *`,[sku,qty,unitCost]);await c.query(`INSERT INTO stock_movements(sku,movement_type,qty,unit_cost,reference,note,actor) VALUES($1,'RECEIPT',$2,$3,$4,$5,$6)`,[sku,qty,unitCost,reference||null,note||null,req.user.email]);await c.query('COMMIT');await audit(req.user.email,'STOCK_RECEIVED','PRODUCT',sku,{qty,mode});res.json({ok:true,inventory:inv});}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message});}finally{c.release();}});
app.post('/api/sales',auth,async(req,res)=>{const items=Array.isArray(req.body.items)?req.body.items:[],method=req.body.payment_method;if(!['CASH','CARD','EFT'].includes(method)||!items.length)return res.status(400).json({error:'Items and payment method required'});const c=await pool.connect();try{await c.query('BEGIN');let subtotal=0;const priced=[];for(const item of items){const count=Number(item.qty);const {rows:[p]}=await c.query(`SELECT p.sku,p.name,p.selling_price::float,p.case_price::float,p.units_per_case,i.qty::float stock_qty FROM products p JOIN inventory i USING(sku) WHERE p.sku=$1 AND p.active=TRUE FOR UPDATE`,[item.sku]);if(!p||!(count>0))throw new Error('Invalid product or quantity');const isCase=String(item.mode||'UNIT').toUpperCase()==='CASE',stockQty=isCase?count*p.units_per_case:count;if(p.stock_qty<stockQty)throw new Error('Insufficient stock for '+p.name);const price=isCase?(p.case_price==null?p.selling_price*p.units_per_case:p.case_price):p.selling_price,line=Number((price*count).toFixed(2));subtotal+=line;priced.push({...p,stockQty,price,line,isCase});}subtotal=Number(subtotal.toFixed(2));const tender=req.body.cash_tendered==null?null:Number(req.body.cash_tendered);if(method==='CASH'&&!(tender>=subtotal))throw new Error('Cash tendered is below total');const change=method==='CASH'?Number((tender-subtotal).toFixed(2)):null,ref='ES-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();const {rows:[sale]}=await c.query(`INSERT INTO sales(receipt_no,payment_method,subtotal,cash_tendered,change_due,actor) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at`,[ref,method,subtotal,tender,change,req.user.email]);for(const p of priced){await c.query(`INSERT INTO sale_items(sale_id,sku,qty,unit_price,line_total) VALUES($1,$2,$3,$4,$5)`,[sale.id,p.sku,p.stockQty,p.price,p.line]);await c.query(`UPDATE inventory SET qty=qty-$2,updated_at=now() WHERE sku=$1`,[p.sku,p.stockQty]);await c.query(`INSERT INTO stock_movements(sku,movement_type,qty,reference,actor,note) VALUES($1,'SALE',$2,$3,$4,$5)`,[p.sku,-p.stockQty,ref,req.user.email,p.isCase?'CASE SALE':'UNIT SALE']);}await c.query('COMMIT');await audit(req.user.email,'SALE_COMPLETED','SALE',ref,{payment_method:method,subtotal});res.json({ok:true,receipt_no:ref,total:subtotal,change_due:change});}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message});}finally{c.release();}});
app.post('/api/expenses',auth,manager,async(req,res)=>{const {category,description,payment_method,reference}=req.body,amount=Number(req.body.amount);if(!category||!description||!(amount>=0)||!['CASH','CARD','EFT'].includes(payment_method))return res.status(400).json({error:'Valid expense fields required'});const {rows:[row]}=await pool.query(`INSERT INTO expenses(category,description,amount,payment_method,reference,actor) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[category,description,amount,payment_method,reference||null,req.user.email]);await audit(req.user.email,'EXPENSE_RECORDED','EXPENSE',String(row.id),{amount});res.json({ok:true,expense:row});});
app.post('/api/cashups',auth,manager,async(req,res)=>{const date=req.body.business_date||new Date().toISOString().slice(0,10),opening=Number(req.body.opening_float||0),actual=Number(req.body.actual_cash);if(!Number.isFinite(actual))return res.status(400).json({error:'actual_cash required'});const {rows:[tot]}=await pool.query(`SELECT COALESCE(sum(subtotal) FILTER(WHERE payment_method='CASH'),0)::float cash_sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='CARD'),0)::float card_sales,COALESCE(sum(subtotal) FILTER(WHERE payment_method='EFT'),0)::float eft_sales FROM sales WHERE created_at::date=$1`,[date]);const {rows:[exp]}=await pool.query(`SELECT COALESCE(sum(amount),0)::float cash_expenses FROM expenses WHERE created_at::date=$1 AND payment_method='CASH'`,[date]);const expected=Number((opening+tot.cash_sales-exp.cash_expenses).toFixed(2)),variance=Number((actual-expected).toFixed(2));const {rows:[row]}=await pool.query(`INSERT INTO cashups(business_date,opening_float,expected_cash,actual_cash,variance,card_total,eft_total,notes,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[date,opening,expected,actual,variance,tot.card_sales,tot.eft_sales,req.body.notes||null,req.user.email]);await audit(req.user.email,'CASHUP_COMPLETED','CASHUP',String(row.id),{date,variance});res.json({ok:true,cashup:row});});
app.post('/api/infrastructure',auth,manager,async(req,res)=>{const vals=[req.body.battery_percent,req.body.solar_kw,req.body.water_percent].map(v=>v==null?null:Number(v));const {rows:[row]}=await pool.query(`INSERT INTO infrastructure_status(battery_percent,solar_kw,water_percent,internet_status,note,actor) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[vals[0],vals[1],vals[2],req.body.internet_status||null,req.body.note||null,req.user.email]);await audit(req.user.email,'INFRASTRUCTURE_UPDATED','INFRASTRUCTURE',String(row.id),{});res.json({ok:true,status:row});});
app.get('/api/audit',auth,manager,async(req,res)=>{const {rows}=await pool.query(`SELECT id,actor,action,entity,entity_id,details,created_at FROM audit_log ORDER BY id DESC LIMIT 300`);res.json(rows);});

app.use((req,res,next)=>{if(req.path.startsWith('/api/')||req.path==='/health')return next();res.sendFile(path.join(__dirname,'public','index.html'));});
migrate().then(()=>app.listen(PORT,()=>console.log(`Esingesini Lounge Operations listening on ${PORT}`))).catch(err=>{console.error(err);process.exit(1);});
