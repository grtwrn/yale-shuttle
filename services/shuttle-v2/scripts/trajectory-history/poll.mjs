#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {atomicJson,withStorageLock} from '../retention/storage.mjs';import {rotateOutput} from '../retention/maintain.mjs';
import {witnessSHA} from '../../src/collector/witnessCodec.ts';
import {nativeRecords,ModelProjection} from './native.mjs';import {collectorSnapshot,CollectorProjection} from './collector.mjs';import {HistoryStore,HistoryHold} from './storage.mjs';
import {PosteriorCapture} from './posterior.mjs';
import {trialContexts} from '../learning-loop/trial-evidence.mjs';
const service=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),MiB=1024*1024,read=p=>JSON.parse(fs.readFileSync(p));
const cycleId=v=>typeof v==='string'&&/^cycle-\d+$/.test(v),hash=v=>/^[a-f0-9]{64}$/.test(v??'');
const archiveSourceKey=witnessSHA(JSON.stringify(['native.mjs','collector.mjs','storage.mjs','poll.mjs','posterior.mjs','../collector-witness-watch/protocol.mjs','../../src/collector/witnessCodec.ts','../learning-loop/trial-evidence.mjs','../reestimate-validation.mjs','../../src/server/executionIdentity.ts'].map(name=>[name,witnessSHA(fs.readFileSync(new URL(name,import.meta.url)))])));
function inputFiles(root,cycle,since,until,prior){const directory=path.join(root,cycle);if(fs.lstatSync(directory).isSymbolicLink())throw Error('Invalid native cycle');const all=fs.readdirSync(directory).filter(n=>/^feed-\d{4}-\d\d-\d\d-\d\d-\d+\.jsonl\.gz$/.test(n)).sort().map(n=>path.join(directory,n)),selected=all.filter(file=>{const n=path.basename(file),start=Date.parse(n.slice(5,15)+'T'+n.slice(16,18)+':00:00Z');return start+3600000>since&&start<=until;});return selected.length?selected:all.filter(file=>prior?.[file]).slice(-1);}
async function verifyUnchanged(file,previous){
 const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.dev!==previous.dev||st.ino!==previous.ino||st.size!==previous.bytes)return false;
 const h=createHash('sha256');if(previous.bytes)for await(const b of fs.createReadStream(file,{start:0,end:previous.bytes-1}))h.update(b);if(h.digest('hex')!==previous.sha256)throw Error('Native input prefix changed');return true;
}

/** Local read-only inputs, independent output database. No API requests,
 * estimator execution, fitting, report writes, publication or process signals. */
