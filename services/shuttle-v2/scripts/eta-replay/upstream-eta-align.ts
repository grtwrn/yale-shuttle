/**
 * Q2 (replay arm) — OUR estimator at the moments upstream spoke.
 *
 * Replays the real client (`computeUpcomingArrivals`, the ring estimator on
 * every route it serves, the legacy arithmetic where it declines) over a
 * position capture exactly as gps-replay.ts does — same detector replay for
 * `at_stop_id` / `at_stop_since`, same time-travelled calibration, the same
 * `PAYLOAD_PATCH` for the model's tables, one shared per-vehicle store so the
 * belief is stepped on EVERY poll in time order — and, at each poll that is
 * the nearest to an upstream (bus, 15 s bucket), prices the stops upstream
 * listed for that bus. One output row per upstream row: what upstream said,
 * what we said at the same instant about the same stop, and the same truth.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap-0906-1230.db \
 *     PAYLOAD_PATCH=./scripts/.eta-replay/upstream-eta/model-patch-0905.json \
 *     FROM=2026-09-05T04:00:00Z TO=2026-09-06T04:00:00Z OUT_NAME=ours-0905.jsonl \
 *     npx tsx scripts/eta-replay/upstream-eta-align.ts
 *
 * Env: REPLAY_DB, CAPTURES, FROM/TO (the upstream rows scored; the capture is
 * read from an hour earlier so the detector and the belief are warm),
 * PAYLOAD_PATCH (model-patch.ts bounded at the day's start), MODEL_ROUTES
 * (as gps-replay.ts: "" = legacy everywhere, unset = the tree's allowlist),
 * OUT_NAME. `upstream-eta-blend.ts` reads the rows.
 */
import fs from "node:fs";
import path from "node:path";

import {
  SEGMENT_WINDOW_MS, loadNet, loadSamples, makeCalibCache, routeAdjacency, segmentTimesFor, serveRoute,
  type AdjEntry, type ServedRoute,
} from "./common.js";
import {
  MATCH_MS, ensureOut, etDay, fmtEt, horizonOf, loadArrivals, loadCaptures, loadUpstream, makeLastSeen, makeProximity,
  parseWindow, tracksByBus, truthFor, type Pos,
} from "./upstream-eta-common.js";
import { planTracks, stepMany, type BusObservation, type BusState } from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { median } from "../../src/calibrator/shrinkage.js";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from "../../web/src/arrivals";
import { isBusOnRoute, registerRoutePaths } from "../../web/src/anchor";
import type { AnchorStore } from "../../web/src/eta/index.js";
import { PACE_KEY, paceCarrier, type PaceEntry } from "../../src/server/v1compat";
import type { BusData } from "../../web/src/map-data";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const AT_STOP_MAX_M = 75; // collector.ts
/** An upstream bucket is floored to 15 s; the poll nearest its midpoint, within this, is "the same instant". */
const ALIGN_MS = 12_500;

const net = loadNet();
const { db, network } = net;
registerRoutePaths(net.routePaths);
if (process.env.MODEL_ROUTES !== undefined) {
  (globalThis as { __SHUTTLE_MODEL_ROUTES__?: ReadonlySet<string> }).__SHUTTLE_MODEL_ROUTES__ = new Set(process.env.MODEL_ROUTES.split(",").map((x) => x.trim()).filter(Boolean));
  log(`MODEL_ROUTES=${JSON.stringify(process.env.MODEL_ROUTES)}`);
}

const { from, to } = parseWindow();
const up = loadUpstream(db, from, to);
if (up.length === 0) throw new Error("no upstream rows in window");
const winFrom = up[0]!.at;
const winTo = up[up.length - 1]!.at;
log(`upstream rows ${up.length}, ${fmtEt(winFrom)} .. ${fmtEt(winTo)} ET`);

