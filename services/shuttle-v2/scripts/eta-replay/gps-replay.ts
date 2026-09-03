/**
 * GPS replay: feed every logged raw position (the last ~7 h) through the REAL
 * client ETA path — findRouteAnchor + computeUpcomingArrivals from
 * web/src/arrivals.ts — with the payload the server would have served at that
 * hour, and score the ETA for the bus's next 1..5 stops against two ground
 * truths:
 *
 *   detector  — the arrivals table (the collector's "nearest stop changed"
 *               event, which fires roughly at the midpoint BEFORE the stop)
 *   proximity — the first moment the bus's own GPS track comes within 50 m
 *               of the stop (what a rider standing there would call arrival)
 *
 * Then re-scores the same pairs with alternative first-hop proration rules.
 *
 *   cd services/shuttle-v2 && TZ=America/New_York npx tsx <this file>
 */
import fs from "node:fs";

import {
  OUT_DIR,
  SEGMENT_WINDOW_MS,
  fmtEt,
  loadNet,
  loadSamples,
  makeCalibCache,
  metricsOf,
  routeAdjacency,
  segmentTimesFor,
  serveRoute,
  type AdjEntry,
  type ServedRoute,
} from "./common.js";
import {
  planTracks,
  stepMany,
  type BusObservation,
  type BusState,
} from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { median } from "../../src/calibrator/shrinkage.js";
import { computeUpcomingArrivals, type SegmentTimes } from "../../web/src/arrivals";
import { findRouteAnchor, isBusOnRoute, registerRoutePaths } from "../../web/src/anchor";
import { distanceToSegmentM, haversineMeters, progressAlongSegment, traceStopLegs } from "../../web/src/geo";
import type { BusData } from "../../web/src/map-data";
import { BUS_SPEED_M_S, ROUTE_ID_LABEL, ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const MAX_K = 5;
const MATCH_MS = 45 * 60_000;
const ENTER_M = 50;
const EXIT_M = 120;
const AT_STOP_MAX_M = 75; // collector.ts
const POLL_STRIDE = Number(process.env.POLL_STRIDE ?? 1);

const net = loadNet();
const { db, network } = net;
registerRoutePaths(net.routePaths);

type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const pos = db
  .prepare(
    `SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
     FROM raw_positions ORDER BY collected_at, id`,
  )
  .all() as PosRow[];
const rawStart = pos[0]!.t;
const rawEnd = pos[pos.length - 1]!.t;
log(`raw positions ${pos.length}, ${fmtEt(rawStart)} .. ${fmtEt(rawEnd)} ET`);

const samples = loadSamples(net, rawStart - SEGMENT_WINDOW_MS - 3_600_000, rawEnd + 3_600_000);
const calibCache = makeCalibCache(samples, network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));
const servedCache = new Map<string, { served: Map<number, ServedRoute>; segmentTimes: SegmentTimes }>();
function payloadAt(t: number) {
  const bs = calibCache.bucketStart(t);
  let p = servedCache.get(String(bs));
  if (!p) {
    const bc = calibCache.get(bs);
    const served = new Map<number, ServedRoute>();
    const segmentTimes: SegmentTimes = {};
    for (const r of net.routes) {
      const adj = adjByRoute.get(r.id)!;
      const s = serveRoute(adj, bc.byName.base);
      served.set(r.id, s);
      segmentTimes[String(r.id)] = segmentTimesFor(adj, s);
    }
    servedCache.set(String(bs), (p = { served, segmentTimes }));
  }
  return p;
}

