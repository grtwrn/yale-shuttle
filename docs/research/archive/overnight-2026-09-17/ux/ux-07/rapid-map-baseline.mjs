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
  try{return r.fulfill({body:await fs.readFile('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-07/baseline-dist'+f),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}
 });

 mode='ready';feed.buses=buses;feed.server_eta=wire;
 await page.goto('https://empty-state.test',{waitUntil:'domcontentloaded'});
 const nav=name=>page.getByRole('navigation',{name:'Main'}).getByRole('button',{name,exact:true});
 await nav('map').click();await page.clock.runFor(400);await page.waitForTimeout(80);
 await page.getByRole('button',{name:'Hide all',exact:true}).click();
 await page.getByRole('button',{name:'Blue Day',exact:true}).click();
 await page.getByRole('button',{name:'Running now',exact:true}).click();
 await nav('trip').click();await nav('map').click();
 try {await page.clock.runFor(5500);report.reproduced=false;} catch(e) {report.reproduced=String(e).includes('_leaflet_pos');report.timerError=String(e);if(!report.reproduced)throw e;}
 report.completed=true;
} finally {if(page)await page.close();if(ctx)await ctx.close();await browser.close();report.resourcesClosed=true;await fs.writeFile(out+'/rapid-map-baseline.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
