import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const asset=value=>typeof value==='string'&&/^\/assets\/[A-Za-z0-9._-]{1,150}\.(?:js|css)$/.test(value);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=160)=>typeof value==='string'?value.slice(0,max):undefined;
const number=value=>Number.isSafeInteger(value)&&value>=0?value:undefined;
const artifactName=/^[a-f0-9]{64}\.(?:json|js|css)$/;
const attemptName=/^attempt-\d+-[a-f0-9]{16}\.json$/;

// Match feedbackScreen.ts's public click metadata; never retain a navigation URL,
// planner object, address or rider fix. This receipt does not request source bytes.
function navigationSourceFacts(input){
 if(!object(input)||input.v!==1||!sha(input.snapshotId)||!sha(input.sha256)
  ||number(input.bytes)===undefined||input.bytes>2*1024*1024||typeof input.build!=='string'
  ||!/^[A-Za-z0-9_-]{1,80}$/.test(input.build)||!(input.modelAt===null||number(input.modelAt)!==undefined)
  ||!(input.servedAt===null||number(input.servedAt)!==undefined)
  ||(input.modelAt!==null&&input.servedAt!==null&&input.modelAt>input.servedAt))return undefined;
 const result={v:1,snapshotId:input.snapshotId,sha256:input.sha256,bytes:input.bytes,
  build:input.build,modelAt:input.modelAt,servedAt:input.servedAt};
 if(input.evaluation!==undefined){
  const e=input.evaluation;
  if(!object(e)||typeof e.epoch!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(e.epoch)
   ||number(e.cursor)===undefined||e.cursor===0||number(e.at)===undefined||e.at!==result.modelAt||!sha(e.sha256))return undefined;
  result.evaluation={epoch:e.epoch,cursor:e.cursor,at:e.at,sha256:e.sha256};
 }
 return result;
}
function navigationIntentFacts(input){
 if(!object(input)||input.provider!=='google-maps'||input.mode!=='walking'||number(input.requestedAt)===undefined
  ||number(input.publicStopId)===undefined||input.publicStopId<1||input.publicStopId>2_147_483_647
  ||typeof input.walkLabel!=='string')return undefined;
 const walkLabel=input.walkLabel.replace(/\s+/g,' ').trim().slice(0,24);
 if(!/^(?:[1-9]\d{0,4} min)?$/.test(walkLabel))return undefined;
 const source=navigationSourceFacts(input.source);
 return {provider:'google-maps',mode:'walking',publicStopId:input.publicStopId,walkLabel,requestedAt:input.requestedAt,
  ...(source?{source}:{})};
}

/** Keep public screen facts, never whole planner/client objects or credentials. */
export function reportScreenFacts(input){
 if(!object(input))return null;
 const rows=(Array.isArray(input.rows)?input.rows:[]).slice(0,32).filter(row=>object(row)&&['walk','shuttle'].includes(row.mode)).map(row=>({
  mode:row.mode,route:text(row.route,80),
  ...Object.fromEntries(['boardStopId','alightStopId','stopsAhead'].map(k=>[k,number(row[k])])),
  ...Object.fromEntries(['busName','countdownBusName','pickupChoice','board','next','arrive','legs','approaching'].map(k=>[k,text(row[k])])),
 }));
 const s=input.source,e=object(s?.evaluation)?s.evaluation:null;
 const source=object(s)?{v:s.v===1?1:undefined,snapshotId:sha(s.snapshotId)?s.snapshotId:undefined,
  sha256:sha(s.sha256)?s.sha256:undefined,bytes:number(s.bytes),build:text(s.build,80),
  modelAt:s.modelAt===null?null:number(s.modelAt),servedAt:s.servedAt===null?null:number(s.servedAt),receivedAt:number(s.receivedAt),
  ...(e?{evaluation:{epoch:text(e.epoch,100),cursor:number(e.cursor),at:number(e.at),sha256:sha(e.sha256)?e.sha256:undefined}}:{})}:undefined;
 const navigationIntent=navigationIntentFacts(input.navigationIntent);
 return {v:1,capturedAt:number(input.capturedAt),build:text(input.build,24),view:text(input.view,24),
  tripDetail:input.tripDetail===true,rows,truncated:input.truncated===true,source,
  sourceScope:input.sourceScope==='public-input-for-render'?input.sourceScope:undefined,
  sourceUnavailable:['not-supplied','invalid'].includes(input.sourceUnavailable)?input.sourceUnavailable:undefined,
  assets:[...new Set((Array.isArray(input.assets)?input.assets:[]).filter(asset))].slice(0,8),
  ...(navigationIntent?{navigationIntent}:{})};
}

