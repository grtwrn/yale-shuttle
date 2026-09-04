/**
 * BELIEF SCOREBOARD -- Stage 0 of the state-estimator lane.
 *
 * One table for every anti-jitter arm, scored the way the operator judges it:
 *
 *   "it can go 5->1 if it leaves early. but if it is jitter we need a fix."
 *
 * So the metric is the change in the promised arrival instant A(t) = t + eta
 * between consecutive 5 s polls (0 = a countdown ticking down perfectly), and
 * every catastrophic change (>= JUMP_BIG_SEC) is attributed TWICE:
 *
 *   by the feed      did the bus do anything? (detector event / moved >= 100 m
 *                    / twitched < 100 m / byte-identical fix). The last two are
 *                    the EVENTLESS population -- the only thing to suppress.
 *   by the arm       what did THIS estimator change? (anchor advance / anchor
 *                    flip / standing on / standing off / credit reset /
 *                    proration / re-price). This is what the feed-side
 *                    attribution cannot say: the same feed twitch is a jump on
 *                    one arm and nothing on another.
 *
 * Every arm also reports the freeze split (an arm can "win" by not moving),
 * accuracy against the bus's own track, the fold-back routes separately, and
 * the DEPARTURE gate: for every clean layover departure (plateau walk-back
 * from docs/layover-clock.md -- no radius any arm uses) the error of the
 * promise to the NEXT stop at fixed offsets around the departure instant.
 *
 * FIDELITY. The shipped arm builds `at_stop_since` from the detector's
 * `stationarySince`, which is what production serves (collector.ts,
 * updateLivePositions). Earlier harnesses used `enteredAt`; that variant is
 * kept as an arm so the size of the drift is a number, not a claim. The
 * `replica` arm must equal `shipped` on every poll or the run is invalid.
 *
 * Inputs: positions from the durable JSONL capture (POSITIONS_JSONL, default
 * ~/shuttle-captures/positions-20260903.jsonl; set to "db" to use the
 * snapshot's raw_positions); stops/routes/segments/arrivals from REPLAY_DB.
 *
 *   cd services/shuttle-v2 && TZ=America/New_York REPLAY_DB=./store/snap2.db \
 *     npx tsx scripts/eta-replay/belief-scoreboard.ts
 *
 * Env: ARMS=comma list (shipped+replica always), START/END "YYYY-MM-DD HH:MM"
 * ET, JUMP_BIG_SEC (300), OUT_NAME.
 */
import fs from "node:fs";
import os from "node:os";

import {
  OUT_DIR, SEGMENT_WINDOW_MS, fmtEt, loadNet, loadSamples, makeCalibCache,
  routeAdjacency, segmentTimesFor, serveRoute, type AdjEntry,
} from "./common.js";
import { planTracks, stepMany, type BusObservation, type BusState } from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { median } from "../../src/calibrator/shrinkage.js";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from "../../web/src/arrivals";
import type { AnchorStore } from "../../web/src/anchorGate";
import { computeUpcomingArrivalsAnchored, type AnchorBelief, type BusDiag } from "./arrivals-anchored.js";
import { ANCHOR_GPS_THRESHOLD_M, registerRoutePaths } from "../../web/src/anchor";
import { distanceToSegmentM, haversineMeters, progressAlongSegment } from "../../web/src/geo";
import type { BusData } from "../../web/src/map-data";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes";
import { buildGeometry, step as filterStep, type FilterState, type RouteGeometry } from "./progress-filter.js";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const AT_STOP_MAX_M = 75;
const JUMP_BIG_SEC = Number(process.env.JUMP_BIG_SEC ?? 300);
const MAX_POLL_GAP_MS = 20_000;
const DWELL_WINDOW_MS = 14 * 86_400_000;
const DWELL_LOW_QUANTILE = 0.35;
const DWELL_LOW_MIN_SAMPLES = 5;
/** Proximity truth: first entry within ENTER_M of the stop, hysteresis EXIT_M (gps-replay.ts). */
const ENTER_M = 50;
const EXIT_M = 120;
const MATCH_MS = 45 * 60_000;
const ACC_STRIDE = 12;
/** Departure truth (docs/layover-clock.md section 7). */
const DEPARTED_M = 250;
const DEPART_HORIZON = 36;
const PLATEAU_TOL = 10;
const LAYOVER_MIN_S = 180;
const DEPART_OFFSETS = [-60, -30, -10, -5, 0, 5, 10, 15, 20, 30, 45, 60, 90];

// shipped    the REAL computeUpcomingArrivals with its own AnchorStore (production = PR #72 gate + PR #73 floor)
// replica    the copy, same gate -- MUST equal shipped on every poll
// ungated    the copy with no AnchorStore: production before PR #72, for reference
// beliefFull the predecessor's arm as audited (filter leg + progress + its own standing mode)
// beliefFullFixed  the same with its two defects repaired (standing clock backdated to the last distinct fix; standing granted at the leg's END stop)
// beliefA    filter leg refined by the feed's at_stop exactly as findRouteAnchor refines; production credit; chord proration
// beliefAroad  beliefA with along-polyline proration instead of the chord
const ALL_ARMS = ["shipped", "replica", "ungated", "beliefFull", "beliefFullFixed", "beliefA", "beliefAroad"] as const;
type Arm = (typeof ALL_ARMS)[number];
const ARMS: Arm[] = process.env.ARMS
  ? (["shipped", "replica", ...process.env.ARMS.split(",").filter((a) => a !== "shipped" && a !== "replica")] as Arm[])
  : [...ALL_ARMS];
for (const a of ARMS) if (!ALL_ARMS.includes(a)) throw new Error(`unknown arm ${a}`);

const net = loadNet();
const { db, network } = net;
registerRoutePaths(net.routePaths);

