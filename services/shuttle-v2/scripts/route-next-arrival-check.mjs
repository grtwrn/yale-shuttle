// Actual built SPA: following-arrival column, mobile reflow, row navigation and live updates. Synthetic wire, not physical-service evidence.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const service = process.cwd(), out = process.env.OUT;
if (!out) throw new Error('Set OUT to a fresh evidence directory');
await fs.mkdir(out, { recursive: true });
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
rows.sort((a,b)=>a[2]-b[2]);
feed.server_eta={v:2,at:now,servedAt:now,buses:['307','309'].map(b=>[b,'Red',previous,null]),rows,distributions:rows.map(r=>Array.from({length:50},(_,i)=>r[2]-120+i*360/49))};

const report={scope:'Actual built SPA with synthetic two-bus Red wire',widths:[],errors:[],completed:false};
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH,args:['--no-sandbox','--disable-gpu']});
try {
 for(const width of [320,390,1280]) {
  const context=await browser.newContext({viewport:{width,height:844},isMobile:width<600,hasTouch:width<600,timezoneId:'America/New_York',serviceWorkers:'block'});
  await seedTestId(context);
  await context.addInitScript(({now,fromLL,toLL})=>sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Pickup',fromLL,toText:'Union Station',toLL,tripTime:'',expandedKey:null,savedAt:now})),{now,fromLL:feed.stop_coords[48],toLL:feed.stop_coords[121]});
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));
  try {
   await page.clock.install({time:new Date(now)});
   await page.route('**/*',async r=>{
    const u=new URL(r.request().url());if(u.hostname!=='next-column.test')return r.abort();
    if(u.pathname==='/api/buses')return r.fulfill({json:feed});
    if(u.pathname==='/api/weather')return r.fulfill({status:204});
    if(u.pathname.startsWith('/api/'))return r.fulfill({json:{reports:[],results:[],routes:[]}});
    const f=u.pathname==='/'?'/index.html':u.pathname;
    try{return r.fulfill({body:await fs.readFile(service+'/web/dist'+f),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'})}catch{return r.fulfill({status:404})}
   });
   await page.goto('https://next-column.test');
   const table=page.getByTestId('route-timing-table');await table.waitFor();
   assert.deepEqual(await table.locator('thead th').allTextContents(),['Route','Board in (min)','Next in','Arrive at']);
   const row=table.locator('tbody[data-route="Red"]'),next=row.getByTestId('route-next-arrival');await next.waitFor();
   const before=await next.innerText();assert.match(before,/^~(?:19|20) min$/);
   assert.equal(await row.locator('tr').first().locator('th,td').count(),4);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page reflow '+width);
   const clipped=await table.locator('thead th,tbody tr:first-child th,tbody tr:first-child td').evaluateAll(cells=>cells.filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>({text:e.innerText,scroll:e.scrollWidth,client:e.clientWidth})));
   assert.deepEqual(clipped,[],'table cells reflow '+width);
   await table.screenshot({path:out+'/table-'+width+'.png'});
   if(width<600)await next.tap();else await next.click();
   await page.getByTitle('Back to all routes',{exact:true}).waitFor();
   assert.equal(await page.getByRole('dialog').count(),0,'next cell opens route, not chart');
   await page.getByTitle('Back to all routes',{exact:true}).click();
   for(const r of feed.server_eta.rows)if(r[0]===1){r[2]-=120;r[3]-=120;r[4]-=120;r[7]-=120;r[8]-=120;}
   feed.server_eta.distributions=feed.server_eta.rows.map(r=>Array.from({length:50},(_,i)=>r[3]+i*(r[4]-r[3])/49));
   await page.clock.runFor(5500);await page.waitForTimeout(100);
   const after=await table.locator('tbody[data-route="Red"]').getByTestId('route-next-arrival').innerText();assert.match(after,/^~(?:17|18) min$/);
   // Remove the wire: this must remove, not fabricate, the following arrival.
   const wire=feed.server_eta;delete feed.server_eta;await page.clock.runFor(5500);await page.waitForTimeout(100);
   await table.locator('tbody[data-route="Red"]').getByLabel('Following arrival unavailable').waitFor();
   assert.equal(await table.getByTestId('route-next-arrival').count(),0);
   feed.server_eta=wire;
   for(const r of wire.rows)if(r[0]===1){r[2]+=120;r[3]+=120;r[4]+=120;r[7]+=120;r[8]+=120;}
   wire.distributions=wire.rows.map(r=>Array.from({length:50},(_,i)=>r[3]+i*(r[4]-r[3])/49));
   await page.clock.runFor(5500);await page.waitForTimeout(100);await table.locator('tbody[data-route="Red"]').getByTestId('route-next-arrival').waitFor();
   const select=table.getByRole('button',{name:'View Red trip details',exact:true});await select.focus();await page.keyboard.press('Enter');await page.getByTitle('Back to all routes',{exact:true}).waitFor();
   report.widths.push({width,before,after,clipped,nextTapAndKeyboardNavigate:true,missingAndRecovery:true});
  } finally {await page.close();await context.close()}
 }
 assert.deepEqual(report.errors,[]);report.completed=true;
} finally {await browser.close();report.resourcesClosed=true;await fs.writeFile(out+'/RESULT.json',JSON.stringify(report,null,2))}
console.log(JSON.stringify(report,null,2));
