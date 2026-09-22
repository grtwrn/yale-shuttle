/** Hosted only. Actual emission knowledge, no finalized source insertion. */
import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import readline from 'node:readline';
import {once} from 'node:events';
import {classify,foldMaps,project,date,FROZEN,MAX_BANK} from './folds.ts';
import {Readable} from 'node:stream';import {pipeline} from 'node:stream/promises';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {planTracks,reconcileTracks} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits} from '../../services/shuttle-v2/src/collector/departure.ts';
import {resolveOccurrence} from '../canonical-windows/occurrence.ts';
import {Families} from '../checkpoint-ensemble/membership.ts';
import {ProgressLedger} from '../checkpoint-ensemble/progress.ts';
const here=new URL('.',import.meta.url).pathname,out=here+'results/';
const rawDir=here+'../k-sweep/results/',canon=here+'../canonical-windows/results/';
const read=(p:string)=>zlib.gunzipSync(fs.readFileSync(p)).toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
const write=async(name:string,rows:Iterable<any>)=>pipeline(Readable.from((function*(){for(const row of rows)yield JSON.stringify(row)+'\n';})()),zlib.createGzip(),fs.createWriteStream(out+name+'.jsonl.gz'));
const sha=(p:string)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const pins:any={
 [rawDir+'raw_positions.jsonl.gz']:'3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9',
 [rawDir+'predictions_log.jsonl.gz']:'5bcc9927337564067af7eabc6c667ff44eeb7c3cba05619cc57cb0a3cf5b12de',
 [canon+'canonical-topology.json']:'eb753d58c4ace616e844b3a54842978c4ec46833373560e1b236d7b5d61b40bc',
 [canon+'preparation.json']:'2edd09127b7d41357ef6ecb6bf461f75c4f0b59c33d37ad2dd11cff24269df0d',
 [canon+'features.jsonl.gz']:'b2268eb15fc913a5c5cbf039d2dfbb8d518eefe25e6149776f7a930bd2eb5bb3',
 [canon+'training-visits.jsonl.gz']:'a3aa7065e7e82e018f2d0671b5a3044df766d033b7098462e4f257115d880fd5',
};
fs.mkdirSync(out,{recursive:true});for(const[p,h]of Object.entries(pins))assert.equal(sha(p),h,p);
const top=JSON.parse(fs.readFileSync(canon+'canonical-topology.json','utf8'));
const waits=JSON.parse(fs.readFileSync(canon+'preparation.json','utf8')).waits;
const net=TransitNetwork.build(top.stops,top.routes),routes=new Map<number,any>(top.routes.map((r:any)=>[r.id,r]));
for(const r of top.routes)assert.deepEqual(net.routes.get(r.id)!.stops,r.stops);
const cutoff=Date.parse('2026-09-16T04:00:00Z'),lead=cutoff-3600000,ks=[1,2,3,5,8,10,15];
const predictions=read(rawDir+'predictions_log.jsonl.gz').sort((a,b)=>a.predicted_at-b.predicted_at);
const raw=read(rawDir+'raw_positions.jsonl.gz').sort((a,b)=>a.collected_at-b.collected_at||a.bus_id-b.bus_id);
const dedup=new Map<string,any>();for(const p of predictions){const key=[p.predicted_at,p.bus_name,p.route_id,p.to_stop_id].join('|');if(!dedup.has(key)||p.surface==='trip')dedup.set(key,p);}
const preds=[...dedup.values()].sort((a,b)=>a.predicted_at-b.predicted_at);
const training=read(canon+'training-visits.jsonl.gz');
const reference=here+'reference/';
async function* stream(path:string){const input=fs.createReadStream(path).pipe(zlib.createGunzip());for await(const line of readline.createInterface({input,crlfDelay:Infinity}))if(line.trim())yield JSON.parse(line);}
const hashRows=(rows:any[])=>{const h=crypto.createHash('sha256');for(const r of rows)h.update(JSON.stringify(r)+'\n');return h.digest('hex');};
const evidence=(ledger:any,progress:any)=>Object.fromEntries([
 ['sources',ledger.events],['sourceResets',ledger.resets],['sourceRejections',ledger.rejected],
 ['pins',progress.records],['occurrenceResets',progress.resets],['occurrenceRejections',progress.rejections]
].map(([name,rows]:any)=>[name,{rows:rows.length,sha256:hashRows(rows)}]));

