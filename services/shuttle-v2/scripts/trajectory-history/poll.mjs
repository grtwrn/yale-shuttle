#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {atomicJson,withStorageLock} from '../retention/storage.mjs';import {rotateOutput} from '../retention/maintain.mjs';
import {witnessSHA} from '../../src/collector/witnessCodec.ts';
import {nativeRecords,ModelProjection} from './native.mjs';import {collectorSnapshot,CollectorProjection} from './collector.mjs';import {HistoryStore,HistoryHold} from './storage.mjs';
import {PosteriorCapture} from './posterior.mjs';
const service=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),MiB=1024*1024,read=p=>JSON.parse(fs.readFileSync(p));
const cycleId=v=>typeof v==='string'&&/^cycle-\d+$/.test(v),hash=v=>/^[a-f0-9]{64}$/.test(v??'');
const archiveSourceKey=witnessSHA(JSON.stringify(['native.mjs','collector.mjs','storage.mjs','poll.mjs','posterior.mjs','../collector-witness-watch/protocol.mjs','../../src/collector/witnessCodec.ts'].map(name=>[name,witnessSHA(fs.readFileSync(new URL(name,import.meta.url)))])));
function inputFiles(root,cycle,since){const directory=path.join(root,cycle);if(fs.lstatSync(directory).isSymbolicLink())throw Error('Invalid native cycle');return fs.readdirSync(directory).filter(n=>/^feed-\d{4}-\d\d-\d\d-\d\d-\d+\.jsonl\.gz$/.test(n)).filter(n=>Date.parse(n.slice(5,15)+'T'+n.slice(16,18)+':00:00Z')+3600000>=since).sort().map(n=>path.join(directory,n));}
async function verifyUnchanged(file,previous){
 const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.dev!==previous.dev||st.ino!==previous.ino||st.size!==previous.bytes)return false;
 const h=createHash('sha256');if(previous.bytes)for await(const b of fs.createReadStream(file,{start:0,end:previous.bytes-1}))h.update(b);if(h.digest('hex')!==previous.sha256)throw Error('Native input prefix changed');return true;
}

/** Local read-only inputs, independent output database. No API requests,
 * estimator execution, fitting, report writes, publication or process signals. */
