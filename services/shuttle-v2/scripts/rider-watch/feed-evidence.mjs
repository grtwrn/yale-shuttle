import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {DAY, MiB, readJson, withStorageLock} from '../retention/storage.mjs';

export const FEED_RESPONSE_LIMITS = Object.freeze({maxDecodedBytes:8*MiB, maxGzipBytes:MiB});
export const DEFAULT_FEED_RESPONSE_POLICY = Object.freeze({maxBytes:256*MiB, maxAgeMs:7*DAY, maxProtectedBytes:512*MiB});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeRun = id => typeof id==='string' && /^\d{1,20}$/.test(id);
const headersAllowed = new Set(['date','content-type','content-length','content-encoding','etag','x-shuttle-snapshot']);
function fail(code) {const error=new Error(code);error.code=code;throw error;}

async function policyFor(root) {
 const configured=await readJson(path.join(root,'storage-policy.json'),{});
 if(configured.feedResponses!==undefined&&(configured.feedResponses===null||typeof configured.feedResponses!=='object'||Array.isArray(configured.feedResponses)))
  fail('invalid-feed-storage-policy');
 const policy={...DEFAULT_FEED_RESPONSE_POLICY,...configured.feedResponses};
 if(!Object.values(policy).every(v=>Number.isSafeInteger(v)&&v>0)||policy.maxProtectedBytes<policy.maxBytes)
  fail('invalid-feed-storage-policy');
 return policy;
}
async function inventory(root,{dryRun=false}={}) {
 const directory=path.join(root,'feed-responses');
 let stat=await fs.lstat(directory).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(!stat) {if(dryRun)return {directory,files:[]};await fs.mkdir(directory,{mode:0o700});stat=await fs.lstat(directory);}
 if(!stat.isDirectory()||stat.isSymbolicLink())fail('unsafe-feed-directory');
 const files=[];
 for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
  if(!entry.isFile()||!/^\d{1,20}\.jsonl$/.test(entry.name))fail('unrecognized-feed-artifact');
  const file=path.join(directory,entry.name),s=await fs.lstat(file);
  if(!s.isFile()||s.isSymbolicLink())fail('unsafe-feed-artifact');
  files.push({file,name:entry.name,runId:entry.name.slice(0,-6),bytes:s.size,time:s.mtimeMs});
 }
 return {directory,files:files.sort((a,b)=>a.time-b.time||a.name.localeCompare(b.name))};
}
async function cleanup(root,{activeRunId,now=Date.now(),dryRun=false,incomingBytes=0}={}) {
 const policy=await policyFor(root),pins=await readJson(path.join(root,'storage-pins.json'),{});
 if(pins.runIds!==undefined&&(!Array.isArray(pins.runIds)||!pins.runIds.every(safeRun)))fail('invalid-feed-storage-pins');
 const checkpoint=await readJson(path.join(root,'resume.json'),null),checkpointRun=checkpoint?.run?.id;
 if((activeRunId!==undefined&&!safeRun(activeRunId))||(checkpointRun!==undefined&&!safeRun(checkpointRun)))fail('invalid-feed-active-run');
 const protectedRuns=new Set([...(pins.runIds??[]),...(activeRunId?[activeRunId]:[]),...(checkpointRun?[checkpointRun]:[])]);
 const {directory,files}=await inventory(root,{dryRun});
 let bytes=files.reduce((n,f)=>n+f.bytes,0),deletedFiles=0,freedBytes=0;
 const kept=[];
 for(const file of files) {
  if(!protectedRuns.has(file.runId)&&(bytes+incomingBytes>policy.maxBytes||now-file.time>policy.maxAgeMs)) {
   if(!dryRun)await fs.unlink(file.file);
   bytes-=file.bytes;deletedFiles++;freedBytes+=file.bytes;
  }else kept.push(file);
 }
 const protectedBytes=kept.filter(f=>protectedRuns.has(f.runId)).reduce((n,f)=>n+f.bytes,0);
 return {directory,files:kept,updatedAt:new Date(now).toISOString(),bytes,protectedBytes,
  protectedOverageBytes:Math.max(0,protectedBytes-policy.maxBytes),...policy,deletedFiles,freedBytes};
}
const publicStorage = ({directory,files,...status}) => status;
export function maintainFeedResponses(root,options={}) {
 return withStorageLock(root,async()=>publicStorage(await cleanup(root,options)));
}

/** Store the actual decoded response bytes, never a serialization of feed.
 * A journal is independent of the compact UI/GPS log budget. Only completed,
 * unpinned trip journals roll; the active/pinned evidence remains intact. */
