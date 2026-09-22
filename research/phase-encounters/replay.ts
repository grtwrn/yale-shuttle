/** Hosted, research-only. No fits, ETA-error calculations or production writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {planTracks,reconcileTracks,type BusObservation,type BusState} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits,type VisitState} from '../../services/shuttle-v2/src/collector/departure.ts';
import {visitRowsOf} from '../../services/shuttle-v2/src/collector/visitRows.ts';
import {DirectedGuard,type Decision} from '../directed-leg-protection/guard.ts';
import {EncounterLedger,type Update} from './ledger.ts';
const OUT='research/phase-encounters/results/',CANON='research/canonical-windows/results/',PHASE='research/phase-frozen/';
fs.mkdirSync(OUT,{recursive:true});
async function read(path:string){const rows:any[]=[];for await(const line of readline.createInterface({input:fs.createReadStream(path).pipe(zlib.createGunzip())}))if(line.trim())rows.push(JSON.parse(line));return rows;}
async function sha(path:string){const hash=createHash('sha256');for await(const chunk of fs.createReadStream(path))hash.update(chunk);return hash.digest('hex');}
function writer(name:string){const gzip=zlib.createGzip({level:3}),file=fs.createWriteStream(OUT+name+'.jsonl.gz');gzip.pipe(file);return {
  async write(s:string){if(s&&!gzip.write(s))await once(gzip,'drain');},async close(){gzip.end();await once(file,'finish');}
};}
function emit(name:string,rows:any[]){fs.writeFileSync(OUT+name+'.jsonl.gz',zlib.gzipSync(rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':'')));}
const top=JSON.parse(fs.readFileSync(CANON+'canonical-topology.json','utf8'));
const net=TransitNetwork.build(top.stops,top.routes),markers=top.stops.map((s:any)=>({id:s.id,lat:s.lat,lon:s.lon}));
const frozenSummary=JSON.parse(fs.readFileSync(PHASE+'summary.json','utf8'));
const rawPath='research/k-sweep/results/raw_positions.jsonl.gz';
assert.equal(await sha(rawPath),frozenSummary.inputSha256);assert.equal(await sha(CANON+'canonical-topology.json'),frozenSummary.topologySha256);
const raw:BusObservation[]=(await read(rawPath)).map(r=>Object.freeze({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,
  heading:Number.isFinite(r.heading)?r.heading:0,lastStopId:Number.isFinite(r.last_stop_id)?r.last_stop_id:null,collectedAt:r.collected_at})).sort((a,b)=>a.collectedAt-b.collectedAt||a.busId-b.busId);
assert.equal(raw.length,1487970);assert(raw.at(-1)!.collectedAt<Date.parse('2026-09-21T04:00:00Z'));
const frozen={baseline:await read(PHASE+'baseline-visits.jsonl.gz'),guarded:await read(PHASE+'protected-visits.jsonl.gz')};
const cuts=[Date.parse('2026-09-16T04:00:00Z'),Date.parse('2026-09-19T04:00:00Z'),1789262772829].sort((a,b)=>a-b);
type Arm={name:'baseline'|'guarded';states:Map<string,BusState>;visits:Map<string,VisitState>;guard:DirectedGuard;ledger:EncounterLedger;emitted:number};
function signature(r:any){return Object.fromEntries(Object.entries(r).filter(([k])=>k!=='id'&&!k.startsWith('replay_')));}
function annotations(arm:Arm,updates:Update[],keys:Map<number,string>,decisions:Map<number,Decision>){
  return updates.map(u=>{
    const e=u.episode,k=keys.get(e.provider),state=k?arm.states.get(k):null,v=k?arm.visits.get(k):null,d=decisions.get(e.provider);
    const valid=state&&state.busId===e.provider&&state.busName===e.bus&&state.routeId===e.route&&state.lastObservedAt===u.knownAt;
    const anchorIndex=valid?state.nearestIndex:null,phaseIndex=valid?(v?.pass?.arrivedAt!=null?v.pass.stopIndex:v?.transit?.fromIndex??null):null;
    const supportedLeg=valid&&d?.retained?d.leg:null,route=net.routes.get(e.route);
    const markerOccurrences=route?.stops.flatMap((s,i)=>s===e.marker?[i]:[])??[];
    const supported=new Set([anchorIndex,phaseIndex,supportedLeg,supportedLeg!==null&&route?(supportedLeg+1)%route.stops.length:null].filter(i=>i!==null));
    const candidates=markerOccurrences.filter(i=>supported.has(i));
    return {episodeId:u.episodeId,version:u.version,knownAt:u.knownAt,arm:arm.name,anchorIndex,phaseIndex,supportedLeg,markerOccurrences,
      association:!valid?'unavailable':!markerOccurrences.length?'marker_not_on_route':candidates.length>1?'multiple_phase_candidates':candidates.length===1?'unique_phase_supported':'other_phase_or_leg'};
  });
}
async function replay(cutoff=Infinity,save=false){
  const arms:Arm[]=(['baseline','guarded'] as const).map(name=>({name,states:new Map(),visits:new Map(),guard:new DirectedGuard(net),ledger:new EncounterLedger(markers),emitted:0}));
  const hashes={physical:createHash('sha256'),baseline:createHash('sha256'),guarded:createHash('sha256'),breaks:createHash('sha256')};
  const counts={observations:0,polls:0,duplicates:0,physical:0,breaks:0,annotations:0,phaseDifferences:0};
  const streams=save?{physical:writer('encounter-updates'),annotations:writer('phase-annotations'),breaks:writer('continuity-breaks'),differences:writer('phase-annotation-differences')}:null;
  const snapshots:any[]=[];let cutIndex=0;
  const digest=()=>({cutoff,counts:{...counts},hashes:Object.fromEntries(Object.entries(hashes).map(([k,v])=>[k,v.copy().digest('hex')])),visits:arms.map(a=>a.emitted)});
  const associationCounts:Record<string,number>={};
  for(let cursor=0;cursor<raw.length&&raw[cursor]!.collectedAt<cutoff;){
    const at=raw[cursor]!.collectedAt;
    while(save&&cutIndex<cuts.length&&at>=cuts[cutIndex]!){snapshots.push({...digest(),cutoff:cuts[cutIndex++]});}
    const unique=new Map<number,BusObservation>();
    while(cursor<raw.length&&raw[cursor]!.collectedAt===at){const o=raw[cursor++]!;counts.observations++;
      if(unique.has(o.busId)){assert.deepEqual(o,unique.get(o.busId));counts.duplicates++;}else unique.set(o.busId,o);}
    const group=[...unique.values()],plan=planTracks(group),physical:any[]=[],phase:any[][]=[];
    for(const arm of arms){
      // Separate ledgers run before/after phase work; neither receives phase data.
      if(arm.name==='baseline')physical.push(arm.ledger.stepBatch(group));
      reconcileTracks(arm.states,plan);reconcileTracks(arm.visits,plan);
      const decisions=new Map<number,Decision>();
      if(arm.name==='guarded')for(const o of group)decisions.set(o.busId,arm.guard.prepare(plan.keys.get(o.busId)!,arm.states.get(plan.keys.get(o.busId)!),o,plan.contendedNames.has(o.busName)));
      const result=stepManyWithVisits(arm.name==='guarded'?arm.guard.network:net,arm.states,arm.visits,group,plan);
      if(arm.name==='guarded')physical.push(arm.ledger.stepBatch(group));
      const rows=visitRowsOf(result.visits.filter(e=>e.kind==='visit')).visitRows;
      for(const mapped of rows){const row:any=Object.fromEntries(Object.entries(mapped).map(([k,v])=>[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),v instanceof Date?v.getTime():v]));
        row.known_at=at;assert.deepEqual(signature(row),signature(frozen[arm.name][arm.emitted]),`${arm.name} visit ${arm.emitted}`);arm.emitted++;}
      phase.push(annotations(arm,physical[physical.length-1].updates,plan.keys,decisions));
    }
    const a=JSON.stringify(physical[0]),b=JSON.stringify(physical[1]);assert.equal(a,b,`Phase affected physical ledger at ${at}`);
    const lines=(rows:any[])=>rows.map(r=>JSON.stringify(r)+'\n').join('');
    const physicalText=lines(physical[0].updates),breakText=lines(physical[0].breaks),baseText=lines(phase[0]!),guardText=lines(phase[1]!);
    hashes.physical.update(physicalText);hashes.breaks.update(breakText);hashes.baseline.update(baseText);hashes.guarded.update(guardText);
    counts.physical+=physical[0].updates.length;counts.breaks+=physical[0].breaks.length;counts.annotations+=phase[0]!.length*2;counts.polls++;
    const differences:any[]=[];
    for(let i=0;i<phase[0]!.length;i++){
      const x=phase[0]![i]!,y=phase[1]![i]!;
      for(const p of [x,y]){const k=p.arm+'/'+p.association;associationCounts[k]=(associationCounts[k]??0)+1;}
      if(JSON.stringify({...x,arm:null})!==JSON.stringify({...y,arm:null}))differences.push({episodeId:x.episodeId,version:x.version,knownAt:at,baseline:x,guarded:y});
    }
    counts.phaseDifferences+=differences.length;
    if(streams)await Promise.all([streams.physical.write(physicalText),streams.breaks.write(breakText),streams.annotations.write(baseText+guardText),streams.differences.write(lines(differences))]);
    if(save&&counts.polls%25000===0)console.log(JSON.stringify({progress:counts,at}));
  }
  if(streams)await Promise.all(Object.values(streams).map(s=>s.close()));
  if(save){assert.equal(arms[0]!.emitted,frozen.baseline.length);assert.equal(arms[1]!.emitted,frozen.guarded.length);
    assert.deepEqual(arms[0]!.ledger.summaries(),arms[1]!.ledger.summaries());emit('episodes',arms[0]!.ledger.summaries());}
  return {...digest(),snapshots,associationCounts,episodes:arms[0]!.ledger.summaries().length};
}
const full=await replay(Infinity,true),prefixes=[];
for(const cutoff of cuts){console.log(JSON.stringify({prefixStarting:cutoff}));const prefix=await replay(cutoff),expected=full.snapshots.find(s=>s.cutoff===cutoff);
  assert(expected);assert.deepEqual(prefix.hashes,expected.hashes);assert.deepEqual(prefix.counts,expected.counts);assert.deepEqual(prefix.visits,expected.visits);
  prefixes.push({cutoff,counts:prefix.counts,hashes:prefix.hashes,visits:prefix.visits,identical:true});}
const inputs:Record<string,string>={};
for(const path of [rawPath,CANON+'canonical-topology.json',CANON+'unscored.jsonl.gz',PHASE+'baseline-visits.jsonl.gz',PHASE+'protected-visits.jsonl.gz',PHASE+'label-comparison.jsonl.gz',
  'research/directed-leg-diagnostics/results/physical-visit-differences.jsonl.gz','research/directed-leg-diagnostics/results/earlier-pickup-barriers.jsonl.gz',
  'research/phase-encounters/SPEC.md','research/phase-encounters/SCHEMA.json','research/phase-encounters/ledger.ts','research/directed-leg-protection/guard.ts'])inputs[path]=await sha(path);
const summary={...full,prefixes,inputs,qualityRuleMps:22,modelScoresComputed:false,productionFilesChanged:false,latestInputEtDay:'2026-09-20'};
fs.writeFileSync(OUT+'replay-summary.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({finished:full.counts,prefixes:prefixes.length,episodes:full.episodes}));
