/** Causal sidecar extracted from the pinned development replay, never wire state. */
import {createHash} from 'node:crypto';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {planTracks,reconcileTracks} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits} from '../../services/shuttle-v2/src/collector/departure.ts';
import {DirectedGuard} from '../brown-directed/guard.ts';
import {fresh,originEligible,resetReason,updateRelease,type Origin,type Warm} from '../brown-clocks/policy.ts';
import {resolveOccurrence} from '../canonical-windows/occurrence.ts';
import type {Feature,Forecast} from './model.ts';

export interface RawPosition {collected_at:number;bus_id:number;bus_name:string;route_id:number;lat:number;lon:number;heading:number;last_stop_id?:number|null}
export interface ClockSnapshot {
  asof:number;bus:string;route:number;provider:number|null;ready:boolean;index:number;nearest:number;
  phase:string;began:number;observedAt:number;origins:Feature['origins'];releasedOrigins:Feature['releasedOrigins'];
  prefixComplete:boolean;prefixSha256:string;variant:'original'|'directed';
}
export class CausalClock {
  private states:any=new Map();private visits:any=new Map();
  private histories=new Map<string,Map<number,Origin>>();private warm=new Map<string,Warm>();
  private released=new Map<string,Map<string,number>>();private cursor=0;private asof=-Infinity;
  private digest=createHash('sha256');private guard:DirectedGuard;private network:TransitNetwork;
  private routes:Map<number,any>;private ids:Set<number>;
  readonly sourceEvents:any[]=[];readonly resets:any[]=[];
  constructor(private topology:any,private waits:Record<string,number[]>,private raw:RawPosition[],
    readonly variant:'original'|'directed',private prefixComplete:boolean) {
    const net=TransitNetwork.build(topology.stops,topology.routes);
    this.guard=new DirectedGuard(net);this.network=variant==='directed'?this.guard.network:net;
    this.routes=new Map(topology.routes.map((r:any)=>[r.id,r]));this.ids=new Set(this.routes.keys());
    for(let i=1;i<raw.length;i++)if(raw[i]!.collected_at<raw[i-1]!.collected_at)throw Error('Raw observations are not chronological');
  }
  advance(asof:number) {
    if(!Number.isFinite(asof)||asof<this.asof)throw Error('Cannot rewind a causal clock; use a sealed older snapshot');
    while(this.cursor<this.raw.length&&this.raw[this.cursor]!.collected_at<=asof) {
      const time=this.raw[this.cursor]!.collected_at,group:RawPosition[]=[];
      while(this.cursor<this.raw.length&&this.raw[this.cursor]!.collected_at===time)group.push(this.raw[this.cursor++]!);
      this.digest.update(JSON.stringify(group)+'\n');
      const obs=group.map(r=>({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,
        heading:r.heading,lastStopId:r.last_stop_id??null,collectedAt:time}));
      const plan=planTracks(obs);
      for(const o of obs) {
        const w=this.warm.get(o.busName),reason=o.routeId===19?resetReason(w,o,plan.contendedNames.has(o.busName))
          :(!w?'initial':time-w.last>60000?'raw gap':w.route!==o.routeId?'route change':plan.contendedNames.has(o.busName)?'contended name':null);
        if(reason) {
          this.warm.set(o.busName,{first:time,last:time,route:o.routeId,provider:o.busId});
          this.histories.delete(o.busName);this.released.delete(o.busName);
          for(const[k,s]of this.states)if(s.busName===o.busName){this.states.delete(k);this.visits.delete(k);}
          this.resets.push({at:time,bus:o.busName,reason,previous:w??null,route:o.routeId,provider:o.busId});
        }else w!.last=time;
      }
      reconcileTracks(this.states,plan);reconcileTracks(this.visits,plan);
      if(this.variant==='directed')for(const o of obs)if(o.routeId===19)
        this.guard.prepare(plan.keys.get(o.busId)!,this.states.get(plan.keys.get(o.busId)!),o,plan.contendedNames.has(o.busName));
      const stepped=stepManyWithVisits(this.network,this.states,this.visits,obs.filter(o=>this.ids.has(o.routeId)),plan);
      for(const e of stepped.visits) {
        if(e.kind!=='visit'||e.how==='gap'||e.outcome==='unresolved'||e.arrivedAt===null||e.departedAt===null
          ||(e.routeId===19&&plan.contendedNames.has(e.busName)))continue;
        const w=this.warm.get(e.busName);
        if(!w||e.departedAt<w.first||(e.routeId===19&&(e.routeId!==w.route||e.departedAt>time)))continue;
        if(e.routeId===19)this.sourceEvents.push({bus:e.busName,provider:e.busId,route:e.routeId,index:e.stopIndex,departure:e.departedAt,knownAt:time});
        let h=this.histories.get(e.busName);if(!h)this.histories.set(e.busName,h=new Map());
        h.set(e.stopIndex,{departed:e.departedAt,knownAt:time,route:e.routeId});
      }
      for(const[name,s]of this.states) {
        if(s.lastObservedAt!==time)continue;
        const v=this.visits.get(name),w=this.warm.get(name),h=this.histories.get(name);
        const phase=v?.pass?.arrivedAt!=null?'hold':v?.transit?'drive':null;
        const index=phase==='hold'?v.pass.stopIndex:v?.transit?.fromIndex??-1;
        const began=phase==='hold'?v.pass.arrivedAt:v?.transit?.departedAt??Infinity;
        const n=this.network.routes.get(s.routeId)?.stops.length??0;
        if(!phase||index<0||!h||!w||time-w.first<600000)continue;
        let l=this.released.get(name);if(!l)this.released.set(name,l=new Map());
        for(const wait of this.waits[s.routeId]??[])for(const k of [1,2,3,5,8,10,15])if(k<n)
          updateRelease(l,h,s.routeId,index,phase,began,time,2700000,k,wait,n);
      }
    }
    this.asof=asof;
  }
  snapshot(bus:string,route:number):ClockSnapshot {
    if(!Number.isFinite(this.asof))throw Error('Advance to a server ETA clock before reading features');
    const s=this.states.get(bus),v=this.visits.get(bus),w=this.warm.get(bus),pass=v?.pass;
    const phase=pass?.arrivedAt!=null?'hold':v?.transit?'drive':'unknown';
    const index=phase==='hold'?pass.stopIndex:phase==='drive'?v.transit.fromIndex:-1;
    const began=phase==='hold'?pass.arrivedAt:phase==='drive'?v.transit.departedAt:0;
    const ready=Boolean(this.prefixComplete&&s&&w&&s.routeId===route&&(route!==19||s.busId===w.provider)
      &&fresh(this.asof,s.lastObservedAt,15000)&&w.last-w.first>=600000&&index>=0);
    const origins:Feature['origins']={};
    if(ready)for(const[i,e]of this.histories.get(bus)??[])
      if(originEligible(e,route,this.asof,began,this.asof,2700000))origins[i]={...e};
    return {asof:this.asof,bus,route,provider:s?.busId??null,ready,index,nearest:s?.nearestIndex??-1,phase,began,
      observedAt:s?.lastObservedAt??0,origins,releasedOrigins:Object.fromEntries(this.released.get(bus)??[]),
      prefixComplete:this.prefixComplete,prefixSha256:this.digest.copy().digest('hex'),variant:this.variant};
  }
  feature(p:{at:number;asof:number;bus:string;route:number;target:number;stopsAhead:number;baseline:Forecast;from?:number}):Feature {
    if(p.at!==p.asof)throw Error('This complete-response adapter prices at server_eta.at only');
    this.advance(p.asof);return featureForRow(this.snapshot(p.bus,p.route),p,this.routes.get(p.route)?.stops??[]);
  }
}
export function featureForRow(s:ClockSnapshot,p:{at:number;asof:number;bus:string;route:number;target:number;stopsAhead:number;baseline:Forecast;from?:number},seq:readonly number[]):Feature {
  if(s.asof!==p.asof||p.at!==p.asof||s.bus!==p.bus||s.route!==p.route)throw Error('Clock snapshot does not match row identity/asof');
  const occurrence=resolveOccurrence(seq,p.target,p.stopsAhead,s.index,s.nearest,s.ready);
  return {...occurrence,releasedOrigins:s.releasedOrigins,at:p.at,asof:p.asof,bus:p.bus,route:p.route,target:p.target,
    baseline:p.baseline,stopsAhead:p.stopsAhead,...('from'in p?{from:p.from}:{}),ready:s.ready,index:s.index,nearest:s.nearest,
    phase:s.phase,began:s.began,observedAt:s.observedAt,origins:s.origins};
}
