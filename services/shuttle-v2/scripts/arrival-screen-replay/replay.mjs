/** Actual SPA renderer. Frozen inputs/controls below; never an ETA scorer.
 * Run only in the dedicated Linux Node22.23.4 workflow after source review.
 */
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {chromium} from 'playwright-core';
import {seedTestId, TEST_ANON_ID} from '../testId.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)), SERVICE=path.resolve(HERE,'../..');
const LIMITS=Object.freeze({wallMs:180000,cleanupMs:5000,fixtureBytes:1048576,assetFileBytes:8388608,assetReadBytes:67108864,outputBytes:16777216,finalReceiptReserveBytes:65536});
const PRODUCTION_PIN=Object.freeze({build:'6aed223edaec',indexBytes:1177,
  indexSHA256:'6490ee53dee0b26561517b938592e7a44eecb7b5f9c74285e4953a6a53202d77',
  rootCaptureReceiptSHA256:'5b2cd54b8b9efbc2e3472510bc1aacea65dccfd3a3049816c1f5e82df73f5653',
  scope:'Root paired health/index/health DATA capture; observed-build checks are not an atomic deployment lock or ABA proof.'});
const PROTOCOL=Object.freeze({
  id:'arrival-screen-replay-v1', widths:[390,1280], route:'Orange East', bus:'50', pickup:157, destination:165,
  recorded:'All three complete retained frame.json byte strings unchanged, in receipt order. Observational: no flicker/stability assertion.',
  contexts:[{id:'pickup',eastLongitudeOffset:0},{id:'east-0.0025',eastLongitudeOffset:0.0025}],
  contextScope:'Constructed diagnostic origins and destination; never recovered reporter state or report113 reproduction.',
  protocolHeaderScope:'X-Shuttle-Snapshot is constructed by this harness to bind exact response bytes to the rendered screen; original HTTP headers and journal-record bytes are unavailable.',
  controls:{
    width:{point:330,low:300,highSequence:[361,359,361],exhaustedBand:{point:330,low:0,high:0},
      expected:'Same visit: point and window both visible at each non-exhausted step; point remains when [0,0] window is unavailable.'},
    curb:{laterPickupSequence:[1800,2400,1800],expected:'Exact same raw curb, current offer and stand; changing only later offers must retain At stop.'},
    departure:{returnPickup:1200,returnLow:1100,returnHigh:1300,
      expected:'Clear raw curb/stationary and served stand; advance anchor/travel2→3, retain return rows only, shift their relative hops by -1. A later pickup must replace At stop.'},
    invalid:{sequence:['valid','wire-v0','valid'],expected:'Unavailable on invalid wire, recover on valid wire; keep the route/pickup.'},
    reindex:'Keep only raw #50/route17 and its wire Orange East entry. Remap every selected row, aligned distribution/travel/repeatVisits together. Original recorded frames are never reindexed.',
    moving:'Width/invalid controls move raw #50 to published stop150, clear standing/at-stop, anchor/travel2→1, add1 to every relative hop. Set pickup to330/[300,high] and destination to600/[570,650].',
    quantiles:'For replaced synthetic rows only, construct50 monotone control points through low/point/high; exhausted window uses50 zeros. These are artificial controls, not fitted distributions.',
    clock:'Each synthetic scenario fixes Date.now to its declared clock; width/curb/invalid changes do not age between polls. Departure advances5000ms. Recorded steps use exact original receipt clocks.',
  },
  assets:['local candidate web/dist','production static assets cached once; health/index/hashed JS/CSS GET only'],
  scope:'Browser functional evidence only. No physical arrival truth, model accuracy, original report113 join, trial support, or publication capability.',
});
const args=process.argv.slice(2), option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
assert(args.every((a,i)=>['--assets','--out'].includes(a)||i>0&&['--assets','--out'].includes(args[i-1])),'Unknown argument');
const role=option('--assets')??'local';assert(['local','production'].includes(role),'--assets must be local or production');
assert.equal(process.platform,'linux','This finite renderer is admitted on Linux only');
assert.equal(process.versions.node,'22.23.4','This renderer requires the pinned Node22.23.4 runtime');
const OUT=path.resolve(option('--out')??path.join(SERVICE,'pr-preview/arrival-screen-replay',role));
const host='arrival-screen-replay.test', productionOrigin='https://yale-shuttle.fly.dev';
const started=performance.now(), actualStartedAt=new Date().toISOString();
let outputBytes=0,fixtureReadBytes=0,assetReadBytes=0,fixtureEOFProbes=0,fixtureEOFBytes=0,assetEOFProbes=0,assetEOFBytes=0;
let fixtureAdmittedReadBytes=0,assetAdmittedReadBytes=0;
let browser,browserServer,browserProcess,activePage,terminal=false,deadlineTriggered=false;
const browserCustody={launchAttempted:false,pid:null,state:'not-started',exitCode:null,signalCode:null,cleanupErrors:[]};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const check=()=>assert(!deadlineTriggered&&performance.now()-started<LIMITS.wallMs-LIMITS.cleanupMs,'Finite work budget exhausted; cleanup reserve required');
await fs.mkdir(path.dirname(OUT),{recursive:true});await fs.mkdir(OUT); // Fresh namespace; never overwrite a prior result.
const writes=[];
async function write(relative,value,{final=false}={}){
  if(!final)check();const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);
  const maximum=final?LIMITS.outputBytes:LIMITS.outputBytes-LIMITS.finalReceiptReserveBytes;
  assert(outputBytes+bytes.length<=maximum,`Output cap exceeded by ${relative}`);
  if(final)assert(bytes.length<=LIMITS.finalReceiptReserveBytes,'Final receipt exceeds its fixed reserve');
  const file=path.resolve(OUT,relative);assert(file.startsWith(OUT+path.sep),'Unsafe output path');
  outputBytes+=bytes.length;await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes,{flag:'wx'});
  const pin={file:relative,bytes:bytes.length,sha256:sha(bytes)};writes.push(pin);return pin;
}
const json=(name,value,options)=>write(name,JSON.stringify(value,null,2)+'\n',options);
function refreshBrowserCustody(){
  if(!browserProcess){browserCustody.state=browserCustody.launchAttempted?'unknown':'not-started';return;}
  browserCustody.pid=browserProcess.pid??null;browserCustody.exitCode=browserProcess.exitCode;browserCustody.signalCode=browserProcess.signalCode;
  browserCustody.state=browserProcess.exitCode!==null||browserProcess.signalCode!==null?'closed':'owned-running';
}
async function closeOwnedBrowser(force=false){
  if(!browserServer){refreshBrowserCustody();return;}
  if(force)await browserServer.kill();
  else{
    if(browser)await browser.close().catch(error=>browserCustody.cleanupErrors.push(String(error)));
    await browserServer.close();
  }
  refreshBrowserCustody();
}
function retainHardDeadline(){
  refreshBrowserCustody();
  const body=Buffer.from(JSON.stringify({completed:false,error:'Finite wall deadline; owned browser closure must be proven',actualStartedAt,
    actualFinishedAt:new Date().toISOString(),elapsedMs:performance.now()-started,browserCustody,outputBytes})+'\n');
  if(body.length<=LIMITS.finalReceiptReserveBytes&&outputBytes+body.length<=LIMITS.outputBytes){
    syncFs.writeFileSync(path.join(OUT,'hard-deadline.json'),body,{flag:'wx'});outputBytes+=body.length;
  }
}
const timer=setTimeout(()=>{
  deadlineTriggered=true;terminal=false;
  // Begin public-API kill with5s left; retain whether this exact owned PID
  // exited. Unknown custody always refuses completion, even at hard cutoff.
  const finalCutoff=setTimeout(()=>{try{retainHardDeadline();}finally{process.exit(124);}},Math.max(1,LIMITS.wallMs-(performance.now()-started)));
  void closeOwnedBrowser(true).catch(error=>browserCustody.cleanupErrors.push(String(error))).finally(()=>{
    clearTimeout(finalCutoff);try{retainHardDeadline();}finally{process.exit(124);}
  });
},LIMITS.wallMs-LIMITS.cleanupMs);
async function boundedLocal(file,max,{kind,root}){
  check();file=path.resolve(file);root=path.resolve(root);
  assert.equal(await fs.realpath(root),root,'Local input root must be canonical and free of symlink escapes');
  const relative=path.relative(root,file);assert(relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative),'Input outside admitted root');
  let parent=root;
  for(const part of relative.split(path.sep).slice(0,-1)){
    parent=path.join(parent,part);const entry=await fs.lstat(parent);assert(entry.isDirectory()&&!entry.isSymbolicLink(),'Symlink/non-directory input ancestor');
  }
  const namedBefore=await fs.lstat(file,{bigint:true});assert(namedBefore.isFile()&&!namedBefore.isSymbolicLink(),'Input must be a named regular file');
  const fd=await fs.open(file,syncFs.constants.O_RDONLY|syncFs.constants.O_NOFOLLOW);
  try{
    const before=await fd.stat({bigint:true});assert(before.isFile()&&before.size<=BigInt(max),'Input file exceeds admitted extent');
    for(const key of ['dev','ino','size','mtimeNs','ctimeNs'])assert.equal(before[key],namedBefore[key],`Named input changed before open: ${key}`);
    const used=kind==='fixture'?fixtureAdmittedReadBytes:assetAdmittedReadBytes;
    const cap=kind==='fixture'?LIMITS.fixtureBytes:LIMITS.assetReadBytes;
    assert(used+Number(before.size)+1<=cap,'Input payload plus one EOF probe exceeds aggregate admission');
    if(kind==='fixture')fixtureAdmittedReadBytes+=Number(before.size)+1;else assetAdmittedReadBytes+=Number(before.size)+1;
    const bytes=Buffer.alloc(Number(before.size));let offset=0;
    while(offset<bytes.length){check();const n=(await fd.read(bytes,offset,bytes.length-offset,offset)).bytesRead;if(kind==='fixture')fixtureReadBytes+=n;else assetReadBytes+=n;assert(n>0,'Unexpected input EOF');offset+=n;}
    if(kind==='fixture')fixtureEOFProbes++;else assetEOFProbes++;
    const extra=(await fd.read(Buffer.alloc(1),0,1,offset)).bytesRead;
    if(kind==='fixture')fixtureEOFBytes+=extra;else assetEOFBytes+=extra;
    assert.equal(extra,0,'Input grew beyond admitted extent');
    const after=await fd.stat({bigint:true}),namedAfter=await fs.lstat(file,{bigint:true});
    assert(!namedAfter.isSymbolicLink(),'Named input became a symlink');assert.equal(await fs.realpath(file),file,'Named input escaped its root');
    for(const key of ['dev','ino','size','mtimeNs','ctimeNs']){assert.equal(after[key],before[key],`Input identity changed: ${key}`);assert.equal(namedAfter[key],after[key],`Named input no longer identifies descriptor: ${key}`);}
    return bytes;
  }finally{await fd.close();}
}
const fixtureRoot=path.join(HERE,'__fixtures__'),fixtureAdmission={kind:'fixture',root:fixtureRoot};
const manifestBytes=await boundedLocal(path.join(fixtureRoot,'manifest.json'),LIMITS.fixtureBytes,fixtureAdmission);
const manifest=JSON.parse(manifestBytes),frames=[];
assert.equal(manifest.sourceBuild,'6aed223edaec');assert.deepEqual(manifest.frames.map(f=>f.seq),[1777,1778,1782]);
for(const metadata of manifest.frames){
  assert.equal(metadata.file,`orange-${metadata.seq}.json`,'Unexpected fixture filename');
  const bytes=await boundedLocal(path.join(fixtureRoot,metadata.file),LIMITS.fixtureBytes-fixtureAdmittedReadBytes-1,fixtureAdmission);
  assert.equal(bytes.length,metadata.bytes);assert.equal(sha(bytes),metadata.sha256);
  const value=JSON.parse(bytes);assert.equal(value.server_eta.at,metadata.modelAt);
  frames.push({metadata,bytes,value});
}
await json('protocol-frozen-before-browser.json',{protocol:PROTOCOL,productionPin:PRODUCTION_PIN,limits:LIMITS,role,manifestSHA256:sha(manifestBytes),manifest,
  actualStartedAt,node:process.version,platform:process.platform,fixtureReadBytes,fixtureEOFProbes,fixtureEOFBytes});

