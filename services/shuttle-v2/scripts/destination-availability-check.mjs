/** Current destination presentation using unchanged original Red124 offers.
 * All APIs are intercepted. Build web first; --baseline records the existing
 * unsupported point rather than requiring its correction. Production assets
 * require DESTINATION_AVAILABILITY_PRODUCTION_ASSETS=1 explicitly.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {seedTestId} from './testId.mjs';

const service=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(process.env.DESTINATION_AVAILABILITY_OUT??path.join(service,'pr-preview/destination-availability'));
const production=process.env.DESTINATION_AVAILABILITY_PRODUCTION_ASSETS==='1';
const baseline=process.argv.includes('--baseline'),host='destination-availability.test';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixture=JSON.parse(gunzipSync(await fs.readFile(path.join(service,'scripts/__fixtures__/red124-destination-offers-20261030.json.gz')),{maxOutputLength:8*1024*1024}));
for(const frame of fixture.frames){assert.equal(Buffer.byteLength(frame.payloadJSON),frame.payloadBytes);assert.equal(digest(frame.payloadJSON),frame.payloadSHA256);assert.equal(JSON.parse(frame.payloadJSON).server_eta.at,frame.at);}
await fs.mkdir(out,{recursive:true});await fs.mkdir(path.join(out,'assets'),{recursive:true});
const result={baseline,production,scope:fixture.source.scope,runs:[],allAPIsIntercepted:true,noRealReportWrites:true};
if(production){
 const response=await fetch('https://yale-shuttle.fly.dev/healthz'),bytes=Buffer.from(await response.arrayBuffer()),health=JSON.parse(bytes);
 assert(response.ok&&health.ok);result.published={at:new Date().toISOString(),build:health.build,healthSHA256:digest(bytes)};
 await fs.writeFile(path.join(out,'production-health-original.json'),bytes);
}
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
let activePage;
try{
 for(const width of [390,1280])for(const clockControl of [false,true]){
  const frames=clockControl?fixture.frames.slice(0,-1):fixture.frames;
  let phase=0,at=frames[0].at;
  const run={width,scenario:clockControl?'clock-advance':'six-original-updates',errors:[],requests:[],assets:[],snapshots:[]};result.runs.push(run);
  const context=await browser.newContext({viewport:{width,height:900},isMobile:width<600,hasTouch:width<600,timezoneId:'America/New_York',serviceWorkers:'block'});
  await seedTestId(context);
  await context.addInitScript(({plan,now})=>{
   localStorage.setItem('listView','trip');
   sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:plan.pickupStopName,fromLL:plan.fromLL,toText:plan.destinationName,toLL:plan.toLL,tripTime:'',expandedKey:null,savedAt:now}));
  },{plan:fixture.plan,now:at});
  const page=activePage=await context.newPage(),assets=[];page.setDefaultTimeout(12000);
  const retainAsset=(bytes,source,pathname)=>{
   if(pathname!=='/'&&!pathname.startsWith('/assets/'))return;
   const sha256=digest(bytes),file=sha256+(pathname.endsWith('.js')?'.js':pathname.endsWith('.css')?'.css':'.html');
   run.assets.push({url:source,bytes:bytes.length,sha256,file});
   assets.push(fs.writeFile(path.join(out,'assets',file),bytes,{flag:'wx'}).catch(async error=>{if(error.code!=='EEXIST')throw error;assert.equal(digest(await fs.readFile(path.join(out,'assets',file))),sha256);}));
  };
  page.on('pageerror',error=>run.errors.push(error.message));
  await page.clock.setFixedTime(at);
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.hostname!==host)return route.abort();
   if(url.pathname.startsWith('/api/')){
    run.requests.push({seq:frames[phase].seq,clock:at,path:url.pathname,method:request.method()});
    if(url.pathname==='/api/buses')return route.fulfill({body:frames[phase].payloadJSON,contentType:'application/json'});
    if(url.pathname==='/api/weather')return route.fulfill({status:204});
    return route.fulfill({json:{reports:[],results:[],routes:[],rows:[],ok:true}});
   }
   if(request.method()!=='GET')return route.abort();
   if(production){
    const source='https://yale-shuttle.fly.dev'+url.pathname+url.search,response=await route.fetch({url:source}),bytes=await response.body();
    retainAsset(bytes,source,url.pathname);
    return route.fulfill({response,body:bytes});
   }
   const file=url.pathname==='/'?'/index.html':url.pathname;
   try{const bytes=await fs.readFile(service+'/web/dist'+file);retainAsset(bytes,service+'/web/dist'+file,url.pathname);return route.fulfill({body:bytes,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}
   catch{return route.fulfill({status:404});}
  });
  await page.goto('https://'+host,{waitUntil:'domcontentloaded'});
  const row=page.locator('tbody[data-route="Red"][data-pickup="115"]');await row.waitFor();
  await row.getByRole('button',{name:'View Red trip details',exact:true}).click();
  const drain=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const capture=async stage=>{
   await drain();const destination=row.getByTestId('destination-arrival');await destination.waitFor();
   const snapshot={seq:frames[phase].seq,at:frames[phase].at,browserClock:await page.evaluate(()=>Date.now()),stage,
    payloadSHA256:frames[phase].payloadSHA256,kind:await destination.getAttribute('data-kind'),text:await destination.innerText(),
    description:await destination.getAttribute('aria-label'),row:await row.innerText(),boardBus:await row.getAttribute('data-board-bus'),
    rideDuration:(await row.getByTestId('journey-legs').locator('span').allTextContents()).find(text=>text.startsWith('🚌 '))??null,
    countdownBus:await row.getAttribute('data-countdown-bus'),stopsAhead:await row.getAttribute('data-board-stops-ahead'),
    alerts:await page.locator('[data-testid="bus-reporting-alerts"]').allTextContents(),
    noHorizontalOverflow:await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)};
   run.snapshots.push(snapshot);assert.equal(snapshot.browserClock,at);assert.equal(snapshot.boardBus,'124');assert.equal(snapshot.countdownBus,'124');assert.equal(snapshot.stopsAhead,'0');assert.match(snapshot.row,/At stop/);assert.equal(snapshot.alerts.length,0);assert(snapshot.noHorizontalOverflow);
   const expected=frames[phase].seq===69277||frames[phase].seq===69282?'window':'unavailable';
   if(!baseline){assert.equal(snapshot.kind,expected);if(expected==='unavailable'){assert.equal(snapshot.text,'Arrival unavailable');assert(!/[~\d]:?\d/.test(snapshot.text),'unsupported destination must not show a clock');assert.equal(snapshot.rideDuration,'🚌 Typical ride ~20 min');assert(!snapshot.row.includes('🚌 22 min'),'a missing live journey must not reuse its previous live ride duration');}else{assert.equal(snapshot.rideDuration,'🚌 22 min');}}
   await fs.writeFile(path.join(out,`${width}-${run.scenario}-${snapshot.seq}-${stage}.json`),JSON.stringify(snapshot,null,2)+'\n');
   if([69277,69278,69282].includes(snapshot.seq)||stage==='after-clock-advance')await page.screenshot({path:path.join(out,`${width}-${run.scenario}-${snapshot.seq}-${stage}.png`),fullPage:true});
  };
  for(let index=0;index<frames.length;index++){
   phase=index;at=frames[phase].at;
   if(index){await page.clock.setFixedTime(at);const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/buses');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await(await response).finished();}
   await capture('original-clock');
  }
  if(clockControl){
   // Keep the last original offer, advance only the synthetic browser clock.
   // The original GPS is still within45s. The old UI rolls its cached1368s
   // ride from~9:30 to~9:31 despite having no joined current destination.
   at+=40000;await page.clock.setFixedTime(at);const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/buses');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await(await response).finished();await capture('after-clock-advance');
  }
  for(const entry of await Promise.allSettled(assets))if(entry.status==='rejected')throw entry.reason;
  assert.deepEqual(run.errors,[]);await context.unrouteAll({behavior:'wait'});await context.close();activePage=null;
 }
 result.completed=true;
}catch(error){
 result.error=String(error.stack??error);if(activePage){result.failureBody=await activePage.locator('body').innerText().catch(()=>'unavailable');await activePage.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}throw error;
}finally{await browser.close();await fs.writeFile(path.join(out,'browser-result-original.json'),JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify(result,null,2));
