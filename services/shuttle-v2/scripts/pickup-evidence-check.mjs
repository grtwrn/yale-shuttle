// Bounded built-SPA regression. Missing rows and the earlier #38 visit are
// constructed from the Sep 28 capture, not asserted to be report history.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const service=process.cwd(),dist=process.env.PICKUP_EVIDENCE_DIST??path.join(service,'web/dist');
const output=process.env.PICKUP_EVIDENCE_OUT;
if(output)await fs.mkdir(output,{recursive:true,mode:0o700});
const fixture=JSON.parse(await fs.readFile('web/src/__fixtures__/blue-pickup-2026-09-28.json','utf8'));
const base=JSON.parse(await fs.readFile('web/src/__fixtures__/buses-payload.json','utf8'));
const names=Object.fromEntries(JSON.parse(await fs.readFile('src/server/__fixtures__/stops.json','utf8')).map(s=>[s.id,s.name]));
const now=fixture.server_eta.servedAt,results=[];
const full=structuredClone(fixture.server_eta);
const bus=full.buses.findIndex(b=>b[0]==='38');
for(const row of full.rows)if(row[0]===bus)for(const col of [2,3,4,7,8])row[col]+=600;
function wire(kind){
  if(kind==='invalid')return undefined;
  const result=structuredClone(full);
  const kept=result.rows.map((row,i)=>({row,i})).filter(({row})=>kind==='pickup'?row[1]!==100:
    kind==='line'?result.buses[row[0]][1]!=='Blue Day':true);
  result.rows=kept.map(x=>x.row);
  if(result.distributions)result.distributions=kept.map(x=>result.distributions[x.i]);
  return result;
}
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH||'/usr/bin/chromium',
  args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try{
  for(const width of [368,1280])for(const scenario of ['cold-pickup','warm-loss','cold-line','farther-selected','moving-live','moving-pickup','moving-line','moving-invalid','manual-pickup']){
    const moving=scenario.startsWith('moving-'),deliverGeo=moving||scenario==='manual-pickup';
    const label=`${width}-${scenario}`,errors=[],feed={...base,...structuredClone(fixture),stop_names:names,
      server_eta:wire(scenario==='cold-pickup'?'pickup':scenario==='cold-line'?'line':'full')};
    const ctx=await browser.newContext({viewport:{width,height:854},isMobile:width===368,hasTouch:width===368,
      timezoneId:'America/New_York',serviceWorkers:'block',permissions:deliverGeo?['geolocation']:[]});
    let page;
    try{
      await seedTestId(ctx);
      await ctx.addInitScript(({from,to,now,moving,deliverGeo})=>{
        localStorage.setItem('listView','trip');
        sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:moving?'Current location':'517 Prospect Street',fromLL:from,
          toText:'Rosenkranz Hall',toLL:to,tripTime:'',expandedKey:null,savedAt:now}));
        if(deliverGeo){
          let id=1,point=from;const watchers=new Map();
          const fix=()=>({coords:{latitude:point.lat,longitude:point.lon,accuracy:5,altitude:null,altitudeAccuracy:null,heading:null,speed:null},timestamp:Date.now()});
          Object.defineProperty(navigator,'geolocation',{value:{
            getCurrentPosition(ok){queueMicrotask(()=>ok(fix()));},
            watchPosition(ok){const key=id++;watchers.set(key,ok);queueMicrotask(()=>ok(fix()));return key;},
            clearWatch(key){watchers.delete(key);},
          }});
          window.moveRider=next=>{point=next;for(const ok of watchers.values())ok(fix());return watchers.size;};
        }
      },{...fixture,now,moving,deliverGeo});
      page=await ctx.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
      await page.clock.install({time:new Date(now)});
      await page.route('**/*',async route=>{
        const u=new URL(route.request().url());
        if(u.hostname!=='pickup-evidence.test')return route.abort();
        if(u.pathname==='/api/buses')return route.fulfill({json:feed});
        if(u.pathname==='/api/weather')return route.fulfill({status:204});
        if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[]}});
        const file=u.pathname==='/'?'/index.html':u.pathname;
        try{return route.fulfill({body:await fs.readFile(dist+file),contentType:file.endsWith('.js')?'text/javascript':
          file.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404});}
      });
      await page.goto('https://pickup-evidence.test');
      const closest=page.locator('tbody[data-route="Blue Day"][data-pickup="100"]');
      const farther=page.locator('tbody[data-route="Blue Day"][data-pickup="129"]');
      const unavailable=async()=>{
        await closest.getByText('Unavailable',{exact:true}).waitFor();
        assert.equal(await closest.getAttribute('data-pickup-choice'),'closest-stop');
        assert.equal(await closest.locator('[data-testid="pickup-range"]').count(),0);
        assert.equal(await closest.getByLabel('Destination arrival unavailable',{exact:true}).count(),1);
        assert(!(await closest.innerText()).includes('Missed'));
      };
      const recovered=async()=>{await closest.locator('[data-testid="pickup-range"]').waitFor();
        assert.equal(await closest.getByText('Unavailable',{exact:true}).count(),0);};
      if(deliverGeo){
        await recovered();await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).click();
        const directions=page.getByTitle('Walking directions to Prospect/Canner',{exact:true});await directions.waitFor();
        const legs=closest.getByTestId('journey-legs'),exit=await closest.getAttribute('data-alight');
        assert((await legs.innerText()).trim().startsWith('🚶'),'The rider must start with a nonzero walk');
        const kind=moving?scenario.slice('moving-'.length):'pickup';
        feed.server_eta=wire(kind);await page.clock.runFor(5500);
        if(kind!=='live')await unavailable();
        const delivered=await page.evaluate(point=>window.moveRider(point),fixture.stop_coords[100]);
        assert(delivered>0,'A registered GPS watch must receive the move');
        await page.clock.runFor(5500);
        if(moving)await page.waitForFunction(()=>document.querySelector('tbody[data-route="Blue Day"][data-pickup="100"] [data-testid="journey-legs"]')?.textContent?.trim().startsWith('🚌'));
        else assert((await legs.innerText()).trim().startsWith('🚶'),'A manually chosen origin must remain fixed');
        if(kind!=='live')await unavailable();
        assert.equal(await closest.getAttribute('data-alight'),exit);assert(await directions.isVisible());
        if(output)await page.screenshot({path:path.join(output,label+'-at-pickup.png'),fullPage:true});
        feed.server_eta=wire('full');await page.clock.runFor(5500);await recovered();
        if(moving)assert((await legs.innerText()).trim().startsWith('🚌'),'Recovery retains walking progress');
        else assert((await legs.innerText()).trim().startsWith('🚶'),'Recovery retains the explicit origin');
        assert.equal(await closest.getAttribute('data-alight'),exit);assert(await directions.isVisible());
      }else if(scenario==='cold-pickup'){
        await unavailable();await farther.and(page.locator('[data-pickup-choice="more-walking"]')).waitFor();assert((await farther.innerText()).includes('More walking'));
        assert.equal(await farther.getByText('Arrive sooner',{exact:true}).count(),0);
        if(output)await page.screenshot({path:path.join(output,label+'-unavailable.png'),fullPage:true});
        await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).click();
        await page.getByTitle('Walking directions to Prospect/Canner',{exact:true}).waitFor();
        assert.equal(await page.getByRole('button',{name:"I'm on it",exact:false}).count(),0,'An untimed pickup with no bus identity cannot start an empty ride');
        await page.getByTitle('Back to all routes',{exact:true}).click();
        feed.server_eta=wire('full');await page.clock.runFor(5500);await recovered();
        await farther.and(page.locator('[data-pickup-choice="arrive-sooner"]')).waitFor();assert((await farther.innerText()).includes('Arrive sooner'));
      }else if(scenario==='warm-loss'){
        await recovered();await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).click();
        const pickup=page.getByTitle('Walking directions to Prospect/Canner',{exact:true});await pickup.waitFor();
        feed.server_eta=wire('pickup');await page.clock.runFor(5500);await unavailable();
        assert(await pickup.isVisible());
        assert.equal(await page.getByRole('button',{name:"I'm on it",exact:false}).count(),1,'Retain the manual escape hatch for the last known bus');
        feed.server_eta=wire('full');await page.clock.runFor(5500);await recovered();assert(await pickup.isVisible());
      }else if(scenario==='cold-line'){
        await unavailable();assert.equal(await farther.count(),0);
        await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).click();
        await page.getByTitle('Walking directions to Prospect/Canner',{exact:true}).waitFor();
        assert.equal(await page.getByRole('button',{name:"I'm on it",exact:false}).count(),0);
        await page.getByTitle('Back to all routes',{exact:true}).click();
        feed.server_eta=wire('full');await page.clock.runFor(5500);await recovered();
        await farther.and(page.locator('[data-pickup-choice="arrive-sooner"]')).waitFor();assert((await farther.innerText()).includes('Arrive sooner'));
        await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).click();
        await page.getByTitle('Walking directions to Prospect/Canner',{exact:true}).waitFor();
      }else{
        await page.getByRole('button',{name:'View Blue Day trip details from Whitney/Canner',exact:true}).click();
        const pickup=page.getByTitle('Walking directions to Whitney/Canner',{exact:true});await pickup.waitFor();
        feed.server_eta=wire('line');await page.clock.runFor(5500);
        await farther.getByText('Unavailable',{exact:true}).waitFor();assert(await pickup.isVisible());
        feed.server_eta=wire('full');await page.clock.runFor(5500);
        await farther.locator('[data-testid="pickup-range"]').waitFor();assert(await pickup.isVisible());
        assert.equal(await closest.count(),0,'recovery must not change the selected pickup');
      }
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
      results.push({label,ok:true});
    }catch(error){
      results.push({label,ok:false,error:String(error),pageErrors:errors});
      if(output&&page){await page.screenshot({path:path.join(output,label+'-failure.png'),fullPage:true}).catch(()=>{});
        await fs.writeFile(path.join(output,label+'-failure.txt'),await page.locator('body').innerText());}
    }finally{if(page)await page.unrouteAll({behavior:'wait'});await ctx.close();}
  }
}finally{await browser.close();}
if(output)await fs.writeFile(path.join(output,'result.json'),JSON.stringify({at:new Date().toISOString(),dist,results},null,2)+'\n',{mode:0o600});
assert(results.every(r=>r.ok),JSON.stringify(results.filter(r=>!r.ok)));
console.log('Pickup evidence: eighteen phone/desktop cases retain closest-stop geometry, withhold missing ETAs, recover alternatives and preserve selected pickups; live walking progress survives forecast loss and explicit origins stay fixed.');
