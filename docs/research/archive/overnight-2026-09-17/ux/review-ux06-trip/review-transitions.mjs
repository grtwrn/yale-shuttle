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
let feedRequests=0, offline=false, failedRequests=0;
const report={scope:'Unmodified built SPA; fabricated two-bus live wire on checked-in route network',checks:[],errors:[]};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});let ctx,page;
try{
 ctx=await browser.newContext({viewport:{width:process.env.DESKTOP ? 1280 : 390,height:844},isMobile:!process.env.DESKTOP,hasTouch:!process.env.DESKTOP,timezoneId:'America/New_York',serviceWorkers:'block'});await seedTestId(ctx);
 await ctx.addInitScript(({now,fromLL,toLL,fromName,toName})=>sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:fromName,fromLL,toText:toName,toLL,tripTime:'',expandedKey:null,savedAt:now})),{now,fromLL:{lat:feed.stop_coords[48].lat,lon:feed.stop_coords[48].lon-0.0017},toLL:{lat:feed.stop_coords[121].lat,lon:feed.stop_coords[121].lon+0.0017},fromName:feed.stop_names[48],toName:'Destination east of Union Station with a long building name'});
 page=await ctx.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));await page.clock.install({time:new Date(now)});
 await page.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname!=='shell-map.test')return r.abort();if(u.pathname==='/api/buses'){feedRequests++;if(offline){failedRequests++;return r.abort();}return r.fulfill({json:feed});}if(u.pathname==='/api/weather')return r.fulfill({status:204});if(u.pathname.startsWith('/api/'))return r.fulfill({json:{reports:[],results:[],routes:[]}});const f=u.pathname==='/'?'/index.html':u.pathname;try{return r.fulfill({body:await fs.readFile(service+'/web/dist'+f),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}});
 await page.goto('https://shell-map.test');const arrival=page.getByRole('button',{name:/Red arrival details/}).first();await arrival.waitFor();
 if(!await page.locator('.trip-map-wrap').count())await page.getByTitle('Expand overview',{exact:true}).click();
 const marker=page.locator('.trip-map-wrap .bus-pin-sm').first();await marker.waitFor();assert.match(await page.locator('.trip-map-wrap').innerText(),/🚌 \(R\)/);assert.equal(await marker.getAttribute('aria-label'),'Red #307');
 await marker.focus();await page.waitForTimeout(60);assert.match(await page.locator('.trip-map-wrap').innerText(),/Red #307/);
 await arrival.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Red arrival',exact:true});await dialog.waitFor();assert.match(await dialog.innerText(),/Following shuttle · #309/);await page.keyboard.press('Escape');
 report.checks.push('Real planner/transport selects #307 on minimap; keyboard exposes route/bus identity; arrival detail retains following #309');
 const fsButton=page.locator('.trip-map-wrap').getByRole('button',{name:'Fullscreen',exact:true});if(process.env.DESKTOP)await fsButton.click();else await fsButton.tap();await page.clock.runFor(150);assert(await page.locator('.map-fs').count());await page.keyboard.press('Escape');await page.clock.runFor(150);assert.equal(await page.locator('.map-fs').count(),0);assert(await fsButton.evaluate(e=>e===document.activeElement));
 report.checks.push('Mobile fullscreen tap and Escape retain map toggle focus');

 await page.getByRole('button',{name:'View Red trip details',exact:true}).click();
 report.before=await page.locator('body').innerText();
 for (const r of feed.server_eta.rows) if(r[0]===0) {r[2]-=280;r[3]=Math.max(0,r[3]-280);r[4]-=280;r[7]=Math.max(0,r[7]-280);r[8]=Math.max(0,r[8]-280);}
 feed.server_eta.rows.sort((a,b)=>a[2]-b[2]);
 feed.server_eta.distributions=feed.server_eta.rows.map(r=>Array.from({length:50},(_,i)=>r[3]+i*(r[4]-r[3])/49));
 await page.clock.runFor(5500);await page.waitForTimeout(100);
 report.options=await page.evaluate(()=>{const r=document.getElementById('root');const k=Object.keys(r).find(k=>k.startsWith('__reactContainer$'));const stack=[r[k].stateNode?.current??r[k]],all=[];let n=0;while(stack.length&&n++<10000){const f=stack.pop();if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);let h=f.memoizedState,c=0;while(h&&typeof h==='object'&&c++<500){const m=h.memoizedState;if(Array.isArray(m)&&Array.isArray(m[0])&&m[0][0]?.routeLabel&&m[0][0]?.mode)all.push(m[0]);h=h.next;}}return all.flat().filter(o=>o.mode==='shuttle'&&Object.hasOwn(o,'departed'));});
 report.after=await page.locator('body').innerText();

 const option=report.options[0];
 assert.equal(option.busName,'307');assert.equal(option.journeyArrival.busName,'309');
 assert.equal(option.boardStopId,48);assert.equal(option.alightStopId,121);
 assert(option.walkFromSec>=60,'fixture has a final walk');
 assert.match(report.after,/Trip time uses #309. #307 may reach pickup before you/);
 assert(report.after.includes(`🚌 #309 · ${Math.floor(option.rideSec/60)} min`),'ride duration matches the chosen journey');
 assert.match(report.after,/⏳ 17 min/);assert(!report.after.includes('⏳ now-2 min'));
 assert.match(report.after,/GET OFFUnion Station/);
 const draft=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('shuttle-trip-draft')));
 const action=page.getByRole('button',{name:"🚌 I'm on #309",exact:true});
 const pickupAction=page.getByRole('button',{name:"🚌 I'm on #307",exact:true});

 const mismatchWire=JSON.parse(JSON.stringify(feed.server_eta));
 const poll=async()=>{await page.clock.runFor(5500);await page.waitForTimeout(120);};
 // Same-bus recovery removes only the extra action and preserves its focus.
 await action.focus();
 for(const r of feed.server_eta.rows)if(r[0]===0){r[2]+=280;r[3]+=280;r[4]+=280;r[7]+=280;r[8]+=280;}
 feed.server_eta.rows.sort((a,b)=>a[2]-b[2]);
 feed.server_eta.distributions=feed.server_eta.rows.map(r=>Array.from({length:50},(_,i)=>r[3]+i*(r[4]-r[3])/49));
 await poll();
 const ordinary=page.getByRole('button',{name:"🚌 I'm on it",exact:true});
 await ordinary.waitFor();assert(await ordinary.evaluate(e=>e===document.activeElement),'same-bus recovery returns focus to persistent pickup action');
 assert.equal(await page.getByText(/Trip time uses/).count(),0);
 feed.server_eta=JSON.parse(JSON.stringify(mismatchWire));await poll();await action.waitFor();
 assert(await pickupAction.evaluate(e=>e===document.activeElement),'adding a journey action preserves existing pickup focus');
 report.checks.push('Distinct to same bus removes focused extra action safely; recovery preserves focus on pickup');
 // Outage is an actual failed request sequence, not just an invalid payload.
 await action.focus();offline=true;await page.clock.runFor(49000);await page.waitForTimeout(150);await page.clock.runFor(1500);
 assert(failedRequests>0);
 await page.getByText('ETA unavailable',{exact:true}).first().waitFor();
 assert.equal(await page.getByText(/Trip time uses/).count(),0);
 assert(await ordinary.evaluate(e=>e===document.activeElement),'expired feed restores boarding focus');
 report.offlineText=await page.locator('body').innerText();
 offline=false;const recoveredAt=await page.evaluate(()=>Date.now());
 feed.server_eta.at=recoveredAt;feed.server_eta.servedAt=recoveredAt;
 for(const b of feed.buses)b.observed_at=recoveredAt;
 await poll();await action.waitFor();
 assert(await pickupAction.evaluate(e=>e===document.activeElement),'feed recovery does not steal pickup focus');
 await arrival.focus();await page.keyboard.press('Enter');await dialog.waitFor();assert.match(await dialog.innerText(),/Following shuttle · #309/);await page.keyboard.press('Escape');
 report.checks.push('Failed requests expire after 45 seconds: different-bus claim removed, focus returned; fresh recovery retains both arrivals');
 // A normalized bus-name update changes the label and the boarded identity together.
 await action.focus();feed.buses[1].bus_name='#310';feed.server_eta.buses[1][0]='#310';await poll();
 const newAction=page.getByRole('button',{name:"🚌 I'm on #310",exact:true});await newAction.waitFor();
 assert(await newAction.evaluate(e=>e===document.activeElement),'updated journey identity preserves focused button');
 assert.match(await page.locator('body').innerText(),/Trip time uses #310. #307 may reach pickup before you/);
 assert.equal(await page.getByRole('button',{name:"🚌 I'm on #309",exact:true}).count(),0);
 await page.keyboard.press('Space');
 const done=page.getByRole('button',{name:'Done',exact:true});await done.waitFor();
 const ride=await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle-boarded-ride')));
 assert.equal(ride.busName,'310');assert.equal(ride.alightStopId,121);assert.equal(ride.toText,draft.toText);
 await page.reload();await done.waitFor();
 const restored=await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle-boarded-ride')));
 assert.deepEqual(restored,ride,'active ride survives restart with selected normalized bus and destination');
 assert.match(await page.locator('body').innerText(),/Red #310/);
 report.rideText=await page.locator('body').innerText();
 // Even when fresh forecast rows disappear during the ride, tracking keeps the chosen bus.
 const freshWire=feed.server_eta;delete feed.server_eta;await poll();
 assert.equal((await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle-boarded-ride')))).busName,'310');
 assert.match(await page.locator('body').innerText(),/Red #310/);
 feed.server_eta=freshWire;await poll();await done.focus();await page.keyboard.press('Enter');
 const finish=page.getByRole('region',{name:'Finish your trip'});await finish.waitFor();
 const url=new URL(await finish.getByRole('link',{name:/Walking directions/}).getAttribute('href'));
 assert.equal(url.searchParams.get('destination'),`${draft.toLL.lat},${draft.toLL.lon}`);assert.equal(url.searchParams.get('travelmode'),'walking');
 assert.equal(url.searchParams.has('origin'),false);
 report.checks.push('Journey bus rename to #310 preserves focus and boards 310; reload/missing forecast preserve its tracking; Done retains exact final walk');
 assert.deepEqual(report.errors,[]);report.failedRequests=failedRequests;report.completed=true;
}finally{if(!report.completed&&page)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);if(page)await page.close();if(ctx)await ctx.close();await browser.close();report.resourcesClosed=true;await fs.writeFile(out+'/review-transitions.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify({checks:report.checks,failedRequests:report.failedRequests,errors:report.errors,completed:report.completed,resourcesClosed:report.resourcesClosed},null,2));
