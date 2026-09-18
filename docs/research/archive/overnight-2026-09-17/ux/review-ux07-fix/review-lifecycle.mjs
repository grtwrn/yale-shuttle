/** Built-SPA empty/feed/filter regression. All network intercepted; no server.
 * From shuttle-v2, after Vite build, under the shared heavy lock:
 * OUT=/fresh/evidence node scripts/empty-service-check.mjs (DESKTOP=1 optional).
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const service = process.cwd(), out = process.env.OUT;
if (!out) throw new Error('Set OUT to a fresh evidence directory');
await fs.mkdir(out, {recursive:true});
const { chromium } = createRequire(service + '/package.json')('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const now = Date.parse('2026-09-17T14:00:00-04:00');
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id,s.name]));
feed.announcements = [{id:1,title:'Fixture service notice',message:'Check published schedules for planned service.'}];
const seq=feed.routes['3'], start=seq.indexOf(48), previous=(start+seq.length-1)%seq.length;
const buses=['307','309'].map((bus_name,i)=>({bus_name,bus_id:i+1,route_id:3,...feed.stop_coords[seq[previous]],last_stop_id:seq[previous],heading:180,observed_at:now}));
const rows=[];
for(let i=0;i<2;i++) for(let h=0;h<seq.length*2;h++) {
 const eta=300+i*900+h*90;rows.push([i,seq[(start+h)%seq.length],eta,eta-120,eta+240,h+1,0,eta-120,eta-120]);
}
rows.sort((a,b)=>a[2]-b[2]);
const wire={v:2,at:now,servedAt:now,buses:['307','309'].map(b=>[b,'Red',previous,null]),rows,distributions:rows.map(r=>Array.from({length:50},(_,i)=>r[3]+i*(r[4]-r[3])/49))};
feed.buses=[];delete feed.server_eta;
let mode='pending', pending=[], requests=0, failures=0;
const report={scope:'Synthetic intercepted feed on unmodified built SPA; no accuracy claim',checks:[],snapshots:{},errors:[]};
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});let ctx,page;
try {
 ctx=await browser.newContext({viewport:{width:process.env.DESKTOP?1280:390,height:844},isMobile:!process.env.DESKTOP,hasTouch:!process.env.DESKTOP,timezoneId:'America/New_York',serviceWorkers:'block'});
 await seedTestId(ctx);page=await ctx.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));await page.clock.install({time:new Date(now)});
 await page.route('**/*',async r=>{
  const u=new URL(r.request().url());if(u.hostname!=='empty-state.test')return r.abort();
  if(u.pathname==='/api/buses') {requests++;if(mode==='pending'){pending.push(r);return;}if(mode==='fail'){failures++;return r.fulfill({status:503,json:{error:'fixture'}});}if(mode==='malformed')return r.fulfill({json:{error:'fixture'}});return r.fulfill({json:feed});}
  if(u.pathname==='/api/weather')return r.fulfill({status:204});
  if(u.pathname.startsWith('/api/'))return r.fulfill({json:{reports:[],results:[],routes:[]}});
  const f=u.pathname==='/'?'/index.html':u.pathname;
  try{return r.fulfill({body:await fs.readFile(service+'/web/dist'+f),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}
 });
 const nav=name=>page.getByRole('navigation',{name:'Main'}).getByRole('button',{name,exact:true});
 const switchView=async name=>{await page.clock.runFor(400);await nav(name).click();await page.clock.runFor(400);};
 const body=()=>page.locator('body').innerText();
 const red=page.locator('[id="route-card-Red"]');
 const poll=async()=>{const before=requests;await page.clock.runFor(5500);await page.waitForTimeout(120);assert(requests>before,'feed request completed its next poll');};
 const snapshot=async name=>{report.snapshots[name]=await body();assert(!report.snapshots[name].includes('No shuttles running right now'),name+' does not claim service off');};
 const reflow=async()=>{for(const width of (process.env.DESKTOP?[1280,640]:[360,390,430])){await page.setViewportSize({width,height:844});await page.clock.runFor(60);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow '+width);}await page.setViewportSize({width:process.env.DESKTOP?1280:390,height:844});};

 await page.goto('https://empty-state.test',{waitUntil:'domcontentloaded'});
 await page.getByText('Loading shuttle information…',{exact:true}).waitFor();
 await page.clock.runFor(47000);
 await page.getByText('Live shuttle status unavailable',{exact:true}).waitFor();
 await snapshot('stalledInitialRequest');
 mode='ready';
 for (const r of pending) await r.fulfill({json:feed}).catch(()=>{});
 pending=[];
 await poll();
 await page.getByText('No shuttles reporting right now',{exact:true}).waitFor();
 report.checks.push('Initial hanging/aborted requests become unavailable at 45 seconds without claiming empty service; fresh empty recovers');
 feed.buses=buses;feed.server_eta=wire;await poll();
 await page.getByText('🚌 2 shuttles reporting on 1 route',{exact:true}).waitFor();
 mode='pending';await page.clock.runFor(48000);
 await page.getByText('Live shuttle status unavailable',{exact:true}).waitFor();
 await snapshot('stalledRetainedFleet');
 mode='ready';for (const r of pending) await r.fulfill({json:feed}).catch(()=>{});pending=[];await poll();
 await page.getByText('🚌 2 shuttles reporting on 1 route',{exact:true}).waitFor();
 report.checks.push('Retained nonempty fleet expires during hanging polls and recovers without conflating absence of data and buses');
 await switchView('map');await red.waitFor();
 await page.getByRole('button',{name:'Hide all',exact:true}).click();
 await page.getByRole('button',{name:'Blue Day',exact:true}).click();
 const showSelected=page.getByRole('button',{name:'Show selected routes',exact:true});await showSelected.waitFor();
 const saved=await page.evaluate(()=>localStorage.getItem('mapHiddenRoutes'));
 await page.reload({waitUntil:'domcontentloaded'});await showSelected.waitFor();
 assert.equal(await page.evaluate(()=>localStorage.getItem('mapHiddenRoutes')),saved);
 await showSelected.focus();
 // A normal successful poll with an empty fleet turns off the effective
 // Running-now filter and removes the focused recovery control.
 feed.buses=[];delete feed.server_eta;await poll();
 await page.locator('[id="route-card-Blue Day"]').waitFor();
 assert(await page.getByRole('button',{name:'Running now',exact:true}).evaluate(e=>e===document.activeElement),'automatic empty poll restores mode focus');
 report.focusAfterAutomaticRecovery=await page.evaluate(()=>({tag:document.activeElement.tagName,text:document.activeElement.textContent?.slice(0,100)}));
 await snapshot('automaticRecovery');
 // Restore the idle-selection branch, then activate recovery with the keyboard.
 feed.buses=buses;feed.server_eta=wire;await poll();await showSelected.waitFor();
 await showSelected.focus();await page.keyboard.press('Enter');
 const modeButton=page.getByRole('button',{name:'Every route',exact:true});
 assert(await modeButton.evaluate(e=>e===document.activeElement));
 await page.keyboard.press('Tab');
 report.nextTabAfterRecovery=await page.evaluate(()=>({tag:document.activeElement.tagName,label:document.activeElement.getAttribute('aria-label'),text:document.activeElement.textContent?.slice(0,80)}));
 assert.equal(await page.evaluate(()=>localStorage.getItem('mapHiddenRoutes')),saved);
 report.checks.push('Manual hidden-route choices survive reload; keyboard activation restores mode-control focus and subsequent Tab advances into restored cards');
 // Select Red alone, but place its reporting bus well outside the route.
 await page.getByRole('button',{name:'Hide all',exact:true}).click();await page.getByRole('button',{name:'Red',exact:true}).click();
 await page.getByRole('button',{name:'Every route',exact:true}).click();
 feed.buses=buses.map(b=>({...b,lat:41.45,lon:-72.8}));delete feed.server_eta;await poll();
 await showSelected.waitFor();
 report.offRouteEmptyMessage=await body();
 assert.match(report.offRouteEmptyMessage,/Your selected routes are hidden by the Running now filter/);
 assert.match(await page.getByRole('button',{name:'Red',exact:true}).getAttribute('title'),/no on-route bus/);
 await showSelected.focus();feed.buses=buses;feed.server_eta=wire;await poll();await red.waitFor();
 assert.equal(await showSelected.count(),0);
 assert(await page.getByRole('button',{name:'Running now',exact:true}).evaluate(e=>e===document.activeElement),'on-route movement removes recovery with focus preserved');
 feed.buses=buses.map(b=>({...b,lat:41.45,lon:-72.8}));delete feed.server_eta;await poll();await showSelected.waitFor();
 assert(await page.getByRole('button',{name:'Running now',exact:true}).evaluate(e=>e===document.activeElement),'reappearing recovery does not steal focus');
 report.checks.push('Same-fleet off-route/on-route updates remove the focused recovery action safely, and its return preserves focus');
 await showSelected.click();await red.waitFor();
 report.offRouteRecoveredCard=await red.innerText();
 // Runtime loss of storage must not break the newly added recovery action.
 await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('Blocked fixture storage','SecurityError');};});
 await page.getByRole('button',{name:'Hide all',exact:true}).click();
 await page.getByRole('button',{name:'Show all routes',exact:true}).click();await red.waitFor();
 assert(await page.getByRole('button',{name:'Every route',exact:true}).evaluate(e=>e===document.activeElement));
 report.checks.push('Filter recovery works despite storage-write failure');
 assert.deepEqual(report.errors,[]);report.completed=true;
}finally{
 if(!report.completed&&page)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);
 if(page)await page.close();if(ctx)await ctx.close();await browser.close();report.resourcesClosed=true;report.requests=requests;report.failedRequests=failures;
 await fs.writeFile(out+'/review-lifecycle.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify({checks:report.checks,errors:report.errors,completed:report.completed,resourcesClosed:report.resourcesClosed},null,2));