// ---- positions --------------------------------------------------------------
type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
function parseEt(s: string): number { return new Date(s.replace(" ", "T")).getTime(); }
function loadPositions(): { rows: PosRow[]; source: string } {
  // Comma-separated files, or the default: every positions-*.jsonl in the capture directory. The
  // recorder re-fetches the whole retention window into a new file at the UTC day roll, so
  // consecutive files overlap and rows are deduplicated on (collected_at, bus_id) ACROSS files.
  const dir = `${os.homedir()}/shuttle-captures`;
  const spec = process.env.POSITIONS_JSONL
    ?? (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^positions-\d{8}\.jsonl$/.test(f)).sort().map((f) => `${dir}/${f}`).join(",") : "db");
  let rows: PosRow[];
  let source: string;
  const files = spec === "db" ? [] : spec.split(",").filter((f) => f && fs.existsSync(f));
  if (files.length) {
    rows = [];
    const seen = new Set<string>();
    for (const f of files) for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      const k = `${r.collected_at}|${r.bus_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ i: r.bus_id, b: r.bus_name, r: r.route_id, lat: r.lat, lon: r.lon, h: r.heading, l: r.last_stop_id ?? null, t: r.collected_at });
    }
    rows.sort((a, b) => a.t - b.t || a.i - b.i);
    source = files.map((f) => f.slice(f.lastIndexOf("/") + 1)).join("+");
  } else {
    rows = db.prepare(`SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
                       FROM raw_positions ORDER BY collected_at, id`).all() as PosRow[];
    source = "raw_positions";
  }
  const start = process.env.START ? parseEt(process.env.START) : -Infinity;
  const end = process.env.END ? parseEt(process.env.END) : Infinity;
  if (Number.isFinite(start) || Number.isFinite(end)) rows = rows.filter((p) => p.t >= start && p.t <= end);
  return { rows, source };
}
const { rows: pos, source: posSource } = loadPositions();
if (!pos.length) throw new Error("no positions");
const rawStart = pos[0]!.t, rawEnd = pos[pos.length - 1]!.t;
log(`positions ${pos.length} from ${posSource}, ${fmtEt(rawStart)} .. ${fmtEt(rawEnd)} ET`);

// ---- served payload, time-travelled per hour (identical to eta-stability.ts) --
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
  const rows = db.prepare(`SELECT route_id r, stop_id s, arrived_at a, dwell_sec d, dow, hour FROM arrivals
                           WHERE dwell_sec IS NOT NULL AND arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at`)
    .all(rawStart - DWELL_WINDOW_MS - 3_600_000, rawEnd) as Array<{ r: number; s: number; a: number; d: number; dow: number; hour: number }>;
  const tmp = new Map<string, Array<{ a: number; d: number; dow: number; hour: number }>>();
  for (const x of rows) { const k = `${x.r}:${x.s}`; let l = tmp.get(k); if (!l) tmp.set(k, (l = [])); l.push(x); }
  for (const [k, l] of tmp) dwellGroups.set(k, {
    at: Float64Array.from(l.map((x) => x.a)), done: Float64Array.from(l.map((x) => x.a + x.d * 1000)),
    sec: Float64Array.from(l.map((x) => x.d)), dow: Int8Array.from(l.map((x) => x.dow)), hour: Int8Array.from(l.map((x) => x.hour)),
  });
}
function pct(a: ArrayLike<number>, q: number): number {
  const s = Array.from(a).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
const dwellCache = new Map<string, DwellTimes>();
function dwellsAt(t: number): DwellTimes {
  const start = calibCache.bucketStart(t);
  const hit = dwellCache.get(String(start));
  if (hit) return hit;
  const d = new Date(start), dow = d.getDay();
  const hours = new Set([(d.getHours() + 23) % 24, d.getHours(), (d.getHours() + 1) % 24]);
  const out: DwellTimes = {};
  for (const [key, g] of dwellGroups) {
    const [rid, sid] = key.split(":");
    const all: number[] = [], win: number[] = [];
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
  dwellCache.set(String(start), out);
  return out;
}

// ---- polls & tracks -----------------------------------------------------------
const polls: BusObservation[][] = [];
{
  let cur: BusObservation[] = [], curAt = -1;
  for (const p of pos) {
    if (p.t !== curAt) { if (cur.length) polls.push(cur); cur = []; curAt = p.t; }
    cur.push({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t });
  }
  if (cur.length) polls.push(cur);
}
log(`polls ${polls.length}`);
const trackByName = new Map<string, PosRow[]>();
for (const p of pos) { let l = trackByName.get(p.b); if (!l) trackByName.set(p.b, (l = [])); l.push(p); }
function trackIndexAt(busName: string, t: number): number {
  const tr = trackByName.get(busName)!;
  let lo = 0, hi = tr.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (tr[m]!.t < t) lo = m + 1; else hi = m; }
  return lo < tr.length && tr[lo]!.t === t ? lo : -1;
}

// ---- proximity truth ----------------------------------------------------------
const entryCache = new Map<string, Float64Array>();
function entries(busName: string, stopId: number): Float64Array {
  const key = `${busName} ${stopId}`;
  let e = entryCache.get(key);
  if (e) return e;
  const track = trackByName.get(busName) ?? [];
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
      if (!inside && d <= ENTER_M) { out.push(p.t); inside = true; } else if (inside && d >= EXIT_M) inside = false;
    }
    prev = p;
  }
  entryCache.set(key, (e = Float64Array.from(out)));
  return e;
}
/** First physical entry to stopId strictly after t (within MATCH_MS), or null. */
function nextEntry(busName: string, stopId: number, t: number): number | null {
  if (!net.stopCoords[stopId]) return null;
  const e = entries(busName, stopId);
  let lo = 0, hi = e.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (e[m]! <= t) lo = m + 1; else hi = m; }
  if (lo >= e.length) return null;
  return e[lo]! - t <= MATCH_MS ? e[lo]! : null;
}

// ---- geometry for the filter, per route list ----------------------------------
const geoByLabel = new Map<string, RouteGeometry>();
for (const cfg of ROUTE_LISTS) {
  const path = net.routePaths[String(cfg.routeIds[0]!)];
  const stops = mergedRouteStops(cfg, net.routeStops);
  const ll = stops.map((sid) => net.stopCoords[sid]).filter(Boolean) as Array<{ lat: number; lon: number }>;
  if (!path || ll.length !== stops.length || ll.length < 3) continue;
  try { geoByLabel.set(cfg.label, buildGeometry(path, ll)); } catch { /* untraceable */ }
}
log(`geometry for ${geoByLabel.size}/${ROUTE_LISTS.length} route lists`);
const cfgByRoute = new Map<number, (typeof ROUTE_LISTS)[number]>();
for (const cfg of ROUTE_LISTS) for (const rid of cfg.busRouteIds) if (!cfgByRoute.has(rid)) cfgByRoute.set(rid, cfg);

// ---- departure episodes (first pass, production detector) ---------------------
interface Episode {
  bus: string; routeId: number; stopId: number; stopName: string; targetStop: number;
  enteredAt: number; lastAt: number; departAt: number; truthAt: number | null; durS: number;
  /** per arm: eta samples for the target within the window */
  series: Map<Arm, Array<{ t: number; eta: number }>>;
}
const episodes: Episode[] = [];
/** The production detector's own arrival sequence per bus (replayed), which says WHICH pass of a stop is ahead. */
const detSeq = new Map<string, Array<{ s: number; t: number }>>();
{
  const states = new Map<string, BusState>();
  const open = new Map<string, { routeId: number; stopId: number; index: number; enteredAt: number; lastAt: number; minD: number }>();
  const stopLL = (sid: number) => net.stopCoords[sid];
  const close = (bus: string, o: { routeId: number; stopId: number; index: number; enteredAt: number; lastAt: number; minD: number }) => {
    const durS = (o.lastAt - o.enteredAt) / 1000;
    if (durS < LAYOVER_MIN_S || o.minD > AT_STOP_MAX_M) return;
    const route = net.routeById.get(o.routeId);
    if (!route) return;
    const tr = trackByName.get(bus)!;
    const aIdx = trackIndexAt(bus, o.enteredAt), bIdx = trackIndexAt(bus, o.lastAt);
    if (aIdx < 0 || bIdx < 0) return;
    const sPos = stopLL(o.stopId)!;
    const d = (k: number) => distanceMeters(tr[k]!, sPos);
    let idxFar = -1;
    for (let k = bIdx + 1; k < tr.length && k <= bIdx + DEPART_HORIZON; k++) {
      if (tr[k]!.t - tr[k - 1]!.t > 60_000) break;
      if (tr[k]!.r !== o.routeId) break;
      if (d(k) > DEPARTED_M) { idxFar = k; break; }
    }
    if (idxFar < 0) return; // not a clean departure
    let k = idxFar, sufMin = d(idxFar);
    while (k - 1 > aIdx && d(k - 1) <= sufMin) { k--; sufMin = Math.min(sufMin, d(k)); }
    const restD = d(k);
    let dep = idxFar;
    for (let m = k; m <= idxFar; m++) if (d(m) > restD + PLATEAU_TOL) { dep = m; break; }
    const departAt = tr[dep]!.t;
    const targetStop = route.stops[(o.index + 1) % route.stops.length]!;
    const truthAt = truthArrival(bus, targetStop, departAt - 1);
    episodes.push({
      bus, routeId: o.routeId, stopId: o.stopId, stopName: net.stopById.get(o.stopId)?.name ?? String(o.stopId), targetStop,
      enteredAt: o.enteredAt, lastAt: o.lastAt, departAt, truthAt, durS, series: new Map(),
    });
  };
  for (const poll of polls) {
    const plan = planTracks(poll);
    const evs = stepMany(network, states, poll, plan);
    for (const ev of evs) if (ev.kind === "arrival") { let l = detSeq.get(ev.busName); if (!l) detSeq.set(ev.busName, (l = [])); l.push({ s: ev.stopId, t: ev.arrivedAt }); }
    for (const o of poll) {
      const key = plan.keys.get(o.busId) ?? o.busName;
      const st = states.get(key);
      const cur = open.get(o.busName);
      if (!st) { if (cur) { close(o.busName, cur); open.delete(o.busName); } continue; }
      const dNow = distanceMeters(o, net.stopById.get(st.nearestStopId)!);
      if (cur && cur.enteredAt === st.enteredAt && cur.index === st.nearestIndex && cur.routeId === st.routeId) {
        cur.lastAt = o.collectedAt; cur.minD = Math.min(cur.minD, dNow);
      } else {
        if (cur) close(o.busName, cur);
        open.set(o.busName, { routeId: st.routeId, stopId: st.nearestStopId, index: st.nearestIndex, enteredAt: st.enteredAt, lastAt: o.collectedAt, minD: dNow });
      }
    }
  }
  for (const [bus, cur] of open) close(bus, cur);
}
episodes.sort((a, b) => a.departAt - b.departAt);
const epWindows = new Map<string, Episode[]>();
for (const e of episodes) { let l = epWindows.get(e.bus); if (!l) epWindows.set(e.bus, (l = [])); l.push(e); }
log(`layover departures (>= ${LAYOVER_MIN_S} s at a stop, clean): ${episodes.length}, with truth ${episodes.filter((e) => e.truthAt !== null).length}`);

/**
 * Ground truth for "when does this bus next reach this stop", resolving WHICH
 * pass: the detector's sequence says whether the pass ahead is the one it has
 * already logged (it fires ~25 s before the kerb) or the next lap; the physical
 * instant is the bus's own track entering ENTER_M of the stop (gps-replay.ts).
 * Proximity alone credits a twin platform 28 m away with an arrival that never
 * happened, which is why the sequence is consulted first.
 */
function truthArrival(busName: string, stopId: number, t: number): number | null {
  const seq = detSeq.get(busName);
  if (!seq || !net.stopCoords[stopId]) return null;
  const e = entries(busName, stopId);
  const refine = (detT: number): number | null => {
    let best: number | null = null;
    for (let i = 0; i < e.length; i++) {
      const x = e[i]!;
      if (x < detT - 90_000) continue;
      if (x > detT + 300_000) break;
      if (best === null || Math.abs(x - detT) < Math.abs(best - detT)) best = x;
    }
    return best;
  };
  let lo = 0, hi = seq.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (seq[m]!.t <= t) lo = m + 1; else hi = m; }
  const m = lo - 1;
  if (m >= 0 && seq[m]!.s === stopId && t - seq[m]!.t <= 180_000) {
    const phys = refine(seq[m]!.t);
    if (phys !== null && phys > t) return phys; // logged, not yet physically there
  }
  for (let i = lo; i < seq.length; i++) {
    if (seq[i]!.t - t > MATCH_MS) return null;
    if (seq[i]!.s !== stopId) continue;
    const phys = refine(seq[i]!.t);
    return phys !== null && phys > t ? phys : seq[i]!.t;
  }
  return null;
}

// ---- incidents: fixed-target traces -------------------------------------------
interface Incident { bus: string; from: number; to: number; label: string; target?: number; truthAt?: number | null; rows: Array<Record<string, unknown>> }
const incidents: Incident[] = [
  { bus: "#316", from: Date.parse("2026-09-03T20:38:00Z"), to: Date.parse("2026-09-03T20:48:30Z"), label: "#316 layover at 344 Winchester (report #82)", target: 146, rows: [] },
  { bus: "#304", from: Date.parse("2026-09-03T20:57:00Z"), to: Date.parse("2026-09-03T21:02:30Z"), label: "#304 canary pre-fix, 344 Winchester", target: 146, rows: [] },
  { bus: "#309", from: Date.parse("2026-09-03T21:21:30Z"), to: Date.parse("2026-09-03T21:26:00Z"), label: "#309 canary post-fix: held at Canal/Munson 354 m out, left, reached 344 Winchester", target: 11, rows: [] },
  { bus: "#301", from: Date.parse("2026-09-03T21:45:00Z"), to: Date.parse("2026-09-03T21:49:30Z"), label: "#301 Brown 1 min -> 56 min at 77 m out", target: 47, rows: [] },
];
const targetOverride: Record<string, number> = {};
for (const kv of (process.env.INCIDENT_TARGETS ?? "").split(",").filter(Boolean)) { const [b, s] = kv.split(":"); targetOverride[`#${b!.replace("#", "")}`] = Number(s); }
for (const inc of incidents) {
  const tr = trackByName.get(inc.bus);
  if (!tr || inc.from < rawStart || inc.from > rawEnd) continue;
  const first = tr.find((p) => p.t >= inc.from);
  if (!first) continue;
  const route = net.routeById.get(first.r);
  if (!route) continue;
  if (targetOverride[inc.bus]) inc.target = targetOverride[inc.bus];
  else if (inc.target === undefined) {
    // the first stop the bus physically reaches after the window opens (+60 s)
    let best: { sid: number; t: number } | null = null;
    for (const sid of new Set(route.stops)) {
      const t = nextEntry(inc.bus, sid, inc.from + 60_000);
      if (t !== null && (!best || t < best.t)) best = { sid, t };
    }
    if (best) inc.target = best.sid;
  }
  if (inc.target !== undefined) inc.truthAt = truthArrival(inc.bus, inc.target, inc.from + 60_000);
}

// ---- arms ---------------------------------------------------------------------
interface Stats {
  jumps: number[]; big: number; n: number; unchanged: number; up: number;
  unchangedMoving: number; nMoving: number; unchangedFrozen: number; nFrozen: number;
  bigBoard: number; nBoard: number;
  errs: number[]; errsNear: number[];
  bigByLabel: Map<string, { big: number; n: number; wrap: number; eventlessJitter: number; byArm: Record<string, number> }>;
  bigByFeed: Record<string, number>;
  bigByArm: Record<string, number>;
  bigEventlessByArm: Record<string, number>;
  bigByGeom: Record<string, number>;
  wrapAtStop: number; eventlessJitter: number;
  worst: Array<{ t: number; bus: string; stop: number; from: number; to: number; feed: string; arm: string; geom: string; label: string; dStop: number }>;
  prev: { t: number; perBus: Map<string, number>; board: Map<number, { eta: number; bus: string }>; diag: Map<string, BusDiag>; bucket: number } | null;
}
const mk = (): Stats => ({ jumps: [], big: 0, n: 0, unchanged: 0, up: 0, unchangedMoving: 0, nMoving: 0, unchangedFrozen: 0, nFrozen: 0, bigBoard: 0, nBoard: 0, errs: [], errsNear: [], bigByLabel: new Map(), bigByFeed: {}, bigByArm: {}, bigEventlessByArm: {}, bigByGeom: {}, wrapAtStop: 0, eventlessJitter: 0, worst: [], prev: null });
const stats = new Map<Arm, Stats>(ARMS.map((a) => [a, mk()]));

const states = new Map<string, BusState>();
const filterStates = new Map<string, FilterState>();
const storeShipped: AnchorStore = new Map();
const storeReplica: AnchorStore = new Map();
let replicaMismatch = 0;

/** The verifier's paired departure metric: at each production at_stop_id non-null -> null, arm - shipped for the NEXT stop over the following polls. */
const DEPART_POLLS = 6;
interface PairedDep { bus: string; label: string; stop: number; t: number; k: number; s: number[]; a: Record<string, number[]> }
const pendingDep: PairedDep[] = [];
const pairedDeps: PairedDep[] = [];
let prevAtStop = new Map<string, { atStopId: number | null; routeId: number }>();

interface Ctx { lat: number; lon: number; nearest: number | null; atStopId: number | null; label: string }
let prevCtx = new Map<string, Ctx>();

const naive = (ms: number) => new Date(ms).toISOString().replace(/Z$/, "");
function withAt(base: Omit<BusData, "stationary">, at: { id: number; since: number } | null): BusData {
  return { ...base, stationary: at != null, ...(at ? { at_stop_id: at.id, at_stop_since: naive(at.since) } : {}) } as BusData;
}
/** Production's at_stop derivation (collector.ts updateLivePositions): `since` is the STOP-PINNED stationary clock (PR #67). */
function atStopOf(st: BusState | undefined, o: BusObservation) {
  if (!st) return null;
  if (o.collectedAt - st.enteredAt < 15_000) return null;
  const cand = net.stopById.get(st.nearestStopId);
  if (!cand || distanceMeters(o, cand) > AT_STOP_MAX_M) return null;
  return { id: st.nearestStopId, since: st.stationarySince };
}
/** findRouteAnchor's own rule: at_stop wins when the bus is really there and it is the anchor or one ahead. */
function refineLeg(leg: number, bus: BusData, stops: number[]): number {
  if (bus.at_stop_id == null) return leg;
  const N = stops.length;
  const sc = net.stopCoords[bus.at_stop_id];
  if (!sc) return leg;
  if (distanceMeters(bus, sc) >= ANCHOR_GPS_THRESHOLD_M) return leg;
  for (let i = 0; i < N; i++) {
    if (stops[i] !== bus.at_stop_id) continue;
    const ahead = (i - leg + N) % N;
    if (ahead <= 1) return i;
  }
  return leg;
}

const diagByArm = new Map<Arm, Map<string, BusDiag>>();

for (let pi = 0; pi < polls.length; pi++) {
  const poll = polls[pi]!;
  const plan = planTracks(poll);
  stepMany(network, states, poll, plan);
  const t = poll[0]!.collectedAt;
  const segs = segmentsAt(t), dw = dwellsAt(t);
  const bucket = calibCache.bucketStart(t);
  const scoreAcc = pi % ACC_STRIDE === 0;

  const feedProd: BusData[] = [];
  const beliefs = { beliefFull: new Map<string, AnchorBelief>(), beliefFullFixed: new Map<string, AnchorBelief>(), beliefA: new Map<string, AnchorBelief>(), beliefAroad: new Map<string, AnchorBelief>() };
  const ctx = new Map<string, Ctx>();
  const atStopNow = new Map<string, { atStopId: number | null; routeId: number }>();

  for (const o of poll) {
    const key = plan.keys.get(o.busId) ?? o.busName;
    const st = states.get(key);
    const cfg = cfgByRoute.get(o.routeId);
    const name = o.busName.replace("#", "");
    const base = { bus_id: o.busId, bus_name: o.busName, route_id: o.routeId, heading: o.heading, last_stop_id: o.lastStopId as number, lat: o.lat, lon: o.lon };
    const atProd = atStopOf(st, o);
    const busProd = withAt(base, atProd);
    feedProd.push(busProd);
    ctx.set(name, { lat: o.lat, lon: o.lon, nearest: st ? st.nearestStopId : null, atStopId: atProd ? atProd.id : null, label: cfg?.label ?? "?" });
    atStopNow.set(name, { atStopId: atProd ? atProd.id : null, routeId: o.routeId });
    if (!cfg) continue;
    const stops = mergedRouteStops(cfg, net.routeStops);
    const N = stops.length;
    const bkey = `${name}|${cfg.label}`;
    const geo = geoByLabel.get(cfg.label);
    if (geo) {
      const fkey = `${cfg.label}|${o.busName}`;
      const r = filterStep(geo, filterStates.get(fkey) ?? null, { lat: o.lat, lon: o.lon, t: o.collectedAt });
      filterStates.set(fkey, r.state);
      const leg = r.out.leg;
      const legStart = geo.offsets[leg]!, legLen = Math.max(1e-6, geo.offsets[leg + 1]! - legStart);
      const within = Math.max(0, Math.min(1, (r.out.progress - legStart) / legLen));
      // predecessor's arm, verbatim: the filter's own standing, only near the leg's START stop
      const legStopLL = net.stopCoords[stops[leg]!];
      const nearLegStop = legStopLL ? distanceMeters({ lat: r.out.lat, lon: r.out.lon }, legStopLL) <= AT_STOP_MAX_M : false;
      const standing = r.out.standingSince !== null && nearLegStop && o.collectedAt - r.out.standingSince >= 15_000 ? r.out.standingSince : null;
      beliefs.beliefFull.set(bkey, { anchor: leg, legProgress: within, standingSince: standing });
      // beliefFull with its two defects repaired: the standing clock is backdated to the last DISTINCT fix (the bus
      // has been at this coordinate since then), and standing is granted at the leg's END stop as well as its start.
      {
        const isStanding = r.out.standingSince !== null;
        const since = r.state.lastFixT;
        const endStop = stops[(leg + 1) % N]!;
        const endLL = net.stopCoords[endStop];
        const atEnd = isStanding && endLL ? distanceMeters({ lat: o.lat, lon: o.lon }, endLL) <= AT_STOP_MAX_M : false;
        const atStart = isStanding && legStopLL ? distanceMeters({ lat: o.lat, lon: o.lon }, legStopLL) <= AT_STOP_MAX_M : false;
        const granted = o.collectedAt - since >= 15_000;
        if (atEnd && granted) beliefs.beliefFullFixed.set(bkey, { anchor: (leg + 1) % N, legProgress: 0, standingSince: since });
        else if (atStart && granted) beliefs.beliefFullFixed.set(bkey, { anchor: leg, legProgress: within, standingSince: since });
        else beliefs.beliefFullFixed.set(bkey, { anchor: leg, legProgress: within, standingSince: null });
      }
      // Stage A: the remembered leg, refined by the feed's at_stop exactly as findRouteAnchor refines; production credit
      const refined = refineLeg(leg, busProd, stops);
      beliefs.beliefA.set(bkey, { anchor: refined });
      beliefs.beliefAroad.set(bkey, { anchor: refined, legProgress: refined === leg ? within : 0 });
    }
  }

  const targets = new Set<number>();
  for (const cfg of ROUTE_LISTS) {
    if (!feedProd.some((b) => cfg.busRouteIds.includes(b.route_id))) continue;
    for (const s2 of mergedRouteStops(cfg, net.routeStops)) targets.add(s2);
  }
  const targetList = [...targets];
  const ov = (m: Map<string, AnchorBelief>) => (b: BusData, label: string) => m.get(`${b.bus_name.replace("#", "")}|${label}`) ?? null;

  const runs = new Map<Arm, ReturnType<typeof computeUpcomingArrivalsAnchored>>();
  for (const arm of ARMS) {
    const diag = new Map<string, BusDiag>();
    let out;
    switch (arm) {
      case "shipped": out = computeUpcomingArrivals(targetList, feedProd, net.routeStops, net.stopCoords, segs, t, dw, storeShipped); break;
      case "replica": out = computeUpcomingArrivalsAnchored(targetList, feedProd, net.routeStops, net.stopCoords, segs, t, dw, null, storeReplica, diag); break;
      case "ungated": out = computeUpcomingArrivalsAnchored(targetList, feedProd, net.routeStops, net.stopCoords, segs, t, dw, null, undefined, diag); break;
      default: out = computeUpcomingArrivalsAnchored(targetList, feedProd, net.routeStops, net.stopCoords, segs, t, dw, ov(beliefs[arm]), undefined, diag);
    }
    runs.set(arm, out);
    diagByArm.set(arm, diag);
  }
  // the real function exposes no internals; shipped == replica by the guard below, so it borrows replica's
  diagByArm.set("shipped", diagByArm.get("replica")!);
  {
    const a = runs.get("shipped")!, b = runs.get("replica")!;
    if (a.length !== b.length) replicaMismatch++;
    else for (let i = 0; i < a.length; i++) if (a[i]!.eta !== b[i]!.eta || a[i]!.stopId !== b[i]!.stopId || a[i]!.busName !== b[i]!.busName) { replicaMismatch++; break; }
  }

  for (const arm of ARMS) {
    const S = stats.get(arm)!;
    const perBus = new Map<string, number>();
    const board = new Map<number, { eta: number; bus: string }>();
    for (const a of runs.get(arm)!) {
      const k = `${a.busName}|${a.stopId}`;
      const c = perBus.get(k);
      if (c === undefined || a.eta < c) perBus.set(k, a.eta);
      const b = board.get(a.stopId);
      if (!b || a.eta < b.eta) board.set(a.stopId, { eta: a.eta, bus: a.busName });
    }
    const diag = diagByArm.get(arm)!;
    const frame = { t, perBus, board, diag, bucket };
    const prev = S.prev;
    if (prev && t - prev.t > 0 && t - prev.t <= MAX_POLL_GAP_MS) {
      const dt = (t - prev.t) / 1000;
      const repriced = bucket !== prev.bucket;
      for (const [k, eta] of perBus) {
        const before = prev.perBus.get(k);
        if (before === undefined) continue;
        S.n++;
        const jump = eta - before + dt;
        S.jumps.push(jump);
        if (eta === before) S.unchanged++;
        if (eta > before + 1) S.up++;
        const name = k.slice(0, k.indexOf("|"));
        const stopId = Number(k.slice(k.indexOf("|") + 1));
        const c1 = ctx.get(name), c0 = prevCtx.get(name);
        if (c0 && c1) {
          const rawMoved = distanceMeters(c0, c1) > 0;
          if (rawMoved) { S.nMoving++; if (eta === before) S.unchangedMoving++; }
          else { S.nFrozen++; if (eta === before) S.unchangedFrozen++; }
        }
        const lab = c1?.label ?? "?";
        const bl = S.bigByLabel.get(lab) ?? { big: 0, n: 0, wrap: 0, eventlessJitter: 0, byArm: {} };
        bl.n++;
        if (Math.abs(jump) >= JUMP_BIG_SEC) {
          S.big++; bl.big++;
          // Geometry: a (bus, stop) series MUST flip to the next lap when the bus reaches the stop -- that is the
          // metric's construction, not jitter. Count it as a wrap only when the bus is actually there.
          const sc = net.stopCoords[stopId];
          const dStop1 = sc && c1 ? distanceMeters(c1, sc) : Infinity;
          const dStop0 = sc && c0 ? distanceMeters(c0, sc) : Infinity;
          const rose = eta - before > 600, fell = before - eta > 600;
          const geom = rose ? (Math.min(dStop0, dStop1) <= AT_STOP_MAX_M ? "wrap at stop (legit)" : "premature wrap") : fell ? "un-wrap" : "other";
          S.bigByGeom[geom] = (S.bigByGeom[geom] ?? 0) + 1;
          const isWrap = geom === "wrap at stop (legit)";
          if (isWrap) { S.wrapAtStop++; bl.wrap++; }
          let feedEv = "unclassified";
          if (c0 && c1) {
            const moved = distanceMeters(c0, c1);
            if (c0.nearest !== c1.nearest || c0.atStopId !== c1.atStopId) feedEv = "detector arrival / at-stop flip";
            else if (moved >= 100) feedEv = "moved >= 100 m";
            else if (moved > 0) feedEv = "twitch < 100 m (EVENTLESS)";
            else feedEv = "byte-identical fix (EVENTLESS)";
          }
          S.bigByFeed[feedEv] = (S.bigByFeed[feedEv] ?? 0) + 1;
          const d0 = prev.diag.get(name), d1 = diag.get(name);
          let armEv: string;
          if (!d0 || !d1) armEv = "bus appeared/vanished";
          else if (d0.anchor !== d1.anchor) {
            const cfg = cfgByRoute.get(feedProd.find((b) => b.bus_name === `#${name}`)?.route_id ?? -1);
            const N = cfg ? mergedRouteStops(cfg, net.routeStops).length : 0;
            const adv = N ? (d1.anchor - d0.anchor + N) % N : 99;
            armEv = adv === 1 || adv === 2 ? (eta - before > 600 ? "anchor advance: lap wrap (passed the stop)" : "anchor advance") : "anchor flip";
          } else if (d0.standing !== d1.standing) armEv = d1.standing ? "standing ON (credit appears)" : "standing OFF (credit vanishes)";
          else if (Math.abs(d1.credit - d0.credit) >= 60) armEv = d1.credit < d0.credit ? "credit reset" : "credit jump";
          else if (repriced) armEv = "re-price (calibration bucket)";
          else if (Math.abs(d1.factor - d0.factor) * d1.firstSeg >= 60) armEv = "proration swing";
          else armEv = "unexplained";
          S.bigByArm[armEv] = (S.bigByArm[armEv] ?? 0) + 1;
          bl.byArm[armEv] = (bl.byArm[armEv] ?? 0) + 1;
          if (feedEv.includes("EVENTLESS") && !isWrap) { S.bigEventlessByArm[armEv] = (S.bigEventlessByArm[armEv] ?? 0) + 1; S.eventlessJitter++; bl.eventlessJitter++; }
          if (!isWrap && S.worst.length < 6000) S.worst.push({ t, bus: name, stop: stopId, from: before, to: eta, feed: feedEv, arm: armEv, geom, label: lab, dStop: Math.round(dStop1) });
        }
        S.bigByLabel.set(lab, bl);
        if (scoreAcc) {
          const truth = truthArrival(`#${name}`, stopId, t);
          if (truth !== null) {
            const e = eta - (truth - t) / 1000;
            S.errs.push(e);
            if (truth - t <= 600_000) S.errsNear.push(e);
          }
        }
      }
      for (const [stopId, cur] of board) {
        const b0 = prev.board.get(stopId);
        if (!b0) continue;
        S.nBoard++;
        if (Math.abs(cur.eta - b0.eta + dt) >= JUMP_BIG_SEC) S.bigBoard++;
      }
    }
    S.prev = frame;
    // departure episodes & incidents: record this arm's promise for the fixed target
    for (const o of poll) {
      const eps = epWindows.get(o.busName);
      if (eps) for (const e of eps) {
        if (t < e.departAt - 90_000 || t > e.departAt + 120_000) continue;
        const eta = perBus.get(`${o.busName.replace("#", "")}|${e.targetStop}`);
        if (eta === undefined) continue;
        let s = e.series.get(arm); if (!s) e.series.set(arm, (s = [])); s.push({ t, eta });
      }
    }
  }
  // ---- paired departures (verifier's metric): production at_stop_id non-null -> null
  {
    const etaOf = (arm: Arm, key: string) => stats.get(arm)!.prev!.perBus.get(key);
    for (const [name, cur] of atStopNow) {
      const p0 = prevAtStop.get(name);
      if (!p0 || p0.atStopId === null || cur.atStopId !== null) continue;
      const route = net.routeById.get(cur.routeId);
      const cfg = cfgByRoute.get(cur.routeId);
      if (!route || !cfg) continue;
      const i = route.stops.indexOf(p0.atStopId);
      if (i < 0) continue;
      const stop = route.stops[(i + 1) % route.stops.length]!;
      const key = `${name}|${stop}`;
      if (etaOf("shipped", key) === undefined) continue;
      pendingDep.push({ bus: name, label: cfg.label, stop, t, k: 0, s: [], a: Object.fromEntries(ARMS.map((a) => [a, []])) });
    }
    for (let i = pendingDep.length - 1; i >= 0; i--) {
      const d = pendingDep[i]!;
      const key = `${d.bus}|${d.stop}`;
      const sv = etaOf("shipped", key);
      if (sv === undefined) { pendingDep.splice(i, 1); continue; }
      d.s.push(sv);
      for (const arm of ARMS) d.a[arm]!.push(etaOf(arm, key) ?? NaN);
      d.k++;
      if (d.k > DEPART_POLLS) { pairedDeps.push(d); pendingDep.splice(i, 1); }
    }
    prevAtStop = atStopNow;
  }
  for (const inc of incidents) {
    if (inc.target === undefined || t < inc.from || t > inc.to) continue;
    const c = ctx.get(inc.bus.replace("#", ""));
    if (!c) continue;
    const c0 = prevCtx.get(inc.bus.replace("#", ""));
    const row: Record<string, unknown> = {
      t, utc: new Date(t).toISOString().slice(11, 19), moved: c0 ? Math.round(distanceMeters(c0, c)) : null,
      dStop: Math.round(distanceMeters(c, net.stopCoords[inc.target]!)), nearest: c.nearest, at: c.atStopId,
      truth: inc.truthAt != null ? Math.round((inc.truthAt - t) / 1000) : null,
    };
    for (const arm of ARMS) { if (arm === "replica") continue; const v = stats.get(arm)!.prev!.perBus.get(`${inc.bus.replace("#", "")}|${inc.target}`); row[arm] = v === undefined ? null : Math.round(v); }
    inc.rows.push(row);
  }
  prevCtx = ctx;
  if (pi % 1000 === 0) log(`poll ${pi}/${polls.length}`);
}

// ---- report -----------------------------------------------------------------
const r1 = (x: number) => Math.round(x * 10) / 10;
const metrics = (e: number[]) => e.length ? { n: e.length, medianAbs: r1(pct(e.map(Math.abs), 0.5)), p90Abs: r1(pct(e.map(Math.abs), 0.9)), meanSigned: r1(e.reduce((a, b) => a + b, 0) / e.length) } : { n: 0 };
const out: any = {
  generatedAt: new Date().toISOString(), positions: posSource, window: { start: fmtEt(rawStart), end: fmtEt(rawEnd), polls: polls.length },
  jumpBigSec: JUMP_BIG_SEC, replicaMismatch, arms: {}, departures: {}, incidents: [],
};
for (const arm of ARMS) {
  const S = stats.get(arm)!;
  const abs = S.jumps.map(Math.abs);
  const eventlessAll = (S.bigByFeed["twitch < 100 m (EVENTLESS)"] ?? 0) + (S.bigByFeed["byte-identical fix (EVENTLESS)"] ?? 0);
  const jitter = S.big - S.wrapAtStop;
  S.worst.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  out.arms[arm] = {
    n: S.n,
    jumpAbs: { p50: r1(pct(abs, 0.5)), p90: r1(pct(abs, 0.9)), p99: r1(pct(abs, 0.99)), p999: r1(pct(abs, 0.999)) },
    big: S.big, bigPct: Math.round(1e4 * S.big / Math.max(1, S.n)) / 100,
    wrapAtStop: S.wrapAtStop,
    jitter, jitterPct: Math.round(1e4 * jitter / Math.max(1, S.n)) / 100,
    eventlessJitter: S.eventlessJitter, eventlessJitterPct: Math.round(1e4 * S.eventlessJitter / Math.max(1, S.n)) / 100,
    eventlessAll,
    bigByGeom: S.bigByGeom,
    bigBoard: S.bigBoard, bigBoardPct: Math.round(1e4 * S.bigBoard / Math.max(1, S.nBoard)) / 100,
    frozenPct: Math.round(1e4 * S.unchanged / Math.max(1, S.n)) / 100,
    frozenWhileMovingPct: Math.round(1e4 * S.unchangedMoving / Math.max(1, S.nMoving)) / 100,
    frozenWhileFixFrozenPct: Math.round(1e4 * S.unchangedFrozen / Math.max(1, S.nFrozen)) / 100,
    countdownUpPct: Math.round(1e4 * S.up / Math.max(1, S.n)) / 100,
    accuracy: metrics(S.errs), accuracyNear10min: metrics(S.errsNear),
    bigByFeed: S.bigByFeed, bigByArm: S.bigByArm, bigEventlessByArm: S.bigEventlessByArm,
    bigByLabel: Object.fromEntries([...S.bigByLabel].map(([l, v]) => [l, { big: v.big, wrap: v.wrap, jitter: v.big - v.wrap, eventlessJitter: v.eventlessJitter, n: v.n, jitterPct: Math.round(1e4 * (v.big - v.wrap) / Math.max(1, v.n)) / 100, byArm: v.byArm }])),
    worst20: S.worst.slice(0, 20).map((w) => ({ at: fmtEt(w.t), label: w.label, bus: w.bus, stop: net.stopById.get(w.stop)?.name ?? w.stop, dStop: w.dStop, shown: `${Math.round(w.from)}s -> ${Math.round(w.to)}s`, geom: w.geom, feed: w.feed, arm: w.arm })),
  };
}
// departures: error of the promise to the next stop at fixed offsets around the departure instant
{
  const scored = episodes.filter((e) => e.truthAt !== null);
  for (const arm of ARMS) {
    if (arm === "replica") continue;
    const byOff: Record<string, { errs: number[]; wrongWay: number; n: number }> = {};
    for (const off of DEPART_OFFSETS) byOff[String(off)] = { errs: [], wrongWay: 0, n: 0 };
    let nEp = 0, nRise = 0, nFall = 0;
    for (const e of scored) {
      const s = e.series.get(arm);
      if (!s || s.length < 4) continue;
      nEp++;
      const at = (offS: number) => {
        const want = e.departAt + offS * 1000;
        let best: { t: number; eta: number } | null = null;
        for (const x of s) if (best === null || Math.abs(x.t - want) < Math.abs(best.t - want)) best = x;
        return best && Math.abs(best.t - want) <= 6000 ? best : null;
      };
      const before = at(-5), after = at(5);
      if (before && after) {
        const dA = (after.t + after.eta * 1000) - (before.t + before.eta * 1000);
        if (dA > 60_000) nRise++; else if (dA < -60_000) nFall++;
      }
      for (const off of DEPART_OFFSETS) {
        const x = at(off);
        if (!x) continue;
        const b = byOff[String(off)]!;
        b.n++;
        b.errs.push(((x.t + x.eta * 1000) - e.truthAt!) / 1000);
      }
    }
    out.departures[arm] = {
      episodes: nEp, promiseRoseAtDeparture: nRise, promiseFellAtDeparture: nFall,
      byOffset: Object.fromEntries(DEPART_OFFSETS.map((off) => { const b = byOff[String(off)]!; return [off, { n: b.n, medianAbs: r1(pct(b.errs.map(Math.abs), 0.5)), medianSigned: r1(pct(b.errs, 0.5)), p90Abs: r1(pct(b.errs.map(Math.abs), 0.9)) }]; })),
    };
  }
  out.departures.meta = { episodes: episodes.length, scored: scored.length, layoverMinS: LAYOVER_MIN_S, offsetsSec: DEPART_OFFSETS };
}
// paired departures
{
  const q = (a: number[], p: number) => r1(pct(a, p));
  out.pairedDepartures = { n: pairedDeps.length, byArm: {} };
  for (const arm of ARMS) {
    if (arm === "shipped") continue;
    const d0 = pairedDeps.map((d) => d.a[arm]![0]! - d.s[0]!).filter(Number.isFinite);
    const d6 = pairedDeps.map((d) => d.a[arm]![DEPART_POLLS]! - d.s[DEPART_POLLS]!).filter(Number.isFinite);
    const worst = pairedDeps.map((d) => ({ d0: d.a[arm]![0]! - d.s[0]!, d })).filter((x) => Number.isFinite(x.d0)).sort((a, b) => b.d0 - a.d0).slice(0, 6)
      .map((x) => ({ at: fmtEt(x.d.t), bus: x.d.bus, label: x.d.label, stop: net.stopById.get(x.d.stop)?.name ?? x.d.stop, shipped: x.d.s.map(Math.round).join(" "), arm: x.d.a[arm]!.map(Math.round).join(" ") }));
    const byLabel: Record<string, { n: number; over300: number }> = {};
    for (const d of pairedDeps) { const v = d.a[arm]![0]! - d.s[0]!; if (!Number.isFinite(v)) continue; const b = byLabel[d.label] ??= { n: 0, over300: 0 }; b.n++; if (v > 300) b.over300++; }
    out.pairedDepartures.byArm[arm] = {
      atDeparturePoll: { p50: q(d0, 0.5), p90: q(d0, 0.9), p99: q(d0, 0.99), over60: d0.filter((x) => x > 60).length, over300: d0.filter((x) => x > 300).length, underMinus60: d0.filter((x) => x < -60).length },
      sixPollsLater: { p50: q(d6, 0.5), p90: q(d6, 0.9), p99: q(d6, 0.99), over300: d6.filter((x) => x > 300).length },
      byLabel, worst,
    };
  }
}
for (const inc of incidents) if (inc.rows.length) out.incidents.push({ label: inc.label, bus: inc.bus, target: inc.target, targetName: inc.target !== undefined ? net.stopById.get(inc.target)?.name : undefined, truthAt: inc.truthAt ? new Date(inc.truthAt).toISOString() : null, rows: inc.rows });

fs.mkdirSync(OUT_DIR, { recursive: true });
const outName = process.env.OUT_NAME ?? "belief-scoreboard.json";
fs.writeFileSync(`${OUT_DIR}/${outName}`, JSON.stringify(out, null, 1));

// ---- console ---------------------------------------------------------------
const P = (s: unknown, w: number) => String(s).padStart(w);
console.log(`\npositions: ${posSource}  window ${out.window.start} .. ${out.window.end} ET, ${polls.length} polls`);
console.log(`replica mismatches: ${replicaMismatch} (must be 0)\n`);
console.log("JITTER = catastrophic jumps (>=300 s) minus wraps-at-stop (the series flipping to next lap while the bus is within 75 m of the stop, which the metric requires).");
console.log("arm               n       |jump| p50/p90/p99/p99.9    big>=300s    wraps    JITTER          EVENTLESS-jitter   board>=300s    frozen% frz-mov%   up%   acc med/bias  near10 med/bias");
for (const arm of ARMS) {
  const a = out.arms[arm];
  console.log(`${arm.padEnd(16)} ${P(a.n, 8)}  ${P(a.jumpAbs.p50, 4)}/${P(a.jumpAbs.p90, 5)}/${P(a.jumpAbs.p99, 6)}/${P(a.jumpAbs.p999, 7)}  ${P(a.big, 6)} (${P(a.bigPct, 4)}%) ${P(a.wrapAtStop, 6)}  ${P(a.jitter, 6)} (${P(a.jitterPct, 4)}%)  ${P(a.eventlessJitter, 6)} (${P(a.eventlessJitterPct, 4)}%)  ${P(a.bigBoard, 6)} (${P(a.bigBoardPct, 4)}%)  ${P(a.frozenPct, 6)} ${P(a.frozenWhileMovingPct, 7)}  ${P(a.countdownUpPct, 5)}  ${P(a.accuracy.medianAbs, 5)}/${P(a.accuracy.meanSigned, 6)}  ${P(a.accuracyNear10min.medianAbs, 5)}/${P(a.accuracyNear10min.meanSigned, 6)}`);
}
console.log("\n== catastrophic jumps by GEOMETRY (wrap at stop = legit) ==");
{
  const evs = new Set<string>();
  for (const arm of ARMS) for (const k of Object.keys(out.arms[arm].bigByGeom)) evs.add(k);
  console.log(`${"".padEnd(24)}${ARMS.map((a) => a.padStart(16)).join("")}`);
  for (const e of evs) console.log(`${e.padEnd(24)}${ARMS.map((a) => P(out.arms[a].bigByGeom[e] ?? 0, 16)).join("")}`);
}
console.log("\n== catastrophic jumps by what the FEED did ==");
{
  const evs = new Set<string>();
  for (const arm of ARMS) for (const k of Object.keys(out.arms[arm].bigByFeed)) evs.add(k);
  console.log(`${"".padEnd(34)}${ARMS.map((a) => a.padStart(16)).join("")}`);
  for (const e of evs) console.log(`${e.padEnd(34)}${ARMS.map((a) => P(out.arms[a].bigByFeed[e] ?? 0, 16)).join("")}`);
}
console.log("\n== catastrophic jumps by what the ARM did ==");
{
  const evs = new Set<string>();
  for (const arm of ARMS) for (const k of Object.keys(out.arms[arm].bigByArm)) evs.add(k);
  console.log(`${"".padEnd(44)}${ARMS.map((a) => a.padStart(16)).join("")}`);
  for (const e of evs) console.log(`${e.padEnd(44)}${ARMS.map((a) => P(out.arms[a].bigByArm[e] ?? 0, 16)).join("")}`);
}
console.log("\n== EVENTLESS JITTER (no feed event, not a wrap at the stop) by what the ARM did ==");
{
  const evs = new Set<string>();
  for (const arm of ARMS) for (const k of Object.keys(out.arms[arm].bigEventlessByArm)) evs.add(k);
  console.log(`${"".padEnd(44)}${ARMS.map((a) => a.padStart(16)).join("")}`);
  for (const e of evs) console.log(`${e.padEnd(44)}${ARMS.map((a) => P(out.arms[a].bigEventlessByArm[e] ?? 0, 16)).join("")}`);
}
console.log("\n== JITTER rate by route, % (count) ==");
{
  const labs = new Set<string>();
  for (const arm of ARMS) for (const k of Object.keys(out.arms[arm].bigByLabel)) labs.add(k);
  console.log(`${"".padEnd(16)}${ARMS.map((a) => a.padStart(16)).join("")}`);
  for (const l of labs) console.log(`${l.padEnd(16)}${ARMS.map((a) => P(`${(out.arms[a].bigByLabel[l]?.jitterPct ?? 0).toFixed(2)} (${out.arms[a].bigByLabel[l]?.jitter ?? 0})`, 16)).join("")}`);
  console.log("\n   eventless jitter by route (count)");
  for (const l of labs) console.log(`${l.padEnd(16)}${ARMS.map((a) => P(out.arms[a].bigByLabel[l]?.eventlessJitter ?? 0, 16)).join("")}`);
}
console.log(`\n== departures: promise to the NEXT stop around the departure instant (${out.departures.meta.scored} clean layovers with truth; error = promised - actual arrival, s) ==`);
console.log(`arm               eps   rose/fell@dep   ${DEPART_OFFSETS.map((o) => P(`${o}s`, 12)).join("")}`);
for (const arm of ARMS) {
  if (arm === "replica") continue;
  const d = out.departures[arm];
  console.log(`${arm.padEnd(16)} ${P(d.episodes, 4)}   ${P(d.promiseRoseAtDeparture, 4)}/${P(d.promiseFellAtDeparture, 4)}       ${DEPART_OFFSETS.map((o) => { const b = d.byOffset[o]; return P(`${b.medianSigned}`, 12); }).join("")}`);
}
console.log("  (median SIGNED error; a well-behaved departure goes to ~0 and stays; positive = promised later than it came)");
console.log(`\n== PAIRED departures (verifier's metric): at each production at_stop_id -> null, arm minus shipped for the next stop (${out.pairedDepartures.n} departures) ==`);
console.log("arm               @departure p50/p90/p99     >60s   >300s  <-60s   | +6 polls p50/p90/p99    >300s");
for (const arm of ARMS) {
  if (arm === "shipped") continue;
  const d = out.pairedDepartures.byArm[arm];
  const A = d.atDeparturePoll, B = d.sixPollsLater;
  console.log(`${arm.padEnd(16)} ${P(A.p50, 7)}/${P(A.p90, 7)}/${P(A.p99, 7)}  ${P(A.over60, 5)}  ${P(A.over300, 5)}  ${P(A.underMinus60, 5)}   | ${P(B.p50, 7)}/${P(B.p90, 7)}/${P(B.p99, 7)}  ${P(B.over300, 5)}`);
  const bl = Object.entries(d.byLabel).filter(([, v]) => (v as any).over300 > 0).map(([l, v]) => `${l} ${(v as any).over300}/${(v as any).n}`).join(", ");
  if (bl) console.log(`                 >300 s by route: ${bl}`);
  for (const w of d.worst.slice(0, 3)) if (Number(w.arm.split(" ")[0]) - Number(w.shipped.split(" ")[0]) > 300) console.log(`                 worst ${w.at} ${w.bus} ${w.label} -> ${w.stop}: shipped [${w.shipped}] arm [${w.arm}]`);
}
for (const inc of out.incidents) {
  console.log(`\n== ${inc.label}: promise to ${inc.targetName} (stop ${inc.target}), truth arrival ${inc.truthAt ?? "n/a"} ==`);
  const arms = ARMS.filter((a) => a !== "replica");
  console.log(`utc       moved  dStop  near  at    truth ${arms.map((a) => a.padStart(10)).join("")}`);
  let prevSig = "";
  for (const r of inc.rows) {
    const sig = arms.map((a) => r[a]).join(",") + `|${r.nearest}|${r.at}`;
    if (sig === prevSig && r.moved === 0) continue;
    prevSig = sig;
    console.log(`${r.utc}  ${P(r.moved ?? "-", 4)}  ${P(r.dStop, 5)}  ${P(r.nearest ?? "-", 4)}  ${P(r.at ?? "-", 4)}  ${P(r.truth ?? "-", 5)} ${arms.map((a) => P(r[a] ?? "-", 10)).join("")}`);
  }
}
console.log(`\n-> ${OUT_DIR}/${outName}`);