// Positions: an hour of lead-in so the detector state and the belief are warm
// at the first upstream row, and MATCH_MS of tail for the proximity truth.
const pos = loadCaptures(winFrom - 3_600_000, winTo + MATCH_MS + 600_000);
log(`capture rows ${pos.length}`);
const rawStart = pos[0]!.t;
const rawEnd = pos[pos.length - 1]!.t;
const tracks = tracksByBus(pos);
const stopCoordsMap = new Map<number, { lat: number; lon: number }>(net.stops.map((s) => [s.id, { lat: s.lat, lon: s.lon }]));
const proximityArrival = makeProximity(tracks, stopCoordsMap);
const lastSeenAfter = makeLastSeen(tracks);
const arrivals = loadArrivals(db, winFrom - 3_600_000, winTo + MATCH_MS + 60_000);

// -- Time-travelled calibration (as gps-replay.ts) --------------------------------
const samples = loadSamples(net, rawStart - SEGMENT_WINDOW_MS - 3_600_000, rawEnd + 3_600_000);
const calibCache = makeCalibCache(samples, network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));
interface PayloadPatch { segments?: Record<string, Record<string, Record<string, unknown>>>; dwells?: Record<string, Record<string, Record<string, unknown>>>; pace?: Record<string, PaceEntry> }
const patch: PayloadPatch | null = process.env.PAYLOAD_PATCH ? (JSON.parse(fs.readFileSync(process.env.PAYLOAD_PATCH, "utf8")) as PayloadPatch) : null;
if (patch) log(`payload patch ${process.env.PAYLOAD_PATCH}: segments ${Object.values(patch.segments ?? {}).reduce((n, r) => n + Object.keys(r).length, 0)} keys, dwells ${Object.values(patch.dwells ?? {}).reduce((n, r) => n + Object.keys(r).length, 0)} keys, pace ${Object.keys(patch.pace ?? {}).length} routes`);
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
    if (patch?.segments) for (const [rid, byKey] of Object.entries(patch.segments)) {
      const r = (segmentTimes[rid] ??= {});
      for (const [k, fields] of Object.entries(byKey)) Object.assign((r[k] ??= { avg: 0, n: 0 } as any), fields);
    }
    if (patch?.pace) for (const [rid, entry] of Object.entries(patch.pace)) (segmentTimes[rid] ??= {})[PACE_KEY] = paceCarrier(entry) as any;
    servedCache.set(String(bs), (p = { served, segmentTimes }));
  }
  return p;
}
const DWELL_WINDOW_MS = 14 * 86_400_000;
const DWELL_LOW_QUANTILE = 0.35;
const DWELL_LOW_MIN_SAMPLES = 5;
interface DwellGroup { at: Float64Array; done: Float64Array; sec: Float64Array; dow: Int8Array; hour: Int8Array }
const dwellGroups = new Map<string, DwellGroup>();
{
  const rows = db
    .prepare(`SELECT route_id r, stop_id s, arrived_at a, dwell_sec d, dow, hour FROM arrivals WHERE dwell_sec IS NOT NULL AND arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at`)
    .all(rawStart - DWELL_WINDOW_MS - 3_600_000, rawEnd) as Array<{ r: number; s: number; a: number; d: number; dow: number; hour: number }>;
  const tmp = new Map<string, Array<{ a: number; d: number; dow: number; hour: number }>>();
  for (const x of rows) (tmp.get(`${x.r}:${x.s}`) ?? tmp.set(`${x.r}:${x.s}`, []).get(`${x.r}:${x.s}`)!).push(x);
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
function percentileOf(a: number[], q: number): number {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
const dwellPayloadCache = new Map<string, DwellTimes>();
function dwellPayloadAt(t: number): DwellTimes {
  const start = calibCache.bucketStart(t);
  const hit = dwellPayloadCache.get(String(start));
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
    if (all.length === 0) continue;
    const priorMedian = median(all);
    const low = all.length >= DWELL_LOW_MIN_SAMPLES ? percentileOf(all, DWELL_LOW_QUANTILE) : undefined;
    let stat: { med: number; sd: number; n: number; low?: number };
    if (win.length === 0) stat = { med: priorMedian, sd: Math.max(percentileOf(all, 0.9) - priorMedian, 5), n: 0, ...(low !== undefined ? { low } : {}) };
    else {
      const med = median(win);
      stat = { med, sd: Math.max(percentileOf(win, 0.9) - med, 5), n: win.length, ...(low !== undefined ? { low: Math.min(low, med) } : {}) };
    }
    (out[rid!] ||= {})[sid!] = { med: Math.round(stat.med * 10) / 10, sd: Math.round(stat.sd * 10) / 10, n: stat.n, ...(stat.low !== undefined ? { low: Math.round(stat.low * 10) / 10 } : {}) };
  }
  if (patch?.dwells) for (const [rid, byKey] of Object.entries(patch.dwells)) {
    const r = (out[rid] ??= {});
    for (const [k, fields] of Object.entries(byKey)) Object.assign((r[k] ??= { med: 0, sd: 0, n: 0 } as any), fields);
  }
  dwellPayloadCache.set(String(start), out);
  return out;
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
interface Obs { bus: BusData; t: number; routeId: number; atStop: boolean; moved: boolean }
const observations: Obs[] = [];
{
  const states = new Map<string, BusState>();
  const lastFix = new Map<string, { lat: number; lon: number }>();
  for (const poll of polls) {
    const plan = planTracks(poll);
    stepMany(network, states, poll, plan);
    for (const o of poll) {
      const key = plan.keys.get(o.busId) ?? o.busName;
      const st = states.get(key);
      const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
      const cand = st && dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
      const atStop = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.enteredAt } : null;
      const prev = lastFix.get(o.busName);
      const moved = !prev || prev.lat !== o.lat || prev.lon !== o.lon;
      lastFix.set(o.busName, { lat: o.lat, lon: o.lon });
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
      observations.push({ bus, t: o.collectedAt, routeId: o.routeId, atStop: atStop != null, moved });
    }
  }
}
log(`observations ${observations.length}`);

// -- Which poll answers for which upstream bucket ----------------------------------
// Upstream groups: (bus, bucket) → the stops it listed. The poll nearest the
// bucket's midpoint (within ALIGN_MS) is the instant we price them at.
interface Group { bus: string; at: number; rows: Array<{ id: number; stopId: number; sec: number; routeId: number; fromStopId: number; stopsAhead: number }> }
const groups = new Map<string, Group>();
for (const u of up) {
  const k = `${u.bus}:${u.at}`;
  let g = groups.get(k);
  if (!g) groups.set(k, (g = { bus: u.bus, at: u.at, rows: [] }));
  g.rows.push({ id: u.id, stopId: u.stopId, sec: u.sec, routeId: u.routeId, fromStopId: u.fromStopId, stopsAhead: u.stopsAhead });
}
const obsTimes = new Map<string, number[]>();
for (const o of observations) (obsTimes.get(o.bus.bus_name) ?? obsTimes.set(o.bus.bus_name, []).get(o.bus.bus_name)!).push(o.t);
const groupAtPoll = new Map<string, Group[]>();
let unaligned = 0;
for (const g of groups.values()) {
  const ts = obsTimes.get(g.bus);
  if (!ts) { unaligned++; continue; }
  const mid = g.at + 7_500;
  let lo = 0, hi = ts.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (ts[m]! < mid) lo = m + 1; else hi = m; }
  let best = -1;
  for (const i of [lo - 1, lo]) if (i >= 0 && i < ts.length && (best < 0 || Math.abs(ts[i]! - mid) < Math.abs(ts[best]! - mid))) best = i;
  if (best < 0 || Math.abs(ts[best]! - mid) > ALIGN_MS) { unaligned++; continue; }
  const k = `${g.bus}:${ts[best]}`;
  (groupAtPoll.get(k) ?? groupAtPoll.set(k, []).get(k)!).push(g);
}
log(`upstream groups ${groups.size}, unaligned (no poll within ${ALIGN_MS} ms) ${unaligned}`);

