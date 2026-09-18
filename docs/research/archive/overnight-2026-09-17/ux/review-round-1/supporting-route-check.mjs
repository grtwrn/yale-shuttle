import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const service = path.resolve(process.cwd());
const require = createRequire(service + '/package.json');
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const out = path.dirname(new URL(import.meta.url).pathname);
const baseline = process.argv.includes('--baseline');
const prefix = 'supporting-route';
const code = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArriveBy} from './ArriveBy';
import {localDateTime} from './journeyArrival';
const now = Date.now();
const shuttle = {mode:'shuttle', routeLabel:'Red', color:'red', boardStopId:48, alightStopId:121,
 walkToSec:60, waitSec:180, rideSec:420, walkFromSec:60, totalSec:660, busName:'307', directWalkSec:1500,
 journeyArrival:{busName:'309',pointMs:now+660000,lowMs:now+300000,highMs:now+840000,catchRisk:false,estimated:false}};
const walk = {...shuttle,mode:'walk',routeLabel:'Walk',totalSec:1500,journeyArrival:undefined};
const base = {value:localDateTime(now+1200000), bufferMin:5, options:[shuttle,walk],
 destination:'Laboratory of Epidemiology and Public Health / 60 College Street', lastBusUpdateAt:now,busUpdateFailed:false,
 stopNames:{48:'Winchester / Mansfield'},onSelect:r=>window.selected=r};
