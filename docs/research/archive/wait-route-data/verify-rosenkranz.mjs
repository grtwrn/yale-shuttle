import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),base='/home/gwarren/projects/yale-shuttle-watcher/wait-route-data';
const req=createRequire(root+'/package.json');
const {chromium}=req('playwright-core'),D=req('better-sqlite3');
const {createJourneyHistory}=await import(pathToFileURL(root+'/src/server/journeyHistory.ts').href);
const feed=JSON.parse(fs.readFileSync(base+'/cache-fix/live-payload-1.json','utf8'));
const e=feed.server_eta,at=e.servedAt;
const db=new D('/home/gwarren/projects/yale-shuttle-watcher/red-eta-data/replay-lap.db',{readonly:true,fileMustExist:true});
const history=createJourneyHistory(db),probes=[];
const network={routes:new Map(Object.entries(feed.routes).map(([id,stops])=>[Number(id),{id:Number(id),stops}])),stops:new Map(Object.entries(feed.stop_names).map(([id,name])=>[Number(id),{name}]))};
const production=process.env.PRODUCTION_UI_URL;
const url=production??'https://rosenkranz.test';
const out=base+(production?'/rosenkranz-compact-production':'/rosenkranz-compact');fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,permissions:['geolocation'],geolocation:{latitude:41.324769,longitude:-72.923522},timezoneId:'America/New_York',serviceWorkers:'block'});
 const page=await ctx.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',x=>errors.push(x.message));await page.clock.install({time:at});
 await page.route('**/*',async r=>{
  const u=new URL(r.request().url());if(u.hostname!==new URL(url).hostname)return r.abort();
  if(u.pathname==='/api/buses')return r.fulfill({json:{...feed,server_eta:{...e,servedAt:await page.evaluate(()=>Date.now())}}});
  if(u.pathname==='/api/geocode')return r.fulfill({json:{results:[{display_name:'Rosenkranz Hall',lat:41.314701,lon:-72.924551,type:'college',class:'yale'}]}});
  if(u.pathname==='/api/journey-history'){
   const bus=u.searchParams.get('bus'),stop=Number(u.searchParams.get('stop')),track=e.buses.find(b=>b[0]===bus&&b[1]==='Red'),raw=feed.buses.find(b=>b.bus_name==='#'+bus&&b.route_id===3),row=e.rows.find(r=>e.buses[r[0]]===track&&r[1]===stop);
   const h=history('Red',stop,{bus:raw,sequence:feed.routes['3'],index:track[2],standing:track[3],stopsAhead:row[5]},network,at,100);probes.push({bus,stop,result:h});return r.fulfill({json:h});
  }
  if(u.pathname==='/api/weather')return r.fulfill({status:204});
  if(u.pathname.startsWith('/api/'))return r.fulfill({json:{reports:[]}});
  if(production)return r.continue();
  const f=u.pathname==='/'?'/index.html':u.pathname;try{return r.fulfill({body:fs.readFileSync(root+'/web/dist'+f),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}
 });
 await page.goto(url);await page.getByPlaceholder('Where do you want to go?').fill('Rosenkranz');await page.getByText('Rosenkranz Hall',{exact:true}).first().click();
 const more=page.getByRole('button',{name:/Show \d+ more route/});if(await more.isVisible())await more.click();
 const trip=page.getByRole('button',{name:'View Red trip details',exact:true});await trip.focus();await page.keyboard.press('Enter');
 await page.locator('.bus-wait-label').waitFor();assert((await page.locator('body').innerText()).includes('130 Prospect Street (S)'));
 const layouts=[];
 for(const width of [390,320,430]){
  await page.setViewportSize({width,height:844});await page.waitForTimeout(300);const map=page.locator('.trip-map-wrap');await map.scrollIntoViewIfNeeded();
  for(const full of [false,true]){
   if(full){await map.getByRole('button',{name:'Fullscreen',exact:true}).click();await page.waitForTimeout(300);}
   const layout=await map.evaluate(el=>{
    const label=el.querySelector('.bus-wait-label'),tip=label.closest('.leaflet-tooltip'),r=tip.getBoundingClientRect(),b=el.querySelector('.bus-pin-sm').getBoundingClientRect();
    const blockers=[...el.querySelectorAll('.eta-tip,.leaflet-control,.bus-pin-sm,:scope>button')].filter(t=>!t.querySelector('.bus-wait-label'));
    return {text:label.innerText,description:label.getAttribute('aria-label'),height:r.height,gap:Math.hypot(Math.max(r.left-b.right,b.left-r.right,0),Math.max(r.top-b.bottom,b.top-r.bottom,0)),collisions:blockers.filter(x=>{const z=x.getBoundingClientRect();return r.left<z.right&&r.right>z.left&&r.top<z.bottom&&r.bottom>z.top}).length};
   });assert.match(layout.text,/^Red \d+:\d{2}\/~\d+m$/);assert.equal(layout.collisions,0);assert(layout.height<25);assert(layout.gap<=12,JSON.stringify(layout));layouts.push({width,full,...layout});await page.screenshot({path:out+`/map-${width}-${full?'full':'mini'}.png`});
   if(full){await map.getByRole('button',{name:'Back',exact:true}).click();await page.waitForTimeout(200);}
  }
 }
 await page.getByRole('button',{name:/^Red arrival details:/}).click();await page.getByRole('region',{name:'Recorded arrival history'}).waitFor();await page.waitForTimeout(300);
 const detail=await page.getByRole('dialog').innerText();assert(detail.includes('344 Winchester'));assert(probes.some(p=>p.stop===48&&p.result.journey.trips.length>0));await page.screenshot({path:out+'/pickup-history.png'});
 assert.deepEqual(errors,[]);fs.writeFileSync(out+'/result.json',JSON.stringify({layouts,errors,detail,probes},null,2));console.log(JSON.stringify({layouts,errors,history:probes.map(p=>({stop:p.stop,trips:p.result.journey?.trips.length,dates:p.result.journey?.serviceDates}))}));
}finally{await browser.close();db.close();}