export async function collectHistory({store,learningRoot=path.join(service,'scripts/.learning-loop'),collectorFile=path.join(service,'scripts/.bot-artifacts/collector-witness-watch/witnesses.sqlite'),now=Date.now(),capturePosteriors=false}={}){
 const before=store.state(),live=read(path.join(learningRoot,'state.json'));if(Object.keys(before).length&&before.version!==1)throw Error('Unsupported timing history state');if(live.forecastProtocol!=='served-control-v2'||!cycleId(live.id)||!hash(live.sourceKey))throw Error('Unsupported live native source');
 const nativeStatus=read(path.join(learningRoot,'status.json'));if(nativeStatus.cycle!==live.id||!nativeStatus.running||nativeStatus.error||now-Date.parse(nativeStatus.feedReceivedAt)>120000||Date.parse(nativeStatus.feedReceivedAt)>now+5000)throw Error('Native source is not fresh');
 const archiveChanged=before.archiveSourceKey&&before.archiveSourceKey!==archiveSourceKey;
 if(archiveChanged){before.model={...before.model,tracks:{}};before.collector={...before.collector,tracks:{}};before.posterior={};}
 const posterior=capturePosteriors?new PosteriorCapture(learningRoot,live,{now,prior:before.posterior??{}}):null;
 const snapshot=collectorSnapshot(collectorFile,{since:Math.max(now-2*3600000,Math.min(before.collector?.last?.at??now-2*3600000,now)-10000)});
 const models=new ModelProjection(before.model??{},snapshot.topologies,info=>posterior?.modelContext(info)),prefixes={},cycles=[...new Set([before.cycle,live.id].filter(cycleId))],files=[];
 for(const cycle of cycles){const frozen=read(path.join(learningRoot,cycle,'frozen-candidate.json'));if(frozen.id!==cycle||!hash(frozen.sourceKey))throw Error('Invalid frozen source identity');if(cycle===live.id&&witnessSHA(fs.readFileSync(path.join(learningRoot,cycle,'frozen-candidate.json')))!==live.frozenCandidateSha256)throw Error('Frozen native identity differs');
  for(const file of inputFiles(learningRoot,cycle,Math.max(now-2*3600000,(before.model?.last?.at??now-2*3600000)-3600000)))files.push({file,cycle,sourceKey:frozen.sourceKey,build:frozen.productionBuild,stat:fs.lstatSync(file)});
 }
 if(!files.length||files.length>8||files.reduce((s,x)=>s+x.stat.size,0)>512*MiB)throw new HistoryHold('Native history read bound exceeded');
 let inputLines=0,unchangedFiles=0;
 for(const spec of files){const prior=before.prefixes?.[spec.file];if(prior&&await verifyUnchanged(spec.file,prior)){prefixes[spec.file]=prior;unchangedFiles++;
   if(posterior?.matches(spec.cycle,spec.sourceKey))for await(const item of nativeRecords(spec.file,{previous:prior,captureBytes:spec.stat.size,expectedFile:spec.stat})){if(item.record)posterior.observe(item.record.source,{cycle:spec.cycle,sourceKey:spec.sourceKey});}
   continue;}
  for await(const item of nativeRecords(spec.file,{previous:prior,captureBytes:spec.stat.size,expectedFile:spec.stat})){if(item.prefix){prefixes[spec.file]=item.prefix;continue;}inputLines++;const p=item.record.source;if(p?.build&&p.build!==spec.build)throw Error('Native input build differs from frozen source');posterior?.observe(p,{cycle:spec.cycle,sourceKey:spec.sourceKey});models.consume(p,{cycle:spec.cycle,sourceKey:spec.sourceKey,receivedAt:item.record.receivedAt,rawSHA256:item.rawSHA256});}
 }
 const phase=posterior?.finish(models.state)??{records:[],state:before.posterior??{},status:{enabled:false,ok:true,state:'disabled',capturedModels:0}};
 const pending={...before.pendingSources};for(const r of [...models.records,...phase.records])if(['model-projection','posterior-projection'].includes(r.kind)&&r.collector?.status==='recorded'){const key=r.collector.epoch+':'+r.collector.seq,old=pending[key],value={at:r.at,sha256:r.collector.sha256,topologySha256:r.collector.topologySha256};if(old&&(old.sha256!==value.sha256||old.topologySha256!==value.topologySha256))throw Error('Conflicting named collector source');pending[key]??=value;}
 if(Object.keys(pending).length>1024)throw new HistoryHold('Pending model/source association bound exceeded');
 const sources=new CollectorProjection(before.collector??{},new Set(Object.keys(pending)));sources.consume(snapshot);
 for(const r of sources.records)if(r.kind==='collector-projection'){const key=r.epoch+':'+r.header.seq,expected=pending[key];if(expected&&(expected.sha256!==r.header.sha256||expected.topologySha256!==r.header.topologySha256))throw Error('Named collector commitment differs');delete pending[key];}
 const expired=[];for(const[key,value]of Object.entries(pending))if(now-value.at>2*3600000){expired.push({kind:'model-source-unavailable',at:value.at,reference:key,sha256:value.sha256,reason:'Original collector frame was not retained within the two-hour association window.'});delete pending[key];}
 const records=[...models.records,...sources.records,...phase.records,...expired,...(archiveChanged?[{kind:'history-boundary',at:now,reason:'projection-code-changed',previousArchiveSourceKey:before.archiveSourceKey,archiveSourceKey}]:[])].sort((a,b)=>a.at-b.at);
 const latestModel=models.state.last?.at??null,latestCollector=sources.state.last?.at,idle=models.state.idleService===true,unavailable=models.state.forecastUnavailable===true,latestNative=idle?models.state.idleReceipt?.receivedAt:unavailable?models.state.forecastUnavailableReceipt?.receivedAt:latestModel;if(!Number.isSafeInteger(latestNative)||!Number.isSafeInteger(latestCollector)||now-latestNative>120000||now-latestCollector>120000||latestNative>now+5000||latestCollector>now+5000){const e=Error('Timing history source did not advance to a fresh frame');e.captureDiagnostics={now,latestModel,latestNative,latestCollector,model:models.counts,collector:sources.counts};throw e;}
 const next={version:1,archiveSourceKey,cycle:live.id,model:models.state,collector:sources.state,posterior:phase.state,prefixes,pendingSources:pending,checkedAt:now};
 const retention=store.commit({records,state:next,topologies:snapshot.topologies,now});
 return{checkedAt:new Date(now).toISOString(),ok:true,cycle:live.id,archiveSourceKey,runtime:process.versions.node,modelAt:latestModel,collectorAt:latestCollector,posteriorCapture:phase.status,idleService:idle,...(idle?{idleReceipt:models.state.idleReceipt}:{}),forecastUnavailable:unavailable,...(unavailable?{forecastUnavailableReceipt:models.state.forecastUnavailableReceipt}:{}),inputLines,unchangedFiles,model:models.counts,collector:sources.counts,pendingSourceAssociations:Object.keys(pending).length,unavailableSourceAssociations:expired.length,readOnlySnapshotTransactionMs:snapshot.transactionMs,retention,scope:'Verified compact projections of original local forecasts and collector records; minute samples plus observed transitions/source writes. Optional posterior samples retain exact original inputs and already-computed champion state projections. Fresh empty or forecast-unavailable GPS receipts are distinct from model frames and physical service truth. Gaps remain unknown. Not full reducer/forecast replay, physical boarding truth, independent ETA accuracy or promotion qualification.'};
}

