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
const out='/home/gwarren/projects/yale-shuttle-watcher/ranking-data/'+(production?'production-jumps':'jumps');fs.mkdirSync(out,{recursive:true});
let phase=0,feedReads=0;
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,permissions:['geolocation'],geolocation:{latitude:41.324769,longitude:-72.923522},timezoneId:'America/New_York',serviceWorkers:'block'});
 const page=await ctx.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',x=>errors.push(x.message));await page.clock.install({time:at});
 await page.route('**/*',async r=>{
  const u=new URL(r.request().url());if(u.hostname!==new URL(url).hostname)return r.abort();
  if(u.pathname==='/api/buses'){
   feedReads++;
   const now=await page.evaluate(()=>Date.now()),f=structuredClone(feed);
   f.server_eta.at=now;f.server_eta.servedAt=now;
   for(const b of f.buses)b.observed_at=now;
   if(phase)for(const row of f.server_eta.rows){
    if(f.server_eta.buses[row[0]][1]!=='Red'||row[5]===0)continue;
    row[2]=Math.max(30,row[2]*[1,.4,1.6,.7][phase]);row[3]=0;row[4]=Math.max(2400,row[4]*2,row[2]);
   }
   return r.fulfill({json:f});
  }
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
 const routeButtons=page.getByRole('button',{name:/^View .+ trip details$/});
 const initialOrder=await routeButtons.evaluateAll(xs=>xs.map(x=>x.getAttribute('aria-label')));
 assert(initialOrder.length>=2);
 assert((await page.locator('body').innerText()).includes('When arrival timing is unclear, shorter walks and rides come first.'));
 await page.screenshot({path:out+'/ranked-options-390.png'});
 fs.writeFileSync(out+'/initial-order.json',JSON.stringify(initialOrder,null,2));
 const sequence=[];
 for(const p of [1,2,3,1,2,0]){
  phase=p;const before=feedReads;await page.clock.fastForward(12000);
  await page.waitForFunction(()=>document.querySelector('body')!==null);await page.waitForTimeout(500);
  assert(feedReads>before,'each variation must reach the UI');
  const order=await routeButtons.evaluateAll(xs=>xs.map(x=>x.getAttribute('aria-label')));
  const redText=await page.getByRole('button',{name:'View Red trip details',exact:true}).innerText();
  sequence.push({phase,order,redText,feedReads});
  assert.deepEqual(order,initialOrder,'wide overlapping windows must not reorder on point jumps');
 }
 assert(new Set(sequence.map(x=>x.redText)).size>1,'ETA text must remain live');
 fs.writeFileSync(out+'/sequence.json',JSON.stringify({note:'Synthetic forecast jumps over recorded September17 route geometry; verifies ranking/UI stability, not ETA accuracy.',initialOrder,sequence},null,2));
 const trip=page.getByRole('button',{name:'View Red trip details',exact:true});await trip.focus();await page.keyboard.press('Enter');
 await page.locator('.bus-wait-label').waitFor();assert((await page.locator('body').innerText()).includes('130 Prospect Street (S)'));
 await page.screenshot({path:out+'/red-after-jumps.png'});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({initialOrder,phases:sequence.length,feedReads,errors}));
}finally{await browser.close();db.close();}