export async function collectHistory({store,learningRoot=path.join(service,'scripts/.learning-loop'),collectorFile=path.join(service,'scripts/.bot-artifacts/collector-witness-watch/witnesses.sqlite'),now=Date.now(),throughAt=now,capturePosteriors=false}={}){
 const before=store.state(),live=read(path.join(learningRoot,'state.json'));if(Object.keys(before).length&&before.version!==1)throw Error('Unsupported timing history state');if(live.forecastProtocol!=='served-control-v2'||!cycleId(live.id)||!hash(live.sourceKey))throw Error('Unsupported live native source');
 const fromAt=before.throughAt??before.checkedAt??now-2*3600000;if(!Number.isSafeInteger(fromAt)||!Number.isSafeInteger(throughAt)||fromAt>throughAt||throughAt>now)throw Error('Invalid history capture interval');
 const nativeStatus=read(path.join(learningRoot,'status.json')),receivedAt=Date.parse(nativeStatus.feedReceivedAt);if(nativeStatus.cycle!==live.id||!nativeStatus.running||nativeStatus.error||live.sourceRefusal||nativeStatus.sourceRefusal||live.protocolFailures?.count>0||nativeStatus.protocolFailures?.count>0||!Number.isFinite(receivedAt)||now-receivedAt>120000||receivedAt>now+5000)throw Error('Native source is not fresh or is refused');
 // Several exact contexts can begin and end between two archive polls. Follow
 // the current trial's exact closed-state links rather than just its endpoints;
 // missing/conflicting links must fail before any history cursor advances.
 const contexts=trialContexts(learningRoot,live);
 for(let i=0;i<contexts.length-1;i++)if(!Number.isSafeInteger(contexts[i].invalidatedAt)||contexts[i].invalidatedAt<contexts[i].startedAt||contexts[i].invalidatedAt>contexts[i+1].startedAt)throw Error('Native context closure chronology differs');
 // A genuinely new statistical trial has no link to the previously captured
 // one. Retain that endpoint's diagnostic history under the existing checks.
 if(cycleId(before.cycle)&&!contexts.some(c=>c.id===before.cycle))contexts.unshift({id:before.cycle});
 const archiveChanged=before.archiveSourceKey&&before.archiveSourceKey!==archiveSourceKey;
 if(archiveChanged){before.model={...before.model,tracks:{}};before.collector={...before.collector,tracks:{}};before.posterior={};}
 const catchingUp=throughAt<now,posterior=capturePosteriors&&!catchingUp?new PosteriorCapture(learningRoot,live,{now,prior:before.posterior??{}}):null;
 const snapshot=collectorSnapshot(collectorFile,{since:Math.min(before.collector?.last?.at??fromAt,throughAt)-10000,until:throughAt});
 const models=new ModelProjection(before.model??{},snapshot.topologies,info=>posterior?.modelContext(info)),prefixes={},files=[];
 for(const context of contexts){const cycle=context.id,raw=fs.readFileSync(path.join(learningRoot,cycle,'frozen-candidate.json')),frozen=JSON.parse(raw);if(frozen.id!==cycle||!hash(frozen.sourceKey))throw Error('Invalid frozen source identity');
  if(context.frozenCandidateSha256!==undefined&&(!hash(context.frozenCandidateSha256)||witnessSHA(raw)!==context.frozenCandidateSha256)||(context.trial||cycle===live.id)&&!hash(context.frozenCandidateSha256))throw Error('Frozen native identity differs');
  if(context.sourceKey!==undefined&&context.sourceKey!==frozen.sourceKey||context.productionBuild!==undefined&&context.productionBuild!==frozen.productionBuild||context.trial&&(!hash(context.sourceKey)||typeof context.productionBuild!=='string'||!context.productionBuild||!Number.isSafeInteger(context.startedAt)||context.startedAt<0||frozen.trialSHA256!==context.trialSHA256||frozen.startedAt!==context.startedAt||typeof frozen.source?.epoch!=='string'||!frozen.source.epoch||!hash(frozen.source?.seedSha256)||frozen.source.epoch!==context.source?.epoch||frozen.source.seedSha256!==context.source?.seedSha256))throw Error('Frozen native context differs from its exact descriptor');
  // Still verify every exact link/frozen descriptor above, but do not carry a
  // completed context's old prefix into every later interval's read budget.
  if(context.trial&&(context.startedAt>throughAt||Number.isSafeInteger(context.invalidatedAt)&&context.invalidatedAt<fromAt))continue;
  for(const file of inputFiles(learningRoot,cycle,fromAt,throughAt,before.prefixes))files.push({file,cycle,sourceKey:frozen.sourceKey,build:frozen.productionBuild,epoch:frozen.source?.epoch,stat:fs.lstatSync(file)});
 }
 // A trial handover can leave no native files in a past outage interval.
 // Commit the explicit source gap below and keep catching up; only original
 // current evidence may satisfy the fresh-coverage checks.
 if(!files.length&&!catchingUp||files.length>8||files.reduce((s,x)=>s+x.stat.size,0)>512*MiB)throw new HistoryHold('Native history read bound exceeded');
 let inputLines=0,unchangedFiles=0;
 for(const spec of files){const prior=before.prefixes?.[spec.file];if(prior&&(prior.throughAt??before.throughAt??before.checkedAt??-Infinity)>=throughAt&&await verifyUnchanged(spec.file,prior)){prefixes[spec.file]=prior;unchangedFiles++;
   if(posterior?.matches(spec.cycle,spec.sourceKey))for await(const item of nativeRecords(spec.file,{previous:prior,captureBytes:spec.stat.size,expectedFile:spec.stat})){if(item.record)posterior.observe(item.record.source,{cycle:spec.cycle,sourceKey:spec.sourceKey});}
   continue;}
  for await(const item of nativeRecords(spec.file,{previous:prior,captureBytes:spec.stat.size,expectedFile:spec.stat})){if(item.prefix){prefixes[spec.file]={...item.prefix,throughAt};continue;}inputLines++;const p=item.record.source,receiptAt=item.record.receivedAt??p?.responseAt??p?.frames?.at(-1)?.at;if(!Number.isSafeInteger(receiptAt))throw Error('Invalid native receipt clock');if(receiptAt<fromAt||receiptAt>throughAt)continue;if(p?.build&&p.build!==spec.build)throw Error('Native input build differs from frozen source');if(p?.build&&spec.epoch!==undefined&&p.epoch!==spec.epoch)throw Error('Native input epoch differs from frozen source');posterior?.observe(p,{cycle:spec.cycle,sourceKey:spec.sourceKey});models.consume(p,{cycle:spec.cycle,sourceKey:spec.sourceKey,receivedAt:item.record.receivedAt,rawSHA256:item.rawSHA256});}
 }
 const phase=posterior?.finish(models.state)??{records:[],state:before.posterior??{},status:{enabled:capturePosteriors,ok:!capturePosteriors,state:capturePosteriors?'backfilling':'disabled',capturedModels:0}};
 const pending={...before.pendingSources};for(const r of [...models.records,...phase.records])if(['model-projection','posterior-projection'].includes(r.kind)&&r.collector?.status==='recorded'){const key=r.collector.epoch+':'+r.collector.seq,old=pending[key],value={at:r.at,sha256:r.collector.sha256,topologySha256:r.collector.topologySha256};if(old&&(old.sha256!==value.sha256||old.topologySha256!==value.topologySha256))throw Error('Conflicting named collector source');pending[key]??=value;}
 if(Object.keys(pending).length>1024)throw new HistoryHold('Pending model/source association bound exceeded');
 const sources=new CollectorProjection(before.collector??{},new Set(Object.keys(pending)));sources.consume(snapshot,{until:throughAt});
 for(const r of sources.records)if(r.kind==='collector-projection'){const key=r.epoch+':'+r.header.seq,expected=pending[key];if(expected&&(expected.sha256!==r.header.sha256||expected.topologySha256!==r.header.topologySha256))throw Error('Named collector commitment differs');delete pending[key];}
 const expired=[];for(const[key,value]of Object.entries(pending))if(throughAt-value.at>2*3600000){expired.push({kind:'model-source-unavailable',at:value.at,reference:key,sha256:value.sha256,reason:'Original collector frame was not retained within the two-hour association window.'});delete pending[key];}
 const records=[...models.records,...sources.records,...phase.records,...expired,...(archiveChanged?[{kind:'history-boundary',at:now,reason:'projection-code-changed',previousArchiveSourceKey:before.archiveSourceKey,archiveSourceKey}]:[])].sort((a,b)=>a.at-b.at);
 const latestModel=models.state.last?.at??null,latestCollector=sources.state.last?.at,idle=models.state.idleService===true,unavailable=models.state.forecastUnavailable===true,latestNative=idle?models.state.idleReceipt?.receivedAt:unavailable?models.state.forecastUnavailableReceipt?.receivedAt:latestModel;
 const missing=[...(!Number.isSafeInteger(latestNative)||throughAt-latestNative>120000||latestNative>throughAt+5000?['native']:[]),...(!Number.isSafeInteger(latestCollector)||throughAt-latestCollector>120000||latestCollector>throughAt+5000?['collector']:[])];
 if(missing.length){if(!catchingUp){const e=Error('Timing history source did not advance to its capture interval');e.captureDiagnostics={now,throughAt,latestModel,latestNative,latestCollector,model:models.counts,collector:sources.counts};throw e;}records.push({kind:'history-source-gap',at:throughAt,intervalStart:fromAt,intervalEnd:throughAt,unavailableSources:missing,lastKnownModelAt:latestModel,lastKnownNativeReceiptAt:latestNative??null,lastKnownCollectorAt:latestCollector??null,scope:'Original source chronology is unavailable in part of this historical interval. No physical departure, movement, boarding or ETA-accuracy result is inferred.'});records.sort((a,b)=>a.at-b.at);if(missing.includes('collector'))sources.state.tracks={};if(missing.includes('native'))models.state.tracks={};}
 const caughtUp=!catchingUp, next={version:1,archiveSourceKey,cycle:live.id,model:models.state,collector:sources.state,posterior:phase.state,prefixes,pendingSources:pending,checkedAt:now,throughAt};
 const retention=store.commit({records,state:next,topologies:snapshot.topologies,now});
 return{checkedAt:new Date(now).toISOString(),ok:caughtUp,caughtUp,throughAt,cycle:live.id,archiveSourceKey,runtime:process.versions.node,modelAt:latestModel,collectorAt:latestCollector,posteriorCapture:phase.status,idleService:idle,...(idle?{idleReceipt:models.state.idleReceipt}:{}),forecastUnavailable:unavailable,...(unavailable?{forecastUnavailableReceipt:models.state.forecastUnavailableReceipt}:{}),inputLines,unchangedFiles,nativeContextsRead:[...new Set(files.map(f=>f.cycle))],model:models.counts,collector:sources.counts,pendingSourceAssociations:Object.keys(pending).length,unavailableSourceAssociations:expired.length,readOnlySnapshotTransactionMs:snapshot.transactionMs,retention,scope:'Verified compact projections of original local forecasts and collector records; minute samples plus observed transitions/source writes. Optional posterior samples retain exact original inputs and already-computed champion state projections. Fresh empty or forecast-unavailable GPS receipts are distinct from model frames and physical service truth. Gaps remain unknown. Not full reducer/forecast replay, physical boarding truth, independent ETA accuracy or promotion qualification.'};
}

