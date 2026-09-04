/**
 * JITTER AUDIT: an independent re-derivation of the jump classification, and
 * a paired scorer for candidate fixes.
 *
 * The claim under audit (jitter-classify.ts, 2026-09-03): of 16,128 ETA jumps
 * >= 300 s over 1.59 M (bus, stop) transitions, 49.2% coincide with a detector
 * arrival / at-stop flip, 4.4% with movement >= 100 m, 43.7% with a "twitch"
 * under 100 m and 2.7% with a byte-identical fix — so 46.4% "have no
 * real-world event behind them".
 *
 * This script replays the same client (`computeUpcomingArrivals`, unmodified)
 * over the same snapshot and reproduces that split with the SAME rules, then
 * explains every big jump a second way — MECHANICALLY, from the anchor the ETA
 * actually used on the identical BusData:
 *
 *   wrap      the anchor advanced past THIS stop, so its ETA went from "now"
 *             to a lap later. Correct information (the bus went by).
 *   advance   the anchor advanced +1/+2 and this stop is still ahead: the
 *             first hop was re-priced (old segment dropped, new proration).
 *   flip      the anchor moved by anything but 0/+1/+2 — the fold-back
 *             relocation. Affects every stop of the route at once.
 *   atstop    anchor held; the at-stop flag set/cleared (stall credit on/off).
 *   clock     anchor held, same stop; at_stop_since restarted.
 *   proration anchor held, no flag change; the fix moved so the chord
 *             projection moved.
 *   calib     nothing else changed; the calibration bucket rolled.
 *
 * and counts INCIDENTS (one bus, one poll pair) as well as per-stop jumps,
 * because one anchor flip on a 33-stop route is 33 "jumps".
 *
 * Also puts each displacement in context: the bus's net movement over the
 * two minutes around the transition, and its speed. At a 5 s poll a bus
 * driving 8 m/s reports a 40 m displacement — "under 100 m" is not a twitch.
 *
 * ARMS (paired against shipped on every transition):
 *   ARM=gate     PR #72's corroborated anchor — needs a tree where
 *                computeUpcomingArrivals takes an AnchorStore.
 *   ARM=belief   the kalman worktree's beliefFull (filter leg + progress +
 *                standing mode) via _arrivals-anchored-kalman.ts.
 * Plus, for every arm, a DEPARTURE TRACE: at each production departure
 * (at_stop_id non-null -> null) the arm's next-stop ETA minus shipped's for
 * the following six polls, and whether the arm's number fell in the same poll.
 *
 * And a replay of the trip card's "next in" rule (PR #74): the old
 * `eta > pinned + 30` filter against the identity-based one, on shipped ETAs.
 *
 * Env:
 *   REPLAY_DB   snapshot (default ./store/snap.db)
 *   SINCE       stationary | entered   what at_stop_since is built from.
 *               Production serves `stationarySince` (collector.ts). The
 *               earlier harnesses used `enteredAt`.
 *   DETECTOR    new | pre57            which detector replays the feed
 *   ARM         none | gate | belief | guard | anchor
 *   SHIPPED_SRC ARM=anchor: master's web/src (git archive) as the shipped series
 *   ARM_SRC     ARM=anchor: the arm's web/src (default: this tree)
 *   STORE       ARM=anchor: 1 = each series keeps an AnchorStore (production), 0 = stateless
 *   OUT_NAME    output file stem (default jitter-audit)
 *
 *   TZ=America/New_York REPLAY_DB=./store/snap.db npx tsx scripts/eta-replay/jitter-audit.ts
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
import * as detNew from "../../src/collector/detector.js";
import * as detOld from "./_detector-pre57.js";
import type { BusObservation, BusState } from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { median } from "../../src/calibrator/shrinkage.js";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes, type UpcomingArrival } from "../../web/src/arrivals";
import { findRouteAnchor, isBusOnRoute, registerRoutePaths } from "../../web/src/anchor";
import type { BusData } from "../../web/src/map-data";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const SINCE = (process.env.SINCE ?? "stationary") as "stationary" | "entered";
const DETECTOR = (process.env.DETECTOR ?? "new") as "new" | "pre57";
const ARM = (process.env.ARM ?? "none") as "none" | "gate" | "belief" | "guard" | "anchor";
const OUT_NAME = process.env.OUT_NAME ?? "jitter-audit";
const det = DETECTOR === "pre57" ? detOld : detNew;

// Arm-specific modules, loaded only when asked for so the script runs on any tree.
let beliefMod: { buildGeometry: any; projectOnLeg: any; step: any } | null = null;
let anchoredMod: { computeUpcomingArrivalsAnchored: any } | null = null;
/** ARM=guard: PR #75's rider-facing stability guard, passed as the 9th argument on that tree. */
let guardObj: any = null;
if (ARM === "guard") {
  const g = await import("../../web/src/etaStability");
  guardObj = g.createEtaGuard();
}
if (ARM === "belief") {
  beliefMod = await import("./progress-filter.js");
  anchoredMod = await import("./_arrivals-anchored-kalman.js");
}

/**
 * ARM=anchor: pair two CLIENT TREES against each other — a change to
 * `findRouteAnchor` / `gateAnchor` cannot be switched on by an argument, so
 * the "shipped" series is imported from a git-archived copy of master's
 * `web/src` (SHIPPED_SRC, required) and the "arm" series from this tree, or
 * from a second archive (ARM_SRC). Both series run through their own
 * `computeUpcomingArrivals` with their own `AnchorStore` (STORE=1, the default
 * since PR #72 — production always passes `liveAnchorStore`; STORE=0 scores
 * the stateless anchor, which the map's route position still uses directly).
 *
 * Replica check: point SHIPPED_SRC and ARM_SRC at the SAME commit and
 * `armMismatches` must be 0 — the dynamic import is then provably the real
 * function, not a replica of it.
 *
 *   mkdir -p /tmp/shipped && git archive <commit> services/shuttle-v2/web/src | tar -x -C /tmp/shipped
 *   ARM=anchor SHIPPED_SRC=/tmp/shipped/services/shuttle-v2/web/src TZ=America/New_York npx tsx scripts/eta-replay/jitter-audit.ts
 */
interface ClientTree { compute: any; findRouteAnchor: any; isBusOnRoute: any; pruneAnchors: any; registerRoutePaths: any }
async function loadTree(dir: string | undefined): Promise<ClientTree> {
  if (!dir) {
    const g = await import("../../web/src/anchorGate");
    return { compute: computeUpcomingArrivals, findRouteAnchor, isBusOnRoute, pruneAnchors: g.pruneAnchors, registerRoutePaths };
  }
  const a = await import(`${dir}/arrivals.ts`);
  const an = await import(`${dir}/anchor.ts`);
  const g = await import(`${dir}/anchorGate.ts`);
  return { compute: a.computeUpcomingArrivals, findRouteAnchor: an.findRouteAnchor, isBusOnRoute: an.isBusOnRoute, pruneAnchors: g.pruneAnchors, registerRoutePaths: an.registerRoutePaths };
}
const USE_STORE = (process.env.STORE ?? "1") === "1";
let treeS: ClientTree | null = null;
let treeA: ClientTree | null = null;
if (ARM === "anchor") {
  if (!process.env.SHIPPED_SRC) throw new Error("ARM=anchor needs SHIPPED_SRC=<dir of master's web/src>");
  treeS = await loadTree(process.env.SHIPPED_SRC);
  treeA = await loadTree(process.env.ARM_SRC);
}
const storeS: Map<string, any> | undefined = ARM === "anchor" && USE_STORE ? new Map() : undefined;
const storeA: Map<string, any> | undefined = ARM === "anchor" && USE_STORE ? new Map() : undefined;
let armMismatches = 0;
let armCompared = 0;

