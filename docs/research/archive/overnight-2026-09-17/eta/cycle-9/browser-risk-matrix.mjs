/** Actual built shell at a recorded raw-at-stop frame, with synthetic walking origins. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-9';
const C='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-6',B='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/traversal-guard',service=process.cwd();
const {chromium}=createRequire(service+'/package.json')('playwright-core');
const {seedTestId}=await import(service+'/scripts/testId.mjs');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const payload=await read(B+'/calibration-payload.json');
const topology=await read('/home/gwarren/projects/yale-shuttle-watcher/red-eta-data/payload.json');
const frames=gunzipSync(await fs.readFile(B+'/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(JSON.parse);
const original=frames.find(f=>f.at===1789561481036);
const sample=(await fs.readFile(C+'/ordered-browser-decisions.jsonl','utf8')).trim().split('\n').map(JSON.parse).find(d=>d.session==='57454:48:0'&&d.at===original.at);
const report={cases:[],errors:[],scope:'Recorded current-state fixture, synthetic live GPS walking offsets with the origin/plan held fixed; no observed walking or all-route claim.'};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try{
 const cases=[{walkSec:0,low:150},{walkSec:100,low:150},{walkSec:100,low:'walk'},
  {walkSec:119,low:150},{walkSec:121,low:150},{walkSec:100,low:150,approaching:true}];
 let measuredWalk=100;
 for(const scenario of cases){
  const {walkSec}=scenario;
  const active=structuredClone(original), low=scenario.low==='walk'?measuredWalk:scenario.low;
  for(const [i,row] of active.server_eta.rows.entries()) {
   if(active.server_eta.buses[row[0]][0]==='309' && row[1]===121 && row[5]===1){
    row[2]=200;row[3]=low;row[4]=300;row[7]=200;row[8]=low;
    active.server_eta.distributions[i]=Array.from({length:50},(_,k)=>low+k*(300-low)/49);
   }
  }
  if(scenario.approaching)for(const bus of active.buses)if(bus.bus_name.replace(/^#/, '')==='309')delete bus.at_stop_id;
  const wireBefore=JSON.stringify(active.server_eta);
  const rawBranch=!scenario.approaching&&walkSec<=119;
  const riskExpected=rawBranch&&walkSec>0;
  const from={...sample.from,lat:sample.from.lat+walkSec*1.1/6371000*180/Math.PI};
  const context=await browser.newContext({geolocation:{latitude:from.lat,longitude:from.lon},permissions:['geolocation'],viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'America/New_York',serviceWorkers:'block'});
  try{
   await seedTestId(context);
   await context.addInitScript(({at,from,to})=>{
    const RealDate=Date;window.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[at]));}static now(){return at;}};
    sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Current location',fromLL:from,toText:'Research destination',toLL:to,tripTime:'',expandedKey:null,savedAt:at}));
   },{at:active.at,from:sample.from,to:sample.to});
   const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));
   await page.route('**/*',async route=>{
    const u=new URL(route.request().url());if(u.hostname!=='shuttle.test')return route.abort();
    if(u.pathname==='/api/buses')return route.fulfill({json:{...topology,...payload,buses:active.buses,server_eta:active.server_eta}});
    if(u.pathname==='/api/weather')return route.fulfill({status:204});
    if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[],routes:[]}});
    const file=u.pathname==='/'?'/index.html':u.pathname;
    try{return route.fulfill({body:await fs.readFile(service+'/web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404});}
   });
   await page.goto('https://shuttle.test',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(({at,walkSec})=>{
    const root=document.getElementById('root'),key=Object.keys(root).find(k=>k.startsWith('__reactContainer$'));if(!key)return false;
    const rf=root[key],stack=[rf.stateNode?.current??rf],arrays=[];let n=0;
    while(stack.length&&n++<10000){const f=stack.pop();if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);let h=f.memoizedState,k=0;
     while(h&&typeof h==='object'&&k++<500){const m=h.memoizedState;if(Array.isArray(m)&&Array.isArray(m[0])&&m[0][0]?.routeLabel&&m[0][0]?.mode)arrays.push(m[0]);h=h.next;}}
    const live=arrays.flat().find(o=>o.mode==='shuttle'&&o.routeLabel==='Red'&&o.computedAtMs===at&&Object.hasOwn(o,'departed')&&Math.abs(o.walkToSec-walkSec)<0.01);
    if(!live)return false;window.__walkOption=live;return true;
   },{at:active.at,walkSec});
   const option=await page.evaluate(()=>window.__walkOption);
   report.cases.push({scenario,low,from,option,text:await page.locator('body').innerText()});
   assert.equal(option.boardStopId,121);assert.equal(option.busName,'309');
   assert.ok(Math.abs(option.walkToSec-walkSec)<0.01);
   if(rawBranch){
    assert.equal(option.busEtaSec,0);assert.equal(option.waitSec,0);assert.equal(option.busDistribution,undefined);
    assert.equal(option.journeyArrival.pointMs,sample.options.find(o=>o.mode==='shuttle').journeyArrival.pointMs);
    // Audit warning after capturing the rendered class panel below.
   }else{
    assert.notEqual(option.busEtaSec,0); // Existing dwell gate fell through to normal catchability.
   }
   {
    await page.getByRole('button',{name:/Arrive by/}).tap();
    const section=page.getByRole('region',{name:'Arrive by class'});
    await section.getByRole('button',{name:/Red · #309/}).waitFor();
    
    
    // Fixture date interpreted in the browser's New Haven timezone.
    const value=await page.evaluate(at=>{const d=new Date(at),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;},active.at+90*60_000);
    await section.getByLabel('Class starts · local time').fill(value);
    report.cases.at(-1).deadlineText=await section.innerText();
   }
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   report.cases.at(-1).pickupRows=active.server_eta.rows.filter(r=>active.server_eta.buses[r[0]][0]==='309' && r[1]===121);
   assert.equal(option.journeyArrival.catchRisk,riskExpected);
   const deadlineText=report.cases.at(-1).deadlineText;
   assert.equal(deadlineText.includes('Connection uncertain'),riskExpected);
   assert.equal(deadlineText.includes('This window assumes you catch it.'),riskExpected);
   if(rawBranch){
    assert.equal(option.busLowSec,0);assert.equal(option.busHighSec,0);assert.equal(option.busDepartNowSec,0);
   }else{
    assert.equal(option.busEtaSec,200);assert.equal(option.busLowSec,low);
   }
   if(scenario.low==='walk')assert.equal(low,option.walkToSec,'Positive forecast lower bound equals the actual live-GPS walk exactly');
   if(walkSec===100)measuredWalk=option.walkToSec;
   assert.equal(JSON.stringify(active.server_eta),wireBefore);
   assert.equal(report.cases.at(-1).pickupRows.length,2);
  }finally{await context.close();}
 }
 assert.deepEqual(report.errors,[]);
}finally{await browser.close();report.resourcesClosed=true;await fs.writeFile(O+'/browser-risk-matrix.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({cases:report.cases.length,errors:report.errors,resourcesClosed:report.resourcesClosed}));
