/** Hosted-only integration replay against the frozen causal reference features. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { TransitNetwork } from '../src/network/TransitNetwork.js';
import { planTracks, reconcileTracks, type BusObservation, type BusState } from '../src/collector/detector.js';
import { stepManyWithVisits, pruneVisits, type VisitState } from '../src/collector/departure.js';
import { K10Clock } from '../src/collector/k10Clock.js';

const [data, result] = process.argv.slice(2);
const read = (file: string) => zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').map(s => JSON.parse(s));
const top = JSON.parse(fs.readFileSync(`${data}/topology.json`, 'utf8'));
const raw = read(`${data}/raw_positions.jsonl.gz`).filter(r => r.day >= '2026-09-16').sort((a,b) => a.collected_at - b.collected_at || a.bus_id - b.bus_id);
const features = read(`${result}/multistop/features.jsonl.gz`).filter(r => r.target === 48);
const net = TransitNetwork.build(top.stops, [top.route]);
const states = new Map<string, BusState>(), visits = new Map<string, VisitState>();
let clock = new K10Clock(), cursor = 0, day = '', compared = 0, active = 0, released = 0;
for (const f of features) {
  while (cursor < raw.length && raw[cursor].collected_at <= f.asof) {
    const time = raw[cursor].collected_at, group = [];
    while (cursor < raw.length && raw[cursor].collected_at === time) group.push(raw[cursor++]);
    if (day !== group[0].day) { states.clear(); visits.clear(); clock = new K10Clock(); day = group[0].day; }
    const observations: BusObservation[] = group.map(r => ({ busId: r.bus_id, busName: r.bus_name, routeId: r.route_id,
      lat: r.lat, lon: r.lon, heading: r.heading, lastStopId: r.last_stop_id ?? null, collectedAt: r.collected_at }));
    // Mirror the research's >60s evidence break, without querying outcomes.
    for (const o of observations) for (const [key, s] of states) {
      if (s.busName === o.busName && time - s.lastObservedAt > 60_000) { states.delete(key); visits.delete(key); }
    }
    const plan = planTracks(observations);
    reconcileTracks(states,plan); reconcileTracks(visits,plan); pruneVisits(visits,states);
    const stepped = stepManyWithVisits(net,states,visits,observations,plan);
    clock.update(observations,stepped.visits,states,visits,plan);
  }
  const e = clock.snapshot(f.asof).get(f.bus.replace(/^#/,''));
  if (!e) continue;
  const origin = f.checkpointOrigins['4'];
  // The trial may deliberately be unavailable; every available clock must
  // identify exactly the same source departure and observed route phase.
  assert(origin, `unexpected clock ${f.bus} ${f.at}`);
  assert.equal(e.origin.departed,origin.departed); assert.equal(e.origin.knownAt,origin.knownAt);
  assert.equal(e.index,f.index); assert.equal(e.phase,f.phase);
  const latest = Math.max(...Object.entries(f.origins).filter(([i]) => Number(i)<14).map(([,v]:any) => v.departed));
  const exit = f.releaseEvents.some((v:any) => v.index === 14 && latest < v.departed && v.knownAt <= f.asof)
    || f.index > 14 || (f.index === 14 && f.phase === 'drive');
  assert.equal(e.released,exit);
  compared++; if (e.released) released++; else active++;
}
assert(compared > 3000); assert(active > 1000); assert(released > 100);
console.log(JSON.stringify({compared, active, released, assertion:'live clock agrees with frozen causal reference'},null,2));
