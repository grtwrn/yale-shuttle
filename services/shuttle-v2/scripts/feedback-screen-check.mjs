import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {seedTestId} from './testId.mjs';

const recorded=JSON.parse(await fs.readFile('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json','utf8'));
const out=process.env.FEEDBACK_SCREEN_OUT??'pr-preview/feedback-screen';
const production=process.env.FEEDBACK_SCREEN_PRODUCTION_ASSETS==='1',now=recorded.server_eta.servedAt,results=[];
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true});
try {
 for(const width of [368,1702]) {
  let phase='fresh',responseStatus=503,page;const submissions=[],errors=[];
  const ctx=await browser.newContext({viewport:{width,height:width<500?854:1164},isMobile:width<500,hasTouch:width<500,timezoneId:'America/New_York',serviceWorkers:'block'});
  try {
   await seedTestId(ctx);await ctx.addInitScript(({from,to,now})=>{
    localStorage.setItem('listView','trip');
    sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Private diagnostic origin',fromLL:from,toText:'Rosenkranz Hall',toLL:to,tripTime:'',expandedKey:null,savedAt:now}));
   },{from:recorded.from,to:recorded.to,now});
   page=await ctx.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
   await page.clock.install({time:new Date(now)});await page.clock.pauseAt(new Date(now+1000));
   await page.route('**/*',async route=>{
    const u=new URL(route.request().url());if(u.hostname!=='feedback-screen.test')return route.abort();
    if(u.pathname==='/api/buses'){
     const feed=structuredClone(recorded),at=await page.evaluate(()=>Date.now());
     feed.server_eta.at=phase==='stale'?at-46000:at;feed.server_eta.servedAt=at;
     for(const bus of feed.buses)bus.observed_at=at;
     return route.fulfill({json:feed});
    }
    if(u.pathname==='/api/report'){submissions.push(route.request().postDataJSON());return route.fulfill({status:responseStatus,json:{id:900+submissions.length}});}
    if(u.pathname==='/api/weather')return route.fulfill({status:204});
    if(u.pathname.startsWith('/api/'))return route.fulfill({json:{results:[],reports:[]}});
    if(route.request().method()!=='GET')return route.abort();
    if(production){const response=await route.fetch({url:'https://yale-shuttle.fly.dev'+u.pathname+u.search});return route.fulfill({response});}
    const file=u.pathname==='/'?'/index.html':u.pathname;
    try{return route.fulfill({body:await fs.readFile('web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}
    catch{return route.fulfill({status:404});}
   });
   await page.goto('https://feedback-screen.test',{waitUntil:'domcontentloaded'});
   const closest=page.locator('tbody[data-route="Blue Day"][data-pickup="100"]');await closest.waitFor();
   const initialBoard=(await closest.locator(':scope > tr:first-child > td').nth(0).innerText()).replace(/\s+/g,' ').trim();
   const initialNext=(await closest.getByTestId('route-next-arrival').innerText()).replace(/\s+/g,' ').trim();
   const open=async()=>{await page.getByRole('button',{name:'💬 Send feedback',exact:true}).click();await page.getByRole('textbox',{name:'Feedback',exact:true}).waitFor();};
   const send=async text=>{
    const count=submissions.length;await page.getByRole('textbox',{name:'Feedback',exact:true}).fill(text);
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/report');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await response;
    assert.equal(submissions.length,count+1);return submissions.at(-1);
   };
   async function transition(next){
    phase=next;const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/buses');
    await page.clock.runFor(5000);await(await response).finished();await page.clock.runFor(1000);
    await page.waitForFunction(stale=>{
     const text=document.querySelector('tbody[data-route="Blue Day"] tr:first-child td')?.textContent??'';
     return stale?text.includes('Unavailable'):!text.includes('Unavailable');
    },next==='stale');
   }
   await open();
   await transition('stale');
   const failed=await send('Fixture: the closer pickup disappeared while I was watching.');
   await page.getByRole('alert').getByText("Couldn't send — try again",{exact:true}).waitFor();
   assert(failed.screen,'Feedback must include the opening-time screen evidence');
   assert.equal(failed.screen.view,'trip');assert.equal(failed.screen.tripDetail,false);
   const selected=failed.screen.rows.find(r=>r.route==='Blue Day'&&r.boardStopId===100);
   assert(selected);assert.equal(selected.busName,'44');assert.equal(selected.pickupChoice,'closest-stop');
   assert.equal(selected.board,initialBoard);assert.equal(selected.next,initialNext);
   assert.match(selected.approaching,/Approaching #48: <1 min/);
   assert(failed.screen.rows.some(r=>r.route==='Blue Day'&&r.boardStopId===129&&r.pickupChoice==='arrive-sooner'));
   assert(!JSON.stringify(failed.screen).includes('Private diagnostic origin'));
   const allowed=['mode','route','boardStopId','alightStopId','busName','stopsAhead','pickupChoice','board','next','arrive','legs','approaching'];
   for(const row of failed.screen.rows)assert(Object.keys(row).every(key=>allowed.includes(key)));
   assert.match(failed.screen.build,/^[A-Za-z0-9_-]{4,24}$/);assert.notEqual(failed.screen.build,'dev');
   await transition('fresh');responseStatus=200;
   const retried=await send('Fixture: the closer pickup disappeared while I was watching.');assert.deepEqual(retried.screen,failed.screen);
   await page.getByRole('button',{name:'💬 Send feedback',exact:true}).waitFor();
   await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).click();await page.getByTestId('trip-detail-panel').waitFor();
   await open();assert(await page.getByText('Includes the trip details shown when you opened feedback.',{exact:true}).isVisible());
   const detail=await send('Fixture: selected the closest pickup.');
   assert.equal(detail.screen.tripDetail,true);assert.equal(detail.screen.rows.length,1);assert.equal(detail.screen.rows[0].boardStopId,100);assert.equal(detail.screen.rows[0].busName,'44');
   assert(detail.screen.capturedAt>failed.screen.capturedAt);
   await page.getByRole('button',{name:'← All routes',exact:true}).click();
   await page.getByRole('button',{name:'View Blue Day trip details from Whitney/Canner',exact:true}).click();await page.getByTestId('trip-detail-panel').waitFor();
   assert(await page.getByRole('button',{name:'🔔 Remind me for #48',exact:true}).isVisible());
   await open();const alternative=await send('Fixture: selected the earlier pickup.');
   assert.equal(alternative.screen.rows.length,1);assert.equal(alternative.screen.rows[0].boardStopId,129);assert.equal(alternative.screen.rows[0].busName,'48');
   await transition('stale');await open();const unavailable=await send('Fixture: no fresh arrival available.');
   assert.equal(unavailable.screen.rows[0].board,'Unavailable');assert.equal(unavailable.screen.rows[0].next,'—');assert.equal(unavailable.screen.rows[0].busName,undefined);
   await transition('fresh');await open();await page.getByRole('button',{name:'Cancel',exact:true}).click();
   await page.getByRole('button',{name:'Clear',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-testid="route-timing-table"]'));
   await open();const empty=await send('Fixture: general feedback after clearing the trip.');
   assert.deepEqual(empty.screen.rows,[]);assert.equal(empty.screen.tripDetail,false);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
   await page.screenshot({path:`${out}/after-${width}.png`,fullPage:true});
   results.push({width,submissions,pageErrors:errors});console.log(`[feedback-screen] ${width}: frozen retries, distinct pickups, stale evidence and cleared trip passed`);
  }catch(error){
   if(page){await page.screenshot({path:`${out}/failure-${width}.png`,fullPage:true,timeout:5000}).catch(()=>{});await fs.writeFile(`${out}/failure-${width}.json`,JSON.stringify({phase,error:String(error),submissions,text:await page.locator('body').innerText().catch(()=>'')},null,2)).catch(()=>{});}
   throw error;
  }finally{await ctx.close();}
 }
 await fs.writeFile(out+'/results.json',JSON.stringify({productionAssets:production,scope:'Actual SPA with intercepted requests and controlled feed availability; verifies submitted diagnostic context, not ETA accuracy',results},null,2)+'\n');
}finally{await browser.close();}
