import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {THRESHOLDS,CARD_REPRICE_TOL_SEC} from '../canary-metrics.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
// Source-offer review candidates only. Every physical-call row and CDF is
// retained; telemetry changes are context, not an automatic exemption.
export function createDetector({state}={}){
state=state?structuredClone(state):undefined;
if(state){assert.equal(state.version,1);assert(Array.isArray(state.previous)&&Array.isArray(state.open));assert(state.previous.length<=4096&&state.open.length<=4096);}
const previous=new Map(state?.previous??[]),open=new Map(state?.open??[]),events=[],counts=state?.counts??{packets:0,frames:0,rows:0,groups:0,duplicatePhysicalCallGroups:0,minETATies:0,emptyWires:0,largeConsecutiveMoves:0,expiredExcursions:0,anchorChangedExcursions:0,missingGroupExcursions:0,completedRoundTrips:0,groupsWithMissingOrAmbiguousPhysicalIdentity:0};
function observe(f,payload,wire=payload.server_eta??null){
 counts.frames++;
   if(!wire){counts.emptyWires++;previous.clear();open.clear();return;}
   assert.equal(wire.at,f.at);assert.equal(wire.rows.length,wire.distributions.length);counts.rows+=wire.rows.length;
   const repeats=new Set((wire.repeatVisits??[]).map(r=>r.join('|'))),tableIdentity=sha(JSON.stringify([payload.model_params,payload.segments,payload.dwells])),groups=new Map();
   for(const [i,row]of wire.rows.entries()){
    const bus=wire.buses[row[0]];assert(bus);assert.equal(wire.distributions[i].length,50);
    const key=JSON.stringify([bus[1],bus[0],row[1]]),group=groups.get(key)??{key,label:bus[1],busName:bus[0],stop:row[1],anchor:wire.travel?.[row[0]]??bus[2],servedBus:bus,rows:[]};
    group.rows.push({row:row.slice(1),distribution:wire.distributions[i],explicitFollowing:repeats.has([row[0],row[1],row[5]].join('|'))});groups.set(key,group);
   }
   for(const [key,group]of groups){
    counts.groups++;if(group.rows.length>1)counts.duplicatePhysicalCallGroups++;
    const min=Math.min(...group.rows.map(r=>r.row[1])),best=group.rows.filter(r=>r.row[1]===min);if(best.length>1)counts.minETATies++;
    const buses=payload.buses.filter(b=>b.bus_name.replace(/^#/,'')===group.busName),physicalIdentity=buses.length===1&&Number.isFinite(buses[0].bus_id)?JSON.stringify([buses[0].route_id,buses[0].bus_id]):null;if(physicalIdentity===null)counts.groupsWithMissingOrAmbiguousPhysicalIdentity++;
    // Every physical-call row and its CDF remain attached. The monitored
    // quantity is the soonest OFFER at this stop, not a claimed same visit.
    const current={...group,seq:f.seq,at:f.at,absoluteArrivalSec:f.at/1000+min,minimumETASeconds:min,minimumETARows:best,rawBuses:buses,physicalIdentity,tableIdentity,originalBodySHA256:f.sha256,originalContextSHA256:f.contextSha256};
    const prev=previous.get(key),pending=open.get(key);let completed=false;
    if(pending){
     if(current.at-pending.before.at>THRESHOLDS.maxGapSec*1000){counts.expiredExcursions++;open.delete(key);}
     else if(current.anchor!==pending.before.anchor){counts.anchorChangedExcursions++;open.delete(key);}
     else if(current.at>pending.jump.at&&Math.abs(current.absoluteArrivalSec-pending.before.absoluteArrivalSec)<=CARD_REPRICE_TOL_SEC){
      const samePhysicalIdentity=current.physicalIdentity!==null&&current.physicalIdentity===pending.before.physicalIdentity&&current.physicalIdentity===pending.jump.physicalIdentity;
      events.push({event:'large-point-offer-roundtrip-with-held-anchor',key,label:group.label,busName:group.busName,stop:group.stop,before:pending.before,jump:pending.jump,returned:current,driftUpSec:pending.jump.absoluteArrivalSec-pending.before.absoluteArrivalSec,driftBackSec:current.absoluteArrivalSec-pending.jump.absoluteArrivalSec,spanSec:(current.at-pending.before.at)/1000,samePhysicalIdentity,calibrationTablesUnchanged:current.tableIdentity===pending.before.tableIdentity&&current.tableIdentity===pending.jump.tableIdentity,physicalVisitIdentity:'unknown; no physical-call matching or arrival outcome credit',requiresHumanReview:true,physicalETAErrorEstablished:false});counts.completedRoundTrips++;open.delete(key);completed=true;
     }
    }
    if(!completed&&prev&&current.at>prev.at&&current.at-prev.at<=THRESHOLDS.maxGapSec*1000&&current.anchor===prev.anchor&&Math.abs(current.absoluteArrivalSec-prev.absoluteArrivalSec)>=THRESHOLDS.catastrophicSec){
     counts.largeConsecutiveMoves++;if(!open.has(key))open.set(key,{before:prev,jump:current});
    }
    previous.set(key,current);
   }
   for(const key of previous.keys())if(!groups.has(key)){previous.delete(key);if(open.delete(key))counts.missingGroupExcursions++;}

}
return {observe,snapshot(){return structuredClone({version:1,previous:[...previous],open:[...open],counts});},notePacket(){counts.packets++;},events,counts,get unfinishedExcursions(){return open.size;}};
}
