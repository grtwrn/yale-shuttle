/**
 * Does the unstarted-rest re-pricing make the number JUMP?
 *
 * Median error says how wrong the board is on average. A rider does not
 * experience an average — they watch one number for a minute. This scores
 * STABILITY: replay every raw GPS position (5 s cadence) through the real
 * anchor, and for each (bus, target stop) compare consecutive polls.
 *
 * A healthy ETA counts down in real time, so between polls t1 and t2 the
 * honest change is exactly -(t2 - t1). Anything else is a jump:
 *
 *     jump = (eta2 - eta1) + (t2 - t1)
 *
 * Two hop pricings are scored on the SAME anchors, the same stall credit and
 * the same proration, so the only difference is the rule under test:
 *
 *   pr      hop = seg.avg                                (this branch)
 *   master  hop = max(30, seg.avg - dwell.med) + dwell.low  for every hop
 *           after the first                              (PR #40, reverted)
 *
 * The mechanism to look for: step 1 is exempt from the re-pricing and step 2
 * is not, so every time the bus advances a stop, the hop that was surcharged
 * stops being surcharged — a jump built into the rule, not into the data.
 *
 *   cd services/shuttle-v2 && TZ=America/New_York REPLAY_DB=... npx tsx scripts/eta-replay/stability-replay.ts
 */
import fs from "node:fs";

import {
  OUT_DIR, SEGMENT_WINDOW_MS, fmtEt, loadNet, loadSamples, makeCalibCache,
  routeAdjacency, serveRoute, type AdjEntry, type ServedRoute,
} from "./common.js";
import { planTracks, stepMany, type BusObservation, type BusState } from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { median, percentile } from "../../src/calibrator/shrinkage.js";
import { findRouteAnchor, isBusOnRoute, registerRoutePaths } from "../../web/src/anchor";
import { haversineMeters, progressAlongSegment } from "../../web/src/geo";
import type { BusData } from "../../web/src/map-data";
import { BUS_SPEED_M_S, ROUTE_ID_LABEL, ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const MAX_K = 5;
const AT_STOP_MAX_M = 75;
const MAX_POLL_GAP_MS = 15_000;
const DWELL_WINDOW_MS = 14 * 86_400_000;
const MIN_HOP_SEC = 30;
const STALL_CREDIT_MAX_FRACTION = 0.5;

const net = loadNet();
const { db, network } = net;
registerRoutePaths(net.routePaths);

type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const pos = db.prepare(
  `SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
   FROM raw_positions ORDER BY collected_at, id`).all() as PosRow[];
const rawStart = pos[0]!.t, rawEnd = pos[pos.length - 1]!.t;
log(`raw positions ${pos.length}, ${fmtEt(rawStart)} .. ${fmtEt(rawEnd)} ET`);

const samples = loadSamples(net, rawStart - SEGMENT_WINDOW_MS - 3_600_000, rawEnd + 3_600_000);
const calibCache = makeCalibCache(samples, network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));
const servedCache = new Map<string, ServedRoute>();
function served(bs: number, route: number): ServedRoute {
  const k = `${bs}|${route}`;
  let s = servedCache.get(k);
  if (!s) { s = serveRoute(adjByRoute.get(route)!, calibCache.get(bs).byName.base); servedCache.set(k, s); }
  return s;
}

// -- time-travelled dwells (med + p35), as calibrator.computeDwellStats --------
interface DG { at: Float64Array; done: Float64Array; sec: Float64Array; dow: Int8Array; hour: Int8Array }
const dwellGroups = new Map<string, DG>();
{
  const rows = db.prepare(
    `SELECT route_id r, stop_id s, arrived_at a, dwell_sec d, dow, hour FROM arrivals
     WHERE dwell_sec IS NOT NULL AND arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at`)
    .all(rawStart - DWELL_WINDOW_MS - 3_600_000, rawEnd) as any[];
  const tmp = new Map<string, any[]>();
  for (const x of rows) { const k = `${x.r}:${x.s}`; let l = tmp.get(k); if (!l) tmp.set(k, (l = [])); l.push(x); }
  for (const [k, l] of tmp) dwellGroups.set(k, {
    at: Float64Array.from(l.map((x) => x.a)), done: Float64Array.from(l.map((x) => x.a + x.d * 1000)),
    sec: Float64Array.from(l.map((x) => x.d)), dow: Int8Array.from(l.map((x) => x.dow)), hour: Int8Array.from(l.map((x) => x.hour)),
  });
}
const dwellCache = new Map<string, { med: number; low: number | undefined }>();
function dwellAt(route: number, stop: number, t: number) {
  const start = calibCache.bucketStart(t), key = `${start}|${route}:${stop}`;
  const hit = dwellCache.get(key);
  if (hit) return hit;
  const g = dwellGroups.get(`${route}:${stop}`);
  let out: { med: number; low: number | undefined } = { med: 15, low: undefined };
  if (g) {
    const d = new Date(start), dow = d.getDay();
    const hours = new Set([(d.getHours() + 23) % 24, d.getHours(), (d.getHours() + 1) % 24]);
    const all: number[] = [], win: number[] = [];
    for (let i = 0; i < g.at.length; i++) {
      if (g.at[i]! < start - DWELL_WINDOW_MS || g.done[i]! > start) continue;
      all.push(g.sec[i]!);
      if (g.dow[i] === dow && hours.has(g.hour[i]!)) win.push(g.sec[i]!);
    }
    if (all.length) {
      const low = all.length >= 5 ? percentile(all, 0.35) : undefined;
      const med = win.length ? median(win) : median(all);
      out = { med, low: low === undefined ? undefined : Math.min(low, med) };
    }
  }
  dwellCache.set(key, out);
  return out;
}

