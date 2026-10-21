// Exact recorded public payloads, original virtual-rider endpoints, actual SPA.
// API interception prevents production writes; optional published assets are
// retained with hashes. This checks notices, not physical ETA accuracy.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {seedTestId} from './testId.mjs';

const fixture=JSON.parse(await fs.readFile('web/src/__fixtures__/blue-night-forecast-loss-2026-10-21.json','utf8'));
const out=process.env.FORECAST_REPORTING_OUT??'pr-preview/forecast-reporting';
const published=process.env.FORECAST_REPORTING_PRODUCTION_ASSETS==='1',expected=process.env.FORECAST_REPORTING_EXPECTED_BUILD;
const base=process.env.BOT_BASE_URL??'https://forecast-reporting.test',hostname=new URL(base).hostname;
await fs.mkdir(out,{recursive:true,mode:0o700});
if(published){assert.match(expected??'',/^[a-f0-9]{12}$/);const h=await(await fetch('https://yale-shuttle.fly.dev/healthz',{signal:AbortSignal.timeout(15000)})).json();assert(h.ok&&h.build===expected);}
const manifest={},assets=new Map(),results=[],errors=[];
async function asset(route,u){
  const key=u.pathname==='/'?'/index.html':u.pathname;
  assert(key==='/index.html'||/^\/assets\/[A-Za-z0-9._-]+\.(js|css)$/.test(key)||['/manifest.webmanifest','/sw.js','/icons/icon-180.png','/icons/icon-192.png','/icons/icon-512.png','/icons/maskable-512.png'].includes(key));
  if(!assets.has(key)){assert(assets.size<24);assets.set(key,(async()=>{
    let bytes;
    if(published){const r=await fetch('https://yale-shuttle.fly.dev'+(key==='/index.html'?'/':key),{signal:AbortSignal.timeout(15000)});assert(r.ok);bytes=Buffer.from(await r.arrayBuffer());}
    else bytes=await fs.readFile('web/dist'+key);
    assert(bytes.length<2*1024*1024);const file=out+'/assets'+key;await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});manifest[key]={sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};return bytes;
  })());}
  return route.fulfill({body:await assets.get(key),contentType:key.endsWith('.js')?'text/javascript':key.endsWith('.css')?'text/css':key.endsWith('.png')?'image/png':key.endsWith('.webmanifest')?'application/manifest+json':'text/html'});
}
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true});let failure;
try{
 for(const width of [307,390,1280])for(const expanded of [false,true]){
  const ctx=await browser.newContext({viewport:{width,height:900},isMobile:width<600,hasTouch:width<600,timezoneId:'America/New_York',serviceWorkers:'block'});
  let page,phase=0,polls=0;
  try{
   await seedTestId(ctx);await ctx.addInitScript(({trip,at,expanded})=>{
    localStorage.setItem('listView','trip');sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Phelps Gate',fromLL:trip.origin,toText:'Union Station (N)',toLL:trip.destination,tripTime:'',expandedKey:expanded?'Blue Night':null,savedAt:at}));
    window.permissionRequests=0;Object.defineProperty(window,'Notification',{configurable:true,value:class{static permission='default';static async requestPermission(){window.permissionRequests++;return 'denied';}}});
   },{trip:fixture.trip,at:fixture.frames[0].modelAt,expanded});
   page=await ctx.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(`${width}/${expanded}: ${e.message}`));await page.clock.install({time:new Date(fixture.frames[0].modelAt)});
   await page.route('**/*',async route=>{
    const u=new URL(route.request().url());if(u.hostname!==hostname||route.request().method()!=='GET')return route.abort();
    if(u.pathname==='/api/buses'){polls++;return route.fulfill({json:structuredClone(fixture.frames[phase].feed)});}
    if(u.pathname==='/api/weather')return route.fulfill({status:204});
    if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[]}});
    return asset(route,u);
   });
   const row=page.locator('tbody[data-route="Blue Night"][data-pickup="98"]').first();const updates=page.getByTestId('bus-forecast-update');
   const advance=async next=>{
    phase=next;await page.clock.setSystemTime(new Date(fixture.frames[phase].modelAt));const before=polls,response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/buses');await page.clock.runFor(5500);await(await response).finished();assert(polls>before);await page.waitForTimeout(100);
   };
   await page.goto(base,{waitUntil:'domcontentloaded'});await row.waitFor();assert.equal(await row.getAttribute('data-countdown-bus'),'38','Original #38 option is visible');assert.equal(await updates.count(),0);
   await advance(1);assert.equal(await row.getAttribute('data-countdown-bus'),'38');
   await advance(2);await page.waitForFunction(()=>document.querySelector('tbody[data-route="Blue Night"][data-pickup="98"]')?.getAttribute('data-countdown-bus')==='45');assert.equal(await updates.count(),0,'One missing model stays quiet');
   await advance(3);await updates.waitFor();assert.match(await updates.innerText(),/Blue Night #38: arrival estimate unavailable/);assert.match(await updates.innerText(),/trip now shows #45/);assert.equal(await updates.getAttribute('role'),'alert');assert(!/stopped reporting|offline|left service/.test(await updates.innerText()));
   const dismiss=updates.getByRole('button',{name:'Dismiss arrival update for Blue Night #38',exact:true}),box=await dismiss.boundingBox();assert(box.width>=44&&box.height>=44);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${out}/forecast-lost-${width}-${expanded?'details':'overview'}.png`,fullPage:true});
   await dismiss.focus();await page.keyboard.press('Enter');assert.equal(await updates.count(),0);await advance(3);assert.equal(await updates.count(),0,'Dismissed loss and cached model stay quiet');
   await advance(4);assert.equal(await updates.count(),0,'Dismissed episode stays quiet through its last missing update');
   await advance(5);await updates.waitFor();assert.match(await updates.innerText(),/Blue Night #38: arrival estimate restored/);assert.equal(await updates.getAttribute('role'),'status');assert.equal(await row.getAttribute('data-countdown-bus'),'38');await page.screenshot({path:`${out}/forecast-restored-${width}-${expanded?'details':'overview'}.png`,fullPage:true});
   await advance(6);assert.equal(await updates.count(),0,'Recovery expires');assert.equal(await page.evaluate(()=>window.permissionRequests),0);assert.deepEqual(errors,[]);results.push({width,expanded,passed:true,polls,sourceFrames:fixture.frames.map(f=>f.originalFrameSHA256)});
  }catch(error){if(page){await page.screenshot({path:`${out}/failure-${width}-${expanded}.png`,fullPage:true,timeout:5000}).catch(()=>{});await fs.writeFile(`${out}/failure-${width}-${expanded}.json`,JSON.stringify({error:String(error),phase,text:await page.locator('body').innerText().catch(()=>''),polls},null,2),{flag:'wx',mode:0o600}).catch(()=>{});}throw error;}
  finally{await ctx.unrouteAll({behavior:'wait'});await ctx.close();}
 }
}catch(error){failure=error;}finally{await browser.close();await fs.writeFile(out+'/result.json',JSON.stringify({ok:!failure,published,expected,cases:results.length,results,errors,assets:manifest,error:failure?String(failure):undefined,scope:fixture.scope},null,2)+'\n',{flag:'wx',mode:0o600});}
if(failure)throw failure;
console.log('Arrival estimate availability: six phone/desktop overview/detail cases show #38 loss, #45 replacement, dismissal and #38 recovery without a false reporting-loss claim.');
