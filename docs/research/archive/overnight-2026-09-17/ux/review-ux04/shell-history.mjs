import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const service = process.cwd(), out = '/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux04';
const { chromium } = createRequire(service + '/package.json')('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const now = Date.parse('2026-09-17T14:00:00-04:00');
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s=>[s.id,s.name]));
const seq = feed.routes['3'], start = seq.indexOf(48), previous = (start + seq.length - 1) % seq.length;
feed.buses = ['307','309'].map((bus_name,i)=>({bus_name, bus_id:i+1, route_id:3,...feed.stop_coords[seq[previous]],last_stop_id:seq[previous],heading:180,observed_at:now}));
const rows=[];
for(let i=0;i<2;i++) for(let h=0;h<seq.length*2;h++) {
 const eta=300+i*900+h*90;
 rows.push([i,seq[(start+h)%seq.length],eta,eta-120,eta+240,h+1,0,eta-120,eta-120]);
}
feed.server_eta={v:2,at:now,servedAt:now,buses:['307','309'].map(b=>[b,'Red',previous,null]),rows,distributions:rows.map(r=>Array.from({length:50},(_,i)=>r[2]-120+i*360/49))};
function history(query) {
 const stop=Number(query.stop), trips=Array.from({length:8},(_,i)=>{
  const startedAt=Date.parse(i<4?'2026-09-16T00:05:00-04:00':'2026-09-17T00:05:00-04:00')+i*60000;
  const actualSec=[30,120,300,600,900,1200,1800,3600][i];
  return {busName:String(500+i),startedAt,departedAt:startedAt,arrivedAt:startedAt+actualSec*1000,actualSec};
 });
 return {asOf:now,days:30,journey:{fromStopId:seq[previous],fromName:feed.stop_names[seq[previous]],toStopId:stop,toName:feed.stop_names[stop],mode:'departure',elapsedSec:null,trips,serviceDates:2},recent:[]};
}
const report={scope:'Unmodified built SPA, fabricated live wire/history; device timezone Pacific/Honolulu',checks:[],requests:[],errors:[]};
let pending=false,offline=false;const releases=[];
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
let ctx,page;
try {
 ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Pacific/Honolulu',serviceWorkers:'block'});
 await seedTestId(ctx);
 await ctx.addInitScript(({now,fromLL,toLL,fromName,toName})=>sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:fromName,fromLL,toText:toName,toLL,tripTime:'',expandedKey:null,savedAt:now})),{now,fromLL:feed.stop_coords[48],toLL:feed.stop_coords[121],fromName:feed.stop_names[48],toName:feed.stop_names[121]});
 page=await ctx.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.clock.install({time:new Date(now)});
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.hostname!=='review-history.test')return route.abort();
  if(u.pathname==='/api/buses')return route.fulfill({json:feed});
  if(u.pathname==='/api/weather')return route.fulfill({status:204});
  if(u.pathname==='/api/journey-history') {
   const query=Object.fromEntries(u.searchParams);report.requests.push(query);
   const body=history(query),fail=offline;
   if(pending)await new Promise(r=>releases.push(r));
   return fail?route.abort('internetdisconnected'):route.fulfill({json:body});
  }
  if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[],routes:[]}});
  const f=u.pathname==='/'?'/index.html':u.pathname;
  try{return route.fulfill({body:await fs.readFile(service+'/web/dist'+f),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404});}
 });
 await page.goto('https://review-history.test',{waitUntil:'domcontentloaded'});
 const trigger=page.getByRole('button',{name:/Red arrival details/}).first();await trigger.waitFor();
 assert.equal(report.requests.length,0,'no history request before details open');
 await trigger.focus();await page.keyboard.press('Enter');
 const dialog=page.getByRole('dialog',{name:'Red arrival',exact:true});
 const hist=dialog.getByRole('region',{name:'Recorded arrival history'});await hist.getByRole('img').waitFor();
 assert.equal(report.requests.length,1);assert.equal(report.requests[0].route,'Red');assert.equal(report.requests[0].bus,'307');assert.equal(report.requests[0].limit,'100');
 assert.match(await dialog.innerText(),/Following shuttle · #309/);
 assert.match(await hist.innerText(),/2 dates · Sep 16 – Sep 17/);
 assert.match(await hist.innerText(),/Comparison captured Sep 17, 8:00 AM/);
 const table=hist.locator('summary').filter({hasText:'Dates and recorded times'});
 await table.focus();await page.keyboard.press('Space');
 const tableText=await hist.getByRole('table').innerText();assert.match(tableText,/Sep 15/);assert.match(tableText,/Sep 16/);assert.match(tableText,/60 min/);assert.match(tableText,/<1 min/);
 const about=hist.locator('summary').filter({hasText:'About these records'});await about.focus();await page.keyboard.press('Enter');
 assert.match(await hist.innerText(),/date range uses trip starts in New Haven/);assert.match(await hist.innerText(),/device’s local time/);
 report.checks.push('Actual trip-card opens pickup history lazily with Red/#307 identity, #309 following shuttle and limit 100. New Haven date range differs correctly from Honolulu table/capture time. All 8 observations including <1 and 60 min retained.');
 await hist.evaluate(e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:out+'/shell-history-honolulu-corrected-390.png'});
 const refresh=hist.getByRole('button',{name:'Refresh comparison',exact:true});
 pending=true;await refresh.focus();await page.keyboard.press('Space');await hist.getByRole('status').waitFor();
 const busy=hist.getByRole('button',{name:'Refreshing comparison…'});assert(await busy.evaluate(e=>e===document.activeElement));
 const n=report.requests.length;await page.keyboard.press('Space');await page.waitForTimeout(30);assert.equal(report.requests.length,n);
 const close=dialog.getByRole('button',{name:'Close arrival details'});await close.focus();
 pending=false;releases.splice(0).forEach(r=>r());await hist.getByRole('img').waitFor();assert(await close.evaluate(e=>e===document.activeElement),'completion must not steal moved focus');
 offline=true;await refresh.focus();await page.keyboard.press('Enter');await hist.getByRole('alert').waitFor();assert(await refresh.evaluate(e=>e===document.activeElement));assert.match(await dialog.innerText(),/Following shuttle · #309/);
 offline=false;await refresh.press('Enter');await hist.getByRole('img').waitFor();assert(await refresh.evaluate(e=>e===document.activeElement));
 await page.keyboard.press('Escape');assert(await trigger.evaluate(e=>e===document.activeElement));
 report.checks.push('Space refresh keeps focus, ignores repeated activation, does not steal focus after it moves to Close; network-disconnected retry recovers, keeps both arrivals and Escape returns to real card trigger.');
 const arrive=page.getByRole('button',{name:/^Arrive by…/});await arrive.click();
 const disclosure=page.locator('summary').filter({hasText:'See Red arrival times'});await disclosure.waitFor();
 const before=report.requests.length;await disclosure.focus();await page.keyboard.press('Enter');
 const inline=page.getByRole('region',{name:'Recorded arrival history'});await inline.getByRole('img').waitFor();assert.equal(report.requests.length,before+1);
 assert.match(await page.getByRole('region',{name:'Arrive by class'}).innerText(),/before your final walk/);
 assert.notEqual(report.requests.at(-1).stop,report.requests[0].stop,'destination history should use destination occurrence');
 assert.equal(report.requests.at(-1).bus,'307');
 pending=true;const inlineRefresh=inline.getByRole('button',{name:'Refresh comparison',exact:true});await inlineRefresh.focus();await page.keyboard.press('Enter');await inline.getByRole('status').waitFor();
 assert(await inline.getByRole('button',{name:'Refreshing comparison…'}).evaluate(e=>e===document.activeElement));
 await disclosure.focus();await page.keyboard.press('Space');pending=false;releases.splice(0).forEach(r=>r());await page.waitForTimeout(50);assert.equal(await page.getByRole('region',{name:'Recorded arrival history'}).count(),0);
 assert(await disclosure.evaluate(e=>e===document.activeElement));
 await page.keyboard.press('Space');await inline.getByRole('img').waitFor();
 for(const width of [360,390,430,1280,640]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'full SPA overflow '+width);}
 report.checks.push('Destination disclosure uses actual selected alight stop/#307, labels final-walk exclusion, preserves refresh focus outside modal, aborts on close and reloads on reopen; full SPA 360/390/430/1280/640px reflow.');
 assert.deepEqual(report.errors,[]);report.completed=true;
}finally {
 releases.splice(0).forEach(r=>r());
 if(!report.completed&&page)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);
 if(page)await page.close();if(ctx)await ctx.close();await browser.close();report.resourcesClosed=true;
 await fs.writeFile(out+'/shell-history.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
