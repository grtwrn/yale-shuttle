import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const service = process.cwd();
const require = createRequire(service + '/package.json');
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const out = path.dirname(new URL(import.meta.url).pathname);
const code = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArriveBy} from './ArriveBy';
import {localDateTime, arrivalClock} from './journeyArrival';
import {preferredTripOrder} from './tripRanking';
import {topVisibleOptions} from './planner';
const now = Date.now();
function shuttle(routeLabel, busName, rideSec, highSec) {
 return {mode:'shuttle',routeLabel,busName:'previous-bus',color:'#f00',boardStopId:48,alightStopId:121,
 walkToSec:60,waitSec:300,rideSec,walkFromSec:60,totalSec:rideSec+420,directWalkSec:1500,computedAtMs:now,
 journeyArrival:{busName,pointMs:now+(rideSec+420)*1000,lowMs:now+300000,highMs:now+highSec*1000,catchRisk:false,estimated:false}};
}
const red=shuttle('Red','309',300,1800);
red.journeyArrival.distributionMs=Array.from({length:50},(_,i)=>now+(300+i*30)*1000);
const walk={...red,mode:'walk',routeLabel:'Walk',totalSec:1500,journeyArrival:undefined};
function App() {
 const [scenario,setScenario]=useState('buffer');
 const [value,setValue]=useState(localDateTime(now+1200000));
 window.setScenario=setScenario;
 const blue=shuttle('Blue Day','410',650,1100);
 if(scenario==='connection')blue.journeyArrival.catchRisk=true;
 if(scenario==='limited')blue.journeyArrival.estimated=true;
 const options=preferredTripOrder([red,shuttle('Green','305',400,1800),shuttle('Brown','507',500,1800),blue,walk]);
 window.fixture={ordered:options.map(o=>o.routeLabel),visible:topVisibleOptions(options).map(o=>o.routeLabel),
 blueWindow:arrivalClock(blue.journeyArrival.lowMs,'low')+'–'+arrivalClock(blue.journeyArrival.highMs,'high')};
 return <ArriveBy value={value} onChange={setValue} bufferMin={5} onBufferChange={()=>{}}
 options={options} destination="Laboratory of Epidemiology and Public Health / 60 College Street"
 lastBusUpdateAt={scenario==='loading'?null:now} busUpdateFailed={scenario==='failed'}
 stopNames={{48:'Winchester / Mansfield'}} onSelect={route=>window.selected=route}/>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
const bundled=await build({stdin:{contents:code,resolveDir:service+'/web/src',loader:'tsx'},bundle:true,
 plugins:[{name:'exact-case',setup(b){b.onResolve({filter:/^\.\.?\//},async a=>{for(const ext of ['.ts','.tsx','.js']){const p=path.resolve(a.resolveDir,a.path+ext);try{await fs.access(p);return {path:p};}catch{}}});}}],
 write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
const report={source:'Real ArriveBy, ranking and visibility helpers; synthetic options; intercepted requests',cases:[],errors:[]};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
let ctx;
try {
 ctx=await browser.newContext({viewport:{width:360,height:800},isMobile:true,hasTouch:true,timezoneId:'America/New_York',serviceWorkers:'block'});
 await seedTestId(ctx);
 const page=await ctx.newPage();page.setDefaultTimeout(8000);
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.clock.install({time:new Date('2026-09-17T14:00:00-04:00')});
 await page.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(u.pathname==='/app.js')return route.fulfill({contentType:'text/javascript',body:bundled.outputFiles[0].text});
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:12px;font-family:Arial,sans-serif}#root{max-width:620px;margin:auto}</style></head><body><main id="root"></main><script src="/app.js"></script></body></html>'});
  return route.abort();
 });
 await page.goto('https://supporting-route.test');
 const panel=page.getByRole('region',{name:'Arrive by class'});
 for(const [scenario,heading] of [['buffer','Your buffer may be tight'],['connection','Check the shuttle connection'],['limited','Allow extra time for this shuttle']]) {
  await page.evaluate(s=>window.setScenario(s),scenario);
  await panel.getByRole('heading',{name:heading,exact:true}).waitFor();
  const fixture=await page.evaluate(()=>window.fixture);
  assert.deepEqual(fixture.ordered,['Red','Green','Brown','Blue Day','Walk']);
  assert(!fixture.visible.includes('Blue Day'));
  const action=panel.getByRole('button',{name:/^Blue Day · #410/});
  assert.equal(await action.count(),1);
  assert((await action.innerText()).includes(fixture.blueWindow));
  assert.match(await action.innerText(),/View trip/);
  assert.doesNotMatch(await action.innerText(),/previous-bus/);
  const sizes=[];
  for(const width of [360,390,430,1280,640]) {
   await page.setViewportSize({width,height:width===640?422:844});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow at '+width);
   const box=await action.boundingBox();assert(box.height>=44&&box.width>=44);sizes.push({viewport:width,height:box.height,width:box.width});
  }
  await page.setViewportSize({width:360,height:800});
  // Actual Tab order: original route, supporting route, walk. Enter and Space
  // must both select the route in the same button as its window and caution.
  await panel.getByLabel('Time to get inside').focus();
  await page.keyboard.press('Tab');
  assert.match(await page.evaluate(()=>document.activeElement.textContent),/^Red · #309/);
  await page.keyboard.press('Tab');assert(await action.evaluate(e=>e===document.activeElement));
  await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.selected),'Blue Day');
  await page.evaluate(()=>window.selected=null);
  await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>window.selected),'Blue Day');
  await page.keyboard.press('Tab');assert.match(await page.evaluate(()=>document.activeElement.textContent),/^Walk/);
  await action.scrollIntoViewIfNeeded();
  await page.screenshot({path:out+'/supporting-'+scenario+'-360.png'});
  const distribution=panel.getByText(/^See .+ arrival times ▾$/);
  assert.match(await distribution.innerText(),/See Red arrival times/,'distribution stays attached to the primary route');
  await distribution.focus();await page.keyboard.press('Space');
  const plot=panel.getByRole('img',{name:/^Model estimate: arrival at/});await plot.waitFor();
  assert.equal(await plot.locator('circle').count(),50);
  await page.keyboard.press('Space');assert.equal(await plot.count(),0);
  report.cases.push({scenario,heading,fixture,distribution:'Named Red disclosure opens its 50 modeled outcomes with Space',action:await action.innerText(),sizes,keyboard:'Tab reaches Blue between Red and Walk; Enter/Space select Blue Day'});
 }
 for(const scenario of ['loading','failed']) {
  await page.evaluate(s=>window.setScenario(s),scenario);
  await panel.getByRole('heading',{name:'Live shuttle times unavailable',exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:/^Blue Day/}).count(),0,'unavailable state must remove old supporting forecast');
  report.cases.push({scenario,text:await panel.innerText()});
 }
 await page.evaluate(()=>window.setScenario('buffer'));
 await panel.getByRole('button',{name:/^Blue Day · #410/}).waitFor();
 report.recovery='Buffer route/action restored after unavailable feed states';
 assert.deepEqual(report.errors,[]);
 await page.close();
} finally {
 if(ctx)await ctx.close();
 await browser.close();
 await fs.writeFile(out+'/supporting-route-browser.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
