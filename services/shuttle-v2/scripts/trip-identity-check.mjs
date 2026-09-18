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
let feedRequests=0;
const report={scope:'Unmodified built SPA; fabricated two-bus live wire on checked-in route network',checks:[],errors:[]};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});let ctx,page;
try{
 ctx=await browser.newContext({viewport:{width:process.env.DESKTOP ? 1280 : 390,height:844},isMobile:!process.env.DESKTOP,hasTouch:!process.env.DESKTOP,timezoneId:'America/New_York',serviceWorkers:'block'});await seedTestId(ctx);
 await ctx.addInitScript(({now,fromLL,toLL,fromName,toName})=>sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:fromName,fromLL,toText:toName,toLL,tripTime:'',expandedKey:null,savedAt:now})),{now,fromLL:{lat:feed.stop_coords[48].lat,lon:feed.stop_coords[48].lon-0.0017},toLL:{lat:feed.stop_coords[121].lat,lon:feed.stop_coords[121].lon+0.0017},fromName:feed.stop_names[48],toName:'Destination east of Union Station with a long building name'});
 page=await ctx.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));await page.clock.install({time:new Date(now)});
 await page.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname!=='shell-map.test')return r.abort();if(u.pathname==='/api/buses'){feedRequests++;return r.fulfill({json:feed});}if(u.pathname==='/api/weather')return r.fulfill({status:204});if(u.pathname.startsWith('/api/'))return r.fulfill({json:{reports:[],results:[],routes:[]}});const f=u.pathname==='/'?'/index.html':u.pathname;try{return r.fulfill({body:await fs.readFile(service+'/web/dist'+f),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}});
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
 for(const a of [action,pickupAction]){const b=await a.boundingBox();assert(b.width>=44&&b.height>=44);}
 await action.focus();await page.keyboard.press('Tab');assert(await pickupAction.evaluate(e=>e===document.activeElement));
 for(const width of (process.env.DESKTOP?[1280,640]:[360,390,430])){
  await page.setViewportSize({width,height:844});await page.clock.runFor(100);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'reflow '+width);
 }
 await page.setViewportSize({width:process.env.DESKTOP?1280:390,height:844});
 await action.scrollIntoViewIfNeeded();await page.screenshot({path:out+'/trip-identity.png',fullPage:true});
 report.checks.push('Actual live option prices #309 while pickup still follows #307; ride/wait attribution, both named 44px boarding actions, final walk and reflow pass');
 await arrival.focus();await page.keyboard.press('Enter');await dialog.waitFor();
 assert.match(await dialog.innerText(),/Following shuttle · #309/);assert.match(await dialog.innerText(),/#307/);await page.keyboard.press('Escape');
 // The original endpoint draft and both pickup visits survive return navigation.
 await page.getByTitle('Back to all routes',{exact:true}).click();
 await page.getByRole('button',{name:'View Red trip details',exact:true}).click();
 const afterDraft=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('shuttle-trip-draft')));
 for(const k of ['fromText','fromLL','toText','toLL'])assert.deepEqual(afterDraft[k],draft[k]);
 // A failed/absent forecast removes the different-journey claim, then recovers.
 await action.focus();await page.clock.runFor(5500);await page.waitForTimeout(100);
 assert(await action.evaluate(e=>e===document.activeElement),'ordinary poll retains boarding focus');
 const wire=feed.server_eta;delete feed.server_eta;
 await page.clock.runFor(5500);await page.waitForTimeout(100);
 await page.getByText('ETA unavailable',{exact:true}).first().waitFor();
 assert.equal(await page.getByText(/Trip time uses #309/).count(),0);
 assert.equal(await page.getByRole('button',{name:/I'm on #309/}).count(),0);
 assert(await page.getByRole('button',{name:"🚌 I'm on it",exact:true}).evaluate(e=>e===document.activeElement),'missing journey returns focus to persistent boarding action');
 feed.server_eta=wire;await page.clock.runFor(5500);await page.waitForTimeout(100);await action.waitFor();
 const directions=page.getByRole('link',{name:'🧭 Directions to stop',exact:true});await directions.focus();
 wire.servedAt=wire.at+60000;await page.clock.runFor(5500);await page.waitForTimeout(100);
 assert.equal(await page.getByText(/Trip time uses #309/).count(),0);
 assert(await directions.evaluate(e=>e===document.activeElement),'stale transition preserves external focus');
 wire.servedAt=wire.at;await page.clock.runFor(5500);await page.waitForTimeout(100);await action.waitFor();
 report.checks.push('Both pickup identities, Back/draft, missing and stale wire removal, and fresh recovery preserved');
 // Each explicit choice tracks its own bus and preserves the final destination.
 for(const busName of ['309','307']){
  const b=page.getByRole('button',{name:`🚌 I'm on #${busName}`,exact:true});
  await b.focus();if(busName==='309')await page.keyboard.press('Enter');else if(process.env.DESKTOP)await page.keyboard.press('Space');else await b.tap();
  const done=page.getByRole('button',{name:'Done',exact:true});await done.waitFor();
  const boarded=await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle-boarded-ride')));
  assert.equal(boarded.busName,busName);assert.equal(boarded.boardStopId,48);assert.equal(boarded.alightStopId,121);
  assert.equal(boarded.toText,draft.toText);assert.equal(boarded.toLat,draft.toLL.lat);assert.equal(boarded.toLon,draft.toLL.lon);
  assert.match(await page.locator('body').innerText(),new RegExp(`Red #${busName}`));
  await done.focus();await page.keyboard.press('Enter');
  const finish=page.getByRole('region',{name:'Finish your trip'});await finish.waitFor();
  const link=finish.getByRole('link',{name:/Walking directions/});
  const url=new URL(await link.getAttribute('href'));assert.equal(url.searchParams.get('destination'),`${draft.toLL.lat},${draft.toLL.lon}`);assert.equal(url.searchParams.get('travelmode'),'walking');assert.equal(url.searchParams.has('origin'),false);
  assert.match(await finish.innerText(),/Destination east of Union Station/);
  report.checks.push(`Explicit boarding #${busName} tracks that bus and retains exit/final walking destination after Done`);
  await page.evaluate(({draft})=>{localStorage.removeItem('shuttle-boarded-ride');sessionStorage.setItem('shuttle-trip-draft',JSON.stringify(draft));},{draft});
  await page.reload();await page.getByRole('button',{name:'View Red trip details',exact:true}).click();await page.getByRole('button',{name:"🚌 I'm on #309",exact:true}).waitFor();
 }
 // Once the original pickup is catchable again, ordinary one-bus presentation returns.
 for(const r of wire.rows)if(r[0]===0){r[2]+=280;r[3]+=280;r[4]+=280;r[7]+=280;r[8]+=280;}
 wire.rows.sort((a,b)=>a[2]-b[2]);wire.distributions=wire.rows.map(r=>Array.from({length:50},(_,i)=>r[3]+i*(r[4]-r[3])/49));
 await page.clock.runFor(5500);await page.waitForTimeout(100);
 await page.getByRole('button',{name:"🚌 I'm on it",exact:true}).waitFor();
 assert.equal(await page.getByText(/Trip time uses/).count(),0);
 assert.match(await page.locator('body').innerText(),/🚌 #307 · 1[78] min/);
 assert.deepEqual(report.errors,[]);report.completed=true;

}finally{if(!report.completed&&page)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);if(page)await page.close();if(ctx)await ctx.close();await browser.close();report.resourcesClosed=true;await fs.writeFile(out+'/trip-identity.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify({checks:report.checks,errors:report.errors,completed:report.completed,resourcesClosed:report.resourcesClosed},null,2));
