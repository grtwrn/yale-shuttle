/** No finalized visits or legs enter these features. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {resolveOccurrence} from './occurrence.ts';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {planTracks,reconcileTracks} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits} from '../../services/shuttle-v2/src/collector/departure.ts';
const dir=new URL('.',import.meta.url).pathname, out=dir+'results/';
const input=dir+'../k-sweep/results/';
const read=(n:string)=>zlib.gunzipSync(fs.readFileSync(input+n+'.jsonl.gz')).toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
const top=JSON.parse(fs.readFileSync(out+'canonical-topology.json','utf8'));
const waits=JSON.parse(fs.readFileSync(out+'preparation.json','utf8')).waits;
const ks=[1,2,3,5,8,10,15];
const net=TransitNetwork.build(top.stops,top.routes), ids=new Set(top.routes.map((r:any)=>r.id));
const cutoff=Date.parse('2026-09-16T04:00:00Z');
const predictions=read('predictions_log').filter(p=>p.predicted_at>=cutoff).sort((a,b)=>a.predicted_at-b.predicted_at);
const names=new Set(predictions.map(p=>p.bus_name));
const raw=read('raw_positions').filter(r=>r.collected_at>=cutoff-3600000 && names.has(r.bus_name)).sort((a,b)=>a.collected_at-b.collected_at||a.bus_id-b.bus_id);
const dedup=new Map<string,any>();
for(const p of predictions){const key=[p.predicted_at,p.bus_name,p.route_id,p.to_stop_id].join('|');if(!dedup.has(key)||p.surface==='trip')dedup.set(key,p);}
const preds=[...dedup.values()].sort((a,b)=>a.predicted_at-b.predicted_at);
function replay(end=Infinity, delay=0){
 const states:any=new Map(),visits:any=new Map(), histories=new Map<string,Map<number,any>>(), warm=new Map<string,any>();
 const releasedOrigins=new Map<string,Map<string,number>>();
 let cursor=0,unknown=0;const rows:any[]=[];
 for(const p of preds){
  if(p.predicted_at>end)break;
  const asof=p.predicted_at-delay;
  while(cursor<raw.length&&raw[cursor].collected_at<=asof){
   const time=raw[cursor].collected_at,group:any[]=[];
   while(cursor<raw.length&&raw[cursor].collected_at===time)group.push(raw[cursor++]);
   const obs=group.map(r=>({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,heading:r.heading,lastStopId:r.last_stop_id??null,collectedAt:time}));
   const plan=planTracks(obs);
   for(const o of obs){
    const w=warm.get(o.busName);
    if(!w||time-w.last>60000||w.route!==o.routeId||plan.contendedNames.has(o.busName)){
     warm.set(o.busName,{first:time,last:time,route:o.routeId});histories.delete(o.busName);releasedOrigins.delete(o.busName);
     for(const[k,s]of states)if(s.busName===o.busName){states.delete(k);visits.delete(k);}
    }else w.last=time;
   }
   reconcileTracks(states,plan);reconcileTracks(visits,plan);
   const stepped=stepManyWithVisits(net,states,visits,obs.filter(o=>ids.has(o.routeId)),plan);
   for(const e of stepped.visits){
    if(e.kind!=='visit'||e.how==='gap'||e.outcome==='unresolved'||e.arrivedAt===null||e.departedAt===null)continue;
    const w=warm.get(e.busName);if(!w||e.departedAt<w.first)continue;
    let h=histories.get(e.busName);if(!h)histories.set(e.busName,h=new Map());
    h.set(e.stopIndex,{departed:e.departedAt,knownAt:time,route:e.routeId});
   }
   // Match production's one-way release per source occurrence. A GPS phase
   // return to hold cannot resurrect an old source after observed departure.
   for(const [name,s] of states){
    if(s.lastObservedAt!==time)continue;
    const v=visits.get(name),warmth=warm.get(name),h=histories.get(name);
    const phase=v?.pass?.arrivedAt!=null?'hold':v?.transit?'drive':null;
    const index=phase==='hold'?v.pass.stopIndex:v?.transit?.fromIndex??-1;
    const began=phase==='hold'?v.pass.arrivedAt:v?.transit?.departedAt??Infinity;
    const n=net.routes.get(s.routeId)?.stops.length??0;
    if(!phase||index<0||!h||!warmth||time-warmth.first<600000)continue;
    let latches=releasedOrigins.get(name);if(!latches)releasedOrigins.set(name,latches=new Map());
    for(const w of waits[s.routeId]??[])for(const k of ks){
     if(k>=n)continue;const source=(w-k+n)%n,origin=h.get(source),release=h.get(w);
     if(!origin||origin.departed>began||time-origin.departed>2700000)continue;
     if((release&&release.departed>origin.departed&&release.departed<=began&&release.knownAt<=time)
       ||(index-source+n)%n>k||(index===w&&phase==='drive'))latches.set(`${k}/${w}`,origin.departed);
    }
   }
  }
  const s=states.get(p.bus_name),v=visits.get(p.bus_name),w=warm.get(p.bus_name);
  const pass=v?.pass, phase=pass?.arrivedAt!=null?'hold':v?.transit?'drive':'unknown';
  const index=phase==='hold'?pass.stopIndex:phase==='drive'?v.transit.fromIndex:-1;
  const began=phase==='hold'?pass.arrivedAt:phase==='drive'?v.transit.departedAt:0;
  const ready=Boolean(s&&w&&s.routeId===p.route_id&&asof-s.lastObservedAt<=15000&&asof>=s.lastObservedAt&&w.last-w.first>=600000&&index>=0);
  const origins:any={};
  if(ready)for(const[i,e]of histories.get(p.bus_name)??[])if(e.route===p.route_id&&e.knownAt<=asof&&e.departed<=began&&p.predicted_at-e.departed<=2700000)origins[i]=e;
  if(!ready)unknown++;
  const occurrence=resolveOccurrence(top.routes.find((r:any)=>r.id===p.route_id).stops,p.to_stop_id,p.stops_ahead,index,s?.nearestIndex??-1,ready);
  rows.push({...occurrence,releasedOrigins:Object.fromEntries(releasedOrigins.get(p.bus_name)??[]),at:p.predicted_at,asof,bus:p.bus_name,route:p.route_id,target:p.to_stop_id,baseline:{eta:p.predicted_sec,low:p.predicted_low_sec,high:p.predicted_high_sec},stopsAhead:p.stops_ahead,from:p.from_stop_id,ready,index,nearest:s?.nearestIndex??-1,phase,began,observedAt:s?.lastObservedAt??0,origins});
 }
 return{rows,unknown};
}
const full=replay();const midpoint=preds[Math.floor(preds.length/2)].predicted_at;
const old=read('features'),oldByKey=new Map(old.map((r:any)=>[[r.at,r.bus,r.route,r.target].join('|'),r]));
const unchanged=new Set(top.routes.filter((r:any)=>!r.publishedStops&&new Set(r.stops).size===r.stops.length).map((r:any)=>r.id));
let parityRows=0;
for(const r of full.rows){if(!unchanged.has(r.route))continue;const previous=oldByKey.get([r.at,r.bus,r.route,r.target].join('|'))!;assert(previous);
 const keys=Object.keys(previous).filter(k=>k!=='releasedOrigins');assert.deepEqual(Object.fromEntries(keys.map(k=>[k,r[k]])),Object.fromEntries(keys.map(k=>[k,previous[k]])));parityRows++;}
assert(parityRows>1000,'Vacuous unique-route feature parity');
const prefix=replay(midpoint);assert.deepEqual(prefix.rows,full.rows.filter(r=>r.at<=midpoint));
for(const r of full.rows)for(const e of Object.values(r.origins) as any[])assert(e.knownAt<=r.asof&&e.departed<=r.asof);
const delayed=replay(Infinity,15000);
for(const[name,result]of [['features',full],['features-delay15',delayed]] as const){
 fs.writeFileSync(out+name+'.jsonl.gz',zlib.gzipSync(result.rows.map(r=>JSON.stringify(r)).join('\n')+'\n'));
}
const audit={uniqueRouteFeatureParityRows:parityRows,raw:raw.length,predictions:preds.length,features:full.rows.length,unknown:full.unknown,delayedUnknown:delayed.unknown,prefixInvariant:true,prefixRows:prefix.rows.length};
fs.writeFileSync(out+'replay-audit.json',JSON.stringify(audit,null,2));console.log(JSON.stringify(audit));
