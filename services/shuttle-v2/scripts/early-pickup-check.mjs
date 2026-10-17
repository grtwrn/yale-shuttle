import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {seedTestId} from './testId.mjs';
import {parseOptions} from './canary-metrics.mjs';

const recorded=JSON.parse(await fs.readFile('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json','utf8'));
const out=process.env.EARLY_PICKUP_OUT??'pr-preview/early-pickup';
const production=process.env.EARLY_PICKUP_PRODUCTION_ASSETS==='1';
const now=recorded.server_eta.servedAt,results=[];
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true});
async function checkPickupHere(viewport) {
 const from=recorded.stop_coords[47],to={lat:recorded.stop_coords[147].lat,lon:recorded.stop_coords[147].lon-.001};
 const ctx=await browser.newContext({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500,timezoneId:'America/New_York',serviceWorkers:'block'});
 let page,phase='fresh';const errors=[];
 try {
  await seedTestId(ctx);await ctx.addInitScript(({from,to,now})=>{
   localStorage.setItem('listView','trip');
   sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Divinity/409 Prospect test stop',fromLL:from,toText:'Winchester/Sachem test destination',toLL:to,tripTime:'',expandedKey:null,savedAt:now}));
  },{from,to,now});
  page=await ctx.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date(now)});
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.hostname!=='early.test')return route.abort();
   if(u.pathname==='/api/buses') {
    const feed=structuredClone(recorded),at=await page.evaluate(()=>Date.now());
    feed.server_eta.at=phase==='stale'?at-46000:at;feed.server_eta.servedAt=at;
    for(const bus of feed.buses)bus.observed_at=at;
    return route.fulfill({json:feed});
   }
   if(u.pathname==='/api/weather')return route.fulfill({status:204});
   if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[]}});
   if(route.request().method()!=='GET')return route.abort();
   if(production){const response=await route.fetch({url:'https://yale-shuttle.fly.dev'+u.pathname+u.search});return route.fulfill({response});}
   const file=u.pathname==='/'?'/index.html':u.pathname;
   try{return route.fulfill({body:await fs.readFile('web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}
   catch{return route.fulfill({status:404});}
  });
  await page.goto('https://early.test',{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'View Red trip details',exact:true}).waitFor();
  const row=page.locator('tbody[data-route="Blue Day"][data-pickup="47"]');
  assert.equal(await row.count(),1,'Blue from the current pickup must be in the initial list');
  const legs=await row.getByTestId('journey-legs').innerText();
  assert.match(legs,/14 min/);assert.match(legs,/8 min/);
  const overview=await row.innerText();
  await page.screenshot({path:`${out}/at-pickup-${viewport.width}.png`,fullPage:true});
  for(const next of ['stale','fresh']) {
   phase=next;const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/buses');
   await page.clock.runFor(5000);await(await response).finished();
   await page.waitForFunction(unavailable=>{
    const r=document.querySelector('tbody[data-route="Blue Day"][data-pickup="47"]');
    return !!r&&r.textContent.includes('Unavailable')===unavailable;
   },next==='stale');
   assert.equal(await row.count(),1,'Availability changes must keep the pickup option visible');
  }
  await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).click();
  const directions=page.getByTitle('Walking directions to Divinity/409 Prospect',{exact:true});await directions.waitFor();
  assert.equal(new URL(await directions.getAttribute('href')).searchParams.get('destination'),`${from.lat},${from.lon}`);
  assert(await page.getByRole('button',{name:'🔔 Remind me for #44',exact:true}).isVisible());
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  results.push({viewport,origin:'at-pickup',overviewText:overview,pickup:47,initiallyVisible:true,staleOptionRemainsVisible:true,reminderStillUses44:true,pageErrors:errors});
 }catch(error){
  if(page){await page.screenshot({path:`${out}/failure-at-pickup-${viewport.width}.png`,fullPage:true,timeout:5000}).catch(()=>{});
   await fs.writeFile(`${out}/failure-at-pickup-${viewport.width}.json`,JSON.stringify({phase,error:String(error),text:await page.locator('body').innerText({timeout:1000}).catch(()=>'')},null,2)).catch(()=>{});}
  throw error;
 }finally{await ctx.unrouteAll({behavior:'wait'});await ctx.close();}
}
try {
 for(const viewport of [{width:368,height:854},{width:1702,height:1164}]) {
  for(const origin of [{name:'corridor',from:recorded.from},{name:'west',from:{lat:41.3254,lon:-72.9258}}]) {
   let phase='fresh',page;const received=[];
   const ctx=await browser.newContext({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500,timezoneId:'America/New_York',serviceWorkers:'block'});
   try {
    await seedTestId(ctx);await ctx.addInitScript(({from,to,now})=>{
     localStorage.setItem('listView','trip');
     sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Prospect/Canner test origin',fromLL:from,toText:'Rosenkranz Hall',toLL:to,tripTime:'',expandedKey:null,savedAt:now}));
    },{from:origin.from,to:recorded.to,now});
    page=await ctx.newPage();const errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install({time:new Date(now)});
    await page.route('**/*',async route=>{
     const u=new URL(route.request().url());if(u.hostname!=='early.test')return route.abort();
     if(u.pathname==='/api/buses') {
      const feed=structuredClone(recorded),at=await page.evaluate(()=>Date.now());
      // Controlled ranking case for #137: shorten Brown's calibrated ride by
      // two minutes so it clears the old third-row slack, while still taking
      // longer than walking and improving none of Red's moving legs. Live
      // forecast rows, buses, stop choices and reminder evidence stay recorded.
      if(origin.name==='corridor')feed.segments['19']['145-147'].avg-=120;
      feed.server_eta.at=phase==='stale'?at-46000:at;feed.server_eta.servedAt=at;
      for(const bus of feed.buses)bus.observed_at=at;
      if(phase==='gone')feed.buses=feed.buses.filter(b=>b.bus_name!=='#48');
      if(phase==='alt-early'||phase==='alt-gone') {
       const index=feed.server_eta.buses.findIndex(b=>b[0]==='41');
       const first=feed.server_eta.rows.filter(r=>r[0]===index&&r[1]===129).sort((a,b)=>a[2]-b[2])[0];
       assert(first);first[2]=30;first[3]=20;first[4]=90;first[7]=30;first[8]=20;
       delete feed.server_eta.distributions;
       if(phase==='alt-gone')feed.buses=feed.buses.filter(b=>b.bus_name!=='#41');
      }
      if(phase==='only-earlier') {
       const index=feed.server_eta.buses.findIndex(b=>b[0]==='48');
       feed.server_eta.rows=feed.server_eta.rows.filter(r=>r[1]!==100||(r[0]===index&&r[5]===1));
       delete feed.server_eta.distributions;
      }
      if(phase==='missing')delete feed.server_eta;
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
    await page.goto('https://early.test',{waitUntil:'domcontentloaded'});
    const row=page.locator('tbody[data-route="Blue Day"][data-pickup="100"]');await row.waitFor();
    const notice=row.getByTestId('approaching-pickup');await notice.waitFor();
    assert.match(await notice.innerText(),/Approaching #48: <1 min/);
    assert.match(await row.getByTestId('route-pickup').innerText(),/~21/);
    assert(await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).isVisible());
    if(origin.name==='corridor') {
     assert.equal(await page.locator('tbody[data-route="Brown"]').count(),0,'Redundant Brown third route belongs under Show more');
     assert(await page.getByRole('button',{name:'View Red trip details',exact:true}).isVisible());
     assert(await page.locator('tbody[data-route="Blue Day"][data-pickup="129"]').isVisible(),'Earlier farther pickup remains selectable alongside closest Blue');
    }
    const parsed=parseOptions(await page.locator('body').innerText()).find(o=>o.routeLabel==='Blue Day');
    assert.deepEqual(parsed.eta.median,[1260,1320],'Telemetry must still read the selected boarding estimate');
    const overviewText=await row.innerText();
    await page.screenshot({path:`${out}/overview-${origin.name}-${viewport.width}.png`,fullPage:true});
    await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).click();await page.getByTestId('trip-detail-panel').waitFor();
    assert(await notice.isVisible());assert(await page.getByRole('button',{name:'🔔 Remind me for #44',exact:true}).isVisible());
    assert(await page.getByRole('button',{name:origin.name==='corridor'?"🚌 I'm on #44":"🚌 I'm on it",exact:true}).isVisible());
    const phases=[];
    async function transition(next,predicate) {
     console.log(`[early-pickup] ${origin.name}:${viewport.width} ${next}`);
     phase=next;const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/buses');
     await page.clock.runFor(5000);await(await response).finished();assert.equal(received.at(-1),next);
     await page.waitForFunction(predicate);phases.push({phase:next,text:await row.innerText()});
    }
    const fresh=()=>document.querySelector('tbody[data-route="Blue Day"][data-pickup="100"] [data-testid="approaching-pickup"]')?.textContent.includes('Approaching #48');
    const absent=()=>!document.querySelector('tbody[data-route="Blue Day"][data-pickup="100"] [data-testid="approaching-pickup"]');
    const unavailable=()=>document.querySelector('tbody[data-route="Blue Day"][data-pickup="100"] tr:first-child td')?.textContent.includes('Unavailable');
    await transition('gone',absent);assert.match(await row.getByTestId('route-pickup').innerText(),/~21/);
    await transition('gone',absent);
    await page.getByTestId('bus-reporting-alerts').getByRole('alert').filter({hasText:'#48'}).waitFor();
    await transition('fresh',fresh);
    await page.getByTestId('bus-reporting-alerts').getByRole('status').filter({hasText:'#48'}).waitFor();
    if(origin.name==='west') {
     await transition('only-earlier',()=>document.querySelector('tbody[data-route="Blue Day"][data-pickup="100"] tr:first-child td')?.textContent.includes('Missed'));
     assert(await notice.isVisible());assert.match(await notice.innerText(),/Approaching #48: <1 min/);
     assert.equal(await row.locator('[aria-label="Destination arrival unavailable"]').count(),1);
     await page.screenshot({path:`${out}/only-arrival-${viewport.width}.png`,fullPage:true});
     await transition('fresh',fresh);
    }
    await transition('stale',unavailable);assert.equal(await notice.count(),0);
    assert.equal(await page.getByRole('alert').count(),0);
    await transition('fresh',fresh);
    await transition('missing',unavailable);assert.equal(await notice.count(),0);
    await transition('fresh',fresh);
    if(origin.name==='corridor') {
     await page.getByRole('button',{name:'← All routes',exact:true}).click();
     const alternative=page.locator('tbody[data-route="Blue Day"][data-pickup="129"]');await alternative.waitFor();
     const altFresh=()=>document.querySelector('tbody[data-route="Blue Day"][data-pickup="129"] [data-testid="approaching-pickup"]')?.textContent.includes('Approaching #41');
     const altAbsent=()=>!document.querySelector('tbody[data-route="Blue Day"][data-pickup="129"] [data-testid="approaching-pickup"]');
     await transition('alt-early',altFresh);
     await transition('alt-gone',altAbsent);await transition('alt-gone',altAbsent);
     await page.getByTestId('bus-reporting-alerts').getByRole('alert').filter({hasText:'#41'}).waitFor();
     await transition('alt-early',altFresh);
     await page.getByTestId('bus-reporting-alerts').getByRole('status').filter({hasText:'#41'}).waitFor();
     await transition('fresh',fresh);
    }
    let brownAfterMore;
    if(origin.name==='corridor') {
     assert.equal(await page.locator('tbody[data-route="Brown"]').count(),0,'Polling must not restore the redundant third row');
     await page.getByRole('button',{name:/^Show \d+ more routes?$/}).click();
     await page.locator('tbody[data-route="Brown"]').waitFor();
     brownAfterMore=await page.locator('tbody[data-route="Brown"]').innerText();
     await page.getByRole('button',{name:'View Brown trip details',exact:true}).click();
     await page.getByTestId('trip-detail-panel').waitFor();
     assert(await page.getByRole('button',{name:/Remind me for #310/}).isVisible());
     await page.screenshot({path:`${out}/brown-after-more-${viewport.width}.png`,fullPage:true});
    }
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);results.push({viewport,origin:origin.name,overviewText,selectedBoardingUnchanged:true,reminderStillUses44:true,approachingBusLossAndReturnAlerted:true,alternativeBusLossAndReturnAlerted:origin.name==='corridor',telemetryBoardingMedian:parsed.eta.median,brownAfterMore,phases,pageErrors:errors});
   }catch(error){
    if(page){
     await page.screenshot({path:`${out}/failure-${origin.name}-${viewport.width}.png`,fullPage:true,timeout:5000}).catch(()=>{});
     const text=await page.locator('body').innerText({timeout:1000}).catch(()=>'');
     await fs.writeFile(`${out}/failure-${origin.name}-${viewport.width}.json`,JSON.stringify({phase,received,error:String(error),text},null,2)).catch(()=>{});
    }
    throw error;
   }finally{await ctx.close();}
  }
  await checkPickupHere(viewport);
 }
 await fs.writeFile(out+'/results.json',JSON.stringify({productionAssets:production,feedCapturedAt:recorded.capturedAt,scope:'Recorded feed and controlled origins/availability phases; corridor Brown calibrated ride shortened two minutes to exercise third-row visibility; at-pickup origin/destination are public-stop proxies for report129. Not an exact report104/129/137 replay or ETA accuracy evaluation',results},null,2)+'\n');
}finally{await browser.close();}
console.log('Approaching shuttle times remain visible alongside later boarding choices; disappear with absent/stale/missing evidence; selection, reminders and telemetry retain the boarding bus.');
