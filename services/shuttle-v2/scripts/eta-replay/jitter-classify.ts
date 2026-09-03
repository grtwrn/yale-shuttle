/**
 * JITTER CLASSIFICATION: which ETA jumps had a real-world cause, and which
 * had none at all.
 *
 * The operator's rule, which replaces "reduce jump magnitude" as the goal:
 *
 *   "it can go 5->1 if it leaves early. but if it is jitter we need a fix."
 *
 * A 5 min -> 1 min collapse is CORRECT when the bus really did pull out early;
 * suppressing it withholds information a rider standing at a stop needs. The
 * defect is a change that no event in the world caused.
 *
 * So every jump >= JUMP_BIG_SEC is asked one question: between these two
 * polls, did anything actually happen to this bus?
 *
 *   arrival/departure   the detector logged an arrival, or the at-stop flag
 *                       flipped -- a real event, the ETA SHOULD move
 *   moved >= 100 m      the bus covered real ground
 *   moved < 100 m       it twitched. The feed's 30 m deadband means the
 *                       smallest reportable move is ~30 m, and no 30-90 m
 *                       twitch justifies a five-minute swing. Disproportionate.
 *   fix identical       the coordinate did not change AT ALL. Nothing happened.
 *                       This is jitter with no defence.
 *
 * The last two are the population to suppress. The first two must be left
 * alone, which is why an indiscriminate rate limiter was rejected: it cannot
 * tell them apart.
 *
 *   cd services/shuttle-v2 && TZ=America/New_York npx tsx scripts/eta-replay/jitter-classify.ts
 */
import fs from "node:fs";

