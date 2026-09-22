/** Hosted causal Brown features; no labels, finalized visits or scores read. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {resolveOccurrence} from '../canonical-windows/occurrence.ts';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {planTracks,reconcileTracks} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits} from '../../services/shuttle-v2/src/collector/departure.ts';
import {HORIZONS,FRESHNESS,variant,fresh,originEligible,resetReason,updateRelease,type Origin,type Warm} from './policy.ts';
const base='research/brown-clocks/', input=base+'input/canonical/canonical-windows/results/', out=base+'results/';
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
function replay(horizon:number, predictions=originals, observations=raw){
 const states:any=new Map(),visits:any=new Map(),histories=new Map<string,Map<number,Origin>>(),warm=new Map<string,Warm>();
 const released=new Map<string,Map<string,number>>(),resets:any[]=[];
 let cursor=0;const rows:any[]=[];
 for(const p of predictions){
  const asof=p.asof;
  while(cursor<observations.length&&observations[cursor].collected_at<=asof){
   const time=observations[cursor].collected_at,group:any[]=[];
   while(cursor<observations.length&&observations[cursor].collected_at===time)group.push(observations[cursor++]);
   const obs=group.map(r=>({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,
    heading:r.heading,lastStopId:r.last_stop_id??null,collectedAt:time}));
   const plan=planTracks(obs);
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
 return {rows,resets};
}
fs.mkdirSync(out,{recursive:true});
const results=HORIZONS.map(h=>replay(h));
const rows=results[0].rows.map((r,i)=>({...r,variants:{...r.variants,...results[1].rows[i].variants}}));
const mismatches:any[]=[];
for(let i=0;i<rows.length;i++){
 const control=rows[i].variants.h45_f15,original=originals[i];
 for(const k of Object.keys(control))if(JSON.stringify(control[k])!==JSON.stringify(original[k]))
  mismatches.push({at:original.at,bus:original.bus,target:original.target,field:k,old:original[k],next:control[k]});
 // Brown's unique stop identity must be invariant to relaxed feature freshness.
 for(const f of Object.values(rows[i].variants) as any[])for(const k of ['targetIndex','anchorIndex','occurrenceReason'])
  assert.deepEqual(f[k],original[k],`Occurrence changed: ${k}`);
}
fs.writeFileSync(out+'control-discrepancies.json',JSON.stringify(mismatches,null,2));
fs.writeFileSync(out+'identity-resets.json',JSON.stringify(results[0].resets,null,2));
assert.equal(mismatches.length,0,'Guarded original feature control differs: HALT before fitting/scoring');
const cutoffs=new Set<number>([originals[Math.floor(originals.length/2)].at,originals.at(-1).at-30000]);
for(const r of rows){
 const f=r.variants.h90_f45;
 if(f.ready&&f.asof-f.observedAt>15000){cutoffs.add(r.at);break;}
}
for(const r of rows){const f=r.variants.h90_f15;
 if(Object.values(f.origins).some((o:any)=>r.at-o.departed>2700000)){cutoffs.add(r.at);break;}}
for(const end of cutoffs)for(let i=0;i<HORIZONS.length;i++){
 const prefix=replay(HORIZONS[i],originals.filter(p=>p.at<=end),raw.filter(r=>r.collected_at<=end));
 assert.deepEqual(prefix.rows,results[i].rows.filter(r=>r.at<=end));
}
fs.writeFileSync(out+'clock-features.jsonl.gz',zlib.gzipSync(rows.map(r=>JSON.stringify(r)).join('\n')+'\n'));
fs.writeFileSync(out+'replay-audit.json',JSON.stringify({rows:rows.length,originalFeatureParity:true,
 prefixDeletionCutoffs:[...cutoffs],prefixChecks:cutoffs.size*2,resets:results[0].resets.length,
 rawRows:raw.length,latestForecast:originals.at(-1).at,policies:rows[0]&&Object.keys(rows[0].variants)},null,2));
console.log(JSON.stringify({rows:rows.length,originalFeatureParity:true,prefixChecks:cutoffs.size*2}));
