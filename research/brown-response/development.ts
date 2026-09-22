/** Hosted only. Opens original unscored features/fits/raw, never outcome labels. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {createHash} from 'node:crypto';
import {CausalClock,featureForRow,type ClockSnapshot,type RawPosition} from './clock.ts';
import {adaptResponse,topologyContract} from './adapter.ts';
import {ARMS,PROTOCOL_SHA256,TOPOLOGY_SHA256,predictCheckpoint,modelUnavailable,type Arm,type ModelHandle} from './model.ts';
const root='research/brown-response/',input=root+'input/development/',out=root+'results/';
fs.mkdirSync(out,{recursive:true});
const read=(p:string)=>zlib.gunzipSync(fs.readFileSync(p)).toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
const hash=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const key=(r:any)=>JSON.stringify([r.at,r.bus,r.route,r.target]);
const end=Date.parse('2026-09-21T04:00:00Z'),frozen=Date.parse('2026-09-16T04:00:00Z');
assert.equal(process.env.TZ,'America/New_York');
assert.equal(hash('research/brown-directed/guard.ts'),'472c2e7a5babebcb3e2d31736aa4d3ddb013d11bb73ebd157d3daf65719719f6');
const names=['baseline-features.jsonl.gz','candidate-features.jsonl.gz','baseline-source-events.jsonl.gz','candidate-source-events.jsonl.gz',
  'unscored.jsonl.gz','fit-comparisons.jsonl.gz','canonical-topology.json','preparation.json'];
const before=Object.fromEntries(names.map(n=>[n,hash(input+n)]));
assert.equal(before['unscored.jsonl.gz'],'f6ed95e2235ae60aab3dada8b86d4e513f15523239e6038dca31850563466967');
assert.equal(before['canonical-topology.json'],TOPOLOGY_SHA256);
const rawPath=root+'input/raw/raw_positions.jsonl.gz',rawHash=hash(rawPath);
assert.equal(rawHash,'3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9');
const top=JSON.parse(fs.readFileSync(input+'canonical-topology.json','utf8'));
const waits=JSON.parse(fs.readFileSync(input+'preparation.json','utf8')).waits;
const topology=topologyContract(top);
const expected={original:read(input+'baseline-features.jsonl.gz'),directed:read(input+'candidate-features.jsonl.gz')};
const wantedNames=new Set(expected.original.map(p=>p.bus));
const raw:RawPosition[]=read(rawPath).filter(r=>r.collected_at>=frozen-3600000&&wantedNames.has(r.bus_name))
  .sort((a,b)=>a.collected_at-b.collected_at||a.bus_id-b.bus_id);
assert(raw.at(-1)!.collected_at<end);
const unscored=read(input+'unscored.jsonl.gz');
assert(unscored.every(r=>r.at<end&&!('label'in r)&&!('truth'in r)));
const snapshots=new Map<string,{original?:ClockSnapshot;directed?:ClockSnapshot}>();
const counts:any={features:{},sources:{},prefixes:[],predictionControls:0,wireControls:0,changedWireControls:0};
for(const variant of ['original','directed'] as const) {
  console.log(JSON.stringify({stage:'development-clock',variant,raw:raw.length}));
  const engine=new CausalClock(top,waits,raw,variant,true),rs=expected[variant];
  for(const r of rs) {
    assert(r.at<end&&!('label'in r)&&!('truth'in r));
    const feature=engine.feature(r);assert.deepEqual(feature,r,`${variant} feature ${key(r)}`);
    if(r.route===19){const k=key(r),s=snapshots.get(k)??{};s[variant]=engine.snapshot(r.bus,r.route);snapshots.set(k,s);}
  }
  const sources=read(input+(variant==='original'?'baseline':'candidate')+'-source-events.jsonl.gz');
  assert.equal(engine.sourceEvents.length,sources.length);
  for(let i=0;i<sources.length;i++)assert.deepEqual(engine.sourceEvents[i],sources[i],`${variant} source ${i}`);
  counts.features[variant]=rs.length;counts.sources[variant]=sources.length;
}
const fits=new Map<string,any>();
for(const r of read(input+'fit-comparisons.jsonl.gz')) {
  assert.deepEqual(r.baseline,r.candidate);fits.set(JSON.stringify([r.cutoff,r.query]),r.baseline);
}
const sealedFits=new Map(JSON.parse(fs.readFileSync(out+'sealed-development-fits.json','utf8')).map((r:any)=>[JSON.stringify(r.query),r.fit]));
const sealedManifest=JSON.parse(fs.readFileSync(root+'input/sealed/manifest.json','utf8'));
assert.equal(modelUnavailable({manifest:sealedManifest,fit:()=>null},'frozen_K8_original',unscored[0]!.at),'model not built at server clock');
function fixture(r:any,arm:Arm):ModelHandle {
  const isFrozen=arm.startsWith('frozen'),midnight=new Date(r.at);midnight.setHours(0,0,0,0);
  const cutoff=isFrozen?frozen:midnight.getTime()-86400000;
  return {manifest:{schema:1,kind:'fixture',artifactId:`development-only/${arm}/${cutoff}`,training:isFrozen?'frozen':'rolling',K:isFrozen?8:5,
    trainBefore:cutoff,builtAt:cutoff,validFrom:cutoff,validUntil:end,protocolSha256:PROTOCOL_SHA256,topologySha256:TOPOLOGY_SHA256,
    pathsSha256:'a'.repeat(64),rawPrefixSha256:rawHash,knownAtPrefixSha256:'a'.repeat(64),sourceSha256:'a'.repeat(64),parametersSha256:'a'.repeat(64),
    parity:{physical:true,source:true,path:true,fit:true}},fit:q=>{
      const id=JSON.stringify([cutoff,q]);assert(fits.has(id),`Missing saved query ${id}`);
      const f=fits.get(id);
      if(isFrozen){assert(sealedFits.has(JSON.stringify(q)),'Missing reloaded frozen query');assert.deepEqual(f,sealedFits.get(JSON.stringify(q)));}
      return f;
    }};
}
const records:any[]=[];
for(const r of unscored)for(const arm of ARMS) {
  const variant=arm.endsWith('_directed')?'directed':'original',s=snapshots.get(key(r))![variant]!;
  const model=fixture(r,arm),feature=featureForRow(s,{...r,baseline:r.deployed},topology.sequence);
  const p=predictCheckpoint(feature,model.manifest.K,model.fit);
  assert.deepEqual(p.forecast,r.underlyingCandidates[arm],`${arm} forecast ${key(r)}`);
  const {forecast,...evidence}=p;assert.deepEqual(evidence,r.candidateEvidence[arm],`${arm} evidence ${key(r)}`);
  counts.predictionControls++;
  // This wrapper is a declared synthetic wire shape, never an archived response.
  const row=[0,r.target,r.deployed.eta,r.deployed.low,r.deployed.high,r.stopsAhead,0,0,0];
  const b={buses:[{bus_id:s.provider,bus_name:r.bus,route_id:19,observed_at:s.observedAt}],
    routes:{'19':topology.sequence},route_paths:{'19':topology.path},stop_coords:topology.coords,
    server_eta:{v:2,at:r.at,servedAt:r.at,buses:[[r.bus.replace(/^#/,''),'Brown',r.anchorIndex??-1,null]],rows:[row]}};
  const beforeBody=JSON.stringify(b);
  const next=adaptResponse(b,{responseId:`development/${key(r)}`,receivedAt:r.at,arm,topology,model,
    snapshot:()=>s,allowFixtureArtifacts:true});
  assert.equal(JSON.stringify(b),beforeBody);assert.equal(next.audit.rows.length,1);
  const n=next.body.server_eta.rows[0]!;
  assert.deepEqual({eta:n[2],low:n[3],high:n[4]},r.candidates[arm],`${arm} row overlay ${key(r)}`);
  assert.equal(next.body.buses,b.buses);assert.equal(next.body.server_eta.buses,b.server_eta.buses);
  for(const j of [0,1,2,5,6,7,8])assert.equal(n[j],row[j]);
  counts.wireControls++;counts.changedWireControls+=next.audit.changedRows;
  records.push({at:r.at,bus:r.bus,target:r.target,arm,syntheticWire:true,audit:next.audit.rows[0]});
}
for(const cutoff of [Date.parse('2026-09-17T04:00:00Z'),Date.parse('2026-09-19T04:00:00Z'),
  Date.parse('2026-09-18T10:14:45-04:00'),Date.parse('2026-09-18T10:17:15-04:00')])for(const variant of ['original','directed'] as const) {
  console.log(JSON.stringify({stage:'future-prefix',cutoff,variant}));
  const engine=new CausalClock(top,waits,raw.filter(r=>r.collected_at<cutoff),variant,true);
  const rs=expected[variant].filter(r=>r.at<cutoff);
  for(const r of rs){assert.deepEqual(engine.feature(r),r,`${variant} prefix ${cutoff} ${key(r)}`);
    if(r.route===19)assert.deepEqual(engine.snapshot(r.bus,r.route),snapshots.get(key(r))![variant]);}
  const sources=read(input+(variant==='original'?'baseline':'candidate')+'-source-events.jsonl.gz').filter(r=>r.knownAt<=rs.at(-1)!.asof);
  assert.deepEqual(engine.sourceEvents,sources);
  counts.prefixes.push({cutoff,variant,features:rs.length,sources:sources.length});
}
assert.deepEqual(Object.fromEntries(names.map(n=>[n,hash(input+n)])),before);assert.equal(hash(rawPath),rawHash);
fs.writeFileSync(out+'development-records.jsonl.gz',zlib.gzipSync(records.map(r=>JSON.stringify(r)).join('\n')+'\n'));
const result={...counts,originalInputHashes:before,rawHash,guardSha256:hash('research/brown-directed/guard.ts'),
  unscoredSourceIdentity:true,knownAtPrefixIdentity:true,originalFourArmIdentity:true,
  realFrozenArtifactId:sealedManifest.artifactId,realFrozenHistoricalAvailability:false,syntheticHistoricalManifests:true,
  outcomesRead:0,prospectiveBodiesRead:0,newFits:0,completeHistoricalResponsesClaimed:false,productionChanged:false};
fs.writeFileSync(out+'development.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
