import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const service=process.cwd(), require=createRequire(service+'/package.json');
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const {seedTestId}=await import(service+'/scripts/testId.mjs');
const out=path.dirname(new URL(import.meta.url).pathname);
const baseline=process.argv.includes('--expect-missing-map');
const prefix=baseline?'before':'after';
const now=Date.parse('2026-09-17T14:00:00-04:00');
const feed=JSON.parse(await fs.readFile(service+'/web/src/__fixtures__/buses-payload.json','utf8'));
feed.stop_names=Object.fromEntries(JSON.parse(await fs.readFile(service+'/src/server/__fixtures__/stops.json','utf8')).map(s=>[s.id,s.name]));
const routes=[['Red','309',3,300,1800],['Orange Day','305',2,400,1800],['Brown','507',19,500,1800],['Blue Day','410',1,650,1100]];
const options=routes.map(([routeLabel,busName,rid,rideSec])=>({mode:'shuttle',routeLabel,busName,color:'#f00',boardStopId:42,alightStopId:98,walkToSec:60,waitSec:300,rideSec,walkFromSec:60,totalSec:rideSec+420,directWalkSec:2400,computedAtMs:now}));
options.push({...options[0],mode:'walk',routeLabel:'Walk',totalSec:2400});
feed.buses=routes.map(([,bus_name,route_id],i)=>{
 const list=feed.routes[route_id], previous=list.indexOf(42)-1, stop=list[previous];
 return {bus_id:i+1,bus_name,route_id,...feed.stop_coords[stop],heading:180,last_stop_id:stop,observed_at:now};
});
feed.server_eta={v:2,at:now,servedAt:now,buses:routes.map(([label,name,rid])=>[name,label,feed.routes[rid].indexOf(42)-1,null]),
 rows:routes.flatMap(([,name,rid,rideSec,highSec],i)=>[[i,42,360,300,480,1,0,300,300],[i,98,rideSec+360,240,highSec-60,2,0,240,240]])};
const actualPlanner=service+'/web/src/planner.ts';
const bundle=await build({entryPoints:[service+'/web/src/main.tsx'],outdir:out+'/virtual',bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.png':'dataurl'},
 define:{'process.env.NODE_ENV':'"production"','import.meta.env.DEV':'false'},
 plugins:[{name:'controlled-planned-options',setup(b){
 b.onResolve({filter:/^\.\/planner$/},a=>a.importer.endsWith('/TransitMap.tsx')?{path:'fixture-planner',namespace:'fixture'}:undefined);
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'import {ROUTE_COLOR} from '+JSON.stringify(service+'/web/src/routes.ts')+'; export * from '+JSON.stringify(actualPlanner)+'; export const planTrip=()=>'+JSON.stringify(options)+'.map(o=>({...o,color:ROUTE_COLOR[o.routeLabel]??o.color}));',loader:'ts',resolveDir:service+'/web/src'}));
 b.onResolve({filter:/^\.\.?\//},async a=>{for(const ext of ['.ts','.tsx','.js']){const p=path.resolve(a.resolveDir,a.path+ext);try{await fs.access(p);return {path:p};}catch{}}});
 }}]});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text;
const css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))?.text??'';
const report={source:'Actual application shell, only planTrip substituted with fixed synthetic options; real live-arrival transport, destination update, ranking and navigation; checked-in network',phase:prefix,checks:[],errors:[],requests:[]};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});let ctx;
try {
 ctx=await browser.newContext({viewport:{width:360,height:800},isMobile:true,hasTouch:true,timezoneId:'America/New_York',serviceWorkers:'block'});
 await seedTestId(ctx);
 await ctx.addInitScript(now=>sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Winchester / Mansfield',fromLL:{lat:41.324769,lon:-72.923522},toText:'Laboratory of Epidemiology and Public Health / 60 College Street',toLL:{lat:41.303735,lon:-72.932155},tripTime:'',tripTimeSetAt:now,expandedKey:null,arriveBy:'2026-09-17T14:20',classBufferMin:5,savedAt:now})),now);
 const page=await ctx.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.clock.install({time:new Date(now)});
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.hostname!=='shell.test')return route.abort();
  if(u.pathname==='/api/buses')return route.fulfill({json:feed});
  if(u.pathname==='/api/weather')return route.fulfill({status:204});
  if(u.pathname.startsWith('/api/')){report.requests.push(u.pathname);return route.fulfill({json:{reports:[],results:[],routes:[]}});}
  if(u.pathname==='/app.js')return route.fulfill({contentType:'text/javascript',body:js});
  if(u.pathname==='/app.css')return route.fulfill({contentType:'text/css',body:css});
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'});
  return route.fulfill({status:404});
 });
 await page.goto('https://shell.test');
 const panel=page.getByRole('region',{name:'Arrive by class'});await panel.waitFor();
 report.initial=await page.locator('body').innerText();
 await panel.getByRole('heading',{name:'Your buffer may be tight',exact:true}).waitFor();
 const blue=panel.getByRole('button',{name:/^Blue Day · #410/});await blue.waitFor();
 assert.equal(await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).count(),0,'supporting route is initially behind Show more');
 assert(await page.getByRole('button',{name:/Show .*more route/}).count()>0);
 report.checks.push('Blue Day advice/action visible while its main card is behind Show more');
 await blue.focus();await page.keyboard.press('Enter');
 const back=page.getByRole('button',{name:/All routes/});await back.waitFor();
 report.details=await page.locator('body').innerText();
 assert.match(report.details,/Blue Day/);
 const mapHeading=page.getByRole('button',{name:/^Blue Day route/});
 report.routeMapCount=await mapHeading.count();
 await page.screenshot({path:out+'/'+prefix+'-hidden-route-details-360.png'});
 assert.equal(report.routeMapCount,baseline?0:1,'selected supporting route should retain its route map');
 for(const width of [360,390,430,1280,640]) { await page.setViewportSize({width,height:844}); assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'detail overflow '+width); }
 report.checks.push('Selected route details reflow at 360/390/430/1280/640px');
 report.checks.push('Enter opens Blue Day details',baseline?'Reproduced missing map for hidden route':'Selected Blue Day route map remains available');
 await back.focus();await page.keyboard.press('Enter');await panel.waitFor();
 assert.equal(await panel.getByLabel('Class starts · local time').inputValue(),'2026-09-17T14:20');
 assert.equal(await panel.getByLabel('Time to get inside').inputValue(),'5');
 await blue.waitFor();
 assert.equal(await page.getByRole('button',{name:'View Blue Day trip details',exact:true}).count(),0,'Back preserves the collapsed main list');
 assert.equal(await page.getByRole('button',{name:/^Overview — top 3 of 4 routes/}).count(),1);
 report.checks.push('Back preserves original top-three overview and collapsed list');report.checks.push('Back retains class time, buffer and supporting action');
 assert.deepEqual(report.errors,[]);
 await page.close();
} finally {if(ctx)await ctx.close();await browser.close();await fs.writeFile(out+'/'+prefix+'-hidden-route-shell.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
