import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {step,type BusState,type BusObservation} from '../../services/shuttle-v2/src/collector/detector.ts';
import {DirectedGuard} from './guard.ts';
const top=JSON.parse(fs.readFileSync('research/canonical-windows/results/canonical-topology.json','utf8'));
const net=TransitNetwork.build(top.stops,top.routes);
const cases=[
  {bus:'#40',at:'2026-09-03T22:28:39.565Z',before:18,ordinary:14,expected:18,positive:true},
  {bus:'#44',at:'2026-09-18T01:43:53.516Z',before:18,ordinary:14,expected:18,positive:true},
  {bus:'#54',at:'2026-09-14T03:45:27.171Z',before:2,ordinary:5,expected:3,positive:true},
  {bus:'#44',at:'2026-09-19T00:05:42.084Z',before:2,ordinary:5,expected:3,positive:true},
  {bus:'#40',at:'2026-09-14T03:43:32.166Z',before:16,ordinary:15,expected:15,positive:false},
  {bus:'#54',at:'2026-09-14T03:27:22.102Z',before:17,ordinary:9,expected:9,positive:false},
  {bus:'#51',at:'2026-09-13T02:48:43.322Z',before:6,ordinary:3,expected:3,positive:false}
].map(c=>({...c,time:Date.parse(c.at)}));
const raw:BusObservation[]=[];
for await(const line of readline.createInterface({input:fs.createReadStream('research/k-sweep/results/raw_positions.jsonl.gz').pipe(zlib.createGunzip())})) {
  if(!line.trim())continue;const r=JSON.parse(line);
  if(cases.some(c=>c.bus===r.bus_name&&r.collected_at>=c.time-10000&&r.collected_at<=c.time+70000))
    raw.push({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,heading:r.heading??0,
      lastStopId:r.last_stop_id??null,collectedAt:r.collected_at});
}
raw.sort((a,b)=>a.collectedAt-b.collectedAt||a.busId-b.busId);
function stateAt(o:BusObservation,index:number):BusState {
  const s=step(net,null,o).state!;
  return {...s,nearestIndex:index,nearestStopId:net.routes.get(o.routeId)!.stops[index]!};
}
const results:any[]=[];
for(const c of cases) {
  const observations=raw.filter(r=>r.busName===c.bus&&r.collectedAt<=c.time&&r.collectedAt>=c.time-10000);
  const o=observations.at(-1)!,p=observations.filter(r=>r.collectedAt<o.collectedAt).at(-1)!;assert.equal(o.collectedAt,c.time);
  const before=stateAt(p,c.before),guard=new DirectedGuard(net),d=guard.prepare(c.bus,before,o);
  assert.equal(step(net,before,o).state?.nearestIndex,c.ordinary);
  assert.equal(d.protected,c.positive);assert.equal(step(guard.network,before,o).state?.nearestIndex,c.expected);
  results.push({...c,decision:d});
  if(c.before===2) {
    let state=step(guard.network,before,o).state!;
    for(const next of raw.filter(r=>r.busName===c.bus&&r.collectedAt>c.time&&r.collectedAt<=c.time+40000)) {
      const decision=guard.prepare(c.bus,state,next);
      state=step(guard.network,state,next).state!;
      assert.notEqual(state.nearestIndex,5,'Later marker recaptured anchor before Wall/York');
      if(decision.protected)assert.equal(decision.leg,2,'Lost directed leg when nearest endpoint advanced');
    }
    assert.equal(state.nearestIndex,3);
  }
}
const c=cases[0]!,o=raw.find(r=>r.busName===c.bus&&r.collectedAt===c.time)!;
const p=raw.filter(r=>r.busName===c.bus&&r.collectedAt<c.time).at(-1)!;
const before=stateAt(p,18);
for(const [name,next,prior,contended] of [
  ['provider change',{...o,busId:o.busId+1000},before,false],
  ['route change',{...o,routeId:1},before,false],
  ['missing observations',{...o,collectedAt:p.collectedAt+60001},before,false],
  ['duplicate poll',{...o,collectedAt:p.collectedAt},before,false],
  ['older poll',{...o,collectedAt:p.collectedAt-1},before,false],
  ['stationary without certificate',{...o,lat:p.lat,lon:p.lon},before,false],
  ['cold start',o,undefined,false],
  ['contended name',o,before,true],
  ['reverse motion',{...o,lat:p.lat,lon:p.lon},{...before,lat:o.lat,lon:o.lon},false],
] as const) {
  const d=new DirectedGuard(net).prepare(c.bus,prior,next,contended);assert.equal(d.protected,false,name);
  results.push({fixture:name,reason:d.reason});
}
const guard=new DirectedGuard(net);assert(guard.prepare(c.bus,before,o).protected);
const after=step(guard.network,before,o).state!;
assert.equal(guard.prepare(c.bus,after,o).reason,'not_newer');
const repeat={...o,collectedAt:o.collectedAt+5000};assert(guard.prepare(c.bus,after,repeat).protected);
const far=net.stops.get(net.routes.get(13)!.stops[9]!)!;
const skipped={...o,lat:far.lat,lon:far.lon,collectedAt:o.collectedAt+10000};
assert.equal(guard.prepare(c.bus,after,skipped).protected,false);
assert.deepEqual(step(guard.network,after,skipped).events.map(e=>e.kind),['arrival']);
results.push({fixture:'repeat retains certificate after duplicate; genuine skipped stop recovers with arrival only',passed:true});
const collision=new DirectedGuard(net);assert(collision.prepare(c.bus,before,o).protected);
collision.prepare(c.bus+'|provider',after,{...repeat,busId:o.busId+1},true);
assert.equal(collision.prepare(c.bus,after,repeat).protected,false,'Contended name resurrected an old-key certificate');
results.push({fixture:'contended identity clears certificate across track-key migration',passed:true});
fs.mkdirSync('research/directed-leg-protection/results',{recursive:true});
fs.writeFileSync('research/directed-leg-protection/results/focused-fixtures.json',JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({focusedFixtures:results.length,passed:true}));
