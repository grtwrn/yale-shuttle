import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const service=process.cwd(), require=createRequire(service+'/package.json');
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const {seedTestId}=await import(service+'/scripts/testId.mjs');
const out=process.env.OUT || path.dirname(new URL(import.meta.url).pathname);
await fs.mkdir(out,{recursive:true});
const baseline=process.argv.includes('--baseline'), prefix=baseline?'before':'after';
const desktop=!!process.env.DESKTOP;
const from={lat:41.321,lon:-72.927}, to={lat:41.307,lon:-72.926};
const base={label:'Red',color:'#C62828',segCoords:[from,to],bus:{...from,name:'307'},passedBus:{lat:41.3207,lon:-72.927,name:'309'},boardEta:'2–19 min',arriveAt:'12:59–1:32 PM',busWait:{compact:'3:21/~5m',elapsed:'Waiting 3:21',typical:'Usually ~5 min total',overdue:false}};
const source=baseline ? (process.env.BASELINE_SOURCE || path.dirname(new URL(import.meta.url).pathname)+'/TransitMap.baseline.tsx') : service+'/web/src/TransitMap.tsx';
const code=`import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {CombinedTripMap} from './TransitMap';
function App(){const [options,setOptions]=useState(${JSON.stringify([base])});window.setOptions=setOptions;return <><button>Before map</button><CombinedTripMap from={${JSON.stringify(from)}} to={${JSON.stringify(to)}} options={options}/><button>After map</button></>};createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:code,resolveDir:service+'/web/src',loader:'tsx'},outdir:out+'/virtual',bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"','import.meta.env.DEV':'false'},plugins:[{name:'actual-map',setup(b){
 b.onLoad({filter:/\/TransitMap\.tsx$/},async()=>({contents:(await fs.readFile(source,'utf8')).replace('const CombinedTripMap:','export const CombinedTripMap:').replaceAll('mapRef.current = map;\n    L.tileLayer','mapRef.current = map; window.fixtureMap = map;\n    L.tileLayer'),loader:'tsx',resolveDir:service+'/web/src'}));
 b.onResolve({filter:/^\.\.?\//},async a=>{for(const ext of ['.ts','.tsx','.js']){const p=path.resolve(a.resolveDir,a.path+ext);try{await fs.access(p);return {path:p};}catch{}}});
}}]});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text, css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))?.text??'';
const report={phase:prefix,desktop,source:'Actual CombinedTripMap with synthetic props; test-only export/map reference; no estimator or live network',states:[],checks:[],errors:[]};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
let ctx;
try{
 ctx=await browser.newContext({viewport:{width:desktop?1280:360,height:800},isMobile:!desktop,hasTouch:!desktop,serviceWorkers:'block'});await seedTestId(ctx);
 const page=await ctx.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname!=='minimap.test')return r.abort();if(u.pathname==='/app.js')return r.fulfill({contentType:'text/javascript',body:js});if(u.pathname==='/app.css')return r.fulfill({contentType:'text/css',body:css});if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="font-family:Arial,sans-serif"><main id="root"></main><script src="/app.js"></script></body></html>'});return r.abort();});
 await page.goto('https://minimap.test');await page.locator('.bus-wait-label').waitFor();await page.waitForTimeout(200);
 async function capture(name,screenshot=false){
 const state=await page.evaluate(()=>{const rect=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,left:b.left,right:b.right,top:b.top,bottom:b.bottom}};return {width:innerWidth,map:rect(document.querySelector('.leaflet-container')),labels:[...document.querySelectorAll('.eta-tip')].map(e=>({text:e.textContent,wait:!!e.querySelector('.bus-wait-label'),...rect(e)})),buses:[...document.querySelectorAll('.bus-pin-sm')].map(e=>({text:e.textContent,name:e.getAttribute('aria-label'),title:e.title,role:e.getAttribute('role'),...rect(e)})),overflow:document.documentElement.scrollWidth>innerWidth}});
 report.states.push({name,...state});if(screenshot)await page.screenshot({path:path.join(out,`${prefix}-${name}.png`)});return state;
 }
 const first = await capture('same-route-360',true);
 if(baseline){assert(first.buses.every(b=>b.name===null));assert.equal(first.labels.find(l=>l.wait).text,'Red 3:21/~5m');report.checks.push('Reproduced unnamed bus markers and absent visible bus number');}
 else{
  assert.match(first.buses[0].name,/Red #307.*Waiting 3:21.*Usually ~5 min total.*not time remaining/);
  assert.equal(first.buses[1].name,'Red #309 — just passed');
  assert.equal(first.labels.find(l=>l.wait).text,'Red #307 3:21/~5m');
  report.checks.push('Catchable and passed Red buses have distinct accessible identities; compact wait names #307');
 }

 await page.locator('.bus-pin-sm').first().focus();await capture('focused-bus');
 await page.evaluate(base=>{window.originalMarker=document.querySelector('.bus-pin-sm');window.setOptions([{...base,busWait:{...base.busWait,compact:'3:22/~5m',elapsed:'Waiting 3:22'}}]);},base);
 await page.waitForTimeout(60);
 assert(await page.locator('.bus-pin-sm').first().evaluate(e=>e===window.originalMarker && e===document.activeElement),'poll update keeps marker and keyboard focus');
 if(!baseline)assert.match(await page.locator('.bus-pin-sm').first().getAttribute('aria-label'),/Waiting 3:22/);
 assert.match(await page.locator('.bus-wait-label').innerText(),/3:22\/~5m/);
 report.checks.push('Wait tick updates identity/details in place and preserves keyboard focus');

 await page.getByRole('button',{name:'Fullscreen',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForTimeout(200);await capture('fullscreen');await page.keyboard.press('Escape');await page.waitForTimeout(200);
 assert.equal(await page.locator('.map-fs').count(),0);
 assert(await page.getByRole('button',{name:'Fullscreen',exact:true}).evaluate(e=>e===document.activeElement));
 const toggle=page.getByRole('button',{name:'Fullscreen',exact:true}), target=await toggle.boundingBox();assert(target.width>=44&&target.height>=44);
 if(!desktop)await toggle.tap();else await toggle.click();await page.waitForTimeout(150);
 await page.getByRole('button',{name:'Back',exact:true}).click();await page.waitForTimeout(150);assert.equal(await page.locator('.map-fs').count(),0);
 report.checks.push('44px fullscreen control works by Enter/touch or click; Escape retains toggle focus; Back closes');

 const options=[base,{...base,label:'Blue Day',color:'#1565c0',bus:{...from,name:'410'},passedBus:null,busWait:{...base.busWait,compact:'12:08/~10m'}},{...base,label:'Brown',color:'#795548',bus:{lat:41.3208,lon:-72.927,name:'507'},passedBus:null,busWait:{...base.busWait,compact:'18:05/~12m'}}];
 await page.evaluate(options=>window.setOptions(options),options);await page.waitForTimeout(200);const together=await capture('three-routes-360',true);
 const timing=together.labels.filter(l=>!l.wait).map(l=>l.text).join(' ');
 if(baseline){assert.equal((timing.match(/\(B\)/g)||[]).length,4);report.checks.push('Reproduced Blue Day/Brown identical (B) tags at both endpoints');}
 else{assert(timing.includes('(Blue Day) 2–19 min'));assert(timing.includes('(Brown) 2–19 min'));assert(timing.includes('(R) 2–19 min'));assert(!timing.includes('(B)'));report.checks.push('Both pickup and arrival time stacks distinguish Blue Day/Brown without color');}

 for(const width of [390,430,1280,640]){await page.setViewportSize({width,height:844});await page.evaluate(()=>window.fixtureMap.invalidateSize());await page.waitForTimeout(150);await capture('three-routes-'+width);}
 await page.getByRole('button',{name:'Zoom in',exact:true}).focus();const zoom=await page.evaluate(()=>window.fixtureMap.getZoom());await page.keyboard.press('Enter');await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>window.fixtureMap.getZoom()),zoom+1);
 await page.getByRole('button',{name:'Zoom out',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>window.fixtureMap.getZoom()),zoom);
 report.checks.push('Keyboard zoom in/out reclusters without errors');
 await page.setViewportSize({width:360,height:800});await page.evaluate(()=>{const m=window.fixtureMap;m.invalidateSize();m.panBy([100,-65],{animate:false});});await page.waitForTimeout(200);await capture('edge',true);
 await page.evaluate(base=>window.setOptions([{...base,busWait:null,boardEta:null,arriveAt:null}]),base);await page.waitForTimeout(100);const missing=await capture('no-forecast');assert.equal(missing.labels.length,0);
 if(!baseline)assert.equal(missing.buses[0].name,'Red #307');
 report.checks.push('Unavailable times remove wait/arrival labels while preserving bus identity');
 await page.locator('.bus-pin-sm').nth(1).focus();await page.waitForTimeout(50);
 assert.match(await page.locator('.eta-tip').innerText(),/309.*just passed/);
 report.checks.push('Keyboard focus opens the passed-bus tooltip');

 await page.evaluate(()=>window.setOptions([]));await page.waitForTimeout(100);const empty=await capture('empty');assert.equal(empty.buses.length,0);assert.equal(empty.labels.length,0);report.checks.push('Empty options remove old bus markers and labels');
 for(const state of report.states){assert.equal(state.overflow,false,state.name+' page reflow');
  for(const label of state.labels.filter(l=>l.wait)){
   assert(label.left>=state.map.left-1 && label.right<=state.map.right+1 && label.top>=state.map.top-1 && label.bottom<=state.map.bottom+1,state.name+' wait within map');
   const others=[...state.labels.filter(l=>l!==label),...state.buses];
   for(const other of others)assert(label.right<=other.left+1||label.left>=other.right-1||label.bottom<=other.top+1||label.top>=other.bottom-1,state.name+' wait avoids another label or bus');
  }
 }
 report.checks.push('Wait labels stay in bounds and clear of buses/time labels at all tested widths and pan position');
 await page.evaluate(base=>window.setOptions([{...base,label:'Orange Night',color:'#ED7D31',passedBus:null,boardEta:'2–119 min',arriveAt:'12:59 PM'},{...base,label:'Orange East',color:'#E8836A',passedBus:null,bus:{...base.bus,name:'410'},boardEta:'8–125 min',arriveAt:'1:25 PM'}]),base);
 await page.waitForTimeout(150);const long=await capture('orange-long-window',true);
 if(!baseline){const times=long.labels.filter(l=>!l.wait).map(l=>l.text).join(' ');assert(times.includes('(Orange Night) 2–119 min'));assert(times.includes('(Orange East) 8–125 min'));}
 for(const l of long.labels.filter(l=>l.wait))assert(l.left>=long.map.left-1&&l.right<=long.map.right+1,'long route wait in bounds');
 report.checks.push('Long route names and broad pickup windows remain present without clipping numerical ranges');
 assert.deepEqual(report.errors,[]);await page.close();
}finally{if(ctx)await ctx.close();await browser.close();await fs.writeFile(path.join(out,prefix+'-browser.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
