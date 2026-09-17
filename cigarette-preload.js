const {Pool}=require('pg');
const DATABASE_URL=process.env.DATABASE_URL;
const pool=new Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false}});

// Initial South African market benchmark selling prices. Director may edit these in Products & Prices.
// Supplier cost remains controlled through stock receiving / supplier pricing so real margin can be calculated.
const items=[
 ['CIG-STUY-RED-20','Peter Stuyvesant','Red','20 cigarettes',50],
 ['CIG-STUY-BLU-20','Peter Stuyvesant','Blue','20 cigarettes',51],
 ['CIG-ROTH-RED-20','Rothmans','Red','20 cigarettes',41],
 ['CIG-ROTH-BLU-20','Rothmans','Blue','20 cigarettes',41],
 ['CIG-DUNH-RED-20','Dunhill','Red','20 cigarettes',59],
 ['CIG-DUNH-BLU-20','Dunhill','Blue','20 cigarettes',70],
 ['CIG-MARL-RED-20','Marlboro','Red','20 cigarettes',68],
 ['CIG-MARL-GLD-20','Marlboro','Gold','20 cigarettes',68],
 ['CIG-CHES-RED-20','Chesterfield','Red','20 cigarettes',55],
 ['CIG-CHES-BLU-20','Chesterfield','Blue','20 cigarettes',62],
 ['CIG-PALL-RED-20','Pall Mall','Red','20 cigarettes',40],
 ['CIG-PALL-BLU-20','Pall Mall','Blue','20 cigarettes',40],
 ['CIG-CAML-FIL-20','Camel','Filters','20 cigarettes',68],
 ['CIG-CAML-BLU-20','Camel','Blue','20 cigarettes',68],
 ['CIG-BENH-GLD-20','Benson & Hedges','Gold','20 cigarettes',48],
 ['CIG-WINS-RED-20','Winston','Red','20 cigarettes',43],
 ['CIG-WINS-BLU-20','Winston','Blue','20 cigarettes',43],
 ['CIG-KENT-BLU-20','Kent','Blue','20 cigarettes',63],
 ['CIG-VOGU-BLU-20','Vogue','Blue','20 cigarettes',70],
 ['CIG-LD-RED-20','LD','Red','20 cigarettes',40],
 ['CIG-LD-BLU-20','LD','Blue','20 cigarettes',40]
];

async function load(){
  for(const [sku,brand,variant,size,price] of items){
    const name=`${brand} ${variant}`;
    const cartonPrice=Number((price*10).toFixed(2));
    await pool.query(`INSERT INTO products(sku,category,name,brand,serving,size_label,selling_price,units_per_case,case_price,age_restricted,expiry_tracking,active,manually_added)
      VALUES($1,'CIGARETTES',$2,$3,$4,$4,$5,10,$6,TRUE,FALSE,TRUE,FALSE)
      ON CONFLICT(sku) DO UPDATE SET category='CIGARETTES',brand=EXCLUDED.brand,name=EXCLUDED.name,serving=EXCLUDED.serving,size_label=EXCLUDED.size_label,selling_price=EXCLUDED.selling_price,units_per_case=10,case_price=EXCLUDED.case_price,age_restricted=TRUE,expiry_tracking=FALSE,active=TRUE`,[sku,name,brand,size,price,cartonPrice]);
    await pool.query(`INSERT INTO inventory(sku,reorder_level) VALUES($1,5) ON CONFLICT(sku) DO UPDATE SET reorder_level=GREATEST(inventory.reorder_level,5)`,[sku]);
  }
}
load().catch(e=>console.error('Cigarette catalogue load failed:',e));
