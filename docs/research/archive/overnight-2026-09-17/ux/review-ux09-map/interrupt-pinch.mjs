/** Real-clock built-SPA zoom/unmount regression. From shuttle-v2 under heavy.lock:
 * OUT=/fresh/evidence node scripts/map-lifecycle-check.mjs
 * DESKTOP=1, SCENARIOS=ride and DIST_ROOT=/frozen/build are optional.
 * All network intercepted, tester identity seeded, all resources closed.
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.cwd() + '/package.json')('playwright-core');
const { seedTestId } = await import(process.cwd() + '/scripts/testId.mjs');
const service = process.cwd(), out = process.env.OUT, desktop = !!process.env.DESKTOP;
const dist = process.env.DIST_ROOT || service + '/web/dist';
if (!out) throw Error('Set OUT to a fresh evidence directory');
await fs.mkdir(out, { recursive: true });
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id, s.name]));
const seq = feed.routes['3'], start = seq.indexOf(48), previous = (start + seq.length - 1) % seq.length;
const exitId = seq[(previous + 5) % seq.length];
const ride = { routeLabel: 'Red', color: '#e53935', busName: '307', boardStopId: 48, alightStopId: exitId,
  toText: 'Fixture final destination', toLat: feed.stop_coords[exitId].lat, toLon: feed.stop_coords[exitId].lon + .002 };
function payload() {
  const now = Date.now(), rows = [];
  const buses = ['307', '309'].map((bus_name, i) => ({ bus_name, bus_id: i + 1, route_id: 3, ...feed.stop_coords[seq[previous]], last_stop_id: seq[previous], heading: 180, observed_at: now }));
  for (let b = 0; b < 2; b++) for (let h = 0; h < seq.length * 2; h++) {
    const eta = 300 + b * 900 + h * 90; rows.push([b, seq[(start + h) % seq.length], eta, eta - 120, eta + 240, h + 1, 0, eta - 120, eta - 120]);
  }
  rows.sort((a, b) => a[2] - b[2]);
  return { ...feed, buses, server_eta: { v: 2, at: now, servedAt: now, buses: ['307', '309'].map(b => [b, 'Red', previous, null]), rows } };
}

const autoEnd = process.env.AUTO_END === '1';
const report = {autoEnd, scope: 'Independent held-pinch interruption probe; current built SPA; real clock; all network intercepted', errors: [], phases: []};
let browser,context,page,client;
try {
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block',timezoneId:'America/New_York'});
 await seedTestId(context);
 await context.addInitScript(({ride,autoEnd})=>localStorage.setItem('shuttle-boarded-ride',JSON.stringify({...ride,startedAt:Date.now()-(autoEnd?7200000-4000:0)})),{ride,autoEnd});
 page=await context.newPage();page.setDefaultTimeout(8000);
 page.on('pageerror',e=>report.errors.push({message:e.message,stack:e.stack,phase:report.phases.at(-1)}));
 await page.route('**/*',async r=>{
  const u=new URL(r.request().url());if(u.hostname!=='map-interrupt.test')return r.abort();
  if(u.pathname==='/api/buses')return r.fulfill({json:payload()});
  if(u.pathname==='/api/weather')return r.fulfill({status:204});
  if(u.pathname.startsWith('/api/'))return r.fulfill({json:{reports:[],results:[],routes:[]}});
  const file=u.pathname==='/'?'/index.html':u.pathname;
  try{return r.fulfill({body:await fs.readFile(dist+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}
 });
 await page.goto('https://map-interrupt.test');
 const map=page.locator('.leaflet-container').first();await map.waitFor();
 await map.locator('.leaflet-overlay-pane path').first().waitFor();await page.waitForTimeout(400);
 const box=await map.boundingBox(),cx=box.x+box.width/2,cy=box.y+box.height/2;
 const pts=gap=>[{x:cx-gap,y:cy,id:1},{x:cx+gap,y:cy,id:2}];
 client=await context.newCDPSession(page);
 report.phases.push('pinch begins');
 await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:pts(25)});
 for(const gap of [30,40,50]){await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:pts(gap)});await page.waitForTimeout(40);}
 await page.waitForTimeout(100);
 report.phases.push(autoEnd ? 'Natural age auto-end while fingers remain down' : 'Done while fingers remain down');
 if (!autoEnd) await page.getByRole('button',{name:'Done',exact:true}).evaluate(e=>e.click());
 await page.getByRole('region',{name:'Finish your trip'}).waitFor();assert.equal(await page.locator('.leaflet-container').count(),0);
 await page.waitForTimeout(400);
 report.phases.push('release held pinch after teardown');
 await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(400);
 report.phases.push('subsequent normal touch on finish view');
 await page.getByRole('region',{name:'Finish your trip'}).getByRole('button',{name:'Dismiss',exact:true}).tap();await page.waitForTimeout(400);
 report.phases.push('complete');report.completed=true;
} finally {
 if(client)await client.detach();if(page)await page.close();if(context)await context.close();if(browser)await browser.close();
 report.resourcesClosed=true;await fs.writeFile(out+'/interrupt-pinch.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
assert.deepEqual(report.errors,[]);