import {
  OUT_DIR,
  SEGMENT_WINDOW_MS,
  fmtEt,
  loadNet,
  loadSamples,
  makeCalibCache,
  routeAdjacency,
  segmentTimesFor,
  serveRoute,
  type AdjEntry,
} from "./common.js";
import {
  planTracks,
  stepMany,
  type BusObservation,
  type BusState,
} from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { median } from "../../src/calibrator/shrinkage.js";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from "../../web/src/arrivals";
import { findRouteAnchor, isBusOnRoute, registerRoutePaths } from "../../web/src/anchor";
import { fmtMin } from "../../web/src/format";
import type { BusData } from "../../web/src/map-data";
import { ROUTE_ID_LABEL, ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes";


const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const AT_STOP_MAX_M = 75;
/** A jump this big is the operator's complaint rather than ordinary noise. */
const JUMP_BIG_SEC = Number(process.env.JUMP_BIG_SEC ?? 300);
/** Ignore pairs of polls further apart than this (feed gap, not a jump). */
const MAX_POLL_GAP_MS = 20_000;
const DWELL_WINDOW_MS = 14 * 86_400_000;
const DWELL_LOW_QUANTILE = 0.35;
const DWELL_LOW_MIN_SAMPLES = 5;

const net = loadNet();
const { db, network } = net;
registerRoutePaths(net.routePaths);

type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const pos = db
  .prepare(`SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
            FROM raw_positions ORDER BY collected_at, id`)
  .all() as PosRow[];
const rawStart = pos[0]!.t;
const rawEnd = pos[pos.length - 1]!.t;
log(`raw positions ${pos.length}, ${fmtEt(rawStart)} .. ${fmtEt(rawEnd)} ET`);

// -- served payload (segments + dwells), time-travelled per hour --------------
const samples = loadSamples(net, rawStart - SEGMENT_WINDOW_MS - 3_600_000, rawEnd + 3_600_000);
const calibCache = makeCalibCache(samples, network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));
const segCache = new Map<string, SegmentTimes>();
function segmentsAt(t: number): SegmentTimes {
  const bs = calibCache.bucketStart(t);
  let p = segCache.get(String(bs));
  if (!p) {
    const bc = calibCache.get(bs);
    const st: SegmentTimes = {};
    for (const r of net.routes) st[String(r.id)] = segmentTimesFor(adjByRoute.get(r.id)!, serveRoute(adjByRoute.get(r.id)!, bc.byName.base));
    segCache.set(String(bs), (p = st));
  }
  return p;
}
interface DwellGroup { at: Float64Array; done: Float64Array; sec: Float64Array; dow: Int8Array; hour: Int8Array }
const dwellGroups = new Map<string, DwellGroup>();
{
  const rows = db
    .prepare(`SELECT route_id r, stop_id s, arrived_at a, dwell_sec d, dow, hour FROM arrivals
              WHERE dwell_sec IS NOT NULL AND arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at`)
    .all(rawStart - DWELL_WINDOW_MS - 3_600_000, rawEnd) as Array<{ r: number; s: number; a: number; d: number; dow: number; hour: number }>;
  const tmp = new Map<string, Array<{ a: number; d: number; dow: number; hour: number }>>();
  for (const x of rows) {
    const k = `${x.r}:${x.s}`;
    let l = tmp.get(k);
    if (!l) tmp.set(k, (l = []));
    l.push(x);
  }
  for (const [k, l] of tmp) dwellGroups.set(k, {
    at: Float64Array.from(l.map((x) => x.a)), done: Float64Array.from(l.map((x) => x.a + x.d * 1000)),
    sec: Float64Array.from(l.map((x) => x.d)), dow: Int8Array.from(l.map((x) => x.dow)), hour: Int8Array.from(l.map((x) => x.hour)),
  });
}
function pct(a: number[], q: number): number {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
const dwellCache = new Map<string, DwellTimes>();
function dwellsAt(t: number): DwellTimes {
  const start = calibCache.bucketStart(t);
  const hit = dwellCache.get(String(start));
  if (hit) return hit;
  const d = new Date(start);
  const dow = d.getDay();
  const hours = new Set([(d.getHours() + 23) % 24, d.getHours(), (d.getHours() + 1) % 24]);
  const out: DwellTimes = {};
  for (const [key, g] of dwellGroups) {
    const [rid, sid] = key.split(":");
    const all: number[] = [];
    const win: number[] = [];
    for (let i = 0; i < g.at.length; i++) {
      if (g.at[i]! < start - DWELL_WINDOW_MS || g.done[i]! > start) continue;
      all.push(g.sec[i]!);
      if (g.dow[i] === dow && hours.has(g.hour[i]!)) win.push(g.sec[i]!);
    }
    if (!all.length) continue;
    const low = all.length >= DWELL_LOW_MIN_SAMPLES ? pct(all, DWELL_LOW_QUANTILE) : undefined;
    const src = win.length ? win : all;
    const med = median(src);
    const stat = { med, sd: Math.max(pct(src, 0.9) - med, 5), n: win.length, ...(low !== undefined ? { low: Math.min(low, med) } : {}) };
    (out[rid!] ||= {})[sid!] = stat;
  }
  dwellCache.set(String(start), out);
  return out;
}

// -- polls ---------------------------------------------------------------------
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

// -- truth, for the accuracy guard rail ---------------------------------------
interface DetEv { s: number; t: number }
const detSeq = new Map<string, DetEv[]>();
{
  const rows = db.prepare(`SELECT bus_name b, stop_id s, arrived_at t FROM arrivals
                           WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at, id`)
    .all(rawStart - 3_600_000, rawEnd + 45 * 60_000) as Array<{ b: string; s: number; t: number }>;
  for (const a of rows) {
    let l = detSeq.get(a.b);
    if (!l) detSeq.set(a.b, (l = []));
    l.push({ s: a.s, t: a.t });
  }
}
/** Next time this bus reaches this stop after t, or null. */
function nextArrival(busName: string, stopId: number, t: number): number | null {
  const seq = detSeq.get(busName);
  if (!seq) return null;
  let lo = 0, hi = seq.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (seq[m]!.t <= t) lo = m + 1; else hi = m; }
  for (let i = lo; i < seq.length; i++) {
    if (seq[i]!.t - t > 45 * 60_000) return null;
    if (seq[i]!.s === stopId) return seq[i]!.t;
  }
  return null;
}


