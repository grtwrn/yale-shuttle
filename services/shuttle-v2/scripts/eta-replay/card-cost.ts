/**
 * IS THE CARD ESTIMATOR'S SIMPLICITY LOAD-BEARING?
 *
 * `StopList` renders every line's card on the Map tab and re-runs its ETA
 * arithmetic on every `tick`, so "it is simpler because it has to be fast" is a
 * real hypothesis and has to be measured rather than assumed. This times, on
 * ONE representative payload:
 *
 *   card      the inline StopList arithmetic for all 15 ROUTE_LISTS entries
 *   trip      one `computeUpcomingArrivals` over every stop of every line —
 *             what a merged StopList would call, once per render
 *   tripPer   the same, called once per line (the naive merge, 15 calls)
 *
 * A render happens at most once a second (the `tick`), so the budget is the
 * browser's frame, not microseconds.
 *
 *   TZ=America/New_York REPLAY_DB=./store/snap3-split.db \
 *     PAYLOAD_PATCH=./scripts/.eta-replay/split-patch-0903.json \
 *     npx tsx scripts/eta-replay/card-cost.ts
 */
import fs from "node:fs";

import {
  SEGMENT_WINDOW_MS, loadNet, loadSamples, makeCalibCache, makeDwellCache,
  routeAdjacency, segmentTimesFor, serveRoute, type AdjEntry,
} from "./common.js";
import { distanceMeters } from "../../src/network/geo.js";
import { dedupeAndSort, groupPolls, parseCaptureLine, type PosRow } from "./rider-sim/lib.js";
import * as det from "../../src/collector/detector.js";
import { computeUpcomingArrivals } from "../../web/src/arrivals.js";
import { registerRoutePaths } from "../../web/src/anchor.js";
import { liveAnchorStore } from "../../web/src/anchorGate.js";
import { isBusInService } from "../../web/src/schedule.js";
import { BUS_SPEED_M_S, mergedRouteStops, ROUTE_LISTS } from "../../web/src/routes.js";
import { haversineMeters } from "../../web/src/geo.js";
import type { BusData } from "../../web/src/map-data.js";
import type { LatLon } from "../../web/src/geo.js";

const AT_STOP_MAX_M = 75, AT_STOP_MIN_DWELL_MS = 15_000, LIVE_BUS_TTL_MS = 120_000;

// the card arithmetic, transcribed — same copy as card-vs-trip.ts
function nearestRouteStop(bus: BusData, routeIds: string[], routeStops: Record<string, number[]>, stopCoords: Record<number, LatLon>): number | null {
  if (!bus.lat || !bus.lon) return null;
  let bestStop: number | null = null, bestD = Infinity;
  for (const rid of routeIds) for (const sid of routeStops[rid] ?? []) {
    const sc = stopCoords[sid]; if (!sc) continue;
    const dLat = bus.lat - sc.lat, dLon = bus.lon - sc.lon, d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; bestStop = sid; }
  }
  return bestStop;
}
function cardArrivals(cfg: any, buses: BusData[], routeStops: Record<string, number[]>, stopCoords: Record<number, LatLon>, segmentTimes: any) {
  const busMap: Record<number, BusData> = {};
  for (const bus of buses) {
    if (!cfg.busRouteIds.includes(bus.route_id)) continue;
    busMap[(nearestRouteStop(bus, cfg.routeIds, routeStops, stopCoords) ?? bus.last_stop_id) as number] = bus;
  }
  const seen = new Set<number>(); const stops: number[] = [];
  for (const rid of cfg.routeIds) for (const sid of routeStops[rid] ?? []) if (!seen.has(sid)) { seen.add(sid); stops.push(sid); }
  const etaAtStop: Record<number, any> = {};
  if (stops.length === 0) return etaAtStop;
  const routeSegs = segmentTimes[cfg.routeIds[0]] ?? {};
  const segValues = Object.values(routeSegs).filter((s: any) => s.n >= 2) as any[];
  const avgSeg = segValues.length ? segValues.reduce((s, x) => s + x.avg, 0) / segValues.length : 0;
  for (const [sid, b] of Object.entries(busMap)) {
    const busIdx = stops.indexOf(Number(sid)); if (busIdx === -1) continue;
    let cumulative = 0, cumulativeVar = 0, hasAnyData = false;
    const totalStops = stops.length, fallbackSd = avgSeg * 0.5;
    for (let step = 1; step < totalStops; step++) {
      const prevIdx = (busIdx + step - 1) % totalStops, curIdx = (busIdx + step) % totalStops;
      const seg = routeSegs[`${stops[prevIdx]}-${stops[curIdx]}`];
      if (seg && seg.n >= 1) { cumulative += seg.avg; cumulativeVar += (seg.sd ?? 0) ** 2; hasAnyData = true; }
      else if (avgSeg > 0) { cumulative += avgSeg; cumulativeVar += fallbackSd * fallbackSd; }
      else {
        const pc = stopCoords[stops[prevIdx]!], cc = stopCoords[stops[curIdx]!]; if (!pc || !cc) break;
        const est = Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S);
        cumulative += est; cumulativeVar += (est * 0.5) ** 2;
      }
      if (cumulative > 0) {
        const sd = Math.sqrt(cumulativeVar), existing = etaAtStop[stops[curIdx]!];
        if (!existing || cumulative < existing.eta) {
          etaAtStop[stops[curIdx]!] = { eta: cumulative, low: Math.max(0, cumulative - sd), high: cumulative + sd, busName: (b as BusData).bus_name, estimated: !hasAnyData };
        }
      }
    }
  }
  return etaAtStop;
}