/** Each independently verified interval commits its own cursor atomically.
 * Pending catch-up stays unhealthy; it never receives a fresh model clock. */
export async function catchUpHistory({store,learningRoot,collectorFile,now,clock=Date.now,capturePosteriors=false,maxIntervals=32,budgetMs=120000,onProgress}={}){
 if(!Number.isSafeInteger(maxIntervals)||maxIntervals<1||maxIntervals>32||!Number.isFinite(budgetMs)||budgetMs<0||budgetMs>120000)throw Error('Invalid history catch-up budget');
 const started=performance.now(),intervals=[];let result;
 for(let i=0;i<maxIntervals;i++){const at=now??clock(),before=store.state(),from=before.throughAt??before.checkedAt??at-2*3600000,throughAt=at-from<=16*60000?at:from+15*60000;
  result=await collectHistory({store,learningRoot,collectorFile,now:at,throughAt,capturePosteriors});intervals.push({throughAt:result.throughAt,modelAt:result.modelAt,collectorAt:result.collectorAt,records:result.retention.committedRecords,chunkIds:result.retention.chunkIds});if(result.ok)break;await onProgress?.({...result,catchUpIntervals:intervals});if(performance.now()-started>=budgetMs)break;
 }
 if(!result)throw Error('No timing-history capture interval was attempted');return{...result,...(!result.ok?{errorCode:'backfill_pending',error:'Verified catch-up intervals were committed; fresh coverage is still pending.'}:{}),catchUpIntervals:intervals};
}