// Construct all controls before the browser exists. No application/model import.
const base=frames[0], baseline=base.value, controlAt=base.metadata.originalReceiptAt+100000;
function singleBus(){
  const feed=structuredClone(baseline),wire=feed.server_eta;
  const i=wire.buses.findIndex(b=>b[0].replace(/^#/,'')===PROTOCOL.bus&&b[1]===PROTOCOL.route);assert(i>=0);
  const indices=wire.rows.flatMap((row,j)=>row[0]===i?[j]:[]);
  assert.equal(wire.distributions.length,wire.rows.length);assert.equal(wire.travel.length,wire.buses.length);
  feed.buses=feed.buses.filter(b=>b.bus_name.replace(/^#/,'')===PROTOCOL.bus&&b.route_id===17);assert.equal(feed.buses.length,1);
  wire.buses=[wire.buses[i]];
  wire.rows=indices.map(j=>{const row=[...wire.rows[j]];row[0]=0;return row;});
  wire.distributions=indices.map(j=>wire.distributions[j]);wire.travel=[wire.travel[i]];
  wire.repeatVisits=wire.repeatVisits.filter(row=>row[0]===i).map(row=>[0,row[1],row[2]]);
  if(Array.isArray(wire.serviceStopsAhead))wire.serviceStopsAhead=indices.map(j=>wire.serviceStopsAhead[j]);
  delete wire.trial;
  wire.at=controlAt;wire.servedAt=controlAt;feed.buses[0].observed_at=controlAt;
  delete feed.buses[0].recent_speed;
  return feed;
}
function replaceRow(feed,stop,hops,point,low,high){
  const wire=feed.server_eta,ri=wire.rows.findIndex(r=>r[1]===stop&&r[5]===hops);assert(ri>=0,`Missing controlled row ${stop}/${hops}`);
  const row=wire.rows[ri];row[2]=point;row[3]=low;row[4]=high;row[7]=low;row[8]=low;
  wire.distributions[ri]=Array.from({length:50},(_,i)=>high===0?0:i<25?low+(point-low)*i/24:point+(high-point)*(i-25)/24);
}
function shiftHops(feed,delta){
  for(const row of feed.server_eta.rows)row[5]+=delta;
  for(const row of feed.server_eta.repeatVisits)row[2]+=delta;
}
function moving(high=361){
  const feed=singleBus(),bus=feed.buses[0],wire=feed.server_eta;
  Object.assign(bus,feed.stop_coords[150],{last_stop_id:150,stationary:false,at_stop_id:null,last_moved_at:new Date(controlAt).toISOString()});
  delete bus.at_stop_since;delete bus.stationary_since;
  wire.buses[0][2]=1;wire.buses[0][3]=null;wire.travel[0]=1;shiftHops(feed,1);
  replaceRow(feed,157,1,330,300,high);replaceRow(feed,165,2,600,570,650);return feed;
}
function curb(later){const feed=singleBus();replaceRow(feed,157,0,0,0,0);replaceRow(feed,157,12,later,later-100,later+100);return feed;}
function departure(){
  const feed=curb(1800),wire=feed.server_eta,bus=feed.buses[0],indices=wire.rows.flatMap((r,i)=>r[5]>=12?[i]:[]);
  wire.rows=indices.map(i=>wire.rows[i]);wire.distributions=indices.map(i=>wire.distributions[i]);
  if(Array.isArray(wire.serviceStopsAhead))wire.serviceStopsAhead=indices.map(i=>wire.serviceStopsAhead[i]);
  const retained=new Set(wire.rows.map(r=>r.join('|')));
  wire.repeatVisits=wire.repeatVisits.filter(r=>wire.rows.some(row=>row[0]===r[0]&&row[1]===r[1]&&row[5]===r[2]));
  assert(retained.size>0);shiftHops(feed,-1);
  const at=controlAt+5000;wire.at=at;wire.servedAt=at;wire.buses[0][2]=3;wire.buses[0][3]=null;wire.travel[0]=3;
  Object.assign(bus,feed.stop_coords[165],{observed_at:at,last_stop_id:165,stationary:false,at_stop_id:null,last_moved_at:new Date(at).toISOString()});
  delete bus.at_stop_since;delete bus.stationary_since;
  replaceRow(feed,157,11,1200,1100,1300);replaceRow(feed,165,12,1500,1450,1600);return feed;
}
const syntheticStep=(id,feed)=>({id,at:feed.server_eta.servedAt,feed,bytes:Buffer.from(JSON.stringify(feed)),synthetic:true});
const exhausted=moving();replaceRow(exhausted,157,1,330,0,0);
const invalid=moving();invalid.server_eta.v=0;
const controls=[
  {id:'width',steps:[...PROTOCOL.controls.width.highSequence.map((high,i)=>syntheticStep(`high-${high}-${i}`,moving(high))),syntheticStep('exhausted-band',exhausted)]},
  {id:'curb',steps:PROTOCOL.controls.curb.laterPickupSequence.map((later,i)=>syntheticStep(`later-${later}-${i}`,curb(later)))},
  {id:'departure',steps:[syntheticStep('current-curb',curb(1800)),syntheticStep('departed-return',departure())]},
  {id:'invalid',steps:[syntheticStep('valid',moving()),syntheticStep('wire-v0',invalid),syntheticStep('recovered',moving())]},
];
for(const scenario of controls)for(const step of scenario.steps){
  step.sha256=sha(step.bytes);await write(`synthetic-inputs/${scenario.id}-${step.id}.json`,step.bytes);
}
await json('synthetic-input-manifest-frozen-before-browser.json',controls.map(c=>({id:c.id,steps:c.steps.map(s=>({id:s.id,at:s.at,bytes:s.bytes.length,sha256:s.sha256}))})));

const assetCache=new Map(),assetPins=[];
const assetPath=/^\/assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{4,24}\.(?:js|css)$/;
const contentType=p=>p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p==='/healthz'?'application/json':'text/html';
async function fetchBytes(pathname){
  check();assert(pathname==='/'||pathname==='/healthz'||assetPath.test(pathname),'Non-admitted production fetch');
  const timeout=Math.max(1,Math.floor(Math.min(15000,LIMITS.wallMs-LIMITS.cleanupMs-(performance.now()-started))));
  const response=await fetch(productionOrigin+pathname,{redirect:'error',signal:AbortSignal.timeout(timeout)});
  assert(response.ok,`Static fetch ${pathname}: HTTP${response.status}`);
  const declared=response.headers.get('content-length');if(declared!==null)assert(Number(declared)<=LIMITS.assetFileBytes,'Asset content length exceeds cap');
  const parts=[];let bytes=0;
  for await(const part of response.body){check();const b=Buffer.from(part);bytes+=b.length;assetReadBytes+=b.length;assetAdmittedReadBytes+=b.length;assert(bytes<=LIMITS.assetFileBytes&&assetAdmittedReadBytes<=LIMITS.assetReadBytes,'Asset read cap exceeded');parts.push(b);}
  return Buffer.concat(parts);
}
async function asset(pathname){
  assert(pathname==='/'||pathname==='/healthz'||assetPath.test(pathname),'Non-admitted asset');
  if(!assetCache.has(pathname))assetCache.set(pathname,(async()=>{
    const assetRoot=path.join(SERVICE,'web/dist');
    const bytes=role==='production'?await fetchBytes(pathname):await boundedLocal(path.join(assetRoot,pathname==='/'?'index.html':pathname.slice(1)),LIMITS.assetFileBytes,{kind:'asset',root:assetRoot});
    const pin=await write(`assets/${pathname==='/'?'index.html':pathname==='/healthz'?'health-original.json':pathname.slice(8)}`,bytes);
    assetPins.push({pathname,source:role==='production'?productionOrigin+pathname:path.join(SERVICE,'web/dist',pathname),...pin});return bytes;
  })());
  return assetCache.get(pathname);
}
const result={protocol:PROTOCOL.id,role,scope:PROTOCOL.scope,actualStartedAt,node:process.version,platform:process.platform,
  productionBuild:null,manifestSHA256:sha(manifestBytes),fixtureReadBytes,allBrowserRequestsIntercepted:true,realReportsWritten:false,runs:[]};
try{
  if(role==='production'){
    const health=JSON.parse(await asset('/healthz'));assert.equal(health.build,manifest.sourceBuild,'Production build changed: refuse this role');
    result.productionBuild=health.build;result.productionHealthBefore={build:health.build,actualObservedAt:new Date().toISOString()};
  }
  const index=await asset('/');
  if(role==='production'){
    assert.equal(index.length,PRODUCTION_PIN.indexBytes,'Production index length changed before browser execution');
    assert.equal(sha(index),PRODUCTION_PIN.indexSHA256,'Production index changed before browser execution');
    result.productionPin=PRODUCTION_PIN;
  }
  assert(LIMITS.wallMs-LIMITS.cleanupMs-(performance.now()-started)>15000,'Insufficient remaining budget to admit browser launch');
  browserCustody.launchAttempted=true;
  browserServer=await chromium.launchServer({executablePath:process.env.BOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true,timeout:10000,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  browserProcess=browserServer.process();refreshBrowserCustody();assert(Number.isInteger(browserCustody.pid),'Owned browser PID unavailable');
  browserProcess.once('exit',()=>{refreshBrowserCustody();browserCustody.actualExitedAt=new Date().toISOString();});
  browser=await chromium.connect(browserServer.wsEndpoint(),{timeout:10000});
  const packageRoot=path.join(SERVICE,'node_modules/playwright-core');
  const playwrightPackage=await boundedLocal(path.join(packageRoot,'package.json'),65536,{kind:'fixture',root:packageRoot});
  result.browser={version:browser.version(),pid:browserCustody.pid,executable:process.env.BOT_CHROMIUM_PATH??'/usr/bin/chromium',playwrightVersion:JSON.parse(playwrightPackage).version};
  await json('browser-runtime.json',result.browser);
  const scenarios=[...PROTOCOL.contexts.map(context=>({id:`recorded-${context.id}`,recorded:true,context,steps:frames.map(f=>({id:`seq-${f.metadata.seq}`,at:f.metadata.originalReceiptAt,bytes:f.bytes,sha256:f.metadata.sha256,feed:f.value,metadata:f.metadata}))})),...controls.map(c=>({...c,recorded:false,context:PROTOCOL.contexts[0]}))];
  for(const width of PROTOCOL.widths)for(const scenario of scenarios){
    check();let active=scenario.steps[0],expanded=false,routeFailure;
    const run={id:`${width}-${scenario.id}`,width,scenario:scenario.id,recorded:scenario.recorded,context:scenario.context,requests:[],pageErrors:[],snapshots:[]};result.runs.push(run);
    const ctx=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500,timezoneId:'America/New_York',serviceWorkers:'block'});
    try{
      await seedTestId(ctx);
      const from={...baseline.stop_coords[157],lon:baseline.stop_coords[157].lon+scenario.context.eastLongitudeOffset},to=baseline.stop_coords[165];
      run.constructedTrip={from,to,pickup:157,destination:165,scope:PROTOCOL.contextScope};
      await ctx.addInitScript(({from,to,now})=>{
        localStorage.setItem('listView','trip');
        sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Replay diagnostic origin',fromLL:from,toText:'Replay destination stop165',toLL:to,tripTime:'',expandedKey:null,savedAt:now}));
      },{from,to,now:active.at});
      const page=activePage=await ctx.newPage();page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(15000);
      page.on('pageerror',error=>run.pageErrors.push(error.message));
      await page.clock.setFixedTime(active.at);
      const submissions=[];
      await ctx.route('**/*',async route=>{
        try{
          const request=route.request(),url=new URL(request.url());
          run.requests.push({path:url.origin===`https://${host}`?url.pathname:url.origin+url.pathname,method:request.method(),step:active.id,clock:active.at});
          if(url.origin!==`https://${host}`)return route.abort();
          if(url.pathname.startsWith('/api/')){
            if(url.pathname==='/api/buses'){
              assert.equal(request.method(),'GET');assert.equal(request.headers()['x-anon-id'],TEST_ANON_ID);
              const wire=active.feed.server_eta,source={v:1,sha256:active.sha256??sha(active.bytes),bytes:active.bytes.length,build:manifest.sourceBuild,modelAt:wire.at,servedAt:wire.servedAt};
              source.snapshotId=sha(JSON.stringify(source));
              return route.fulfill({body:active.bytes,contentType:'application/json',headers:{'X-Shuttle-Snapshot':JSON.stringify(source),'Cache-Control':'no-store'}});
            }
            if(url.pathname==='/api/report'){
              if(request.method()==='POST'){assert.equal(request.headers()['x-anon-id'],TEST_ANON_ID);submissions.push({step:active.id,body:request.postDataJSON()});return route.fulfill({json:{id:9000+submissions.length}});}
              return route.fulfill({json:{reports:[]}});
            }
            if(url.pathname==='/api/weather')return route.fulfill({status:204});
            return route.fulfill({json:{ok:true,reports:[],results:[],routes:[],rows:[],sample:0}});
          }
          if(request.method()!=='GET')return route.abort();
          if(url.pathname!=='/'&&!assetPath.test(url.pathname))return route.fulfill({status:404,body:''});
          return route.fulfill({body:await asset(url.pathname),contentType:contentType(url.pathname)});
        }catch(error){routeFailure??=error;await route.abort().catch(()=>{});}
      });
      await page.goto(`https://${host}/`,{waitUntil:'domcontentloaded'});
      const row=page.locator('tbody[data-route="Orange East"][data-pickup="157"]');await row.first().waitFor();
      assert.equal(await row.count(),1,'Constructed trip must expose one unambiguous Orange East pickup157 row');
      for(let i=0;i<scenario.steps.length;i++){
        active=scenario.steps[i];
        if(i){
          await page.clock.setFixedTime(active.at);
          const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/buses');
          await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await(await response).finished();
        }
        await page.waitForFunction(expected=>{
          const raw=document.querySelector('[data-feedback-source]')?.getAttribute('data-feedback-source');
          try{return JSON.parse(raw??'null')?.sha256===expected;}catch{return false;}
        },active.sha256??sha(active.bytes));
        if(!expanded){
          run.initialOverview=await json(`screens/${run.id}-initial-overview.json`,await row.evaluate(el=>({html:el.outerHTML,text:el.innerText})));
          await row.getByRole('button',{name:/^View Orange East trip details/}).click();
          await page.getByTestId('trip-detail-panel').waitFor();expanded=true;
        }
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert(!routeFailure,routeFailure?.stack);assert.equal(await page.evaluate(()=>Date.now()),active.at);
        const dom=await page.content();
        const rendered=await row.evaluate(el=>({html:el.outerHTML,text:el.innerText,attributes:Object.fromEntries([...el.attributes].map(a=>[a.name,a.value])),
          pickup:el.querySelector('[data-testid="route-pickup"]')?.textContent??null,range:el.querySelector('[data-testid="pickup-range"]')?.textContent??null,
          firstCells:[...el.querySelectorAll(':scope > tr:first-child > td')].map(td=>td.innerText)}));
        const expandedDOM=await page.getByTestId('trip-detail-panel').evaluate(el=>({html:el.outerHTML,text:el.innerText,
          approach:[...el.querySelectorAll('[data-testid="trip-approach-stops"] [data-stop-id]')].map(e=>({id:e.getAttribute('data-stop-id'),text:e.innerText})),
          stopList:el.querySelector('[data-testid="trip-stop-list"]')?.textContent??null}));
        const count=submissions.length,response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/report'&&r.request().method()==='POST');
        page.once('dialog',dialog=>dialog.accept(`Replay fixture ${run.id}/${active.id}; synthetic trip context.`));
        await page.getByRole('button',{name:'🚩 Report',exact:true}).click();await(await response).finished();
        assert.equal(submissions.length,count+1);const submitted=submissions.at(-1).body;
        assert(submitted.screen,'Actual route feedback must submit screen evidence');
        assert.equal(submitted.screen.source?.sha256,active.sha256??sha(active.bytes));
        assert.equal(submitted.screen.source?.receivedAt,active.at);assert.equal(submitted.screen.capturedAt,active.at);
        assert.equal(submitted.screen.truncated,false,'No silently truncated feedback evidence');
        const screenRow=submitted.screen.rows.find(r=>r.route==='Orange East'&&r.boardStopId===157);assert(screenRow,'Submitted screen must contain pickup157');
        const normalize=text=>(text??'').replace(/\s+/g,' ').trim();assert.equal(screenRow.board,normalize(rendered.firstCells[0]));
        const snapshot={step:active.id,recorded:scenario.recorded,originalMetadata:active.metadata??null,browserClock:active.at,payloadSHA256:active.sha256??sha(active.bytes),
          rendered,expanded:expandedDOM,submittedScreenRow:screenRow,submittedSource:submitted.screen.source,
          actualSelection:{busName:submitted.option?.busName,busBoardHops:submitted.option?.busBoardHops,livePickupSelection:submitted.option?.livePickupSelection,
            boardStopId:submitted.option?.boardStopId,alightStopId:submitted.option?.alightStopId,etaUnavailable:submitted.option?.etaUnavailable},
          allSourcePickupRows:active.feed.server_eta.rows.filter(r=>r[1]===157),
          noHorizontalOverflow:await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)};
        const domPin=await write(`screens/${run.id}-${active.id}.html`,dom),capturePin=await json(`screens/${run.id}-${active.id}.json`,{snapshot,submission:submitted});
        run.snapshots.push({step:active.id,browserClock:active.at,payloadSHA256:snapshot.payloadSHA256,dom:domPin,capture:capturePin});
        if(scenario.recorded||i===scenario.steps.length-1)await write(`screens/${run.id}-${active.id}.png`,await page.screenshot({fullPage:true,timeout:5000}));
        // Recorded cases are observations. Only deliberately constructed controls have presentation oracles.
        if(!scenario.recorded){
          const text=normalize(rendered.pickup??rendered.firstCells[0]);
          if(scenario.id==='width'){
            assert.match(text,/~5/,'330-second same-visit point uses existing floor-to-minutes formatter');
            if(active.id==='exhausted-band')assert.equal(rendered.range,null,'Exhausted [0,0] band is unavailable');
            else{assert(rendered.range,'Point and band must both remain visible across width boundary');assert.match(text,i===1?/\(5 – 6\)/:/\(5 – 7\)/);}
          }
          if(scenario.id==='curb'||scenario.id==='departure'&&i===0)assert.equal(text,'At stop','A fixed current curb must stay At stop');
          if(scenario.id==='departure'&&i===1){assert(!text.includes('At stop'),'A legitimate departure must not freeze At stop');assert.match(text,/~20/,'Retained return must supply its future pickup');assert.notEqual(submitted.option?.livePickupSelection?.countdown?.source,'raw-at-stop');}
          if(scenario.id==='invalid'){
            if(active.id==='wire-v0')assert.equal(text,'Unavailable');
            else{assert.match(text,/~5/);assert(rendered.range,'Valid recovery must restore the range');}
          }
        }
      }
      assert.deepEqual(run.pageErrors,[]);assert(!routeFailure,routeFailure?.stack);
      console.log(JSON.stringify({run:run.id,steps:run.snapshots.length,recordedObservational:run.recorded,controlsPassed:!run.recorded}));
    }catch(error){
      run.error=String(error.stack??error);
      if(routeFailure)run.routeFailure=String(routeFailure.stack??routeFailure);
      // Capture while the failed context still exists; the outer finally only
      // sees it after this context has been closed.
      if(activePage&&!activePage.isClosed()){
        await write(`screens/${run.id}-failure.html`,await activePage.content()).catch(e=>{run.failureCaptureError=String(e);});
        await write(`screens/${run.id}-failure.png`,await activePage.screenshot({fullPage:true,timeout:5000})).catch(e=>{run.failureScreenshotError=String(e);});
      }
      throw error;
    }finally{
      try{
        run.requestCount=run.requests.length;run.snapshotCount=run.snapshots.length;
        run.receipt=await json(`runs/${run.id}.json`,run);
      }finally{await ctx.unrouteAll({behavior:'wait'}).catch(()=>{});await ctx.close();activePage=null;}
    }
  }
  if(role==='production'){
    // Explicit second health GET; index and hashed assets remain cache-once.
    const bytes=await fetchBytes('/healthz'),pin=await write('assets/health-completion-original.json',bytes),health=JSON.parse(bytes);
    result.productionHealthAfter={build:health.build,actualObservedAt:new Date().toISOString(),...pin};
    assert.equal(health.build,PRODUCTION_PIN.build,'Observed production build changed during the role');
  }
  result.completed=true;terminal=true;
}catch(error){
  result.completed=false;result.error=String(error.stack??error);
  if(activePage&&!activePage.isClosed()){
    await write('failure.html',await activePage.content()).catch(e=>{result.failureCaptureError=String(e);});
    await write('failure.png',await activePage.screenshot({fullPage:true,timeout:5000})).catch(e=>{result.failureScreenshotError=String(e);});
  }
  process.exitCode=1;
}finally{
  try{
    try{await closeOwnedBrowser();}catch(error){
      browserCustody.cleanupErrors.push(String(error));terminal=false;process.exitCode=1;
      try{await closeOwnedBrowser(true);}catch(killError){browserCustody.cleanupErrors.push(String(killError));}
      refreshBrowserCustody();
    }
    result.completed=terminal&&!deadlineTriggered&&browserCustody.state==='closed';
    if(!result.completed)process.exitCode=process.exitCode||1;
    result.browserCustody=browserCustody;result.actualFinishedAt=new Date().toISOString();result.elapsedMs=performance.now()-started;
    result.inputAccounting={fixtureAndRuntimePayloadBytes:fixtureReadBytes,fixtureEOFProbes,fixtureEOFBytes,assetPayloadBytes:assetReadBytes,assetEOFProbes,assetEOFBytes,
      fixtureAdmittedReadBytes,assetAdmittedReadBytes};
    result.assetPins=assetPins;result.outputBytesBeforeResult=outputBytes;result.files=[...writes];
    result.runs=result.runs.map(run=>({id:run.id,width:run.width,scenario:run.scenario,recorded:run.recorded,requestCount:run.requestCount,snapshotCount:run.snapshotCount,error:run.error,receipt:run.receipt}));
    await json('result.json',result,{final:true});
  }finally{clearTimeout(timer);}
}
if(browserCustody.launchAttempted&&browserCustody.state!=='closed')process.exit(1); // Explicit refused/unknown custody is already retained.
assert(result.completed,'Replay did not complete with proven owned-browser closure; retained output is diagnostic only');
