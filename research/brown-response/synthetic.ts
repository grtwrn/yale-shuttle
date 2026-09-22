import assert from 'node:assert/strict';
import fs from 'node:fs';
import {adaptResponse,type AdapterContext} from './adapter.ts';
import {ARMS,SEQUENCE,PROTOCOL_SHA256,TOPOLOGY_SHA256,modelUnavailable,predictCheckpoint,requiredQueries,type Feature,type ModelHandle} from './model.ts';
import {CausalClock,type ClockSnapshot} from './clock.ts';
import {fresh,originEligible,updateRelease} from '../brown-clocks/policy.ts';
import {attachServerEta,serverArrivals} from '../../services/shuttle-v2/web/src/etaSource.ts';

const now=Date.parse('2026-09-23T12:00:00Z'),built=Date.parse('2026-09-22T12:00:00Z'),sha='a'.repeat(64);
const coords=Object.fromEntries(SEQUENCE.map((id,i)=>[id,{lat:41.30+i/1000,lon:-72.92}]));
const topology={sequence:SEQUENCE,path:SEQUENCE.map(id=>[coords[id]!.lat,coords[id]!.lon]),coords};
const origin={departed:now-600000,knownAt:now-580000,route:19};
const snapshot:ClockSnapshot={asof:now,bus:'#126',route:19,provider:66423,ready:true,index:0,nearest:0,phase:'hold',
  began:now-120000,observedAt:now,origins:{'1':origin,'6':origin},releasedOrigins:{},prefixComplete:true,prefixSha256:sha,variant:'original'};
function model():ModelHandle{return {manifest:{schema:1,kind:'fixture',artifactId:'synthetic-artifact',training:'frozen',K:8,
  trainBefore:Date.parse('2026-09-16T04:00:00Z'),builtAt:built,validFrom:Date.parse('2026-09-23T04:00:00Z'),validUntil:Date.parse('2026-09-30T04:30:00Z'),
  protocolSha256:PROTOCOL_SHA256,topologySha256:TOPOLOGY_SHA256,pathsSha256:sha,rawPrefixSha256:sha,knownAtPrefixSha256:sha,
  sourceSha256:sha,parametersSha256:sha,parity:{physical:true,source:true,path:true,fit:true}},
  fit:q=>({eta:1600+q[3]*20,low:900+q[3]*20,high:1900+q[3]*20,effective:20,days:4})};}
function body(){const rows=SEQUENCE.map((id,i)=>[0,id,1200,600,1900,i||9,0,100,30]);
  rows.push([1,11,900,400,1500,2,0,10,20]);rows.push(rows[3]!.slice());
  return {buses:[{bus_id:66423,bus_name:'#126',route_id:19,observed_at:now,lat:41.3,lon:-72.92,heading:0,last_stop_id:145}],
    routes:{'19':SEQUENCE},route_paths:{'19':topology.path},stop_coords:coords,service:{untouched:true},
    server_eta:{v:2,at:now,servedAt:now+1000,buses:[['126','Brown',0,null],['205','Red',3,null]],rows,
      distributions:rows.map(()=>Array.from({length:50},(_,i)=>600+20*i)),trial:{model:'original',changedRows:0,validUntil:now+10000}}};}
