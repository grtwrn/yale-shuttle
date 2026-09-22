/** Hosted causal Brown features; no labels, finalized visits or scores read. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {DirectedGuard} from './guard.ts';
import {resolveOccurrence} from '../canonical-windows/occurrence.ts';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {planTracks,reconcileTracks} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits} from '../../services/shuttle-v2/src/collector/departure.ts';
import {HORIZONS,FRESHNESS,variant,fresh,originEligible,resetReason,updateRelease,type Origin,type Warm} from '../brown-clocks/policy.ts';
const base='research/brown-directed/', input=base+'input/canonical/canonical-windows/results/', out=base+'results/';
const read=(p:string)=>zlib.gunzipSync(fs.readFileSync(p)).toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
const top=JSON.parse(fs.readFileSync(input+'canonical-topology.json','utf8'));
const waits=JSON.parse(fs.readFileSync(input+'preparation.json','utf8')).waits;
const route=top.routes.find((r:any)=>r.id===19);assert.equal(route.name,'Brown');assert.deepEqual(waits[19],[0,5]);
const net=TransitNetwork.build(top.stops,top.routes), ids=new Set(top.routes.map((r:any)=>r.id));
const cutoff=Date.parse('2026-09-16T04:00:00Z');
const originals=read(input+'features.jsonl.gz').sort((a,b)=>a.at-b.at);
const scoredStart=Date.parse('2026-09-17T04:00:00Z');
assert(originals.every(r=>r.at<Date.parse('2026-09-21T04:00:00Z')&&!('label'in r)));
const names=new Set(originals.map(p=>p.bus));
const raw=read('research/k-sweep/results/raw_positions.jsonl.gz')
 .filter(r=>r.collected_at>=cutoff-3600000&&names.has(r.bus_name)).sort((a,b)=>a.collected_at-b.collected_at||a.bus_id-b.bus_id);
function replay(protectedArm:boolean, predictions=originals, observations=raw){
 const horizon=2700000,guard=new DirectedGuard(net),network=protectedArm?guard.network:net;
 const sourceEvents:any[]=[],decisions:any[]=[];
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
    const w=warm.get(o.busName),reason=o.routeId===19?resetReason(w,o,plan.contendedNames.has(o.busName))
     :(!w?'initial':time-w.last>60000?'raw gap':w.route!==o.routeId?'route change':plan.contendedNames.has(o.busName)?'contended name':null);
    if(reason){
     warm.set(o.busName,{first:time,last:time,route:o.routeId,provider:o.busId});histories.delete(o.busName);released.delete(o.busName);
     for(const[k,s]of states)if(s.busName===o.busName){states.delete(k);visits.delete(k);}
     resets.push({at:time,bus:o.busName,reason,previous:w??null,route:o.routeId,provider:o.busId});
    }else w!.last=time;
   }
   reconcileTracks(states,plan);reconcileTracks(visits,plan);
   if(protectedArm)for(const o of obs)if(o.routeId===19){
    const d=guard.prepare(plan.keys.get(o.busId)!,states.get(plan.keys.get(o.busId)!),o,plan.contendedNames.has(o.busName));
    if(d.protected)decisions.push(d);
   }
   const stepped=stepManyWithVisits(network,states,visits,obs.filter(o=>ids.has(o.routeId)),plan);
   for(const e of stepped.visits){
    if(e.kind!=='visit'||e.how==='gap'||e.outcome==='unresolved'||e.arrivedAt===null||e.departedAt===null
     ||(e.routeId===19&&plan.contendedNames.has(e.busName)))continue;
    const w=warm.get(e.busName);
    if(!w||e.departedAt<w.first||(e.routeId===19&&(e.routeId!==w.route||e.departedAt>time)))continue;
    if(e.routeId===19)sourceEvents.push({bus:e.busName,provider:e.busId,route:e.routeId,index:e.stopIndex,departure:e.departedAt,knownAt:time});
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
  for(const freshness of [15000]){
   const ready=Boolean(s&&w&&s.routeId===p.route&&(p.route!==19||s.busId===w.provider)
    &&fresh(asof,s.lastObservedAt,freshness)&&w.last-w.first>=600000&&index>=0);
   const origins:any={};
   if(ready)for(const[i,e]of histories.get(p.bus)??[])
    if(originEligible(e,p.route,asof,began,p.at,horizon))origins[i]=e;
   const occurrence=resolveOccurrence(top.routes.find((r:any)=>r.id===p.route).stops,p.target,p.stopsAhead,index,s?.nearestIndex??-1,ready);
   variants[variant(horizon,freshness)]={...occurrence,releasedOrigins:Object.fromEntries(released.get(p.bus)??[]),
    at:p.at,asof,bus:p.bus,route:p.route,target:p.target,baseline:p.baseline,stopsAhead:p.stopsAhead,from:p.from,
    ready,index,nearest:s?.nearestIndex??-1,phase,began,observedAt:s?.lastObservedAt??0,origins};
  }
  rows.push({at:p.at,bus:p.bus,route:p.route,target:p.target,variants});
 }
 return {rows:rows.map(r=>r.variants.h45_f15),resets,sourceEvents,decisions};
}
fs.mkdirSync(out,{recursive:true});
const physical=JSON.parse(fs.readFileSync(out+'parity-summary.json','utf8'));
assert.equal(physical.Brown.discrepancyKeys,0);assert.equal(physical.nonBrownEventIdentity,true);
function write(name:string,rows:any[]){fs.writeFileSync(out+name+'.jsonl.gz',zlib.gzipSync(rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':'')));}
const baseline=replay(false),candidate=replay(true),control:any[]=[],differences:any[]=[];
assert.equal(baseline.rows.length,originals.length);assert.equal(candidate.rows.length,originals.length);
for(let i=0;i<originals.length;i++){
 const old=originals[i],a=baseline.rows[i],b=candidate.rows[i];
 // Original lead controls start Sep17. Non-Brown controls include every row.
 if(old.route!==19||old.at>=scoredStart)for(const key of Object.keys(a))
  if(JSON.stringify(a[key])!==JSON.stringify(old[key]))control.push({at:old.at,bus:old.bus,route:old.route,target:old.target,key,old:old[key],next:a[key]});
 if(old.route!==19)assert.deepEqual(b,a,'Non-Brown feature changed');
 else {
  const fields=Object.keys(a).filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]));
  if(fields.length)differences.push({at:old.at,bus:old.bus,route:old.route,target:old.target,fields,baseline:a,candidate:b});
 }
}
write('feature-control-discrepancies',control);write('feature-differences',differences);
write('baseline-source-events',baseline.sourceEvents);write('candidate-source-events',candidate.sourceEvents);
write('baseline-features',baseline.rows);write('candidate-features',candidate.rows);
write('feature-guard-decisions',candidate.decisions);
assert.equal(control.length,0,'Original feature control discrepancy: HALT before fitting/scoring');
assert.equal(baseline.sourceEvents.length,candidate.sourceEvents.length,'Physical source count changed');
for(let i=0;i<baseline.sourceEvents.length;i++)assert.deepEqual(candidate.sourceEvents[i],baseline.sourceEvents[i],`Physical source departure/knownAt changed at ${i}`);
const prefixes=[];
for(const end of [Date.parse('2026-09-17T04:00:00Z'),Date.parse('2026-09-19T04:00:00Z'),
 Date.parse('2026-09-18T10:14:45-04:00'),Date.parse('2026-09-18T10:17:15-04:00')]){
 const ps=originals.filter(p=>p.at<end),rs=raw.filter(r=>r.collected_at<end),prefix=replay(true,ps,rs);
 const expected=candidate.rows.filter(r=>r.at<end);assert.equal(prefix.rows.length,expected.length);
 for(let i=0;i<expected.length;i++)assert.deepEqual(prefix.rows[i],expected[i],`Feature prefix ${end} row ${i}`);
 const last=ps.at(-1)!.asof,sourceExpected=candidate.sourceEvents.filter(r=>r.knownAt<=last);
 assert.equal(prefix.sourceEvents.length,sourceExpected.length);
 for(let i=0;i<sourceExpected.length;i++)assert.deepEqual(prefix.sourceEvents[i],sourceExpected[i],`Source prefix ${end} row ${i}`);
 prefixes.push({end,rows:expected.length,sources:sourceExpected.length,deletedRaw:raw.length-rs.length});
}
const result={originalLeadAndNonBrownFeatureParity:true,nonBrownRows:originals.filter(r=>r.route!==19).length,
 BrownScoredControlRows:originals.filter(r=>r.route===19&&r.at>=scoredStart).length,
 sourceDepartureKnownAtParity:true,sourceEvents:baseline.sourceEvents.length,
 BrownChangedRows:differences.length,featurePrefixes:prefixes,modelsFitted:0,scoresProduced:false};
fs.writeFileSync(out+'feature-parity.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
