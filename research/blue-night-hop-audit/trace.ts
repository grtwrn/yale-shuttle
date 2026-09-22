import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { TransitNetwork } from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import { distanceMeters } from '../../services/shuttle-v2/src/network/geo.ts';
import { planTracks, reconcileTracks, ANCHOR_LOOKAHEAD, ANCHOR_SLACK_M,
  type BusObservation, type BusState } from '../../services/shuttle-v2/src/collector/detector.ts';
import { stepManyWithVisits, type VisitState } from '../../services/shuttle-v2/src/collector/departure.ts';

const out = 'research/blue-night-hop-audit/results/';
const canonical = 'research/canonical-windows/results/';
const windows: Array<{ id: number; bus: string; start: number; end: number; transition: number[] }> =
  JSON.parse(fs.readFileSync(out + 'trace-windows.json', 'utf8'));
const topology = JSON.parse(fs.readFileSync(canonical + 'canonical-topology.json', 'utf8'));
const network = TransitNetwork.build(topology.stops, topology.routes);
assert.deepEqual(network.routes.get(13)!.stops, topology.routes.find((r: any) => r.id === 13).stops);
const expected: any[] = [];
for await (const line of readline.createInterface({ input: fs.createReadStream(canonical + 'training-visits.jsonl.gz').pipe(zlib.createGunzip()) })) {
  if (!line.trim()) continue;
  const v = JSON.parse(line);
  if (v.route_id === 13) expected.push(v);
}
const names = new Set(expected.map(v => v.bus_name));
const raw: BusObservation[] = [];
for await (const line of readline.createInterface({ input: fs.createReadStream('research/k-sweep/results/raw_positions.jsonl.gz').pipe(zlib.createGunzip()) })) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  if (!names.has(r.bus_name)) continue;
  raw.push({ busId: r.bus_id, busName: r.bus_name, routeId: r.route_id, lat: r.lat, lon: r.lon,
    heading: Number.isFinite(r.heading) ? r.heading : 0, lastStopId: Number.isFinite(r.last_stop_id) ? r.last_stop_id : null,
    collectedAt: r.collected_at });
}
raw.sort((a,b) => a.collectedAt-b.collectedAt || a.busId-b.busId);
const states = new Map<string, BusState>();
const visits = new Map<string, VisitState>();
const actual: any[] = [], traces: any[] = [];
for (let cursor=0; cursor<raw.length;) {
  const at = raw[cursor]!.collectedAt;
  const unique = new Map<number,BusObservation>();
  while (cursor<raw.length && raw[cursor]!.collectedAt===at) {
    const o=raw[cursor++]!;
    if (unique.has(o.busId)) assert.deepEqual(o,unique.get(o.busId));
    unique.set(o.busId,o);
  }
  const group=[...unique.values()], plan=planTracks(group);
  reconcileTracks(states,plan); reconcileTracks(visits,plan);
  const before=new Map(states);
  const stepped=stepManyWithVisits(network,states,visits,group,plan);
  for (const e of stepped.visits) if (e.kind==='visit' && e.routeId===13) {
    actual.push({bus:e.busName,provider:e.busId,anchorProvider:e.anchorBusId,route:e.routeId,index:e.stopIndex,stop:e.stopId,
      anchored:e.anchoredAt,arrived:e.arrivedAt,departed:e.departedAt,knownAt:at,outcome:e.outcome,how:e.how,closest:e.closestM});
  }
  for (const o of group) {
    const active=windows.filter(w=>w.bus===o.busName && w.start<=at && at<=w.end);
    if (!active.length) continue;
    const key=plan.keys.get(o.busId)!, prev=before.get(key), after=states.get(key);
    const global=network.nearestStopOnRoute(o.routeId,o);
    const ahead=prev && prev.routeId===o.routeId
      ? network.nearestStopAheadOnRoute(o.routeId,o,prev.nearestIndex,ANCHOR_LOOKAHEAD) : null;
    const distances=network.routes.get(13)!.stops.map((sid,index)=>({index,stop:sid,
      metres:distanceMeters(o,network.stops.get(sid)!)})).sort((a,b)=>a.metres-b.metres);
    const projected=stepped.visits.filter(e=>e.kind==='visit' && e.busName===o.busName).map(e=>e.kind==='visit'
      ? {index:e.stopIndex,stop:e.stopId,anchored:e.anchoredAt,arrived:e.arrivedAt,departed:e.departedAt,
        outcome:e.outcome,how:e.how,closest:e.closestM} : null);
    traces.push({examples:active.map(w=>w.id),at,utc:new Date(at).toISOString(),bus:o.busName,provider:o.busId,route:o.routeId,
      providerLastStop:o.lastStopId,contended:plan.contendedNames.has(o.busName),
      previousIndex:prev?.nearestIndex ?? null,previousRoute:prev?.routeId ?? null,previousProvider:prev?.busId ?? null,
      index:after?.nearestIndex ?? null,stationaryStop:after?.stationaryStopId ?? null,
      gapSec:prev?(at-prev.lastObservedAt)/1000:null,stepMetres:prev?distanceMeters(prev,o):null,
      global,ahead,lookaheadCompetitive:!!ahead && !!global && ahead.meters<=global.meters+ANCHOR_SLACK_M,
      nearestThree:distances.slice(0,3),emitted:projected});
  }
}
const signatures=expected.map(v=>({bus:v.bus_name,provider:v.bus_id,anchorProvider:v.anchor_bus_id,route:v.route_id,
  index:v.stop_index,stop:v.stop_id,anchored:v.anchored_at,arrived:v.arrived_at,departed:v.departed_at,
  knownAt:v.known_at,outcome:v.outcome,how:v.how,closest:v.closest_m}));
assert.deepEqual(actual,signatures,'Unchanged reducer disagrees with frozen canonical Blue Night visits');
fs.writeFileSync(out+'reducer-traces.jsonl.gz',zlib.gzipSync(traces.map(t=>JSON.stringify(t)).join('\n')+'\n'));
const summary={canonicalBlueNightVisitSignaturesIdentical:actual.length,observations:raw.length,
  originalRules:{lookahead:ANCHOR_LOOKAHEAD,slackMetres:ANCHOR_SLACK_M},
  windows:windows.map(w=>{const rs=traces.filter(t=>t.examples.includes(w.id));return {...w,rows:rs.length,
    routes:[...new Set(rs.map(r=>r.route))],providers:[...new Set(rs.map(r=>r.provider))],
    changes:rs.filter(r=>r.previousIndex!==r.index).map(r=>({at:r.at,utc:r.utc,from:r.previousIndex,to:r.index,
      route:r.route,provider:r.provider,gapSec:r.gapSec,stepMetres:r.stepMetres,global:r.global,ahead:r.ahead,
      lookaheadCompetitive:r.lookaheadCompetitive,providerLastStop:r.providerLastStop}))};})};
fs.writeFileSync(out+'trace-summary.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({canonicalBlueNightVisitSignaturesIdentical:actual.length,traceRows:traces.length}));
