import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const service=process.cwd(), O=process.env.OUT;
if (!O) throw new Error('Set OUT to a fresh evidence directory');
await fs.mkdir(O,{recursive:true});
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
const report={scope:'Reviewer supplement: missing-destination focus, fleet lifecycle, deadline unknownness and actual selected-bus boarding.',viewport:mobile?'mobile':'desktop',states:[],errors:[],feedRequests:0};
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
 const chosenAction=page.getByRole('button',{name:/I'm on #309/});await chosenAction.focus();
 const allRows=structuredClone(feed.server_eta.rows),target=distinct.option.alightStopId;
 feed.server_eta.rows=allRows.filter(r=>r[1]!==target);refreshDots();await refresh();
 const missing=await capture('destination disappears, wait still belongs to #309',{journey:false,close:true});
 assert.equal(missing.option.waitSec,distinct.option.waitSec);assert.equal(missing.option.busEtaSec,distinct.option.busEtaSec);
 assert.match(missing.text,/I'm on #309/);assert.match(missing.text,/I'm on #307/);
 assert.match(missing.text,/⏳ 17 min/);assert.doesNotMatch(missing.text,/⏳ now-2 min/);
 assert(await chosenAction.evaluate(e=>e===document.activeElement),'destination loss preserves selected action focus');
 // Reviewer-owned transitions from the missing-destination state.
 report.checks=[];
 const directions=page.getByRole('link',{name:'🧭 Directions to stop',exact:true});
 await directions.focus();
 feed.server_eta.rows=allRows;refreshDots();await refresh();
 await capture('external focus through destination restoration',{journey:true,bus:'309',close:true,relation:'different-bus'});
 assert(await directions.evaluate(e=>e===document.activeElement));
 feed.server_eta.rows=allRows.filter(r=>r[1]!==target);refreshDots();await refresh();
 await capture('external focus through destination loss',{journey:false,close:true,relation:'different-bus'});
 assert(await directions.evaluate(e=>e===document.activeElement));
 report.checks.push('Destination loss/recovery does not steal external keyboard focus');
 await chosenAction.focus();failure=true;await refresh();
 const failed=await capture('failed feed removes selected action',{journey:false,unavailable:true});
 assert.equal(failed.option.livePickupSelection,undefined);
 let fallback=page.getByRole('button',{name:"🚌 I'm on it",exact:true});
 assert(await fallback.evaluate(e=>e===document.activeElement));
 failure=false;await refresh();
 await capture('fresh pickup without destination recovers',{journey:false,close:true,relation:'different-bus'});
 assert(await page.getByRole('button',{name:"🚌 I'm on #307",exact:true}).evaluate(e=>e===document.activeElement));
 report.checks.push('Failed-feed action removal restores focus; recovery retains persistent action focus');
 const fleet=feed.buses;feed.buses=[];await refresh();
 const empty=await capture('empty fleet clears selected pickup',{journey:false,unavailable:true});
 assert.equal(empty.option.livePickupSelection,undefined);
 assert.equal(await page.getByRole('button',{name:/I'm on #309/}).count(),0);
 feed.buses=fleet;await refresh();
 await capture('fleet recovers destination-independent choice',{journey:false,close:true,relation:'different-bus'});
 report.checks.push('Empty fleet clears metadata and restores correct choice when vehicles recover');
 await page.getByRole('button',{name:'← All routes',exact:true}).click();
 await page.getByRole('button',{name:/Arrive by…/}).click();
 await page.getByLabel('Class starts · local time',{exact:true}).fill('2026-09-17T14:01');
 const classSection=page.getByRole('region',{name:'Arrive by class',exact:true});
 await classSection.getByRole('heading',{name:'Live shuttle times unavailable',exact:true}).waitFor();
 report.classMissing=await classSection.innerText();
 assert.match(report.classMissing,/No live window/);
 assert.match(report.classMissing,/Estimate past class time/);
 assert.doesNotMatch(report.classMissing,/Window fits buffer/);
 await classSection.getByRole('button',{name:'Clear',exact:true}).click();
 await page.getByRole('button',{name:'View Red trip details',exact:true}).click();
 await getOption({journey:false,close:true,relation:'different-bus'});
 report.checks.push('Class advice with missing destination remains unknown even when walking is late');
 const action=page.getByRole('button',{name:"🚌 I'm on #309",exact:true});
 await action.focus();if(mobile)await action.tap();else await page.keyboard.press('Space');
 const done=page.getByRole('button',{name:'Done',exact:true});await done.waitFor();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle-boarded-ride')));
 assert.equal(saved.busName,'309');assert.equal(saved.boardStopId,48);assert.equal(saved.alightStopId,target);
 assert.equal(saved.livePickupSelection,undefined);assert.equal(saved.stopsAhead,undefined);
 assert.equal(saved.toText,'Research destination');
 await page.reload();await done.waitFor();assert.match(await page.locator('body').innerText(),/Red #309/);
 await done.focus();await page.keyboard.press('Enter');
 const finish=page.getByRole('region',{name:'Finish your trip',exact:true});await finish.waitFor();
 const url=new URL(await finish.getByRole('link',{name:/Walking directions/}).getAttribute('href'));
 assert.equal(url.searchParams.get('destination'),`${feed.stop_coords[121].lat},${feed.stop_coords[121].lon}`);
 assert.equal(url.searchParams.get('travelmode'),'walking');assert.equal(url.searchParams.has('origin'),false);
 assert.match(await finish.innerText(),/Research destination/);
 report.checks.push('Explicit missing-destination boarding tracks #309 through reload and keeps final walk');
 assert.deepEqual(report.errors,[]);report.completed=true;
}finally{
 if(!report.completed&&page)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);
 if(page)await page.close();if(context)await context.close();await browser.close();report.resourcesClosed=true;
 await fs.writeFile(O+'/browser-'+(mobile?'mobile':'desktop')+'.json',JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({completed:report.completed,states:report.states.length,errors:report.errors,resourcesClosed:report.resourcesClosed}));
