import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const O=new URL('.',import.meta.url).pathname.replace(/\/$/,''),service=process.cwd();
const mobile=process.env.VIEWPORT!=='desktop';
const {chromium}=createRequire(service+'/package.json')('playwright-core');
const {seedTestId}=await import(service+'/scripts/testId.mjs');
const now=Date.parse('2026-09-17T14:00:00-04:00');
const feed=JSON.parse(await fs.readFile(service+'/web/src/__fixtures__/buses-payload.json','utf8'));
feed.stop_names=Object.fromEntries(JSON.parse(await fs.readFile(service+'/src/server/__fixtures__/stops.json','utf8')).map(s=>[s.id,s.name]));
const seq=feed.routes['3'],start=seq.indexOf(48),previous=(start+seq.length-1)%seq.length;
feed.buses=['307','309'].map((bus_name,i)=>({bus_name,bus_id:i+1,route_id:3,...feed.stop_coords[seq[previous]],last_stop_id:seq[previous],heading:180,observed_at:now}));
const rows=[];
for(let i=0;i<2;i++)for(let h=0;h<seq.length*2;h++){
 const eta=300+i*900+h*90;rows.push([i,seq[(start+h)%seq.length],eta,eta-120,eta+240,h+1,0,eta-120,eta-120]);
}
rows.sort((a,b)=>a[2]-b[2]);
const refreshDots=()=>{feed.server_eta.rows.sort((a,b)=>a[2]-b[2]);feed.server_eta.distributions=feed.server_eta.rows.map(r=>Array.from({length:50},(_,i)=>r[3]+i*(r[4]-r[3])/49));};
feed.server_eta={v:2,at:now,servedAt:now,buses:['307','309'].map(b=>[b,'Red',previous,null]),rows};refreshDots();
const report={scope:'Artifact-only ETA projection build; existing production display is intentionally unchanged. No release.',viewport:mobile?'mobile':'desktop',states:[],errors:[],feedRequests:0};
let failure=false;
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});let context,page;
try{
 context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,timezoneId:'America/New_York',serviceWorkers:'block'});await seedTestId(context);
 await context.addInitScript(({now,fromLL,toLL})=>{
  const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
  sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Research origin',fromLL,toText:'Research destination',toLL,tripTime:'',expandedKey:null,savedAt:now}));
 },{now,fromLL:{lat:feed.stop_coords[48].lat,lon:feed.stop_coords[48].lon-0.0017},toLL:feed.stop_coords[121]});
 page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',async r=>{
  const u=new URL(r.request().url());if(u.hostname!=='pickup-contract.test')return r.abort();
  if(u.pathname==='/api/buses'){report.feedRequests++;return failure?r.fulfill({status:503,json:{error:'fixture'}}):r.fulfill({json:feed});}
  if(u.pathname==='/api/weather')return r.fulfill({status:204});
  if(u.pathname.startsWith('/api/'))return r.fulfill({json:{reports:[],results:[],routes:[]}});
  const file=u.pathname==='/'?'/index.html':u.pathname;try{return r.fulfill({body:await fs.readFile(O+'/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}
 });
 await page.goto('https://pickup-contract.test',{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'View Red trip details',exact:true}).click();
 async function getOption(expected){
  await page.waitForFunction(expected=>{
   const root=document.getElementById('root'),k=Object.keys(root).find(k=>k.startsWith('__reactContainer$'));if(!k)return false;
   const stack=[root[k].stateNode?.current??root[k]];let n=0;
   while(stack.length&&n++<10000){const f=stack.pop();if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);let h=f.memoizedState,c=0;
    while(h&&typeof h==='object'&&c++<500){const m=h.memoizedState;
     if(Array.isArray(m)&&Array.isArray(m[0]))for(const o of m[0])if(o?.mode==='shuttle'&&o.routeLabel==='Red'&&(Object.hasOwn(o,'departed')||o.etaUnavailable)&&o.busName===(expected.pickup??'307')
      &&Boolean(o.etaUnavailable)===Boolean(expected.unavailable)&&Boolean(o.journeyArrival)===expected.journey
      &&(!expected.bus||o.journeyArrival?.busName===expected.bus)&&(!expected.close||o.busEtaSec<30)
      &&(!expected.relation||o.livePickupSelection?.relation===expected.relation)
      &&(expected.departed===undefined||o.departed===expected.departed)){
       window.__contractOption=o;return true;
      }
     h=h.next;
    }
   }return false;
  },expected);return page.evaluate(()=>window.__contractOption);
 }
 async function capture(name,expected){const option=await getOption(expected);await page.waitForTimeout(100);const text=await page.locator('body').innerText();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const state={name,option,text};report.states.push(state);return state;}
 async function refresh(){await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));}
 await capture('initial same bus',{journey:true,bus:'307'});
 for(const r of feed.server_eta.rows)if(r[0]===0){r[2]-=280;r[3]=Math.max(0,r[3]-280);r[4]-=280;r[7]=Math.max(0,r[7]-280);r[8]=Math.max(0,r[8]-280);}refreshDots();await refresh();
 const distinct=await capture('different selected bus with destination',{journey:true,bus:'309',close:true});
 assert.match(distinct.text,/I'm on #309/);assert.match(distinct.text,/I'm on #307/);
 const allRows=structuredClone(feed.server_eta.rows),target=distinct.option.alightStopId;
 feed.server_eta.rows=allRows.filter(r=>r[1]!==target);refreshDots();await refresh();
 const missing=await capture('destination disappears, wait still belongs to #309',{journey:false,close:true});
 assert.equal(missing.option.waitSec,distinct.option.waitSec);assert.equal(missing.option.busEtaSec,distinct.option.busEtaSec);
 assert.doesNotMatch(missing.text,/I'm on #309/);assert.match(missing.text,/I'm on it/);
 // Keep the physical bus roster stable: only the other bus's forecast rows
 // disappear. The existing saved plan must not be regenerated for this probe.
 feed.server_eta.rows=allRows.filter(r=>r[0]===0);refreshDots();await refresh();
 const sameLater=await capture('same vehicle later visit, first visit remains countdown',{journey:true,bus:'307',close:true});
 assert.ok(sameLater.option.waitSec>2000);assert.match(sameLater.text,/I'm on it/);
 feed.server_eta.rows=allRows.filter(r=>r[0]===0&&r[1]!==target);refreshDots();await refresh();
 const laterMissing=await capture('same vehicle later visit without destination',{journey:false,close:true});assert.equal(laterMissing.option.waitSec,sameLater.option.waitSec);
 feed.server_eta.rows=allRows;refreshDots();await refresh();
 const recovered=await capture('destination and distinct bus recover',{journey:true,bus:'309',close:true});assert.equal(recovered.option.waitSec,distinct.option.waitSec);assert.match(recovered.text,/I'm on #309/);
 feed.server_eta.servedAt=now+45000;await refresh();
 const stale=await capture('forecast expires, live identity unavailable',{journey:false,unavailable:true});assert.doesNotMatch(stale.text,/I'm on #309/);
 feed.server_eta.servedAt=now;await refresh();await capture('fresh forecast recovers',{journey:true,bus:'309',close:true});
 const relations=['same-visit','different-bus','different-bus','same-bus-later-visit','same-bus-later-visit','different-bus',undefined,'different-bus'];
 const previous=JSON.parse(await fs.readFile(O+'/../cycle-10/browser-contract.json','utf8'));
 for(let i=0;i<report.states.length;i++){
  const current=report.states[i].option,selection=current.livePickupSelection;
  assert.equal(selection?.relation,relations[i],report.states[i].name);
  if(selection){
   assert.equal(selection.selectedAtMs,now);assert.equal(selection.countdown.busName,'307');
   assert.equal(selection.boarding.busName,relations[i]==='different-bus'?'309':'307');
   assert.equal(selection.countdown.etaSec,current.busEtaSec);
   assert.equal(Math.max(0,selection.boarding.etaSec-current.walkToSec),current.waitSec);
   assert.equal(selection.boarding.stopId,current.boardStopId);
  }
  const {livePickupSelection,...existing}=current;
  assert.deepEqual(JSON.parse(JSON.stringify(existing)),previous.states[i].option,'exact serialized baseline option '+report.states[i].name);
 }
 assert.deepEqual(report.states[1].option.livePickupSelection,report.states[2].option.livePickupSelection);
 assert.deepEqual(report.states[3].option.livePickupSelection,report.states[4].option.livePickupSelection);
 assert.equal(await page.getByRole('button',{name:/I'm on #309/}).count(),1);
 const action=page.getByRole('button',{name:/I'm on #309/});await action.focus();await page.keyboard.press('Tab');
 report.keyboardTabPassed=await page.evaluate(()=>document.activeElement!==document.body);assert.ok(report.keyboardTabPassed);
 // Exercise raw evidence and departed clearing in the real compiled shell.
 feed.buses[0].at_stop_id=48;feed.buses[0].at_stop_since=new Date(now-60000).toISOString().slice(0,19);
 feed.dwells['3']??={};feed.dwells['3']['48']={med:600,sd:10,n:10};await refresh();
 const raw=await capture('raw current pickup with walking caution',{journey:true,bus:'307',close:true,relation:'raw-current'});
 assert.equal(raw.option.waitSec,0);assert.equal(raw.option.busEtaSec,0);assert.equal(raw.option.journeyArrival.catchRisk,true);
 assert.equal(raw.option.livePickupSelection.boarding.source,'raw-at-stop');
 assert.equal(raw.option.livePickupSelection.boarding.stopsAhead,undefined);
 feed.server_eta.rows=allRows.filter(r=>r[1]!==target);refreshDots();await refresh();
 const rawMissing=await capture('raw pickup with no destination forecast',{journey:false,close:true,relation:'raw-current'});
 assert.deepEqual(rawMissing.option.livePickupSelection,raw.option.livePickupSelection);
 delete feed.buses[0].at_stop_id;delete feed.buses[0].at_stop_since;
 const sole=structuredClone(allRows.find(r=>r[0]===1&&r[1]===48&&r[5]===1));
 sole[2]=20;sole[3]=0;sole[4]=60;sole[7]=0;sole[8]=0;feed.server_eta.rows=[sole];refreshDots();await refresh();
 const departed=await capture('departed without pinned tolerance clears selection',{journey:false,close:true,departed:true,pickup:'309'});
 assert.equal(departed.option.livePickupSelection,undefined);
 feed.server_eta.rows=allRows;refreshDots();await refresh();
 await capture('catchable selection recovers after departed',{journey:true,bus:'309',close:true,relation:'different-bus',departed:false});

 // Reviewer-only acceptance: poll failure/missing transport must clear projection.
 failure=true;await refresh();
 const failed=await capture('review: polling failure clears metadata',{journey:false,unavailable:true});
 assert.equal(failed.option.livePickupSelection,undefined);
 failure=false;await refresh();await capture('review: poll recovery',{journey:true,bus:'309',close:true,relation:'different-bus'});
 const savedWire=feed.server_eta;delete feed.server_eta;await refresh();
 const missingWire=await capture('review: missing server ETA clears metadata',{journey:false,unavailable:true});
 assert.equal(missingWire.option.livePickupSelection,undefined);
 feed.server_eta=savedWire;await refresh();await capture('review: transport recovery',{journey:true,bus:'309',close:true,relation:'different-bus'});
 const readStorage=()=>page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}}));
 assert.doesNotMatch(JSON.stringify(await readStorage()),/livePickupSelection/);
 // Enter a real future plan through the public UI, then inspect the current
 // hooks' computed option array (identified by this additive own property).
 await page.getByRole('button',{name:'← All routes',exact:true}).click();
 await page.getByRole('button',{name:'Plan for later…',exact:true}).click();
 await page.getByLabel('Departure time',{exact:true}).fill('2026-09-17T15:00');
 await page.getByText(/Estimated from service hours and typical wait and travel times/).waitFor();
 await page.waitForFunction(()=>{
  const root=document.getElementById('root'),k=Object.keys(root).find(k=>k.startsWith('__reactContainer$'));
  const stack=[root[k].stateNode?.current??root[k]];let visited=0,found=false;
  while(stack.length&&visited++<10000){const f=stack.pop();if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);
   let h=f.memoizedState,c=0;while(h&&typeof h==='object'&&c++<500){const m=h.memoizedState;
    if(Array.isArray(m)&&Array.isArray(m[0])&&m[0].some(o=>o?.mode&&Object.hasOwn(o,'livePickupSelection'))){
     found=true;if(m[0].some(o=>o?.livePickupSelection!==undefined))return false;
    }h=h.next;
   }
  }return found;
 });
 report.futurePlanCleared=true;
 assert.doesNotMatch(JSON.stringify(await readStorage()),/livePickupSelection/);
 await page.getByRole('button',{name:'Now',exact:true}).click();
 const details=page.getByRole('button',{name:'View Red trip details',exact:true});
 if(await details.count())await details.click();
 await getOption({journey:true,bus:'309',relation:'different-bus',close:true});
 await page.getByRole('button',{name:/I'm on #309/}).click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('shuttle-boarded-ride')??'null')?.busName==='309');
 const storage=await readStorage();
 assert.doesNotMatch(JSON.stringify(storage),/livePickupSelection/);
 const ride=JSON.parse(storage.local['shuttle-boarded-ride']);
 assert.deepEqual(Object.keys(ride).sort(),['routeLabel','color','busName','boardStopId','alightStopId','startedAt','toLat','toLon','toText'].sort());
 await page.reload({waitUntil:'domcontentloaded'});
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle-boarded-ride')).busName),'309');
 assert.doesNotMatch(JSON.stringify(await readStorage()),/livePickupSelection/);
 report.physicalRidePersistencePassed=true;
 assert.equal(report.errors.length,0);report.completed=true;
}finally{
 if(!report.completed&&page)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);
 if(page)await page.close();if(context)await context.close();await browser.close();report.resourcesClosed=true;
 await fs.writeFile(O+'/browser-review-'+(mobile?'mobile':'desktop')+'.json',JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({completed:report.completed,states:report.states.length,errors:report.errors,resourcesClosed:report.resourcesClosed}));
