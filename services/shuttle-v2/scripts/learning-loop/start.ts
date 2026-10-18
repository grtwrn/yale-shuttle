import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { observationKey } from './forecasts';
import { ExactForecastStream, SourceContextChanged, digest, modelKey, pruneRuntimes } from './stream';
import { verifyExactReceipts } from './receipts';
import { archiveTableFile, readArchiveTable } from '../archive-files.mjs';
import { assembleCandidate, conformalFit, estimateEmissions, estimateVisitRates,
  sameParams, tracksByName, zoneTester } from '../reestimate-lib.mjs';
import { fileHash, fileIdentity, identityHash } from '../reestimate-validation.mjs';
import { assertLearningSourceUnchanged, learningSourceFiles } from './source-files.mjs';
import { calibrationObservation, dayStart, etDay, evaluate, excludePending, keyOf, nextDay, observe,
  phaseAt, productionControlInputValid, productionControlValid, recordForecast, SETTLE_MS, UNIT } from './lib.mjs';

const service=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../..');
const one=process.argv.includes('--once');
const root=path.resolve(process.env.LEARNING_DIR??path.join(service,one?`scripts/.cache/learning-probe-${Date.now()}`:'scripts/.learning-loop'));
const archive=process.env.ARCHIVE_DIR??path.join(process.env.HOME!,'shuttle-archive');
const tokenFile=process.env.SHUTTLE_ADMIN_TOKEN_FILE??path.join(process.env.HOME!,'.config/yale-shuttle/admin-token');
const base=process.env.BOT_BASE_URL??'https://yale-shuttle.fly.dev';
const publish=!one&&process.env.LEARNING_PUBLISH==='1';
fs.mkdirSync(root,{recursive:true});
const lock=path.join(root,'observer.lock');
try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});}catch(e:any){
 if(e.code!=='EEXIST')throw e;
 const owner=Number(fs.readFileSync(lock,'utf8'));if(!Number.isInteger(owner)||owner<=0)throw Error('Invalid observer lock');
 try{process.kill(owner,0);throw Error(`Observer already running (PID ${owner})`);}catch(status:any){
  if(status.code!=='ESRCH')throw status;
  fs.unlinkSync(lock);fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
 }
}
process.on('exit',()=>{try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}});
let stopping=false, state:any, lastReceived=0;
let exact:ExactForecastStream|undefined,lastInputKey:string|null=null,lastInputAt=0;
let lastForecasts:any={champion:[],challenger:[],productionControl:null};
const stateFile=path.join(root,'state.json');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function atomic(file:string,value:unknown){fs.writeFileSync(file+'.partial',JSON.stringify(value,null,2));fs.renameSync(file+'.partial',file);}
const event=(kind:string,detail:unknown)=>{const row={at:new Date().toISOString(),kind,detail};fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify(row)+'\n');console.log(JSON.stringify(row));};
async function api(route:string,body?:unknown){
 const token=process.env.SHUTTLE_ADMIN_TOKEN??fs.readFileSync(tokenFile,'utf8').trim();
 const res=await fetch(base+route,{headers:{'x-admin-token':token,...(body?{'content-type':'application/json'}:{})},method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 if(!res.ok){const detail:any=await res.json().catch(()=>null);const error:any=new Error(`${route}: HTTP ${res.status}`);error.code=detail?.error;error.status=res.status;error.response=detail;throw error;}
 return res.json();
}
const files=learningSourceFiles(service), sourceKey=identityHash(fileIdentity(files));
const candidateModel=()=>({version:state.id,publishedAt:state.startedAt,params:state.candidate.params});
function checkpoint(){
 if(exact&&state?.forecastProtocol==='served-control-v2'&&state.source?.seedSha256===exact.seedSha256){
  exact.setModels(state.champion,candidateModel());
  const next=exact.persist(path.join(root,state.id)),previous=state.source.runtime;
  if(previous?.file!==next.file)state.source.previousRuntime=previous;
  state.source.runtime=next;
  atomic(stateFile,state);
  pruneRuntimes(path.join(root,state.id),[state.source.runtime,state.source.previousRuntime]);
 }else atomic(stateFile,state);
}
function flushOutbox(){
 if(!state?.outbox?.length)return;
 for(const row of state.outbox)fs.appendFileSync(path.join(root,state.id,`pairs-${row.day}.jsonl`),JSON.stringify(row)+'\n');
 state.outbox=[];checkpoint();
}
function commit(rows:any[]){state.outbox=rows;checkpoint();flushOutbox();}
function readPairs(){
 const seen=new Map();
 for(const name of fs.readdirSync(path.join(root,state.id)).filter(n=>/^pairs-.*\.jsonl$/.test(n))){
  const text=fs.readFileSync(path.join(root,state.id,name),'utf8');
  for(const line of text.split('\n').filter(Boolean)){
   const row=JSON.parse(line),previous=seen.get(row.id);
   if(previous&&identityHash(previous)!==identityHash(row))throw Error('Conflicting forecast journal receipts');
   seen.set(row.id,row);
  }
 }
 return [...seen.values()];
}
function readSeed(){
 const receipt=state.source?.seedFile;
 if(!receipt||receipt.file!=='source-seed.json.gz'||!Number.isSafeInteger(receipt.bytes)||receipt.bytes>6*1024*1024)
  throw Error('Invalid frozen source seed receipt');
 const bytes=fs.readFileSync(path.join(root,state.id,receipt.file));
 if(bytes.length!==receipt.bytes||digest(bytes)!==receipt.sha256)throw Error('Frozen source seed file checksum mismatch');
 const raw=zlib.gunzipSync(bytes,{maxOutputLength:8*1024*1024});
 if(digest(raw)!==receipt.rawSha256||digest(raw)!==state.source.seedSha256)throw Error('Frozen source seed content checksum mismatch');
 return JSON.parse(raw.toString());
}
function verifyFrozen(){
 const file=path.join(root,state.id,'frozen-candidate.json');
 if(fileHash(file)!==state.frozenCandidateSha256)throw Error('Frozen candidate checksum mismatch');
 const frozen=JSON.parse(fs.readFileSync(file,'utf8'));
 const core=(params:any)=>{const copy={...params};delete copy.CONFORMAL;return identityHash(copy);};
 if(frozen.id!==state.id||frozen.startedAt!==state.startedAt||frozen.sourceKey!==state.sourceKey||frozen.productionBuild!==state.productionBuild
  ||modelKey(frozen.champion)!==modelKey(state.champion)||core(frozen.candidate.params)!==core(state.candidate.params)
  ||identityHash(frozen.trainingInputs)!==identityHash(state.trainingInputs)||identityHash(frozen.requiredRoutes)!==identityHash(state.requiredRoutes)
  ||identityHash(frozen.trainingDays)!==identityHash(state.trainingDays)
  ||identityHash(frozen.calibrationDays)!==identityHash(state.calibrationDays.slice(0,frozen.calibrationDays.length))
  ||frozen.source.seedSha256!==state.source.seedSha256||identityHash(frozen.source.seedFile)!==identityHash(state.source.seedFile))
  throw Error('Live candidate differs from frozen model/source/training identity');
 for(const original of files){
  const saved=path.join(root,state.id,'source',path.relative(service,original));
  if(fileHash(saved)!==fileHash(original))throw Error('Frozen estimator source bytes are missing or changed');
 }
 if(state.calibratedAt){
  const calibrated=path.join(root,state.id,'calibrated-candidate.json');
  if(fileHash(calibrated)!==state.calibratedCandidateSha256||identityHash(JSON.parse(fs.readFileSync(calibrated,'utf8')))!==identityHash(state.candidate))
   throw Error('Frozen calibrated candidate is missing or changed');
 }
 readSeed();
}
function verifyInputs(rows:any[]){
 if(state.forecastProtocol==='served-control-v2'){
  function* records(){
   for(const name of fs.readdirSync(path.join(root,state.id)).filter(n=>/^feed-.*\.jsonl.gz$/.test(n)).sort()){
    const text=zlib.gunzipSync(fs.readFileSync(path.join(root,state.id,name)),{finishFlush:zlib.constants.Z_SYNC_FLUSH}).toString('utf8');
    const complete=text.endsWith('\n')?text:text.slice(0,text.lastIndexOf('\n')+1);
    for(const raw of complete.split('\n').filter(Boolean))yield {raw,input:JSON.parse(raw)};
   }
  }
  try{return verifyExactReceipts(state,rows,records(),readSeed());}
  catch(error){holdSource(Date.now(),state.source.seedSha256,'Retained evaluation evidence failed: '+String(error));throw error;}
 }
 const needed=new Set<string>();
 const controls=new Map<string,any[]>();
 for(const p of rows){
  if(!p.inputHash)throw Error('Missing forecast input receipt');needed.add(p.inputHash);
  const group=controls.get(p.inputHash)??[];group.push(p);controls.set(p.inputHash,group);
  if(p.det!==null){if(!p.arrivalInputHash||!p.outcomeInputHash)throw Error('Missing curb outcome receipts');needed.add(p.arrivalInputHash);needed.add(p.outcomeInputHash);}
 }
 for(const name of fs.readdirSync(path.join(root,state.id)).filter(n=>/^feed-.*\.jsonl.gz$/.test(n))){
  if(!needed.size)break;
  // Validate the actual retained bytes, including concatenated gzip members
  // after a process restart. A missing/corrupt journal cannot authorize a fit.
  const text=zlib.gunzipSync(fs.readFileSync(path.join(root,state.id,name)),{finishFlush:zlib.constants.Z_SYNC_FLUSH}).toString('utf8');
  const complete=text.endsWith('\n')?text:text.slice(0,text.lastIndexOf('\n')+1);
  for(const line of complete.split('\n').filter(Boolean)){
   const hash=createHash('sha256').update(line).digest('hex');
   if(controls.has(hash)){
    const input=JSON.parse(line);
    for(const row of controls.get(hash)!)if(!productionControlInputValid(row,input))throw Error('Production control is not bound to its original input receipt');
    controls.delete(hash);
   }
   needed.delete(hash);
  }
 }
 if(needed.size)throw Error(`Missing ${needed.size} retained forecast/outcome inputs`);
}
async function begin(feed:any,health:any){
 if(state?.publishingVersion===feed.model_params?.version&&!state.promotedAt){state.promotedAt=Date.now();event('publication-observed',{version:state.publishingVersion});}
 if(state&&!state.invalidatedAt){
  state.invalidatedAt=Date.now();
  commit(excludePending(state,Date.now(),'cycle-invalidated'));
  await sealInputs();
  atomic(path.join(root,state.id,'closed-state.json'),state);
 }
 exact=undefined;
 const current=(await api('/api/stats/model-params')).current;
 if(!current?.accepted||!Number.isFinite(current.publishedAt)||current.publishedAt>=Date.now())throw Error('No verifiable current champion');
 const cutoff=Date.now(),positions:any[]=[],visits:any[]=[],inputs:any[]=[],days:string[]=[];
 for(const day of fs.readdirSync(archive).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()){
  const folder=path.join(archive,day),manifestFile=path.join(folder,'manifest.json');
  let m:any;try{m=JSON.parse(fs.readFileSync(manifestFile,'utf8'));}catch{continue;}
  if(!m.ok)continue;
  const tables=['raw_positions','stop_visits'];
  if(tables.some(table=>!m.tables?.[table]?.complete||!fs.existsSync(archiveTableFile(folder,table,m))))continue;
  const receipts=tables.map(table=>({table,file:archiveTableFile(folder,table,m),availableAt:Date.parse(m.tables[table].capturedAt??m.generatedAt),expected:m.tables[table].sha256}));
  if(receipts.some(r=>!Number.isFinite(r.availableAt)||r.availableAt>=cutoff))continue;
  for(const r of receipts){const sha256=fileHash(r.file);if(r.expected&&r.expected!==sha256)throw Error(`Archive checksum mismatch: ${day}/${r.table}`);inputs.push({...r,sha256});}
  inputs.push({file:manifestFile,sha256:fileHash(manifestFile)});
  for(const r of readArchiveTable(folder,'raw_positions',m))if(r.collected_at<cutoff)positions.push(r);
  for(const r of readArchiveTable(folder,'stop_visits',m))if(Number.isFinite(r.departed_at)&&r.departed_at<cutoff)visits.push(r);
  days.push(day);if(days.length===14)break;
 }
 if(days.length<7)throw Error(`Need seven archived training dates; found ${days.length}`);
 const routes=Object.entries(feed.routes).map(([id,stops])=>({id:Number(id),stops}));
 const fits={...estimateEmissions(tracksByName(positions),zoneTester(routes,feed.stop_coords)),...estimateVisitRates(visits)};
 const candidate=assembleCandidate(fits,null,current.params);
 candidate.params.CONFORMAL={...UNIT};
 const seed=await api('/api/evaluation/seed'),seedReceivedAt=Date.now();
 if(seed.build!==health.build)throw new SourceContextChanged('build','Production build changed while fitting');
 if(modelKey(seed.modelParams)!==modelKey(current))throw new SourceContextChanged('champion','Champion changed while fitting');
 const startedAt=Date.now(),first=nextDay(etDay(startedAt));
 const id=`cycle-${startedAt}`;
 const directory=path.join(root,id);fs.mkdirSync(directory);
 const next=new ExactForecastStream(health.build,sourceKey,current,{version:id,publishedAt:startedAt,params:candidate.params});
 next.seed(seed,seedReceivedAt);
 const seedRaw=Buffer.from(JSON.stringify(seed)),seedBytes=zlib.gzipSync(seedRaw);
 const seedFile={file:'source-seed.json.gz',sha256:digest(seedBytes),rawSha256:digest(seedRaw),bytes:seedBytes.length};
 fs.writeFileSync(path.join(directory,seedFile.file),seedBytes);
 assertLearningSourceUnchanged(service,sourceKey);
 // Preserve the code bytes used by both arms, not only their git identifier.
 for(const file of files){const dest=path.join(directory,'source',path.relative(service,file));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);}
 assertLearningSourceUnchanged(service,sourceKey);
 state={version:2,forecastProtocol:'served-control-v2',id,startedAt,sourceKey,productionBuild:health.build,champion:current,candidate,
  source:{epoch:next.epoch,seedSha256:next.seedSha256,seedFile,seedReceivedAt,seedAt:seed.at,seedCursor:seed.cursor,initialChain:next.chain},
  trainingDays:days.sort(),trainingInputs:inputs,requiredRoutes:[...new Set(positions.map(r=>r.route_id))].sort((a,b)=>a-b),
  calibrationDays:[first,nextDay(first)],pending:{},visits:{},outbox:[],archiveLastDay:days.at(-1),lastOutcomeAt:null};
 atomic(path.join(directory,'frozen-candidate.json'),state);
 state.frozenCandidateSha256=fileHash(path.join(directory,'frozen-candidate.json'));
 exact=next;lastInputKey=null;lastInputAt=0;
 lastForecasts={champion:[],challenger:[],productionControl:null};checkpoint();
 event('candidate-frozen',{id,trainingDays:state.trainingDays,championVersion:current.version,calibrationDays:state.calibrationDays,scalarChanges:Object.keys(fits).filter(k=>candidate.params[k]!==current.params[k]),issues:candidate.issues});
}
let inputStream:zlib.Gzip|undefined,inputSink:fs.WriteStream|undefined,inputFile='',lastMaintenance=0;
const execution=Date.now();
async function sealInputs(){
 if(!inputStream)return;
 const done=once(inputSink!,'finish');inputStream.end();await done;
 inputStream=undefined;inputSink=undefined;inputFile='';
}
async function captureInput(feed:any,receivedAt:number,source?:unknown){
 const record=source!==undefined?{receivedAt,source}:{receivedAt,feed},raw=JSON.stringify(record);
 const hour=new Date(receivedAt).toISOString().slice(0,13).replace('T','-');
 const file=path.join(root,state.id,`feed-${hour}-${execution}.jsonl.gz`);
 if(file!==inputFile){
  await sealInputs();
  inputStream=zlib.createGzip();inputSink=fs.createWriteStream(file,{flags:'a'});inputStream.pipe(inputSink);inputFile=file;
 }
 inputStream!.write(raw+'\n');
 await new Promise<void>((resolve,reject)=>inputStream!.flush(zlib.constants.Z_SYNC_FLUSH,err=>err?reject(err):resolve()));
 await new Promise<void>((resolve,reject)=>inputSink!.write('',err=>err?reject(err):resolve()));
 return createHash('sha256').update(raw).digest('hex');
}
async function maintain(now:number){
 const cutoff=dayStart(nextDay(state.calibrationDays[1]))+SETTLE_MS;
 if(!state.calibratedAt&&now>=cutoff){
  const rows=readPairs().filter(p=>p.phase==='calibration');
  if(state.protocolFailures?.count||rows.some(p=>!productionControlValid(p))){
   state.calibrationRefusal={at:now,reason:'Production-control parity is missing or mismatched; retain the full cohort for review.'};
   checkpoint();return;
  }
  const fitting=rows.map(calibrationObservation).filter(Boolean);
  state.conformalFitScope={sampled:rows.length,parameterAffected:fitting.length,fixedOrInvalid:rows.length-fitting.length};
  const fit=conformalFit(fitting);
  // Visit sampling has fewer observations than poll sampling. Require 200
  // distinct visit forecasts in EACH bucket before fitting; do not import
  // the legacy 500-correlated-poll floor as evidence of independent visits.
  const support=Object.values(fit).every((f:any)=>f.n>=200&&f.w!==null&&Number.isFinite(f.w)&&f.w<=4);
  if(!support){
   state.calibrationRefusal={at:now,fit,reason:'Need 200 sampled visits per horizon and valid widening (0.5–4).'};
   const today=etDay(now);if(!state.calibrationDays.includes(today))state.calibrationDays.push(today);
   checkpoint();return;
  }
  await sealInputs();verifyInputs(rows);
  const candidate=structuredClone(state.candidate);
  candidate.params.CONFORMAL=Object.fromEntries(Object.entries(fit).map(([h,f]:any)=>[h,Math.max(0.5,f.w)]));
  for(const [h,f]of Object.entries(fit)as any)candidate.n[`CONFORMAL.${h}`]=f.n;
  const calibrated=path.join(root,state.id,'calibrated-candidate.json');
  if(fs.existsSync(calibrated)&&identityHash(JSON.parse(fs.readFileSync(calibrated,'utf8')))!==identityHash(candidate)){
   holdSource(now,state.source.seedSha256,'Conflicting previously frozen calibrated candidate');throw Error(state.sourceRefusal.reason);
  }
  if(!fs.existsSync(calibrated))atomic(calibrated,candidate);
  state.candidate=candidate;state.calibratedCandidateSha256=fileHash(calibrated);
  state.calibratedAt=now;state.testStartDay=etDay(now);state.conformalFit=fit;checkpoint();
  event('intervals-frozen',{id:state.id,calibratedAt:now,fit});
 }
 if(!state.calibratedAt)return;
 const rows=readPairs();
 const days=[...new Set(rows.filter(p=>p.phase==='test').map(p=>p.day))].filter(d=>dayStart(nextDay(d))+SETTLE_MS<=now).sort();
 if(days.length<3)return;
 const key=days.join(',');if(state.evaluatedDays===key)return;
 await sealInputs();verifyInputs(rows.filter(p=>p.phase==='test'&&days.includes(p.day)));
 const decision=evaluate(state,rows,days);state.evaluatedDays=key;state.decision=decision;checkpoint();
 atomic(path.join(root,state.id,'validation.json'),decision);atomic(path.join(root,'latest-validation.json'),{id:state.id,...decision});
 event('validation',{id:state.id,promote:decision.promote,reasons:decision.reasons,uncertainty:decision.uncertainty});
 if(!decision.promote||sameParams(state.candidate.params,state.champion.params)||!publish)return;
 const current=(await api('/api/stats/model-params')).current;
 if(current.version!==state.champion.version||identityHash(current.params)!==identityHash(state.champion.params))throw Error('Champion changed before publication');
 const version=`prospective-${state.startedAt}`;state.publishingVersion=version;checkpoint();
 const submission={params:state.candidate.params,n:state.candidate.n,
  window:{from:state.trainingDays[0],to:days.at(-1),days:state.trainingDays.length+state.calibrationDays.length+days.length},
  version,accepted:true,note:'Passed prospective paired visit sampling, route/tail gates and day/bus clustered WIS comparison.',
  decision:{sourceKey,cycle:state.id,calibrationDays:state.calibrationDays,testDays:days,evidenceKey:decision.evidenceKey,uncertainty:decision.uncertainty}};
 atomic(path.join(root,state.id,'submission.json'),submission);
 const result=await api('/api/model-params',submission);state.promotedAt=Date.now();state.publishedId=result.id;checkpoint();event('promoted',{version,id:result.id});
}
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
let lastError:string|undefined,idleService=false;
function refuseProtocol(at:number,inputHash:string,reason:string){
 if(state.forecastProtocol!=='served-control-v2'&&!['calibration','test'].includes(phaseAt(state,at)))return;
 const receipt={at,inputHash,reason},previous=state.protocolFailures;
 state.protocolFailures={count:(previous?.count??0)+1,first:previous?.first??receipt,last:receipt};
 if(!previous)event('production-control-refusal',receipt);
 checkpoint();
}
function holdSource(at:number,inputHash:string,reason:string){
 if(!state.sourceRefusal){
  state.sourceRefusal={at,inputHash,reason};refuseProtocol(at,inputHash,reason);
  commit(excludePending(state,at,'source-protocol-refusal'));
 }
}
function status(error=lastError,terminal=false){
 atomic(path.join(root,'status.json'),{updatedAt:new Date().toISOString(),running:!one&&!terminal,
  publicationEnabled:publish,...(error?{error}:{}),phase:state?phaseAt(state,Date.now()):'starting',
  cycle:state?.id,forecastProtocol:state?.forecastProtocol,champion:state?.champion?.version,
  trainingDays:state?.trainingDays,calibrationDays:state?.calibrationDays,calibratedAt:state?.calibratedAt??null,
  lastOutcomeAt:state?.lastOutcomeAt??null,pending:Object.values(state?.pending??{}).filter((p:any)=>!p.closed).length,
  forecasts:{champion:lastForecasts.champion.length,challenger:lastForecasts.challenger.length},
  productionControl:lastForecasts.productionControl,protocolFailures:state?.protocolFailures??null,
  sourceRefusal:state?.sourceRefusal??null,source:exact?{...exact.receipt(),canSample:exact.canSample()}:null,
  idleService,
  feedReceivedAt:lastReceived?new Date(lastReceived).toISOString():null,
  lastInputAt:lastInputAt?new Date(lastInputAt).toISOString():null,
  calibrationRefusal:state?.calibrationRefusal??null,decision:state?.decision?{promote:state.decision.promote,reasons:state.decision.reasons}:null});
}
async function readSource(){
 try{return await api('/api/evaluation/inputs?epoch='+encodeURIComponent(exact!.epoch)+'&after='+exact!.cursor);}
 catch(error:any){
  if(['evaluation_epoch','evaluation_gap','evaluation_cursor'].includes(error.code)){
   const at=Date.now(),hash=await captureInput(null,at,{request:{epoch:exact!.epoch,after:exact!.cursor},response:{status:error.status,body:error.response}});
   if(error.code==='evaluation_epoch'){const changed:any=new SourceContextChanged('epoch','Production observation epoch changed');changed.inputHash=hash;throw changed;}
   holdSource(at,hash,'Exact source refused required history: '+error.code);
  }
  throw error;
 }
}
async function readHead(){
 const head:any=await api('/api/evaluation/inputs');
 if(!head||head.v!==1||typeof head.build!=='string'||!head.build.length||typeof head.epoch!=='string'||!head.epoch.length
  ||!Number.isSafeInteger(head.cursor)||head.cursor<1||!Number.isSafeInteger(head.at)||head.at<0
  ||!Array.isArray(head.feed?.buses)||!head.feed.routes||!head.feed.stop_coords||!head.feed.segments||!head.feed.dwells
  ||typeof head.feed.model_params?.version!=='string'||!head.feed.model_params.params){
  if(state){const at=Date.now(),hash=await captureInput(null,at,{head});holdSource(at,hash,'Malformed exact source head');}
  throw Error('Malformed exact source head');
 }
 return head;
}
async function collect(){
 while(!stopping){
  const packet:any=await readSource(),receivedAt=Date.now();
  if(!packet||typeof packet!=='object'){
   const hash=await captureInput(null,receivedAt,packet);holdSource(receivedAt,hash,'Malformed exact source response');throw Error(state.sourceRefusal.reason);
  }
  const hasFrames=Array.isArray(packet.frames)&&packet.frames.length>0;
  const feed=packet.feed,signature=feed?observationKey(feed):null;
  const processed=!!feed&&(signature!==lastInputKey||(!feed.server_eta&&receivedAt-lastInputAt>=10000));
  const inputHash=hasFrames||processed||packet.hasMore?await captureInput(null,receivedAt,packet):null;
  try{exact!.advance(packet);}
  catch(error){
   if(error instanceof SourceContextChanged){(error as any).inputHash=inputHash;throw error;}
   const hash=inputHash??await captureInput(null,receivedAt,packet);
   holdSource(receivedAt,hash,String(error));throw error;
  }
  if(hasFrames||packet.hasMore){
   checkpoint();
   // Obtain a fresh caught-up HTTP view after computation. Backfill does not
   // supply retrospective forecast timestamps or retrospectively seen curbs.
   continue;
  }
  if(!Array.isArray(feed?.buses)||!feed.routes||!feed.stop_coords||!feed.segments||!feed.dwells){
   const hash=inputHash??await captureInput(null,receivedAt,packet);
   holdSource(receivedAt,hash,'Invalid current exact-source feed');throw Error(state.sourceRefusal.reason);
  }
  return {feed,receivedAt,responseAt:packet.responseAt,signature,processed,inputHash};
 }
 return null;
}
try{
 state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
 if(state.forecastProtocol==='served-control-v2'&&state.sourceKey===sourceKey&&!state.invalidatedAt&&!state.sourceRefusal){
  try{
   verifyFrozen();exact=new ExactForecastStream(state.productionBuild,sourceKey,state.champion,candidateModel());
   exact.recover(path.join(root,state.id),state.source.runtime,state.source.seedSha256);
  }catch(error){exact=undefined;holdSource(Date.now(),state.source?.seedSha256??'',String(error));}
 }
 flushOutbox();commit(excludePending(state,Date.now(),'observer-restart'));
 lastInputKey=state.lastInputKey??null;lastInputAt=state.lastInputAt??0;
}catch(error:any){if(error.code!=='ENOENT'){lastError=error.message;status(lastError,true);throw error;}}
while(!stopping){
 const start=Date.now();
 try{
  if(!exact||state.sourceRefusal){
   // A refused source waits below before reaching maintenance. Let the
   // supervisor load changed code without clearing the original refusal.
   assertLearningSourceUnchanged(service,sourceKey);
   const head=await readHead();
   const changed=state?.source&&head.epoch!==state.source.epoch||state&&head.build!==state.productionBuild
    ||state&&modelKey(head.feed?.model_params)!==modelKey(state.champion);
   if(!state||state.sourceKey!==sourceKey||state.promotedAt||state.invalidatedAt||changed||state.forecastProtocol!=='served-control-v2'){
    event('cycle-start-context',{previous:state?.id,reason:changed?'Production context changed':'Initial/source cycle'});
    await begin(head.feed,{build:head.build});lastMaintenance=Date.now();
   }
   if(state.sourceRefusal){lastError=state.sourceRefusal.reason;status();if(one){process.exitCode=1;break;}await sleep(10000);continue;}
   if(!exact)throw Error('Missing exact runtime; source recovery was not completed');
  }
  let collected;
  try{collected=await collect();}
  catch(error){
   if(!(error instanceof SourceContextChanged))throw error;
   event('cycle-invalidated',{reason:error.message});const head=await readHead();
   if(head.build===state.productionBuild&&head.epoch===state.source.epoch&&modelKey(head.feed?.model_params)===modelKey(state.champion)){
    holdSource(Date.now(),(error as any).inputHash??state.source.seedSha256,'Unconfirmed production context change: '+error.message);
    throw Error(state.sourceRefusal.reason);
   }
   await begin(head.feed,{build:head.build});lastMaintenance=Date.now();collected=await collect();
  }
  if(!collected)break;
  const {feed,receivedAt,signature,processed}=collected;
  idleService=feed.buses.length===0&&!feed.server_eta;
  if(lastReceived&&receivedAt-lastReceived>30000)commit(excludePending(state,receivedAt,'observation-gap'));
  lastReceived=receivedAt;state.lastReceivedAt=receivedAt;
  if(processed){
   const inputHash=collected.inputHash!;
   const resolved=observe(state,feed,receivedAt,inputHash);
   if(resolved.length){state.lastOutcomeAt=receivedAt;event('outcomes',{n:resolved.length,matched:resolved.filter(p=>p.det!==null).length});}
   commit(resolved);
   let forecasts;
   try{forecasts=exact!.sample(feed,receivedAt,collected.responseAt);}
   catch(error){holdSource(receivedAt,inputHash,String(error));throw error;}
   if(forecasts.productionControl&&(forecasts.productionControl.mismatched||forecasts.productionControl.missing)){
    holdSource(receivedAt,inputHash,'Sampled control differs from actual served forecasts');throw Error(state.sourceRefusal.reason);
   }
   const challenger=new Map(forecasts.challenger.map((p:any)=>[keyOf(p.bus,p.stop),p]));
   const phase=phaseAt(state,receivedAt);
   const estimate=(p:any)=>({eta:p.eta,low:p.low,high:p.high,raw:p.raw,ageSec:p.ageSec,
    forecastSource:p.forecastSource,conformalBounds:p.conformalBounds,runtimeIntervals:p.runtimeIntervals,...(p.control?{control:p.control}:{})});
   for(const p of forecasts.champion){
    const b=challenger.get(keyOf(p.bus,p.stop));
    recordForecast(state,p.bus,p.stop,receivedAt,estimate(p),
     b?estimate(b):{eta:p.eta,low:null,high:null,missing:true},phase,inputHash);
   }
   lastForecasts=forecasts;lastInputKey=signature;lastInputAt=receivedAt;
   state.lastInputKey=lastInputKey;state.lastInputAt=lastInputAt;
  }
  if(receivedAt-lastMaintenance>60000){
   assertLearningSourceUnchanged(service,sourceKey);
   try{verifyFrozen();}catch(error){holdSource(receivedAt,state.source.seedSha256,'Frozen evaluation evidence failed: '+String(error));throw error;}
   await maintain(receivedAt);lastMaintenance=receivedAt;
  }
  checkpoint();lastError=undefined;status();
 }catch(error:any){
  if(state?.publishingVersion&&!state.promotedAt){state.evaluatedDays=null;checkpoint();lastMaintenance=Date.now();}
  lastError=error.message;event('error',lastError);status();
  if(one||lastError?.includes('restart required')){process.exitCode=1;break;}
 }
 if(one)break;
 await sleep(Math.max(500,2000-(Date.now()-start)));
}
await sealInputs();
if(state)checkpoint();
status(lastError,true);