function App(){const [props,setProps]=useState(base);window.setScenario=(s)=>{
 let p={...base};
 if(s==='buffer')p.options=[shuttle,{...walk,totalSec:1080}],p.lastBusUpdateAt=now-60000;
 if(s==='stale')p.lastBusUpdateAt=now-60000;
 if(s==='failed')p.busUpdateFailed=true;
 if(s==='loading')p.lastBusUpdateAt=null;
 if(s==='missing')p.options=[{...shuttle,journeyArrival:undefined},walk];
 if(s==='future')p.departureMs=now+600000,p.options=[{...shuttle,busName:'',journeyArrival:undefined},walk];
 if(s==='partial')p.options=[{...shuttle,journeyArrival:{...shuttle.journeyArrival,highMs:now+1800000}},{...shuttle,routeLabel:'Blue',journeyArrival:undefined},walk];
 if(s==='late')p.options=[{...shuttle,journeyArrival:{...shuttle.journeyArrival,highMs:now+1800000}},walk];
 if(s==='catch')p.options=[{...shuttle,journeyArrival:{...shuttle.journeyArrival,catchRisk:true}},walk];
 if(s==='estimated')p.options=[{...shuttle,journeyArrival:{...shuttle.journeyArrival,estimated:true}},walk];
 if(s==='walk')p.options=[{...shuttle,journeyArrival:{...shuttle.journeyArrival,catchRisk:true}},{...walk,totalSec:600}];
 if(s==='empty')p.options=[];
 if(s==='second-buffer')p.options=[{...shuttle,journeyArrival:{...shuttle.journeyArrival,highMs:now+1800000}},{...shuttle,routeLabel:'Blue',journeyArrival:{...shuttle.journeyArrival,highMs:now+1100000}},walk];
 if(s==='second-catch')p.options=[{...shuttle,journeyArrival:{...shuttle.journeyArrival,highMs:now+1800000}},{...shuttle,routeLabel:'Blue',journeyArrival:{...shuttle.journeyArrival,catchRisk:true}},walk];
 if(s==='both-cautions')p.options=[{...shuttle,journeyArrival:{...shuttle.journeyArrival,catchRisk:true,estimated:true}},walk];
 if(s==='departed-unknown')p.options=[{...shuttle,journeyArrival:{...shuttle.journeyArrival,highMs:now+1800000}},{...shuttle,routeLabel:'Blue',journeyArrival:undefined,departed:true},walk];
 if(s==='future-walk')p.departureMs=now+60000,p.options=[shuttle,{...walk,totalSec:600}];
 setProps(p);
};return <ArriveBy {...props} onChange={value=>setProps(p=>({...p,value}))} onBufferChange={bufferMin=>setProps(p=>({...p,bufferMin}))}/>}
createRoot(document.getElementById('root')).render(<App/>);`;
const bundled = await build({stdin:{contents:code,resolveDir:service+'/web/src',loader:'tsx'},bundle:true,plugins:[{name:'exact-case',setup(b){b.onResolve({filter:/^\.\.?\//},async a=>{for(const ext of ['.ts','.tsx','.js']){const p=path.resolve(a.resolveDir,a.path+ext);try{await fs.access(p);return {path:p};}catch{}}});}}],write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const report={phase:prefix,states:[],checks:[],errors:[],supportingFailures:[]};
try {
 const ctx=await browser.newContext({viewport:{width:360,height:800},isMobile:true,hasTouch:true,timezoneId:'America/New_York',serviceWorkers:'block'});
 await seedTestId(ctx);
 const page=await ctx.newPage();
 page.setDefaultTimeout(8000);
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.clock.install({time:new Date('2026-09-17T14:00:00-04:00')});
 await page.route('**/*',route=>{
 const u=new URL(route.request().url());
 if(u.pathname==='/app.js')return route.fulfill({contentType:'text/javascript',body:bundled.outputFiles[0].text});
 if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:12px;font-family:Arial,sans-serif}#root{max-width:620px;margin:auto}</style></head><body><main id="root"></main><script src="/app.js"></script></body></html>'});
 return route.abort();
 });
 await page.goto('https://deadline.test');
 const panel=page.getByRole('region',{name:'Arrive by class'});
 await panel.waitFor();
 for(const [scenario,expected] of Object.entries({'second-buffer':'Your buffer may be tight','second-catch':'Check the shuttle connection'})){
  await page.evaluate(s=>window.setScenario(s),scenario);
  if(!baseline)await page.getByRole('heading',{name:expected,exact:true}).waitFor();
  else await page.waitForTimeout(30);
  const heading=await panel.getByRole('heading').innerText();
  const buttons = await panel.getByRole('button').allTextContents();
  const count = await panel.getByRole('button',{name:/^Blue/}).count();
  report.states.push({scenario,heading,text:await panel.innerText(),buttons,supportingRouteActions:count});
  if(count === 0)report.supportingFailures.push(scenario+': heading describes Blue, but no Blue window/trip action is rendered in the deadline panel');
  if(!baseline&&scenario==='future')assert.doesNotMatch(await panel.innerText(),/Red · #/,'no placeholder bus identity before departure');
  for(const width of [360,390,430,1280]){
   await page.setViewportSize({width,height:844});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),scenario+' overflows '+width);
  }
  await page.setViewportSize({width:360,height:800});

 }
 if(false){
  await page.evaluate(()=>window.setScenario('fresh'));
  await page.getByRole('heading',{name:'Red may fit your buffer',exact:true}).waitFor();
  // Independent state-transition checks on the mounted component.
  await panel.getByLabel('Time to get inside').selectOption('10');
  await page.getByRole('heading',{name:'Your buffer may be tight',exact:true}).waitFor();
  await panel.getByLabel('Time to get inside').selectOption('5');
  await page.getByRole('heading',{name:'Red may fit your buffer',exact:true}).waitFor();
  for(const [scenario,heading] of [['stale','Live shuttle times unavailable'],['fresh','Red may fit your buffer'],['failed','Live shuttle times unavailable'],['fresh','Red may fit your buffer']]) {
    await page.evaluate(s=>window.setScenario(s),scenario);
    await page.getByRole('heading',{name:heading,exact:true}).waitFor();
  }
  await panel.getByRole('button',{name:'Clear',exact:true}).click();
  await page.getByRole('button',{name:/Arrive by…/}).click();
  await panel.waitFor();
  await page.evaluate(()=>window.setScenario('fresh'));
  await page.getByRole('heading',{name:'Red may fit your buffer',exact:true}).waitFor();
  report.checks.push('buffer edits update advice; fresh/stale/failed/recovered transitions; clear and reopen deadline');
  const clear=panel.getByRole('button',{name:'Clear',exact:true});
  await clear.focus();
  await page.keyboard.press('Tab');
  assert(await panel.getByLabel('Class starts · local time').evaluate(e=>e===document.activeElement),'time receives focus');
  const select=panel.getByLabel('Time to get inside');
  await select.focus();await page.keyboard.press('Tab');
  assert.match(await page.evaluate(()=>document.activeElement.textContent),/Red · #309/);
  await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.selected),'Red');
  const summary=panel.locator('summary');await summary.focus();await page.keyboard.press('Space');
  assert(await panel.locator('details').evaluate(e=>e.open));
  await page.keyboard.press('Space');assert(!(await panel.locator('details').evaluate(e=>e.open)));
  await panel.getByLabel('Class starts · local time').fill('2026-01-01T10:00');
  assert.match(await panel.getByRole('alert').innerText(),/passed/);
  assert.equal(await panel.getByRole('heading').count(),0);
  await panel.getByLabel('Class starts · local time').fill('');
  assert.match(await panel.getByRole('alert').innerText(),/Choose a class/);
  await page.evaluate(()=>window.setScenario('stale'));
  // Equivalent CSS-pixel reflow to a 1280px desktop viewport at 200% zoom.
  await page.setViewportSize({width:640,height:422});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  report.checks.push('1280px desktop at 200% equivalent CSS-pixel reflow');
  const sizes=await panel.locator('button,input,select,summary').evaluateAll(es=>es.map(e=>({name:e.textContent||e.getAttribute('type'),height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width})));
  assert(sizes.every(s=>s.height>=44&&s.width>=44));report.controls=sizes;
  report.checks.push('Tab to named datetime and comparison row','Enter selects catchable Red #309 trip','Space toggles help','invalid/past deadline hides advice','all panel targets >=44px');
 }
 report.checks.push('two mismatched supporting-route cases at 360/390/430/1280px');
 assert.deepEqual(report.errors,[]);
 await page.close();await ctx.close();
}finally{await browser.close();await fs.writeFile(out+'/'+prefix+'-browser.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify({phase:prefix,states:report.states.map(({scenario,heading})=>({scenario,heading})),checks:report.checks,errors:report.errors},null,2));

assert.deepEqual(report.supportingFailures, [], 'Advice about a specific route must expose that route’s window and trip action');
