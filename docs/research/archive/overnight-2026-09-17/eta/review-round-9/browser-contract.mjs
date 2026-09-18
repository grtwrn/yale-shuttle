import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-9',service=process.cwd();
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
const report={scope:'Unchanged production built SPA; sorted synthetic wire on real topology. Research reproducer only.',states:[],errors:[],feedRequests:0};
let failure=false;
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});let context,page;
try{
 context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'America/New_York',serviceWorkers:'block'});await seedTestId(context);
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
  const file=u.pathname==='/'?'/index.html':u.pathname;try{return r.fulfill({body:await fs.readFile(service+'/web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}
 });
 await page.goto('https://pickup-contract.test',{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'View Red trip details',exact:true}).click();
 async function getOption(expected){
  await page.waitForFunction(expected=>{
   const root=document.getElementById('root'),k=Object.keys(root).find(k=>k.startsWith('__reactContainer$'));if(!k)return false;
   const stack=[root[k].stateNode?.current??root[k]];let n=0;
   while(stack.length&&n++<10000){const f=stack.pop();if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);let h=f.memoizedState,c=0;
    while(h&&typeof h==='object'&&c++<500){const m=h.memoizedState;
     if(Array.isArray(m)&&Array.isArray(m[0]))for(const o of m[0])if(o?.mode==='shuttle'&&o.routeLabel==='Red'&&(Object.hasOwn(o,'departed')||o.etaUnavailable)&&o.busName==='307'
      &&Boolean(o.etaUnavailable)===Boolean(expected.unavailable)&&Boolean(o.journeyArrival)===expected.journey
      &&(!expected.bus||o.journeyArrival?.busName===expected.bus)&&(!expected.close||o.busEtaSec<30)){
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
 assert.equal(report.errors.length,0);report.completed=true;
}finally{
 if(!report.completed&&page)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);
 if(page)await page.close();if(context)await context.close();await browser.close();report.resourcesClosed=true;
 await fs.writeFile(O+'/browser-contract.json',JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({completed:report.completed,states:report.states.length,errors:report.errors,resourcesClosed:report.resourcesClosed}));
