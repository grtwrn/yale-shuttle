/**
 * Shared machinery for the offline ETA replay: DB load, the real
 * TransitNetwork, and a time-travelling calibration engine that reproduces
 * what the calibrator would have served at any past instant, plus the
 * alternative estimators under test.
 *
 * Run with:  cd services/shuttle-v2 && TZ=America/New_York npx tsx <script>
 * (the calibrator uses getDay()/getHours(), which must be ET as in prod).
 */
import { createRequire } from "node:module";

import { TransitNetwork } from "../../src/network/TransitNetwork.js";
import { distanceMeters } from "../../src/network/geo.js";
import {
  computeSegmentStats,
  hourWindow,
  type ValueGroup,
} from "../../src/calibrator/calibrator.js";
import { median, shrink } from "../../src/calibrator/shrinkage.js";
import { haversineMeters } from "../../web/src/geo";
import { BUS_SPEED_M_S } from "../../web/src/routes";
import type { Route, Stop } from "../../src/schema/api.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// A read-only COPY of the production database (see README.md for how to take
// one) — never point this at the live volume.
export const SNAP_DB = process.env.REPLAY_DB ?? "./store/snap.db";
export const OUT_DIR = process.env.REPLAY_OUT ?? "./scripts/.eta-replay";

if (Intl.DateTimeFormat().resolvedOptions().timeZone !== "America/New_York") {
  throw new Error("run with TZ=America/New_York (calibrator uses local getDay/getHours)");
}

export const DAY_MS = 86_400_000;
export const SEGMENT_WINDOW_MS = 30 * DAY_MS; // calibrator.ts SEGMENT_WINDOW_DAYS
export const SHRINKAGE_K = 8; // calibrator.ts
export const MAX_PLAUSIBLE_M_S = 22; // calibrator.ts
export const HOUR_WINDOW = 1; // calibrator.ts

export const round1 = (x: number): number => Math.round(x * 10) / 10; // v1compat.ts

export function openDb() {
  return new Database(SNAP_DB, { readonly: true });
}

export interface Net {
  db: any;
  network: TransitNetwork;
  stops: Stop[];
  routes: Route[];
  stopById: Map<number, Stop>;
  routeById: Map<number, Route>;
  /** Client-shaped tables. */
  routeStops: Record<string, number[]>;
  stopCoords: Record<number, { lat: number; lon: number }>;
  routePaths: Record<string, [number, number][]>;
}

export function loadNet(): Net {
  const db = openDb();
  const stops = db
    .prepare("SELECT id, name, lat, lon FROM stops")
    .all() as Stop[];
  const routes = (
    db
      .prepare("SELECT id, name, short_name, color, stops_json, path_json FROM routes")
      .all() as any[]
  ).map((r) => {
    const stopsSeq = JSON.parse(r.stops_json) as number[];
    let path: [number, number][] | undefined;
    try {
      path = r.path_json ? (JSON.parse(r.path_json) as [number, number][]) : undefined;
    } catch {
      path = undefined;
    }
    return {
      id: r.id as number,
      name: r.name as string,
      shortName: r.short_name as string,
      color: r.color as string,
      stops: stopsSeq,
      ...(path ? { path } : {}),
    } as Route;
  });
  const network = TransitNetwork.build(stops, routes);
  const routeStops: Record<string, number[]> = {};
  const routePaths: Record<string, [number, number][]> = {};
  for (const r of routes) {
    routeStops[String(r.id)] = r.stops;
    if (r.path) routePaths[String(r.id)] = r.path;
  }
  const stopCoords: Record<number, { lat: number; lon: number }> = {};
  for (const s of stops) stopCoords[s.id] = { lat: s.lat, lon: s.lon };
  return {
    db,
    network,
    stops,
    routes,
    stopById: new Map(stops.map((s) => [s.id, s])),
    routeById: new Map(routes.map((r) => [r.id, r])),
    routeStops,
    stopCoords,
    routePaths,
  };
}

// -- Segment samples ----------------------------------------------------------