// -- Replay ---------------------------------------------------------------------------
interface OutRow {
  id: number; day: string; bus: string; routeId: number; stopId: number; at: number; t: number;
  upSec: number; upHorizon: string; upFrom: number; upAhead: number;
  our: number | null; ourLow: number | null; ourHigh: number | null; ourAhead: number | null; ourWhy: string | null;
  atStop: boolean; moved: boolean;
  kind: string; det: number | null; prox: number | null; vanishedAt: number | null;
}
const outRows: OutRow[] = [];
const clientStore: AnchorStore = new Map();
const counts = { obs: observations.length, noRouteCfg: 0, offRoute: 0, priced: 0, notPriced: 0 };
let lastLog = Date.now();
for (const o of observations) {
  const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(o.routeId));
  if (!cfg) { counts.noRouteCfg++; continue; }
  const stops = mergedRouteStops(cfg, net.routeStops);
  const gs = groupAtPoll.get(`${o.bus.bus_name}:${o.t}`);
  const onRoute = isBusOnRoute(o.bus, stops, net.stopCoords);
  if (!onRoute) counts.offRoute++;
  // Every poll steps the belief (one target keeps the call cheap); the
  // aligned polls price what upstream listed.
  const targets = new Set<number>([stops[0]!]);
  if (gs) for (const g of gs) for (const r of g.rows) targets.add(r.stopId);
  const payload = payloadAt(o.t);
  const real = onRoute
    ? computeUpcomingArrivals([...targets], [o.bus], net.routeStops, net.stopCoords, payload.segmentTimes, o.t, dwellPayloadAt(o.t), clientStore).filter((a) => a.routeLabel === cfg.label)
    : [];
  if (!gs) continue;
  for (const g of gs) {
    for (const r of g.rows) {
      // Earliest of our arrivals at that stop (a repeated stop has two).
      const ours = real.filter((a) => a.stopId === r.stopId).sort((a, b) => a.eta - b.eta)[0];
      const tr = truthFor(arrivals, g.bus, r.routeId, r.stopId, g.at);
      const det = tr.det;
      const prox = det === null ? null : proximityArrival(g.bus, r.stopId, det);
      let vanishedAt: number | null = null;
      if (tr.kind === "missing") {
        const last = lastSeenAfter(g.bus, g.at);
        vanishedAt = last !== null && last < g.at + MATCH_MS ? last : null;
      }
      if (ours) counts.priced++; else counts.notPriced++;
      outRows.push({
        id: r.id, day: etDay(g.at), bus: g.bus, routeId: r.routeId, stopId: r.stopId, at: g.at, t: o.t,
        upSec: r.sec, upHorizon: horizonOf(r.sec), upFrom: r.fromStopId, upAhead: r.stopsAhead,
        our: ours ? Math.round(ours.eta * 10) / 10 : null, ourLow: ours ? Math.round(ours.low * 10) / 10 : null, ourHigh: ours ? Math.round(ours.high * 10) / 10 : null,
        ourAhead: ours ? ours.stopsAhead : null,
        ourWhy: ours ? null : !onRoute ? "offRoute" : r.routeId !== o.routeId ? "routeMismatch" : "noArrival",
        atStop: o.atStop, moved: o.moved,
        kind: tr.kind, det, prox, vanishedAt,
      });
    }
  }
  if (Date.now() - lastLog > 30_000) { lastLog = Date.now(); log(`${fmtEt(o.t)} rows ${outRows.length}`); }
}
log(`done: ${JSON.stringify(counts)}`);
const outName = process.env.OUT_NAME ?? "ours.jsonl";
fs.writeFileSync(path.join(ensureOut(), outName), outRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
log(`wrote ${path.join(ensureOut(), outName)} (${outRows.length} rows)`);
