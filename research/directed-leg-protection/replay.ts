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

const out='research/directed-leg-protection/results/';
const frozen='research/canonical-windows/results/';
fs.mkdirSync(out,{recursive:true});
const topology=JSON.parse(fs.readFileSync(frozen+'canonical-topology.json','utf8'));
const network=TransitNetwork.build(topology.stops,topology.routes);
const windows=JSON.parse(fs.readFileSync('research/blue-night-frozen/trace-windows.json','utf8'));
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
  const rows:any[]=[],decisions:any[]=[],traces:any[]=[],perRoute:Record<string,any>={};
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
      if(!protectedArm)return null;
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
  return {rows,decisions,traces,audit:{polls,observations:observations.length,duplicates,perRoute,eofClosures:0}};
}
const baseline=replay(raw,false),protectedRun=replay(raw,true);
assert.deepEqual(baseline.rows.map(signature),frozenRows.map(signature),'Baseline differs from frozen canonical visits');
emit('baseline-visits',baseline.rows);emit('protected-visits',protectedRun.rows);
emit('guard-decisions',protectedRun.decisions);emit('baseline-example-traces',baseline.traces);emit('protected-example-traces',protectedRun.traces);
function grouped(rows:any[]) {
  const groups=new Map<string,any[]>();
  for(const row of rows){const key=visitKey(row),group=groups.get(key)??[];group.push(row);groups.set(key,group);}
  return groups;
}
const baseByKey=grouped(baseline.rows),newByKey=grouped(protectedRun.rows);
const diff:any[]=[],collisions:any[]=[],counts:Record<string,any>={};
function compare(key:string,old:any,next:any,ambiguousIdentity=false) {
  const row=old??next;
  const fields=old&&next?Object.keys(signature(old)).filter(k=>JSON.stringify(old[k])!==JSON.stringify(next[k])):[];
  const status=!old?'added':!next?'removed':fields.length?'changed':'identical';
  const r=counts[row.route_id]??={added:0,removed:0,changed:0,identical:0};r[status]++;
  if(status!=='identical')diff.push({key,route:row.route_id,bus:row.bus_name,status,fields,ambiguousIdentity,
    baseline:old??null,protected:next??null});
}
for(const key of new Set([...baseByKey.keys(),...newByKey.keys()])) {
  const old=[...(baseByKey.get(key)??[])],next=[...(newByKey.get(key)??[])];
  if(old.length>1||next.length>1)collisions.push({key,baseline:[...old],protected:[...next]});
  // Contended names can have two visits at exactly the same anchor instant.
  // Match exact semantic rows first and retain every unmatched row; never let
  // Map.set silently overwrite a physical/provider occurrence.
  for(let i=old.length-1;i>=0;i--) {
    const j=next.findIndex(r=>JSON.stringify(signature(r))===JSON.stringify(signature(old[i])));
    if(j>=0){compare(key,old[i],next[j]);old.splice(i,1);next.splice(j,1);}
  }
  if(old.length===1&&next.length===1)compare(key,old[0],next[0]);
  else {
    const ambiguous=old.length>1||next.length>1;
    for(const row of old)compare(key,row,null,ambiguous);
    for(const row of next)compare(key,null,row,ambiguous);
  }
}
emit('visit-differences',diff);emit('anchored-identity-collisions',collisions);
assert.equal(Object.values(counts).reduce((n,r)=>n+r.identical+r.changed+r.removed,0),baseline.rows.length);
assert.equal(Object.values(counts).reduce((n,r)=>n+r.identical+r.changed+r.added,0),protectedRun.rows.length);
const prefixChecks=[];
for(const cutoff of [Date.parse('2026-09-16T04:00:00Z'),Date.parse('2026-09-19T04:00:00Z'),raw[Math.floor(raw.length/2)]!.collectedAt+1]) {
  const before=raw.filter(o=>o.collectedAt<cutoff),prefix=replay(before,true,false);
  assert.deepEqual(prefix.rows,protectedRun.rows.filter(r=>r.known_at<cutoff),'Protected future-prefix deletion failed');
  prefixChecks.push({cutoff,inputRows:before.length,deletedFutureRows:raw.length-before.length,visits:prefix.rows.length,identical:true});
}
function trace(bus:string,at:string,arm=protectedRun) {
  const row=arm.traces.find(r=>r.bus===bus&&r.at===Date.parse(at));assert(row,`Missing fixture ${bus} ${at}`);return row;
}
const checks:any[]=[];
for(const [bus,at,index] of [
  ['#40','2026-09-03T22:28:39.565Z',18],['#44','2026-09-18T01:43:53.516Z',18],
  ['#54','2026-09-14T03:45:27.171Z',3],['#44','2026-09-19T00:05:42.084Z',3],
  ['#54','2026-09-14T03:46:07.179Z',3],['#44','2026-09-19T00:06:17.089Z',3]
] as const) {
  const row=trace(bus,at);assert.equal(row.index,index,`Positive ${bus} ${at}`);checks.push({bus,at,index,positive:true,decision:row.decision});
}
for(const [bus,at] of [
  ['#40','2026-09-14T03:43:32.166Z'],['#54','2026-09-14T03:27:22.102Z'],['#51','2026-09-13T02:48:43.322Z']
] as const) {
  const old=trace(bus,at,baseline),row=trace(bus,at);assert.equal(row.index,old.index,`Negative ${bus} ${at}`);
  assert.equal(row.decision.protected,false);checks.push({bus,at,index:row.index,positive:false,decision:row.decision});
}
const summary={baselineVisitSignaturesIdentical:baseline.rows.length,baseline:baseline.audit,protected:protectedRun.audit,
  visitDifferencesByRoute:counts,anchoredIdentityCollisionGroups:collisions.length,focusedExamples:checks,prefixChecks,
  inputSha256:createHash('sha256').update(fs.readFileSync('research/k-sweep/results/raw_positions.jsonl.gz')).digest('hex'),
  topologySha256:createHash('sha256').update(fs.readFileSync(frozen+'canonical-topology.json')).digest('hex'),
  specSha256:createHash('sha256').update(fs.readFileSync('research/directed-leg-protection/SPEC.md')).digest('hex'),
  latestInputEtDay:'2026-09-20',productionFilesChanged:false,qualityRuleMps:22};
fs.writeFileSync(out+'summary.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({baselineVisits:baseline.rows.length,protectedVisits:protectedRun.rows.length,guardPolls:protectedRun.decisions.length,focusedExamples:checks.length,prefixChecks:prefixChecks.length}));