const AT_STOP_MAX_M = 75;
const MAX_POLL_GAP_MS = 20_000;
const LEVELS = [120, 180, 300, 600] as const;
const RECORD_FROM = 120;
/** Net-movement context window either side of the transition. */
const NET_WIN_MS = 60_000;
const DEPART_POLLS = 6;
const DWELL_WINDOW_MS = 14 * 86_400_000;
const DWELL_LOW_QUANTILE = 0.35;
const DWELL_LOW_MIN_SAMPLES = 5;

const net = loadNet();
const { db, network } = net;
registerRoutePaths(net.routePaths);
// Each imported tree keeps its own module-level polyline table for isBusOnRoute.
treeS?.registerRoutePaths(net.routePaths);
treeA?.registerRoutePaths(net.routePaths);

type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const pos = db
  .prepare(`SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
            FROM raw_positions ORDER BY collected_at, id`)
  .all() as PosRow[];
const rawStart = pos[0]!.t;
const rawEnd = pos[pos.length - 1]!.t;
log(`raw positions ${pos.length}, ${fmtEt(rawStart)} .. ${fmtEt(rawEnd)} ET  SINCE=${SINCE} DETECTOR=${DETECTOR} ARM=${ARM}`);

// -- served payload, time-travelled per hour (as the other harnesses) ---------
const samples = loadSamples(net, rawStart - SEGMENT_WINDOW_MS - 3_600_000, rawEnd + 3_600_000);
const calibCache = makeCalibCache(samples, network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));
const segCache = new Map<number, SegmentTimes>();
function segmentsAt(t: number): SegmentTimes {
  const bs = calibCache.bucketStart(t);
  let p = segCache.get(bs);
  if (!p) {
    const bc = calibCache.get(bs);
    const st: SegmentTimes = {};
    for (const r of net.routes) st[String(r.id)] = segmentTimesFor(adjByRoute.get(r.id)!, serveRoute(adjByRoute.get(r.id)!, bc.byName.base));
    segCache.set(bs, (p = st));
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
function pct(a: ArrayLike<number>, q: number): number {
  const s = Float64Array.from(a).sort();
  if (s.length === 0) return NaN;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
const dwellCache = new Map<number, DwellTimes>();
function dwellsAt(t: number): DwellTimes {
  const start = calibCache.bucketStart(t);
  const hit = dwellCache.get(start);
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
    (out[rid!] ||= {})[sid!] = { med, sd: Math.max(pct(src, 0.9) - med, 5), n: win.length, ...(low !== undefined ? { low: Math.min(low, med) } : {}) };
  }
  dwellCache.set(start, out);
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

// -- the DB's arrivals table, for claim A's own "real event" rule --------------
const tableArr = new Map<string, Float64Array>();
{
  const rows = db.prepare(`SELECT bus_name b, arrived_at t FROM arrivals WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at`)
    .all(rawStart - 3_600_000, rawEnd + 60_000) as Array<{ b: string; t: number }>;
  const tmp = new Map<string, number[]>();
  for (const r of rows) {
    let l = tmp.get(r.b);
    if (!l) tmp.set(r.b, (l = []));
    l.push(r.t);
  }
  for (const [k, l] of tmp) tableArr.set(k, Float64Array.from(l));
}
function tableArrivalBetween(busName: string, t0: number, t1: number): boolean {
  const a = tableArr.get(busName);
  if (!a) return false;
  let lo = 0;
  let hi = a.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m]! <= t0) lo = m + 1; else hi = m; }
  return lo < a.length && a[lo]! <= t1;
}

// -- per-bus track, for net-movement context ----------------------------------
const track = new Map<string, { t: Float64Array; lat: Float64Array; lon: Float64Array }>();
{
  const tmp = new Map<string, PosRow[]>();
  for (const p of pos) {
    let l = tmp.get(p.b);
    if (!l) tmp.set(p.b, (l = []));
    l.push(p);
  }
  for (const [k, l] of tmp) track.set(k, { t: Float64Array.from(l.map((x) => x.t)), lat: Float64Array.from(l.map((x) => x.lat)), lon: Float64Array.from(l.map((x) => x.lon)) });
}
/** The bus's fix at or before `t`, unless the feed had been quiet for 2 min. */
function fixAt(busName: string, t: number): { lat: number; lon: number } | null {
  const tr = track.get(busName);
  if (!tr) return null;
  let lo = 0;
  let hi = tr.t.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (tr.t[m]! <= t) lo = m + 1; else hi = m; }
  const i = lo - 1;
  if (i < 0 || t - tr.t[i]! > 120_000) return null;
  return { lat: tr.lat[i]!, lon: tr.lon[i]! };
}

// -- belief arm geometry --------------------------------------------------------
const geoByLabel = new Map<string, any>();
if (beliefMod) {
  for (const cfg of ROUTE_LISTS) {
    const path = net.routePaths[String(cfg.routeIds[0]!)];
    const stops = mergedRouteStops(cfg, net.routeStops);
    const ll = stops.map((sid) => net.stopCoords[sid]).filter(Boolean) as Array<{ lat: number; lon: number }>;
    if (!path || ll.length !== stops.length || ll.length < 3) continue;
    try { geoByLabel.set(cfg.label, beliefMod.buildGeometry(path, ll)); } catch { /* untraceable */ }
  }
  log(`belief geometry for ${geoByLabel.size}/${ROUTE_LISTS.length} route lists`);
}
const filterStates = new Map<string, any>();
const gateStore: Map<string, any> | undefined = ARM === "gate" ? new Map() : undefined;

// -- the "next in" rules (PR #74) ----------------------------------------------
function nextOld(list: UpcomingArrival[], pinnedEta: number): UpcomingArrival | null {
  return list.filter((a) => a.eta > pinnedEta + 30).sort((a, b) => a.eta - b.eta)[0] ?? null;
}
function nextNew(list: UpcomingArrival[], pinnedName: string, fallbackEta: number): UpcomingArrival | null {
  const sorted = [...list].sort((a, b) => a.eta - b.eta);
  const shownIdx = sorted.findIndex((a) => a.busName === pinnedName);
  const shown = sorted[shownIdx];
  const shownEta = shown ? shown.eta : fallbackEta;
  return sorted.find((a, i) => i !== shownIdx && a.eta > shownEta) ?? null;
}

