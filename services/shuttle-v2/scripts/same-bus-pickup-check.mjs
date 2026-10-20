// Report #143's captured Blue Day bus/forecast, with declared stop-coordinate
// proxy endpoints. This checks route choices, not physical arrival accuracy.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {seedTestId} from './testId.mjs';

export async function checkSameBusPickup() {
  const service=process.cwd(),out=process.env.SAME_BUS_PICKUP_OUT??'pr-preview/same-bus-pickup';
  const production=process.env.SAME_BUS_PICKUP_PRODUCTION_ASSETS==='1';
  const expected=process.env.SAME_BUS_PICKUP_EXPECTED_BUILD;
  if(production)assert.match(expected??'',/^[a-f0-9]{12}$/);
  const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
  const fixture=await read('web/src/__fixtures__/blue-same-bus-pickup-2026-10-20.json');
  const base=await read('web/src/__fixtures__/buses-payload.json');
  await fs.mkdir(out,{recursive:true,mode:0o700});
  if(production){const r=await fetch('https://yale-shuttle.fly.dev/healthz',{signal:AbortSignal.timeout(15000)});assert(r.ok);const h=await r.json();assert(h.ok&&h.build===expected);}
  const assets=new Map(),manifest={},results=[];
  async function asset(route,u) {
    const key=u.pathname==='/'?'/index.html':u.pathname;
    assert(key==='/index.html'||/^\/assets\/[A-Za-z0-9._-]+\.(js|css)$/.test(key)||['/manifest.webmanifest','/sw.js','/icons/icon-180.png','/icons/icon-192.png','/icons/icon-512.png','/icons/maskable-512.png'].includes(key));
    let pending=assets.get(key);
    if(!pending){assert(assets.size<20);pending=(async()=>{
      let bytes;if(production){const r=await fetch('https://yale-shuttle.fly.dev'+(key==='/index.html'?'/':key),{signal:AbortSignal.timeout(15000)});assert(r.ok);bytes=Buffer.from(await r.arrayBuffer());}else bytes=await fs.readFile(service+'/web/dist'+key);
      assert(bytes.length<2*1024*1024);const file=out+'/assets'+key;await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});manifest[key]={sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};return bytes;
    })();assets.set(key,pending);}
    return route.fulfill({body:await pending,contentType:key.endsWith('.js')?'text/javascript':key.endsWith('.css')?'text/css':key.endsWith('.png')?'image/png':key.endsWith('.webmanifest')?'application/manifest+json':'text/html'});
  }
  const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true});
  let failure;
  try {
    for(const width of [368,1280])for(const expanded of [false,true]) {
      const ctx=await browser.newContext({viewport:{width,height:854},isMobile:width<500,hasTouch:width<500,timezoneId:'America/New_York',serviceWorkers:'block'});
      let page,phase='fresh';const errors=[],received=[];
      try {
        await seedTestId(ctx);await ctx.addInitScript(({from,to,now,expanded})=>{
          localStorage.setItem('listView','trip');sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'LEPH/60 College',fromLL:from,toText:'Prospect/Canner',toLL:to,tripTime:'',expandedKey:expanded?'Blue Day':null,savedAt:now}));
        },{from:fixture.from,to:fixture.to,now:fixture.server_eta.servedAt,expanded});
        page=await ctx.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
        await page.clock.install({time:new Date(fixture.server_eta.servedAt)});
        await page.route('**/*',async route=>{
          const u=new URL(route.request().url());if(u.hostname!=='same-bus.test'||route.request().method()!=='GET')return route.abort();
          if(u.pathname==='/api/buses'){
            const feed={...base,...structuredClone(fixture)},clock=await page.evaluate(()=>Date.now());
            feed.server_eta.at=phase==='stale'?clock-46000:clock;feed.server_eta.servedAt=clock;
            for(const b of feed.buses)b.observed_at=clock;
            received.push(phase);return route.fulfill({json:feed});
          }
          if(u.pathname==='/api/weather')return route.fulfill({status:204});
          if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[]}});
          return asset(route,u);
        });
        await page.goto('https://same-bus.test',{waitUntil:'domcontentloaded'});
        const rows=page.locator('tbody[data-route="Blue Day"]'),row=rows.first();await row.waitFor();
        // Positive control: this is the real closest pickup and a visible bus.
        assert.equal(await row.getAttribute('data-pickup'),'72');
        assert.equal(await row.getAttribute('data-countdown-bus'),'45');
        assert.equal(await row.getAttribute('data-alight'),'100','Closest pickup must share the better onward exit');
        assert.equal(await rows.count(),1,'Walking farther for this same onward visit cannot arrive sooner');
        assert(!/Arrive sooner/.test(await row.innerText()));
        assert(!/🚶/.test(await row.getByTestId('journey-legs').innerText()));
        const overview=await row.innerText();
        if(!expanded)await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).click();
        await page.getByTestId('trip-detail-panel').waitFor();
        assert(await page.getByTitle('Walking directions to LEPH/60 College',{exact:true}).isVisible());
        assert.match(await page.getByTestId('trip-ride-stops').innerText(),/GET OFF\s*Prospect\s*\/\s*Canner/);
        const phases=[];
        for(const next of ['fresh','stale','fresh']) {
          phase=next;const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/buses');
          await page.clock.runFor(5500);await(await response).finished();
          await page.waitForFunction(stale=>{
            const r=document.querySelector('tbody[data-route="Blue Day"][data-pickup="72"]');return !!r&&r.textContent.includes('Unavailable')===stale;
          },next==='stale');
          assert.equal(received.at(-1),next);assert.equal(await row.getAttribute('data-alight'),'100');assert.equal(await rows.count(),1);phases.push(next);
        }
        assert(await page.getByRole('button',{name:'🔔 Remind me for #45',exact:true}).isVisible());
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
        await page.screenshot({path:`${out}/pickup-${width}-${expanded?'expanded':'overview'}.png`,fullPage:true});
        results.push({width,expanded,boardStopId:72,alightStopId:100,bus:'45',overview,phases,pageErrors:errors});
      }catch(error){if(page){await page.screenshot({path:`${out}/failure-${width}-${expanded}.png`,fullPage:true,timeout:5000}).catch(()=>{});await fs.writeFile(`${out}/failure-${width}-${expanded}.json`,JSON.stringify({phase,error:String(error),text:await page.locator('body').innerText().catch(()=>'')},null,2),{flag:'wx',mode:0o600}).catch(()=>{});}throw error;}
      finally{await ctx.unrouteAll({behavior:'wait'});await ctx.close();}
    }
  }catch(error){failure=error;}
  finally{await browser.close();await fs.writeFile(out+'/result.json',JSON.stringify({ok:!failure,cases:results.length,production,expected,results,assets:manifest,error:failure?String(failure):undefined,scope:'Captured public forecast with proxy endpoints; route-choice regression, not physical arrival accuracy.'},null,2)+'\n',{flag:'wx',mode:0o600});}
  if(failure)throw failure;
  console.log('Same-bus pickup: four phone/desktop cases keep the closest pickup and better onward exit through fresh/stale/recovery updates.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await checkSameBusPickup();
