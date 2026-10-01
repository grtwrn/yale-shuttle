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
 await page.getByText('Loading shuttle information…',{exact:true}).waitFor();await snapshot('loading');
 await nav('map').focus();await page.keyboard.press('Enter');await page.getByText('Loading shuttle information…',{exact:true}).waitFor();await snapshot('loadingMap');await switchView('trip');
 mode='fail';for(const r of pending)await r.fulfill({status:503,json:{error:'fixture'}});pending=[];
 await page.getByText('Live shuttle status unavailable',{exact:true}).waitFor();await snapshot('firstFailure');
 assert.match(await body(),/Choose a destination to check walking directions/);await reflow();await page.screenshot({path:out+'/unavailable-trip.png'});
 await switchView('map');await page.getByText('Route maps will appear when updates reconnect.',{exact:true}).waitFor();await snapshot('firstFailureMap');
 report.checks.push('Pending and failed first load are distinct in Trip/Map; no false empty-service claim; destination actions and reflow available');
 mode='ready';await poll();await red.waitFor();await page.getByText('No shuttles reporting right now. Showing selected routes and schedules.',{exact:true}).waitFor();
 assert.match(await red.innerText(),/no buses reporting/);assert.doesNotMatch(await red.innerText(),/unavailable/);await snapshot('freshEmptyMap');
 assert.equal(await page.getByText('Last received notice:',{exact:true}).count(),0);
 // Last known empty fleet becomes unknown on a failed poll, with schedules retained.
 mode='fail';await poll();assert.match(await red.innerText(),/Live count unavailable/);assert.match(await red.innerText(),/live arrivals unavailable/);assert.doesNotMatch(await red.innerText(),/no buses reporting|not running today/);
 await page.getByText('Last received notice:',{exact:true}).waitFor();await snapshot('emptyThenFailure');
 const thumb=red.getByRole('img');if(await thumb.count())assert.match(await thumb.getAttribute('aria-label'),/live bus positions unavailable/);
 await switchView('trip');await page.getByText('Live shuttle status unavailable',{exact:true}).waitFor();
 mode='ready';await poll();await page.getByText('No shuttles reporting right now',{exact:true}).waitFor();
 report.checks.push('Fresh empty response says reporting, then failed polling replaces zero counts/off-service labels with unavailable; cached notice qualified; successful empty recovery clears warning');
 // Two real fixture bus identities and both visits return, then lose ETA independently.
 feed.buses=buses;feed.server_eta=wire;await poll();await page.getByText('🚌 2 shuttles reporting on 1 route',{exact:true}).waitFor();
 await switchView('map');await red.waitFor();assert.match(await red.innerText(),/2.*bus/);
 await page.getByRole('button',{name:'Hide all',exact:true}).focus();await page.keyboard.press('Enter');
 const showAll=page.getByRole('button',{name:'Show all routes',exact:true});await showAll.waitFor();assert.equal(await page.locator('[id^="route-card-"]').count(),0);assert.equal(await page.locator('.leaflet-container').count(),1);
 assert.equal(await page.getByText('All routes are hidden. Choose a route above or show all.',{exact:true}).count(),1);
 await reflow();await showAll.focus();await page.keyboard.press('Space');await red.waitFor();
 const modeButton=page.getByRole('button',{name:/^(Running now|Every route)$/});assert(await modeButton.evaluate(e=>e===document.activeElement));assert.equal(await modeButton.getAttribute('aria-pressed'),'false');assert(await page.locator('[id^="route-card-"]').count()>1,'Show all routes also clears Running now');await modeButton.click();assert.equal(await modeButton.getAttribute('aria-pressed'),'true');
 // Only an idle route is selected; recovery must show it without un-hiding Red.
 await page.getByRole('button',{name:'Hide all',exact:true}).click();await page.getByRole('button',{name:'Blue Day',exact:true}).click();
 const showSelected=page.getByRole('button',{name:'Show selected routes',exact:true});await showSelected.waitFor();assert.match(await body(),/Your selected routes are hidden by the Running now filter/);
 const saved=await page.evaluate(()=>localStorage.getItem('mapHiddenRoutes'));
 mode='fail';await poll();assert.match(await body(),/Your selected routes are hidden by the Running now filter. Live status is unavailable/);
 for(const button of [showSelected,modeButton]){const b=await button.boundingBox();assert(b.width>=44&&b.height>=44);}
 await reflow();await page.screenshot({path:out+'/selected-route-recovery.png'});
 await showSelected.focus();if(process.env.DESKTOP)await page.keyboard.press('Enter');else await showSelected.tap();
 const every=page.getByRole('button',{name:'Every route',exact:true});assert(await every.evaluate(e=>e===document.activeElement));assert.equal(await every.getAttribute('aria-pressed'),'false');
 assert.equal(await page.evaluate(()=>localStorage.getItem('mapHiddenRoutes')),saved);assert.equal(await red.count(),0);await page.locator('[id="route-card-Blue Day"]').waitFor();
 await switchView('trip');await switchView('map');assert.equal(await red.count(),0);await page.locator('[id="route-card-Blue Day"]').waitFor();
 report.checks.push('All-hidden keeps basemap with one message; keyboard Show all recovers; selected-idle recovery works by keyboard/touch, retains manual route choices, returns focus to persistent 44px mode control and survives tab changes');
 // Polling can remove recovery without a click. Preserve focus only when the
 // removed action owns it; ordinary updates and an outgoing view must not move it.
 mode='ready';await poll();await modeButton.click();await showSelected.waitFor();
 await showSelected.focus();await poll();
 assert(await showSelected.evaluate(e=>e===document.activeElement),'ordinary poll keeps recovery focus');
 feed.buses=[];delete feed.server_eta;await poll();
 await page.locator('[id="route-card-Blue Day"]').waitFor();assert.equal(await showSelected.count(),0);
 assert(await modeButton.evaluate(e=>e===document.activeElement),'empty poll returns removed recovery focus to mode');
 assert.equal(await modeButton.getAttribute('aria-pressed'),'true','empty fallback preserves Running now choice');
 assert.equal(await page.evaluate(()=>localStorage.getItem('mapHiddenRoutes')),saved);
 feed.buses=buses;feed.server_eta=wire;await poll();await showSelected.waitFor();
 assert(await modeButton.evaluate(e=>e===document.activeElement),'recovery appearing does not take focus');
 await nav('issues').focus();feed.buses=[];delete feed.server_eta;await poll();
 await page.locator('[id="route-card-Blue Day"]').waitFor();
 assert(await nav('issues').evaluate(e=>e===document.activeElement),'automatic recovery preserves external focus');
 feed.buses=buses;feed.server_eta=wire;await poll();await showSelected.waitFor();
 await modeButton.evaluate(e=>{window.__outgoingModeFocus=0;e.addEventListener('focus',()=>window.__outgoingModeFocus++);});
 await showSelected.focus();
 // A programmatic navigation leaves the departing action focused, exercising
 // unmount itself rather than relying on the navigation click taking focus.
 await page.clock.runFor(400);await nav('trip').evaluate(e=>e.click());await page.clock.runFor(400);
 assert.equal(await nav('trip').getAttribute('aria-current'),'page');
 assert.equal(await modeButton.count(),0);assert.equal(await page.evaluate(()=>window.__outgoingModeFocus),0,'do not focus the outgoing map mode');
 await switchView('map');await showSelected.waitFor();await showSelected.focus();
 const blueStop=feed.routes['1'][0];
 feed.buses=[...buses,{bus_name:'310',bus_id:3,route_id:1,...feed.stop_coords[blueStop],last_stop_id:blueStop,heading:180,observed_at:now}];delete feed.server_eta;
 await poll();await page.locator('[id="route-card-Blue Day"]').waitFor();
 assert.equal(await showSelected.count(),0);assert(await modeButton.evaluate(e=>e===document.activeElement),'a newly running selection restores focus to the remounted mode');
 assert.equal(await red.count(),0,'automatic recovery retains manually hidden Red');
 report.checks.push('Ordinary polls preserve recovery focus; empty-fleet and newly running selection remove it with guarded mode focus; external focus and outgoing navigation are preserved, including after Map remount');
 // Valid current positions can be off route without being absent. Running now
 // still hides them; Every route must retain their correct counts and warning.
 feed.buses=buses.map(b=>({...b,lat:41.45,lon:-72.8}));delete feed.server_eta;
 await page.getByRole('button',{name:'Hide all',exact:true}).click();await page.getByRole('button',{name:'Red',exact:true}).click();
 await poll();await showSelected.waitFor();await snapshot('offRouteFiltered');
 assert.match(await body(),/Your selected routes are hidden by the Running now filter/);
 assert.doesNotMatch(await body(),/No buses are reporting on your selected routes/);
 const redTitle=await page.getByRole('button',{name:'Red',exact:true}).getAttribute('title');
 assert.match(redTitle,/no on-route bus/);assert.doesNotMatch(redTitle,/has no bus in the last update/);
 report.snapshots.offRouteChipTitle=redTitle;
 await reflow();await page.screenshot({path:out+'/off-route-filtered.png'});
 await showSelected.focus();await page.keyboard.press('Enter');await red.waitFor();
 const offRouteCard=await red.innerText();report.snapshots.offRouteRecovered=offRouteCard;
 assert.match(offRouteCard,/2\/2 buses/);assert.match(offRouteCard,/2 buses off route/);
 assert(await modeButton.evaluate(e=>e===document.activeElement));
 report.checks.push('Fresh off-route reports are described as filtered, with an on-route chip explanation; recovery retains both reported buses and their off-route warning without fabricated forecasts');
 // Restore selection, then prove forecast absence and expiry cannot imply no service.
 await page.getByRole('button',{name:'Hide all',exact:true}).click();await page.getByRole('button',{name:'Show all routes',exact:true}).click();
 mode='ready';feed.buses=buses;delete feed.server_eta;await poll();await red.waitFor();assert.match(await red.innerText(),/live arrivals unavailable/);assert.doesNotMatch(await red.innerText(),/no buses reporting|Live count unavailable/);assert.match(await red.innerText(),/2.*bus/);await snapshot('missingForecast');
 feed.server_eta=wire;wire.servedAt=wire.at+60000;await poll();assert.match(await red.innerText(),/live arrivals unavailable/);await snapshot('staleForecast');
 wire.servedAt=wire.at;await poll();assert.doesNotMatch(await red.innerText(),/live arrivals unavailable/);
 mode='malformed';await poll();assert.match(await red.innerText(),/Live count unavailable/);mode='fail';for(let i=0;i<9;i++)await poll();assert.match(await red.innerText(),/live arrivals unavailable/);await snapshot('expiredRetainedFleet');
 mode='ready';await poll();assert.doesNotMatch(await red.innerText(),/Live count unavailable|live arrivals unavailable/);
 report.checks.push('Missing/stale ETA, malformed payload and failed polls beyond45sec retain routes without a false no-bus claim; fresh recovery restores arrivals');
 // Plan remains useful with no buses and failed feed: schedule context plus walking.
 feed.buses=[];delete feed.server_eta;
 const draft={fromText:feed.stop_names[48],fromLL:feed.stop_coords[48],toText:'Union Station — long fixture destination name',toLL:feed.stop_coords[121],tripTime:'',expandedKey:null,savedAt:now};
 await page.evaluate(draft=>{localStorage.setItem('listView','trip');sessionStorage.setItem('shuttle-trip-draft',JSON.stringify(draft));},draft);
 await page.reload({waitUntil:'domcontentloaded'});await page.getByText(/Shuttles that go there/).waitFor();mode='fail';await poll();await page.getByText('Shuttle routes for this trip — live status unavailable',{exact:true}).waitFor();
 const fallback=await body();assert.match(fallback,/Schedule:/);assert.match(fallback,/Walk/);assert.doesNotMatch(fallback,/Should be running now|Not running now|Not running today|Not this weekend/);await snapshot('walkFallbackUnavailable');await reflow();
 mode='ready';await poll();await page.getByText(/Shuttles that go there/).waitFor();
 // Actual pickup dialog still offers both distinct future buses after recovery.
 feed.buses=buses;feed.server_eta=wire;await poll();
 const arrival=page.getByRole('button',{name:/Red arrival details/}).first();await arrival.waitFor();await arrival.focus();await page.keyboard.press('Enter');
 const dialog=page.getByRole('dialog',{name:'Red arrival',exact:true});await dialog.waitFor();assert.match(await dialog.innerText(),/#307/);assert.match(await dialog.innerText(),/Following shuttle · #309/);await page.keyboard.press('Escape');
 report.checks.push('Unavailable walk-only plan keeps schedule and walking context without inferred service-off labels; recovery retains both #307/#309 pickup slots and keyboard dialog');
 // Empty response at overnight clock still reports observation, not an outage.
 feed.buses=[];delete feed.server_eta;await page.clock.setSystemTime(new Date('2026-09-18T03:00:00-04:00'));await poll();await switchView('map');await page.getByText('No shuttles reporting right now. Showing selected routes and schedules.',{exact:true}).waitFor();await red.waitFor();await snapshot('offHoursEmpty');assert.doesNotMatch(await red.innerText(),/Live count unavailable/);await reflow();await page.screenshot({path:out+'/off-hours-map.png'});
 report.checks.push('Off-hours successful empty feed retains maps/schedules and is not called a feed failure');
 assert.deepEqual(report.errors,[]);report.completed=true;
}finally{
 if(!report.completed&&page)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);
 if(page)await page.close();if(ctx)await ctx.close();await browser.close();report.resourcesClosed=true;report.requests=requests;report.failedRequests=failures;
 await fs.writeFile(out+'/empty-service.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify({checks:report.checks,errors:report.errors,completed:report.completed,resourcesClosed:report.resourcesClosed},null,2));