// -- Time-travelled dwell calibration (calibrator.ts loadDwellGroups + computeDwellStats) --
// The payload's dwells[route][stop].med: windowed (dow, hour±1) median over 14 days, else the 14-day median.
const DWELL_WINDOW_MS = 14 * 86_400_000;
interface DwellGroup { at: Float64Array; done: Float64Array; sec: Float64Array; dow: Int8Array; hour: Int8Array }
const dwellGroups = new Map<string, DwellGroup>();
{
  const rows = db
    .prepare(`SELECT route_id r, stop_id s, arrived_at a, dwell_sec d, dow, hour FROM arrivals WHERE dwell_sec IS NOT NULL AND arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at`)
    .all(rawStart - DWELL_WINDOW_MS - 3_600_000, rawEnd) as Array<{ r: number; s: number; a: number; d: number; dow: number; hour: number }>;
  const tmp = new Map<string, Array<{ a: number; d: number; dow: number; hour: number }>>();
  for (const x of rows) {
    const k = `${x.r}:${x.s}`;
    let l = tmp.get(k);
    if (!l) tmp.set(k, (l = []));
    l.push(x);
  }
  for (const [k, l] of tmp) {
    dwellGroups.set(k, {
      at: Float64Array.from(l.map((x) => x.a)),
      done: Float64Array.from(l.map((x) => x.a + x.d * 1000)),
      sec: Float64Array.from(l.map((x) => x.d)),
      dow: Int8Array.from(l.map((x) => x.dow)),
      hour: Int8Array.from(l.map((x) => x.hour)),
    });
  }
}
const dwellMedCache = new Map<string, number>();
function dwellMedAt(routeId: number, stopId: number, t: number): number {
  const start = calibCache.bucketStart(t);
  const key = `${start}|${routeId}:${stopId}`;
  const hit = dwellMedCache.get(key);
  if (hit !== undefined) return hit;
  const g = dwellGroups.get(`${routeId}:${stopId}`);
  let med = 15; // getDwellStats fallback
  if (g) {
    const d = new Date(start);
    const dow = d.getDay();
    const hours = new Set([(d.getHours() + 23) % 24, d.getHours(), (d.getHours() + 1) % 24]);
    const all: number[] = [];
    const win: number[] = [];
    for (let i = 0; i < g.at.length; i++) {
      if (g.at[i]! < start - DWELL_WINDOW_MS || g.done[i]! > start) continue;
      all.push(g.sec[i]!);
      if (g.dow[i] === dow && hours.has(g.hour[i]!)) win.push(g.sec[i]!);
    }
    if (all.length) med = Math.round(median(win.length ? win : all) * 10) / 10;
  }
  dwellMedCache.set(key, med);
  return med;
}

// -- Detector replay for at_stop_id / at_stop_since (collector.updateLivePositions) --
const polls: BusObservation[][] = [];
{
  let cur: BusObservation[] = [];
  let curAt = -1;
  for (const p of pos) {
    if (p.t !== curAt) {
      if (cur.length) polls.push(cur);
      cur = [];
      curAt = p.t;
    }
    cur.push({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t });
  }
  if (cur.length) polls.push(cur);
}
log(`polls ${polls.length}`);

interface Obs {
  bus: BusData;
  t: number;
  routeId: number;
  atStop: boolean;
  /** the detector's own position index after this poll (-1 unknown) */
  detIdx: number;
}
const observations: Obs[] = [];
{
  const states = new Map<string, BusState>();
  for (let pi = 0; pi < polls.length; pi++) {
    const poll = polls[pi]!;
    const plan = planTracks(poll);
    stepMany(network, states, poll, plan);
    if (pi % POLL_STRIDE !== 0) continue;
    for (const o of poll) {
      const key = plan.keys.get(o.busId) ?? o.busName;
      const st = states.get(key);
      const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
      const cand = st && dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
      const atStop = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.enteredAt } : null;
      const bus: BusData = {
        bus_id: o.busId,
        bus_name: o.busName,
        route_id: o.routeId,
        lat: o.lat,
        lon: o.lon,
        heading: o.heading,
        last_stop_id: o.lastStopId as number,
        stationary: atStop != null,
        ...(atStop ? { at_stop_id: atStop.id, at_stop_since: new Date(atStop.since).toISOString().replace(/Z$/, "") } : {}),
      };
      observations.push({ bus, t: o.collectedAt, routeId: o.routeId, atStop: atStop != null, detIdx: st ? st.nearestIndex : -1 });
    }
  }
}
log(`observations ${observations.length}`);

