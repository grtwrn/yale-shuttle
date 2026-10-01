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
const report={checks:[],errors:[],requests:0,completed:false};
const feed=structuredClone(original);
let failure=false,ctx,page;
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try {
 ctx=await browser.newContext({viewport:{width:390,height:844},timezoneId:'America/New_York',serviceWorkers:'block'});
 await seedTestId(ctx);
 await ctx.addInitScript(()=>{
  localStorage.setItem('listView','map');
  window.notifications=[];window.notificationRequests=0;
  Object.defineProperty(window,'Notification',{value:class {
   static permission='default';
   static requestPermission(){
    window.notificationRequests++;
    window.focusAtPermission=document.activeElement?.id;
    return new Promise(resolve=>{window.finishPermission=()=>{this.permission='granted';resolve('granted');};});
   }
   constructor(title,options){window.notifications.push({title,options});} close(){}
  },configurable:true});
 });
 page=await ctx.newPage();page.setDefaultTimeout(8000);
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.clock.install({time:new Date(now)});
 await page.route('**/*',async r=>{
  const u=new URL(r.request().url());if(u.hostname!=='review-alert.test')return r.abort();
  if(u.pathname==='/api/buses'){report.requests++;return failure?r.fulfill({status:503,json:{error:'synthetic'}}):r.fulfill({json:feed});}
  if(u.pathname==='/api/weather')return r.fulfill({status:204});
  if(u.pathname.startsWith('/api/'))return r.fulfill({json:{reports:[],results:[],routes:[]}});
  const f=u.pathname==='/'?'/index.html':u.pathname;
  try{return r.fulfill({body:await fs.readFile(service+'/web/dist'+f),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}
 });
 const focused=l=>l.evaluate(e=>e===document.activeElement);
 const poll=async()=>{await page.clock.runFor(5500);await page.waitForTimeout(100);};
 const red=page.locator('[id="route-card-Red"]');
 const stop=feed.stop_names[48];
 const bell=()=>red.getByRole('button',{name:`Alert me when Red reaches ${stop}`,exact:true});
 const armed=()=>red.getByRole('button',{name:`Cancel the alert for Red at ${stop}`,exact:true});
 const group=()=>red.getByRole('group',{name:`Alert for Red at ${stop}`,exact:true});
 const nav=n=>page.getByRole('navigation',{name:'Main'}).getByRole('button',{name:n,exact:true});
 const openRed=async()=>{await red.waitFor();await page.clock.runFor(400);await red.getByRole('button',{name:'Red',exact:true}).click();await page.clock.runFor(400);};
 await page.goto('https://review-alert.test');await openRed();
 assert.equal(await page.evaluate(()=>window.notificationRequests),0);
 await bell().focus();await page.keyboard.press('Enter');
 const hintId=await group().getAttribute('aria-describedby');
 assert.match(await page.locator('#'+hintId).innerText(),/Your browser will ask/);
 const trigger=await bell().getAttribute('id');
 await group().getByRole('button',{name:'5 min',exact:true}).focus();await page.keyboard.press('Enter');
 await armed().waitFor();assert(await focused(armed()));
 assert.equal(await page.evaluate(()=>window.focusAtPermission),trigger,'focus restored before asynchronous permission begins');
 assert.equal(await page.evaluate(()=>window.notificationRequests),1);
 await nav('issues').focus();await page.keyboard.press('Enter');await page.clock.runFor(400);
 await page.evaluate(()=>window.finishPermission());await poll();assert(await focused(nav('issues')),'permission resolution cannot steal focus after unmount');
 report.checks.push('Default permission copy is truthful; focus reaches same bell before request; delayed granted resolution after leaving Map preserves Issues focus.');
 await nav('map').click();await openRed();assert.equal(await armed().getAttribute('aria-pressed'),'true');
 await page.reload();await openRed();assert.equal(await armed().getAttribute('aria-pressed'),'true');
 assert.equal(await page.evaluate(()=>window.notificationRequests),0,'reload does not prompt again');
 assert.equal(await group().count(),0,'setup is transient across reload');
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle.stopAlerts'))[0].leadMin),5);
 await page.evaluate(()=>{Notification.permission='granted';});
 report.checks.push('Armed stop/lead persists through actual reload; transient chooser does not, and reload never requests permission.');
 // Put a real eligible first occurrence inside the threshold BEFORE making it stale.
 // A later same-bus visit stays far away; both bus identities remain in the feed.
 const wire=feed.server_eta;
 const near=wire.rows.find(r=>r[0]===0&&r[1]===48);
 near[2]=120;near[3]=60;near[4]=180;wire.rows.sort((a,b)=>a[2]-b[2]);
 wire.servedAt=wire.at+60000;await poll();
 assert.equal(await page.evaluate(()=>window.notifications.length),0,'eligible stale forecast must not fire');
 assert.equal(await page.getByTitle('Dismiss',{exact:true}).count(),0);
 assert.equal(await armed().getAttribute('aria-pressed'),'true');
 await armed().focus();await poll();assert(await focused(armed()),'stale poll keeps armed bell focus');
 delete feed.server_eta;await poll();assert.equal(await page.evaluate(()=>window.notifications.length),0);
 failure=true;await poll();assert.equal(await page.evaluate(()=>window.notifications.length),0);
 failure=false;const buses=feed.buses;feed.buses=[];feed.server_eta=wire;wire.servedAt=wire.at;await poll();
 assert.equal(await page.evaluate(()=>window.notifications.length),0,'empty fleet with wire rows cannot fire');
 assert.equal(await armed().getAttribute('aria-pressed'),'true');
 feed.buses=buses;await poll();
 assert.equal(await page.evaluate(()=>window.notifications.length),1,'fresh same forecast must now fire');
 assert.match(await page.evaluate(()=>window.notifications[0].options.body),/Red reaches Division \/ Prospect/);
 const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle.stopAlerts')));
 assert.equal(stored[0].fired.busName,'307');
 assert.equal(stored[0].fired.lead,true);assert.equal(stored[0].fired.arrival,false);
 await poll();assert.equal(await page.evaluate(()=>window.notifications.length),1,'ordinary poll does not repeat lead');
 report.checks.push('Already-eligible stale, missing, failed and empty-fleet inputs do not fire; fresh recovery fires once for first occurrence #307 and persists that identity.');
 await armed().focus();near[2]=20;near[3]=0;near[4]=60;await poll();
 assert.equal(await page.evaluate(()=>window.notifications.length),2);
 await bell().waitFor();assert(await focused(bell()),'automatic arrival disarm keeps same button node focus');
 assert.equal(await bell().getAttribute('aria-pressed'),'false');
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle.stopAlerts'))),[]);
 report.checks.push('Arrival threshold disarms automatically without losing focus on the same bell.');
 // Runtime storage failure is independent of browser notification capability.
 for(const row of wire.rows)if(row[0]===0&&row[1]===48){row[2]+=1800;row[3]+=1800;row[4]+=1800;}
 wire.rows.sort((a,b)=>a[2]-b[2]);await poll();
 await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('blocked','SecurityError');};});
 await bell().focus();await page.keyboard.press('Space');await group().getByRole('button',{name:'1 min',exact:true}).focus();await page.keyboard.press('Enter');
 await armed().waitFor();assert(await focused(armed()));
 await page.keyboard.press('Space');await bell().waitFor();assert(await focused(bell()));
 await page.keyboard.press('Enter');await group().getByRole('button',{name:'Cancel alert setup',exact:true}).focus();await page.keyboard.press('Enter');assert(await focused(bell()));
 const ids=await page.locator('[id^="stop-alert-chooser-"]').evaluateAll(es=>es.map(e=>e.id));
 assert.equal(new Set(ids).size,ids.length,'unique controls and group IDs');
 report.checks.push('Storage-write failure still permits in-page arm/disarm/cancel with correct bell focus; IDs are unique.');
 assert.deepEqual(report.errors,[]);report.completed=true;
} finally {
 if(page&&!report.completed)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);
 if(page)await page.close();if(ctx)await ctx.close();await browser.close();report.resourcesClosed=true;
 await fs.writeFile(out+'/lifecycle.json',JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report,null,2));
