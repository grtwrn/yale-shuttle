import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EncounterLedger,barriersFor,NEAR_M,EXIT_M,GAP_MS,type Observation} from './ledger.ts';
const markers=[{id:1,lat:0,lon:0},{id:2,lat:0,lon:.001},{id:3,lat:0,lon:.002}];
const o=(at:number,lon=0,busId=1,routeId=13,busName='#1'):Observation=>({busId,busName,routeId,lat:0,lon,collectedAt:at});
const cases:string[]=[];
function test(name:string,fn:()=>void){fn();cases.push(name);}
test('frozen constants',()=>assert.deepEqual([NEAR_M,EXIT_M,GAP_MS],[75,125,60000]));
test('overlaps are marker-specific and never transitive',()=>{
  const l=new EncounterLedger(markers);l.stepBatch([o(0,.0005)]);l.stepBatch([o(5000,.0015)]);
  const e=l.summaries();assert.equal(e.length,3);assert.equal(new Set(e.map(x=>x.episodeId)).size,3);
  assert.deepEqual(e.find(x=>x.marker===1)!.simultaneousNearMarkers,[2,3]);
  assert.deepEqual(e.find(x=>x.marker===3)!.simultaneousNearMarkers,[2]);
  assert.equal(e.find(x=>x.marker===1)!.status,'exited');
});
test('moving one-fix encounter remains a possible pass',()=>{
  const l=new EncounterLedger([markers[0]!]);l.stepBatch([o(0,-.002)]);l.stepBatch([o(5000)]);l.stepBatch([o(10000,.002)]);
  const e=l.summaries()[0]!;assert.equal(e.nearPolls,1);assert.equal(e.evidence,'possible_pass');assert.equal(e.exitAt,10000);
});
test('exact near plateau is descriptive and causal',()=>{
  const l=new EncounterLedger([markers[0]!]);l.stepBatch([o(0)]);const early=l.stepBatch([o(10000)]).updates[0]!;
  assert.equal(early.episode.stationaryNearKnownAt,null);l.stepBatch([o(15000)]);l.stepBatch([o(60000)]);
  assert.equal(l.summaries()[0]!.maxNearPlateauMs,60000);assert.equal(l.summaries()[0]!.stationaryNearKnownAt,15000);
  assert.equal(early.episode.stationaryNearKnownAt,null,'Later updates must not mutate emitted snapshots');
});
test('hysteresis retains band, band plateau does not imply near stationary',()=>{
  const l=new EncounterLedger([markers[0]!]);l.stepBatch([o(0)]);l.stepBatch([o(5000,.0009)]);l.stepBatch([o(25000,.0009)]);
  const e=l.summaries()[0]!;assert.equal(e.status,'open');assert.equal(e.nearPolls,1);assert.equal(e.maxBandPlateauMs,20000);assert.equal(e.stationaryNearKnownAt,null);
  l.stepBatch([o(30000,.0012)]);assert.equal(l.summaries()[0]!.exitLowerAt,25000);
});
test('duplicates deduplicate and older input is inert',()=>{
  const l=new EncounterLedger([markers[0]!]);assert.equal(l.stepBatch([o(100),o(100)]).updates.length,1);
  assert.equal(l.stepBatch([o(100)]).updates.length,0);assert.equal(l.stepBatch([o(99)]).updates.length,0);
  assert.throws(()=>l.stepBatch([o(200),o(200,.001)]));
});
test('EOF is open and contains-target encounter spans asof',()=>{
  const l=new EncounterLedger([markers[0]!]);l.stepBatch([o(0)]);l.stepBatch([o(5000)]);const e=l.summaries()[0]!;
  assert.equal(e.status,'open');assert.equal(barriersFor([e],2000,5000,[e.episodeId])[0]!.reason,'open_at_asof');
  assert.equal(barriersFor([e],-1,5000,[e.episodeId]).length,0);
});
for(const reason of ['provider_change','route_change','contention_change','observation_gap'])test(reason+' censors without erasing prior possible pickup',()=>{
  const l=new EncounterLedger([markers[0]!]);l.stepBatch([o(0)]);
  const next=reason==='provider_change'?[o(5000,0,2)]:reason==='route_change'?[o(5000,0,1,14)]:
    reason==='contention_change'?[o(5000),o(5000,0,2)]:[o(60001,.01,2,13,'#other')];
  const result=l.stepBatch(next),old=l.summaries()[0]!;assert.equal(result.breaks[0]!.reason,reason);
  assert.equal(old.status,'censored');assert.equal(old.exitAt,null);assert.equal(old.absenceWitnessAt,null);
  assert.equal(barriersFor([old],70000,80000,[])[0]!.reason,'censored_without_exit');
});
test('same-provider absence witness bounds presence but preserves earlier queries',()=>{
  const l=new EncounterLedger([markers[0]!]);l.stepBatch([o(0)]);l.stepBatch([o(5000,0,1,14)]);
  l.stepBatch([o(10000,.01,2,14)]);assert.equal(l.summaries()[0]!.absenceWitnessAt,null);
  l.stepBatch([o(20000,.01,1,14)]);const old=l.summaries()[0]!;assert.equal(old.absenceWitnessAt,20000);
  assert.equal(barriersFor([old],15000,25000,[]).length,1);assert.equal(barriersFor([old],20000,25000,[]).length,0);
});
test('physical update bytes and identities survive future deletion',()=>{
  const rows=[[o(0,.0005)],[o(5000,.0015)],[o(10000,0,1,14)],[o(80000,.01)]];
  const full=new EncounterLedger(markers),updates=rows.flatMap(r=>full.stepBatch(r).updates);
  for(let n=1;n<rows.length;n++){
    const prefix=new EncounterLedger(markers);assert.deepEqual(rows.slice(0,n).flatMap(r=>prefix.stepBatch(r).updates),updates.filter(r=>r.knownAt<=rows[n-1]![0]!.collectedAt));
  }
});
fs.mkdirSync('research/phase-encounters/results',{recursive:true});
fs.writeFileSync('research/phase-encounters/results/fixtures.json',JSON.stringify({passed:cases.length,cases},null,2)+'\n');
console.log(JSON.stringify({fixtures:cases.length,passed:true}));