const capture = process.env.CAPTURE ?? `${process.env.HOME}/shuttle-captures/positions-20260903.jsonl`;
const raw: PosRow[] = [];
for (const line of fs.readFileSync(capture, "utf8").split("\n")) { const r = parseCaptureLine(line); if (r) raw.push(r); }
const rows = dedupeAndSort(raw);
const polls = groupPolls(rows);
const net = loadNet();
registerRoutePaths(net.routePaths);
const dataStart = rows[0]!.t, dataEnd = rows[rows.length - 1]!.t;
const samples = loadSamples(net, dataStart - SEGMENT_WINDOW_MS - 3_600_000, dataEnd + 3_600_000);
const calibCache = makeCalibCache(samples, net.network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));
const patch = process.env.PAYLOAD_PATCH ? JSON.parse(fs.readFileSync(process.env.PAYLOAD_PATCH, "utf8")) : null;
function applyPatch(table: any, extra: any) {
  if (!extra) return table;
  for (const [rid, byKey] of Object.entries(extra as any)) {
    const r = (table[rid] ??= {});
    for (const [k, fields] of Object.entries(byKey as any)) Object.assign((r[k] ??= {}), fields as any);
  }
  return table;
}

// Pick the busiest poll of the day — the worst case a phone actually renders.
const states = new Map<string, det.BusState>();
const livePositions = new Map<string, any>();
function step(poll: PosRow[]): BusData[] {
  const obs = poll.map((p) => ({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t }));
  const t = poll[0]!.t;
  const plan = det.planTracks(obs);
  det.stepMany(net.network, states as any, obs, plan);
  for (const o of obs) {
    const key = plan.keys.get(o.busId) ?? o.busName;
    const st = states.get(key);
    const cand = st && o.collectedAt - st.enteredAt >= AT_STOP_MIN_DWELL_MS ? net.stopById.get(st.nearestStopId) : undefined;
    const at = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.stationarySince } : null;
    livePositions.set(key, { o, atStopId: at ? at.id : null, atStopSince: at ? at.since : null });
  }
  for (const [k, v] of livePositions) if (v.o.collectedAt < t - LIVE_BUS_TTL_MS) livePositions.delete(k);
  return [...livePositions.values()].map((v) => ({
    bus_id: v.o.busId, bus_name: v.o.busName, route_id: v.o.routeId, lat: v.o.lat, lon: v.o.lon, heading: v.o.heading,
    last_stop_id: v.o.lastStopId, stationary: v.atStopId != null,
    ...(v.atStopId != null ? { at_stop_id: v.atStopId } : {}),
    ...(v.atStopSince != null ? { at_stop_since: new Date(v.atStopSince).toISOString().replace(/Z$/, "") } : {}),
  })).filter((b) => isBusInService(b as BusData, t)) as BusData[];
}
let best: { buses: BusData[]; t: number } = { buses: [], t: 0 };
for (const poll of polls) {
  const buses = step(poll);
  if (buses.length > best.buses.length) best = { buses, t: poll[0]!.t };
}
const { buses, t } = best;
const bs = calibCache.bucketStart(t);
const bc = calibCache.get(bs);
const segmentTimes: any = {};
for (const r of net.routes) segmentTimes[String(r.id)] = segmentTimesFor(adjByRoute.get(r.id)!, serveRoute(adjByRoute.get(r.id)!, bc.byName.base));
applyPatch(segmentTimes, patch?.segments);
const dwellTimes: any = applyPatch(makeDwellCache(net, dataStart, dataEnd).at(bs), patch?.dwells);

const allStops: number[] = [];
for (const cfg of ROUTE_LISTS) for (const sid of mergedRouteStops(cfg, net.routeStops)) allStops.push(sid);

console.log(`busiest poll ${new Date(t).toISOString()}: ${buses.length} live buses, ${ROUTE_LISTS.length} lines, ${allStops.length} stop slots`);

function bench(name: string, fn: () => void, iters = 400) {
  for (let i = 0; i < 40; i++) fn(); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iters;
  console.log(`  ${name.padEnd(34)} ${ms.toFixed(3)} ms/render`);
}

bench("card (StopList, all 15 lines)", () => {
  for (const cfg of ROUTE_LISTS) cardArrivals(cfg, buses, net.routeStops, net.stopCoords, segmentTimes);
});
bench("trip (one call, every stop)", () => {
  computeUpcomingArrivals(allStops, buses, net.routeStops, net.stopCoords, segmentTimes, t, dwellTimes, liveAnchorStore);
});
bench("trip x15 (one call per line)", () => {
  for (const cfg of ROUTE_LISTS) {
    computeUpcomingArrivals(mergedRouteStops(cfg, net.routeStops), buses, net.routeStops, net.stopCoords, segmentTimes, t, dwellTimes, liveAnchorStore);
  }
});
bench("trip, no store (stateless)", () => {
  computeUpcomingArrivals(allStops, buses, net.routeStops, net.stopCoords, segmentTimes, t, dwellTimes);
});