export interface Group {
  key: string;
  idx: number;
  routeId: number;
  from: number;
  to: number;
  /** Server straight-line metres (equirectangular), null when a stop is unknown. */
  meters: number | null;
  at: Float64Array; // started_at, ascending
  end: Float64Array; // started_at + travel_sec*1000 (when the row was written)
  sec: Float64Array;
  dow: Int8Array;
  hour: Int8Array;
  ok: Uint8Array; // passes the calibrator's plausibility filter
}

export interface Samples {
  groups: Group[];
  byKey: Map<string, number>;
  rows: number;
  from: number;
  to: number;
}

/** Load every segment row with started_at in [from, to) grouped by (route, from, to). */
export function loadSamples(net: Net, from: number, to: number): Samples {
  const rows = net.db
    .prepare(
      `SELECT route_id r, from_stop_id f, to_stop_id t, travel_sec s, started_at a, dow d, hour h
       FROM segments WHERE started_at >= ? AND started_at < ? ORDER BY started_at, id`,
    )
    .all(from, to) as Array<{ r: number; f: number; t: number; s: number; a: number; d: number; h: number }>;
  const tmp = new Map<string, { r: number; f: number; t: number; a: number[]; s: number[]; d: number[]; h: number[] }>();
  for (const row of rows) {
    const key = TransitNetwork.segmentKey(row.r, row.f, row.t);
    let g = tmp.get(key);
    if (!g) tmp.set(key, (g = { r: row.r, f: row.f, t: row.t, a: [], s: [], d: [], h: [] }));
    g.a.push(row.a);
    g.s.push(row.s);
    g.d.push(row.d);
    g.h.push(row.h);
  }
  const groups: Group[] = [];
  const byKey = new Map<string, number>();
  for (const [key, g] of tmp) {
    const a = net.stopById.get(g.f);
    const b = net.stopById.get(g.t);
    const meters = a && b ? distanceMeters(a, b) : null;
    const n = g.a.length;
    const ok = new Uint8Array(n);
    const end = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const sec = g.s[i]!;
      // calibrator.ts `plausible`: sec > 0 && meters / sec <= MAX_PLAUSIBLE_M_S;
      // unfiltered when geometry is unknown.
      ok[i] = meters == null ? 1 : sec > 0 && meters / sec <= MAX_PLAUSIBLE_M_S ? 1 : 0;
      end[i] = g.a[i]! + sec * 1000;
    }
    const idx = groups.length;
    groups.push({
      key,
      idx,
      routeId: g.r,
      from: g.f,
      to: g.t,
      meters,
      at: Float64Array.from(g.a),
      end,
      sec: Float64Array.from(g.s),
      dow: Int8Array.from(g.d),
      hour: Int8Array.from(g.h),
      ok,
    });
    byKey.set(key, idx);
  }
  return { groups, byKey, rows: rows.length, from, to };
}

