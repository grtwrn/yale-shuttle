/** Hosted causal Brown features; no labels, finalized visits or scores read. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {distanceMeters} from '../../services/shuttle-v2/src/network/geo.ts';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {resolveOccurrence} from '../canonical-windows/occurrence.ts';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {planTracks,reconcileTracks,ANCHOR_LOOKAHEAD,ANCHOR_SLACK_M} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits} from '../../services/shuttle-v2/src/collector/departure.ts';
import {HORIZONS,FRESHNESS,variant,fresh,originEligible,resetReason,updateRelease,type Origin,type Warm} from '../brown-clocks/policy.ts';
const base='research/brown-source-lap/', input=base+'input/canonical/canonical-windows/results/', out=base+'results/';
const read=(p:string)=>zlib.gunzipSync(fs.readFileSync(p)).toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
const top=JSON.parse(fs.readFileSync(input+'canonical-topology.json','utf8'));
const waits=JSON.parse(fs.readFileSync(input+'preparation.json','utf8')).waits;
const route=top.routes.find((r:any)=>r.id===19);assert.equal(route.name,'Brown');assert.deepEqual(waits[19],[0,5]);
const net=TransitNetwork.build(top.stops,top.routes), ids=new Set(top.routes.map((r:any)=>r.id));
const cutoff=Date.parse('2026-09-16T04:00:00Z');
const originals=read(input+'unscored.jsonl.gz').filter(r=>r.route===19).sort((a,b)=>a.at-b.at);
assert(originals.every(r=>r.at<Date.parse('2026-09-21T04:00:00Z')&&!('label'in r)));
const names=new Set(originals.map(p=>p.bus));
const raw=read('research/k-sweep/results/raw_positions.jsonl.gz')
 .filter(r=>r.collected_at>=cutoff-3600000&&names.has(r.bus_name)).sort((a,b)=>a.collected_at-b.collected_at||a.bus_id-b.bus_id);
const cases=[
 {id:'primary-304-return',bus:'#304',source:6,wait:5,start:Date.parse('2026-09-18T09:32:00-04:00'),end:Date.parse('2026-09-18T10:31:00-04:00')},
 {id:'126-confirmed-union',bus:'#126',source:6,wait:5,start:Date.parse('2026-09-17T07:42:00-04:00'),end:Date.parse('2026-09-17T08:32:00-04:00')},
 {id:'126-science-wait',bus:'#126',source:1,wait:0,start:Date.parse('2026-09-17T11:00:00-04:00'),end:Date.parse('2026-09-17T12:02:00-04:00')},
];
const hash=(p:string)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const protectedFiles=['clock-features.jsonl.gz','unscored.jsonl.gz','forecasts.jsonl.gz','summary.json','audit.json','handoff-audit.json','action-audit.json'];
const hashes=Object.fromEntries(protectedFiles.map(p=>[p,hash(base+'input/clock/'+p)]));
const rawHash=hash('research/k-sweep/results/raw_positions.jsonl.gz');
assert.equal(rawHash,JSON.parse(fs.readFileSync(base+'input/clock/audit.json','utf8')).rawHashes['research/k-sweep/results/raw_positions.jsonl.gz']);
function replay(horizon:number, predictions=originals, observations=raw){
 const states:any=new Map(),visits:any=new Map(),histories=new Map<string,Map<number,Origin>>(),warm=new Map<string,Warm>();
 const released=new Map<string,Map<string,number>>(),resets:any[]=[];
 let cursor=0;const rows:any[]=[],trace:any[]=[];
 for(const p of predictions){
  const asof=p.asof;
  while(cursor<observations.length&&observations[cursor].collected_at<=asof){
   const time=observations[cursor].collected_at,group:any[]=[];
   while(cursor<observations.length&&observations[cursor].collected_at===time)group.push(observations[cursor++]);
   const obs=group.map(r=>({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,
    heading:r.heading,lastStopId:r.last_stop_id??null,collectedAt:time}));
   const plan=planTracks(obs);
   const beforeStates=Object.fromEntries(obs.map(o=>[o.busName,JSON.parse(JSON.stringify(states.get(o.busName)??null))]));
   for(const o of obs){
    const w=warm.get(o.busName), reason=resetReason(w,o,plan.contendedNames.has(o.busName));
    if(reason){
     warm.set(o.busName,{first:time,last:time,route:o.routeId,provider:o.busId});histories.delete(o.busName);released.delete(o.busName);
     for(const[k,s]of states)if(s.busName===o.busName){states.delete(k);visits.delete(k);}
     resets.push({at:time,bus:o.busName,reason,previous:w??null,route:o.routeId,provider:o.busId});
    }else w!.last=time;
   }
   reconcileTracks(states,plan);reconcileTracks(visits,plan);
   const stepped=stepManyWithVisits(net,states,visits,obs.filter(o=>ids.has(o.routeId)),plan);
   for(const e of stepped.visits){
    if(e.kind!=='visit'||e.how==='gap'||e.outcome==='unresolved'||e.arrivedAt===null||e.departedAt===null
     ||plan.contendedNames.has(e.busName))continue;
    const w=warm.get(e.busName);
    if(!w||e.departedAt<w.first||e.routeId!==w.route||e.departedAt>time)continue;
    let h=histories.get(e.busName);if(!h)histories.set(e.busName,h=new Map());
    h.set(e.stopIndex,{departed:e.departedAt,knownAt:time,route:e.routeId});
   }
   for(const[name,s]of states){
    if(s.lastObservedAt!==time)continue;
    const v=visits.get(name),w=warm.get(name),h=histories.get(name);
    const phase=v?.pass?.arrivedAt!=null?'hold':v?.transit?'drive':null;
    const index=phase==='hold'?v.pass.stopIndex:v?.transit?.fromIndex??-1;
    const began=phase==='hold'?v.pass.arrivedAt:v?.transit?.departedAt??Infinity;
    const n=net.routes.get(s.routeId)?.stops.length??0;
    if(!phase||index<0||!h||!w||time-w.first<600000)continue;
    let l= released.get(name);if(!l)released.set(name,l=new Map());
    for(const wait of waits[s.routeId]??[])for(const k of [1,2,3,5,8,10,15])if(k<n)
     updateRelease(l,h,s.routeId,index,phase,began,time,horizon,k,wait,n);
   }
   for(const c of cases)if(c.start<=time&&time<=c.end){
    const os=obs.filter(o=>o.busName===c.bus);if(!os.length)continue;
    const state=states.get(c.bus),visit=visits.get(c.bus);
    const phase=visit?.pass?.arrivedAt!=null?'hold':visit?.transit?'drive':'unknown';
    const index=phase==='hold'?visit.pass.stopIndex:phase==='drive'?visit.transit.fromIndex:-1;
    const history=Object.fromEntries(histories.get(c.bus)??[]);
    trace.push(JSON.parse(JSON.stringify({case:c.id,horizonSec:horizon/1000,at:time,observations:os,
     beforeState:beforeStates[c.bus],
     state:state??null,visit:visit??null,phase,index,warm:warm.get(c.bus)??null,
     origins:history,releaseLatches:Object.fromEntries(released.get(c.bus)??[]),
     detectorEvents:stepped.events.filter(e=>e.busName===c.bus),visitEvents:stepped.visits.filter(e=>e.busName===c.bus),
     resolved:stepped.resolved.filter(e=>e.busName===c.bus),
     contended:plan.contendedNames.has(c.bus),distances:os.map(o=>route.stops.map((sid:number,i:number)=>({index:i,stop:sid,metres:distanceMeters(o,net.stops.get(sid)!)}))),
     global:os.map(o=>net.nearestStopOnRoute(o.routeId,o)),
     aheadFromPrevious:os.map(o=>beforeStates[c.bus]?net.nearestStopAheadOnRoute(o.routeId,o,beforeStates[c.bus].nearestIndex,ANCHOR_LOOKAHEAD):null),
     anchorSlackM:ANCHOR_SLACK_M})));
   }
  }
  const s=states.get(p.bus),v=visits.get(p.bus),w=warm.get(p.bus);
  const pass=v?.pass,phase=pass?.arrivedAt!=null?'hold':v?.transit?'drive':'unknown';
  const index=phase==='hold'?pass.stopIndex:phase==='drive'?v.transit.fromIndex:-1;
  const began=phase==='hold'?pass.arrivedAt:phase==='drive'?v.transit.departedAt:0;
  const variants:any={};
  for(const freshness of FRESHNESS){
   const ready=Boolean(s&&w&&s.routeId===p.route&&s.busId===w.provider
    &&fresh(asof,s.lastObservedAt,freshness)&&w.last-w.first>=600000&&index>=0);
   const origins:any={};
   if(ready)for(const[i,e]of histories.get(p.bus)??[])
    if(originEligible(e,p.route,asof,began,p.at,horizon))origins[i]=e;
   const occurrence=resolveOccurrence(route.stops,p.target,p.stopsAhead,index,s?.nearestIndex??-1,ready);
   variants[variant(horizon,freshness)]={...occurrence,releasedOrigins:Object.fromEntries(released.get(p.bus)??[]),
    at:p.at,asof,bus:p.bus,route:p.route,target:p.target,baseline:p.baseline,stopsAhead:p.stopsAhead,from:p.from,
    ready,index,nearest:s?.nearestIndex??-1,phase,began,observedAt:s?.lastObservedAt??0,origins};
  }
  rows.push({at:p.at,bus:p.bus,route:p.route,target:p.target,variants});
 }
 return {rows,resets,trace};
}
fs.mkdirSync(out,{recursive:true});
const results=HORIZONS.map(h=>replay(h));
const rows=results[0].rows.map((r,i)=>({...r,variants:{...r.variants,...results[1].rows[i].variants}}));
const previous=read(base+'input/clock/clock-features.jsonl.gz');
assert.deepEqual(rows,previous,'Diagnostic instrumentation changed prior clock features');
const cutoffs=['2026-09-18T09:34:15-04:00','2026-09-18T10:14:45-04:00','2026-09-18T10:17:15-04:00','2026-09-18T10:30:15-04:00'].map(Date.parse);
for(const end of cutoffs)for(let i=0;i<HORIZONS.length;i++){
 const prefix=replay(HORIZONS[i],originals.filter(p=>p.at<=end),raw.filter(r=>r.collected_at<=end));
 assert.deepEqual(prefix.rows,results[i].rows.filter(r=>r.at<=end));
 // The last logged prediction, rather than a later absent tick, is the replay frontier.
 const frontier=prefix.rows.at(-1)!.at;
 assert.deepEqual(prefix.trace,results[i].trace.filter(r=>r.at<=frontier));
}
const trace=results.flatMap(r=>r.trace).sort((a,b)=>a.at-b.at||a.horizonSec-b.horizonSec);
fs.writeFileSync(out+'trace.jsonl.gz',zlib.gzipSync(trace.map(r=>JSON.stringify(r)).join('\n')+'\n'));
fs.copyFileSync(input+'canonical-topology.json',out+'canonical-topology.json');
fs.writeFileSync(out+'cases.json',JSON.stringify(cases,null,2));
for(const [p,value]of Object.entries(hashes))assert.equal(hash(base+'input/clock/'+p),value);
assert.equal(hash('research/k-sweep/results/raw_positions.jsonl.gz'),rawHash);
const audit={priorFeatureRows:rows.length,priorFeatureIdentity:true,protectedPriorHashes:hashes,rawHash,
 protectedBytesUnchanged:true,prefixDeletionCutoffs:cutoffs,prefixChecks:cutoffs.length*2,
 traceRows:trace.length,caseCounts:Object.fromEntries(cases.map(c=>[c.id,trace.filter(r=>r.case===c.id).length])),
 note:'Causal source-occurrence trace only; no fits, scores, model/guard change or new dates.'};
fs.writeFileSync(out+'audit.json',JSON.stringify(audit,null,2));console.log(JSON.stringify(audit));
