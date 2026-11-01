import fs from 'node:fs/promises';
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

async function readLimited(response,max){
 const length=Number(response.headers?.get('content-length'));
 if(Number.isFinite(length)&&length>max)throw Error('evidence-response-too-large');
 const reader=response.body?.getReader();
 if(!reader)throw Error('evidence-response-body-missing');
 let size=0;const chunks=[];
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
  if(size>max)throw Error('evidence-response-too-large');chunks.push(Buffer.from(value));}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 finally{reader.releaseLock();}
 return Buffer.concat(chunks);
}
async function json(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function exists(file){try{await fs.stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function tree(dir){
 const files=[];
 async function walk(where){for(const entry of await fs.readdir(where,{withFileTypes:true})){
  const file=path.join(where,entry.name);if(entry.isDirectory())await walk(file);
  else if(entry.isFile()){const stat=await fs.stat(file);files.push({file,size:stat.size,at:stat.mtimeMs});}
  else throw Error('unknown-evidence-filesystem-entry');
 }}
 if(await exists(dir))await walk(dir);return files;
}
async function latest(directory){
 const index=await json(path.join(directory,'latest.json'));
 if(!attemptName.test(index.file)||!sha(index.sha256))throw Error('invalid-evidence-index');
 const bytes=await fs.readFile(path.join(directory,index.file));
 if(hash(bytes)!==index.sha256)throw Error('evidence-manifest-checksum');
 return JSON.parse(bytes.toString('utf8'));
}

/** Rolling cap protects every open report, including earlier failed attempts.
 * A truncated queue cannot establish that any older report was resolved. */
async function maintain(dir,openIds,complete,now,maxBytes,maxAgeMs){
 const reportsDir=path.join(dir,'reports'),objectsDir=path.join(dir,'objects');
 await fs.mkdir(reportsDir,{recursive:true,mode:0o700});await fs.mkdir(objectsDir,{recursive:true,mode:0o700});
 let all=await tree(dir),total=all.reduce((n,f)=>n+f.size,0);
 const reportDirs=[];
 for(const entry of await fs.readdir(reportsDir,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^\d+$/.test(entry.name))throw Error('unknown-report-evidence-entry');
  const directory=path.join(reportsDir,entry.name),files=all.filter(f=>f.file.startsWith(directory+path.sep));
  reportDirs.push({directory,id:Number(entry.name),at:Math.max(0,...files.map(f=>f.at)),size:files.reduce((n,f)=>n+f.size,0)});
 }
 for(const entry of reportDirs.sort((a,b)=>a.at-b.at)){
  if(!complete||openIds.has(entry.id))continue;
  if(total<=maxBytes&&now-entry.at<=maxAgeMs)continue;
  await fs.rm(entry.directory,{recursive:true});total-=entry.size;
 }
 // Read every retained attempt before deleting shared objects. A damaged
 // protected manifest must never turn its inputs into apparently orphaned data.
 const referenced=new Set();let cleanupUncertain=false;
 for(const entry of await fs.readdir(reportsDir,{withFileTypes:true})){
  const directory=path.join(reportsDir,entry.name);
  for(const name of await fs.readdir(directory)){
   if(name==='latest.json')continue;
   if(!attemptName.test(name)){cleanupUncertain=true;continue;}
   try{
    const manifest=await json(path.join(directory,name));
    if(!Array.isArray(manifest.artifacts))throw Error('invalid-report-evidence-manifest');
    for(const file of manifest.artifacts){if(!artifactName.test(file.name))throw Error('invalid-report-evidence-artifact');referenced.add(file.name);}
   }catch{cleanupUncertain=true;}
  }
 }
 const objectNames=await fs.readdir(objectsDir);
 if(objectNames.some(name=>!artifactName.test(name)))cleanupUncertain=true;
 for(const name of objectNames){
  if(!artifactName.test(name))continue;
  if(!cleanupUncertain&&!referenced.has(name))await fs.unlink(path.join(objectsDir,name));
 }
 all=await tree(dir);return {bytes:all.reduce((n,f)=>n+f.size,0),cleanupUncertain};
}

/** Admin evidence requests and public bundle requests use separate headers.
 * Reports can name only same-origin /assets filenames, never arbitrary URLs.
 * Permanent absence remains explicit; transient failures retry on later polls. */
export async function preserveReportEvidence({dir,reports,base,token,fetcher=fetch,now=Date.now(),complete=true,
 maxBytes=256*1024*1024,maxAgeMs=7*86400_000}){
 const root=path.join(dir,'evidence'),openIds=new Set(reports.filter(r=>r.status==='open'&&Number.isSafeInteger(r.id)).map(r=>r.id));
 // Leave room for a new bounded bundle by retiring resolved evidence first.
 const retention=await maintain(root,openIds,complete,now,Math.floor(maxBytes*0.8),maxAgeMs);let total=retention.bytes;
 const deadline=Date.now()+30000;
 const summary={ok:true,captured:[],unavailable:[],retrying:[],bytes:total,maxBytes,maxAgeMs,protectedReports:openIds.size,
  cleanupUncertain:retention.cleanupUncertain};
 const put=async(file,bytes,immutable=true)=>{
  let oldBytes=0;
  if(await exists(file)){
   const old=await fs.readFile(file);if(old.equals(bytes))return;
   if(immutable)throw Error('immutable-evidence-object-changed');oldBytes=old.length;
  }
  if(total-oldBytes+bytes.length>maxBytes)throw Error('report-evidence-storage-limit');
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  try{await fs.writeFile(tmp,bytes,{flag:'wx',mode:0o600});await fs.rename(tmp,file);total+=bytes.length-oldBytes;}
  finally{await fs.unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 };
 const ordered=await Promise.all(reports.filter(report=>Number.isSafeInteger(report.id)&&report.id>0&&report.status==='open').map(async report=>{
  const directory=path.join(root,'reports',String(report.id));
  try{return {report,old:await exists(path.join(directory,'latest.json'))?await latest(directory):undefined};}
  catch{return {report,unreadable:true};}
 }));
 // New reports go first, then the oldest incomplete attempt. A slow source
 // must not permanently monopolize every minute's bounded capture window.
 ordered.sort((a,b)=>(Date.parse(a.old?.capturedAt??'')||0)-(Date.parse(b.old?.capturedAt??'')||0));
 for(const {report,old,unreadable} of ordered){
  if(unreadable){summary.ok=false;summary.retrying.push(report.id);continue;}
  try{
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
    for(const file of old.artifacts){if(!artifactName.test(file.name)||hash(await fs.readFile(path.join(root,'objects',file.name)))!==file.sha256)throw Error('retained-evidence-object-checksum');}
    continue;
   }
  }
  if(Date.now()>=deadline){summary.ok=false;summary.retrying.push(report.id);continue;}
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
     {headers:{'x-admin-token':token},redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(10000,deadline-Date.now())))});
    if(response.status===410||response.status===404)manifest.source={status:'unavailable',reason:'source-expired'};
    else{
     if(!response.ok)throw Error('source-request-failed');
     const bytes=await readLimited(response,4*1024*1024),digest=hash(bytes);
     if(digest!==saved.bundleSha256||response.headers.get('x-content-sha256')!==digest)throw Error('source-bundle-checksum');
     const bundle=JSON.parse(bytes.toString('utf8'));
     if(bundle.v!==1||bundle.source?.snapshotId!==saved.snapshotId||bundle.source.sha256!==saved.sha256)throw Error('source-identity');
     const compressed=Buffer.from(bundle.gzipBase64,'base64');
     if(compressed.length!==bundle.gzipBytes||hash(compressed)!==bundle.gzipSha256)throw Error('source-gzip-checksum');
     const raw=gunzipSync(compressed,{maxOutputLength:2*1024*1024});
     if(raw.length!==bundle.source.bytes||hash(raw)!==saved.sha256)throw Error('source-body-checksum');
     manifest.source={status:'retained',snapshotId:saved.snapshotId,sha256:saved.sha256,bundleSha256:digest,artifact:await artifact(bytes,'json')};
    }
   }catch(error){manifest.source={status:'unavailable',reason:error.message==='report-evidence-storage-limit'?'storage-limit':'source-capture-failed'};manifest.retryable=true;}
  }
  let assetBytes=0;
  for(const requested of screen?.assets??[]){
   try{
    if(Date.now()>=deadline)throw Error('evidence-poll-deadline');
    const response=await fetcher(new URL(requested,base),{redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(10000,deadline-Date.now())))});
    if(response.status===404||response.status===410){manifest.assets.push({path:requested,status:'unavailable',reason:'asset-not-retained'});continue;}
    if(!response.ok)throw Error('asset-request-failed');
    const type=(response.headers.get('content-type')??'').split(';')[0].trim();
    if(type==='text/html'){manifest.assets.push({path:requested,status:'unavailable',reason:'asset-not-retained'});continue;}
    if(requested.endsWith('.css')?type!=='text/css':!['application/javascript','text/javascript','application/ecmascript','text/ecmascript'].includes(type))throw Error('asset-content-type');
    const bytes=await readLimited(response,6*1024*1024);assetBytes+=bytes.length;
    if(assetBytes>16*1024*1024)throw Error('asset-batch-too-large');
    manifest.assets.push({path:requested,status:'retained',artifact:await artifact(bytes,requested.endsWith('.css')?'css':'js')});
   }catch(error){manifest.assets.push({path:requested,status:'unavailable',reason:error.message==='report-evidence-storage-limit'?'storage-limit':'asset-capture-failed'});manifest.retryable=true;}
  }
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),name=`attempt-${now}-${randomBytes(8).toString('hex')}.json`;
  await put(path.join(directory,name),bytes);
  await put(indexFile,Buffer.from(JSON.stringify({v:1,file:name,sha256:hash(bytes)})+'\n'),false);
  if(manifest.retryable){summary.ok=false;summary.retrying.push(report.id);}
  else if(manifest.source.status==='unavailable')summary.unavailable.push(report.id);
  else summary.captured.push(report.id);
  }catch{summary.ok=false;summary.retrying.push(report.id);}
 }
 summary.bytes=total;return summary;
}
