// Route readability regression: real SPA, synthetic Night trips; no live-service or accuracy claim.
// Also supports production assets with ROUTE_READABILITY_PRODUCTION_ASSETS=1.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {seedTestId} from './testId.mjs';
const out=process.env.ROUTE_READABILITY_OUT;
assert(out,'Set ROUTE_READABILITY_OUT to a fresh evidence directory');
await fs.mkdir(out,{recursive:true});
const productionAssets=process.env.ROUTE_READABILITY_PRODUCTION_ASSETS==='1';
const base=process.env.BOT_BASE_URL||'https://yale-shuttle.fly.dev';
const stage=productionAssets?'production':'built';
const feed=JSON.parse(await fs.readFile('web/src/__fixtures__/buses-payload.json','utf8'));
feed.stop_names=Object.fromEntries(JSON.parse(await fs.readFile('src/server/__fixtures__/stops.json','utf8')).map(x=>[x.id,x.name]));
const now=Date.parse('2026-09-17T21:40:00-04:00');
const lines=[{id:13,label:'Blue Night',bus:'901',eta:900,low:600,high:1260},{id:14,label:'Orange Night',bus:'902',eta:720,low:180,high:1320},{id:16,label:'Blue West',bus:'903',eta:1800,low:1020,high:3000}];
feed.buses=[];const buses=[],rows=[];
for(const [i,line]of lines.entries()){
 const seq=feed.routes[line.id],start=seq.indexOf(10),prev=(start+seq.length-1)%seq.length;assert(start>=0&&seq.includes(98));
 feed.buses.push({bus_id:901+i,bus_name:line.bus,route_id:line.id,...feed.stop_coords[seq[prev]],last_stop_id:seq[prev],heading:0,stationary:false,observed_at:now});
 buses.push([line.bus,line.label,prev,null]);
 feed.segments[line.id]=Object.fromEntries(seq.map((from,j)=>[`${from}-${seq[(j+1)%seq.length]}`,{avg:60,sd:10,n:30,drive:50,driveN:30}]));
 feed.dwells??={};feed.dwells[line.id]=Object.fromEntries(seq.map(stop=>[stop,{med:0,sd:0,n:30,q:Array(10).fill(0),qn:30}]));
 for(let h=0;h<seq.length*2;h++)rows.push([i,seq[(start+h)%seq.length],line.eta+h*60,line.low+h*60,line.high+h*60,h+1,0,line.eta+h*60-30,line.low+h*60]);
}
rows.sort((a,b)=>a[2]-b[2]);
feed.server_eta={v:2,at:now,servedAt:now,buses,rows,distributions:rows.map(r=>Array.from({length:50},(_,j)=>r[3]+(r[4]-r[3])*j/49))};
const results=[],browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH,headless:true});
try{for(const viewport of [{width:1702,height:1164},{width:368,height:854}]){
 const context=await browser.newContext({viewport,isMobile:viewport.width<600,hasTouch:viewport.width<600,timezoneId:'America/New_York',serviceWorkers:'block'});let page,phase='fresh';
 try{
  await seedTestId(context);await context.addInitScript(({from,to,now})=>{
   localStorage.setItem('listView','trip');sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'333 Cedar',fromLL:from,toText:'Phelps Gate',toLL:to,tripTime:'',expandedKey:null,savedAt:now}));
  },{from:feed.stop_coords[10],to:feed.stop_coords[98],now});
  page=await context.newPage();page.setDefaultTimeout(15000);const errors=[],assets=[];page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date(now)});
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.hostname!=='map-key.test')return route.abort();
   if(u.pathname==='/api/buses'){
    const f=structuredClone(feed),at=await page.evaluate(()=>Date.now());f.server_eta.at=phase==='stale'?at-46000:at;f.server_eta.servedAt=at;
    for(const b of f.buses)b.observed_at=at;return route.fulfill({json:f});
   }
   if(u.pathname==='/api/weather')return route.fulfill({status:204});
   if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[]}});
   if(route.request().method()!=='GET')return route.abort();if(u.pathname.endsWith('.js'))assets.push(u.pathname);
   if(!productionAssets){const file=u.pathname==='/'?'/index.html':u.pathname;return route.fulfill({body:await fs.readFile('web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}
   const response=await route.fetch({url:base+u.pathname+u.search});return route.fulfill({response});
  });
  await page.goto('https://map-key.test',{waitUntil:'networkidle'});
  const table=page.getByTestId('route-timing-table');await table.waitFor();
  const more=page.getByRole('button',{name:/Show \d+ more route/});if(await more.isVisible())await more.click();
  for(const line of lines)await table.locator(`tbody[data-route="${line.label}"]`).first().waitFor();
  const checks=[];
  async function inspect(name){
   const map=await page.locator('.trip-map-canvas').boundingBox(),key=await table.boundingBox();
   assert(key.y>=map.y+map.height-1,'arrival table below map');
   assert.equal(await page.locator('.trip-map-canvas .eta-tip:not(.bus-wait-tip)').count(),0,'pickup time bubbles removed from map');
   const pins=await page.locator('.trip-map-canvas .bus-pin-sm').evaluateAll(xs=>xs.map(x=>({name:x.getAttribute('aria-label'),title:x.title,text:x.innerText})));
   for(const line of lines){assert(pins.some(x=>x.name?.includes(line.label)&&x.name?.includes(line.bus)),'full bus identity: '+line.label);assert(await table.locator(`tbody[data-route="${line.label}"]`).first().getByTestId('route-pill').isVisible());}
   assert.deepEqual(await table.locator('thead th').allTextContents(),['Route','Board in (min)','Next in','Arrive at']);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no page overflow');
   // Measure browser-computed foreground/background, independently of the
   // production component's color-selection function (WCAG sRGB luminance).
   const pills=await table.locator('tbody[data-mode="shuttle"] [data-testid="route-pill"]').evaluateAll(xs=>xs.map(x=>{
    const s=getComputedStyle(x);
    const luminance=color=>{
     const channels=color.match(/[\d.]+/g).map(Number);if(channels.length!==3)throw Error('Expected opaque RGB: '+color);
     const linear=channels.map(v=>{const c=v/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;});
     return linear[0]*0.2126+linear[1]*0.7152+linear[2]*0.0722;
    };
    const a=luminance(s.color),b=luminance(s.backgroundColor);
    return {label:x.textContent,foreground:s.color,background:s.backgroundColor,fontSize:s.fontSize,fontWeight:s.fontWeight,contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
   }));
   for(const pill of pills)assert(pill.contrast>=4.5,`${pill.label} text contrast ${pill.contrast.toFixed(3)}:1 is below 4.5:1`);
   checks.push({name,map,key,pins,pills,tableText:await table.innerText()});await page.screenshot({path:`${out}/${stage}-${viewport.width}-${name}.png`,fullPage:name!=='fullscreen'});
  }
  await inspect('overview');await page.getByRole('button',{name:'Fullscreen',exact:true}).click();await page.locator('.trip-map-wrap.map-fs').waitFor();await inspect('fullscreen');
  const key=await table.boundingBox();assert(key.y+key.height<=viewport.height+1,'fullscreen arrival panel within viewport');
  await page.getByRole('button',{name:'Back',exact:true}).click();
  phase='stale';const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/buses');await page.clock.runFor(5000);await(await response).finished();
  await page.waitForFunction(()=>[...document.querySelectorAll('tbody[data-mode="shuttle"]')].every(x=>x.textContent.includes('Unavailable')));
  await inspect('unavailable');assert.deepEqual(errors,[]);results.push({viewport,checks,assets:[...new Set(assets)],pageErrors:errors});
 }catch(error){
  if(page){await page.screenshot({path:`${out}/failure-${viewport.width}.png`,fullPage:true,timeout:5000}).catch(()=>{});await fs.writeFile(`${out}/failure-${viewport.width}.json`,JSON.stringify({phase,error:String(error),text:await page.locator('body').innerText({timeout:1000}).catch(()=>''),},null,2)).catch(()=>{});}
  throw error;
 }finally{await context.unrouteAll({behavior:'wait'});await context.close();}
}}finally{await browser.close();}
const proof={at:new Date().toISOString(),productionAssets,scope:'Built or production SPA (see productionAssets), controlled three-night-route feed and shared public-stop trip. Geometry, segment costs and forecast bands are synthetic for UI layout stress. External tiles/fonts blocked. Not the original Sep17 trip, live service or ETA accuracy evaluation.',results};
await fs.writeFile(out+'/RESULT.json',JSON.stringify(proof,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({cases:results.length,states:results.reduce((n,x)=>n+x.checks.length,0),errors:results.flatMap(x=>x.pageErrors)}));
