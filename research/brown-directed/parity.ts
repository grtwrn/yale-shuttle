import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import {createHash} from 'node:crypto';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {distanceMeters} from '../../services/shuttle-v2/src/network/geo.ts';
import {planTracks,reconcileTracks,type BusObservation,type BusState} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits,type VisitState} from '../../services/shuttle-v2/src/collector/departure.ts';
import {visitRowsOf} from '../../services/shuttle-v2/src/collector/visitRows.ts';
import {DirectedGuard} from './guard.ts';

const out='research/brown-directed/results/';
const frozen='research/brown-directed/input/canonical/canonical-windows/results/';
fs.mkdirSync(out,{recursive:true});
const topology=JSON.parse(fs.readFileSync(frozen+'canonical-topology.json','utf8'));
const network=TransitNetwork.build(topology.stops,topology.routes);
const windows:any[]=[];
const hash=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(hash('research/brown-directed/guard.ts'),'472c2e7a5babebcb3e2d31736aa4d3ddb013d11bb73ebd157d3daf65719719f6');
async function read(path:string) {
  const result:any[]=[];
  for await(const line of readline.createInterface({input:fs.createReadStream(path).pipe(zlib.createGunzip())}))
    if(line.trim())result.push(JSON.parse(line));
  return result;
}
const raw=(await read('research/k-sweep/results/raw_positions.jsonl.gz')).map((r):BusObservation=>({
  busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,
  heading:Number.isFinite(r.heading)?r.heading:0,lastStopId:Number.isFinite(r.last_stop_id)?r.last_stop_id:null,collectedAt:r.collected_at
})).sort((a,b)=>a.collectedAt-b.collectedAt||a.busId-b.busId);
assert(raw.at(-1)!.collectedAt<Date.parse('2026-09-21T04:00:00Z'),'Unexpected September21 input');
const frozenRows=await read(frozen+'training-visits.jsonl.gz');
function emit(name:string,rows:any[]){fs.writeFileSync(out+name+'.jsonl.gz',zlib.gzipSync(rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':'')));}
function signature(r:any){return Object.fromEntries(Object.entries(r).filter(([k])=>k!=='id'&&!k.startsWith('replay_')));}
function visitKey(r:any){return [r.bus_name,r.route_id,r.stop_index,r.anchored_at].join('|');}
function replay(observations:BusObservation[],protectedArm:boolean,diagnostic=true) {
  const states=new Map<string,BusState>(),visits=new Map<string,VisitState>();
  const guard=new DirectedGuard(network),net=protectedArm?guard.network:network;
  const rows:any[]=[],decisions:any[]=[],traces:any[]=[],allEvents:any[]=[],perRoute:Record<string,any>={};
  let polls=0,duplicates=0;
  for(let cursor=0;cursor<observations.length;) {
    const at=observations[cursor]!.collectedAt,unique=new Map<number,BusObservation>();
    while(cursor<observations.length&&observations[cursor]!.collectedAt===at) {
      const o=observations[cursor++]!;
      if(unique.has(o.busId)){assert.deepEqual(o,unique.get(o.busId));duplicates++;}else unique.set(o.busId,o);
    }
    const group=[...unique.values()],plan=planTracks(group);
    reconcileTracks(states,plan);reconcileTracks(visits,plan);
    const before=new Map(states);
    const ds=group.map(o=>{
      const r=perRoute[o.routeId]??={observations:0,visits:0,protectedPolls:0,protectedBuses:new Set(),reasons:{},
        transitionsOver5:0,events:{},outcomes:{}};
      r.observations++;
      if(!protectedArm||o.routeId!==19)return null;
      const d=guard.prepare(plan.keys.get(o.busId)!,states.get(plan.keys.get(o.busId)!),o,plan.contendedNames.has(o.busName));
      r.reasons[d.reason]=(r.reasons[d.reason]??0)+1;
      if(d.protected) {
        r.protectedPolls++;r.protectedBuses.add(o.busName);
        if(diagnostic)decisions.push({...d,nearOtherMarkers:network.routes.get(o.routeId)!.stops
          .map((sid,index)=>({stop:sid,index,metres:distanceMeters(o,network.stops.get(sid)!)}))
          .filter(p=>p.metres<=75&&p.index!==d.selected)});
      }
      return d;
    });
    const stepped=stepManyWithVisits(net,states,visits,group,plan);
    for(const e of [...stepped.events,...stepped.visits]) {
      allEvents.push({knownAt:at,...e});
      const r=perRoute[e.routeId]??={observations:0,visits:0,protectedPolls:0,protectedBuses:new Set(),reasons:{},transitionsOver5:0,events:{},outcomes:{}};
      r.events[e.kind]=(r.events[e.kind]??0)+1;
    }
    const emitted=stepped.visits.filter(e=>e.kind==='visit');
    assert(emitted.length<1000);
    for(const [ordinal,mapped] of visitRowsOf(emitted).visitRows.entries()) {
      const row:any=Object.fromEntries(Object.entries(mapped).map(([k,v])=>[
        k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),v instanceof Date?v.getTime():v]));
      row.id=at*1000+ordinal;row.known_at=at;
      row.replay_fit_eligible=network.routes.get(row.route_id)?.stops[row.stop_index]===row.stop_id;
      row.replay_topology_exclusion=row.replay_fit_eligible?null:'emission disagrees with reducer topology';
      row.replay_contended_at_emission=plan.contendedNames.has(row.bus_name);
      assert(row.replay_fit_eligible);
      assert(row.anchored_at<=at&&(row.arrived_at===null||row.arrived_at<=at)&&(row.departed_at===null||row.departed_at<=at));
      rows.push(row);
      const r=perRoute[row.route_id];r.visits++;r.outcomes[row.outcome]=(r.outcomes[row.outcome]??0)+1;
    }
    for(const [i,o] of group.entries()) {
      const key=plan.keys.get(o.busId)!,prev=before.get(key),after=states.get(key),n=network.routeLength(o.routeId);
      if(prev&&after&&prev.routeId===after.routeId&&n&&(after.nearestIndex-prev.nearestIndex+n)%n>5)
        perRoute[o.routeId].transitionsOver5++;
      if(diagnostic) {
        const active=windows.filter((w:any)=>w.bus===o.busName&&w.start<=at&&at<=w.end);
        if(active.length)traces.push({at,bus:o.busName,route:o.routeId,provider:o.busId,examples:active.map((w:any)=>w.id),
          previous:prev?.nearestIndex??null,index:after?.nearestIndex??null,decision:ds[i],
          visits:emitted.filter(e=>e.busName===o.busName)});
      }
    }
    polls++;
  }
  for(const r of Object.values(perRoute))r.protectedBuses=[...r.protectedBuses].sort();
  return {rows,decisions,traces,allEvents,audit:{polls,observations:observations.length,duplicates,perRoute,eofClosures:0}};
}
const baseline=replay(raw,false),candidate=replay(raw,true);
assert.deepEqual(baseline.rows.map(signature),frozenRows.map(signature),'Baseline differs from frozen canonical visits');
emit('baseline-visits',baseline.rows);emit('candidate-visits',candidate.rows);
emit('baseline-events',baseline.allEvents);emit('candidate-events',candidate.allEvents);
emit('guard-decisions',candidate.decisions);
assert(candidate.decisions.every(d=>d.route===19),'Guard changed another route');
const otherBase=baseline.allEvents.filter(e=>e.routeId!==19),otherNext=candidate.allEvents.filter(e=>e.routeId!==19);
assert.deepEqual(otherNext,otherBase,'Non-Brown reducer emission changed');
const physical=(r:any)=>r.pinned_at!==null||r.arrived_at!==null||r.departed_at!==null;
const fields=['bus_name','bus_id','route_id','stop_index','stop_id','arrived_at','departed_at','known_at'];
const identity=(r:any)=>JSON.stringify(Object.fromEntries(fields.map(k=>[k,r[k]])));
function grouped(rows:any[]){
 const groups=new Map<string,any[]>();
 for(const r of rows){const key=identity(r),g=groups.get(key)??[];g.push(r);groups.set(key,g);}
 return groups;
}
const brown=baseline.rows.filter(r=>r.route_id===19),next=candidate.rows.filter(r=>r.route_id===19);
const a=grouped(brown.filter(physical)),b=grouped(next.filter(physical));
const discrepancies:any[]=[],anchorOnly:any[]=[],metadata:any[]=[];
let matched=0;
for(const key of new Set([...a.keys(),...b.keys()])){
 const left=a.get(key)??[],right=b.get(key)??[];
 if(left.length!==right.length){discrepancies.push({identity:JSON.parse(key),baseline:left,candidate:right});continue;}
 matched+=left.length;
 left.sort((x,y)=>x.anchored_at-y.anchored_at);right.sort((x,y)=>x.anchored_at-y.anchored_at);
 for(let i=0;i<left.length;i++){
  const old=left[i],value=right[i];
  const changed=Object.keys(signature(old)).filter(k=>JSON.stringify(old[k])!==JSON.stringify(value[k]));
  if(changed.length){
   const r={identity:JSON.parse(key),fields:changed,baseline:old,candidate:value};
   (changed.every(k=>k==='anchored_at')?anchorOnly:metadata).push(r);
  }
 }
}
discrepancies.sort((x,y)=>x.identity.known_at-y.identity.known_at);
emit('physical-discrepancies',discrepancies);emit('physical-anchor-only',anchorOnly);emit('physical-metadata-differences',metadata);
emit('baseline-unpinned-bookkeeping',brown.filter(r=>!physical(r)));
emit('candidate-unpinned-bookkeeping',next.filter(r=>!physical(r)));
const prefixes=[];
for(const cutoff of [Date.parse('2026-09-16T04:00:00Z'),Date.parse('2026-09-19T04:00:00Z'),
 Date.parse('2026-09-18T10:14:45-04:00'),Date.parse('2026-09-18T10:17:15-04:00')]){
 const prefix=replay(raw.filter(o=>o.collectedAt<cutoff),true,false);
 assert.deepEqual(prefix.rows,candidate.rows.filter(r=>r.known_at<cutoff));
 assert.deepEqual(prefix.allEvents,candidate.allEvents.filter(r=>r.knownAt<cutoff));
 prefixes.push({cutoff,visits:prefix.rows.length,events:prefix.allEvents.length});
}
const mapCount=(rows:any[],field:(r:any)=>string)=>Object.fromEntries(rows.reduce((m,r)=>{
 const k=field(r);m.set(k,(m.get(k)??0)+1);return m;},new Map<string,number>()));
const hashEvents=(rows:any[])=>createHash('sha256').update(rows.map(r=>JSON.stringify(r)).join('\n')).digest('hex');
const result={guardSha256:hash('research/brown-directed/guard.ts'),baselineCanonicalIdentity:true,
 baselineAudit:baseline.audit,candidateAudit:candidate.audit,nonBrownEventCount:otherBase.length,
 nonBrownEventIdentity:true,nonBrownEventSha256:hashEvents(otherBase),prefixChecks:prefixes,
 Brown:{baselineTotal:brown.length,candidateTotal:next.length,baselinePhysical:brown.filter(physical).length,
 candidatePhysical:next.filter(physical).length,matchedPhysical:matched,discrepancyKeys:discrepancies.length,
 anchorOnly:anchorOnly.length,metadataDifferences:metadata.length,
 baselineByStop:mapCount(brown.filter(physical),r=>String(r.stop_index)),
 candidateByStop:mapCount(next.filter(physical),r=>String(r.stop_index)),
 discrepancyByStop:mapCount(discrepancies,r=>String(r.identity.stop_index)),
 firstDiscrepancy:discrepancies[0]??null},
 gate:discrepancies.length?'HALTED: physical arrival/departure/knownAt multiset changed':'PHYSICAL GATE PASSED; feature/source/path/fit gates still required',
 modelsFitted:0,scoresProduced:false,labelsChanged:false,
 rawSha256:hash('research/k-sweep/results/raw_positions.jsonl.gz'),canonicalVisitsSha256:hash(frozen+'training-visits.jsonl.gz')};
fs.writeFileSync(out+'parity-summary.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({gate:result.gate,Brown:result.Brown,nonBrownEventIdentity:true,prefixChecks:prefixes.length}));
assert.equal(discrepancies.length,0,'Frozen physical multiset gate failed; halt before feature/fitting/scoring');