// -- classify ------------------------------------------------------------------
const JUMP_LEVELS = [60, 120, 300] as const;

/** Any detector arrival for this bus strictly inside (t0, t1]. */
function arrivalBetween(busName: string, t0: number, t1: number): boolean {
  const seq = detSeq.get(busName);
  if (!seq) return false;
  let lo = 0, hi = seq.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (seq[m]!.t <= t0) lo = m + 1; else hi = m; }
  return lo < seq.length && seq[lo]!.t <= t1;
}

interface Snap {
  contended: Set<string>;
  eta: Map<string, number>;
  bus: Map<string, { lat: number; lon: number; atStopId: number | null; atStopSince: number | null; anchor: number; routeId: number; lastStopId: number | null }>;
  t: number;
  bucket: number;
}
type Klass = "real: arrival or departure" | "real: moved >=100 m" | "twitch: moved <100 m" | "EVENTLESS: fix identical";

const tally: Record<number, Record<Klass, number>> = {};
const jumpSizes: Record<Klass, number[]> = { "real: arrival or departure": [], "real: moved >=100 m": [], "twitch: moved <100 m": [], "EVENTLESS: fix identical": [] };
for (const L of JUMP_LEVELS) tally[L] = { "real: arrival or departure": 0, "real: moved >=100 m": 0, "twitch: moved <100 m": 0, "EVENTLESS: fix identical": 0 };
/** For the eventless population: what else changed that could explain it? */
const eventlessWhy: Record<string, number> = {};
const eventlessExamples: any[] = [];
const twitchMoves: number[] = [];
const twitchByRoute: Record<number, number> = {};
const twitchWhy: Record<string, number> = {};
const eventlessByRoute: Record<number, number> = {};
let transitions = 0;
let contendedPolls = 0;
const eventlessContended = { yes: 0, no: 0 };
const twitchContended = { yes: 0, no: 0 };

const states = new Map<string, BusState>();
let prev: Snap | null = null;

