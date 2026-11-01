import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {preserveReportEvidence,reportScreenFacts} from './evidence.mjs';
import {pollReports} from './poll.mjs';

const dirs=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const makeDir=async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shuttle-report-inputs-'));dirs.push(dir);return dir;};
afterEach(async()=>{vi.restoreAllMocks();for(const dir of dirs.splice(0))await fs.rm(dir,{recursive:true,force:true});});
function fixture(id=142,assets=['/assets/rider-fixture.js']){
 const now=Date.now(),raw=JSON.stringify({buses:[{bus_name:'317',route_id:16}],server_eta:{v:2,at:now,servedAt:now+500}}),
  sha256=hash(raw),build='fixture-server',snapshotId=hash(JSON.stringify({sha256,build,evaluation:null})),
  source={v:1,snapshotId,sha256,build,bytes:Buffer.byteLength(raw),modelAt:now,servedAt:now+500},gzip=gzipSync(raw);
 const bundle={v:1,source,capturedAt:now,retainedAt:now+1000,gzipSha256:hash(gzip),gzipBytes:gzip.length,gzipBase64:gzip.toString('base64')};
 const bytes=Buffer.from(JSON.stringify(bundle)+'\n'),receipt={v:1,status:'retained',snapshotId,sha256,bundleSha256:hash(bytes),bytes:bytes.length};
 const report={id,status:'open',createdAt:new Date(now).toISOString(),body:'The shuttle time changed',priority:'normal',note:null,
  context:JSON.stringify({client:{userLatLon:{lat:41.31123,lon:-72.91234},privateAddress:'Private house'},
   screen:{v:1,capturedAt:now+700,build:'fixture-bundle',view:'trip',source:{...source,receivedAt:now+600},assets,
    rows:[{mode:'shuttle',route:'Blue West',boardStopId:156,board:'20 (13–40)',userLatLon:'private'}]},serverEvidence:receipt})};
 const calls=[];
 const fetcher=async(url,options)=>{
  calls.push({url:String(url),options});const pathname=new URL(url).pathname;
  if(pathname===`/api/reports/${id}/evidence`)return new Response(bytes,{headers:{'content-type':'application/json','x-content-sha256':hash(bytes)}});
  if(pathname==='/assets/rider-fixture.js')return new Response('console.log("controlled fixture")',{headers:{'content-type':'text/javascript'}});
  return new Response('<html>SPA fallback</html>',{headers:{'content-type':'text/html'}});
 };
 return {now,raw,bundle,bytes,receipt,report,fetcher,calls};
}
async function manifest(dir,id){
 const directory=path.join(dir,'evidence','reports',String(id)),index=JSON.parse(await fs.readFile(path.join(directory,'latest.json'),'utf8'));
 const bytes=await fs.readFile(path.join(directory,index.file));expect(hash(bytes)).toBe(index.sha256);
 return {value:JSON.parse(bytes.toString()),bytes,file:path.join(directory,index.file)};
}
// Synthetic immutable receipts share one exact-cap public asset. No live report
// or scientific input is used; each pointer/manifest has an independent digest.
async function retainedRows(dir,count=16){
 const bytes=Buffer.alloc(6*1024*1024,65),sha256=hash(bytes),name=sha256+'.js',objectFile=path.join(dir,'evidence/objects',name);
 await fs.mkdir(path.dirname(objectFile),{recursive:true});await fs.writeFile(objectFile,bytes);
 const reports=[],receipts=[];
 for(let i=0;i<count;i++){
  const report={id:1000+i,status:'open',context:JSON.stringify({screen:{v:1,view:'trip',assets:[]}})},screen=reportScreenFacts(JSON.parse(report.context).screen),saved={status:'unavailable',reason:'source-not-supplied'};
  const value={v:1,id:report.id,version:hash(JSON.stringify({screen,saved})),capturedAt:'2026-11-01T00:00:00.000Z',screen,source:saved,assets:[],
   artifacts:[{name,sha256,bytes:bytes.length}],retryable:false},directory=path.join(dir,'evidence/reports',String(report.id)),file='attempt-1-'+'a'.repeat(16)+'.json';
  await fs.mkdir(directory,{recursive:true});const raw=Buffer.from(JSON.stringify(value)+'\n');await fs.writeFile(path.join(directory,file),raw);
  await fs.writeFile(path.join(directory,'latest.json'),JSON.stringify({v:1,file,sha256:hash(raw)})+'\n');
  reports.push(report);receipts.push({value,raw,file:path.join(directory,file),index:path.join(directory,'latest.json')});
 }
 return {reports,receipts,bytes,objectFile,options:{dir,reports,base:'https://shuttle.test',token:'test-only',fetcher:async()=>{throw Error('unchanged evidence must not fetch');}}};
}