async function replay(raw:any[],preds:any[],maps:any,emit:(row:any,ledger:any,progress:any)=>Promise<void>){
 const states:any=new Map(),visits:any=new Map(),histories=new Map<string,Map<number,any>>(),warm=new Map<string,any>(),latches=new Map<string,Map<string,number>>();
 const ledger=new Families(routes,Object.fromEntries([...routes].map(([id,r])=>[id,r.stops.map((_:any,i:number)=>i)]))),progress=new ProgressLedger(routes),progressTimes=new Map<string,number>(),observedSignatures=new Map<string,string>();
 ledger.onReset=(name,at,epoch)=>{progress.reset(name,at,epoch);progressTimes.set(name,at);};
 let rowCount=0,cursor=0,didBoundaryReset=false,maxFamilies=0;
 const observe=(key:string,s:any)=>{
  // A renamed/inactive retained legacy state may predate an explicit observer
  // reset. It is no observation in the new epoch, not evidence to retimestamp.
  if(s.lastObservedAt<(progressTimes.get(s.busName)??-Infinity))return;
  const v=visits.get(key),pass=v?.pass??null,index=pass?.stopIndex??v?.transit?.fromIndex??-1;
  const observerKey=JSON.stringify([s.busName,s.busId]),signature=JSON.stringify([ledger.epochs.get(s.busName),s.routeId,s.lastObservedAt,index,
   pass?.anchoredAt,pass?.pinnedAt,pass?.arrivedAt,pass?.closestAt,pass?.anchorBusId]);
  if(observedSignatures.get(observerKey)===signature)return;
  observedSignatures.set(observerKey,signature);
  progress.observe(s.busName,s.routeId,s.busId,index,pass?'pass':v?.transit?'drive':'unknown',s.lastObservedAt,pass);
  progressTimes.set(s.busName,s.lastObservedAt);
 };
 for(const p of preds){
  const asof=p.predicted_at;
  while(cursor<raw.length&&raw[cursor].collected_at<=asof){
   const time=raw[cursor].collected_at,group:any[]=[];
   while(cursor<raw.length&&raw[cursor].collected_at===time)group.push(raw[cursor++]);
   // Inspect retained active pins at their actual old observation time before
   // this poll can reset/reconcile/close them; never stamp stale state as fresh.
   for(const [key,s]of states)observe(key,s);
   if(time>=lead&&!didBoundaryReset){
    // Preserve the exact original evaluation replay boundary. Earlier rows exist
    // only for prequential calibration; no earlier history seeds evaluation.
    for(const name of warm.keys())ledger.reset(name,time,'original evaluation lead-in boundary');
    states.clear();visits.clear();histories.clear();warm.clear();latches.clear();didBoundaryReset=true;
   }
   const obs=group.map(r=>({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,heading:r.heading,lastStopId:r.last_stop_id??null,collectedAt:time}));
   const plan=planTracks(obs);
   const providerNames=new Map<number,Set<string>>();
   for(const o of obs){let ns=providerNames.get(o.busId);if(!ns)providerNames.set(o.busId,ns=new Set());ns.add(o.busName);}
   for(const ns of providerNames.values())if(ns.size>1)for(const name of ns)ledger.reset(name,time,'simultaneous provider-name ambiguity');
   for(const o of obs){
    ledger.identity(o.busName,o.busId,time);const w=warm.get(o.busName);
    if(!w||time-w.last>60000||w.route!==o.routeId||plan.contendedNames.has(o.busName)){
     ledger.reset(o.busName,time,!w?'initial/unknown warm epoch':time-w.last>60000?'gap above60s':w.route!==o.routeId?'route change':'name contention');
     warm.set(o.busName,{first:time,last:time,route:o.routeId});histories.delete(o.busName);latches.delete(o.busName);
     for(const[k,s]of states)if(s.busName===o.busName){states.delete(k);visits.delete(k);}
    }else w.last=time;
   }
   reconcileTracks(states,plan);reconcileTracks(visits,plan);
   const stepped=stepManyWithVisits(net,states,visits,obs.filter(o=>routes.has(o.routeId)),plan);
   for(const [key,s]of states)if(s.lastObservedAt===time)observe(key,s);
   for(const e of stepped.visits){
    if(e.kind!=='visit')continue;
    const w=warm.get(e.busName),accepted=Boolean(e.how!=='gap'&&e.outcome!=='unresolved'&&e.arrivedAt!==null&&e.departedAt!==null&&w&&e.departedAt>=w.first);
    if(accepted){let h=histories.get(e.busName);if(!h)histories.set(e.busName,h=new Map());h.set(e.stopIndex,{departed:e.departedAt,knownAt:time,route:e.routeId});}
    ledger.emission(e,time,accepted,progress.proof(e,time));
   }
   for(const[name,s]of states){
    if(s.lastObservedAt!==time)continue;const v=visits.get(name),w=warm.get(name),h=histories.get(name);
    const phase=v?.pass?.arrivedAt!=null?'hold':v?.transit?'drive':null;
    const index=phase==='hold'?v.pass.stopIndex:v?.transit?.fromIndex??-1;
    const began=phase==='hold'?v.pass.arrivedAt:v?.transit?.departedAt??Infinity;
    const n=routes.get(s.routeId)?.stops.length??0;
    if(phase&&index>=0)ledger.state(s.busName,index,phase,time);
    if(!phase||index<0||!h||!w||time-w.first<600000)continue;
    let ls=latches.get(name);if(!ls)latches.set(name,ls=new Map());
    for(const wait of waits[s.routeId]??[])for(const k of ks){
     if(k>=n)continue;const source=(wait-k+n)%n,origin=h.get(source),release=h.get(wait);
     if(!origin||origin.departed>began||time-origin.departed>2700000)continue;
     if((release&&release.departed>origin.departed&&release.departed<=began&&release.knownAt<=time)||(index-source+n)%n>k||(index===wait&&phase==='drive'))ls.set(`${k}/${wait}`,origin.departed);
    }
   }
  }
  const s=states.get(p.bus_name),v=visits.get(p.bus_name),w=warm.get(p.bus_name),pass=v?.pass;
  const phase=pass?.arrivedAt!=null?'hold':v?.transit?'drive':'unknown';
  const index=phase==='hold'?pass.stopIndex:phase==='drive'?v.transit.fromIndex:-1;
  const began=phase==='hold'?pass.arrivedAt:phase==='drive'?v.transit.departedAt:0;
  const ready=Boolean(s&&w&&s.routeId===p.route_id&&asof-s.lastObservedAt<=15000&&asof>=s.lastObservedAt&&w.last-w.first>=600000&&index>=0);
  const origins:any={};if(ready)for(const[i,e]of histories.get(p.bus_name)??[])if(e.route===p.route_id&&e.knownAt<=asof&&e.departed<=began&&p.predicted_at-e.departed<=2700000)origins[i]=e;
  const occurrence=resolveOccurrence(routes.get(p.route_id).stops,p.to_stop_id,p.stops_ahead,index,s?.nearestIndex??-1,ready);
  const row={...occurrence,releasedOrigins:Object.fromEntries(latches.get(p.bus_name)??[]),at:p.predicted_at,asof,bus:p.bus_name,route:p.route_id,target:p.to_stop_id,
   baseline:{eta:p.predicted_sec,low:p.predicted_low_sec,high:p.predicted_high_sec},stopsAhead:p.stops_ahead,from:p.from_stop_id,ready,index,nearest:s?.nearestIndex??-1,phase,began,observedAt:s?.lastObservedAt??0,origins};
  const families=ledger.snapshot(p.bus_name);maxFamilies=Math.max(maxFamilies,families.length);
  const original=project(row,families,routes,waits),fold=maps[date(asof)];
  const selected=fold?project(row,families,routes,fold.waits):null;
  if(selected)for(const m of Object.values(selected) as any[])if(m.supported){
   assert(fold.cutoff<asof);
   for(const id of Object.values(m.sourceIds) as string[]){
    const f=families.find(f=>f.id===m.journey),event=Object.values(f.sources).find((e:any)=>e.id===id) as any;
    assert(event.departed>fold.cutoff&&event.knownAt>fold.cutoff&&event.knownAt<=asof&&asof-event.departed<=2700000);
   }
  }
  await emit({...row,ensemble:original,fold:selected?{date:date(asof),cutoff:fold.cutoff,ensemble:selected}:null},ledger,progress);rowCount++;

 }
 return{rowCount,ledger,progress,consumed:cursor,maxFamilies};
}

