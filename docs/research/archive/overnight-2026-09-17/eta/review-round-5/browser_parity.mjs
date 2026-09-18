/** Bounded actual built SPA, intercepted local fixture and tester identity only. */
import fs from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const service=process.cwd(),out='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/traversal-guard';
const {chromium}=createRequire(service+'/package.json')('playwright-core');
const {seedTestId}=await import(service+'/scripts/testId.mjs');
const payload=JSON.parse(await fs.readFile(out+'/calibration-payload.json','utf8'));
const topology=JSON.parse(await fs.readFile('/home/gwarren/projects/yale-shuttle-watcher/red-eta-data/payload.json','utf8'));
const frames=gunzipSync(await fs.readFile(out+'/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(JSON.parse);
const decisions=(await fs.readFile(out+'/decisions.jsonl','utf8')).trim().split('\n').map(JSON.parse);
const report={sessions:[],errors:[],checks:0,scope:'Actual built React shell numerical hook parity, stationary explicit origins; no screen reader or physical phone claim.'};
const fields=['mode','routeLabel','boardStopId','alightStopId','busName','walkToSec','walkFromSec','waitSec','rideSec','plannedRideSec','totalSec','busEtaSec','busLowSec','busHighSec','computedAtMs','departed','etaUnavailable','journeyArrival'];
function project(options){return options.map(o=>Object.fromEntries(fields.filter(k=>o[k]!==undefined).map(k=>[k,o[k]]))).sort((a,b)=>a.routeLabel.localeCompare(b.routeLabel));}
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try{
 for(const sid of ['58224:48:0','58224:48:150']){
  const expected=decisions.filter(d=>d.session===sid), atSet=new Set(expected.map(d=>d.at));
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
   const session={id:sid,frames:0,firstText:null,lastText:null};report.sessions.push(session);
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
    }catch(e){await fs.writeFile('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-5'+'/browser-failure.json',JSON.stringify({sid,i,at:active.at,want,arrays:await page.evaluate(()=>window.__parityArrays),text:await page.locator('body').innerText()},null,2));throw e;}
    session.frames++;report.checks++;
    if(i===0)session.firstText=await page.locator('body').innerText();
    if(i===timeline.length-1)session.lastText=await page.locator('body').innerText();
   }
  }finally{await context.close();}
 }
 assert.deepEqual(report.errors,[]);
}finally{await browser.close();await fs.writeFile('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-5'+'/browser-parity.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({checks:report.checks,sessions:report.sessions.map(({id,frames})=>({id,frames})),errors:report.errors}));