function context():AdapterContext{return {responseId:'synthetic-response',receivedAt:now+2000,arm:'frozen_K8_original',topology,model:model(),snapshot:()=>snapshot,allowFixtureArtifacts:true};}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){Object.freeze(v);for(const x of Object.values(v))freeze(x);}return v;}
const passed:string[]=[];
function test(name:string,run:()=>void){run();passed.push(name);console.log(name);}
test('all rows, duplicate ordinals, untouched arrays and non-low/high cells',()=>{
  const b=freeze(body()),before=JSON.stringify(b),r=adaptResponse(b,context());
  assert.equal(JSON.stringify(b),before);assert.equal(r.audit.rows.length,b.server_eta.rows.length);assert(r.audit.changedRows>0);
  assert.equal(r.body.buses,b.buses);assert.equal(r.body.routes,b.routes);assert.equal(r.body.stop_coords,b.stop_coords);
  assert.equal(r.body.server_eta.distributions,b.server_eta.distributions);assert.equal(r.body.server_eta.buses,b.server_eta.buses);
  assert.equal(r.body.server_eta.trial,b.server_eta.trial);assert.equal(r.body.service,b.service);
  for(let i=0;i<b.server_eta.rows.length;i++)for(let j=0;j<9;j++)if(j!==3&&j!==4)assert.equal(r.body.server_eta.rows[i]![j],b.server_eta.rows[i]![j]);
  assert.equal(r.body.server_eta.rows[0],b.server_eta.rows[0]);assert.equal(r.body.server_eta.rows[9],b.server_eta.rows[9]);
  assert.notDeepEqual(r.audit.rows[3]!.key,r.audit.rows[10]!.key);
  assert.equal(r.audit.rows[0]!.reason,'ambiguous occurrence: later lap or invalid hop count');
});
test('guarded index cannot reinterpret original target or hops',()=>{
  const b=body(),c=context();c.arm='frozen_K8_directed';c.snapshot=()=>({...snapshot,index:4,nearest:6,phase:'drive',variant:'directed'});
  const r=adaptResponse(b,c);assert.equal(r.audit.rows[3]!.targetIndex,3);assert.equal(r.audit.rows[3]!.anchorIndex,0);
  assert.equal(r.body.server_eta.rows[3]![1],SEQUENCE[3]);assert.equal(r.body.server_eta.rows[3]![5],3);
});
test('at-stop, later-lap and repeated topology are unchanged',()=>{
  for(const hops of [0,9,10]){const b=body();b.server_eta.rows[1]![5]=hops;const r=adaptResponse(b,context());assert.equal(r.body.server_eta.rows[1],b.server_eta.rows[1]);}
  const b=body();const c=context();c.topology={...topology,sequence:[145,147,4,42,98,121,115,172,147]};
  const r=adaptResponse(b,c);assert.equal(r.body,b);assert.equal(r.audit.rows[1]!.reason,'route topology incompatible');
});
test('invalid wire stays invalid; every existing row is still accounted',()=>{
  const b=body();b.server_eta.rows[1]![5]=-1;const r=adaptResponse(b,context());assert.equal(r.body,b);
  assert.equal(r.audit.rows.length,b.server_eta.rows.length);assert.equal(r.audit.responseReason,'invalid served row');
  const bad:any=body();bad.server_eta.rows.push(null);assert.equal(adaptResponse(bad,context()).body,bad);
});
test('absence of a distribution is preserved',()=>{
  const b:any=body();delete b.server_eta.distributions;const r=adaptResponse(b,context());assert(!('distributions'in r.body.server_eta));
});
test('missing target still participates in whole-group support/countdown',()=>{
  const b=body();b.server_eta.rows=[b.server_eta.rows[1]!];b.server_eta.distributions=[b.server_eta.distributions[1]!];
  const c=context(),queries:any[]=[];c.model!.fit=q=>{queries.push(q);return q[3]===5?null:{eta:2000,low:1000,high:2500,effective:20,days:4};};
  let r=adaptResponse(b,c);assert.equal(r.body,b);assert.equal(r.audit.rows[0]!.reason,'group lacks historical support');assert.deepEqual(queries.map(q=>q[3]),[1,2,3,4,5]);
  c.model!.fit=q=>({eta:q[3]===5?660:2000,low:500,high:2500,effective:20,days:4});
  r=adaptResponse(b,c);assert.equal(r.body,b);assert.equal(r.audit.rows[0]!.reason,'group countdown expired');
});
test('actual server clock controls build availability, never receipt time',()=>{
  const b=body(),c=context();c.receivedAt=now+60000;c.model!.manifest.builtAt=now+1;
  const r=adaptResponse(b,c);assert.equal(r.body,b);assert.equal(r.audit.rows[1]!.reason,'model not built at server clock');
  c.model!.manifest.builtAt=now;assert(adaptResponse(b,c).audit.changedRows>0);
});
test('strict model validity and exact rolling cutoff contract',()=>{
  // Synthetic schema boundary only: no sealed artifact or response is exported.
  const m=model();m.manifest.kind='sealed';assert.equal(modelUnavailable(m,'frozen_K8_original',m.manifest.validUntil), 'model expired');
  assert.equal(modelUnavailable(m,'frozen_K8_original',m.manifest.validFrom-1),'model not yet valid');
  assert.equal(modelUnavailable(m,'frozen_K8_original',m.manifest.validFrom),null);
  const r=model();Object.assign(r.manifest,{kind:'sealed',training:'rolling',K:5,trainBefore:Date.parse('2026-09-22T04:00:00Z'),validUntil:Date.parse('2026-09-24T04:00:00Z')});
  assert.equal(modelUnavailable(r,'rolling_K5_original',now),null);r.manifest.trainBefore++;assert.equal(modelUnavailable(r,'rolling_K5_original',now),'model validity not pinned');
});
test('missing, expired, malformed or fixture models do not alter any row',()=>{
  for(const mutation of [(c:AdapterContext)=>{delete c.model;},(c:AdapterContext)=>{c.model!.manifest.protocolSha256=sha;},
    (c:AdapterContext)=>{c.allowFixtureArtifacts=false;}]){const b=body(),c=context();mutation(c);assert.equal(adaptResponse(b,c).body,b);}
  const c=context();c.model!.manifest.parity.path=false;assert.throws(()=>adaptResponse(body(),c),/HALT/);
});
test('missing raw prefix, wrong server snapshot and provider ambiguity fail closed',()=>{
  for(const s of [{...snapshot,prefixComplete:false},{...snapshot,asof:now+1},{...snapshot,provider:999}]) {
    const b=body(),c=context();c.snapshot=()=>s;assert.equal(adaptResponse(b,c).body,b);
  }
  const b=body();b.buses.push({...b.buses[0]!,bus_id:999});assert.equal(adaptResponse(b,context()).body,b);
});
test('newer public GPS does not refresh the older server-clock sidecar',()=>{
  const b=body();b.buses[0]!.observed_at=now+10000;const c=context();c.snapshot=()=>({...snapshot,ready:false,observedAt:now-15001,origins:{}});
  const r=adaptResponse(b,c);assert.equal(r.body,b);assert.equal(r.audit.rows[1]!.reason,'not warm/fresh');
});
test('unchanged source/freshness boundaries and irreversible release latch',()=>{
  assert(fresh(now,now-15000,15000));assert(!fresh(now,now-15001,15000));assert(!fresh(now,now+1,15000));
  const o={departed:now-2700000,knownAt:now-2690000,route:19};assert(originEligible(o,19,now,now,now,2700000));assert(!originEligible(o,19,now+1,now+1,now+1,2700000));
  assert(!originEligible({...o,knownAt:now+1},19,now,now,now,2700000));
  const h=new Map([[1,origin],[0,{departed:now-50000,knownAt:now-30000,route:19}]]),l=new Map<string,number>();
  updateRelease(l,h,19,0,'drive',now-50000,now,2700000,8,0,9);assert.equal(l.get('8/0'),origin.departed);
  updateRelease(l,h,19,0,'hold',now-20000,now+1000,2700000,8,0,9);assert.equal(l.get('8/0'),origin.departed);
  const delayed=new Map([[1,origin],[0,{departed:now-50000,knownAt:now+1,route:19}]]),known=new Map<string,number>();
  updateRelease(known,delayed,19,0,'hold',now-20000,now,2700000,8,0,9);assert.equal(known.size,0);
  updateRelease(known,delayed,19,0,'hold',now-20000,now+1,2700000,8,0,9);assert.equal(known.get('8/0'),origin.departed);
});
test('actual reducer warmup boundary, provider reset and missing-prefix readiness',()=>{
  const top=JSON.parse(fs.readFileSync('research/brown-response/input/development/canonical-topology.json','utf8'));
  const p=top.stops.find((s:any)=>s.id===145),raw=Array.from({length:121},(_,i)=>({collected_at:now-600000+i*5000,
    bus_id:66423,bus_name:'#126',route_id:19,lat:p.lat,lon:p.lon,heading:0,last_stop_id:145}));
  const engine=new CausalClock(top,{'19':[0,5]},[...raw,{...raw.at(-1)!,collected_at:now+5000,bus_id:999}], 'original',true);
  engine.advance(now-1);assert.equal(engine.snapshot('#126',19).ready,false);
  engine.advance(now);assert.equal(engine.snapshot('#126',19).ready,true);
  engine.advance(now+5000);assert.equal(engine.snapshot('#126',19).ready,false);assert.deepEqual(engine.snapshot('#126',19).origins,{});
  assert.throws(()=>engine.advance(now),/Cannot rewind/);
  const missing=new CausalClock(top,{'19':[0,5]},raw,'original',false);missing.advance(now);assert.equal(missing.snapshot('#126',19).ready,false);
});
test('source knowledge and absent fit sidecars cannot be manufactured',()=>{
  const feature:Feature={...snapshot,at:now,target:147,stopsAhead:1,targetIndex:1,anchorIndex:0,occurrenceReason:'unique physical target',baseline:{eta:1200,low:600,high:1900}};
  assert.equal(requiredQueries(feature,8).length,5);assert.throws(()=>predictCheckpoint(feature,8,()=>{throw Error('missing query');}),/missing query/);
  feature.origins={'1':{...origin,knownAt:now+1}};assert.throws(()=>predictCheckpoint(feature,8,()=>null),/source knowledge/);
});
test('actual attachment clock ages the same response and distribution without refreshing it',()=>{
  const b=body(),r=adaptResponse(b,context()),buses=b.buses.slice(),received=now+2000;
  assert(attachServerEta(buses as any,r.body.server_eta,received));
  const a=serverArrivals(buses as any,[147],received)!;assert.equal(a[0]!.eta,1199);assert.equal(a[0]!.low,r.body.server_eta.rows[1]![3]-1);
  assert.equal(a[0]!.distribution![0],599);assert.equal(serverArrivals(buses as any,[147],received+43999)!.length,1);
  assert.deepEqual(serverArrivals(buses as any,[147],received+44000),[]);
});
fs.mkdirSync('research/brown-response/results',{recursive:true});
fs.writeFileSync('research/brown-response/results/synthetic.json',JSON.stringify({checks:passed.length,passed,
  fixtureOnly:true,prospectiveBodiesRead:0,outcomesRead:0,productionChanged:false,arms:ARMS},null,2)+'\n');
