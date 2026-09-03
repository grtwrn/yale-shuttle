/**
 * ARM COMPARISON: does the corroborated anchor remove the jumps that no event
 * caused, and does smoothing the GPS add anything?
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
import { pruneAnchors, type AnchorStore } from "../../web/src/anchorGate";


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



// -- arms ----------------------------------------------------------------------
// shipped     production today
// gated       the corroborated anchor (web/src/anchorGate.ts)
// ema15/30    exponential smoothing of raw lat/lon before anchoring, tau in s.
//             The operator asked whether EMA is worth doing before a Kalman
//             filter; this is the arm that answers it with a number.
// gatedEma30  both, to see whether smoothing adds anything ON TOP of gating.
const ALL_ARMS = ["shipped", "gated", "ema15", "ema30", "gatedEma30"] as const;
const ONLY = process.env.ONLY_ARMS?.split(",");
const ARMS = (ONLY ? ALL_ARMS.filter((a) => ONLY.includes(a)) : ALL_ARMS) as unknown as readonly (typeof ALL_ARMS)[number][];
type Arm = (typeof ALL_ARMS)[number];
const EMA_TAU: Partial<Record<Arm, number>> = { ema15: 15, ema30: 30, gatedEma30: 30 };
const GATED: Arm[] = ["gated", "gatedEma30"];

interface EmaState { lat: number; lon: number; t: number }
const emaState: Record<string, Map<string, EmaState>> = {};
for (const a of ALL_ARMS) emaState[a] = new Map();
const anchorStores: Record<string, AnchorStore> = {};
for (const a of ALL_ARMS) anchorStores[a] = new Map();

/** Exponential smoothing with a time constant, so it is poll-rate independent. */
function emaPos(arm: Arm, key: string, lat: number, lon: number, t: number): { lat: number; lon: number } {
  const tau = EMA_TAU[arm];
  if (!tau) return { lat, lon };
  const st = emaState[arm]!.get(key);
  if (!st || t - st.t > 120_000 || t <= st.t) {
    emaState[arm]!.set(key, { lat, lon, t });
    return { lat, lon };
  }
  const alpha = 1 - Math.exp(-(t - st.t) / 1000 / tau);
  const nl = st.lat + alpha * (lat - st.lat);
  const no = st.lon + alpha * (lon - st.lon);
  emaState[arm]!.set(key, { lat: nl, lon: no, t });
  return { lat: nl, lon: no };
}

function arrivalBetween(busName: string, t0: number, t1: number): boolean {
  const seq = detSeq.get(busName);
  if (!seq) return false;
  let lo = 0, hi = seq.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (seq[m]!.t <= t0) lo = m + 1; else hi = m; }
  return lo < seq.length && seq[lo]!.t <= t1;
}

type Klass = "real: arrival or departure" | "real: moved >=100 m" | "twitch: moved <100 m" | "EVENTLESS: fix identical";
interface Snap {
  eta: Map<string, number>;
  bus: Map<string, { lat: number; lon: number; rawLat: number; rawLon: number; atStopId: number | null; routeId: number }>;
  t: number;
}
interface S {
  jumps: number[]; n: number; unchanged: number; up: number;
  /** eta by `${bus}|${stop}` at each poll, kept so departures can be scored. */
  etaNow: Map<string, number>;
  klass: Record<Klass, number>;
  bigByRoute: Record<number, { big: number; n: number }>;
  errs: number[];
  prev: Snap | null;
}
const mk = (): S => ({ jumps: [], n: 0, unchanged: 0, up: 0, etaNow: new Map(), klass: { "real: arrival or departure": 0, "real: moved >=100 m": 0, "twitch: moved <100 m": 0, "EVENTLESS: fix identical": 0 }, bigByRoute: {}, errs: [], prev: null });
const stats: Record<Arm, S> = Object.fromEntries(ALL_ARMS.map((a) => [a, mk()])) as any;

const states = new Map<string, BusState>();
const ACC_STRIDE = 12;

/**
 * DEPARTURE LAG. The operator's hard constraint: "it can go 5->1 if it leaves
 * early". So for every real departure (the collector's at_stop_id going
 * non-null -> null) we watch the next 60 s and record, per arm, how the ETA
 * compares with production's. A positive mean is the gate WITHHOLDING a
 * correction the rider needed, and fails the arm no matter what its jump
 * numbers say.
 */
const DEPARTURE_WATCH_MS = 60_000;
interface Watch { bus: string; until: number; }
const watches: Watch[] = [];
const prevAtStop = new Map<string, number | null>();
/** arm -> list of (etaArm - etaShipped) inside a departure window. */
const departureDelta: Record<string, number[]> = {};
for (const a of ALL_ARMS) departureDelta[a] = [];

