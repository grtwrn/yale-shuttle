/** Bounded actual built SPA, intercepted local fixture and tester identity only. */
import fs from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const reportOut='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-7';
const service=process.cwd(),out='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/traversal-guard';
const {chromium}=createRequire(service+'/package.json')('playwright-core');
const {seedTestId}=await import(service+'/scripts/testId.mjs');
const payload=JSON.parse(await fs.readFile(out+'/calibration-payload.json','utf8'));
const topology=JSON.parse(await fs.readFile('/home/gwarren/projects/yale-shuttle-watcher/red-eta-data/payload.json','utf8'));
const frames=gunzipSync(await fs.readFile(out+'/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(JSON.parse);
const decisions=(await fs.readFile('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-6/ordered-browser-decisions.jsonl','utf8')).trim().split('\n').map(JSON.parse);
const report={sessions:[],errors:[],checks:0,scope:'Actual built React shell numerical hook parity, stationary explicit origins; no screen reader or physical phone claim.'};
const fields=['mode','routeLabel','boardStopId','alightStopId','busName','walkToSec','walkFromSec','waitSec','rideSec','plannedRideSec','totalSec','busEtaSec','busLowSec','busHighSec','computedAtMs','departed','etaUnavailable','journeyArrival'];
function project(options){return options.map(o=>Object.fromEntries(fields.filter(k=>o[k]!==undefined).map(k=>[k,o[k]]))).sort((a,b)=>a.routeLabel.localeCompare(b.routeLabel));}
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try{
 for(const sid of ['57454:48:0']){
  const expected=decisions.filter(d=>d.session===sid && d.at<=1789561481036), atSet=new Set(expected.map(d=>d.at));
  const timeline=frames.filter(f=>atSet.has(f.at)); let active=timeline[0];
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'America/New_York',serviceWorkers:'block'});
  try{
   await seedTestId(context);
   await context.addInitScript(({at,from,to})=>{
    const RealDate=Date;window.__fixtureNow=at;
    window.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[window.__fixtureNow]));}static now(){return window.__fixtureNow;}};
    sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Research explicit origin',fromLL:from,toText:'Research destination',toLL:to,tripTime:'',expandedKey:null,savedAt:at}));
   },{at:active.at,from:expected[0].from,to:expected[0].to});
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
   const session={id:sid,frames:0,firstText:null,lastText:null,missingStates:[]};report.sessions.push(session);
   for(let i=0;i<timeline.length;i++){
    active=timeline[i];const want=expected[i];assert.equal(active.at,want.at);
    if(i)await page.evaluate(at=>{window.__fixtureNow=at;document.dispatchEvent(new Event('visibilitychange'));},active.at);
    const target=JSON.stringify(project(want.options));
    try{
     await page.waitForFunction(({target,fields,order})=>{
      const root=document.getElementById('root');const key=Object.keys(root).find(k=>k.startsWith('__reactContainer$'));if(!key)return false;
      const rf=root[key];let current=rf.stateNode?.current??rf;const stack=[current], arrays=[];let n=0;
      while(stack.length&&n++<10000){const f=stack.pop();if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);
       let h=f.memoizedState,k=0;while(h&&typeof h==='object'&&k++<500){const m=h.memoizedState;
        if(Array.isArray(m)&&Array.isArray(m[0])&&m[0][0]?.routeLabel&&m[0][0]?.mode)arrays.push(m[0]);h=h.next;}
      }
      const project=opts=>opts.map(o=>Object.fromEntries(fields.filter(k=>o[k]!==undefined).map(k=>[k,o[k]]))).sort((a,b)=>a.routeLabel.localeCompare(b.routeLabel));
      window.__parityArrays=arrays;
      const close=(a,b)=>typeof a==='number'&&typeof b==='number'?Math.abs(a-b)<=0.001:a&&b&&typeof a==='object'&&typeof b==='object'?Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&close(a[k],b[k])):a===b;
      const want=JSON.parse(target);return arrays.some(a=>close(project(a),want))&&arrays.some(a=>a.map(o=>o.routeLabel).join('|')===order&&close(project(a),want));
     },{target,fields,order:want.order.order.join('|')});
    }catch(e){await fs.writeFile(reportOut+'/deadline-browser-failure.json',JSON.stringify({sid,i,at:active.at,want,arrays:await page.evaluate(()=>window.__parityArrays),text:await page.locator('body').innerText()},null,2));throw e;}
    session.frames++;report.checks++;
    if([1789561481036,1789567302279,1789567307286,1789567322346].includes(active.at))session.missingStates.push({at:active.at,text:await page.locator('body').innerText(),option:project(want.options).find(o=>o.mode==='shuttle')});
    if(i===0)session.firstText=await page.locator('body').innerText();
    if(i===timeline.length-1){
      session.lastText=await page.locator('body').innerText();
      assert.equal(active.at,1789561481036);
      const trigger=page.getByRole('button',{name:/Red arrival details/});
      await trigger.focus();await page.keyboard.press('Enter');
      const dialog=page.getByRole('dialog',{name:'Red arrival'});await dialog.waitFor();
      const detailText=await dialog.innerText();assert.ok(detailText.includes('#309'));
      const close=page.getByRole('button',{name:'Close arrival details'}),box=await close.boundingBox();assert.ok(box.width>=44&&box.height>=44);
      await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
      await trigger.tap();await dialog.waitFor();await close.tap();await dialog.waitFor({state:'hidden'});
      await page.getByRole('button',{name:/Arrive by/}).click();
      const section=page.getByRole('region',{name:'Arrive by class'});
      await section.getByLabel('Time to get inside').selectOption('5');
      const classInput=section.getByLabel('Class starts · local time');
      const restored=want.options.find(o=>o.mode==='shuttle').journeyArrival;
      assert.ok(restored && !restored.catchRisk && !restored.estimated);
      const deadlineStates=[];
      for(const [delta,status] of [[360000,'Window fits buffer'],[60000,'May use your buffer'],[-60000,'Window extends past class']]){
        const value=await page.evaluate(at=>{const d=new Date(at),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;},restored.highMs+delta);
        await classInput.fill(value);await section.getByRole('button',{name:/Red · #309/}).getByText(new RegExp(status)).waitFor();
        const text=await section.innerText();assert.ok(text.includes('Red · #309'));deadlineStates.push({value,status,text});
      }
      session.deadlines=deadlineStates;
      const clean=structuredClone(active);
      active={...clean,server_eta:{...clean.server_eta,servedAt:clean.at+46000}};
      await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.getByText('ETA unavailable',{exact:true}).waitFor();
      await section.getByText('No live window',{exact:true}).waitFor();
      active={...clean,server_eta:null};await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.getByText('ETA unavailable',{exact:true}).waitFor();
      active=clean;await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.getByRole('button',{name:/Red arrival details/}).waitFor();
      await page.getByText('39 min',{exact:true}).waitFor();await section.getByText(/Window extends past class/).waitFor();assert.equal(await page.getByText('ETA unavailable',{exact:true}).count(),0);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      session.transitions={detailText,closeTarget:box,keyboard:true,touch:true,staleMissingRecovery:true,noPageOverflow:true};
    }
   }
  }finally{await context.close();}
 }
 assert.deepEqual(report.errors,[]);
}finally{await browser.close();await fs.writeFile(reportOut+'/deadline-browser.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({checks:report.checks,sessions:report.sessions.map(({id,frames})=>({id,frames})),errors:report.errors}));
