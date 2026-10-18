import {afterEach,describe,expect,it} from 'vitest';
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
afterEach(async()=>{for(const dir of dirs.splice(0))await fs.rm(dir,{recursive:true,force:true});});
function fixture(id=142,assets=['/assets/rider-fixture.js']){
 const now=Date.now(),raw=JSON.stringify({buses:[{bus_name:'317',route_id:16}],server_eta:{v:2,at:now,servedAt:now+500}}),
  sha256=hash(raw),build='fixture-server',snapshotId=hash(JSON.stringify({sha256,build,evaluation:null})),
  source={v:1,snapshotId,sha256,build,bytes:Buffer.byteLength(raw),modelAt:now,servedAt:now+500},gzip=gzipSync(raw);
 const bundle={v:1,source,capturedAt:now,retainedAt:now+1000,gzipSha256:hash(gzip),gzipBytes:gzip.length,gzipBase64:gzip.toString('base64')};
 const bytes=Buffer.from(JSON.stringify(bundle)+'\n'),receipt={v:1,status:'retained',snapshotId,sha256,bundleSha256:hash(bytes),bytes:bytes.length};
 const report={id,status:'open',createdAt:new Date(now).toISOString(),body:'The shuttle time changed',priority:'normal',
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

describe('report source and client asset preservation',()=>{
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
