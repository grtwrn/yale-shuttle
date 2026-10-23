import {test,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {retainFeedResponse,captureFeedResponse,maintainFeedResponses,verifyFeedResponseRecord,FEED_RESPONSE_LIMITS} from './feed-evidence.mjs';
const roots=[];
async function setup(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'rider-feed-evidence-'));roots.push(root);return root;}
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
const bytes=Buffer.from('{ "text":"héllo 🚌", "buses":[], "same":1,"same":2 }\n');
const input=(runId='1',receivedAt=1234)=>({runId,body:bytes,receivedAt,status:200,headers:{'content-type':'application/json','x-admin-token':'DO_NOT_RETAIN','set-cookie':'DO_NOT_RETAIN'}});
async function records(root,id='1'){return (await fs.readFile(path.join(root,'feed-responses',id+'.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);}

test('retains exact decoded UTF8 bytes, including whitespace and duplicate JSON keys, without private headers',async()=>{
 const root=await setup(),reference=await retainFeedResponse(root,input());
 assert.equal(reference.state,'captured');assert.equal(reference.receivedAt,1234);
 const [record]=await records(root);assert.deepEqual(verifyFeedResponseRecord(record),bytes);
 assert.equal(record.id,reference.id);assert.equal(record.decodedSHA256,reference.decodedSHA256);
 assert(!JSON.stringify(record).includes('DO_NOT_RETAIN'));assert(!('body' in reference));
});
test('uses the existing response body and independently matches it to the exact parsed feed',async()=>{
 const root=await setup();let reads=0;
 const response={url:()=> 'https://example.test/api/buses',ok:()=>true,status:()=>200,headers:()=>({'date':'today'}),body:async()=>{reads++;return bytes;}};
 const result=await captureFeedResponse(root,{response,feed:JSON.parse(bytes),runId:'1',receivedAt:1234});
 assert.equal(result.state,'captured');assert.equal(reads,1);
 assert.deepEqual(verifyFeedResponseRecord((await records(root))[0]),bytes);
 const mismatch=await captureFeedResponse(root,{response,feed:{buses:['changed']},runId:'1',receivedAt:1235});
 assert.equal(mismatch.state,'unavailable');assert.equal(mismatch.reason,'feed-body-json-mismatch');assert.equal((await records(root)).length,1);
});
test('a real Playwright response reuses its completed decoded body without another HTTP request',async()=>{
 const root=await setup();let requests=0,context;
 const server=http.createServer((req,res)=>{requests++;assert.equal(req.url,'/api/buses');
  res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'});res.end(gzipSync(bytes));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const {request}=await import('playwright-core');context=await request.newContext();
  const response=await context.get('http://127.0.0.1:'+server.address().port+'/api/buses');
  const feed=await response.json();
  const receipt=await captureFeedResponse(root,{response,feed,runId:'1',receivedAt:1234,sourceKind:'bootstrap-request'});
  assert.equal(receipt.state,'captured');assert.equal(receipt.sourceKind,'bootstrap-request');assert.equal(requests,1);
  const [record]=await records(root);assert.equal(record.headers['content-encoding'],'gzip');
  assert.deepEqual(verifyFeedResponseRecord(record),bytes);assert.equal(requests,1);
 }finally{await context?.dispose();await new Promise(resolve=>server.close(resolve));}
});
test('a missing or failed body remains unavailable rather than serializing a parsed feed',async()=>{
 const root=await setup(),base={url:()=> 'https://example.test/api/buses',ok:()=>true,status:()=>200,headers:()=>({})};
 for(const response of [base,{...base,body:async()=>{throw new Error('body failed');}}]){
  const result=await captureFeedResponse(root,{response,feed:{buses:[]},runId:'1',receivedAt:1234});
  assert.equal(result.state,'unavailable');
 }
 await assert.rejects(fs.stat(path.join(root,'feed-responses')),e=>e.code==='ENOENT');
});
test('checksum and receipt metadata corruption cannot be used as source evidence',async()=>{
 const root=await setup();await retainFeedResponse(root,input());const [record]=await records(root);
 for(const changed of [{...record,decodedSHA256:'0'.repeat(64)},{...record,receivedAt:1235},{...record,body:'AAAA'}])
  assert.throws(()=>verifyFeedResponseRecord(changed));
});
test('rolling cleanup removes completed journals and preserves active and explicitly pinned trips',async()=>{
 const root=await setup();await fs.writeFile(path.join(root,'storage-policy.json'),JSON.stringify({feedResponses:{maxBytes:1,maxProtectedBytes:10000}}));
 await retainFeedResponse(root,input('1'));await fs.writeFile(path.join(root,'storage-pins.json'),JSON.stringify({runIds:['1']}));
 const second=await retainFeedResponse(root,input('2'));assert(second.storage.protectedOverageBytes>0);
 assert.equal((await records(root,'1')).length,1);assert.equal((await records(root,'2')).length,1);
 await fs.writeFile(path.join(root,'storage-pins.json'),'{}');
 const cleanup=await maintainFeedResponses(root,{activeRunId:'2'});assert.equal(cleanup.deletedFiles,1);
 await assert.rejects(fs.stat(path.join(root,'feed-responses','1.jsonl')),e=>e.code==='ENOENT');assert.equal((await records(root,'2')).length,1);
});
test('the protected hard ceiling refuses a new record without deleting or partially appending earlier evidence',async()=>{
 const root=await setup();await fs.writeFile(path.join(root,'storage-policy.json'),JSON.stringify({feedResponses:{maxBytes:1,maxProtectedBytes:2000}}));
 await retainFeedResponse(root,input());let refused=false;
 for(let at=1235;at<1245;at++){
  const file=path.join(root,'feed-responses','1.jsonl'),before=await fs.readFile(file);
  try{await retainFeedResponse(root,input('1',at));}
  catch(error){assert.equal(error.code,'protected-feed-storage-limit');assert.deepEqual(await fs.readFile(file),before);refused=true;break;}
 }
 assert(refused);
});
test('a refused capture does not perform its previewed cleanup of unrelated completed evidence',async()=>{
 const root=await setup();for(const id of ['1','2','3'])await retainFeedResponse(root,input(id));
 await fs.writeFile(path.join(root,'storage-pins.json'),JSON.stringify({runIds:['1','2']}));
 const protectedBytes=(await fs.stat(path.join(root,'feed-responses','1.jsonl'))).size+(await fs.stat(path.join(root,'feed-responses','2.jsonl'))).size;
 await fs.writeFile(path.join(root,'storage-policy.json'),JSON.stringify({feedResponses:{maxBytes:1,maxProtectedBytes:protectedBytes}}));
 const file=path.join(root,'feed-responses','3.jsonl'),before=await fs.readFile(file);
 await assert.rejects(retainFeedResponse(root,input('2',1235)),e=>e.code==='protected-feed-storage-limit');
 assert.deepEqual(await fs.readFile(file),before);
});
test('a delayed capture cannot evict the checkpointed current trip',async()=>{
 const root=await setup();await retainFeedResponse(root,input('1'));
 await fs.writeFile(path.join(root,'resume.json'),JSON.stringify({run:{id:'1'}}));
 await fs.writeFile(path.join(root,'storage-policy.json'),JSON.stringify({feedResponses:{maxBytes:1,maxProtectedBytes:10000}}));
 await retainFeedResponse(root,input('2'));assert.equal((await records(root,'1')).length,1);
});
test('age cleanup expires completed journals while an active trip stays protected',async()=>{
 const root=await setup();await retainFeedResponse(root,input('1'));await retainFeedResponse(root,input('2'));
 for(const id of ['1','2'])await fs.utimes(path.join(root,'feed-responses',id+'.jsonl'),new Date(0),new Date(0));
 const result=await maintainFeedResponses(root,{activeRunId:'2',now:Date.now()});assert.equal(result.deletedFiles,1);assert.equal((await records(root,'2')).length,1);
});
test('symlinked or unrecognized cache artifacts fail closed without deleting them',async()=>{
 const root=await setup(),outside=await setup();await fs.symlink(outside,path.join(root,'feed-responses'),'dir');
 await assert.rejects(retainFeedResponse(root,input()),e=>e.code==='unsafe-feed-directory');assert.deepEqual(await fs.readdir(outside),[]);
 await fs.unlink(path.join(root,'feed-responses'));await fs.mkdir(path.join(root,'feed-responses'));await fs.writeFile(path.join(root,'feed-responses','unknown'),'original');
 await assert.rejects(retainFeedResponse(root,input()),e=>e.code==='unrecognized-feed-artifact');assert.equal(await fs.readFile(path.join(root,'feed-responses','unknown'),'utf8'),'original');
});
test('an incomplete earlier journal is preserved and cannot produce a falsely complete reference',async()=>{
 const root=await setup();await fs.mkdir(path.join(root,'feed-responses'));const file=path.join(root,'feed-responses','1.jsonl');await fs.writeFile(file,'incomplete');
 await assert.rejects(retainFeedResponse(root,input()),e=>e.code==='partial-feed-journal');assert.equal(await fs.readFile(file,'utf8'),'incomplete');
});
test('oversized responses and invalid path identities fail before retaining a body',async()=>{
 const root=await setup();await assert.rejects(retainFeedResponse(root,{...input(),body:Buffer.alloc(FEED_RESPONSE_LIMITS.maxDecodedBytes+1)}),e=>e.code==='feed-response-too-large');
 await assert.rejects(retainFeedResponse(root,input('../escape')),e=>e.code==='invalid-feed-response');
 await assert.rejects(fs.stat(path.join(root,'feed-responses')),e=>e.code==='ENOENT');
});
test('a dry run reports expiry without creating or deleting body artifacts',async()=>{
 const root=await setup();await maintainFeedResponses(root,{dryRun:true});await assert.rejects(fs.stat(path.join(root,'feed-responses')),e=>e.code==='ENOENT');
 await retainFeedResponse(root,input());const file=path.join(root,'feed-responses','1.jsonl');await fs.utimes(file,new Date(0),new Date(0));
 const result=await maintainFeedResponses(root,{dryRun:true});assert.equal(result.deletedFiles,1);assert.equal((await records(root)).length,1);
});
