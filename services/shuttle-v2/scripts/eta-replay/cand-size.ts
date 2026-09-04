/**
 * The road window's cost: a leg that follows the road is a long thin region,
 * so it can hug another leg that shares the same street. How many candidates
 * does each window admit, and how often is the TRUE leg among them?
 */
import { loadNet, fmtEt } from "./common.js";
import { planTracks, stepMany, type BusObservation, type BusState } from "../../src/collector/detector.js";
import { isBusOnRoute, registerRoutePaths, ANCHOR_GPS_THRESHOLD_M } from "../../web/src/anchor.js";
import { distanceToSegmentM, traceStopLegs } from "../../web/src/geo.js";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes.js";
import type { LatLon } from "../../web/src/geo.js";
import type { BusData } from "../../web/src/map-data.js";

const net = loadNet();
registerRoutePaths(net.routePaths);
const { db } = net;
type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const pos = db.prepare(
  `SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
   FROM raw_positions ORDER BY collected_at, id`).all() as PosRow[];
console.error(`raw ${pos.length} ${fmtEt(pos[0]!.t)}..${fmtEt(pos[pos.length - 1]!.t)}`);

const polls: BusObservation[][] = [];
{
  let cur: BusObservation[] = []; let curAt = -1;
  for (const p of pos) {
    if (p.t !== curAt) { if (cur.length) polls.push(cur); cur = []; curAt = p.t; }
    cur.push({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t });
  }
  if (cur.length) polls.push(cur);
}

const geoms = new Map<number, { stops: number[]; label: string; legs: (readonly [number, number])[][] | null }>();
for (const cfg of ROUTE_LISTS) {
  const stops = mergedRouteStops(cfg, net.routeStops);
  if (!stops.length) continue;
  const path = net.routePaths[cfg.routeIds[0]!];
  let legs: (readonly [number, number])[][] | null = null;
  if (path && path.length >= 2) {
    const ring: LatLon[] = stops.map((s) => net.stopCoords[s]!);
    ring.push(ring[0]!);
    const t = traceStopLegs(path, ring);
    if (t.length === stops.length) legs = t.map((l) => l.slice);
  }
  for (const rid of cfg.busRouteIds) geoms.set(rid, { stops, label: cfg.label, legs });
}
const polyD = (p: LatLon, line: readonly (readonly [number, number])[]) => {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const d = distanceToSegmentM(p, { lat: line[i]![0], lon: line[i]![1] }, { lat: line[i + 1]![0], lon: line[i + 1]![1] });
    if (d < best) best = d;
  }
  return best;
};

interface Acc { n: number; cChord: number; cPoly: number; missChord: number; missPoly: number }
const acc = new Map<string, Acc>();
const states = new Map<string, BusState>();
for (const poll of polls) {
  const plan = planTracks(poll);
  stepMany(net.network, states, poll, plan);
  for (const o of poll) {
    const g = geoms.get(o.routeId);
    if (!g) continue;
    const key = plan.keys.get(o.busId) ?? o.busName;
    const st = states.get(key);
    if (!st || st.nearestIndex < 0) continue;
    const bus = { lat: o.lat, lon: o.lon, route_id: o.routeId } as BusData;
    const { stops, label, legs } = g;
    const N = stops.length;
    if (!isBusOnRoute(bus, stops, net.stopCoords)) continue;
    let cc = 0, cp = 0;
    let bestChord = Infinity, bestPoly = Infinity;
    const oc = [st.nearestIndex, (st.nearestIndex - 1 + N) % N];
    let truthInChord = false, truthInPoly = false;
    for (let i = 0; i < N; i++) {
      const dc = distanceToSegmentM(bus, net.stopCoords[stops[i]!]!, net.stopCoords[stops[(i + 1) % N]!]!);
      const leg = legs?.[i];
      const dp = leg && leg.length >= 2 ? polyD(bus, leg) : dc;
      if (dc < ANCHOR_GPS_THRESHOLD_M) { cc++; if (oc.includes(i)) truthInChord = true; }
      if (dp < ANCHOR_GPS_THRESHOLD_M) { cp++; if (oc.includes(i)) truthInPoly = true; }
      if (dc < bestChord) bestChord = dc;
      if (dp < bestPoly) bestPoly = dp;
    }
    let a = acc.get(label);
    if (!a) acc.set(label, (a = { n: 0, cChord: 0, cPoly: 0, missChord: 0, missPoly: 0 }));
    a.n++; a.cChord += cc; a.cPoly += cp;
    if (!truthInChord) a.missChord++;
    if (!truthInPoly) a.missPoly++;
  }
}

console.log("route            polls   mean candidates      truth leg outside the window");
console.log("                          chord   road            chord      road");
let n = 0, cc = 0, cp = 0, mc = 0, mp = 0;
for (const [label, a] of [...acc].sort((x, y) => x[0].localeCompare(y[0]))) {
  n += a.n; cc += a.cChord; cp += a.cPoly; mc += a.missChord; mp += a.missPoly;
  console.log(`  ${label.padEnd(14)}${String(a.n).padStart(7)}${(a.cChord / a.n).toFixed(2).padStart(9)}${(a.cPoly / a.n).toFixed(2).padStart(8)}${(100 * a.missChord / a.n).toFixed(2).padStart(15)}%${(100 * a.missPoly / a.n).toFixed(2).padStart(9)}%`);
}
console.log(`  ${"ALL".padEnd(14)}${String(n).padStart(7)}${(cc / n).toFixed(2).padStart(9)}${(cp / n).toFixed(2).padStart(8)}${(100 * mc / n).toFixed(2).padStart(15)}%${(100 * mp / n).toFixed(2).padStart(9)}%`);