// -- replay --------------------------------------------------------------------
interface Ctx {
  lat: number; lon: number; lastStopId: number | null; atStopId: number | null; atSince: number | null;
  anchorS: number; anchorA: number; N: number; stops: number[]; detIdx: number; label: string; routeId: number;
  arrived: boolean;
}
interface Row {
  t0: number; t1: number; dt: number; bus: string; label: string; routeId: number; stopId: number;
  e0: number; e1: number; jump: number; disp: number; net: number; speed: number;
  a0: number; a1: number; N: number; d: number; ahead0: number; passed: boolean;
  lastChanged: boolean; atChanged: boolean; sinceChanged: boolean; at0: number | null; at1: number | null;
  detIdx0: number; detIdx1: number; detArrReplay: boolean; detArrTable: boolean; bucketChanged: boolean;
  mech: string; trigger: string; klassA: string;
}
type SeriesName = "shipped" | "arm";
const SERIES: SeriesName[] = ARM === "none" ? ["shipped"] : ["shipped", "arm"];
const rows: Record<SeriesName, Row[]> = { shipped: [], arm: [] };
const freeze: Record<SeriesName, { n: number; same: number; sameMoving: number; nMoving: number; sameFrozen: number; nFrozen: number }> = {
  shipped: { n: 0, same: 0, sameMoving: 0, nMoving: 0, sameFrozen: 0, nFrozen: 0 },
  arm: { n: 0, same: 0, sameMoving: 0, nMoving: 0, sameFrozen: 0, nFrozen: 0 },
};
/** paired: per transition, shipped big vs arm big at 300 s */
const paired = { both: 0, shippedOnly: 0, armOnly: 0, neither: 0 };
const accErr: Record<SeriesName, number[]> = { shipped: [], arm: [] };
const ACC_STRIDE = 12;
const states = new Map<string, BusState>();
interface Snap { t: number; etaS: Map<string, number>; etaA: Map<string, number>; ctx: Map<string, Ctx>; bucket: number; arrS: UpcomingArrival[] }
let prev: Snap | null = null;

// departure trace
interface Depart { bus: string; stop: number; atStop: number | null; label: string; t: number; e0S: number; e0A: number; k: number; s: number[]; a: number[] }
const pendingDep: Depart[] = [];
const departures: Depart[] = [];

// "next in" flap replay state: per (label|stop) the pinned bus
interface Pin { bus: string; eta: number; oldNext: UpcomingArrival | null; newNext: UpcomingArrival | null; t: number }
const pins = new Map<string, Pin>();
const flap = { pairs: 0, oldFlap: 0, newFlap: 0, oldFlapSteady: 0, newFlapSteady: 0, oldSwitch: 0, newSwitch: 0, oldBoundary: 0, newBoundary: 0, trailingWithin30: 0, trailingWithin60: 0, oldMarginCross: 0, newMarginCross: 0, byRouteOld: {} as Record<string, number>, byRouteNew: {} as Record<string, number>, byRouteOldB: {} as Record<string, number>, byRouteNewB: {} as Record<string, number>, examplesOld: [] as any[], examplesNew: [] as any[], examplesOldB: [] as any[], examplesNewB: [] as any[] };

// detector truth for the accuracy guard rail (detector arrivals table)
interface DetEv { s: number; t: number }
const detSeq = new Map<string, DetEv[]>();
{
  const rs = db.prepare(`SELECT bus_name b, stop_id s, arrived_at t FROM arrivals WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at, id`)
    .all(rawStart - 3_600_000, rawEnd + 45 * 60_000) as Array<{ b: string; s: number; t: number }>;
  for (const a of rs) { let l = detSeq.get(a.b); if (!l) detSeq.set(a.b, (l = [])); l.push({ s: a.s, t: a.t }); }
}
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

function hopsAhead(stops: number[], stopId: number, anchor: number): number {
  const N = stops.length;
  let best = Infinity;
  for (let j = 0; j < N; j++) if (stops[j] === stopId) best = Math.min(best, (j - anchor + N) % N);
  return best;
}

function scoreSeries(name: SeriesName, eta: Map<string, number>, prevEta: Map<string, number>, snap: Snap, prevSnap: Snap, big300: Set<string>) {
  const t = snap.t;
  const dt = (t - prevSnap.t) / 1000;
  const F = freeze[name];
  for (const [k, e1] of eta) {
    const e0 = prevEta.get(k);
    if (e0 === undefined) continue;
    const [bus, sidStr] = k.split("|");
    const c0 = prevSnap.ctx.get(bus!);
    const c1 = snap.ctx.get(bus!);
    if (!c0 || !c1) continue;
    F.n++;
    const disp = distanceMeters(c0, c1);
    const same = Math.abs(e1 - e0) < 0.05;
    if (same) F.same++;
    if (disp > 0) { F.nMoving++; if (same) F.sameMoving++; } else { F.nFrozen++; if (same) F.sameFrozen++; }
    const jump = e1 - e0 + dt;
    if (Math.abs(jump) >= 300) big300.add(k);
    if (Math.abs(jump) < RECORD_FROM) continue;
    const stopId = Number(sidStr);
    const N = c1.N;
    const a0 = name === "arm" ? c0.anchorA : c0.anchorS;
    const a1 = name === "arm" ? c1.anchorA : c1.anchorS;
    const d = a0 >= 0 && a1 >= 0 && N > 0 ? (a1 - a0 + N) % N : -1;
    const ahead0 = a0 >= 0 && N > 0 ? hopsAhead(c0.stops, stopId, a0) : -1;
    const passed = d >= 1 && d <= 2 && ahead0 >= 1 && ahead0 <= d;
    const before = fixAt(`#${bus}`, prevSnap.t - NET_WIN_MS);
    const after = fixAt(`#${bus}`, t + NET_WIN_MS);
    const netM = before && after ? distanceMeters(before, after) : NaN;
    const lastChanged = c0.lastStopId !== c1.lastStopId;
    const atChanged = c0.atStopId !== c1.atStopId;
    const sinceChanged = !atChanged && c1.atStopId !== null && c0.atSince !== c1.atSince;
    const bucketChanged = prevSnap.bucket !== snap.bucket;
    let mech: string;
    if (d < 0) mech = "no-anchor";
    else if (d !== 0 && d !== 1 && d !== 2) mech = "flip";
    else if (d >= 1) mech = passed ? "wrap" : "advance";
    else if (atChanged) mech = "atstop";
    else if (sinceChanged) mech = "clock";
    else if (bucketChanged) mech = "calib";
    else if (disp > 0) mech = "proration";
    else mech = "none";
    const trigger = lastChanged ? "last_stop_id" : atChanged ? "at_stop" : "gps";
    const detArrTable = tableArrivalBetween(`#${bus}`, prevSnap.t, t);
    const klassA = detArrTable || atChanged ? "real" : disp >= 100 ? "moved" : disp > 0 ? "twitch" : "eventless";
    rows[name].push({
      t0: prevSnap.t, t1: t, dt, bus: bus!, label: c1.label, routeId: c1.routeId, stopId, e0, e1, jump, disp, net: netM, speed: disp / dt,
      a0, a1, N, d, ahead0, passed, lastChanged, atChanged, sinceChanged, at0: c0.atStopId, at1: c1.atStopId,
      detIdx0: c0.detIdx, detIdx1: c1.detIdx, detArrReplay: c1.arrived, detArrTable, bucketChanged, mech, trigger, klassA,
    });
  }
}