for (let pi = 0; pi < polls.length; pi++) {
  const poll = polls[pi]!;
  const plan = planTracks(poll);
  stepMany(network, states, poll, plan);
  const t = poll[0]!.collectedAt;
  const segs = segmentsAt(t);
  const dw = dwellsAt(t);

  const buses: BusData[] = [];
  const busDiag: Snap["bus"] = new Map();
  // Two bus_ids can report one bus_name in the same poll (CLAUDE.md: #43 did
  // it for 6.7 h). The client keys arrivals by NAME, so both physical buses
  // collide onto one series -- for the rider AND for this harness.
  const idsPerName = new Map<string, Set<number>>();
  for (const o of poll) {
    const n = o.busName.replace("#", "");
    let ids = idsPerName.get(n);
    if (!ids) idsPerName.set(n, (ids = new Set()));
    ids.add(o.busId);
  }
  const contended = new Set([...idsPerName].filter(([, v]) => v.size > 1).map(([k]) => k));
  contendedPolls += contended.size;
  for (const o of poll) {
    const key = plan.keys.get(o.busId) ?? o.busName;
    const st = states.get(key);
    const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
    const cand = st && dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
    const at = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.enteredAt } : null;
    const bus: BusData = {
      bus_id: o.busId, bus_name: o.busName, route_id: o.routeId, lat: o.lat, lon: o.lon, heading: o.heading,
      last_stop_id: o.lastStopId as number, stationary: at != null,
      ...(at ? { at_stop_id: at.id, at_stop_since: new Date(at.since).toISOString().replace(/Z$/, "") } : {}),
    };
    buses.push(bus);
    const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(o.routeId));
    let anchor = -1;
    if (cfg) {
      const stops = mergedRouteStops(cfg, net.routeStops);
      if (isBusOnRoute(bus, stops, net.stopCoords)) anchor = findRouteAnchor(bus, stops, net.stopCoords);
    }
    busDiag.set(o.busName.replace("#", ""), { lat: o.lat, lon: o.lon, atStopId: at ? at.id : null, atStopSince: at ? at.since : null, anchor, routeId: o.routeId, lastStopId: o.lastStopId });
  }

  const targets = new Set<number>();
  for (const cfg of ROUTE_LISTS) {
    if (!buses.some((b) => cfg.busRouteIds.includes(b.route_id))) continue;
    for (const s2 of mergedRouteStops(cfg, net.routeStops)) targets.add(s2);
  }
  const arrivals = computeUpcomingArrivals([...targets], buses, net.routeStops, net.stopCoords, segs, t, dw);
  const eta = new Map<string, number>();
  for (const a of arrivals) {
    const k = `${a.busName}|${a.stopId}`;
    const c = eta.get(k);
    if (c === undefined || a.eta < c) eta.set(k, a.eta);
  }
  const snap: Snap = { contended, eta, bus: busDiag, t, bucket: calibCache.bucketStart(t) };

  if (prev && t - prev.t > 0 && t - prev.t <= MAX_POLL_GAP_MS) {
    const dt = (t - prev.t) / 1000;
    for (const [k, e1] of eta) {
      const e0 = prev.eta.get(k);
      if (e0 === undefined) continue;
      transitions++;
      const jump = e1 - e0 + dt;
      const mag = Math.abs(jump);
      if (mag < JUMP_LEVELS[0]) continue;
      const [busName, sidStr] = k.split("|");
      const d0 = prev.bus.get(busName!);
      const d1 = snap.bus.get(busName!);
      if (!d0 || !d1) continue;
      const moved = distanceMeters(d0, d1);
      const realEvent = arrivalBetween(`#${busName}`, prev.t, t) || d0.atStopId !== d1.atStopId;
      const klass: Klass = realEvent ? "real: arrival or departure"
        : moved >= 100 ? "real: moved >=100 m"
        : moved > 0 ? "twitch: moved <100 m"
        : "EVENTLESS: fix identical";
      for (const L of JUMP_LEVELS) if (mag >= L) tally[L]![klass]++;
      if (mag >= 300) {
        jumpSizes[klass].push(mag);
        if (klass === "twitch: moved <100 m") {
          const w = d0.anchor !== d1.anchor
            ? (d0.lastStopId !== d1.lastStopId ? "anchor moved, and last_stop_id moved with it" : "anchor moved on GPS alone (a 30-90 m twitch relocated the bus)")
            : (d0.lastStopId !== d1.lastStopId ? "last_stop_id moved, anchor held" : "neither anchor nor last_stop_id moved");
          twitchWhy[w] = (twitchWhy[w] ?? 0) + 1;
          twitchContended[snap.contended.has(busName!) || prev.contended.has(busName!) ? "yes" : "no"]++; twitchMoves.push(moved); twitchByRoute[d1.routeId] = (twitchByRoute[d1.routeId] ?? 0) + 1; }
        if (klass === "EVENTLESS: fix identical") {
          eventlessByRoute[d1.routeId] = (eventlessByRoute[d1.routeId] ?? 0) + 1;
          // Nothing moved. So what DID change between the two recomputes?
          const isContended = snap.contended.has(busName!) || prev.contended.has(busName!);
          eventlessContended[isContended ? "yes" : "no"]++;
          const why = isContended ? "TWO BUSES SHARE THIS NAME (bus_id collision)"
            : d0.lastStopId !== d1.lastStopId ? "feed's last_stop_id advanced while the GPS fix was frozen"
            : snap.bucket !== prev.bucket ? "calibration bucket rolled"
            : d0.atStopSince !== d1.atStopSince ? "at_stop_since changed (layover clock)"
            : d0.anchor !== d1.anchor ? "client anchor changed on an identical fix"
            : "only the clock advanced";
          eventlessWhy[why] = (eventlessWhy[why] ?? 0) + 1;
          if (eventlessExamples.length < 12) eventlessExamples.push({
            at: fmtEt(t), bus: busName, route: ROUTE_ID_LABEL[d1.routeId] ?? d1.routeId,
            stop: net.stopById.get(Number(sidStr))?.name ?? sidStr,
            shown: `${fmtMin(e0)} -> ${fmtMin(e1)}`, jumpSec: Math.round(jump), why,
            anchor: `${d0.anchor}->${d1.anchor}`, atStop: `${d0.atStopId}->${d1.atStopId}`,
          });
        }
      }
    }
  }
  prev = snap;
  if (pi % 800 === 0) log(`poll ${pi}/${polls.length}`);
}

