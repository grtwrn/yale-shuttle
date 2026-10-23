// Existing built app + retained feed, with declared DOM fault injection.
// This tests the observer, not a historical reconstruction or physical service.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {seedTestId} from './testId.mjs';
import {attach} from './rider-watch/runner.mjs';
const out=process.env.SERVICE_DISCLOSURE_OUT??'pr-preview/service-disclosure-watch';
const recorded=JSON.parse(await fs.readFile('web/src/__fixtures__/purple-union-on-demand-2026-10-23.json','utf8'));
const originalAt=recorded.server_eta.servedAt,results=[],errors=[];
function shifted(value,delta,key=''){
 if(Array.isArray(value))return value.map(v=>shifted(v,delta));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,shifted(v,delta,k)]));
 if(typeof value==='number'&&['observed_at','at','servedAt','expires_at','validUntil','last_at'].includes(key))return value+delta;
 if(typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&/(?:_at|_since)$/.test(key)){
  const at=Date.parse(value.endsWith('Z')?value:value+'Z');if(Number.isFinite(at))return new Date(at+delta).toISOString().replace(/Z$/,'');
 }
 return value;
}
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true});
try{
 for(const width of [390,1280])for(const fault of ['missing-disclosure','missing-phone','healthy-without-marker']){
  const context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500,timezoneId:width<500?'UTC':'Asia/Tokyo',serviceWorkers:'block'});
  let page,rider,lastResponse,at=originalAt;
  try{
   await seedTestId(context);
   await context.addInitScript(({from,to,at})=>{
    localStorage.setItem('listView','trip');sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Union Station (S)',fromLL:from,toText:'Building 400',toLL:to,tripTime:'',expandedKey:null,savedAt:at}));
   },{from:recorded.stop_coords['122'],to:recorded.stop_coords['22'],at});
   page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
   page.on('response',r=>{if(new URL(r.url()).pathname==='/api/buses')lastResponse=r;});
   await page.clock.install({time:new Date(at)});
   await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.hostname!=='service-watch.test')return route.abort();
    if(url.pathname==='/api/buses'){
     const body=Buffer.from(JSON.stringify(shifted(recorded,at-originalAt))),sha=createHash('sha256').update(body).digest('hex');
     return route.fulfill({body,contentType:'application/json',headers:{'x-shuttle-snapshot':JSON.stringify({v:1,snapshotId:sha,sha256:sha,bytes:body.length,build:'bae7256b1544',modelAt:at,servedAt:at})}});
    }
    if(url.pathname==='/api/weather')return route.fulfill({status:204});
    if(url.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[],routes:[]}});
    if(route.request().method()!=='GET')return route.abort();
    const file=url.pathname==='/'?'/index.html':url.pathname;
    try{return route.fulfill({body:await fs.readFile('web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404});}
   });
   await page.goto('https://service-watch.test',{waitUntil:'domcontentloaded'});await page.getByTestId('route-timing-table').waitFor();
   const more=page.getByRole('button',{name:/Show \d+ more route/});if(await more.isVisible())await more.click();
   const row=page.locator('tbody[data-route="Purple"][data-pickup="122"]');await row.getByText('On request',{exact:true}).waitFor();
   await row.getByRole('button',{name:'View Purple trip details',exact:true}).click();await page.getByTestId('trip-stop-list').waitFor();
   await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now())+1000));
   await row.evaluate((el,fault)=>{
    if(fault==='missing-phone'){el.querySelector('a[href^="tel:"]').remove();return;}
    el.removeAttribute('data-pickup-service');
    if(fault==='missing-disclosure')el.innerHTML='<tr><td>Purple</td><td><span data-testid="pickup-range">About &lt;1 min</span></td><td>~33 min</td><td>3:36p – 3:50p</td></tr>';
   },fault);
   assert(lastResponse);
   const initialFeed=await lastResponse.json(),directory=out+'/'+fault+'-'+width;
   rider=await attach({page,ctx:context,autoTick:false,clockNow:()=>at,initialFeed,initialFeedAt:at,initialResponse:lastResponse,outputDir:directory,
    initialLine:{label:'Purple',busRouteIds:[10]},initialTrip:{kind:'fixed',origin:{label:'Union Station (S)',...recorded.stop_coords['122'],stopId:122},destination:{display_name:'Building 400',...recorded.stop_coords['22'],stopId:22}}});
   if(fault!=='healthy-without-marker'){
    assert.equal(rider.status().run.phase,'waiting');assert.equal(rider.status().run.excludeAccuracy,true);
    at+=10000;
    await page.evaluate(()=>fetch('/api/buses',{headers:{'x-anon-id':localStorage.getItem('shuttle-anon-id')}}).then(r=>r.json()));
    const until=Date.now()+5000;while(rider.status().feedAt!==at&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
    assert.equal(rider.status().feedAt,at);await rider.tick();
   }
   const journeys=(await fs.readFile(directory+'/journeys.jsonl','utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
   const events=(await fs.readFile(directory+'/events.jsonl','utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),alerts=events.filter(e=>e.kind==='candidate-pickup-service');
   assert.equal(journeys.length,1);assert.equal(journeys[0].result,'on-demand-request-required-excluded');assert.equal(journeys[0].excludeAccuracy,true);assert.equal(journeys[0].boardedAt,undefined);
   assert.equal(alerts.length,fault==='healthy-without-marker'?0:1);assert(!events.some(e=>e.kind==='harness-error'));
   if(alerts.length){assert.equal(alerts[0].detail.observations.length,2);assert.notEqual(alerts[0].detail.observations[0].feedResponse.id,alerts[0].detail.observations[1].feedResponse.id);}
   await page.screenshot({path:out+'/'+fault+'-'+width+'.png',fullPage:true});results.push({width,fault,alerts:alerts.length,retainedObservations:alerts[0]?.detail.observations.length??0,excluded:true});
  }finally{await rider?.stop();await page?.close();await context.close();}
 }
 assert.deepEqual(errors,[]);
 await fs.writeFile(out+'/result.json',JSON.stringify({ok:true,results,errors,productionRequests:0,scope:'Current built app with declared DOM faults and clock-shifted retained feed; no historical DOM reconstruction, physical service or ETA-accuracy claim.'},null,2)+'\n');
 console.log(JSON.stringify({ok:true,runs:results.length,results,productionRequests:0}));
}finally{await browser.close();}
