import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { forecastArms } from './forecasts';
import { archiveTableFile, readArchiveTable } from '../archive-files.mjs';
import { assembleCandidate, conformalFit, estimateEmissions, estimateVisitRates,
  sameParams, tracksByName, zoneTester } from '../reestimate-lib.mjs';
import { fileHash, fileIdentity, identityHash } from '../reestimate-validation.mjs';
import { dayStart, etDay, evaluate, excludePending, keyOf, nextDay, observe,
  phaseAt, recordForecast, SETTLE_MS, UNIT } from './lib.mjs';

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
let stopping=false, state:any, lastReceived=0, warmedUntil=Date.now()+120000;
let stores={champion:new Map(),challenger:new Map()};
const stateFile=path.join(root,'state.json');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function atomic(file:string,value:unknown){fs.writeFileSync(file+'.partial',JSON.stringify(value,null,2));fs.renameSync(file+'.partial',file);}
const event=(kind:string,detail:unknown)=>{const row={at:new Date().toISOString(),kind,detail};fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify(row)+'\n');console.log(JSON.stringify(row));};
async function api(route:string,body?:unknown){
 const token=process.env.SHUTTLE_ADMIN_TOKEN??fs.readFileSync(tokenFile,'utf8').trim();
 const res=await fetch(base+route,{headers:{'x-admin-token':token,...(body?{'content-type':'application/json'}:{})},method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 if(!res.ok)throw Error(`${route}: HTTP ${res.status}`);
 return res.json();
}
function sourceFiles(){
 const files:string[]=[];
 const walk=(dir:string)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);
  if(entry.isDirectory())walk(file);
  else if(/\.(ts|tsx|mjs|json)$/.test(file)&&!/(\.test\.|__fixtures__)/.test(file))files.push(file);
 }};
 for(const folder of ['src','web/src','scripts/learning-loop'])walk(path.join(service,folder));
 for(const name of ['scripts/reestimate-lib.mjs','scripts/reestimate-validation.mjs','scripts/archive-files.mjs','package-lock.json'])files.push(path.join(service,name));
 return files;
}
const files=sourceFiles(), sourceKey=identityHash(fileIdentity(files));
const checkpoint=()=>atomic(stateFile,state);
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
function verifyInputs(rows:any[]){
 const needed=new Set<string>();
 for(const p of rows){
  if(!p.inputHash)throw Error('Missing forecast input receipt');needed.add(p.inputHash);
  if(p.det!==null){if(!p.arrivalInputHash||!p.outcomeInputHash)throw Error('Missing curb outcome receipts');needed.add(p.arrivalInputHash);needed.add(p.outcomeInputHash);}
 }
 for(const name of fs.readdirSync(path.join(root,state.id)).filter(n=>/^feed-.*\.jsonl.gz$/.test(n))){
  if(!needed.size)break;
  // Validate the actual retained bytes, including concatenated gzip members
  // after a process restart. A missing/corrupt journal cannot authorize a fit.
  const text=zlib.gunzipSync(fs.readFileSync(path.join(root,state.id,name)),{finishFlush:zlib.constants.Z_SYNC_FLUSH}).toString('utf8');
  const complete=text.endsWith('\n')?text:text.slice(0,text.lastIndexOf('\n')+1);
  for(const line of complete.split('\n').filter(Boolean))needed.delete(createHash('sha256').update(line).digest('hex'));
 }
 if(needed.size)throw Error(`Missing ${needed.size} retained forecast/outcome inputs`);
}
async function begin(feed:any,health:any){
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
 const startedAt=Date.now(),first=nextDay(etDay(startedAt));
 const id=`cycle-${startedAt}`;
 const directory=path.join(root,id);fs.mkdirSync(directory,{recursive:true});
 // Preserve the code bytes used by both arms, not only their git identifier.
 for(const file of files){const dest=path.join(directory,'source',path.relative(service,file));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);}
 state={version:1,id,startedAt,sourceKey,productionBuild:health.build,champion:current,candidate,
  trainingDays:days.sort(),trainingInputs:inputs,requiredRoutes:[...new Set(positions.map(r=>r.route_id))].sort((a,b)=>a-b),
  calibrationDays:[first,nextDay(first)],pending:{},visits:{},outbox:[],archiveLastDay:days.at(-1),lastOutcomeAt:null};
 atomic(path.join(directory,'frozen-candidate.json'),state);
 stores={champion:new Map(),challenger:new Map()};warmedUntil=startedAt+120000;checkpoint();
 event('candidate-frozen',{id,trainingDays:state.trainingDays,championVersion:current.version,calibrationDays:state.calibrationDays,scalarChanges:Object.keys(fits).filter(k=>candidate.params[k]!==current.params[k]),issues:candidate.issues});
}
let inputStream:zlib.Gzip|undefined,inputSink:fs.WriteStream|undefined,inputFile='',lastMaintenance=0;
const execution=Date.now();
async function sealInputs(){
 if(!inputStream)return;
 const done=once(inputSink!,'finish');inputStream.end();await done;
 inputStream=undefined;inputSink=undefined;inputFile='';
}
async function captureInput(feed:any,receivedAt:number){
 const record={receivedAt,feed},raw=JSON.stringify(record);
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
  const fit=conformalFit(rows.map(p=>({r:p.r,...p.challenger,det:p.det})));
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
  state.candidate.params.CONFORMAL=Object.fromEntries(Object.entries(fit).map(([h,f]:any)=>[h,Math.max(0.5,f.w)]));
  for(const [h,f]of Object.entries(fit)as any)state.candidate.n[`CONFORMAL.${h}`]=f.n;
  state.calibratedAt=now;state.testStartDay=etDay(now);state.conformalFit=fit;checkpoint();
  atomic(path.join(root,state.id,'calibrated-candidate.json'),state.candidate);
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
try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));flushOutbox();commit(excludePending(state,Date.now(),'observer-restart'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
while(!stopping){
 const start=Date.now();
 try{
  const feed=await api('/api/buses'),receivedAt=Date.now();
  if(!Array.isArray(feed.buses)||!feed.stop_coords||!feed.routes||!feed.segments||!feed.dwells)throw Error('Invalid production feed');
  if(!state||state.sourceKey!==sourceKey||state.promotedAt){await begin(feed,await api('/healthz'));lastMaintenance=receivedAt;}
  if(state.publishingVersion&&feed.model_params?.version===state.publishingVersion){state.promotedAt=receivedAt;checkpoint();continue;}
  if(feed.model_params?.version!==state.champion.version||identityHash(feed.model_params?.params)!==identityHash(state.champion.params)){
   event('cycle-invalidated','Champion changed during prospective collection');await begin(feed,await api('/healthz'));
  }
  if(lastReceived&&receivedAt-lastReceived>30000)commit(excludePending(state,receivedAt,'observation-gap'));
  const inputHash=await captureInput(feed,receivedAt);
  const resolved=observe(state,feed,receivedAt,inputHash);
  if(resolved.length){state.lastOutcomeAt=receivedAt;event('outcomes',{n:resolved.length,matched:resolved.filter(p=>p.det!==null).length});}
  commit(resolved);
  const raw={...state.candidate.params,CONFORMAL:UNIT};
  const forecasts=forecastArms(feed,receivedAt,state.champion,{version:state.id,publishedAt:state.startedAt,params:raw},stores);
  const challenger=new Map(forecasts.challenger.map((p:any)=>[keyOf(p.bus,p.stop),p]));
  const phase=phaseAt(state,receivedAt);
  if(receivedAt>=warmedUntil)for(const p of forecasts.champion){
   const b=challenger.get(keyOf(p.bus,p.stop));
   // An absent challenger forecast stays in the paired population. Omitting
   // it would reward a candidate for declining difficult predictions.
   recordForecast(state,p.bus,p.stop,receivedAt,{eta:p.eta,low:p.low,high:p.high},
     b?{eta:b.eta,low:b.low,high:b.high}:{eta:p.eta,low:null,high:null,missing:true},phase,inputHash);
  }
  lastReceived=receivedAt;state.lastReceivedAt=receivedAt;
  if(receivedAt-lastMaintenance>60000){
   if(identityHash(fileIdentity(files))!==sourceKey)throw Error('Estimator source changed; restart required to freeze a new cycle');
   const health=await api('/healthz');
   if(health.build!==state.productionBuild){event('cycle-invalidated','Production build changed');await begin(feed,health);}
   await maintain(receivedAt);lastMaintenance=receivedAt;
  }
  checkpoint();
  atomic(path.join(root,'status.json'),{updatedAt:new Date().toISOString(),running:!one,publicationEnabled:publish,phase:phaseAt(state,receivedAt),cycle:state.id,champion:state.champion.version,trainingDays:state.trainingDays,calibrationDays:state.calibrationDays,calibratedAt:state.calibratedAt??null,lastOutcomeAt:state.lastOutcomeAt,pending:Object.values(state.pending).filter((p:any)=>!p.closed).length,forecasts:{champion:forecasts.champion.length,challenger:forecasts.challenger.length},calibrationRefusal:state.calibrationRefusal??null,decision:state.decision?{promote:state.decision.promote,reasons:state.decision.reasons}:null});
 }catch(e:any){
  if(state?.publishingVersion&&!state.promotedAt){state.evaluatedDays=null;checkpoint();lastMaintenance=Date.now();}
  event('error',e.message);atomic(path.join(root,'status.json'),{updatedAt:new Date().toISOString(),running:true,error:e.message,publicationEnabled:publish});
  if(one||e.message.includes('restart required')){process.exitCode=1;break;}
 }
 if(one)break;
 await sleep(Math.max(1000,10000-(Date.now()-start)));
}
await sealInputs();
if(state)checkpoint();
