import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { completeArrival } from './rider-watch/complete-arrival.mjs';
import { seedTestId } from './testId.mjs';
const { attach } = await import(process.env.RIDER_RECOVERY_RUNNER ?? './rider-watch/runner.mjs');

// Real Playwright actionability over a modeled arrival screen. No network,
// real journey, physical service or ETA accuracy is evaluated here.
const out=process.env.BOT_OUT??path.join(os.tmpdir(),'rider-completion-'+Date.now());
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??chromium.executablePath(),args:['--no-sandbox','--disable-gpu']});
const results=[];
let navigationRecovery;
const showPrompt=page=>page.evaluate(()=>{
 const dialog=document.createElement('div');dialog.setAttribute('role','alertdialog');dialog.setAttribute('aria-modal','true');
 dialog.style.cssText='position:fixed;inset:0;z-index:1000;background:white;padding:30px';
 dialog.innerHTML='<h2>Get off here</h2><button>Got it</button>';
 dialog.querySelector('button').onclick=()=>{window.dismissals++;dialog.remove();};document.body.append(dialog);
});
try{
 for(const timing of ['already-visible','during-screenshot']){
  const context=await browser.newContext({viewport:{width:390,height:844}});
  try{
   const page=await context.newPage();page.setDefaultTimeout(5000);
   await page.route('**/*',route=>route.abort());
   await page.setContent('<!doctype html><h1>Arriving at Target</h1><button id="done" onclick="window.completions++">Done</button><script>window.completions=0;window.dismissals=0;</script>');
   if(timing==='already-visible')await showPrompt(page);
   await completeArrival(page,async()=>{
    await page.screenshot({path:path.join(out,timing+'.png')});
    if(timing==='during-screenshot')await showPrompt(page);
   });
   const actual=await page.evaluate(()=>({completions:window.completions,dismissals:window.dismissals}));
   assert.deepEqual(actual,{completions:1,dismissals:1});
   // Completion's temporary handler must not acknowledge a later prompt.
   await showPrompt(page);let blocked=false;
   try{await page.getByRole('button',{name:'Done',exact:true}).click({timeout:300});}catch(error){blocked=error.name==='TimeoutError';}
   assert(blocked,'Later prompts must no longer be handled by completion');
   assert.deepEqual(await page.evaluate(()=>({completions:window.completions,dismissals:window.dismissals})),actual);
   results.push({timing,...actual,temporaryHandlerRemoved:true});
  }finally{await context.close();}
 }
 // A real failed browser navigation reproduces the idle-rider transport
 // failure. The replacement uses a modeled planner, not production or an
 // independent physical arrival. The runner and its lifecycle are real.
 const feed={buses:[{bus_name:'#317',route_id:3,lat:41.3271,lon:-72.9298,at_stop_id:11,stationary:true}],
  routes:{3:[11,48,72]},stop_names:{11:'344 Winchester',48:'Division / Prospect',72:'LEPH / 60 College'},
  stop_coords:{11:{lat:41.3271,lon:-72.9298},48:{lat:41.324769,lon:-72.923522},72:{lat:41.30378,lon:-72.93261}}};
 const trip={kind:'fixed',origin:{label:'Division / Prospect',...feed.stop_coords[48],stopId:48},
  destination:{display_name:'LEPH / 60 College',...feed.stop_coords[72],stopId:72}};
 const html=`<!doctype html><h1>Modeled planner</h1><input placeholder="Where do you want to go?" onkeydown="if(event.key==='Enter')sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({toLL:{lat:41.30378,lon:-72.93261}}))"><button>View Red trip details</button>`;
 let failedNavigations=0;
 for(const generation of ['failed','replacement']){
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  let watcher,abortNext=false;
  try{
   await seedTestId(context);const page=await context.newPage();page.setDefaultTimeout(5000);
   await page.route('**/*',route=>{
    const u=new URL(route.request().url());if(u.hostname!=='rider-recovery.test')return route.abort();
    if(u.pathname==='/api/buses')return route.fulfill({json:feed});
    if(u.pathname!=='/')return route.abort();
    if(abortNext){abortNext=false;failedNavigations++;return route.abort('timedout');}
    return route.fulfill({body:html,contentType:'text/html'});
   });
   await page.goto('https://rider-recovery.test',{waitUntil:'domcontentloaded'});
   const dir=path.join(out,'navigation-'+generation),initialAt=Date.now()-1000;
   watcher=await attach({page,ctx:context,autoTick:false,initialFeed:generation==='failed'?{...feed,buses:[]}:feed,
    initialFeedAt:initialAt,outputDir:dir,allowedLabels:['Red'],fixedTrip:trip});
   if(generation==='failed'){
    await page.evaluate(()=>fetch('/api/buses',{headers:{'x-anon-id':localStorage.getItem('shuttle-anon-id')}}).then(r=>r.json()));
    const deadline=Date.now()+5000;while(watcher.status().feedAt===initialAt&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert(watcher.status().feedAt>initialAt,'Positive control: a valid response reached the runner');
    abortNext=true;await watcher.tick();
    assert.equal(failedNavigations,1);assert.equal(watcher.status().running,false);
    assert.equal(watcher.status().restartRequested,'selection-navigation-failed');assert.equal(watcher.status().run,null);
    const checkpoint=JSON.parse(await fs.readFile(path.join(dir,'resume.json'),'utf8'));assert.equal(checkpoint.run,null);
    const events=(await fs.readFile(path.join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert(events.some(e=>e.kind==='harness-error'&&/page.reload/.test(e.detail.message)));
   }else{
    assert.equal(watcher.status().running,true);assert.equal(watcher.status().run.phase,'waiting');
    assert.equal(watcher.status().run.line.label,'Red');assert.equal(watcher.status().run.excludeAccuracy,undefined);
    assert.equal(await page.evaluate(()=>localStorage.getItem('shuttle-anon-id')),'00000000-0000-4000-8000-000000000000');
    await page.screenshot({path:path.join(out,'navigation-replacement.png')});
   }
   assert.equal((await fs.readFile(path.join(dir,'journeys.jsonl'),'utf8')).trim(),'');
  }finally{await watcher?.stop();await context.unrouteAll({behavior:'wait'});await context.close();}
 }
 navigationRecovery={failedNavigations,restartRequested:true,replacementWaiting:true,noJourneyOutcomesInvented:true};
}finally{await browser.close();}
await fs.writeFile(path.join(out,'result.json'),JSON.stringify({source:'Real Playwright and rider helpers over modeled screens; no production requests or physical accuracy claim',results,navigationRecovery},null,2)+'\n');
console.log(JSON.stringify({arrivalCompletion:results,riderNavigationRecovery:navigationRecovery}));