// -- detector replay for at_stop state ----------------------------------------
const polls: BusObservation[][] = [];
{
  let cur: BusObservation[] = [], curAt = -1;
  for (const p of pos) {
    if (p.t !== curAt) { if (cur.length) polls.push(cur); cur = []; curAt = p.t; }
    cur.push({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t });
  }
  if (cur.length) polls.push(cur);
}
interface Obs { bus: BusData; t: number; routeId: number }
const observations: Obs[] = [];
{
  const states = new Map<string, BusState>();
  for (const poll of polls) {
    const plan = planTracks(poll);
    stepMany(network, states, poll, plan);
    for (const o of poll) {
      const st = states.get(plan.keys.get(o.busId) ?? o.busName);
      const cand = st && o.collectedAt - st.enteredAt >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
      const atStop = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.enteredAt } : null;
      observations.push({
        t: o.collectedAt, routeId: o.routeId,
        bus: {
          bus_id: o.busId, bus_name: o.busName, route_id: o.routeId, lat: o.lat, lon: o.lon,
          heading: o.heading, last_stop_id: o.lastStopId as number, stationary: atStop != null,
          ...(atStop ? { at_stop_id: atStop.id, at_stop_since: new Date(atStop.since).toISOString().replace(/Z$/, "") } : {}),
        },
      });
    }
  }
}
log(`observations ${observations.length}`);

// -- the two pricings, on identical anchors -----------------------------------
type Mode = "pr" | "master";
function etas(bus: BusData, stops: number[], routeSegs: Record<string, { avg: number; n: number }>, busIdx: number, now: number, mode: Mode): number[] {
  const segValues = Object.values(routeSegs).filter((s) => s.n >= 2);
  const avgSeg = segValues.length ? segValues.reduce((a, s) => a + s.avg, 0) / segValues.length : 0;
  let stallCredit = 0;
  if (bus.at_stop_id && bus.at_stop_since) {
    const atIdx = stops.indexOf(bus.at_stop_id);
    if (atIdx >= 0 && atIdx === busIdx) stallCredit = Math.max(0, (now - new Date(bus.at_stop_since + "Z").getTime()) / 1000);
  }
  let factor = 1;
  if (stallCredit === 0 && bus.lat && bus.lon) {
    const a = net.stopCoords[stops[busIdx]!], b = net.stopCoords[stops[(busIdx + 1) % stops.length]!];
    if (a && b) factor = Math.max(0, Math.min(1, 1 - progressAlongSegment({ lat: bus.lat, lon: bus.lon }, a, b)));
  }
  const out: number[] = [];
  let cum = 0;
  const N = stops.length;
  for (let step = 1; step <= MAX_K; step++) {
    const prevI = (busIdx + step - 1) % N, curI = (busIdx + step) % N;
    const seg = routeSegs[`${stops[prevI]}-${stops[curI]}`];
    let segAvg: number;
    if (seg && seg.n >= 1) {
      segAvg = seg.avg;
      if (mode === "master" && step > 1) {
        const d = dwellAt(bus.route_id, stops[prevI]!, now);
        if (d.low !== undefined && d.low < d.med) segAvg = Math.max(MIN_HOP_SEC, segAvg - d.med) + d.low;
      }
    } else {
      const pc = net.stopCoords[stops[prevI]!], cc = net.stopCoords[stops[curI]!];
      const byDistance = pc && cc ? Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S) : 0;
      segAvg = avgSeg > 0 && avgSeg >= byDistance ? avgSeg : byDistance || 90;
    }
    if (step === 1 && stallCredit > 0) {
      const d = dwellAt(bus.route_id, stops[busIdx]!, now);
      const cancellable = d.med > 0 ? d.med : segAvg * STALL_CREDIT_MAX_FRACTION;
      const applied = Math.min(stallCredit, cancellable, segAvg);
      segAvg -= applied; stallCredit -= applied;
    }
    if (step === 1 && factor < 1) segAvg *= factor;
    cum += segAvg;
    out.push(cum);
  }
  return out;
}