export function lowerBound(arr: Float64Array, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// -- Calibration variants -----------------------------------------------------

export const CALIB_NAMES = [
  "base", // real calibrator: dow + hour±1 window, k=8, 30-day median prior
  "hourOnly", // V2: hour±1 across all days
  "wkdayWkend", // V3: weekday/weekend class + hour±1
  "recent7prior", // V4: prior = 7-day median (>=5 samples) else 30-day
  "k2", // V5
  "k4",
  "k16",
  "winMedian", // window median shrunk to prior (instead of window mean)
  "medianOnly", // no window at all: serve the 30-day median (k=inf)
  "hourOnlyMedian", // hour±1 window, median shrunk to prior
] as const;
export type CalibName = (typeof CALIB_NAMES)[number];

export interface Calib {
  /** Served avg per group index (round1'd, as the payload does); NaN when the group is omitted. */
  avg: Float64Array;
  /** Served sd per group index (baseline only is meaningful). */
  sd: Float64Array;
  /** Windowed (plausible) sample count per group — the payload's `n`. */
  n: Int32Array;
}

export interface BucketCalib {
  start: number;
  dow: number;
  hour: number;
  byName: Record<CalibName, Calib>;
  /** Replica-vs-real check: max |diff| of mean over groups, and count mismatched. */
  check: { maxDiff: number; mismatched: number; groups: number };
}

const isWeekend = (dow: number) => dow === 0 || dow === 6;

/**
 * Everything the calibrator would have served at `start` (ET hour bucket
 * start), using only segment rows that had COMPLETED before `start` — i.e.
 * rows that existed in the DB at that instant. The task suggested
 * `started_at < start`; that admits a sample still in flight at `start`, so
 * the stricter completion bound is used (strictly less lookahead).
 */
export function calibrateAt(samples: Samples, network: TransitNetwork, start: number): BucketCalib {
  const d = new Date(start);
  const dow = d.getDay();
  const hour = d.getHours();
  const hours = hourWindow(hour, HOUR_WINDOW);
  const hourSet = new Set(hours);
  const G = samples.groups.length;
  const mk = (): Calib => ({
    avg: new Float64Array(G).fill(NaN),
    sd: new Float64Array(G).fill(NaN),
    n: new Int32Array(G),
  });
  const byName = Object.fromEntries(CALIB_NAMES.map((nm) => [nm, mk()])) as Record<CalibName, Calib>;

  // Real calibrator input, mirrored from loadSegmentGroups' SQL.
  const realGroups: ValueGroup[] = [];
  const cutoff = start - SEGMENT_WINDOW_MS;
  const cutoff7 = start - 7 * DAY_MS;

  for (const g of samples.groups) {
    const lo = lowerBound(g.at, cutoff);
    const hi = lowerBound(g.at, start);
    if (hi <= lo) continue;
    const all: number[] = [];
    const windowed: number[] = [];
    // Plausible-filtered views for the replica/variants.
    const allP: number[] = [];
    const winBase: number[] = [];
    const winHour: number[] = [];
    const winClass: number[] = [];
    const recent7: number[] = [];
    const bWeekend = isWeekend(dow);
    for (let i = lo; i < hi; i++) {
      if (g.end[i]! > start) continue; // not yet in the DB at `start`
      const v = g.sec[i]!;
      all.push(v);
      const hourIn = hourSet.has(g.hour[i]!);
      const dowIn = g.dow[i] === dow;
      if (dowIn && hourIn) windowed.push(v);
      if (!g.ok[i]) continue;
      allP.push(v);
      if (g.at[i]! >= cutoff7) recent7.push(v);
      if (hourIn) {
        winHour.push(v);
        if (dowIn) winBase.push(v);
        if (isWeekend(g.dow[i]!) === bWeekend) winClass.push(v);
      }
    }
    if (all.length === 0) continue;
    realGroups.push({ key: g.key, n: all.length, all, windowed });
    if (allP.length === 0) continue; // omitted entirely -> distance prior
    const prior30 = median(allP);
    const set = (nm: CalibName, meanV: number, sdV: number, n: number) => {
      const c = byName[nm];
      c.avg[g.idx] = round1(meanV);
      c.sd[g.idx] = round1(sdV);
      c.n[g.idx] = n;
    };
    // base (replica of computeSegmentStats)
    {
      const est = shrink({ samples: winBase, priorMean: prior30, k: SHRINKAGE_K });
      set("base", est.mean, est.stddev, est.n);
    }
    {
      const est = shrink({ samples: winHour, priorMean: prior30, k: SHRINKAGE_K });
      set("hourOnly", est.mean, est.stddev, est.n);
    }
    {
      const est = shrink({ samples: winClass, priorMean: prior30, k: SHRINKAGE_K });
      set("wkdayWkend", est.mean, est.stddev, est.n);
    }
    {
      const prior = recent7.length >= 5 ? median(recent7) : prior30;
      const est = shrink({ samples: winBase, priorMean: prior, k: SHRINKAGE_K });
      set("recent7prior", est.mean, est.stddev, est.n);
    }
    for (const [nm, k] of [["k2", 2], ["k4", 4], ["k16", 16]] as const) {
      const est = shrink({ samples: winBase, priorMean: prior30, k });
      set(nm, est.mean, est.stddev, est.n);
    }
    {
      const n = winBase.length;
      const m = n > 0 ? (n * median(winBase) + SHRINKAGE_K * prior30) / (n + SHRINKAGE_K) : prior30;
      set("winMedian", m, 5, n);
    }
    set("medianOnly", prior30, 5, winBase.length);
    {
      const n = winHour.length;
      const m = n > 0 ? (n * median(winHour) + SHRINKAGE_K * prior30) / (n + SHRINKAGE_K) : prior30;
      set("hourOnlyMedian", m, 5, n);
    }
  }

  // The real thing, for the baseline — and a check that the replica agrees.
  const real = computeSegmentStats(realGroups, network);
  let maxDiff = 0;
  let mismatched = 0;
  const base = byName.base;
  let present = 0;
  for (const g of samples.groups) {
    const r = real.get(g.key);
    const have = !Number.isNaN(base.avg[g.idx]!);
    if (!r && !have) continue;
    if (!r || !have) {
      mismatched++;
      continue;
    }
    present++;
    const diff = Math.abs(round1(r.mean) - base.avg[g.idx]!);
    if (diff > maxDiff) maxDiff = diff;
    if (diff > 1e-9 || r.n !== base.n[g.idx]) mismatched++;
    // Serve the real function's numbers for the baseline (belt and braces).
    base.avg[g.idx] = round1(r.mean);
    base.sd[g.idx] = round1(r.stddev);
    base.n[g.idx] = r.n;
  }
  return { start, dow, hour, byName, check: { maxDiff, mismatched, groups: present } };
}

/** Memoising bucket cache keyed on the ET-hour start. */
export function makeCalibCache(samples: Samples, network: TransitNetwork, bucketMs = 3_600_000) {
  const cache = new Map<number, BucketCalib>();
  return {
    bucketStart(t: number): number {
      if (bucketMs === 3_600_000) {
        const d = new Date(t);
        return t - (d.getMinutes() * 60_000 + d.getSeconds() * 1000 + d.getMilliseconds());
      }
      const d = new Date(t);
      const hourStart = t - (d.getMinutes() * 60_000 + d.getSeconds() * 1000 + d.getMilliseconds());
      return hourStart + Math.floor((t - hourStart) / bucketMs) * bucketMs;
    },
    get(t: number): BucketCalib {
      const s = this.bucketStart(t);
      let c = cache.get(s);
      if (!c) cache.set(s, (c = calibrateAt(samples, network, s)));
      return c;
    },
    size: () => cache.size,
    all: () => [...cache.values()],
  };
}

// -- Payload / client view ---------------------------------------------------

export interface AdjEntry {
  pos: number;
  from: number;
  to: number;
  key: string; // client key `${from}-${to}`
  gi: number; // group index or -1
  /** getSegmentStats distance prior mean (round1'd as the payload does). */
  priorAvg: number;
  /** Client fallback floor: max(30, haversine / BUS_SPEED_M_S). */
  byDist: number;
}

export function routeAdjacency(net: Net, samples: Samples, routeId: number): AdjEntry[] {
  const r = net.routeById.get(routeId)!;
  const N = r.stops.length;
  const out: AdjEntry[] = [];
  for (let i = 0; i < N; i++) {
    const from = r.stops[i]!;
    const to = r.stops[(i + 1) % N]!;
    const a = net.stopById.get(from);
    const b = net.stopById.get(to);
    let priorAvg: number;
    if (!a || !b) priorAvg = 60;
    else priorAvg = Math.max(20, distanceMeters(a, b) / 5.5);
    const pc = net.stopCoords[from];
    const cc = net.stopCoords[to];
    const byDist = pc && cc ? Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S) : 0;
    out.push({
      pos: i,
      from,
      to,
      key: `${from}-${to}`,
      gi: samples.byKey.get(TransitNetwork.segmentKey(routeId, from, to)) ?? -1,
      priorAvg: round1(priorAvg),
      byDist,
    });
  }
  return out;
}