// -- Ground truths ------------------------------------------------------------
// Sequence-based: the detector's own arrival sequence for (route, bus_name)
// says WHICH pass of the target stop is the one ahead of the bus (twins and
// repeated stops are resolved by stop id + order, and a client anchor that
// lags the detector matches the arrival the detector already logged instead
// of the next lap). The physical time is then refined from the bus's GPS
// track: the first entry within ENTER_M of the stop near that detector event.
interface DetEv { s: number; t: number }
const detSeq = new Map<string, DetEv[]>();
{
  const rows = db
    .prepare(`SELECT bus_name b, route_id r, stop_id s, arrived_at t FROM arrivals WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at, id`)
    .all(rawStart - 3_600_000, rawEnd + MATCH_MS) as Array<{ b: string; r: number; s: number; t: number }>;
  for (const a of rows) {
    const k = `${a.r} ${a.b}`;
    let l = detSeq.get(k);
    if (!l) detSeq.set(k, (l = []));
    l.push({ s: a.s, t: a.t });
  }
}
/** Index of the bus's latest detector arrival at or before t, or -1. */
function detIndexAt(seq: DetEv[], t: number): number {
  let lo = 0;
  let hi = seq.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (seq[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
/** The detector arrival for the `occurrence`-th pass of stopId at or after the bus's current sequence index. */
function detectorArrival(routeId: number, busName: string, stopId: number, t: number, occurrence: number): number | null {
  const seq = detSeq.get(`${routeId} ${busName}`);
  if (!seq) return null;
  const m = detIndexAt(seq, t);
  if (m < 0) return null;
  let seen = 0;
  for (let i = m; i < seq.length; i++) {
    const ev = seq[i]!;
    if (ev.t - t > MATCH_MS) return null;
    if (ev.s !== stopId) continue;
    if (seen === occurrence) return ev.t;
    seen++;
  }
  return null;
}

// proximity: per bus_name track (positions sorted), entry events per stop computed lazily
const trackByName = new Map<string, PosRow[]>();
for (const p of pos) {
  let l = trackByName.get(p.b);
  if (!l) trackByName.set(p.b, (l = []));
  l.push(p);
}
/** Entry times (ms) into the ENTER_M radius of `stop` along the bus's track, with hysteresis. */
const entryCache = new Map<string, Float64Array>();
function entries(busName: string, stopId: number): Float64Array {
  const key = `${busName} ${stopId}`;
  let e = entryCache.get(key);
  if (e) return e;
  const track = trackByName.get(busName)!;
  const s = net.stopCoords[stopId]!;
  const out: number[] = [];
  let inside = false;
  let prev: PosRow | null = null;
  for (const p of track) {
    if (prev && p.t - prev.t <= 60_000) {
      const d = distanceToSegmentM(s, { lat: prev.lat, lon: prev.lon }, { lat: p.lat, lon: p.lon });
      if (!inside && d <= ENTER_M) {
        const tt = Math.max(0, Math.min(1, progressAlongSegment(s, { lat: prev.lat, lon: prev.lon }, { lat: p.lat, lon: p.lon })));
        out.push(prev.t + tt * (p.t - prev.t));
        inside = true;
      } else if (inside && haversineMeters(s, p) >= EXIT_M) inside = false;
    } else {
      const d = haversineMeters(s, p);
      if (!inside && d <= ENTER_M) {
        out.push(p.t);
        inside = true;
      } else if (inside && d >= EXIT_M) inside = false;
    }
    prev = p;
  }
  entryCache.set(key, (e = Float64Array.from(out)));
  return e;
}
const PROX_BEFORE_MS = 90_000;
const PROX_AFTER_MS = 300_000;
/** Physical arrival for the pass the detector logged at detT: the radius entry nearest that event, else null. */
function proximityArrival(busName: string, stopId: number, detT: number): number | null {
  const e = entries(busName, stopId);
  let best: number | null = null;
  for (let i = 0; i < e.length; i++) {
    const x = e[i]!;
    if (x < detT - PROX_BEFORE_MS) continue;
    if (x > detT + PROX_AFTER_MS) break;
    if (best === null || Math.abs(x - detT) < Math.abs(best - detT)) best = x;
  }
  return best;
}

// -- Road-path proration ------------------------------------------------------
interface Leg { pts: [number, number][]; cum: Float64Array; total: number }
const legsByRoute = new Map<number, Leg[]>();
for (const r of net.routes) {
  const path = r.path;
  const stopsLL = [...r.stops, r.stops[0]!].map((sid) => net.stopCoords[sid]!).filter(Boolean);
  const traced = traceStopLegs(path, stopsLL);
  const legs: Leg[] = traced.map((tl) => {
    const cum = new Float64Array(tl.slice.length);
    for (let i = 1; i < tl.slice.length; i++) {
      cum[i] = cum[i - 1]! + haversineMeters({ lat: tl.slice[i - 1]![0], lon: tl.slice[i - 1]![1] }, { lat: tl.slice[i]![0], lon: tl.slice[i]![1] });
    }
    return { pts: tl.slice, cum, total: cum[cum.length - 1] ?? 0 };
  });
  legsByRoute.set(r.id, legs);
}
/** Fraction of the road leg (position idx -> idx+1) already covered, or null if the bus is not near it. */
function pathFraction(routeId: number, idx: number, bus: { lat: number; lon: number }): number | null {
  const legs = legsByRoute.get(routeId);
  const leg = legs?.[idx];
  if (!leg || leg.pts.length < 2 || leg.total <= 0) return null;
  let bestM = Infinity;
  let bestS = 0;
  for (let i = 0; i + 1 < leg.pts.length; i++) {
    const a = { lat: leg.pts[i]![0], lon: leg.pts[i]![1] };
    const b = { lat: leg.pts[i + 1]![0], lon: leg.pts[i + 1]![1] };
    const m = distanceToSegmentM(bus, a, b);
    if (m < bestM) {
      bestM = m;
      const tt = Math.max(0, Math.min(1, progressAlongSegment(bus, a, b)));
      bestS = leg.cum[i]! + tt * (leg.cum[i + 1]! - leg.cum[i]!);
    }
  }
  if (bestM > 100) return null;
  return Math.max(0, Math.min(1, bestS / leg.total));
}

// -- Replica of the computeUpcomingArrivals loop for ONE bus ------------------
type Proration = "chord" | "none" | "path" | "chordNoStall" | "cappedStallDwell" | "cappedStallHalfSeg" | "cappedStallQuarterSeg" | "cappedStallDwell2x" | "oracleAnchor";
function replicaEtas(
  bus: BusData,
  stops: number[],
  routeSegs: Record<string, { avg: number; sd: number; n: number }>,
  busIdx: number,
  now: number,
  mode: Proration,
): number[] {
  const segValues = Object.values(routeSegs).filter((s) => s.n >= 2);
  const avgSeg = segValues.length > 0 ? segValues.reduce((sum, s) => sum + s.avg, 0) / segValues.length : 0;
  let stallCredit = 0;
  if (mode !== "chordNoStall" && bus.at_stop_id && bus.at_stop_since) {
    const atIdx = stops.indexOf(bus.at_stop_id);
    if (atIdx >= 0 && atIdx === busIdx) stallCredit = Math.max(0, (now - new Date(bus.at_stop_since + "Z").getTime()) / 1000);
    if (stallCredit > 0 && mode === "cappedStallDwell") stallCredit = Math.min(stallCredit, dwellMedAt(bus.route_id, bus.at_stop_id, now));
    if (stallCredit > 0 && mode === "cappedStallDwell2x") stallCredit = Math.min(stallCredit, 2 * dwellMedAt(bus.route_id, bus.at_stop_id, now));
  }
  let factor = 1;
  if (stallCredit === 0 && bus.lat && bus.lon && mode !== "none") {
    const a = net.stopCoords[stops[busIdx]!];
    const b = net.stopCoords[stops[(busIdx + 1) % stops.length]!];
    if (a && b) {
      let t = progressAlongSegment({ lat: bus.lat, lon: bus.lon }, a, b);
      if (mode === "path") {
        const f = pathFraction(bus.route_id, busIdx, bus);
        if (f !== null) t = f;
      }
      factor = Math.max(0, Math.min(1, 1 - t));
    }
  }
  const out: number[] = [];
  let cumulative = 0;
  const N = stops.length;
  for (let step = 1; step <= MAX_K; step++) {
    const prevI = (busIdx + step - 1) % N;
    const curI = (busIdx + step) % N;
    const seg = routeSegs[`${stops[prevI]}-${stops[curI]}`];
    let segAvg: number;
    if (seg && seg.n >= 1) segAvg = seg.avg;
    else {
      const pc = net.stopCoords[stops[prevI]!];
      const cc = net.stopCoords[stops[curI]!];
      const byDistance = pc && cc ? Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S) : 0;
      segAvg = avgSeg > 0 && avgSeg >= byDistance ? avgSeg : byDistance || 90;
    }
    if (step === 1 && stallCredit > 0) {
      if (mode === "cappedStallHalfSeg") stallCredit = Math.min(stallCredit, 0.5 * segAvg);
      if (mode === "cappedStallQuarterSeg") stallCredit = Math.min(stallCredit, 0.25 * segAvg);
      const applied = Math.min(stallCredit, segAvg);
      segAvg -= applied;
      stallCredit -= applied;
    }
    if (step === 1 && factor < 1) segAvg *= factor;
    cumulative += segAvg;
    out.push(cumulative);
  }
  return out;
}

// -- Score ----------------------------------------------------------------------
const MODES: Proration[] = ["chord", "none", "path", "chordNoStall", "cappedStallDwell", "cappedStallHalfSeg", "cappedStallQuarterSeg", "cappedStallDwell2x", "oracleAnchor"];
interface Pair { k: number; atStop: boolean; routeId: number; agree: boolean; dwellBin: string; eta: Record<Proration, number>; det: number | null; prox: number | null; realEta: number }
interface OraclePair { k: number; routeId: number; eta: number; prox: number | null; det: number | null }
const oraclePairs: OraclePair[] = [];
const pairs: Pair[] = [];
const counts = { obs: observations.length, offRoute: 0, noAnchor: 0, noRouteCfg: 0, replicaMismatch: 0, noDetector: 0, noProximity: 0, scored: 0 };
let maxReplicaDiff = 0;
let diagLeft = 40;
for (const o of observations) {
  const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(o.routeId));
  if (!cfg) {
    counts.noRouteCfg++;
    continue;
  }
  const stops = mergedRouteStops(cfg, net.routeStops);
  if (!isBusOnRoute(o.bus, stops, net.stopCoords)) {
    counts.offRoute++;
    continue;
  }
  const busIdx = findRouteAnchor(o.bus, stops, net.stopCoords);
  if (busIdx < 0) {
    counts.noAnchor++;
    continue;
  }
  const payload = payloadAt(o.t);
  const targets: number[] = [];
  for (let k = 1; k <= MAX_K; k++) targets.push(stops[(busIdx + k) % stops.length]!);
  const real = computeUpcomingArrivals([...new Set(targets)], [o.bus], net.routeStops, net.stopCoords, payload.segmentTimes, o.t)
    .filter((a) => a.routeLabel === cfg.label);
  // assign the real function's etas to k in order of occurrence per stop id
  const usedPerStop = new Map<number, number>();
  const routeSegs = payload.segmentTimes[cfg.routeIds[0]!] ?? {};
  const etas: Record<Proration, number[]> = {} as any;
  for (const m of MODES) {
    let idx = busIdx;
    if (m === "oracleAnchor" && o.detIdx >= 0) {
      const N = stops.length;
      const cands = [o.detIdx, (o.detIdx - 1 + N) % N];
      let best = cands[0]!;
      let bestD = Infinity;
      for (const c of cands) {
        const a = net.stopCoords[stops[c]!];
        const b = net.stopCoords[stops[(c + 1) % N]!];
        if (!a || !b) continue;
        const d = distanceToSegmentM(o.bus, a, b);
        if (d < bestD) { bestD = d; best = c; }
      }
      idx = best;
    }
    etas[m] = replicaEtas(o.bus, stops, routeSegs, idx, o.t, m);
  }
  for (let k = 1; k <= MAX_K; k++) {
    const sid = targets[k - 1]!;
    const occ = usedPerStop.get(sid) ?? 0;
    usedPerStop.set(sid, occ + 1);
    const forStop = real.filter((a) => a.stopId === sid).sort((a, b) => a.eta - b.eta);
    const r = forStop[occ];
    if (!r) continue;
    const diff = Math.abs(r.eta - etas.chord[k - 1]!);
    if (diff > maxReplicaDiff) maxReplicaDiff = diff;
    if (diff > 0.01) counts.replicaMismatch++;
    const det = detectorArrival(o.routeId, o.bus.bus_name, sid, o.t, occ);
    const prox = det === null ? null : proximityArrival(o.bus.bus_name, sid, det);
    if (det === null) counts.noDetector++;
    if (prox === null) counts.noProximity++;
    if (det === null && prox === null) continue;
    counts.scored++;
    const elapsedDwell = o.bus.at_stop_since ? (o.t - new Date(o.bus.at_stop_since + "Z").getTime()) / 1000 : 0;
    const dwellBin = !o.atStop ? "moving" : elapsedDwell < 30 ? "0-30s" : elapsedDwell < 60 ? "30-60s" : elapsedDwell < 120 ? "60-120s" : elapsedDwell < 300 ? "120-300s" : "300s+";
    if (process.env.DIAG && prox !== null && Math.abs(etas.chord[k - 1]! - (prox - o.t) / 1000) > 600 && diagLeft > 0) {
      diagLeft--;
      console.error(`DIAG ${fmtEt(o.t)} ${o.bus.bus_name} r${o.routeId} anchor=${busIdx}(${stops[busIdx]}) atStop=${o.atStop} k=${k} target=${sid} eta=${Math.round(etas.chord[k - 1]!)} det=${det === null ? "-" : Math.round((det - o.t) / 1000)} prox=${Math.round((prox - o.t) / 1000)} last_stop=${o.bus.last_stop_id} at_stop=${o.bus.at_stop_id ?? "-"}`);
    }
    pairs.push({
      k,
      atStop: o.atStop,
      routeId: o.routeId,
      dwellBin,
      agree: o.detIdx >= 0 && ((busIdx - o.detIdx + stops.length) % stops.length === 0 || (o.detIdx - busIdx + stops.length) % stops.length === 1),
      eta: Object.fromEntries(MODES.map((m) => [m, etas[m][k - 1]!])) as Record<Proration, number>,
      det: det === null ? null : (det - o.t) / 1000,
      prox: prox === null ? null : (prox - o.t) / 1000,
      realEta: r.eta,
    });
  }
}
// Oracle-anchor pairs: targets taken from the detector-informed anchor, scored on the same truths.
for (const o of observations) {
  if (o.detIdx < 0) continue;
  const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(o.routeId));
  if (!cfg) continue;
  const stops = mergedRouteStops(cfg, net.routeStops);
  if (!isBusOnRoute(o.bus, stops, net.stopCoords)) continue;
  const N = stops.length;
  const cands = [o.detIdx, (o.detIdx - 1 + N) % N];
  let idx = cands[0]!;
  let bestD = Infinity;
  for (const c of cands) {
    const a = net.stopCoords[stops[c]!];
    const b = net.stopCoords[stops[(c + 1) % N]!];
    if (!a || !b) continue;
    const d = distanceToSegmentM(o.bus, a, b);
    if (d < bestD) { bestD = d; idx = c; }
  }
  const payload = payloadAt(o.t);
  const routeSegs = payload.segmentTimes[cfg.routeIds[0]!] ?? {};
  const etas = replicaEtas(o.bus, stops, routeSegs, idx, o.t, "chord");
  const used = new Map<number, number>();
  for (let k = 1; k <= MAX_K; k++) {
    const sid = stops[(idx + k) % N]!;
    const occ = used.get(sid) ?? 0;
    used.set(sid, occ + 1);
    const det = detectorArrival(o.routeId, o.bus.bus_name, sid, o.t, occ);
    const prox = det === null ? null : proximityArrival(o.bus.bus_name, sid, det);
    if (det === null && prox === null) continue;
    oraclePairs.push({ k, routeId: o.routeId, eta: etas[k - 1]!, det: det === null ? null : (det - o.t) / 1000, prox: prox === null ? null : (prox - o.t) / 1000 });
  }
}
log(`pairs ${pairs.length}, oracle pairs ${oraclePairs.length}`, JSON.stringify(counts), `max replica diff ${maxReplicaDiff}`);