async function main(){
 const metadata=JSON.parse(fs.readFileSync(reference+'artifact-metadata.json','utf8'));
 assert.equal(metadata.id,10699234338);assert.equal(metadata.digest,'sha256:b60c4c89e1656322ad999bf76d6089e0b70ef524a962630d581e5de42b9016f8');
 const referenceAudit=JSON.parse(fs.readFileSync(reference+'materialization-audit.json','utf8'));
 assert.equal(referenceAudit.allSampledFeatures,133435);assert.equal(referenceAudit.experimentalFullPollFeatureDifferences,0);
 const inputHashes=Object.fromEntries(['features.jsonl.gz','physical-sources.jsonl.gz','materialization-audit.json'].map(p=>[p,sha(reference+p)]));
 const prep=JSON.parse(fs.readFileSync(canon+'preparation.json','utf8')),control=classify(routes,training,FROZEN);
 assert.deepEqual(control.waits,prep.waits);assert.deepEqual(control.waitStats,prep.waitStats);assert.equal(control.admittedVisits,prep.admittedVisits);
 const maps=foldMaps(routes,training,preds),cutoffs=[...new Set(Object.values(maps).map((f:any)=>f.cutoff))].sort((a:any,b:any)=>a-b) as number[];
 const foldChecks=[];
 for(const end of [cutoffs[0],cutoffs.at(-1)!]){
  assert.deepEqual(classify(routes,training,end),classify(routes,training.filter(v=>v.known_at<end),end));
  foldChecks.push({cutoff:end,physicallyDeletedFutureVisits:true,exact:true});
 }
 fs.writeFileSync(out+'folds.json',JSON.stringify({maps,fixedEvaluation:control,foldChecks},null,2)+'\n');
 const evalPreds=preds.filter(p=>p.predicted_at>=FROZEN);
 const ends=[...new Set([.25,.5,.75].map(f=>evalPreds[Math.floor(evalPreds.length*f)].predicted_at)
  .concat([cutoffs[0],cutoffs.at(-1)!].map(c=>preds.filter(p=>p.predicted_at<c).at(-1)?.predicted_at).filter((v):v is number=>v!==undefined)))].sort((a,b)=>a-b);
 const endCounts=new Map(ends.map(end=>[end,preds.filter(p=>p.predicted_at<=end).length]));
 const references:any={},rollingHash=crypto.createHash('sha256');let count=0,compared=0;
 const old=stream(reference+'features.jsonl.gz')[Symbol.asyncIterator]();
 const gzip=zlib.createGzip(),file=fs.createWriteStream(out+'fold-membership.jsonl.gz'),done=pipeline(gzip,file);
 const full=await replay(raw,preds,maps,async(r,ledger,progress)=>{
  const {fold,...original}=r,expected=await old.next();assert(!expected.done);assert.deepEqual(original,expected.value);compared++;
  const compact={at:r.at,bus:r.bus,route:r.route,target:r.target,targetIndex:r.targetIndex,ready:r.ready,
   fixed:r.ensemble,fold};
  const line=JSON.stringify(compact)+'\n';rollingHash.update(line);count++;
  if(!gzip.write(line))await once(gzip,'drain');
  // A timestamp can contain multiple forecast keys. Capture only after its
  // final row; all tied rows remain in the stream and prefix hash.
  if(count===endCounts.get(r.at))references[r.at]={rows:count,sha256:rollingHash.copy().digest('hex'),evidence:evidence(ledger,progress)};
 });
 gzip.end();await done;assert((await old.next()).done);assert.equal(compared,133435);
 const expectedSources=read(reference+'physical-sources.jsonl.gz');assert.deepEqual(full.ledger.events,expectedSources);
 const prefixChecks=[];
 for(const end of ends){
  const pr=raw.filter(r=>r.collected_at<=end),pp=preds.filter(p=>p.predicted_at<=end),pv=training.filter(v=>v.known_at<=end);
  const pm=foldMaps(routes,pv,pp),h=crypto.createHash('sha256');let rows=0;
  const prefix=await replay(pr,pp,pm,async(r)=>{
   const compact={at:r.at,bus:r.bus,route:r.route,target:r.target,targetIndex:r.targetIndex,ready:r.ready,fixed:r.ensemble,fold:r.fold};
   h.update(JSON.stringify(compact)+'\n');rows++;
  });
  assert.deepEqual({rows,sha256:h.digest('hex'),evidence:evidence(prefix.ledger,prefix.progress)},references[end]);
  prefixChecks.push({end,rows,raw:pr.length,exact:true,rebuiltFoldMaps:true,physicallyDeletedFutureInputs:true});
 }
 await write('physical-sources',full.ledger.events);
 await write('source-resets',full.ledger.resets);await write('source-rejections',full.ledger.rejected);
 await write('occurrence-resets',full.progress.resets);await write('occurrence-rejections',full.progress.rejections);
 for(const [p,h]of Object.entries(pins))assert.equal(sha(p),h);
 assert.deepEqual(Object.fromEntries(Object.keys(inputHashes).map(p=>[p,sha(reference+p)])),inputHashes);
 const audit={stage:'A only; no fits, target outcomes or scores',planSha256:sha(here+'PLAN.md'),pins,referenceArtifact:metadata,inputHashes,
  sourceRows:full.ledger.events.length,exactFixedMapMembershipRows:compared,exactPhysicalSources:true,sourceReferenceHash:hashRows(full.ledger.events),
  foldDates:Object.keys(maps),foldChecks,prefixChecks,consumedRaw:full.consumed,maxContemporaneousFamiliesForOneBus:full.maxFamilies,
  outputRows:full.rowCount,eofClosures:0,universalFamilySnapshotsSerialized:0,providerInterpretation:'Observed IDs only, not proven physical vehicle identity'};
 fs.writeFileSync(out+'materialization-audit.json',JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify(audit));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
