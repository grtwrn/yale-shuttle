/**
 * Does "the survivors are the same road facing opposite ways" actually pick out
 * the folds, and leave Red alone? That is the whole premise of the fold-aware
 * selection rule, so it is worth a number rather than an argument.
 *
 * For every raw position: build the candidate set exactly as findRouteAnchor
 * does (road window + the ANCHOR_FEED_LEAD_HOPS exclusion) and report the share
 * of polls where two survivors run more than 127 deg apart where the bus is.
 */
import { loadNet, fmtEt } from "./common.js";
import {
  ANCHOR_FEED_LEAD_HOPS, ANCHOR_GPS_THRESHOLD_M, ANCHOR_DIRECTION_COS,
  isBusOnRoute, registerRoutePaths,
} from "../../web/src/anchor.js";
import { distanceToSegmentM, traceStopLegs } from "../../web/src/geo.js";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes.js";
import type { LatLon } from "../../web/src/geo.js";
import type { BusData } from "../../web/src/map-data.js";

const net = loadNet();
registerRoutePaths(net.routePaths);
const { db } = net;
type PosRow = { r: number; lat: number; lon: number; l: number | null; t: number };
const pos = db.prepare(
  `SELECT route_id r, lat, lon, last_stop_id l, collected_at t
   FROM raw_positions ORDER BY collected_at, id`).all() as PosRow[];
console.error(`raw ${pos.length} ${fmtEt(pos[0]!.t)}..${fmtEt(pos[pos.length - 1]!.t)}`);

interface G { stops: number[]; label: string; legs: (readonly [number, number])[][] | null }
const geoms = new Map<number, G>();
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

function nearestSeg(p: LatLon, line: readonly (readonly [number, number])[]) {
  let best = Infinity, a: LatLon | undefined, b: LatLon | undefined;
  for (let i = 0; i + 1 < line.length; i++) {
    const u = { lat: line[i]![0], lon: line[i]![1] };
    const v = { lat: line[i + 1]![0], lon: line[i + 1]![1] };
    const d = distanceToSegmentM(p, u, v);
    if (d < best) { best = d; a = u; b = v; }
  }
  return { d: best, a, b };
}
function dirAt(p: LatLon, i: number, g: G) {
  const scale = Math.cos((p.lat * Math.PI) / 180);
  const leg = g.legs?.[i];
  let a: LatLon | undefined, b: LatLon | undefined;
  if (leg && leg.length >= 2) ({ a, b } = nearestSeg(p, leg));
  else { a = net.stopCoords[g.stops[i]!]; b = net.stopCoords[g.stops[(i + 1) % g.stops.length]!]; }
  if (!a || !b) return null;
  const x = (b.lon - a.lon) * scale, y = b.lat - a.lat;
  const n = Math.hypot(x, y);
  return n < 1e-12 ? null : { x: x / n, y: y / n };
}

const acc = new Map<string, { n: number; multi: number; opposed: number }>();
for (const r of pos) {
  const g = geoms.get(r.r);
  if (!g || !r.lat || !r.lon) continue;
  const bus = { lat: r.lat, lon: r.lon, route_id: r.r } as BusData;
  const { stops, label, legs } = g;
  const N = stops.length;
  if (!isBusOnRoute(bus, stops, net.stopCoords)) continue;
  const dists: number[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const leg = legs?.[i];
    dists[i] = leg && leg.length >= 2
      ? nearestSeg(bus, leg).d
      : distanceToSegmentM(bus, net.stopCoords[stops[i]!]!, net.stopCoords[stops[(i + 1) % N]!]!);
  }
  let cands: number[] = [];
  for (let i = 0; i < N; i++) if (dists[i]! < ANCHOR_GPS_THRESHOLD_M) cands.push(i);
  const lastIdx = r.l != null ? stops.indexOf(r.l) : -1;
  if (lastIdx >= 0) {
    const kept = cands.filter((i) => ((i - lastIdx + N) % N) <= ANCHOR_FEED_LEAD_HOPS);
    if (kept.length) cands = kept;
  }
  let a = acc.get(label);
  if (!a) acc.set(label, (a = { n: 0, multi: 0, opposed: 0 }));
  a.n++;
  if (cands.length < 2) continue;
  a.multi++;
  const dirs = cands.map((i) => dirAt(bus, i, g));
  outer: for (let i = 0; i < dirs.length; i++) {
    const u = dirs[i]; if (!u) continue;
    for (let j = i + 1; j < dirs.length; j++) {
      const v = dirs[j]; if (!v) continue;
      if (u.x * v.x + u.y * v.y <= -ANCHOR_DIRECTION_COS) { a.opposed++; break outer; }
    }
  }
}

console.log("route            polls   >1 candidate    OPPOSED (the fold-aware branch fires)");
for (const [label, a] of [...acc].sort((x, y) => x[0].localeCompare(y[0]))) {
  console.log(`  ${label.padEnd(14)}${String(a.n).padStart(7)}${`${(100 * a.multi / a.n).toFixed(1)}%`.padStart(12)}${`${(100 * a.opposed / a.n).toFixed(2)}%`.padStart(14)}   (${a.opposed} polls)`);
}
