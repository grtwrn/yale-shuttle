import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const service = process.cwd(), out = process.env.OUT || '/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-05';
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
let feedRequests=0;
const report={scope:'Unmodified built SPA; fabricated two-bus live wire on checked-in route network',checks:[],errors:[]};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});let ctx,page;
try{
 ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'America/New_York',serviceWorkers:'block'});await seedTestId(ctx);
 await ctx.addInitScript(({now,fromLL,toLL,fromName,toName})=>sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:fromName,fromLL,toText:toName,toLL,tripTime:'',expandedKey:null,savedAt:now})),{now,fromLL:feed.stop_coords[48],toLL:feed.stop_coords[121],fromName:feed.stop_names[48],toName:feed.stop_names[121]});
 page=await ctx.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));await page.clock.install({time:new Date(now)});
 await page.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname!=='shell-map.test')return r.abort();if(u.pathname==='/api/buses'){feedRequests++;return r.fulfill({json:feed});}if(u.pathname==='/api/weather')return r.fulfill({status:204});if(u.pathname.startsWith('/api/'))return r.fulfill({json:{reports:[],results:[],routes:[]}});const f=u.pathname==='/'?'/index.html':u.pathname;try{return r.fulfill({body:await fs.readFile(service+'/web/dist'+f),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}});
 await page.goto('https://shell-map.test');const arrival=page.getByRole('button',{name:/Red arrival details/}).first();await arrival.waitFor();
 if(!await page.locator('.trip-map-wrap').count())await page.getByTitle('Expand overview',{exact:true}).click();
 const marker=page.locator('.trip-map-wrap .bus-pin-sm').first();await marker.waitFor();assert.match(await page.locator('.trip-map-wrap').innerText(),/🚌 \(R\)/);assert.equal(await marker.getAttribute('aria-label'),'Red #307');
 await marker.focus();await page.waitForTimeout(60);assert.match(await page.locator('.trip-map-wrap').innerText(),/Red #307/);
 await arrival.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Red arrival',exact:true});await dialog.waitFor();assert.match(await dialog.innerText(),/Following shuttle · #309/);await page.keyboard.press('Escape');
 report.checks.push('Real planner/transport selects #307 on minimap; keyboard exposes route/bus identity; arrival detail retains following #309');
 const fsButton=page.locator('.trip-map-wrap').getByRole('button',{name:'Fullscreen',exact:true});await fsButton.tap();await page.clock.runFor(150);assert(await page.locator('.map-fs').count());await page.keyboard.press('Escape');await page.clock.runFor(150);assert.equal(await page.locator('.map-fs').count(),0);assert(await fsButton.evaluate(e=>e===document.activeElement));
 report.checks.push('Mobile fullscreen tap and Escape retain map toggle focus');
 for(const width of [360,390,430,1280,640]){await page.setViewportSize({width,height:844});await page.clock.runFor(100);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'shell reflow '+width);}
 await page.setViewportSize({width:390,height:844});await page.locator('.trip-map-wrap').scrollIntoViewIfNeeded();await page.screenshot({path:out+'/shell-map-390.png'});
 const beforeStale=feedRequests;feed.server_eta.servedAt=now+60000;await page.clock.runFor(5500);await page.waitForTimeout(100);
 assert(feedRequests>beforeStale,'stale fixture fetched');report.staleBeforeFade=await page.locator('.trip-map-wrap .eta-tip').evaluateAll(es=>es.map(e=>({text:e.textContent,opacity:getComputedStyle(e).opacity})));await page.clock.runFor(500);await page.waitForTimeout(100);await page.clock.runFor(300);const staleMapText=await page.locator('.trip-map-wrap').count()?await page.locator('.trip-map-wrap').innerText():'';assert(!staleMapText.includes('🚌 (R)'),'stale pickup time removed');assert.equal(await page.locator('.trip-map-wrap .bus-wait-label').count(),0);report.checks.push('Fresh pickup timing present; subsequent stale wire removes pickup/wait labels');
 assert.deepEqual(report.errors,[]);report.completed=true;
}finally{if(!report.completed&&page)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);if(page)await page.close();if(ctx)await ctx.close();await browser.close();report.resourcesClosed=true;await fs.writeFile(out+'/shell-map.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
