/** Reviewer-authored lifecycle check; all requests intercepted, one bounded browser. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-8';
const A='/home/gwarren/projects/yale-shuttle-watcher';
const B=A+'/overnight-2026-09-17/eta/cycle-5/traversal-guard';
const service=process.cwd();
const {chromium}=createRequire(service+'/package.json')('playwright-core');
const {seedTestId}=await import(service+'/scripts/testId.mjs');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const payload=await read(B+'/calibration-payload.json'),topology=await read(A+'/red-eta-data/payload.json');
const original=gunzipSync(await fs.readFile(B+'/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(JSON.parse).find(f=>f.at===1789561481036);
const sample=(await fs.readFile(B+'/decisions.jsonl','utf8')).trim().split('\n').map(JSON.parse).find(r=>r.at===original.at&&r.session==='57454:48:0');
const clean=structuredClone(original);
for(const [i,r] of clean.server_eta.rows.entries())if(clean.server_eta.buses[r[0]][0]==='309'&&r[1]===121&&r[5]===1){
 r[2]=200;r[3]=150;r[4]=300;r[7]=200;r[8]=150;
 clean.server_eta.distributions[i]=Array.from({length:50},(_,k)=>150+150*k/49);
}
let active=structuredClone(clean),failure=false,polls=0;
const gps=walk=>({latitude:sample.from.lat+walk*1.1/6371000*180/Math.PI,longitude:sample.from.lon});
const report={states:[],errors:[],scope:'Synthetic causal pickup and GPS boundaries on one recorded current-state fixture; no historical incidence claim.'};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,geolocation:gps(100),permissions:['geolocation'],timezoneId:'America/New_York',serviceWorkers:'block'});
 try{
  await seedTestId(context);
  await context.addInitScript(({at,from,to})=>{
   const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:[at]));}static now(){return at;}};
   sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Current location',fromLL:from,toText:'Review destination',toLL:to,tripTime:'',expandedKey:null,savedAt:at}));
  },{at:clean.at,from:sample.from,to:sample.to});
  const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.hostname!=='shuttle.test')return route.abort();
   if(u.pathname==='/api/buses'){polls++;return failure?route.fulfill({status:503,json:{error:'synthetic unavailable'}}):route.fulfill({json:{...topology,...payload,buses:active.buses,server_eta:active.server_eta}});}
   if(u.pathname==='/api/weather')return route.fulfill({status:204});
   if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[],routes:[]}});
   const file=u.pathname==='/'?'/index.html':u.pathname;
   try{return route.fulfill({body:await fs.readFile(service+'/web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404});}
  });
  await page.goto('https://shuttle.test',{waitUntil:'domcontentloaded'});
  async function option({walk=100,risk=null,available=true,eta=null}={}){
   await page.waitForFunction(({walk,risk,available,eta})=>{
    const root=document.getElementById('root'),key=Object.keys(root).find(k=>k.startsWith('__reactContainer$'));if(!key)return false;
    const rf=root[key],stack=[rf.stateNode?.current??rf];let n=0;
    while(stack.length&&n++<10000){const f=stack.pop();if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);let h=f.memoizedState,k=0;
     while(h&&typeof h==='object'&&k++<500){const m=h.memoizedState;
      if(Array.isArray(m)&&Array.isArray(m[0]))for(const o of m[0]){
       if(o?.mode==='shuttle'&&o.routeLabel==='Red'&&(Object.hasOwn(o,'departed')||o.etaUnavailable)&&(!available&&o.etaUnavailable||Math.abs(o.walkToSec-walk)<0.01)
        &&Boolean(o.journeyArrival)===available&&(!available||o.journeyArrival.catchRisk===risk)&&(eta===null||o.busEtaSec===eta)){
         window.__reviewOption=o;return true;
       }
      }h=h.next;
     }
    }return false;
   },{walk,risk,available,eta});
   return page.evaluate(()=>window.__reviewOption);
  }
  async function refresh(){await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));}
  await option({risk:true,eta:0});
  await page.getByRole('button',{name:/Arrive by/}).tap();
  const section=page.getByRole('region',{name:'Arrive by class'});
  const classValue=await page.evaluate(at=>{const d=new Date(at),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;},clean.at+90*60000);
  await section.getByLabel('Class starts · local time').fill(classValue);
  let destination;
  async function capture(name,want){
   const o=await option(want);const warning=section.getByText(/^Connection uncertain/);
   if(want.available===false){await section.getByText('No live window',{exact:true}).waitFor();}
   else{
    await warning.waitFor({state:want.risk?'visible':'hidden'});
    if(destination)assert.equal(o.journeyArrival.pointMs,destination);else destination=o.journeyArrival.pointMs;
    assert.equal(o.busName,'309');
   }
   assert.equal(await warning.count(),want.available!==false&&want.risk?1:0);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   report.states.push({name,option:o,deadlineText:await section.innerText(),polls});
  }
  await capture('raw-at-stop walk100 low150',{risk:true,eta:0});
  await page.screenshot({path:O+'/at-stop-caution.png',fullPage:true});
  for(const bus of active.buses)if(bus.bus_name.replace(/^#/,'')==='309')delete bus.at_stop_id;
  await refresh();await capture('approaching same forecast',{risk:false,eta:200});
  active=structuredClone(clean);await refresh();await capture('raw-at-stop returns',{risk:true,eta:0});
  await context.setGeolocation(gps(0));await capture('rider reaches pickup',{walk:0,risk:false,eta:0});
  await context.setGeolocation(gps(100));await capture('rider walks again',{risk:true,eta:0});
  const keep=active.server_eta.rows.map((r,i)=>i).filter(i=>active.server_eta.rows[i][1]!==48);
  active.server_eta.rows=keep.map(i=>active.server_eta.rows[i]);active.server_eta.distributions=keep.map(i=>active.server_eta.distributions[i]);
  await refresh();await capture('destination missing',{available:false});
  active=structuredClone(clean);await refresh();await capture('destination recovers',{risk:true,eta:0});
  active.server_eta.rows=[];active.server_eta.distributions=[];await refresh();await capture('forecast rows empty',{available:false});
  active=structuredClone(clean);await refresh();await capture('rows recover',{risk:true,eta:0});
  failure=true;await refresh();await capture('feed503',{available:false});
  failure=false;await refresh();await capture('feed recovers',{risk:true,eta:0});
  await page.reload({waitUntil:'domcontentloaded'});await option({risk:true,eta:0});
  report.reloadPreservesCaution=true;
  assert.deepEqual(report.errors,[]);
 }finally{await context.close();}
}finally{await browser.close();report.resourcesClosed=true;await fs.writeFile(O+'/state-transitions.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({states:report.states.length,reloadPreservesCaution:report.reloadPreservesCaution,errors:report.errors,resourcesClosed:report.resourcesClosed}));
