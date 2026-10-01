// Actual built app + real service worker; bounded local fixture server, no collector.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const service = process.cwd(), out = process.env.OUT;
if (!out) throw Error('Set OUT');
await fs.mkdir(out, { recursive: true });
const { chromium } = createRequire(service + '/package.json')('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const now = Date.parse('2026-09-17T14:00:00-04:00');
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id, s.name]));
const seq = feed.routes['3'], start = seq.indexOf(48), previous = (start + seq.length - 1) % seq.length;
feed.buses = ['307','309'].map((bus_name,i) => ({ bus_name, bus_id:i+1, route_id:3, ...feed.stop_coords[seq[previous]], last_stop_id:seq[previous], heading:180, observed_at:now }));
const rows = [];
for(let b=0;b<2;b++) for(let h=0;h<seq.length*2;h++) {
 const eta=300+b*900+h*90; rows.push([b,seq[(start+h)%seq.length],eta,eta-120,eta+240,h+1,0,eta-120,eta-120]);
}
rows.sort((a,b)=>a[2]-b[2]);
feed.server_eta={ v:2,at:now,servedAt:now,buses:['307','309'].map(b=>[b,'Red',previous,null]),rows };
let requests = 0;
const report = { scope:'Built SPA on bounded local server, normal browser clock; synthetic feed; no live backend', checks:[],states:[],errors:[] };
const server = http.createServer(async(req,res)=>{
 try {
  const url = new URL(req.url, 'http://localhost:8093');
  if(url.pathname === '/api/buses') { requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(feed));return; }
  if(url.pathname === '/api/weather') { res.writeHead(204);res.end();return; }
  if(url.pathname.startsWith('/api/')) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({reports:[],results:[],routes:[]}));return;}
  const file = path.resolve(service + '/web/dist', '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if(!file.startsWith(service + '/web/dist/')) {res.writeHead(404);res.end();return;}
  const body=await fs.readFile(file);
  const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.webmanifest':'application/manifest+json','.svg':'image/svg+xml'};
  res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(body);
 } catch {res.writeHead(404);res.end();}
});
let browser,context,page;
try {
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8093,'127.0.0.1',resolve);});
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'America/New_York',serviceWorkers:'allow'});
 await seedTestId(context);
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='localhost'?route.continue():route.abort());
 page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto('http://localhost:8093');
 const nav=name=>page.getByRole('navigation',{name:'Main'}).getByRole('button',{name,exact:true});
 await page.getByText('🚌 2 shuttles reporting on 1 route',{exact:true}).waitFor();
 const red=page.locator('[id="route-card-Red"]');
 for(let i=0;i<32;i++) {
  await nav('map').click();await red.waitFor();
  await page.locator('.leaflet-control-zoom-in').first().evaluate(e=>e.click());
  await nav('trip').click();
  await nav('map').focus();await page.keyboard.press('Enter');await red.waitFor();
  await page.locator('.leaflet-control-zoom-out').first().evaluate(e=>e.click());
  await page.getByRole('button',{name:'Hide all',exact:true}).click();
  await page.getByRole('button',{name:'Show all routes',exact:true}).click();
  await nav('trip').click();
  assert.equal(await page.getByRole('heading',{name:'The shuttle app couldn’t open'}).count(),0);
 }
 await page.waitForTimeout(800);
 report.checks.push('32 normal-clock zoom-in/unmount and zoom-out/filter/unmount cycles completed; no page error or crash fallback');
 report.states.push({name:'after-rapid-map-transitions',body:await page.locator('body').innerText()});
 assert.deepEqual(report.errors,[]);report.completed=true;
} finally {
 if(page&&!report.completed)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);
 if(page)await page.close();if(context)await context.close();if(browser)await browser.close();
 await new Promise(resolve=>server.close(resolve));
 report.requests=requests;report.resourcesClosed=true;
 await fs.writeFile(out+'/map-stress.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
