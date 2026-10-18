import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {seedTestId} from './testId.mjs';

const recorded=JSON.parse(await fs.readFile('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json','utf8'));
const out=process.env.FOLLOWING_PICKUP_OUT??'pr-preview/following-pickup';
const production=process.env.FOLLOWING_PICKUP_PRODUCTION_ASSETS==='1';
const start=recorded.stop_coords[100],moved={lat:41.3528,lon:-72.9229},now=recorded.server_eta.servedAt,results=[];
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true});
try {
 for(const viewport of [{width:368,height:854},{width:1702,height:1164}]) {
  let phase='fresh',page;const received=[];
  const ctx=await browser.newContext({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500,
   timezoneId:'America/New_York',serviceWorkers:'block',permissions:['geolocation']});
  try {
   await seedTestId(ctx);
   await ctx.addInitScript(({from,to,now})=>{
    localStorage.setItem('listView','trip');
    sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Current location',fromLL:from,toText:'Rosenkranz Hall',toLL:to,tripTime:'',expandedKey:null,savedAt:now}));
    const listeners=new Map();let next=1,position=from;
    const fix=()=>({coords:{latitude:position.lat,longitude:position.lon,accuracy:10,
     altitude:null,altitudeAccuracy:null,heading:null,speed:null},timestamp:Date.now()});
    Object.defineProperty(navigator,'geolocation',{value:{
     getCurrentPosition(ok){queueMicrotask(()=>ok(fix()));},
     watchPosition(ok){const id=next++;listeners.set(id,ok);queueMicrotask(()=>ok(fix()));return id;},
     clearWatch(id){listeners.delete(id);}
    }});
    window.__pickupGeoWatchCount=()=>listeners.size;
    window.__pickupMoveTo=point=>{position=point;for(const ok of listeners.values())ok(fix());return listeners.size;};
   },{from:start,to:recorded.to,now});
   page=await ctx.newPage();const errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
   await page.clock.install({time:new Date(now)});
   await page.route('**/*',async route=>{
    const u=new URL(route.request().url());if(u.hostname!=='following.test')return route.abort();
    if(u.pathname==='/api/buses') {
     const feed=structuredClone(recorded),at=await page.evaluate(()=>Date.now());
     feed.server_eta.at=at;feed.server_eta.servedAt=at;
     for(const bus of feed.buses)bus.observed_at=at;
     if(phase==='no-following') {
      const index=feed.server_eta.buses.findIndex(b=>b[0]==='48');
      feed.server_eta.rows=feed.server_eta.rows.filter(r=>r[1]!==100||r[0]===index);
      delete feed.server_eta.distributions;
     }
     received.push(phase);return route.fulfill({json:feed});
    }
    if(u.pathname==='/api/weather')return route.fulfill({status:204});
    if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[]}});
    if(route.request().method()!=='GET')return route.abort();
    if(production){const response=await route.fetch({url:'https://yale-shuttle.fly.dev'+u.pathname+u.search});return route.fulfill({response});}
    const file=u.pathname==='/'?'/index.html':u.pathname;
    try{return route.fulfill({body:await fs.readFile('web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}
    catch{return route.fulfill({status:404});}
   });
   await page.goto('https://following.test',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.__pickupGeoWatchCount()>0);
   const row=page.locator('tbody[data-route="Blue Day"][data-pickup="100"]');await row.waitFor();
   assert.match(await row.getByTestId('route-pickup').innerText(),/<1/);
   assert.match(await row.getByTestId('route-next-arrival').innerText(),/~21 min/);
   const initial=await row.innerText();
   await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).click();await page.getByTestId('trip-detail-panel').waitFor();
   assert((await page.evaluate(point=>window.__pickupMoveTo(point),moved))>0);
   await page.clock.runFor(250);
   await page.waitForFunction(()=>/4[67] min/.test(document.querySelector('tbody[data-route="Blue Day"][data-pickup="100"] [data-testid="journey-legs"]')?.innerText??''));
   assert.match(await row.getByTestId('route-pickup').innerText(),/~53/);
   assert.match(await row.getByTestId('route-next-arrival').innerText(),/~75 min/);
   assert.match(await row.getByTestId('approaching-pickup').innerText(),/Approaching #48: <1 min · estimated walk 46 min/);
   assert(await page.getByRole('button',{name:"🔔 Remind me for #48's return",exact:true}).isVisible());
   const laterVisit=await row.innerText();
   await page.screenshot({path:`${out}/later-visit-${viewport.width}.png`,fullPage:true});
   const phases=[];
   async function transition(next,predicate) {
    console.log(`[following-pickup] ${viewport.width} ${next}`);
    phase=next;const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/buses');
    await page.clock.runFor(5000);await(await response).finished();assert.equal(received.at(-1),next);
    await page.waitForFunction(predicate);phases.push({phase:next,text:await row.innerText()});
   }
   await transition('no-following',()=>!document.querySelector('tbody[data-route="Blue Day"][data-pickup="100"] [data-testid="route-next-arrival"]'));
   assert.match(await row.getByTestId('route-pickup').innerText(),/~53/);
   assert(await page.getByRole('button',{name:"🔔 Remind me for #48's return",exact:true}).isVisible());
   await transition('fresh',()=>document.querySelector('tbody[data-route="Blue Day"][data-pickup="100"] [data-testid="route-next-arrival"]')?.textContent.includes('~75 min'));
   assert((await page.evaluate(point=>window.__pickupMoveTo(point),start))>0);
   await page.clock.runFor(250);
   await page.waitForFunction(()=>document.querySelector('tbody[data-route="Blue Day"][data-pickup="100"] [data-testid="route-next-arrival"]')?.textContent.includes('~21 min'));
   assert.match(await row.getByTestId('route-pickup').innerText(),/<1/);
   assert.equal(await row.getByTestId('approaching-pickup').count(),0);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.deepEqual(errors,[]);
   results.push({viewport,initial,laterVisit,phases,backAtPickup:await row.innerText(),selectedPickup:100,reminderFollowsSelectedReturn:true,pageErrors:errors});
  }catch(error){
   if(page){
    await page.screenshot({path:`${out}/failure-${viewport.width}.png`,fullPage:true,timeout:5000}).catch(()=>{});
    const text=await page.locator('body').innerText({timeout:1000}).catch(()=>'');
    await fs.writeFile(`${out}/failure-${viewport.width}.json`,JSON.stringify({phase,received,error:String(error),text},null,2)).catch(()=>{});
   }
   throw error;
  }finally{await ctx.close();}
 }
 // Counterfactual closing clocks over the Sep 9 public GPS capture.
 // These four forecast rows were produced by ServerEta during the report89
 // audit; the canonical repeats are explicit, never inferred from stop IDs.
 const capture=JSON.parse(await fs.readFile('src/server/__fixtures__/live-frames.json','utf8'));
 const names=Object.fromEntries(JSON.parse(await fs.readFile('src/server/__fixtures__/stops.json','utf8')).map(s=>[s.id,s.name]));
 const source=capture.frames.at(-1),raw=source.buses.find(b=>b.bus_name==='#119');assert(raw);
 for(const width of [368,1280])for(const scenario of ['midday','closing','after-gate']) {
  const clock=Date.parse(scenario==='midday'?'2026-09-03T12:03:19.952-04:00':scenario==='closing'?'2026-09-03T18:58:19.952-04:00':'2026-09-03T19:10:19.952-04:00');
  const bus=structuredClone(raw),shift=clock-source.t;bus.observed_at=clock;
  for(const key of ['at_stop_since','stationary_since','last_moved_at'])if(bus[key])bus[key]=new Date(Date.parse(bus[key]+'Z')+shift).toISOString().slice(0,-1);
  const feed={...capture.static,buses:[bus],stop_names:names,route_hours:{3:{days:[1,2,3,4,5],startMin:420,endMin:1080}},
   server_eta:{v:2,at:clock,servedAt:clock,buses:[['119','Red',20,null]],travel:[20],
    rows:[[0,98,115,61,166,2,0,115,61],[0,121,755,578,934,9,0,755,578],
     [0,98,3833,3272,4373,31,0,3833,3272],[0,121,4482,3906,5061,38,0,4482,3906]],
    repeatVisits:[[0,98,31],[0,121,38]]}};
  const ctx=await browser.newContext({viewport:{width,height:854},isMobile:width<500,hasTouch:width<500,timezoneId:'America/New_York',serviceWorkers:'block'});
  let page;const errors=[];
  try {
   await seedTestId(ctx);
   await ctx.addInitScript(({from,to,now})=>{localStorage.setItem('listView','trip');sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Phelps Gate',fromLL:from,toText:'Union Station',toLL:to,tripTime:'',expandedKey:null,savedAt:now}));},
    {from:feed.stop_coords[98],to:feed.stop_coords[121],now:clock});
   page=await ctx.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date(clock)});
   await page.route('**/*',async route=>{
    const u=new URL(route.request().url());if(u.hostname!=='following.test')return route.abort();
    if(u.pathname==='/api/buses')return route.fulfill({json:feed});
    if(u.pathname==='/api/weather')return route.fulfill({status:204});
    if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[]}});
    if(route.request().method()!=='GET')return route.abort();
    if(production){const response=await route.fetch({url:'https://yale-shuttle.fly.dev'+u.pathname+u.search});return route.fulfill({response});}
    const file=u.pathname==='/'?'/index.html':u.pathname;
    try{return route.fulfill({body:await fs.readFile('web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404});}
   });
   await page.goto('https://following.test',{waitUntil:'domcontentloaded'});
   const row=page.locator('tbody[data-route="Red"][data-pickup="98"]');await row.waitFor();
   await row.getByTestId('route-pickup').waitFor();assert(!(await row.innerText()).includes('Unavailable'));
   if(scenario==='midday')assert.match(await row.getByTestId('route-next-arrival').innerText(),/~63 min/);
   else {assert.equal(await row.getByTestId('route-next-arrival').count(),0);assert.match(await row.innerText(),/Hours ended 6pm/);}
   await page.getByRole('button',{name:'View Red trip details',exact:true}).click();await page.getByTestId('trip-detail-panel').waitFor();
   assert(await page.getByRole('button',{name:"🚌 I'm on it",exact:true}).isVisible());
   assert.match(await row.innerText(),/🚌 10 min/);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
   await page.screenshot({path:`${out}/end-of-service-${scenario}-${width}.png`,fullPage:true});
   results.push({kind:'end-of-service',scenario,width,clock:new Date(clock).toISOString(),summary:await row.innerText(),pageErrors:errors,
    currentPickupRetained:true,rawForecastRows:feed.server_eta.rows.length,scope:'Constructed closing clock and explicit return metadata; not historical service or ETA accuracy proof'});
  }catch(error){if(page){await fs.writeFile(`${out}/end-of-service-failure-${scenario}-${width}.txt`,await page.locator('body').innerText());await page.screenshot({path:`${out}/end-of-service-failure-${scenario}-${width}.png`,fullPage:true});}throw error;}
  finally{if(page)await page.unrouteAll({behavior:'wait'});await ctx.close();}
 }
 await fs.writeFile(out+'/results.json',JSON.stringify({productionAssets:production,feedCapturedAt:recorded.capturedAt,
  scope:'Recorded feed with controlled location and following-arrival availability updates; not an exact report108 replay, physical journey, or ETA accuracy evaluation',results},null,2)+'\n');
}finally{await browser.close();}
console.log('Next in follows the selected pickup visit, including a return by the same bus; live walking stays current. Later canonical returns beyond service hours are withheld while current pickups stay visible.');
