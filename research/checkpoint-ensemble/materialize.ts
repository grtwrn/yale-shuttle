/** Hosted only. Actual emission knowledge, no finalized source insertion. */
import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {Readable} from 'node:stream';import {pipeline} from 'node:stream/promises';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {planTracks,reconcileTracks} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits} from '../../services/shuttle-v2/src/collector/departure.ts';
import {resolveOccurrence} from '../canonical-windows/occurrence.ts';
import {Families,membership,SIZES} from './membership.ts';
import {replay as legacyReplay} from '../source-retention/replay.ts';
import {ProgressLedger} from './progress.ts';
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

function replay(raw:any[],preds:any[]){
 const states:any=new Map(),visits:any=new Map(),histories=new Map<string,Map<number,any>>(),warm=new Map<string,any>(),latches=new Map<string,Map<string,number>>();
 const ledger=new Families(routes,waits),progress=new ProgressLedger(routes),progressTimes=new Map<string,number>();
 ledger.onReset=(name,at,epoch)=>{progress.reset(name,at,epoch);progressTimes.set(name,at);};
 const rows:any[]=[];let cursor=0,didBoundaryReset=false;
 const observe=(key:string,s:any)=>{
  // A renamed/inactive retained legacy state may predate an explicit observer
  // reset. It is no observation in the new epoch, not evidence to retimestamp.
  if(s.lastObservedAt<(progressTimes.get(s.busName)??-Infinity))return;
  const v=visits.get(key),pass=v?.pass??null,index=pass?.stopIndex??v?.transit?.fromIndex??-1;
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
  const families=ledger.snapshot(p.bus_name),ensemble:any={},n=routes.get(row.route).stops.length;
  const ws:number[]=waits[row.route]??[];
  const d=(w:number)=>((row.targetIndex??-1)-w+n)%n||n;
  const wait=row.targetIndex==null||!ws.length?null:ws.reduce((a,b)=>d(b)<d(a)?b:a);
  const groupLength=wait==null?0:Math.min(...ws.filter(w=>w!==wait).map(w=>(w-wait+n)%n),n-1);
  const targets=wait==null?[]:Array.from({length:groupLength},(_,i)=>(wait+i+1)%n);
  for(const k of SIZES)for(const extension of [false,true]){
   const id=`K${k}_${extension?'extended':'primary'}`;
   ensemble[id]=wait==null||!targets.includes(row.targetIndex as number)?{supported:false,reason:'no fixed downstream wait/target group'}:
    {...membership(row,families,wait,k,n,extension),targetGroup:targets};
  }
  rows.push({...row,families,ensemble});
 }
 return{rows,ledger,progress,consumed:cursor};
}
const expected=read(canon+'features.jsonl.gz');
function validateLegacy(){
 const pp=preds.filter(p=>p.predicted_at>=cutoff),names=new Set(pp.map(p=>p.bus_name));
 const pr=raw.filter(r=>r.collected_at>=lead&&names.has(r.bus_name));
 const control=legacyReplay(net,top,waits,pr,pp,45);assert.deepEqual(control.rows,expected);return control.rows.length;
}
const exactOriginalFeatures=validateLegacy(),full=replay(raw,preds);
const experimentalChanges=full.rows.filter(r=>r.at>=cutoff).reduce((n,{families,ensemble,...row},i)=>n+Number(JSON.stringify(row)!==JSON.stringify(expected[i])),0);
const checks:any[]=[];
for(const fraction of [.25,.5,.75]){
 const end=expected[Math.floor(expected.length*fraction)].at;
 const pr=raw.filter(r=>r.collected_at<=end),pp=preds.filter(p=>p.predicted_at<=end),prefix=replay(pr,pp);
 assert.deepEqual(prefix.rows,full.rows.filter(r=>r.at<=end));
 assert.deepEqual(prefix.ledger.events,full.ledger.events.filter(e=>e.knownAt<=end));
 checks.push({end,rows:prefix.rows.length,raw:pr.length,exact:true});
}
for(const[p,h]of Object.entries(pins))assert.equal(sha(p),h);
const audit={planSha256:sha(here+'PLAN.md'),pins,exactOriginalFeatures,experimentalFullPollFeatureDifferences:experimentalChanges,
 allSampledFeatures:full.rows.length,consumed:full.consumed,
 strictPhysicalSources:full.ledger.events.length,prefixChecks:checks,eofClosures:0,providerInterpretation:'Observed IDs only, not proven physical vehicle identity'};
const sourceMap=new Map(full.ledger.events.map(e=>[e.id,e]));assert.equal(sourceMap.size,full.ledger.events.length);
const availability:any={};
for(const row of full.rows.filter(r=>r.at>=Date.parse('2026-09-17T04:00:00Z'))){
 const route=availability[row.route]??={generated:0,arms:{}};route.generated++;
 for(const [arm,m]of Object.entries(row.ensemble) as any){
  const a=route.arms[arm]??={reasons:{},masks:{},journeys:new Set(),dates:new Set()};
  a.reasons[m.reason]=(a.reasons[m.reason]??0)+1;
  if(m.supported){const mask=m.offsets.join(',');a.masks[mask]=(a.masks[mask]??0)+1;a.journeys.add(m.journey);a.dates.add(new Date(row.at-4*3600000).toISOString().slice(0,10));}
 }
}
for(const route of Object.values(availability) as any)for(const a of Object.values(route.arms) as any){a.journeys=a.journeys.size;a.dates=[...a.dates].sort();}
function* compact(){for(const {families,...row}of full.rows){
 const ensemble:any={};for(const [name,m]of Object.entries(row.ensemble) as any){
  const {sources,...rest}=m;if(!sources){ensemble[name]=rest;continue;}
  const sourceIds:any={};for(const[offset,e]of Object.entries(sources) as any){assert.deepEqual(sourceMap.get(e.id),e);sourceIds[offset]=e.id;}
  ensemble[name]={...rest,sourceIds};
 }yield{...row,ensemble};
}}
async function save(){
 await write('physical-sources',full.ledger.events);await write('features',compact());
 await write('traversal-history',(function*(){for(const r of full.rows)yield{at:r.at,bus:r.bus,route:r.route,target:r.target,families:r.families};})());
 await write('source-rejections',full.ledger.rejected);await write('source-resets',full.ledger.resets);
 await write('observed-occurrences',full.progress.records);await write('occurrence-resets',full.progress.resets);await write('occurrence-rejections',full.progress.rejections);
 const occurrenceProofs:any={};for(const e of full.ledger.events){const reason=e.occurrenceProof.supported?'supported':e.occurrenceProof.reason;occurrenceProofs[reason]=(occurrenceProofs[reason]??0)+1;}
 fs.writeFileSync(out+'materialization-audit.json',JSON.stringify({...audit,schemaVersion:2,sourceReferenceRoundtrip:true,availability,occurrenceProofs},null,2)+'\n');console.log(JSON.stringify({...audit,occurrenceProofs}));
}
save().catch(e=>{console.error(e);process.exitCode=1;});