describe('report source and client asset preservation',()=>{
 it('keeps only public navigation facts and the optional validated click-time source receipt',()=>{
  const source={v:1,snapshotId:'a'.repeat(64),sha256:'b'.repeat(64),bytes:120,build:'public-build',modelAt:1000,servedAt:1100,
   evaluation:{epoch:'public-epoch',cursor:7,at:1000,sha256:'c'.repeat(64)}};
  const intent={provider:'google-maps',mode:'walking',publicStopId:77,walkLabel:' 3  min ',requestedAt:1200,
   url:'https://private.test/directions',address:'Private house',userLatLon:{lat:41.31,lon:-72.91},token:'secret',
   source:{...source,receivedAt:1150,token:'secret',evaluation:{...source.evaluation,url:'https://private.test'}}};
  const before=JSON.stringify(intent),screen=reportScreenFacts({navigationIntent:intent});
  expect(screen.navigationIntent).toEqual({provider:'google-maps',mode:'walking',publicStopId:77,walkLabel:'3 min',requestedAt:1200,source});
  expect(JSON.stringify(screen)).not.toMatch(/private\.test|Private house|userLatLon|secret|receivedAt/);
  expect(JSON.stringify(intent)).toBe(before);
  expect(reportScreenFacts({navigationIntent:{...intent,walkLabel:'',source:undefined}}).navigationIntent.walkLabel).toBe('');
  for(const invalid of [{provider:'other'},{mode:'driving'},{publicStopId:0},{publicStopId:2_147_483_648},
   {publicStopId:1.5},{publicStopId:'77'},{walkLabel:'https://private.test'},{walkLabel:'0 min'},
   {walkLabel:3},{requestedAt:-1},{requestedAt:NaN}]){
   expect(reportScreenFacts({navigationIntent:{...intent,...invalid}})).not.toHaveProperty('navigationIntent');
  }
  for(const invalid of [{v:2},{snapshotId:'invalid'},{bytes:2*1024*1024+1},{build:'https://private.test'},
   {modelAt:1200},{evaluation:{...source.evaluation,cursor:0}},
   {evaluation:{...source.evaluation,at:999}},{evaluation:{...source.evaluation,epoch:'private/address'}}]){
   const projected=reportScreenFacts({navigationIntent:{...intent,source:{...source,...invalid}}}).navigationIntent;
   expect(projected).toEqual({provider:'google-maps',mode:'walking',publicStopId:77,walkLabel:'3 min',requestedAt:1200});
  }
 });
 it('leaves the projected bytes and evidence version unchanged for clients without a valid intent',()=>{
  const input={v:1,capturedAt:1793490000000,build:'6aed223edaec',view:'trip',tripDetail:true,rows:[],assets:[],sourceScope:'public-input-for-render'};
  const expected='{"v":1,"capturedAt":1793490000000,"build":"6aed223edaec","view":"trip","tripDetail":true,"rows":[],"truncated":false,"sourceScope":"public-input-for-render","assets":[]}';
  const saved={status:'unavailable',reason:'source-not-supplied'};
  for(const screen of [reportScreenFacts(input),... [undefined,null,{},[]].map(navigationIntent=>reportScreenFacts({...input,navigationIntent}))]){
   expect(screen).not.toHaveProperty('navigationIntent');expect(JSON.stringify(screen)).toBe(expected);
   expect(hash(JSON.stringify({screen,saved}))).toBe('275bdd5dd9f42d3d1c921a62b379da96f2223bca47ad8558398bb779c3e59924');
  }
 });
 it('creates immutable evidence versions for intent-only changes without fetching a click-time source',async()=>{
  const dir=await makeDir(),f=fixture(142,[]),screen={v:1,capturedAt:f.now,build:'fixture-bundle',view:'trip',assets:[]};
  const report=navigationIntent=>({...f.report,context:JSON.stringify({screen:{...screen,...(navigationIntent?{navigationIntent}:{})}})});
  const options={dir,base:'https://shuttle.test',token:'test-only-admin',fetcher:f.fetcher};
  await preserveReportEvidence({...options,reports:[report()],now:f.now});const legacy=await manifest(dir,142);
  const first={provider:'google-maps',mode:'walking',publicStopId:77,walkLabel:'3 min',requestedAt:f.now-1000,source:f.bundle.source};
  await preserveReportEvidence({...options,reports:[report(first)],now:f.now+60000});const before=await manifest(dir,142);
  const second={...first,publicStopId:98,walkLabel:'7 min'};
  await preserveReportEvidence({...options,reports:[report(second)],now:f.now+120000});const after=await manifest(dir,142);
  expect(legacy.value.screen).not.toHaveProperty('navigationIntent');
  expect(before.value.screen.navigationIntent).toEqual(first);expect(after.value.screen.navigationIntent).toEqual(second);
  expect(before.value.version).not.toBe(legacy.value.version);expect(after.value.version).not.toBe(before.value.version);
  expect(after.file).not.toBe(before.file);expect(await fs.readFile(before.file)).toEqual(before.bytes);
  expect(await fs.readFile(legacy.file)).toEqual(legacy.bytes);
  expect(after.value.source).toEqual({status:'unavailable',reason:'source-not-supplied'});expect(f.calls).toEqual([]);
 });
 it('verifies exact server source bytes and saves reported assets without sending the admin credential to them',async()=>{
  const dir=await makeDir(),f=fixture(142,['/assets/rider-fixture.js','/assets/older-bundle.js']);
  const result=await preserveReportEvidence({dir,reports:[f.report],base:'https://shuttle.test',token:'test-only-admin',fetcher:f.fetcher,now:f.now});
  expect(result.ok).toBe(true);expect(result.captured).toEqual([142]);
  const saved=(await manifest(dir,142)).value;
  expect(saved.source.status).toBe('retained');expect(saved.assets[0].status).toBe('retained');
  expect(saved.assets[1]).toMatchObject({status:'unavailable',reason:'asset-not-retained'});
  const original=await fs.readFile(path.join(dir,'evidence/objects',saved.source.artifact.name));
  expect(original).toEqual(f.bytes);expect(gunzipSync(Buffer.from(JSON.parse(original).gzipBase64,'base64')).toString()).toBe(f.raw);
  expect(f.calls[0].options.headers).toEqual({'x-admin-token':'test-only-admin'});
  expect(f.calls.slice(1).every(c=>!c.options.headers)).toBe(true);
  expect(JSON.stringify(saved)).not.toMatch(/userLatLon|privateAddress|41\.31123|test-only-admin|Private house/);
  const count=f.calls.length;
  await preserveReportEvidence({dir,reports:[f.report],base:'https://shuttle.test',token:'test-only-admin',fetcher:f.fetcher,now:f.now+60000});
  expect(f.calls).toHaveLength(count);
 });
 it('never requests reporter-supplied URLs, private paths or traversal, and accepts an old client without inventing source',async()=>{
  const dir=await makeDir(),f=fixture();
  const report={...f.report,context:JSON.stringify({screen:{assets:['https://private.test/secret','/api/reports/1/image','/assets/../private.js']}})};
  const result=await preserveReportEvidence({dir,reports:[report],base:'https://shuttle.test',token:'secret',fetcher:f.fetcher,now:f.now});
  expect(result.ok).toBe(true);expect(result.unavailable).toEqual([142]);expect(f.calls).toEqual([]);
  expect((await manifest(dir,142)).value.source).toEqual({status:'unavailable',reason:'source-not-supplied'});
  expect(reportScreenFacts({source:{secret:'private'},userLatLon:'private',rows:[{route:'Red',secret:'private'}]})).not.toHaveProperty('userLatLon');
 });
 it('retains a failed attempt and retries checksum failure on the next poll instead of substituting the latest response',async()=>{
  const dir=await makeDir(),f=fixture(142,[]);let failed=true;
  const fetcher=async(url,options)=>failed?new Response(f.bytes,{headers:{'x-content-sha256':'0'.repeat(64)}}):f.fetcher(url,options);
  const before=await preserveReportEvidence({dir,reports:[f.report],base:'https://shuttle.test',token:'test-only',fetcher,now:f.now});
  expect(before.ok).toBe(false);expect(before.retrying).toEqual([142]);const original=await manifest(dir,142);
  expect(original.value.source.status).toBe('unavailable');failed=false;
  const after=await preserveReportEvidence({dir,reports:[f.report],base:'https://shuttle.test',token:'test-only',fetcher,now:f.now+60000});
  expect(after.ok).toBe(true);expect((await manifest(dir,142)).value.source.sha256).toBe(f.receipt.sha256);
  expect(await fs.readFile(original.file)).toEqual(original.bytes);
 });
 it('records permanent expiry explicitly and refuses a corrupt retained artifact',async()=>{
  const dir=await makeDir(),f=fixture(142,[]);
  const expired=await preserveReportEvidence({dir,reports:[f.report],base:'https://shuttle.test',token:'test-only',fetcher:async()=>new Response(null,{status:410}),now:f.now});
  expect(expired.ok).toBe(true);expect(expired.unavailable).toEqual([142]);expect((await manifest(dir,142)).value.source.reason).toBe('source-expired');
  const another=await makeDir();await preserveReportEvidence({dir:another,reports:[f.report],base:'https://shuttle.test',token:'test-only',fetcher:f.fetcher,now:f.now});
  const saved=(await manifest(another,142)).value,file=path.join(another,'evidence/objects',saved.source.artifact.name);
  await fs.writeFile(file,'corrupt-but-retained');
  const corrupt=await preserveReportEvidence({dir:another,reports:[f.report],base:'https://shuttle.test',token:'test-only',fetcher:f.fetcher,now:f.now+60000});
  expect(corrupt.ok).toBe(false);expect(corrupt.retrying).toEqual([142]);
  expect(await fs.readFile(file,'utf8')).toBe('corrupt-but-retained');
 });
 it('protects open reports during rolling cleanup and preserves older reports when the queue is truncated',async()=>{
  const dir=await makeDir(),f=fixture(142,[]),other={...f.report,id:143};
  const fetcher=async(url,options)=>f.fetcher(new URL(String(url).replace('/143/evidence','/142/evidence')),options);
  await preserveReportEvidence({dir,reports:[f.report,other],base:'https://shuttle.test',token:'test-only',fetcher,now:f.now});
  await preserveReportEvidence({dir,reports:[f.report],base:'https://shuttle.test',token:'test-only',fetcher,now:f.now+10000,maxAgeMs:1,complete:false});
  expect((await manifest(dir,143)).value.id).toBe(143);
  await preserveReportEvidence({dir,reports:[f.report],base:'https://shuttle.test',token:'test-only',fetcher,now:f.now+20000,maxAgeMs:1,complete:true});
  expect((await manifest(dir,142)).value.source.sha256).toBe(f.receipt.sha256);
  await expect(fs.stat(path.join(dir,'evidence/reports/143'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('refuses a protected full store without removing original evidence',async()=>{
  const dir=await makeDir(),f=fixture(142,[]);
  const initial=await preserveReportEvidence({dir,reports:[f.report],base:'https://shuttle.test',token:'test-only',fetcher:f.fetcher,now:f.now});
  const before=await manifest(dir,142),other={...f.report,id:143};
  const fetcher=async(url,options)=>f.fetcher(new URL(String(url).replace('/143/evidence','/142/evidence')),options);
  const full=await preserveReportEvidence({dir,reports:[f.report,other],base:'https://shuttle.test',token:'test-only',fetcher,now:f.now+60000,maxBytes:initial.bytes+10});
  expect(full.ok).toBe(false);expect(full.retrying).toEqual([143]);
  expect(await fs.readFile(before.file)).toEqual(before.bytes);
 });
 it('keeps orphaned crash files and their possible inputs instead of silently collecting uncertain data',async()=>{
  const dir=await makeDir(),f=fixture(142,[]);
  await preserveReportEvidence({dir,reports:[f.report],base:'https://shuttle.test',token:'test-only',fetcher:f.fetcher,now:f.now});
  const reportDir=path.join(dir,'evidence/reports/142'),tmp=path.join(reportDir,'attempt-incomplete.tmp');await fs.writeFile(tmp,'partial receipt');
  const orphan=path.join(dir,'evidence/objects','f'.repeat(64)+'.json');await fs.writeFile(orphan,'possible unreferenced input');
  const result=await preserveReportEvidence({dir,reports:[f.report],base:'https://shuttle.test',token:'test-only',fetcher:f.fetcher,now:f.now+60000});
  expect(result.cleanupUncertain).toBe(true);expect(await fs.readFile(orphan,'utf8')).toContain('possible');
  expect(await fs.readFile(tmp,'utf8')).toBe('partial receipt');
  // An empty unknown directory is also uncertain, even without a file to enter
  // the byte inventory. Its presence cannot authorize orphan collection.
  await fs.unlink(tmp);await fs.mkdir(path.join(dir,'evidence/objects/unknown-directory'));
  const unknown=await preserveReportEvidence({dir,reports:[f.report],base:'https://shuttle.test',token:'test-only',fetcher:f.fetcher,now:f.now+120000});
  expect(unknown.cleanupUncertain).toBe(true);expect(await fs.readFile(orphan,'utf8')).toContain('possible');
 });
 it('hashes one shared exact-cap object once for sixteen unchanged reports, with fresh identity checks for every reference',async()=>{
  const dir=await makeDir(),f=await retainedRows(dir),originalOpen=fs.open.bind(fs);let opens=0;
  vi.spyOn(fs,'open').mockImplementation(async(file,...args)=>{if(file===f.objectFile)opens++;return originalOpen(file,...args);});
  const result=await preserveReportEvidence(f.options);
  expect(result.ok).toBe(true);expect(result.verified).toEqual(f.reports.map(report=>report.id));
  expect(result.work.objectHashes).toBe(1);expect(result.work.objectCacheHits).toBe(15);expect(opens).toBe(16);
  expect(result.work.readBytes).toBeLessThan(f.bytes.length+128*1024);
  expect(result.work.limits).toEqual({readBytes:256*1024*1024,operations:64_000,milliseconds:30_000});
  expect((await fs.readFile(f.objectFile)).equals(f.bytes)).toBe(true);
  for(const receipt of f.receipts)expect(await fs.readFile(receipt.file)).toEqual(receipt.raw);
 });
 it('compares each manifest expectation even after the same object was positively cached',async()=>{
  for(const conflict of [{sha256:'0'.repeat(64)},{bytes:1}]){
   const dir=await makeDir(),f=await retainedRows(dir,2),receipt=f.receipts[1];Object.assign(receipt.value.artifacts[0],conflict);
   const raw=Buffer.from(JSON.stringify(receipt.value)+'\n');await fs.writeFile(receipt.file,raw);
   await fs.writeFile(receipt.index,JSON.stringify({v:1,file:path.basename(receipt.file),sha256:hash(raw)})+'\n');
   const result=await preserveReportEvidence(f.options);
   expect(result.ok).toBe(false);expect(result.verified).toEqual([1000]);expect(result.retrying).toEqual([1001]);
   expect(await fs.readFile(receipt.file)).toEqual(raw);expect((await fs.readFile(f.objectFile)).equals(f.bytes)).toBe(true);
  }
 });
 it('detects atomic replacement between cached references and preserves the corrupt retained bytes for investigation',async()=>{
  const dir=await makeDir(),f=await retainedRows(dir,2),originalOpen=fs.open.bind(fs);let opens=0;
  const corrupt=Buffer.alloc(f.bytes.length,66);
  vi.spyOn(fs,'open').mockImplementation(async(file,...args)=>{
   if(file===f.objectFile&&++opens===2){const replacement=file+'.replacement';await fs.writeFile(replacement,corrupt);await fs.rename(replacement,file);}
   return originalOpen(file,...args);
  });
  const result=await preserveReportEvidence(f.options);
  expect(result.ok).toBe(false);expect(result.verified).toEqual([1000]);expect(result.retrying).toEqual([1001]);
  expect(result.work.objectCacheHits).toBe(0);expect((await fs.readFile(f.objectFile)).equals(corrupt)).toBe(true);
  for(const receipt of f.receipts)expect(await fs.readFile(receipt.file)).toEqual(receipt.raw);
 });
 it('defers before unchanged validation on deadline and rotates the next poll beyond the attempted prefix',async()=>{
  const dir=await makeDir(),f=await retainedRows(dir),originalOpen=fs.open.bind(fs);let at=0,opens=0;
  vi.spyOn(fs,'open').mockImplementation(async(file,...args)=>{if(file===f.objectFile&&++opens===2)at=30_000;return originalOpen(file,...args);});
  const first=await preserveReportEvidence({...f.options,clock:()=>at});
  expect(first.ok).toBe(false);expect(first.verified).toEqual([1000]);expect(first.deferred).toContain(1001);expect(first.deferred).toContain(1015);
  expect(first.work.cursor).toBe(1001);expect(opens).toBe(2);
  // pollReports persists this same returned continuation before rejecting !ok.
  await fs.writeFile(path.join(dir,'evidence-status.json'),JSON.stringify(first));at=0;opens=0;
  const second=await preserveReportEvidence({...f.options,clock:()=>at});
  expect(second.verified).toEqual([1002]);expect(second.ok).toBe(false);expect(second.work.cursor).toBe(1003);
  vi.restoreAllMocks();await fs.writeFile(path.join(dir,'evidence-status.json'),JSON.stringify(second));
  const resumed=await preserveReportEvidence(f.options);expect(resumed.ok).toBe(true);expect(resumed.verified).toHaveLength(16);
  for(const receipt of f.receipts)expect(await fs.readFile(receipt.file)).toEqual(receipt.raw);
 });
 it('reserves remaining work for validation when bounded maintenance used more than half the time window',async()=>{
  const dir=await makeDir(),f=await retainedRows(dir,2),originalOpen=fs.open.bind(fs);let at=0;
  vi.spyOn(fs,'open').mockImplementation(async(file,...args)=>{if(file===f.receipts[0].file)at=16_000;return originalOpen(file,...args);});
  const result=await preserveReportEvidence({...f.options,clock:()=>at});
  expect(result.ok).toBe(true);expect(result.verified).toEqual([1000,1001]);expect(result.work.objectHashes).toBe(1);
 });
 it('advances beyond an oldest incomplete capture deferred before committing a new attempt',async()=>{
  const dir=await makeDir(),f=await retainedRows(dir,2);let at=0,defer=true;const requests=[];
  for(let i=0;i<f.reports.length;i++){
   const report=f.reports[i],receipt=f.receipts[i];report.context=JSON.stringify({screen:{v:1,view:'trip',assets:[`/assets/retry-${report.id}.js`]}});
   receipt.value.retryable=true;receipt.value.capturedAt=new Date(1000+i).toISOString();receipt.raw=Buffer.from(JSON.stringify(receipt.value)+'\n');
   await fs.writeFile(receipt.file,receipt.raw);await fs.writeFile(receipt.index,JSON.stringify({v:1,file:path.basename(receipt.file),sha256:hash(receipt.raw)})+'\n');
  }
  const options={...f.options,clock:()=>at,fetcher:async url=>{requests.push(new URL(url).pathname);if(defer)at=30_000;
   return new Response('controlled retry asset',{headers:{'content-type':'text/javascript'}});}};
  const first=await preserveReportEvidence(options);expect(first.ok).toBe(false);expect(first.work.cursor).toBe(1000);
  expect(first.deferred).toEqual([1000,1001]);expect(requests).toEqual(['/assets/retry-1000.js']);
  for(const receipt of f.receipts)expect(await fs.readFile(receipt.file)).toEqual(receipt.raw);
  await fs.writeFile(path.join(dir,'evidence-status.json'),JSON.stringify(first));at=0;defer=false;requests.length=0;
  const resumed=await preserveReportEvidence(options);expect(resumed.ok).toBe(true);
  expect(requests).toEqual(['/assets/retry-1001.js','/assets/retry-1000.js']);
  expect((await manifest(dir,1001)).value.retryable).toBe(false);
  for(const receipt of f.receipts)expect(await fs.readFile(receipt.file)).toEqual(receipt.raw);
 });
 it('leaves incomplete maintenance and all unverified rows explicit under a lower read budget, then resumes without deleting possible inputs',async()=>{
  const dir=await makeDir(),f=await retainedRows(dir,2),orphan=path.join(dir,'evidence/objects','f'.repeat(64)+'.json');await fs.writeFile(orphan,'possibly referenced input');
  const limited=await preserveReportEvidence({...f.options,workLimits:{readBytes:1}});
  expect(limited.ok).toBe(false);expect(limited.cleanupUncertain).toBe(true);expect(limited.maintenanceDeferred).toBe(true);
  expect(limited.deferred).toEqual([1000,1001]);expect(limited.verified).toEqual([]);expect(limited.work.readBytes).toBeLessThanOrEqual(1);
  expect(await fs.readFile(orphan,'utf8')).toBe('possibly referenced input');
  for(const receipt of f.receipts)expect(await fs.readFile(receipt.file)).toEqual(receipt.raw);
  const resumed=await preserveReportEvidence(f.options);expect(resumed.ok).toBe(true);expect(resumed.verified).toEqual([1000,1001]);
 });
 it('saves and notifies the report queue before a source outage and retries after event deduplication',async()=>{
  const dir=await makeDir(),f=fixture(142,[]),tokenFile=path.join(dir,'token');await fs.writeFile(tokenFile,'test-only-admin');
  let failed=true,notified=0;
  const fetcher=async(url,options)=>new URL(url).pathname==='/api/reports'?{ok:true,json:async()=>({reports:[f.report]})}
   :failed?new Response(null,{status:503}):f.fetcher(url,options);
  const options={dir,tokenFile,base:'https://shuttle.test',fetcher,notifier:async events=>{notified+=events.length;},healthNotifier:async()=>{}};
  await expect(pollReports({...options,now:f.now})).rejects.toThrow('Report check failed');
  const queue=JSON.parse(await fs.readFile(path.join(dir,'queue.json'),'utf8'));expect(queue.pending.map(r=>r.id)).toEqual([142]);expect(notified).toBe(1);
  const failedStatus=JSON.parse(await fs.readFile(path.join(dir,'status.json'),'utf8'));expect(failedStatus.pending).toBe(1);
  failed=false;const healthy=await pollReports({...options,now:f.now+60000});
  expect(healthy.ok).toBe(true);expect(notified).toBe(1);expect((await manifest(dir,142)).value.source.status).toBe('retained');
 });
});