export async function runOnce({directory=process.env.TRAJECTORY_HISTORY_DIR??path.join(service,'scripts/.bot-artifacts/trajectory-history'),learningRoot=process.env.TRAJECTORY_HISTORY_LEARNING_ROOT,collectorFile=process.env.TRAJECTORY_HISTORY_COLLECTOR_FILE,now,clock=Date.now,policy,capturePosteriors=process.env.TRAJECTORY_HISTORY_POSTERIORS==='1'}={}){
 const canonical=p=>{let q=path.resolve(p),tail=[];while(!fs.existsSync(q)){tail.unshift(path.basename(q));const parent=path.dirname(q);if(parent===q)throw Error('Invalid history path');q=parent;}return path.join(fs.realpathSync(q),...tail);};
 const target=canonical(directory),inputs=[canonical(learningRoot??path.join(service,'scripts/.learning-loop')),canonical(path.dirname(collectorFile??path.join(service,'scripts/.bot-artifacts/collector-witness-watch/witnesses.sqlite')))];
 if(inputs.some(p=>target===p||target.startsWith(p+path.sep)||p.startsWith(target+path.sep)))throw Error('History output must be separate from source evidence');
 return withStorageLock(directory,async()=>{let store,result;try{
  await rotateOutput(path.join(directory,'watcher.log'),{maxBytes:MiB,maxBackups:1});store=new HistoryStore(directory,{policy});result=await catchUpHistory({store,learningRoot,collectorFile,now,clock,capturePosteriors,onProgress:r=>atomicJson(path.join(directory,'status.json'),r)});
 }catch(error){result={checkedAt:new Date(now??clock()).toISOString(),ok:false,errorCode:error instanceof HistoryHold?'history_held':'capture_rejected',reason:String(error.message??error).slice(0,200),error:'Timing history could not be safely captured. Previously committed cursor and retained incident evidence were preserved.'};}
 finally{store?.close();}if(result.retention)await atomicJson(path.join(directory,'retention.json'),result.retention);await atomicJson(path.join(directory,'status.json'),result);return result;});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=await runOnce();process.exitCode=result.ok?0:1;}