export interface ServedRoute {
  /** served avg per position */
  avg: Float64Array;
  sd: Float64Array;
  n: Int32Array;
  /** client's route-average of entries with n >= 2 (over unique keys, as Object.values does) */
  avgSeg: number;
  /** per-position value the CURRENT client uses (policy A) */
  clientA: Float64Array;
  /** per-position value if the client trusted the served avg always (policy B) */
  clientB: Float64Array;
}

/** What `/api/buses` would carry for one route under one calibration, and what the client makes of it. */
export function serveRoute(adj: AdjEntry[], calib: Calib): ServedRoute {
  const N = adj.length;
  const avg = new Float64Array(N);
  const sd = new Float64Array(N);
  const n = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const e = adj[i]!;
    const have = e.gi >= 0 && !Number.isNaN(calib.avg[e.gi]!);
    if (have) {
      avg[i] = calib.avg[e.gi]!;
      sd[i] = calib.sd[e.gi]!;
      n[i] = calib.n[e.gi]!;
    } else {
      avg[i] = e.priorAvg;
      sd[i] = round1(e.priorAvg * 0.5);
      n[i] = 0;
    }
  }
  // arrivals.ts: Object.values(routeSegs).filter(s => s.n >= 2) — unique keys.
  const seenKey = new Set<string>();
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < N; i++) {
    const e = adj[i]!;
    if (seenKey.has(e.key)) continue;
    seenKey.add(e.key);
    if (n[i]! >= 2) {
      sum += avg[i]!;
      cnt++;
    }
  }
  const avgSeg = cnt > 0 ? sum / cnt : 0;
  const clientA = new Float64Array(N);
  const clientB = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const e = adj[i]!;
    clientB[i] = avg[i]!;
    if (n[i]! >= 1) clientA[i] = avg[i]!;
    else if (avgSeg > 0 && avgSeg >= e.byDist) clientA[i] = avgSeg;
    else clientA[i] = e.byDist || 90;
  }
  return { avg, sd, n, avgSeg, clientA, clientB };
}