for (let pi = 0; pi < polls.length; pi++) {
  const poll = polls[pi]!;
  const plan = planTracks(poll);
  stepMany(network, states, poll, plan);
  const t = poll[0]!.collectedAt;
  const segs = segmentsAt(t);
  const dw = dwellsAt(t);
  const scoreAcc = pi % ACC_STRIDE === 0;

  // Departure detection runs once per poll on the collector's own state, not
  // per arm, so every arm is scored on the SAME set of departures.
  for (const o of poll) {
    const key = plan.keys.get(o.busId) ?? o.busName;
    const st = states.get(key);
    const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
    const cand = st && dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
    const nowAt = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? st.nearestStopId : null;
    const was = prevAtStop.get(o.busName);
    if (was !== undefined && was !== null && nowAt === null) {
      watches.push({ bus: o.busName.replace("#", ""), until: t + DEPARTURE_WATCH_MS });
    }
    prevAtStop.set(o.busName, nowAt);
  }
  while (watches.length && watches[0]!.until < t) watches.shift();
  const watching = new Set(watches.map((w) => w.bus));

  for (const arm of ARMS) {
    const S0 = stats[arm];
    const buses: BusData[] = [];
    const diag: Snap["bus"] = new Map();
    for (const o of poll) {
      const key = plan.keys.get(o.busId) ?? o.busName;
      const st = states.get(key);
      const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
      const cand = st && dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
      const at = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.enteredAt } : null;
      const p = emaPos(arm, o.busName, o.lat, o.lon, o.collectedAt);
      buses.push({
        bus_id: o.busId, bus_name: o.busName, route_id: o.routeId, lat: p.lat, lon: p.lon, heading: o.heading,
        last_stop_id: o.lastStopId as number, stationary: at != null,
        ...(at ? { at_stop_id: at.id, at_stop_since: new Date(at.since).toISOString().replace(/Z$/, "") } : {}),
      });
      diag.set(o.busName.replace("#", ""), { lat: p.lat, lon: p.lon, rawLat: o.lat, rawLon: o.lon, atStopId: at ? at.id : null, routeId: o.routeId });
    }
    const targets = new Set<number>();
    for (const cfg of ROUTE_LISTS) {
      if (!buses.some((b) => cfg.busRouteIds.includes(b.route_id))) continue;
      for (const s2 of mergedRouteStops(cfg, net.routeStops)) targets.add(s2);
    }
    const store = GATED.includes(arm) ? anchorStores[arm] : undefined;
    if (store) pruneAnchors(store, t);
    const arrivals = computeUpcomingArrivals([...targets], buses, net.routeStops, net.stopCoords, segs, t, dw, store);
    const eta = new Map<string, number>();
    for (const a of arrivals) {
      const k = `${a.busName}|${a.stopId}`;
      const c = eta.get(k);
      if (c === undefined || a.eta < c) eta.set(k, a.eta);
    }
    const snap: Snap = { eta, bus: diag, t };
    const prev = S0.prev;
    if (prev && t - prev.t > 0 && t - prev.t <= MAX_POLL_GAP_MS) {
      const dt = (t - prev.t) / 1000;
      for (const [k, e1] of eta) {
        const e0 = prev.eta.get(k);
        if (e0 === undefined) continue;
        S0.n++;
        const jump = e1 - e0 + dt;
        S0.jumps.push(jump);
        if (e1 === e0) S0.unchanged++;
        if (e1 > e0 + 1) S0.up++;
        const [busName, sidStr] = k.split("|");
        const d0 = prev.bus.get(busName!);
        const d1 = snap.bus.get(busName!);
        const rid = d1?.routeId ?? -1;
        (S0.bigByRoute[rid] ||= { big: 0, n: 0 }).n++;
        if (Math.abs(jump) >= 300 && d0 && d1) {
          S0.bigByRoute[rid]!.big++;
          // Classify on the RAW fix, always -- the question is what the world
          // did, and a smoothed coordinate is our invention, not evidence.
          const movedRaw = distanceMeters({ lat: d0.rawLat, lon: d0.rawLon }, { lat: d1.rawLat, lon: d1.rawLon });
          const real = arrivalBetween(`#${busName}`, prev.t, t) || d0.atStopId !== d1.atStopId;
          const kl: Klass = real ? "real: arrival or departure"
            : movedRaw >= 100 ? "real: moved >=100 m"
            : movedRaw > 0 ? "twitch: moved <100 m"
            : "EVENTLESS: fix identical";
          S0.klass[kl]++;
        }
        if (scoreAcc) {
          const truth = nextArrival(`#${busName}`, Number(sidStr), t);
          if (truth !== null) S0.errs.push(e1 - (truth - t) / 1000);
        }
      }
    }
    S0.etaNow = eta;
    S0.prev = snap;
  }
  if (watching.size && stats.shipped.etaNow.size) {
    for (const arm of ARMS) {
      if (arm === "shipped") continue;
      for (const [k, v] of stats[arm].etaNow) {
        const busName = k.slice(0, k.indexOf("|"));
        if (!watching.has(busName)) continue;
        const b = stats.shipped.etaNow.get(k);
        if (b === undefined) continue;
        departureDelta[arm]!.push(v - b);
      }
    }
  }
  if (pi % 800 === 0) log(`poll ${pi}/${polls.length}`);
}

