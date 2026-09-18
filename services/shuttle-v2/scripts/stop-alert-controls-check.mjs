/** Bounded built-SPA keyboard/permission regression. All requests intercepted.
 * Run from shuttle-v2 under heavy.lock after building, with OUT=/fresh/path.
 * BASELINE=1 DIST=/frozen/dist records the original focus failures.
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
const original = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
original.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s=>[s.id,s.name]));
const seq=original.routes['3'], start=seq.indexOf(48), previous=(start+seq.length-1)%seq.length;
original.buses=['307','309'].map((bus_name,i)=>({bus_name,bus_id:i+1,route_id:3,...original.stop_coords[seq[previous]],last_stop_id:seq[previous],heading:180,observed_at:now}));
const rows=[];
for(let i=0;i<2;i++)for(let h=0;h<seq.length*2;h++){
 const eta=600+i*900+h*90;rows.push([i,seq[(start+h)%seq.length],eta,eta-120,eta+240,h+1,0,eta-120,eta-120]);
}
rows.sort((a,b)=>a[2]-b[2]);
original.server_eta={v:2,at:now,servedAt:now,buses:['307','309'].map(b=>[b,'Red',previous,null]),rows};
const report={scope:'Actual built SPA with synthetic two-bus feed and mocked Notification API; no native notification/accuracy claim',states:[],errors:[]};
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
let ctx,page;
try {
 for(const permission of (process.env.BASELINE?['denied']:['denied','unsupported','default','granted'])) {
  const feed=structuredClone(original);let fail=false;
  const state={permission,checks:[]};report.states.push(state);
  ctx=await browser.newContext({viewport:{width:process.env.DESKTOP?1280:390,height:844},isMobile:!process.env.DESKTOP,hasTouch:!process.env.DESKTOP,timezoneId:'America/New_York',serviceWorkers:'block'});
  await seedTestId(ctx);
  await ctx.addInitScript(({permission})=>{
   localStorage.setItem('listView','map');
   window.notificationRequests=0;window.notifications=[];
   if(permission==='unsupported')Object.defineProperty(window,'Notification',{value:undefined,configurable:true});
   else Object.defineProperty(window,'Notification',{value:class {
    static permission=permission;
    static async requestPermission(){window.notificationRequests++;this.permission='denied';return 'denied';}
    constructor(title,options){window.notifications.push({title,options});} close(){}
   },configurable:true});
  },{permission});
  page=await ctx.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));await page.clock.install({time:new Date(now)});
  await page.route('**/*',async r=>{
   const u=new URL(r.request().url());if(u.hostname!=='alert-controls.test')return r.abort();
   if(u.pathname==='/api/buses')return fail?r.fulfill({status:503,json:{error:'fixture'}}):r.fulfill({json:feed});
   if(u.pathname==='/api/weather')return r.fulfill({status:204});
   if(u.pathname.startsWith('/api/'))return r.fulfill({json:{reports:[],results:[],routes:[]}});
   const f=u.pathname==='/'?'/index.html':u.pathname;
   try{return r.fulfill({body:await fs.readFile((process.env.DIST||service+'/web/dist')+f),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}
  });
  const focused=locator=>locator.evaluate(e=>e===document.activeElement);
  const poll=async()=>{await page.clock.runFor(5500);await page.waitForTimeout(100);};
  await page.goto('https://alert-controls.test');
  const red=page.locator('[id="route-card-Red"]');await red.waitFor();await page.clock.runFor(400);
  await red.getByRole('button',{name:'Red',exact:true}).click();await page.clock.runFor(400);
  const stop=feed.stop_names[48];
  const bell=()=>red.getByRole('button',{name:`Alert me when Red reaches ${stop}`,exact:true});
  const armed=()=>red.getByRole('button',{name:`Cancel the alert for Red at ${stop}`,exact:true});
  const choice=()=>red.getByRole('button',{name:'3 min',exact:true});
  await bell().focus();await page.keyboard.press('Enter');await choice().waitFor();
  state.expanded=await bell().getAttribute('aria-expanded');
  assert.equal(await page.evaluate(()=>window.notificationRequests),0,'no permission prompt on open');
  await page.keyboard.press('Tab');assert(await focused(red.getByRole('button',{name:'1 min',exact:true})),'Tab enters choices');
  await choice().focus();await page.keyboard.press('Escape');
  state.escapeClosed=await choice().count()===0;state.escapeFocus=await focused(bell());
  if(!state.escapeClosed)await red.getByRole('button',{name:'Cancel',exact:true}).click();
  await bell().focus();await page.keyboard.press('Enter');
  const cancel=red.getByRole('button',{name:process.env.BASELINE?'Cancel':'Cancel alert setup',exact:true});
  await cancel.focus();await page.keyboard.press('Enter');state.cancelFocus=await focused(bell());
  await bell().focus();await page.keyboard.press('Space');await choice().focus();await page.keyboard.press('Enter');
  await armed().waitFor();state.armFocus=await focused(armed());
  state.stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle.stopAlerts')));
  assert.equal(state.stored.length,1);assert.equal(state.stored[0].stopId,48);assert.equal(state.stored[0].leadMin,3);
  if(process.env.BASELINE){await page.screenshot({path:out+'/baseline-armed.png'});continue;}
  assert.equal(state.expanded,'true');assert(state.escapeClosed&&state.escapeFocus&&state.cancelFocus&&state.armFocus,'chooser closes to its own bell');
  assert.equal(await page.evaluate(()=>window.notificationRequests),permission==='default'?1:0);
  assert.equal(await armed().getAttribute('aria-pressed'),'true');
  await armed().focus();await page.keyboard.press('Space');await bell().waitFor();assert(await focused(bell()));
  await bell().focus();await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');assert.equal(await choice().count(),0);assert(await focused(bell()),'Escape also closes from the opening bell');
  await page.keyboard.press('Enter');
  const group=red.getByRole('group',{name:`Alert for Red at ${stop}`,exact:true});await group.waitFor();
  assert.match(await group.innerText(),permission==='granted'?/Works while this app is open/:/Notifications are off/);
  assert.equal(await bell().getAttribute('aria-controls'),await group.getAttribute('id'));
  for(const width of (process.env.DESKTOP?[1280,640]:[360,390,430])){
   await page.setViewportSize({width,height:844});await page.clock.runFor(60);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page reflow '+width);
   for(const b of await group.getByRole('button').all()){const box=await b.boundingBox();assert(box.width>=44&&box.height>=44,'44px chooser target');}
  }
  if(permission==='denied'){await group.scrollIntoViewIfNeeded();await page.screenshot({path:out+'/chooser.png'});}
  // Switching stops closes the old disclosure and restores to the new bell,
  // never the first stop's trigger. Neither cancel nor Escape arms an alert.
  const secondStop=feed.stop_names[seq[(start+1)%seq.length]];
  const secondBell=red.getByRole('button',{name:`Alert me when Red reaches ${secondStop}`,exact:true});
  await secondBell.focus();await page.keyboard.press('Enter');
  assert.equal(await group.count(),0);assert.equal(await bell().getAttribute('aria-expanded'),'false');
  const secondGroup=red.getByRole('group',{name:`Alert for Red at ${secondStop}`,exact:true});
  await secondGroup.getByRole('button',{name:'Cancel alert setup',exact:true}).focus();await page.keyboard.press('Space');
  assert(await focused(secondBell));
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle.stopAlerts'))),[]);
  await bell().focus();await page.keyboard.press('Enter');await choice().focus();await poll();
  assert(await focused(choice()),'ordinary poll preserves focus within chooser');
  // A user can leave the disclosure without being trapped; polling and tab
  // navigation must not move external focus back into the card.
  const issues=page.getByRole('navigation',{name:'Main'}).getByRole('button',{name:'issues',exact:true});
  await issues.focus();await poll();assert(await focused(issues),'poll preserves external focus');
  await page.keyboard.press('Enter');await page.clock.runFor(400);assert(await focused(issues),'unmount preserves navigation focus');
  await page.getByRole('navigation',{name:'Main'}).getByRole('button',{name:'map',exact:true}).click();await page.clock.runFor(400);
  await red.getByRole('button',{name:'Red',exact:true}).click();await page.clock.runFor(400);
  assert.equal(await choice().count(),0,'navigation closes transient chooser');
  await bell().focus();await page.keyboard.press('Enter');
  if(!process.env.DESKTOP)await choice().tap();else await choice().click();await armed().waitFor();
  state.checks.push('Enter/Space/Tab/Escape, cancel/arm/disarm focus, group and disclosure semantics, 44px targets, phone/desktop reflow, navigation and polling ownership');
  // Alerts survive leaving Map; unavailable forecasts do not fire them.
  await page.clock.runFor(400);await page.getByRole('navigation',{name:'Main'}).getByRole('button',{name:'trip',exact:true}).click();await page.clock.runFor(400);
  const wire=feed.server_eta;wire.servedAt=wire.at+60000;await poll();
  assert.equal(await page.evaluate(()=>window.notifications.length),0,'stale forecast cannot fire');
  wire.servedAt=wire.at;delete feed.server_eta;await poll();
  assert.equal(await page.evaluate(()=>window.notifications.length),0);
  assert.equal(await page.getByTitle('Dismiss',{exact:true}).count(),0);
  fail=true;await poll();assert.equal(await page.evaluate(()=>window.notifications.length),0);
  fail=false;const buses=feed.buses;feed.buses=[];await poll();
  assert.equal(await page.evaluate(()=>window.notifications.length),0,'empty fleet cannot fire');
  assert.equal(await page.getByTitle('Dismiss',{exact:true}).count(),0);
  feed.buses=buses;feed.server_eta=wire;
  for(const row of wire.rows)if(row[0]===0&&row[1]===48){row[2]=120;row[3]=60;row[4]=180;}
  wire.rows.sort((a,b)=>a[2]-b[2]);await poll();
  if(permission==='granted')assert.equal(await page.evaluate(()=>window.notifications.length),1);
  else {const banner=page.getByTitle('Dismiss',{exact:true});await banner.waitFor();assert((await banner.innerText()).includes(stop));assert.match(await banner.innerText(),/Red/);}
  state.checks.push('Armed state survives tab changes; stale/missing/failed forecasts and empty fleet do not fire; recovered live threshold uses OS or in-app fallback for all four permission states');
  assert.deepEqual(report.errors,[]);
  await page.close();page=null;await ctx.close();ctx=null;
 }
 report.completed=true;
} finally {
 if(!report.completed&&page)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);
 if(page)await page.close();if(ctx)await ctx.close();await browser.close();report.resourcesClosed=true;
 await fs.writeFile(out+'/stop-alert-controls.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
