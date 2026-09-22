/** Exact canonical replay computation, with independent read-only observers. */
import {resolveOccurrence} from '../canonical-windows/occurrence.ts';
import {planTracks,reconcileTracks} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits} from '../../services/shuttle-v2/src/collector/departure.ts';
import {Observer,KS} from './observer.ts';
export function replay(net:any, top:any, waits:any, raw:any[], preds:any[], delay=0){
 const ids=new Set(top.routes.map((r:any)=>r.id)), ks=KS;
 const observer=new Observer(new Map(top.routes.map((r:any)=>[r.id,r])),waits), diagnostics:any[]=[];
 const states:any=new Map(),visits:any=new Map(), histories=new Map<string,Map<number,any>>(), warm=new Map<string,any>();
 const releasedOrigins=new Map<string,Map<string,number>>();
 let cursor=0,unknown=0;const rows:any[]=[];
 for(const p of preds){
  const asof=p.predicted_at-delay;
  while(cursor<raw.length&&raw[cursor].collected_at<=asof){
   const time=raw[cursor].collected_at,group:any[]=[];
   while(cursor<raw.length&&raw[cursor].collected_at===time)group.push(raw[cursor++]);
   const obs=group.map(r=>({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,heading:r.heading,lastStopId:r.last_stop_id??null,collectedAt:time}));
   const plan=planTracks(obs);
   observer.observePoll(obs,plan,time); const trackBefore=observer.tracks(states);
   for(const o of obs){
    const w=warm.get(o.busName);
    if(!w||time-w.last>60000||w.route!==o.routeId||plan.contendedNames.has(o.busName)){
     observer.beforeReset(o,time,w,plan,histories.get(o.busName),states,visits);
     warm.set(o.busName,{first:time,last:time,route:o.routeId});histories.delete(o.busName);releasedOrigins.delete(o.busName);
     for(const[k,s]of states)if(s.busName===o.busName){states.delete(k);visits.delete(k);}
    }else w.last=time;
   }
   reconcileTracks(states,plan);reconcileTracks(visits,plan);
   const stepped=stepManyWithVisits(net,states,visits,obs.filter(o=>ids.has(o.routeId)),plan);
   observer.afterTracks(trackBefore,states,time);
   for(const e of stepped.visits){
    observer.emission(e,time,warm.get(e.busName));
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
  const row={...occurrence,releasedOrigins:Object.fromEntries(releasedOrigins.get(p.bus_name)??[]),at:p.predicted_at,asof,bus:p.bus_name,route:p.route_id,target:p.to_stop_id,baseline:{eta:p.predicted_sec,low:p.predicted_low_sec,high:p.predicted_high_sec},stopsAhead:p.stops_ahead,from:p.from_stop_id,ready,index,nearest:s?.nearestIndex??-1,phase,began,observedAt:s?.lastObservedAt??0,origins};
  diagnostics.push(observer.snapshot(row,s,v,w,histories.get(p.bus_name)));
  rows.push(row);
 }
 return{rows,unknown,diagnostics,observer,rawConsumed:cursor};
}