export async function runOnce({directory=process.env.TRAJECTORY_HISTORY_DIR??path.join(service,'scripts/.bot-artifacts/trajectory-history'),learningRoot=process.env.TRAJECTORY_HISTORY_LEARNING_ROOT,collectorFile=process.env.TRAJECTORY_HISTORY_COLLECTOR_FILE,now=Date.now(),policy,capturePosteriors=process.env.TRAJECTORY_HISTORY_POSTERIORS==='1'}={}){
 const canonical=p=>{let q=path.resolve(p),tail=[];while(!fs.existsSync(q)){tail.unshift(path.basename(q));const parent=path.dirname(q);if(parent===q)throw Error('Invalid history path');q=parent;}return path.join(fs.realpathSync(q),...tail);};
 const target=canonical(directory),inputs=[canonical(learningRoot??path.join(service,'scripts/.learning-loop')),canonical(path.dirname(collectorFile??path.join(service,'scripts/.bot-artifacts/collector-witness-watch/witnesses.sqlite')))];
 if(inputs.some(p=>target===p||target.startsWith(p+path.sep)||p.startsWith(target+path.sep)))throw Error('History output must be separate from source evidence');
 return withStorageLock(directory,async()=>{let store,result;try{
  await rotateOutput(path.join(directory,'watcher.log'),{maxBytes:MiB,maxBackups:1});store=new HistoryStore(directory,{policy});result=await collectHistory({store,learningRoot,collectorFile,now,capturePosteriors});
 }catch(error){result={checkedAt:new Date(now).toISOString(),ok:false,errorCode:error instanceof HistoryHold?'history_held':'capture_rejected',error:'Timing history could not be safely captured. Previously committed cursor and retained incident evidence were preserved.'};}
 finally{store?.close();}if(result.retention)await atomicJson(path.join(directory,'retention.json'),result.retention);await atomicJson(path.join(directory,'status.json'),result);return result;});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=await runOnce();process.exitCode=result.ok?0:1;}