// -- walk each bus's series, poll to poll -------------------------------------
interface Sample { jump: number; advanced: boolean }
const jumps: Record<Mode, Sample[]> = { pr: [], master: [] };
const prev = new Map<string, { t: number; idx: number; eta: Record<Mode, Map<number, number>> }>();
let scored = 0;
for (const o of observations) {
  const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(o.routeId));
  if (!cfg) continue;
  const stops = mergedRouteStops(cfg, net.routeStops);
  if (!isBusOnRoute(o.bus, stops, net.stopCoords)) continue;
  const busIdx = findRouteAnchor(o.bus, stops, net.stopCoords);
  if (busIdx < 0) continue;
  // The client reads segments under cfg.routeIds[0]; fall back to the bus's
  // own route id when that config id is not a route in the database.
  const rid = adjByRoute.has(cfg.routeIds[0]!) ? cfg.routeIds[0]! : o.routeId;
  const adj = adjByRoute.get(rid);
  if (!adj) continue;
  const sv = served(calibCache.bucketStart(o.t), rid);
  const routeSegs: Record<string, { avg: number; n: number }> = {};
  for (let i = 0; i < adj.length; i++) routeSegs[adj[i]!.key] = { avg: sv.clientA[i]!, n: sv.n[i]! };
  const cur: Record<Mode, Map<number, number>> = { pr: new Map(), master: new Map() };
  for (const mode of ["pr", "master"] as Mode[]) {
    const e = etas(o.bus, stops, routeSegs, busIdx, o.t, mode);
    for (let k = 1; k <= MAX_K; k++) cur[mode].set(stops[(busIdx + k) % stops.length]!, e[k - 1]!);
  }
  const key = `${o.routeId} ${o.bus.bus_name}`;
  const p = prev.get(key);
  if (p && o.t - p.t > 0 && o.t - p.t <= MAX_POLL_GAP_MS) {
    const dt = (o.t - p.t) / 1000;
    const advanced = busIdx !== p.idx;
    for (const mode of ["pr", "master"] as Mode[]) {
      for (const [sid, eta2] of cur[mode]) {
        const eta1 = p.eta[mode].get(sid);
        if (eta1 === undefined) continue;
        jumps[mode].push({ jump: eta2 - eta1 + dt, advanced });
        if (mode === "pr") scored++;
      }
    }
  }
  prev.set(key, { t: o.t, idx: busIdx, eta: cur });
}
log(`scored ${scored} consecutive-poll pairs per mode`);

function stats(sel: Sample[]) {
  const a = sel.map((s) => Math.abs(s.jump)).sort((x, y) => x - y);
  const up = sel.filter((s) => s.jump > 60).length;
  const n = a.length || 1;
  return {
    n: sel.length,
    medianAbsJumpSec: Math.round(a[Math.floor(n * 0.5)]! * 10) / 10,
    p90AbsJumpSec: Math.round(a[Math.floor(n * 0.9)]! * 10) / 10,
    p99AbsJumpSec: Math.round(a[Math.floor(n * 0.99)]! * 10) / 10,
    shareOver30s: Math.round(1000 * a.filter((x) => x > 30).length / n) / 10,
    shareOver60s: Math.round(1000 * a.filter((x) => x > 60).length / n) / 10,
    shareOver120s: Math.round(1000 * a.filter((x) => x > 120).length / n) / 10,
    shareUpOver60s: Math.round(1000 * up / n) / 10,
  };
}
const result = {
  generatedAt: new Date().toISOString(),
  window: { start: fmtEt(rawStart), end: fmtEt(rawEnd), hours: Math.round((rawEnd - rawStart) / 360_000) / 10 },
  note: "jump = (eta2 - eta1) + elapsed; 0 = the number counted down honestly. Positive = the ETA grew.",
  all: { pr: stats(jumps.pr), master: stats(jumps.master) },
  atAnchorAdvance: { pr: stats(jumps.pr.filter((s) => s.advanced)), master: stats(jumps.master.filter((s) => s.advanced)) },
  betweenStops: { pr: stats(jumps.pr.filter((s) => !s.advanced)), master: stats(jumps.master.filter((s) => !s.advanced)) },
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/stability.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