/** Client-shaped `segments[routeId]` map for the real computeUpcomingArrivals. */
export function segmentTimesFor(adj: AdjEntry[], served: ServedRoute): Record<string, { avg: number; sd: number; n: number }> {
  const out: Record<string, { avg: number; sd: number; n: number }> = {};
  for (let i = 0; i < adj.length; i++) {
    out[adj[i]!.key] = { avg: served.avg[i]!, sd: served.sd[i]!, n: served.n[i]! };
  }
  return out;
}

// -- Metrics ------------------------------------------------------------------

export interface Metrics {
  n: number;
  medianAbsSec: number;
  p90AbsSec: number;
  meanSignedSec: number;
  medianSignedSec: number;
  within60: number;
  within120: number;
}

export function metricsOf(errs: ArrayLike<number>): Metrics {
  const n = errs.length;
  if (n === 0) {
    return { n: 0, medianAbsSec: NaN, p90AbsSec: NaN, meanSignedSec: NaN, medianSignedSec: NaN, within60: NaN, within120: NaN };
  }
  const abs = new Float64Array(n);
  const signed = new Float64Array(n);
  let sum = 0;
  let w60 = 0;
  let w120 = 0;
  for (let i = 0; i < n; i++) {
    const e = errs[i]!;
    signed[i] = e;
    const a = Math.abs(e);
    abs[i] = a;
    sum += e;
    if (a <= 60) w60++;
    if (a <= 120) w120++;
  }
  abs.sort();
  signed.sort();
  const q = (arr: Float64Array, p: number) => {
    const rank = (arr.length - 1) * p;
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    return lo === hi ? arr[lo]! : arr[lo]! + (rank - lo) * (arr[hi]! - arr[lo]!);
  };
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    n,
    medianAbsSec: r1(q(abs, 0.5)),
    p90AbsSec: r1(q(abs, 0.9)),
    meanSignedSec: r1(sum / n),
    medianSignedSec: r1(q(signed, 0.5)),
    within60: Math.round((w60 / n) * 1000) / 10,
    within120: Math.round((w120 / n) * 1000) / 10,
  };
}

export function fmtEt(t: number): string {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
