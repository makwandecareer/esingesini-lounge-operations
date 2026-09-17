const bcrypt = require('bcryptjs');
const crypto = require('crypto');

module.exports = function registerEnhancements({app,pool,audit,auth}) {
  const permit = roles => (req,res,next) => roles.includes(req.user.role) ? next() : res.status(403).json({error:'Permission denied'});
  const director = permit(['DIRECTOR']);
  const catalogueAdmin = permit(['DIRECTOR','ADMINISTRATOR']);
  const stockUser = permit(['DIRECTOR','ADMINISTRATOR','MANAGER','STOCK']);

  async function migrateEnhancements(){
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      UPDATE users SET role='DIRECTOR' WHERE role='OWNER';
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('DIRECTOR','ADMINISTRATOR','MANAGER','CASHIER','STOCK'));

      ALTER TABLE products ALTER COLUMN selling_price DROP NOT NULL;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS case_size INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS case_selling_price NUMERIC(12,2);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_unit TEXT NOT NULL DEFAULT 'UNIT';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS age_restricted BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

      ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS sale_unit TEXT NOT NULL DEFAULT 'UNIT';
      ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS stock_units NUMERIC(14,3);

      UPDATE products SET case_size=24
      WHERE category IN ('BEER','CIDER & RTD','SOFT DRINK','ENERGY DRINK','WATER','JUICE','MIXER','ALCOHOL-FREE') AND case_size=1;
      UPDATE products SET case_selling_price=ROUND(selling_price*case_size,2)
      WHERE case_size>1 AND selling_price IS NOT NULL AND case_selling_price IS NULL;
    `);

    const ownerEmail=process.env.OWNER_EMAIL;
    if(ownerEmail) await pool.query(`UPDATE users SET role='DIRECTOR' WHERE email=$1`,[ownerEmail.toLowerCase()]);

    const beers=[
      ['BEER-096','Castle Milk Stout','330 ml'],['BEER-097','Amstel Lager','330 ml'],
      ['BEER-098','Lion Lager','330 ml'],['BEER-099','Flying Fish Lemon','330 ml'],
      ['BEER-100','Flying Fish Dry Apple','330 ml'],['BEER-101','Castle Double Malt','330 ml'],
      ['BEER-102','Heineken Silver','330 ml']
    ];
    for(const [sku,name,serving] of beers){
      await pool.query(`INSERT INTO products(sku,category,name,serving,selling_price,active,case_size,stock_unit)
        VALUES($1,'BEER',$2,$3,NULL,FALSE,24,'BOTTLE') ON CONFLICT(sku) DO NOTHING`,[sku,name,serving]);
      await pool.query(`INSERT INTO inventory(sku) VALUES($1) ON CONFLICT(sku) DO NOTHING`,[sku]);
    }
  }

  app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));

  app.get('/api/catalogue/manage',auth, async (req,res)=>{
    const {rows}=await pool.query(`SELECT p.sku,p.category,p.name,p.serving,p.selling_price::float AS selling_price,p.active,
      p.case_size,p.case_selling_price::float AS case_selling_price,p.stock_unit,p.age_restricted,
      i.qty::float AS stock_qty,i.unit_cost::float AS unit_cost,i.reorder_level::float AS reorder_level
      FROM products p JOIN inventory i USING(sku) ORDER BY p.category,p.name`);
    res.json(rows);
  });

  app.post('/api/products/manage',auth,catalogueAdmin, async (req,res)=>{
    const category=String(req.body.category||'').trim().toUpperCase();
    const name=String(req.body.name||'').trim();
    const serving=String(req.body.serving||'').trim();
    const sellingPrice=req.body.selling_price===''||req.body.selling_price==null?null:Number(req.body.selling_price);
    const caseSize=Math.max(1,parseInt(req.body.case_size||1,10));
    const casePrice=req.body.case_selling_price===''||req.body.case_selling_price==null?null:Number(req.body.case_selling_price);
    const active=!!req.body.active;
    if(!category||!name||!serving) return res.status(400).json({error:'Category, name and serving are required'});
    if(active && !(sellingPrice>0)) return res.status(400).json({error:'Active POS items require a selling price above R0'});
    const sku=(String(req.body.sku||'').trim().toUpperCase() || ('MAN-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase()));
    try{
      await pool.query(`INSERT INTO products(sku,category,name,serving,selling_price,active,case_size,case_selling_price,stock_unit,age_restricted,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,[sku,category,name,serving,sellingPrice,active,caseSize,casePrice,req.body.stock_unit||'UNIT',!!req.body.age_restricted]);
      await pool.query(`INSERT INTO inventory(sku,reorder_level) VALUES($1,$2)`,[sku,Number(req.body.reorder_level||0)]);
      await audit(req.user.email,'PRODUCT_CREATED','PRODUCT',sku,{name,category,sellingPrice,caseSize,casePrice,active});
      res.json({ok:true,sku});
    }catch(e){res.status(400).json({error:e.code==='23505'?'SKU already exists':e.message});}
  });

  app.patch('/api/products/manage/:sku',auth,catalogueAdmin, async (req,res)=>{
    const sku=req.params.sku;
    const {rows:[p]}=await pool.query(`SELECT * FROM products WHERE sku=$1`,[sku]);
    if(!p) return res.status(404).json({error:'Product not found'});
    const category=String(req.body.category??p.category).trim().toUpperCase();
    const name=String(req.body.name??p.name).trim();
    const serving=String(req.body.serving??p.serving).trim();
    const sellingPrice=req.body.selling_price===undefined?(p.selling_price==null?null:Number(p.selling_price)):(req.body.selling_price===''?null:Number(req.body.selling_price));
    const caseSize=req.body.case_size===undefined?p.case_size:Math.max(1,parseInt(req.body.case_size,10));
    const casePrice=req.body.case_selling_price===undefined?(p.case_selling_price==null?null:Number(p.case_selling_price)):(req.body.case_selling_price===''?null:Number(req.body.case_selling_price));
    const active=req.body.active===undefined?p.active:!!req.body.active;
    if(active && !(sellingPrice>0)) return res.status(400).json({error:'Active POS items require a selling price above R0'});
    await pool.query(`UPDATE products SET category=$2,name=$3,serving=$4,selling_price=$5,active=$6,case_size=$7,case_selling_price=$8,
      stock_unit=$9,age_restricted=$10,updated_at=now() WHERE sku=$1`,[sku,category,name,serving,sellingPrice,active,caseSize,casePrice,req.body.stock_unit??p.stock_unit,req.body.age_restricted===undefined?p.age_restricted:!!req.body.age_restricted]);
    if(req.body.reorder_level!==undefined) await pool.query(`UPDATE inventory SET reorder_level=$2,updated_at=now() WHERE sku=$1`,[sku,Number(req.body.reorder_level||0)]);
    await audit(req.user.email,'PRODUCT_UPDATED','PRODUCT',sku,{name,sellingPrice,caseSize,casePrice,active});
    res.json({ok:true});
  });

  app.get('/api/staff',auth,director, async (req,res)=>{
    const {rows}=await pool.query(`SELECT id,email,full_name,role,active,created_at FROM users ORDER BY role,email`);
    res.json(rows);
  });
  app.post('/api/staff',auth,director, async (req,res)=>{
    const email=String(req.body.email||'').trim().toLowerCase();
    const password=String(req.body.password||'');
    const role=String(req.body.role||'').toUpperCase();
    if(!email||password.length<10) return res.status(400).json({error:'Valid email and password of at least 10 characters required'});
    if(!['ADMINISTRATOR','MANAGER','CASHIER','STOCK'].includes(role)) return res.status(400).json({error:'Invalid role'});
    const hash=await bcrypt.hash(password,12);
    try{
      const {rows:[u]}=await pool.query(`INSERT INTO users(email,full_name,password_hash,role,active) VALUES($1,$2,$3,$4,TRUE) RETURNING id,email,full_name,role,active`,[email,String(req.body.full_name||'').trim()||null,hash,role]);
      await audit(req.user.email,'STAFF_CREATED','USER',String(u.id),{email,role});
      res.json({ok:true,user:u});
    }catch(e){res.status(400).json({error:e.code==='23505'?'Email already exists':e.message});}
  });
  app.patch('/api/staff/:id',auth,director, async (req,res)=>{
    const {rows:[u]}=await pool.query(`SELECT * FROM users WHERE id=$1`,[Number(req.params.id)]);
    if(!u) return res.status(404).json({error:'User not found'});
    if(u.role==='DIRECTOR') return res.status(400).json({error:'Director account is protected'});
    const role=String(req.body.role??u.role).toUpperCase();
    if(!['ADMINISTRATOR','MANAGER','CASHIER','STOCK'].includes(role)) return res.status(400).json({error:'Invalid role'});
    await pool.query(`UPDATE users SET full_name=$2,role=$3,active=$4 WHERE id=$1`,[u.id,String(req.body.full_name??u.full_name??'').trim()||null,role,req.body.active===undefined?u.active:!!req.body.active]);
    if(req.body.password){
      const pw=String(req.body.password); if(pw.length<10) return res.status(400).json({error:'Password must be at least 10 characters'});
      await pool.query(`UPDATE users SET password_hash=$2 WHERE id=$1`,[u.id,await bcrypt.hash(pw,12)]);
    }
    await audit(req.user.email,'STAFF_UPDATED','USER',String(u.id),{email:u.email,role,active:req.body.active});
    res.json({ok:true});
  });

  app.post('/api/stock/receive-case',auth,stockUser, async (req,res)=>{
    const q=Number(req.body.qty), caseCost=Number(req.body.case_cost);
    if(!(q>0)||!(caseCost>=0)) return res.status(400).json({error:'Positive case quantity and case cost required'});
    const {rows:[p]}=await pool.query(`SELECT case_size FROM products WHERE sku=$1`,[req.body.sku]);
    if(!p) return res.status(404).json({error:'Product not found'});
    const units=q*Number(p.case_size||1), unitCost=caseCost/Number(p.case_size||1);
    const {rows:[inv]}=await pool.query(`UPDATE inventory SET qty=qty+$2,unit_cost=$3,updated_at=now() WHERE sku=$1 RETURNING *`,[req.body.sku,units,unitCost]);
    await pool.query(`INSERT INTO stock_movements(sku,movement_type,qty,unit_cost,reference,note,actor) VALUES($1,'RECEIPT',$2,$3,$4,$5,$6)`,[req.body.sku,units,unitCost,req.body.reference||null,`CASE x${q}; ${req.body.note||''}`.trim(),req.user.email]);
    await audit(req.user.email,'CASE_STOCK_RECEIVED','PRODUCT',req.body.sku,{cases:q,units,caseCost});
    res.json({ok:true,inventory:inv,units_added:units});
  });

  app.post('/api/sales/case',auth, async (req,res)=>{
    const qty=Number(req.body.qty||1), method=String(req.body.payment_method||'').toUpperCase();
    if(!(qty>0)||!['CASH','CARD','EFT'].includes(method)) return res.status(400).json({error:'Valid quantity and payment method required'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const {rows:[p]}=await client.query(`SELECT p.sku,p.name,p.case_size,p.case_selling_price::float,i.qty::float stock_qty FROM products p JOIN inventory i USING(sku) WHERE p.sku=$1 AND p.active=TRUE FOR UPDATE`,[req.body.sku]);
      if(!p) throw new Error('Product not found');
      if(!(p.case_selling_price>0)) throw new Error('Case selling price is not set');
      const units=qty*Number(p.case_size||1); if(p.stock_qty<units) throw new Error('Insufficient stock');
      const total=Number((qty*p.case_selling_price).toFixed(2));
      const tender=req.body.cash_tendered==null?null:Number(req.body.cash_tendered); if(method==='CASH'&&!(tender>=total)) throw new Error('Cash tendered is below total');
      const change=method==='CASH'?Number((tender-total).toFixed(2)):null;
      const ref='ES-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();
      const {rows:[sale]}=await client.query(`INSERT INTO sales(receipt_no,payment_method,subtotal,cash_tendered,change_due,actor) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at`,[ref,method,total,tender,change,req.user.email]);
      await client.query(`INSERT INTO sale_items(sale_id,sku,qty,unit_price,line_total,sale_unit,stock_units) VALUES($1,$2,$3,$4,$5,'CASE',$6)`,[sale.id,p.sku,qty,p.case_selling_price,total,units]);
      await client.query(`UPDATE inventory SET qty=qty-$2,updated_at=now() WHERE sku=$1`,[p.sku,units]);
      await client.query(`INSERT INTO stock_movements(sku,movement_type,qty,reference,note,actor) VALUES($1,'SALE',$2,$3,$4,$5)`,[p.sku,-units,ref,`CASE x${qty}`,req.user.email]);
      await client.query('COMMIT');
      await audit(req.user.email,'CASE_SALE_COMPLETED','SALE',ref,{sku:p.sku,cases:qty,total});
      res.json({ok:true,receipt_no:ref,total,change_due:change,created_at:sale.created_at});
    }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
  });

  return migrateEnhancements;
};