export async function retainFeedResponse(root,{runId,body,receivedAt,status=200,headers={},sourceKind='page-response'}, {now=Date.now()}={}) {
 if(!safeRun(runId)||!Buffer.isBuffer(body)||!Number.isSafeInteger(receivedAt)||receivedAt<0
  ||!Number.isInteger(status)||status<200||status>=300||!['page-response','bootstrap-request'].includes(sourceKind))fail('invalid-feed-response');
 if(body.length>FEED_RESPONSE_LIMITS.maxDecodedBytes)fail('feed-response-too-large');
 const compressed=gzipSync(body);
 if(compressed.length>FEED_RESPONSE_LIMITS.maxGzipBytes)fail('compressed-feed-response-too-large');
 const safeHeaders={};
 for(const [name,value] of Object.entries(headers))if(headersAllowed.has(name.toLowerCase())&&typeof value==='string')
  safeHeaders[name.toLowerCase()]=value.slice(0,1024);
 const metadata={v:1,runId,route:'/api/buses',sourceKind,receivedAt,status,headers:safeHeaders,
  decodedBytes:body.length,decodedSHA256:digest(body),gzipBytes:compressed.length,gzipSHA256:digest(compressed)};
 const id=digest(JSON.stringify(metadata)),record={...metadata,id,encoding:'gzip/base64',body:compressed.toString('base64')};
 const line=Buffer.from(JSON.stringify(record)+'\n');
 return withStorageLock(root,async()=>{
  const preview=await cleanup(root,{activeRunId:runId,now,incomingBytes:line.length,dryRun:true});
  if(preview.bytes+line.length>preview.maxProtectedBytes)fail('protected-feed-storage-limit');
  const storage=await cleanup(root,{activeRunId:runId,now,incomingBytes:line.length});
  if(storage.bytes+line.length>storage.maxProtectedBytes)fail('protected-feed-storage-limit');
  const file=path.join(storage.directory,runId+'.jsonl');
  const handle=await fs.open(file,constants.O_CREAT|constants.O_APPEND|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  try {
   const stat=await handle.stat();
   if(!stat.isFile())fail('unsafe-feed-journal');
   if(stat.size){const end=Buffer.alloc(1);await handle.read(end,0,1,stat.size-1);if(end[0]!==10)fail('partial-feed-journal');}
   await handle.writeFile(line);await handle.sync();
  }finally{await handle.close();}
  const protectedBytes=storage.protectedBytes+line.length;
  return {v:1,state:'captured',file:'feed-responses/'+runId+'.jsonl',id,...metadata,
   storage:{...publicStorage(storage),bytes:storage.bytes+line.length,protectedBytes,
    protectedOverageBytes:Math.max(0,protectedBytes-storage.maxBytes)}};
 });
}

/** Independently check a retained row before using any of its JSON values. */
export function verifyFeedResponseRecord(record) {
 if(record?.v!==1||!safeRun(record.runId)||record.route!=='/api/buses'||record.encoding!=='gzip/base64'
  ||!['page-response','bootstrap-request'].includes(record.sourceKind)
  ||!Number.isSafeInteger(record.receivedAt)||record.receivedAt<0||!Number.isInteger(record.status)||record.status<200||record.status>=300
  ||!Number.isSafeInteger(record.decodedBytes)||record.decodedBytes<0||record.decodedBytes>FEED_RESPONSE_LIMITS.maxDecodedBytes
  ||!Number.isSafeInteger(record.gzipBytes)||record.gzipBytes<0||record.gzipBytes>FEED_RESPONSE_LIMITS.maxGzipBytes
  ||record.headers===null||typeof record.headers!=='object'||Array.isArray(record.headers)
  ||!Object.entries(record.headers).every(([key,value])=>headersAllowed.has(key)&&typeof value==='string'&&value.length<=1024)
  ||typeof record.body!=='string'||record.body.length>4*Math.ceil(FEED_RESPONSE_LIMITS.maxGzipBytes/3)
  ||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.body))fail('invalid-feed-response-record');
 const compressed=Buffer.from(record.body,'base64');
 if(compressed.length!==record.gzipBytes||digest(compressed)!==record.gzipSHA256)fail('feed-gzip-checksum-mismatch');
 const raw=gunzipSync(compressed,{maxOutputLength:FEED_RESPONSE_LIMITS.maxDecodedBytes});
 if(raw.length!==record.decodedBytes||digest(raw)!==record.decodedSHA256)fail('feed-body-checksum-mismatch');
 const {v,runId,route,sourceKind,receivedAt,status,headers,decodedBytes,decodedSHA256,gzipBytes,gzipSHA256}=record;
 if(digest(JSON.stringify({v,runId,route,sourceKind,receivedAt,status,headers,decodedBytes,decodedSHA256,gzipBytes,gzipSHA256}))!==record.id)
  fail('feed-receipt-identity-mismatch');
 return raw;
}

/** Response.body() reuses Playwright's completed response; no new request.
 * Capture failure is evidence unavailability, never a synthetic HTTP body. */
export async function captureFeedResponse(root,{response,feed,runId,receivedAt,sourceKind='page-response'}) {
 let timer;
 try {
  if(typeof response?.body!=='function')fail('raw-feed-response-unavailable');
  if(new URL(response.url()).pathname!=='/api/buses'||!response.ok())fail('unexpected-feed-response');
  const body=await Promise.race([response.body(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('feed-body-timeout'),{code:'feed-body-timeout'})),5000);})]);
  if(!Buffer.isBuffer(body)||body.length>FEED_RESPONSE_LIMITS.maxDecodedBytes)fail('feed-response-too-large');
  if(!isDeepStrictEqual(JSON.parse(body.toString('utf8')),feed))fail('feed-body-json-mismatch');
  const headers=await response.headers();
  return await retainFeedResponse(root,{runId,body,receivedAt,status:response.status(),headers,sourceKind});
 }catch(error){return {v:1,state:'unavailable',runId,receivedAt,reason:error.code??'feed-evidence-capture-failed'};}
 finally{clearTimeout(timer);}
}