const WORK_LIMITS={readBytes:256*1024*1024,operations:64_000,milliseconds:30_000};
const JSON_LIMIT=4*1024*1024,ASSET_LIMIT=6*1024*1024;
class Deferred extends Error{}
const identity=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
function workBudget(limits,clock){
 const bounded=(key)=>Number.isSafeInteger(limits?.[key])&&limits[key]>0?Math.min(limits[key],WORK_LIMITS[key]):WORK_LIMITS[key];
 const caps=Object.fromEntries(Object.keys(WORK_LIMITS).map(key=>[key,bounded(key)])),started=clock();
 const work={readBytes:0,operations:0,objectHashes:0,objectCacheHits:0,caps,
  check(){if(clock()-started>=caps.milliseconds)throw new Deferred('evidence-poll-deadline');},
  discoveryWindow(){const until=clock()+(caps.milliseconds-(clock()-started))/2,operations=(this.operations+caps.operations)/2,bytes=(this.readBytes+caps.readBytes)/2;
   return ()=>clock()>=until||this.operations>=operations||this.readBytes>=bytes;},
  charge(operations=1,bytes=0){this.check();if(this.operations+operations>caps.operations||this.readBytes+bytes>caps.readBytes)throw new Deferred('evidence-work-limit');this.operations+=operations;this.readBytes+=bytes;},
  remaining(){this.check();return Math.max(1,Math.floor(Math.min(10000,caps.milliseconds-(clock()-started))));}};
 return work;
}
async function readLimited(response,max,work){
 work.check();
 const length=Number(response.headers?.get('content-length'));
 if(Number.isFinite(length)&&length>max)throw Error('evidence-response-too-large');
 const reader=response.body?.getReader();
 if(!reader)throw Error('evidence-response-body-missing');
 let size=0;const chunks=[];
 try{for(;;){work.check();const {value,done}=await reader.read();if(done)break;work.charge(0,value.byteLength);size+=value.byteLength;
  if(size>max)throw Error('evidence-response-too-large');chunks.push(Buffer.from(value));}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 finally{reader.releaseLock();}
 return Buffer.concat(chunks);
}
// Admit a fixed extent, then one EOF probe. Cache hits still reopen nofollow and
// compare both the descriptor and named identity; pathname alone proves nothing.
async function readFile(file,max,work,{expected,cache}={}){
 work.charge(2);const fd=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  work.charge();const before=await fd.stat({bigint:true});
  if(!before.isFile()||before.size>BigInt(max))throw Error('evidence-file-too-large-or-not-regular');
  const key=expected?`${file}\0${expected.sha256}\0${expected.bytes}`:null,prior=key&&cache?.get(key);
  let bytes,digest;
  if(prior&&prior.identity===identity(before)){digest=prior.digest;work.objectCacheHits++;}
  else{
   const size=Number(before.size),chunks=[],hasher=createHash('sha256');let offset=0;
   while(offset<size){const count=Math.min(64*1024,size-offset),chunk=Buffer.allocUnsafe(count);work.charge(1,count);
    const {bytesRead}=await fd.read(chunk,0,count,offset);if(bytesRead!==count)throw Error('evidence-file-changed');
    chunks.push(chunk);hasher.update(chunk);offset+=count;
   }
   work.charge(1,1);if((await fd.read(Buffer.alloc(1),0,1,size)).bytesRead!==0)throw Error('evidence-file-changed');
   bytes=Buffer.concat(chunks);digest=hasher.digest('hex');if(expected)work.objectHashes++;
  }
  work.charge(2);const after=await fd.stat({bigint:true}),named=await fs.lstat(file,{bigint:true});
  if(!named.isFile()||identity(before)!==identity(after)||identity(before)!==identity(named))throw Error('evidence-file-changed');
  if(expected&&(digest!==expected.sha256||Number(before.size)!==expected.bytes))throw Error('retained-evidence-object-checksum');
  if(key)cache?.set(key,{identity:identity(after),digest});
  return bytes;
 }finally{await fd.close();}
}
async function json(file,work,max=JSON_LIMIT){return JSON.parse((await readFile(file,max,work)).toString('utf8'));}
async function exists(file,work){work.charge();try{await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function tree(dir,work){
 const files=[];files.directories=[];
 async function walk(where){work.charge(3);const entries=await fs.opendir(where);for await(const entry of entries){work.charge();
  const file=path.join(where,entry.name);if(entry.isDirectory()){files.directories.push(file);await walk(file);}
  else if(entry.isFile()){work.charge();const stat=await fs.lstat(file);if(!stat.isFile())throw Error('evidence-file-changed');files.push({file,size:stat.size,at:stat.mtimeMs});}
  else throw Error('unknown-evidence-filesystem-entry');
 }}
 if(await exists(dir,work))await walk(dir);return files;
}
async function latest(directory,work){
 const index=await json(path.join(directory,'latest.json'),work);
 if(!attemptName.test(index.file)||!sha(index.sha256))throw Error('invalid-evidence-index');
 const bytes=await readFile(path.join(directory,index.file),JSON_LIMIT,work);
 if(hash(bytes)!==index.sha256)throw Error('evidence-manifest-checksum');
 return JSON.parse(bytes.toString('utf8'));
}

/** Rolling cap protects every open report, including earlier failed attempts.
 * A truncated queue cannot establish that any older report was resolved. */
async function maintain(dir,openIds,complete,now,maxBytes,maxAgeMs,work){
 const reportsDir=path.join(dir,'reports'),objectsDir=path.join(dir,'objects');
 work.charge(2);await fs.mkdir(reportsDir,{recursive:true,mode:0o700});await fs.mkdir(objectsDir,{recursive:true,mode:0o700});
 let all=await tree(dir,work),total=all.reduce((n,f)=>n+f.size,0);const grouped=new Map();
 for(const directory of all.directories){work.check();if(path.dirname(directory)===reportsDir&&!/^\d+$/.test(path.basename(directory)))throw Error('unknown-report-evidence-entry');}
 for(const file of all){work.check();const relative=path.relative(reportsDir,file.file),parts=relative.split(path.sep);
  if(relative.startsWith('..'+path.sep))continue;
  if(parts.length!==2||!/^\d+$/.test(parts[0]))throw Error('unknown-report-evidence-entry');
  if(!grouped.has(parts[0]))grouped.set(parts[0],[]);grouped.get(parts[0]).push(file);
 }
 const reportDirs=[...grouped].map(([id,files])=>({directory:path.join(reportsDir,id),id:Number(id),files,
  at:Math.max(0,...files.map(f=>f.at)),size:files.reduce((n,f)=>n+f.size,0)}));
 const removed=new Set();
 for(const entry of reportDirs.sort((a,b)=>a.at-b.at)){
  if(!complete||openIds.has(entry.id))continue;
  if(total<=maxBytes&&now-entry.at<=maxAgeMs)continue;
  // Remove only the inventoried eligible files. New/unknown entries make rmdir
  // refuse; they are never swept up by an unbounded recursive removal.
  for(const file of entry.files){work.charge();await fs.unlink(file.file);total-=file.size;removed.add(file.file);}
  work.charge();await fs.rmdir(entry.directory);
 }
 // Read every retained attempt before deleting shared objects. A damaged
 // protected manifest must never turn its inputs into apparently orphaned data.
 // Only committed attempt references protect objects: bytes saved before an
 // attempt commits may be reclaimed after deferral and fetched again on retry.
 const referenced=new Set();let cleanupUncertain=all.directories.some(directory=>directory.startsWith(objectsDir+path.sep)
  ||(directory.startsWith(reportsDir+path.sep)&&path.dirname(directory)!==reportsDir)),maintenanceDeferred=false;
 for(const entry of reportDirs){
  for(const file of entry.files){if(removed.has(file.file))continue;const name=path.basename(file.file);
   if(name==='latest.json')continue;
   if(!attemptName.test(name)){cleanupUncertain=true;continue;}
   try{
    // Keep at least half the new invocation budget for report work. An
    // unfinished reference inventory forbids shared-object collection.
    if(work.operations>=work.caps.operations/2||work.readBytes+file.size+1>work.caps.readBytes/2)throw new Deferred('evidence-maintenance-deferred');
    const manifest=await json(file.file,work);
    if(!Array.isArray(manifest.artifacts))throw Error('invalid-report-evidence-manifest');
    for(const file of manifest.artifacts){if(!artifactName.test(file.name))throw Error('invalid-report-evidence-artifact');referenced.add(file.name);}
   }catch(error){cleanupUncertain=true;if(error instanceof Deferred){maintenanceDeferred=true;break;}}
  }
  if(maintenanceDeferred)break;
 }
 const objects=all.filter(file=>path.dirname(file.file)===objectsDir);
 if(objects.some(file=>!artifactName.test(path.basename(file.file))))cleanupUncertain=true;
 for(const file of objects){const name=path.basename(file.file);
  if(!artifactName.test(name))continue;
  if(!cleanupUncertain&&!referenced.has(name)){work.charge();await fs.unlink(file.file);total-=file.size;}
 }
 return {bytes:total,cleanupUncertain,maintenanceDeferred,knownFiles:new Set(all.filter(file=>!removed.has(file.file)).map(file=>file.file))};
}

/** Admin evidence requests and public bundle requests use separate headers.
 * Reports can name only same-origin /assets filenames, never arbitrary URLs.
 * Permanent absence remains explicit; transient failures retry on later polls. */
export async function preserveReportEvidence({dir,reports,base,token,fetcher=fetch,now=Date.now(),complete=true,
 maxBytes=256*1024*1024,maxAgeMs=7*86400_000,workLimits,clock=()=>performance.now()}){
 const work=workBudget(workLimits,clock),cache=new Map();let cursor=null,total=null;
 const root=path.join(dir,'evidence'),openIds=new Set(reports.filter(r=>r.status==='open'&&Number.isSafeInteger(r.id)).map(r=>r.id));
 const summary={ok:true,captured:[],verified:[],unavailable:[],retrying:[],deferred:[],bytes:null,maxBytes,maxAgeMs,protectedReports:openIds.size,cleanupUncertain:false};
 const retry=(id,deferred=false)=>{summary.ok=false;if(!summary.retrying.includes(id))summary.retrying.push(id);if(deferred&&!summary.deferred.includes(id))summary.deferred.push(id);};
 const finish=()=>{summary.bytes=total;summary.work={readBytes:work.readBytes,operations:work.operations,objectHashes:work.objectHashes,
  objectCacheHits:work.objectCacheHits,cursor,limits:work.caps};return summary;};
 try{const previous=await json(path.join(dir,'evidence-status.json'),work,64*1024);if(number(previous.work?.cursor)!==undefined)cursor=previous.work.cursor;}
 catch(error){if(error instanceof Deferred){for(const id of openIds)retry(id,true);return finish();}/* optional prior continuation */}
 // Leave room for a new bounded bundle by retiring resolved evidence first.
 let retention;
 try{retention=await maintain(root,openIds,complete,now,Math.floor(maxBytes*0.8),maxAgeMs,work);total=retention.bytes;}
 catch(error){summary.cleanupUncertain=true;summary.maintenanceDeferred=error instanceof Deferred;for(const id of openIds)retry(id,true);summary.ok=false;return finish();}
 summary.cleanupUncertain=retention.cleanupUncertain;summary.maintenanceDeferred=retention.maintenanceDeferred;
 if(retention.maintenanceDeferred)summary.ok=false;
 const put=async(file,bytes,immutable=true)=>{
  work.check();
  let oldBytes=0;
  if(await exists(file,work)){
   if(immutable&&path.dirname(file)===path.join(root,'objects')){
    await readFile(file,file.endsWith('.json')?JSON_LIMIT:ASSET_LIMIT,work,{expected:{sha256:hash(bytes),bytes:bytes.length},cache});return;
   }
   const old=await readFile(file,JSON_LIMIT,work);if(old.equals(bytes))return;
   if(immutable)throw Error('immutable-evidence-object-changed');oldBytes=old.length;
  }
  if(total-oldBytes+bytes.length>maxBytes)throw Error('report-evidence-storage-limit');
  work.charge();await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  work.charge(3);try{await fs.writeFile(tmp,bytes,{flag:'wx',mode:0o600});work.check();await fs.rename(tmp,file);total+=bytes.length-oldBytes;}
  finally{await fs.unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 };
 const candidates=reports.filter(report=>Number.isSafeInteger(report.id)&&report.id>0&&report.status==='open');
 const at=candidates.findIndex(report=>report.id===cursor),rotated=at<0?candidates:[...candidates.slice(at+1),...candidates.slice(0,at+1)];
 // New captures stay first. Retained validation resumes after the previous
 // attempted row, rather than rehashing an unchanged prefix every minute.
 rotated.sort((a,b)=>Number(retention.knownFiles.has(path.join(root,'reports',String(a.id),'latest.json')))-Number(retention.knownFiles.has(path.join(root,'reports',String(b.id),'latest.json'))));
 const ordered=[],discoverySpent=work.discoveryWindow();
 for(const report of rotated){
  const directory=path.join(root,'reports',String(report.id));
  try{
   // Discovery also has a share of the invocation budget; leave work time for
   // the discovered rows even when there are many retained versions.
   if(discoverySpent()){retry(report.id,true);continue;}
   work.charge();ordered.push({report,old:retention.knownFiles.has(path.join(directory,'latest.json'))?await latest(directory,work):undefined});
  }catch(error){if(error instanceof Deferred)retry(report.id,true);else ordered.push({report,unreadable:true});}
 }
 // New reports go first, then the oldest incomplete attempt. A slow source
 // must not permanently monopolize every minute's bounded capture window.
 const priority=row=>!row.old?0:row.old.retryable?1:2;
 ordered.sort((a,b)=>priority(a)-priority(b)||(priority(a)===1?(Date.parse(a.old.capturedAt)||0)-(Date.parse(b.old.capturedAt)||0):0));
 // A deferred capture may never commit a newer capturedAt. Resume within the
 // incomplete bucket after its last attempt instead of pinning the oldest row.
 const incomplete=ordered.filter(row=>priority(row)===1),resumeAt=incomplete.findIndex(row=>row.report.id===cursor);
 if(resumeAt>=0){const start=ordered.findIndex(row=>priority(row)===1);
  ordered.splice(start,incomplete.length,...incomplete.slice(resumeAt+1),...incomplete.slice(0,resumeAt+1));}
 for(const {report,old,unreadable} of ordered){
  if(unreadable){cursor=report.id;retry(report.id);continue;}
  try{
  work.charge();cursor=report.id;
  let context={};try{context=JSON.parse(report.context??'{}')??{};}catch{/* legacy report */}
  const screen=reportScreenFacts(context.screen),s=context.serverEvidence;
  const saved=object(s)&&s.status==='retained'&&sha(s.snapshotId)&&sha(s.sha256)&&sha(s.bundleSha256)
   ?{status:'retained',snapshotId:s.snapshotId,sha256:s.sha256,bundleSha256:s.bundleSha256}
   :{status:'unavailable',reason:object(s)&&typeof s.reason==='string'?text(s.reason,80):'source-not-supplied'};
  const version=hash(JSON.stringify({screen,saved})),directory=path.join(root,'reports',String(report.id));
  // Every attempt is immutable; only a small latest pointer is replaced.
  const indexFile=path.join(directory,'latest.json');
  if(old){
   if(old.version===version&&!old.retryable){
    if(!Array.isArray(old.artifacts))throw Error('invalid-report-evidence-manifest');
    for(const file of old.artifacts){work.check();if(!artifactName.test(file.name)||!sha(file.sha256)||number(file.bytes)===undefined)throw Error('invalid-report-evidence-artifact');
     await readFile(path.join(root,'objects',file.name),file.name.endsWith('.json')?JSON_LIMIT:ASSET_LIMIT,work,{expected:file,cache});}
    summary.verified.push(report.id);continue;
   }
  }
  work.check();
  const manifest={v:1,id:report.id,version,capturedAt:new Date(now).toISOString(),
   report:{createdAt:text(report.createdAt,40),priority:text(report.priority,24),body:text(report.body,2000)},
   screen,source:{status:saved.status,reason:saved.reason},assets:[],artifacts:[],retryable:false,
   scope:'Exact public response and reported public asset bytes when available. Does not prove reporter claims, physical service, model causality, or ETA accuracy.'};
  const artifact=async(bytes,extension)=>{
   const sha256=hash(bytes),name=sha256+'.'+extension;
   await put(path.join(root,'objects',name),bytes);const result={name,sha256,bytes:bytes.length};
   if(!manifest.artifacts.some(file=>file.name===name))manifest.artifacts.push(result);return result;
  };
  if(saved.status==='retained'){
   try{
    const response=await fetcher(new URL(`/api/reports/${report.id}/evidence`,base),
     {headers:{'x-admin-token':token},redirect:'error',signal:AbortSignal.timeout(work.remaining())});
    if(response.status===410||response.status===404)manifest.source={status:'unavailable',reason:'source-expired'};
    else{
     if(!response.ok)throw Error('source-request-failed');
     const bytes=await readLimited(response,JSON_LIMIT,work),digest=hash(bytes);work.check();
     if(digest!==saved.bundleSha256||response.headers.get('x-content-sha256')!==digest)throw Error('source-bundle-checksum');
     const bundle=JSON.parse(bytes.toString('utf8'));
     if(bundle.v!==1||bundle.source?.snapshotId!==saved.snapshotId||bundle.source.sha256!==saved.sha256)throw Error('source-identity');
     const compressed=Buffer.from(bundle.gzipBase64,'base64');
     if(compressed.length!==bundle.gzipBytes||hash(compressed)!==bundle.gzipSha256)throw Error('source-gzip-checksum');
     work.check();const raw=gunzipSync(compressed,{maxOutputLength:2*1024*1024});work.check();
     if(raw.length!==bundle.source.bytes||hash(raw)!==saved.sha256)throw Error('source-body-checksum');
     manifest.source={status:'retained',snapshotId:saved.snapshotId,sha256:saved.sha256,bundleSha256:digest,artifact:await artifact(bytes,'json')};
    }
   }catch(error){if(error instanceof Deferred)throw error;manifest.source={status:'unavailable',reason:error.message==='report-evidence-storage-limit'?'storage-limit':'source-capture-failed'};manifest.retryable=true;}
  }
  let assetBytes=0;
  for(const requested of screen?.assets??[]){
   try{
    work.check();
    const response=await fetcher(new URL(requested,base),{redirect:'error',signal:AbortSignal.timeout(work.remaining())});
    if(response.status===404||response.status===410){manifest.assets.push({path:requested,status:'unavailable',reason:'asset-not-retained'});continue;}
    if(!response.ok)throw Error('asset-request-failed');
    const type=(response.headers.get('content-type')??'').split(';')[0].trim();
    if(type==='text/html'){manifest.assets.push({path:requested,status:'unavailable',reason:'asset-not-retained'});continue;}
    if(requested.endsWith('.css')?type!=='text/css':!['application/javascript','text/javascript','application/ecmascript','text/ecmascript'].includes(type))throw Error('asset-content-type');
    const bytes=await readLimited(response,ASSET_LIMIT,work);assetBytes+=bytes.length;
    if(assetBytes>16*1024*1024)throw Error('asset-batch-too-large');
    manifest.assets.push({path:requested,status:'retained',artifact:await artifact(bytes,requested.endsWith('.css')?'css':'js')});
   }catch(error){if(error instanceof Deferred)throw error;manifest.assets.push({path:requested,status:'unavailable',reason:error.message==='report-evidence-storage-limit'?'storage-limit':'asset-capture-failed'});manifest.retryable=true;}
  }
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),name=`attempt-${now}-${randomBytes(8).toString('hex')}.json`;
  await put(path.join(directory,name),bytes);
  await put(indexFile,Buffer.from(JSON.stringify({v:1,file:name,sha256:hash(bytes)})+'\n'),false);
  if(manifest.retryable){summary.ok=false;summary.retrying.push(report.id);}
  else if(manifest.source.status==='unavailable')summary.unavailable.push(report.id);
  else summary.captured.push(report.id);
  }catch(error){retry(report.id,error instanceof Deferred);}
 }
 return finish();
}