const q2 = (a: number[], p: number) => (a.length ? Math.round(pct(a, p) * 10) / 10 : null);
const absOf = (a: number[]) => a.map(Math.abs);
const rate = (a: number[], th: number) => Math.round((1000 * a.filter((x) => Math.abs(x) >= th).length) / Math.max(1, a.length)) / 10;
const FOLD = new Set([9, 10, 8]); // Green, Purple, Pink -- the folding routes
const out: any = { generatedAt: new Date().toISOString(), window: { start: fmtEt(rawStart), end: fmtEt(rawEnd) }, arms: {} };
for (const arm of ARMS) {
  const S0 = stats[arm];
  const foldBig = Object.entries(S0.bigByRoute).filter(([r]) => FOLD.has(Number(r))).reduce((a, [, v]) => ({ big: a.big + v.big, n: a.n + v.n }), { big: 0, n: 0 });
  const restBig = Object.entries(S0.bigByRoute).filter(([r]) => !FOLD.has(Number(r))).reduce((a, [, v]) => ({ big: a.big + v.big, n: a.n + v.n }), { big: 0, n: 0 });
  out.arms[arm] = {
    transitions: S0.n,
    absJump: { p50: q2(absOf(S0.jumps), 0.5), p90: q2(absOf(S0.jumps), 0.9), p99: q2(absOf(S0.jumps), 0.99), p999: q2(absOf(S0.jumps), 0.999) },
    rates: { over60: rate(S0.jumps, 60), over120: rate(S0.jumps, 120), over300: rate(S0.jumps, 300) },
    big300: S0.jumps.filter((x) => Math.abs(x) >= 300).length,
    klass: S0.klass,
    foldingRoutes: { transitions: foldBig.n, big: foldBig.big, pct: Math.round((1000 * foldBig.big) / Math.max(1, foldBig.n)) / 10 },
    otherRoutes: { transitions: restBig.n, big: restBig.big, pct: Math.round((1000 * restBig.big) / Math.max(1, restBig.n)) / 10 },
    byRoute: Object.fromEntries(Object.entries(S0.bigByRoute).filter(([, v]) => v.n > 500).map(([r, v]) => [ROUTE_ID_LABEL[Number(r)] ?? r, { big: v.big, pct: Math.round((1000 * v.big) / v.n) / 10 }])),
    frozenPct: Math.round((1000 * S0.unchanged) / Math.max(1, S0.n)) / 10,
    countdownUpPct: Math.round((1000 * S0.up) / Math.max(1, S0.n)) / 10,
    departureLag: (() => {
      const d = departureDelta[arm]!;
      return d.length
        ? { n: d.length, meanSec: Math.round((d.reduce((a, b) => a + b, 0) / d.length) * 10) / 10, p50: q2(d, 0.5), p90: q2(d, 0.9), worseShare: Math.round((1000 * d.filter((x) => x > 5).length) / d.length) / 10 }
        : null;
    })(),
    accuracy: { n: S0.errs.length, medianAbsSec: q2(absOf(S0.errs), 0.5), meanSignedSec: S0.errs.length ? Math.round((S0.errs.reduce((a, b) => a + b, 0) / S0.errs.length) * 10) / 10 : null },
  };
}
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/arm-compare.json`, JSON.stringify(out, null, 1));
log(`wrote ${OUT_DIR}/arm-compare.json`);
const base = out.arms.shipped ?? { big300: 0 };
console.log("arm          >=300s        vs base   twitch  eventless   fold%   other%   accMed  accMean  frozen%");
for (const arm of ARMS) {
  const a = out.arms[arm];
  const d = Math.round((100 * (a.big300 - base.big300)) / Math.max(1, base.big300));
  console.log(
    arm.padEnd(12),
    String(a.big300).padStart(6), `(${a.rates.over300}%)`.padStart(8),
    `${d >= 0 ? "+" : ""}${d}%`.padStart(8),
    String(a.klass["twitch: moved <100 m"]).padStart(7),
    String(a.klass["EVENTLESS: fix identical"]).padStart(10),
    String(a.foldingRoutes.pct).padStart(7),
    String(a.otherRoutes.pct).padStart(8),
    String(a.accuracy.medianAbsSec).padStart(8),
    String(a.accuracy.meanSignedSec).padStart(8),
    String(a.frozenPct).padStart(8),
  );
}
console.log("\ndeparture lag -- eta minus production's, inside 60 s of a real departure");
console.log("(positive = the arm is withholding a correction the rider needed)");
for (const arm of ARMS) {
  const d = out.arms[arm].departureLag;
  if (!d) { console.log(`  ${arm.padEnd(12)} (baseline)`); continue; }
  console.log(`  ${arm.padEnd(12)} n=${String(d.n).padStart(6)}  mean=${String(d.meanSec).padStart(7)}s  p50=${String(d.p50).padStart(6)}s  p90=${String(d.p90).padStart(7)}s  later-than-production on ${d.worseShare}% of polls`);
}