function score(truth: "det" | "prox", mode: Proration, filter: (p: Pair) => boolean) {
  const errs: number[] = [];
  for (const p of pairs) {
    const a = p[truth];
    if (a === null || !filter(p)) continue;
    errs.push(p.eta[mode] - a);
  }
  return metricsOf(errs);
}
const routeName = (r: number) => `${ROUTE_ID_LABEL[r] ?? "?"} (${net.routeById.get(r)?.name ?? r})`;
const routesSeen = [...new Set(pairs.map((p) => p.routeId))].sort((a, b) => a - b);
const result: any = {
  generatedAt: new Date().toISOString(),
  window: { start: fmtEt(rawStart), end: fmtEt(rawEnd), hours: Math.round(((rawEnd - rawStart) / 3_600_000) * 10) / 10, pollStride: POLL_STRIDE },
  counts,
  replicaCheck: { maxAbsDiffSec: maxReplicaDiff, mismatched: counts.replicaMismatch },
  atStopShare: Math.round((1000 * pairs.filter((p) => p.atStop).length) / pairs.length) / 10,
  truths: {},
};
for (const truth of ["prox", "det"] as const) {
  const t: any = {};
  for (const mode of MODES) {
    t[mode] = {
      overall: score(truth, mode, () => true),
      byHops: Object.fromEntries(Array.from({ length: MAX_K }, (_, i) => i + 1).map((k) => [k, score(truth, mode, (p) => p.k === k)])),
      atStop: score(truth, mode, (p) => p.atStop),
      moving: score(truth, mode, (p) => !p.atStop),
      movingK1: score(truth, mode, (p) => !p.atStop && p.k === 1),
      atStopK1: score(truth, mode, (p) => p.atStop && p.k === 1),
      anchorAgrees: score(truth, mode, (p) => p.agree),
      anchorDisagrees: score(truth, mode, (p) => !p.agree),
      westCampusRoutes: score(truth, mode, (p) => p.routeId === 9 || p.routeId === 10),
      otherRoutes: score(truth, mode, (p) => p.routeId !== 9 && p.routeId !== 10),
      otherRoutesByHops: Object.fromEntries(Array.from({ length: MAX_K }, (_, i) => i + 1).map((k) => [k, score(truth, mode, (p) => p.k === k && p.routeId !== 9 && p.routeId !== 10)])),
    };
  }
  t.anchorDisagreeShareByRoute = Object.fromEntries(routesSeen.map((r) => {
    const rp = pairs.filter((p) => p.routeId === r && p.k === 1);
    return [routeName(r), rp.length ? Math.round((1000 * rp.filter((p) => !p.agree).length) / rp.length) / 10 : null];
  }));
  t.byRoute = Object.fromEntries(routesSeen.map((r) => [routeName(r), score(truth, "chord", (p) => p.routeId === r)]));
  t.byRouteByMode = Object.fromEntries(MODES.map((m) => [m, Object.fromEntries(routesSeen.map((r) => { const x = score(truth, m, (p) => p.routeId === r); return [routeName(r), { n: x.n, medianAbsSec: x.medianAbsSec, meanSignedSec: x.meanSignedSec, medianSignedSec: x.medianSignedSec }]; }))]));
  const bins = ["moving", "0-30s", "30-60s", "60-120s", "120-300s", "300s+"];
  t.k1ByDwellElapsed = Object.fromEntries(MODES.map((m) => [m, Object.fromEntries(bins.map((b) => { const x = score(truth, m, (p) => p.k === 1 && p.dwellBin === b); return [b, { n: x.n, medianAbsSec: x.medianAbsSec, meanSignedSec: x.meanSignedSec, medianSignedSec: x.medianSignedSec }]; }))]));
  {
    const sc = (f: (p: OraclePair) => boolean) => { const e: number[] = []; for (const p of oraclePairs) { const a = p[truth]; if (a === null || !f(p)) continue; e.push(p.eta - a); } return metricsOf(e); };
    t.oracleAnchor = {
      description: "client ETA with the bus anchored where the detector has it (bound on what a perfect anchor could gain); chord proration + current stall credit",
      overall: sc(() => true),
      byHops: Object.fromEntries(Array.from({ length: MAX_K }, (_, i) => i + 1).map((k) => [k, sc((p) => p.k === k)])),
      westCampusRoutes: sc((p) => p.routeId === 9 || p.routeId === 10),
      otherRoutes: sc((p) => p.routeId !== 9 && p.routeId !== 10),
      byRoute: Object.fromEntries(routesSeen.map((r) => { const x = sc((p) => p.routeId === r); return [routeName(r), { n: x.n, medianAbsSec: x.medianAbsSec, meanSignedSec: x.meanSignedSec }]; })),
    };
  }
  t.chord.k1to3 = score(truth, "chord", (p) => p.k <= 3);
  t.chord.movingK1to3 = score(truth, "chord", (p) => !p.atStop && p.k <= 3);
  result.truths[truth] = t;
}
// relative bias by k (pct of actual) for the proximity truth, current client
{
  const rel: Record<number, any> = {};
  for (let k = 1; k <= MAX_K; k++) {
    const v: number[] = [];
    for (const p of pairs) if (p.k === k && p.prox !== null) v.push((100 * (p.eta.chord - p.prox)) / Math.max(30, p.prox));
    rel[k] = metricsOf(v);
  }
  result.truths.prox.chord.relativePctByHops = rel;
}
fs.writeFileSync(`${OUT_DIR}/gps.json`, JSON.stringify(result, null, 1));
log(`wrote ${OUT_DIR}/gps.json`);
console.log(JSON.stringify({ counts, replica: result.replicaCheck, atStopShare: result.atStopShare }, null, 1));
for (const truth of ["prox", "det"] as const) {
  for (const mode of MODES) {
    const t = result.truths[truth][mode];
    console.log(truth.padEnd(5), mode.padEnd(13), "overall", JSON.stringify(t.overall), "movingK1", JSON.stringify(t.movingK1), "atStopK1", JSON.stringify(t.atStopK1));
  }
}