for (let pi = 0; pi < polls.length; pi++) {
  const poll = polls[pi]!;
  const plan = det.planTracks(poll);
  const events = det.stepMany(network, states as any, poll, plan);
  const arrivedNames = new Set<string>();
  for (const e of events) if (e.kind === "arrival") arrivedNames.add(e.busName.replace("#", ""));
  const t = poll[0]!.collectedAt;
  const segs = segmentsAt(t);
  const dw = dwellsAt(t);
  const bucket = calibCache.bucketStart(t);

  const buses: BusData[] = [];
  const ctx = new Map<string, Ctx>();
  const beliefs = new Map<string, any>();
  for (const o of poll) {
    const key = plan.keys.get(o.busId) ?? o.busName;
    const st = states.get(key) as BusState | undefined;
    const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
    const cand = st && dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
    const at = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M
      ? { id: st.nearestStopId, since: SINCE === "entered" ? st.enteredAt : st.stationarySince }
      : null;
    const bus: BusData = {
      bus_id: o.busId, bus_name: o.busName, route_id: o.routeId, lat: o.lat, lon: o.lon, heading: o.heading,
      last_stop_id: o.lastStopId as number, stationary: at != null,
      ...(at ? { at_stop_id: at.id, at_stop_since: new Date(at.since).toISOString().replace(/Z$/, "") } : {}),
    };
    buses.push(bus);
    const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(o.routeId));
    let anchor = -1;
    let stops: number[] = [];
    let anchorA = -1;
    if (cfg) {
      stops = mergedRouteStops(cfg, net.routeStops);
      if (isBusOnRoute(bus, stops, net.stopCoords)) {
        anchor = (treeS ? treeS.findRouteAnchor : findRouteAnchor)(bus, stops, net.stopCoords);
        anchorA = (treeA ? treeA.findRouteAnchor : findRouteAnchor)(bus, stops, net.stopCoords);
      }
    }
    const name = o.busName.replace("#", "");
    if (beliefMod && cfg) {
      const geo = geoByLabel.get(cfg.label);
      if (geo) {
        const fkey = `${cfg.label}|${o.busName}`;
        const r = beliefMod.step(geo, filterStates.get(fkey) ?? null, { lat: o.lat, lon: o.lon, t: o.collectedAt });
        filterStates.set(fkey, r.state);
        const leg = r.out.leg;
        const legStart = geo.offsets[leg]!, legLen = Math.max(1e-6, geo.offsets[leg + 1]! - legStart);
        const within = Math.max(0, Math.min(1, (r.out.progress - legStart) / legLen));
        const legStop = stops[leg];
        const legStopLL = legStop !== undefined ? net.stopCoords[legStop] : undefined;
        const nearLegStop = legStopLL ? distanceMeters({ lat: r.out.lat, lon: r.out.lon }, legStopLL) <= AT_STOP_MAX_M : false;
        const standing = r.out.standingSince !== null && nearLegStop && o.collectedAt - r.out.standingSince >= 15_000 ? r.out.standingSince : null;
        beliefs.set(`${name}|${cfg.label}`, { anchor: leg, legProgress: within, standingSince: standing });
        anchorA = leg;
      }
    }
    ctx.set(name, {
      lat: o.lat, lon: o.lon, lastStopId: o.lastStopId, atStopId: at ? at.id : null, atSince: at ? at.since : null,
      anchorS: anchor, anchorA, N: stops.length, stops, detIdx: st ? st.nearestIndex : -1,
      label: cfg?.label ?? "?", routeId: o.routeId, arrived: arrivedNames.has(name),
    });
  }

  const targets = new Set<number>();
  for (const cfg of ROUTE_LISTS) {
    if (!buses.some((b) => cfg.busRouteIds.includes(b.route_id))) continue;
    for (const s2 of mergedRouteStops(cfg, net.routeStops)) targets.add(s2);
  }
  const targetList = [...targets];
  let arrS: UpcomingArrival[];
  let arrA: UpcomingArrival[] = [];
  if (ARM === "anchor") {
    if (storeS) treeS!.pruneAnchors(storeS, t);
    if (storeA) treeA!.pruneAnchors(storeA, t);
    arrS = treeS!.compute(targetList, buses, net.routeStops, net.stopCoords, segs, t, dw, storeS);
    arrA = treeA!.compute(targetList, buses, net.routeStops, net.stopCoords, segs, t, dw, storeA);
    // The anchor the ETA actually used is the gated one, not the raw one.
    for (const b of buses) {
      const c = ctx.get(b.bus_name.replace("#", ""));
      if (!c) continue;
      const gs = storeS?.get(`${c.label}|${b.bus_name}`);
      if (gs) c.anchorS = gs.index;
      const ga = storeA?.get(`${c.label}|${b.bus_name}`);
      if (ga) c.anchorA = ga.index;
    }
  } else {
    arrS = computeUpcomingArrivals(targetList, buses, net.routeStops, net.stopCoords, segs, t, dw);
  }
  if (ARM === "gate") {
    arrA = (computeUpcomingArrivals as any)(targetList, buses, net.routeStops, net.stopCoords, segs, t, dw, gateStore);
    for (const b of buses) {
      const c = ctx.get(b.bus_name.replace("#", ""));
      if (!c) continue;
      const g = gateStore!.get(`${c.label}|${b.bus_name}`);
      if (g) c.anchorA = g.index;
    }
  } else if (ARM === "guard") {
    arrA = (computeUpcomingArrivals as any)(targetList, buses, net.routeStops, net.stopCoords, segs, t, dw, guardObj);
  } else if (ARM === "belief") {
    arrA = anchoredMod!.computeUpcomingArrivalsAnchored(targetList, buses, net.routeStops, net.stopCoords, segs, t, dw,
      (b: BusData, label: string) => beliefs.get(`${b.bus_name.replace("#", "")}|${label}`) ?? null);
  }
  const etaOf = (arr: UpcomingArrival[]) => {
    const m = new Map<string, number>();
    for (const a of arr) {
      const k = `${a.busName}|${a.stopId}`;
      const c = m.get(k);
      if (c === undefined || a.eta < c) m.set(k, a.eta);
    }
    return m;
  };
  const etaS = etaOf(arrS);
  const etaA = ARM === "none" ? etaS : etaOf(arrA);
  if (ARM === "anchor") {
    for (const [k, e] of etaS) {
      const ea = etaA.get(k);
      if (ea === undefined) continue;
      armCompared++;
      if (Math.abs(ea - e) > 1e-6) armMismatches++;
    }
  }
  const snap: Snap = { t, etaS, etaA, ctx, bucket, arrS };

  if (pi % ACC_STRIDE === 0) {
    for (const [k, e] of etaS) {
      const [bus, sidStr] = k.split("|");
      const truth = nextArrival(`#${bus}`, Number(sidStr), t);
      if (truth === null) continue;
      accErr.shipped.push(e - (truth - t) / 1000);
      if (ARM !== "none") { const ea = etaA.get(k); if (ea !== undefined) accErr.arm.push(ea - (truth - t) / 1000); }
    }
  }

  if (prev && t - prev.t > 0 && t - prev.t <= MAX_POLL_GAP_MS) {
    const dt = (t - prev.t) / 1000;
    const bigS = new Set<string>();
    const bigA = new Set<string>();
    scoreSeries("shipped", etaS, prev.etaS, snap, prev, bigS);
    if (ARM !== "none") {
      scoreSeries("arm", etaA, prev.etaA, snap, prev, bigA);
      const keys = new Set([...etaS.keys()].filter((k) => prev!.etaS.has(k)));
      for (const k of keys) {
        const s = bigS.has(k), a = bigA.has(k);
        if (s && a) paired.both++; else if (s) paired.shippedOnly++; else if (a) paired.armOnly++; else paired.neither++;
      }
    }

    // ---- departure trace: production at_stop_id non-null -> null
    for (const [name, c1] of ctx) {
      const c0 = prev.ctx.get(name);
      if (!c0 || c0.atStopId === null || c1.atStopId !== null) continue;
      // the stop the rider would be watching: the bus's soonest stop at t0
      let stop = -1, best = Infinity;
      for (const [k, e] of prev.etaS) if (k.startsWith(`${name}|`) && e < best) { best = e; stop = Number(k.split("|")[1]); }
      if (stop < 0) continue;
      const e0A = prev.etaA.get(`${name}|${stop}`);
      if (e0A === undefined) continue;
      const dep: Depart = { bus: name, stop, atStop: c0.atStopId, label: c1.label, t, e0S: best, e0A, k: 0, s: [], a: [] };
      pendingDep.push(dep);
    }
    for (let i = pendingDep.length - 1; i >= 0; i--) {
      const dep = pendingDep[i]!;
      const eS = etaS.get(`${dep.bus}|${dep.stop}`);
      const eA = etaA.get(`${dep.bus}|${dep.stop}`);
      dep.s.push(eS ?? NaN);
      dep.a.push(eA ?? NaN);
      dep.k++;
      if (dep.k > DEPART_POLLS) { departures.push(dep); pendingDep.splice(i, 1); }
    }

    // ---- "next in" flap replay on shipped arrivals
    const byCard = new Map<string, UpcomingArrival[]>();
    for (const a of arrS) {
      const k = `${a.routeLabel}|${a.stopId}`;
      let l = byCard.get(k);
      if (!l) byCard.set(k, (l = []));
      l.push(a);
    }
    for (const [k, list] of byCard) {
      list.sort((a, b) => a.eta - b.eta);
      const p = pins.get(k);
      let pinned: UpcomingArrival | undefined;
      if (p) {
        // keep the pin while that bus still has an arrival here that is not a lap later
        pinned = list.find((a) => a.busName === p.bus && a.eta < p.eta + 600 - dt);
      }
      if (!pinned) pinned = list[0];
      if (!pinned) { pins.delete(k); continue; }
      const oldN = nextOld(list, pinned.eta);
      const newN = nextNew(list, pinned.busName, pinned.eta);
      if (p && p.bus === pinned.busName && t - p.t <= MAX_POLL_GAP_MS) {
        flap.pairs++;
        const steady = Math.abs(pinned.eta - p.eta + dt) < 60;
        const jOld = oldN && p.oldNext ? oldN.eta - p.oldNext.eta + dt : NaN;
        const jNew = newN && p.newNext ? newN.eta - p.newNext.eta + dt : NaN;
        const label = k.split("|")[0]!;
        if (Number.isFinite(jOld) && Math.abs(jOld) >= 300) {
          flap.oldFlap++; if (steady) flap.oldFlapSteady++;
          flap.byRouteOld[label] = (flap.byRouteOld[label] ?? 0) + 1;
          if (flap.examplesOld.length < 8) flap.examplesOld.push({ at: fmtEt(t), card: `${label} @${net.stopById.get(pinned.stopId)?.name ?? pinned.stopId}`, pinned: `${pinned.busName} ${Math.round(p.eta)}->${Math.round(pinned.eta)}`, next: `${p.oldNext!.busName} ${Math.round(p.oldNext!.eta)} -> ${oldN!.busName} ${Math.round(oldN!.eta)}` });
        }
        if (Number.isFinite(jNew) && Math.abs(jNew) >= 300) {
          flap.newFlap++; if (steady) flap.newFlapSteady++;
          flap.byRouteNew[label] = (flap.byRouteNew[label] ?? 0) + 1;
          if (flap.examplesNew.length < 8) flap.examplesNew.push({ at: fmtEt(t), card: `${label} @${net.stopById.get(pinned.stopId)?.name ?? pinned.stopId}`, pinned: `${pinned.busName} ${Math.round(p.eta)}->${Math.round(pinned.eta)}`, next: `${p.newNext!.busName} ${Math.round(p.newNext!.eta)} -> ${newN!.busName} ${Math.round(newN!.eta)}` });
        }
        if (oldN && p.oldNext && oldN.busName !== p.oldNext.busName) flap.oldSwitch++;
        if (newN && p.newNext && newN.busName !== p.newNext.busName) flap.newSwitch++;
        // BOUNDARY flap: the bus that was "next" is still here and barely
        // moved, yet the rule now answers with something else and the figure
        // jumped. That is the signature of a threshold being crossed, as
        // opposed to the trailing bus's own ETA jumping.
        const stillOld = p.oldNext ? list.find((a) => a.busName === p.oldNext!.busName && Math.abs(a.eta - p.oldNext!.eta + dt) < 60) : undefined;
        if (steady && Number.isFinite(jOld) && Math.abs(jOld) >= 300 && stillOld && oldN && oldN.eta !== stillOld.eta) {
          flap.oldBoundary++; flap.byRouteOldB[label] = (flap.byRouteOldB[label] ?? 0) + 1;
          if (flap.examplesOldB.length < 6) flap.examplesOldB.push({ at: fmtEt(t), card: `${label} @${net.stopById.get(pinned.stopId)?.name ?? pinned.stopId}`, pinned: `${pinned.busName} ${Math.round(p.eta)}->${Math.round(pinned.eta)}`, was: `${p.oldNext!.busName} ${Math.round(p.oldNext!.eta)} (now ${Math.round(stillOld.eta)})`, now: `${oldN.busName} ${Math.round(oldN.eta)}` });
        }
        const stillNew = p.newNext ? list.find((a) => a.busName === p.newNext!.busName && Math.abs(a.eta - p.newNext!.eta + dt) < 60) : undefined;
        if (steady && Number.isFinite(jNew) && Math.abs(jNew) >= 300 && stillNew && newN && newN.eta !== stillNew.eta) {
          flap.newBoundary++; flap.byRouteNewB[label] = (flap.byRouteNewB[label] ?? 0) + 1;
          if (flap.examplesNewB.length < 6) flap.examplesNewB.push({ at: fmtEt(t), card: `${label} @${net.stopById.get(pinned.stopId)?.name ?? pinned.stopId}`, pinned: `${pinned.busName} ${Math.round(p.eta)}->${Math.round(pinned.eta)}`, was: `${p.newNext!.busName} ${Math.round(p.newNext!.eta)} (now ${Math.round(stillNew.eta)})`, now: `${newN.busName} ${Math.round(newN.eta)}` });
        }
        // The exact defect PR #74 names: the bus that was "next" is still here
        // and CROSSED the rule's line (old: pinned+30, new: pinned+0), so the
        // answer had to change to something else.
        // `x` must be the SAME entry (same lap) as last poll's answer, i.e.
        // within two minutes of where that entry was expected to be — a bus
        // carries two entries (this lap, next lap) and the earliest one is
        // not the one that was on screen.
        if (p.oldNext && p.oldNext.busName !== pinned.busName) {
          const x = list.find((a) => a.busName === p.oldNext!.busName && Math.abs(a.eta - p.oldNext!.eta + dt) < 120);
          if (x && x.eta <= pinned.eta + 30) flap.oldMarginCross++;
        }
        if (p.newNext && p.newNext.busName !== pinned.busName) {
          const x = list.find((a) => a.busName === p.newNext!.busName && Math.abs(a.eta - p.newNext!.eta + dt) < 120);
          if (x && x.eta <= pinned.eta) flap.newMarginCross++;
        }
        // how often does a real trailing bus sit inside the old margin?
        if (list.some((a) => a.busName !== pinned!.busName && a.eta > pinned!.eta && a.eta <= pinned!.eta + 30)) flap.trailingWithin30++;
        if (list.some((a) => a.busName !== pinned!.busName && a.eta > pinned!.eta && a.eta <= pinned!.eta + 60)) flap.trailingWithin60++;
      }
      pins.set(k, { bus: pinned.busName, eta: pinned.eta, oldNext: oldN, newNext: newN, t });
    }
  } else {
    pins.clear();
  }
  prev = snap;
  if (pi % 1000 === 0) log(`poll ${pi}/${polls.length}  rows ${rows.shipped.length}/${rows.arm.length}`);
}
log(`transitions ${freeze.shipped.n}, rows >=${RECORD_FROM}s shipped ${rows.shipped.length} arm ${rows.arm.length}`);