const q2 = (a: number[], p: number) => (a.length ? Math.round(pct(a, p) * 10) / 10 : null);
const share = (n: number, d: number) => Math.round((1000 * n) / Math.max(1, d)) / 10;
const out: any = {
  generatedAt: new Date().toISOString(),
  window: { start: fmtEt(rawStart), end: fmtEt(rawEnd) },
  question: "of the jumps this size, how many had a real-world event behind them?",
  transitions,
  byLevel: Object.fromEntries(JUMP_LEVELS.map((L) => {
    const t2 = tally[L]!;
    const total = Object.values(t2).reduce((a, b) => a + b, 0);
    return [`>=${L}s`, { total, pctOfTransitions: share(total, transitions), breakdown: Object.fromEntries(Object.entries(t2).map(([k, v]) => [k, { n: v, pct: share(v, total) }])) }];
  })),
  jumpSizeByClass: Object.fromEntries(Object.entries(jumpSizes).map(([k, v]) => [k, { n: v.length, p50: q2(v, 0.5), p90: q2(v, 0.9), p99: q2(v, 0.99) }])),
  twitch: { why: twitchWhy, moveM: { p50: q2(twitchMoves, 0.5), p90: q2(twitchMoves, 0.9), max: q2(twitchMoves, 1) }, byRoute: Object.fromEntries(Object.entries(twitchByRoute).map(([r, n]) => [ROUTE_ID_LABEL[Number(r)] ?? r, n])) },
  nameCollisions: { contendedNameInstances: contendedPolls, eventlessOnContendedName: eventlessContended, twitchOnContendedName: twitchContended },
  eventless: { why: eventlessWhy, byRoute: Object.fromEntries(Object.entries(eventlessByRoute).map(([r, n]) => [ROUTE_ID_LABEL[Number(r)] ?? r, n])), examples: eventlessExamples },
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/jitter-classify.json`, JSON.stringify(out, null, 1));
log(`wrote ${OUT_DIR}/jitter-classify.json`);
console.log(`transitions ${transitions}`);
for (const L of JUMP_LEVELS) {
  const b = out.byLevel[`>=${L}s`];
  console.log(`\njumps >= ${L}s: ${b.total} (${b.pctOfTransitions}% of transitions)`);
  for (const [k, v] of Object.entries(b.breakdown) as any) console.log(`   ${k.padEnd(30)} ${String(v.n).padStart(6)}  ${v.pct}%`);
}
console.log("\njump size by class (>=300s):", JSON.stringify(out.jumpSizeByClass, null, 1));
console.log("\ntwitch displacement (m):", JSON.stringify(out.twitch.moveM), "\n  by route:", JSON.stringify(out.twitch.byRoute));
console.log("  twitch mechanism:", JSON.stringify(out.twitch.why, null, 1));
console.log("\nname collisions:", JSON.stringify(out.nameCollisions));
console.log("\neventless — what changed:", JSON.stringify(out.eventless.why, null, 1));
console.log("eventless by route:", JSON.stringify(out.eventless.byRoute));
console.log("\neventless examples:");
for (const e of out.eventless.examples.slice(0, 8)) console.log(`  ${e.at} ${String(e.route).padEnd(11)} #${e.bus} ${String(e.shown).padEnd(18)} ${String(e.jumpSec).padStart(6)}s  ${e.why}  anchor ${e.anchor}  atStop ${e.atStop}  @${e.stop}`);

