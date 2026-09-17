const {Pool}=require('pg');
const DATABASE_URL=process.env.DATABASE_URL;
const pool=new Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false}});

const items=[
 ['CIG-STUY-RED-20','Peter Stuyvesant','Red','20 cigarettes'],
 ['CIG-STUY-BLU-20','Peter Stuyvesant','Blue','20 cigarettes'],
 ['CIG-ROTH-RED-20','Rothmans','Red','20 cigarettes'],
 ['CIG-ROTH-BLU-20','Rothmans','Blue','20 cigarettes'],
 ['CIG-DUNH-RED-20','Dunhill','Red','20 cigarettes'],
 ['CIG-DUNH-BLU-20','Dunhill','Blue','20 cigarettes'],
 ['CIG-MARL-RED-20','Marlboro','Red','20 cigarettes'],
 ['CIG-MARL-GLD-20','Marlboro','Gold','20 cigarettes'],
 ['CIG-CHES-RED-20','Chesterfield','Red','20 cigarettes'],
 ['CIG-CHES-BLU-20','Chesterfield','Blue','20 cigarettes'],
 ['CIG-PALL-RED-20','Pall Mall','Red','20 cigarettes'],
 ['CIG-PALL-BLU-20','Pall Mall','Blue','20 cigarettes'],
 ['CIG-CAML-FIL-20','Camel','Filters','20 cigarettes'],
 ['CIG-CAML-BLU-20','Camel','Blue','20 cigarettes'],
 ['CIG-BENH-GLD-20','Benson & Hedges','Gold','20 cigarettes'],
 ['CIG-WINS-RED-20','Winston','Red','20 cigarettes'],
 ['CIG-WINS-BLU-20','Winston','Blue','20 cigarettes'],
 ['CIG-KENT-BLU-20','Kent','Blue','20 cigarettes'],
 ['CIG-VOGU-BLU-20','Vogue','Blue','20 cigarettes'],
 ['CIG-LD-RED-20','LD','Red','20 cigarettes'],
 ['CIG-LD-BLU-20','LD','Blue','20 cigarettes']
];

async function load(){
  for(const [sku,brand,variant,size] of items){
    const name=`${brand} ${variant}`;
    await pool.query(`INSERT INTO products(sku,category,name,brand,serving,size_label,selling_price,units_per_case,case_price,age_restricted,expiry_tracking,active,manually_added)
      VALUES($1,'CIGARETTES',$2,$3,$4,$4,0,10,NULL,TRUE,FALSE,TRUE,FALSE)
      ON CONFLICT(sku) DO UPDATE SET category='CIGARETTES',brand=EXCLUDED.brand,name=EXCLUDED.name,serving=EXCLUDED.serving,size_label=EXCLUDED.size_label,units_per_case=10,age_restricted=TRUE,active=TRUE`,[sku,name,brand,size]);
    await pool.query(`INSERT INTO inventory(sku,reorder_level) VALUES($1,0) ON CONFLICT(sku) DO NOTHING`,[sku]);
  }
}
load().catch(e=>console.error('Cigarette catalogue load failed:',e));