// -- aggregate -----------------------------------------------------------------
const q = (a: number[], p: number) => (a.length ? Math.round(pct(a, p) * 10) / 10 : null);
const count = <T,>(xs: T[], f: (x: T) => string) => {
  const m: Record<string, number> = {};
  for (const x of xs) { const k = f(x); m[k] = (m[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
};
const cross = <T,>(xs: T[], f: (x: T) => string, g: (x: T) => string) => {
  const m: Record<string, Record<string, number>> = {};
  for (const x of xs) { const a = f(x), b = g(x); (m[a] ||= {})[b] = (m[a]![b] ?? 0) + 1; }
  return m;
};
const incidentsOf = (xs: Row[]) => {
  const m = new Map<string, { mech: string; klassA: string; label: string; n: number; maxAbs: number; trigger: string; d: number; N: number }>();
  for (const r of xs) {
    const k = `${r.bus}|${r.t1}`;
    const cur = m.get(k);
    if (!cur) m.set(k, { mech: r.mech, klassA: r.klassA, label: r.label, n: 1, maxAbs: Math.abs(r.jump), trigger: r.trigger, d: r.d, N: r.N });
    else { cur.n++; cur.maxAbs = Math.max(cur.maxAbs, Math.abs(r.jump)); if (cur.mech === "wrap" && r.mech !== "wrap") cur.mech = r.mech; }
  }
  return [...m.values()];
};
const deltaLabel = (d: number, N: number) => (d < 0 ? "n/a" : d <= 2 ? `+${d}` : d >= N - 2 ? `-${N - d}` : "other");
const metrics = (e: number[]) => (e.length ? { n: e.length, medianAbs: q(e.map(Math.abs), 0.5), p90Abs: q(e.map(Math.abs), 0.9), meanSigned: Math.round((e.reduce((a, b) => a + b, 0) / e.length) * 10) / 10 } : { n: 0 });

function summarise(name: SeriesName) {
  const xs0 = rows[name];
  const F = freeze[name];
  const out: any = {
    transitions: F.n,
    freeze: {
      etaUnchangedPct: Math.round(1e4 * F.same / Math.max(1, F.n)) / 100,
      unchangedWhileFixMovedPct: Math.round(1e4 * F.sameMoving / Math.max(1, F.nMoving)) / 100,
      unchangedWhileFixFrozenPct: Math.round(1e4 * F.sameFrozen / Math.max(1, F.nFrozen)) / 100,
    },
    accuracy: metrics(accErr[name]),
    levels: {},
  };
  for (const L of LEVELS) {
    const xs = xs0.filter((r) => Math.abs(r.jump) >= L);
    const inc = incidentsOf(xs);
    const twitch = xs.filter((r) => r.klassA === "twitch");
    const nonReal = xs.filter((r) => r.klassA !== "real" && r.disp > 0);
    out.levels[`>=${L}s`] = {
      jumps: xs.length,
      pctOfTransitions: Math.round(1e4 * xs.length / Math.max(1, F.n)) / 100,
      incidents: inc.length,
      jumpsPerIncident: Math.round(10 * xs.length / Math.max(1, inc.length)) / 10,
      claimA: count(xs, (r) => r.klassA),
      claimAIncidents: count(inc, (r) => r.klassA),
      mechanism: count(xs, (r) => r.mech),
      mechanismIncidents: count(inc, (r) => r.mech),
      mechanismByClaimA: cross(xs, (r) => r.klassA, (r) => r.mech),
      triggerByMechanism: cross(xs, (r) => r.mech, (r) => r.trigger),
      signByMechanism: cross(xs, (r) => r.mech, (r) => (r.jump > 0 ? "later" : "sooner")),
      absJumpByMechanism: Object.fromEntries(Object.keys(count(xs, (r) => r.mech)).map((m) => [m, { p50: q(xs.filter((r) => r.mech === m).map((r) => Math.abs(r.jump)), 0.5), p90: q(xs.filter((r) => r.mech === m).map((r) => Math.abs(r.jump)), 0.9) }])),
      flipIncidents: {
        n: inc.filter((i) => i.mech === "flip").length,
        byRoute: count(inc.filter((i) => i.mech === "flip"), (r) => r.label),
        byTrigger: count(inc.filter((i) => i.mech === "flip"), (r) => r.trigger),
        byDelta: count(inc.filter((i) => i.mech === "flip"), (r) => deltaLabel(r.d, r.N)),
        byDeltaAndTrigger: cross(inc.filter((i) => i.mech === "flip"), (r) => deltaLabel(r.d, r.N), (r) => r.trigger),
        byClaimA: count(inc.filter((i) => i.mech === "flip"), (r) => r.klassA),
      },
      twitch: {
        n: twitch.length,
        incidents: inc.filter((i) => i.klassA === "twitch").length,
        mechanismIncidents: count(inc.filter((i) => i.klassA === "twitch"), (r) => r.mech),
        dispM: { p10: q(twitch.map((r) => r.disp), 0.1), p50: q(twitch.map((r) => r.disp), 0.5), p90: q(twitch.map((r) => r.disp), 0.9) },
        speedMs: { p10: q(twitch.map((r) => r.speed), 0.1), p50: q(twitch.map((r) => r.speed), 0.5), p90: q(twitch.map((r) => r.speed), 0.9) },
        net2minM: { p10: q(twitch.filter((r) => Number.isFinite(r.net)).map((r) => r.net), 0.1), p50: q(twitch.filter((r) => Number.isFinite(r.net)).map((r) => r.net), 0.5), p90: q(twitch.filter((r) => Number.isFinite(r.net)).map((r) => r.net), 0.9) },
        net2minUnder100mPct: Math.round(1e3 * twitch.filter((r) => Number.isFinite(r.net) && r.net < 100).length / Math.max(1, twitch.filter((r) => Number.isFinite(r.net)).length)) / 10,
        net2minOver300mPct: Math.round(1e3 * twitch.filter((r) => Number.isFinite(r.net) && r.net >= 300).length / Math.max(1, twitch.filter((r) => Number.isFinite(r.net)).length)) / 10,
      },
      boundarySensitivity: Object.fromEntries([50, 75, 100, 150, 200].map((b) => [`under${b}m`, nonReal.filter((r) => r.disp < b).length])),
      eventless: {
        n: xs.filter((r) => r.klassA === "eventless").length,
        incidents: inc.filter((i) => i.klassA === "eventless").length,
        mechanism: count(xs.filter((r) => r.klassA === "eventless"), (r) => r.mech),
        trigger: count(xs.filter((r) => r.klassA === "eventless"), (r) => r.trigger),
      },
      real: { n: xs.filter((r) => r.klassA === "real").length, mechanism: count(xs.filter((r) => r.klassA === "real"), (r) => r.mech) },
      byRouteIncidents: count(inc, (r) => r.label),
      detectorRuleAgreement: { tableSaysArrival: xs.filter((r) => r.detArrTable).length, replaySaysArrival: xs.filter((r) => r.detArrReplay).length, disagree: xs.filter((r) => r.detArrTable !== r.detArrReplay).length },
    };
  }
  out.examples = {};
  for (const m of ["flip", "wrap", "advance", "atstop", "clock", "proration", "calib", "none", "no-anchor"]) {
    const ex = xs0.filter((r) => Math.abs(r.jump) >= 300 && r.mech === m).slice(0, 6).map((r) => ({
      at: fmtEt(r.t1), bus: r.bus, route: r.label, stop: net.stopById.get(r.stopId)?.name ?? r.stopId,
      eta: `${Math.round(r.e0)} -> ${Math.round(r.e1)}`, jump: Math.round(r.jump), dispM: Math.round(r.disp), net2minM: Math.round(r.net),
      anchor: `${r.a0}->${r.a1}/${r.N}`, ahead0: r.ahead0, lastStop: r.lastChanged, atStop: `${r.at0}->${r.at1}`, det: `${r.detIdx0}->${r.detIdx1}`, klassA: r.klassA,
    }));
    if (ex.length) out.examples[m] = ex;
  }
  return out;
}

const out: any = {
  generatedAt: new Date().toISOString(),
  config: { REPLAY_DB: process.env.REPLAY_DB ?? "./store/snap.db", SINCE, DETECTOR, ARM },
  window: { start: fmtEt(rawStart), end: fmtEt(rawEnd), polls: polls.length },
  shipped: summarise("shipped"),
};
if (ARM !== "none") {
  out.arm = summarise("arm");
  if (guardObj) out.guardStats = guardObj.stats;
  if (ARM === "anchor") out.armReplica = { shippedSrc: process.env.SHIPPED_SRC, armSrc: process.env.ARM_SRC ?? "(this tree)", store: USE_STORE, compared: armCompared, mismatches: armMismatches };
  out.paired300 = paired;
  // departure trace
  const d0 = departures.map((d) => d.a[0]! - d.s[0]!).filter(Number.isFinite);
  const d6 = departures.map((d) => d.a[DEPART_POLLS]! - d.s[DEPART_POLLS]!).filter(Number.isFinite);
  const dropS = departures.map((d) => d.s[0]! - d.e0S);
  const dropA = departures.map((d) => d.a[0]! - d.e0A);
  const landed = departures.filter((d, i) => dropS[i]! <= -60);
  const armLandedSame = landed.filter((d, i) => (d.a[0]! - d.e0A) <= -60).length;
  // The watched stop is shipped's soonest at t0. When shipped had the bus
  // "approaching" the very stop it was standing at (ETA ~0 — the
  // repeated-stop refinement refused on Purple/Green's second visit), that
  // stop is the one it watches, and an arm that correctly says "a lap" reads
  // as +5,000 s "later". Split those out: a rider waits for a bus that is
  // coming, not one already at the kerb.
  const waited = departures.filter((d) => d.stop !== d.atStop);
  const worstOf = (xs: Depart[]) => xs.map((d) => ({ d0: d.a[0]! - d.s[0]!, d })).filter((x) => Number.isFinite(x.d0)).sort((a, b) => b.d0 - a.d0).slice(0, 8).map((x) => ({
    at: fmtEt(x.d.t), bus: x.d.bus, route: x.d.label, stop: net.stopById.get(x.d.stop)?.name ?? x.d.stop, atStop: x.d.atStop === null ? null : (net.stopById.get(x.d.atStop)?.name ?? x.d.atStop),
    shipped: [Math.round(x.d.e0S), ...x.d.s.map(Math.round)].join(" "), arm: [Math.round(x.d.e0A), ...x.d.a.map(Math.round)].join(" "),
  }));
  const d0w = waited.map((d) => d.a[0]! - d.s[0]!).filter(Number.isFinite);
  const d6w = waited.map((d) => d.a[DEPART_POLLS]! - d.s[DEPART_POLLS]!).filter(Number.isFinite);
  out.departures = {
    n: departures.length,
    armMinusShipped: {
      atDeparturePoll: { p50: q(d0, 0.5), p90: q(d0, 0.9), p99: q(d0, 0.99), over60s: d0.filter((x) => x > 60).length, over300s: d0.filter((x) => x > 300).length, under_minus60s: d0.filter((x) => x < -60).length },
      sixPollsLater: { p50: q(d6, 0.5), p90: q(d6, 0.9), p99: q(d6, 0.99), over60s: d6.filter((x) => x > 60).length, over300s: d6.filter((x) => x > 300).length },
    },
    watchedStopWasTheStopStoodAt: departures.length - waited.length,
    armMinusShippedAtAStopAhead: {
      n: waited.length,
      atDeparturePoll: { p50: q(d0w, 0.5), p90: q(d0w, 0.9), p99: q(d0w, 0.99), over60s: d0w.filter((x) => x > 60).length, over300s: d0w.filter((x) => x > 300).length, under_minus60s: d0w.filter((x) => x < -60).length },
      sixPollsLater: { p50: q(d6w, 0.5), p90: q(d6w, 0.9), p99: q(d6w, 0.99), over60s: d6w.filter((x) => x > 60).length, over300s: d6w.filter((x) => x > 300).length },
      worst: worstOf(waited),
      worstSixPollsLater: waited.map((d) => ({ d6: d.a[DEPART_POLLS]! - d.s[DEPART_POLLS]!, d })).filter((x) => Number.isFinite(x.d6)).sort((a, b) => b.d6 - a.d6).slice(0, 8).map((x) => ({
        at: fmtEt(x.d.t), bus: x.d.bus, route: x.d.label, stop: net.stopById.get(x.d.stop)?.name ?? x.d.stop, atStop: x.d.atStop === null ? null : (net.stopById.get(x.d.atStop)?.name ?? x.d.atStop),
        shipped: [Math.round(x.d.e0S), ...x.d.s.map(Math.round)].join(" "), arm: [Math.round(x.d.e0A), ...x.d.a.map(Math.round)].join(" "),
      })),
    },
    shippedDroppedGe60AtDeparture: landed.length,
    armAlsoDroppedGe60SamePoll: armLandedSame,
    samePollLandingPct: Math.round(1e3 * armLandedSame / Math.max(1, landed.length)) / 10,
    shippedDropAtDeparture: { p50: q(dropS, 0.5), p10: q(dropS, 0.1) },
    armDropAtDeparture: { p50: q(dropA, 0.5), p10: q(dropA, 0.1) },
    worst: departures.map((d) => ({ d0: d.a[0]! - d.s[0]!, d })).filter((x) => Number.isFinite(x.d0)).sort((a, b) => b.d0 - a.d0).slice(0, 8).map((x) => ({
      at: fmtEt(x.d.t), bus: x.d.bus, route: x.d.label, stop: net.stopById.get(x.d.stop)?.name ?? x.d.stop,
      shipped: [Math.round(x.d.e0S), ...x.d.s.map(Math.round)].join(" "), arm: [Math.round(x.d.e0A), ...x.d.a.map(Math.round)].join(" "),
    })),
  };
}
out.nextInFlap = {
  pairs: flap.pairs,
  trailingBusWithin30sOfPinned: flap.trailingWithin30, marginCrossings: { oldRule: flap.oldMarginCross, newRule: flap.newMarginCross }, trailingBusWithin60sOfPinned: flap.trailingWithin60,
  oldRule: { flapsGe300: flap.oldFlap, flapsWhileFirstFigureSteady: flap.oldFlapSteady, busSwitches: flap.oldSwitch, boundaryFlaps: flap.oldBoundary, boundaryByRoute: flap.byRouteOldB, byRoute: flap.byRouteOld, examples: flap.examplesOld, boundaryExamples: flap.examplesOldB },
  newRule: { flapsGe300: flap.newFlap, flapsWhileFirstFigureSteady: flap.newFlapSteady, busSwitches: flap.newSwitch, boundaryFlaps: flap.newBoundary, boundaryByRoute: flap.byRouteNewB, byRoute: flap.byRouteNew, examples: flap.examplesNew, boundaryExamples: flap.examplesNewB },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/${OUT_NAME}.json`, JSON.stringify(out, null, 1));
const dumpName = ARM === "none" ? "shipped" : "arm";
fs.writeFileSync(`${OUT_DIR}/${OUT_NAME}.rows300.jsonl`, rows[dumpName].filter((r) => Math.abs(r.jump) >= 300).map((r) => JSON.stringify(r)).join("\n"));
log(`wrote ${OUT_DIR}/${OUT_NAME}.json (+ .rows300.jsonl for ${dumpName})`);

// -- console -------------------------------------------------------------------
const pad = (s: unknown, n: number) => String(s).padEnd(n);
function printSeries(name: SeriesName, s: any) {
  console.log(`\n##### ${name.toUpperCase()}  transitions ${s.transitions}  freeze: unchanged ${s.freeze.etaUnchangedPct}% (fix moved ${s.freeze.unchangedWhileFixMovedPct}%, fix frozen ${s.freeze.unchangedWhileFixFrozenPct}%)  accuracy ${JSON.stringify(s.accuracy)}`);
  for (const L of LEVELS) {
    const l = s.levels[`>=${L}s`];
    console.log(`== |jump| >= ${L}s: ${l.jumps} jumps (${l.pctOfTransitions}%) in ${l.incidents} incidents (${l.jumpsPerIncident}/incident)`);
    console.log(`   claim A (per stop) ${JSON.stringify(l.claimA)}   (per incident) ${JSON.stringify(l.claimAIncidents)}`);
    console.log(`   mechanism (per stop) ${JSON.stringify(l.mechanism)}   (per incident) ${JSON.stringify(l.mechanismIncidents)}`);
    if (L === 300 || L === 120) {
      console.log(`   mechanism within claim-A class:`);
      for (const [k, v] of Object.entries(l.mechanismByClaimA)) console.log(`      ${pad(k, 10)} ${JSON.stringify(v)}`);
      console.log(`   |jump| by mechanism ${JSON.stringify(l.absJumpByMechanism)}`);
      console.log(`   sign by mechanism ${JSON.stringify(l.signByMechanism)}`);
      console.log(`   flip incidents ${l.flipIncidents.n}: by route ${JSON.stringify(l.flipIncidents.byRoute)}; by trigger ${JSON.stringify(l.flipIncidents.byTrigger)}; by delta ${JSON.stringify(l.flipIncidents.byDelta)}`);
      console.log(`      delta x trigger ${JSON.stringify(l.flipIncidents.byDeltaAndTrigger)}`);
      console.log(`   twitch ${l.twitch.n} jumps / ${l.twitch.incidents} incidents; mech ${JSON.stringify(l.twitch.mechanismIncidents)}; disp ${JSON.stringify(l.twitch.dispM)}; speed ${JSON.stringify(l.twitch.speedMs)} m/s; net2min ${JSON.stringify(l.twitch.net2minM)} (<100 m ${l.twitch.net2minUnder100mPct}%, >=300 m ${l.twitch.net2minOver300mPct}%)`);
      console.log(`   boundary ${JSON.stringify(l.boundarySensitivity)}`);
      console.log(`   eventless ${JSON.stringify(l.eventless)}`);
      console.log(`   real ${JSON.stringify(l.real)}`);
      console.log(`   incidents by route ${JSON.stringify(l.byRouteIncidents)}`);
    }
  }
}
console.log(`\n${OUT_NAME}: ${out.window.start} .. ${out.window.end} ET, ${polls.length} polls  (SINCE=${SINCE}, DETECTOR=${DETECTOR}, ARM=${ARM})`);
printSeries("shipped", out.shipped);
if (ARM !== "none") {
  printSeries("arm", out.arm);
  if (out.armReplica) console.log(`\n== replica: ${JSON.stringify(out.armReplica)}`);
  console.log(`\n== paired at 300 s: ${JSON.stringify(out.paired300)}`);
  console.log(`== departures (${out.departures.n}): arm - shipped at the departure poll ${JSON.stringify(out.departures.armMinusShipped.atDeparturePoll)}; six polls later ${JSON.stringify(out.departures.armMinusShipped.sixPollsLater)}`);
  console.log(`   shipped dropped >=60 s at departure on ${out.departures.shippedDroppedGe60AtDeparture}; arm did too in the same poll on ${out.departures.armAlsoDroppedGe60SamePoll} (${out.departures.samePollLandingPct}%)`);
  console.log(`   at a stop AHEAD of the one stood at (${out.departures.armMinusShippedAtAStopAhead.n}): ${JSON.stringify(out.departures.armMinusShippedAtAStopAhead.atDeparturePoll)}; six polls later ${JSON.stringify(out.departures.armMinusShippedAtAStopAhead.sixPollsLater)}`);
  for (const w of out.departures.armMinusShippedAtAStopAhead.worst) console.log(`   worst ahead: ${JSON.stringify(w)}`);
  console.log(`   drop at departure: shipped ${JSON.stringify(out.departures.shippedDropAtDeparture)} arm ${JSON.stringify(out.departures.armDropAtDeparture)}`);
  for (const w of out.departures.worst) console.log(`   worst: ${JSON.stringify(w)}`);
}
console.log(`\n== "next in" flap replay: ${out.nextInFlap.pairs} pairs`);
console.log(`   old rule (eta > pinned + 30): flaps>=300 ${out.nextInFlap.oldRule.flapsGe300} (first figure steady: ${out.nextInFlap.oldRule.flapsWhileFirstFigureSteady}), bus switches ${out.nextInFlap.oldRule.busSwitches}, by route ${JSON.stringify(out.nextInFlap.oldRule.byRoute)}`);
console.log(`   new rule (identity):          flaps>=300 ${out.nextInFlap.newRule.flapsGe300} (first figure steady: ${out.nextInFlap.newRule.flapsWhileFirstFigureSteady}), bus switches ${out.nextInFlap.newRule.busSwitches}, by route ${JSON.stringify(out.nextInFlap.newRule.byRoute)}`);
console.log(`   BOUNDARY flaps (next bus still present & steady, answer changed >=300 s, first figure steady): old ${out.nextInFlap.oldRule.boundaryFlaps} ${JSON.stringify(out.nextInFlap.oldRule.boundaryByRoute)}  new ${out.nextInFlap.newRule.boundaryFlaps} ${JSON.stringify(out.nextInFlap.newRule.boundaryByRoute)}`);
console.log(`   MARGIN CROSSINGS (the next bus itself crossed the rule's line, forcing a different answer): old ${out.nextInFlap.marginCrossings.oldRule}  new ${out.nextInFlap.marginCrossings.newRule}`);
console.log(`   pairs with a trailing bus within 30 s of the pinned one: ${out.nextInFlap.trailingBusWithin30sOfPinned}; within 60 s: ${out.nextInFlap.trailingBusWithin60sOfPinned}`);
for (const e of out.nextInFlap.oldRule.boundaryExamples.slice(0, 4)) console.log(`   old boundary ex: ${JSON.stringify(e)}`);
for (const e of out.nextInFlap.newRule.boundaryExamples.slice(0, 4)) console.log(`   new boundary ex: ${JSON.stringify(e)}`);
