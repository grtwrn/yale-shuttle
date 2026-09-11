/**
 * Shared pieces for the upstream-ETA measurement (docs/upstream-eta-measurement.md).
 *
 * The question: does the operator's own per-stop ETA (`routes_eta.php`,
 * logged by `src/collector/upstreamEta.ts` into `predictions_log` with
 * `surface = "upstream"`) carry information OUR estimator lacks? Every script
 * here is a MEASUREMENT — nothing touches the estimator.
 *
 * Inputs shared by all of them:
 *   REPLAY_DB        a production snapshot (read-only)
 *   CAPTURES         comma-separated position captures (JSONL, one row per bus
 *                    per 5 s poll: bus_id, bus_name, route_id, lat, lon,
 *                    heading, last_stop_id, collected_at). `raw_positions` is
 *                    retention-swept, so the captures are the position record.
 *   FROM / TO        ISO instants bounding the window (default: every upstream row)
 *   REPLAY_OUT       output directory (default scripts/.eta-replay/upstream-eta)
 *
 * Conventions (same as the rest of scripts/eta-replay/): error is
 * predicted − actual in seconds, NEGATIVE = optimistic (the bus came later
 * than promised). Upstream serves WHOLE MINUTES, so ±30 s of its error is
 * rounding before any real disagreement.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

export const SNAP_DB = process.env.REPLAY_DB ?? "./store/snap-0906-1230.db";
export const OUT_DIR = process.env.REPLAY_OUT ?? "./scripts/.eta-replay/upstream-eta";
export const CAPTURE_PATHS: string[] = (process.env.CAPTURES ??
  ["04", "05", "06"].map((d) => path.join(process.env.HOME ?? "", `shuttle-captures/positions-202609${d}.jsonl`)).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const UPSTREAM_SURFACE = "upstream";
/** The spec's pairing window: first arrival after the prediction within 45 min. */
export const MATCH_MS = 45 * 60_000;
/** Upstream records nothing further out than 30 min (MAX_UPSTREAM_ETA_SEC). */
export const UPSTREAM_MAX_SEC = 30 * 60;

export const HORIZONS = [
  { label: "0-2 min", lo: 0, hi: 120 },
  { label: "2-5 min", lo: 120, hi: 300 },
  { label: "5-10 min", lo: 300, hi: 600 },
  { label: "10-30 min", lo: 600, hi: 1800.5 },
] as const;
export type Horizon = (typeof HORIZONS)[number];
export function horizonOf(sec: number): string {
  for (const h of HORIZONS) if (sec >= h.lo && sec < h.hi) return h.label;
  return sec < 0 ? "0-2 min" : ">30 min";
}

export function openDb(): any {
  return new Database(SNAP_DB, { readonly: true });
}

export function parseWindow(): { from: number; to: number } {
  const from = process.env.FROM ? Date.parse(process.env.FROM) : 0;
  const to = process.env.TO ? Date.parse(process.env.TO) : Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("FROM/TO must be ISO instants");
  return { from, to };
}

export const ET = "America/New_York";
export function fmtEt(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { timeZone: ET, hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
/** `YYYY-MM-DD` in ET. */
export function etDay(ms: number): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export const normBus = (s: string): string => s.trim().replace(/^#/, "");

// -- Upstream rows ------------------------------------------------------------
export interface UpstreamRow {
  id: number;
  busId: number;
  bus: string; // normalised bus name
  routeId: number;
  stopId: number;
  /** Where OUR fleet had the bus (last_stop_id), -1 when unseen. */
  fromStopId: number;
  stopsAhead: number;
  sec: number;
  at: number;
}
export function loadUpstream(db: any, from: number, to: number): UpstreamRow[] {
  const rows = db
    .prepare(
      `SELECT id, bus_id, bus_name, route_id, from_stop_id, to_stop_id, stops_ahead, predicted_sec, predicted_at
       FROM predictions_log WHERE surface = ? AND predicted_at >= ? AND predicted_at <= ? ORDER BY predicted_at, id`,
    )
    .all(UPSTREAM_SURFACE, from, to) as any[];
  return rows.map((r) => ({
    id: r.id,
    busId: r.bus_id,
    bus: normBus(r.bus_name),
    routeId: r.route_id,
    stopId: r.to_stop_id,
    fromStopId: r.from_stop_id,
    stopsAhead: r.stops_ahead,
    sec: r.predicted_sec,
    at: r.predicted_at,
  }));
}

// -- Arrivals (detector truth) ------------------------------------------------
export interface ArrivalEv { t: number; d: number | null }
export interface ArrivalsIndex {
  /** key `${bus}:${route}:${stop}` → ascending {t: arrived_at, d: departed_at} */
  byKey: Map<string, ArrivalEv[]>;
  /** key `${bus}:${route}` → ascending {stop, at} */
  seq: Map<string, Array<{ stop: number; at: number }>>;
}
export function loadArrivals(db: any, from: number, to: number): ArrivalsIndex {
  const rows = db
    .prepare(`SELECT bus_name, route_id, stop_id, arrived_at, departed_at FROM arrivals WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at, id`)
    .all(from, to) as Array<{ bus_name: string; route_id: number; stop_id: number; arrived_at: number; departed_at: number | null }>;
  const byKey = new Map<string, ArrivalEv[]>();
  const seq = new Map<string, Array<{ stop: number; at: number }>>();
  for (const a of rows) {
    const b = normBus(a.bus_name);
    const k = `${b}:${a.route_id}:${a.stop_id}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push({ t: a.arrived_at, d: a.departed_at });
    const s = `${b}:${a.route_id}`;
    (seq.get(s) ?? seq.set(s, []).get(s)!).push({ stop: a.stop_id, at: a.arrived_at });
  }
  return { byKey, seq };
}
export function firstAtLeast(sorted: readonly number[], target: number): number | null {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length ? sorted[lo]! : null;
}
/** Index of the first event with t >= target. */
function lowerBoundEv(list: readonly ArrivalEv[], target: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.t < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export type TruthKind = "arrived" | "already" | "missing";
export interface Truth {
  kind: TruthKind;
  /** The detector arrival paired with the prediction (kind = arrived), else null. */
  det: number | null;
  /** kind = already: when the bus reached the stop it is still standing at. */
  since: number | null;
}
/**
 * The detector truth for a prediction made at `at` about (bus, route, stop):
 *
 *  - "already": the bus's latest detected arrival at that stop has no
 *    departure yet at `at` — the bus is STANDING at the stop being predicted.
 *    That is not a forecast (both apps print ~0 there while a layover runs),
 *    so these rows are counted and kept out of every error table. Measured
 *    first: 2,183 of the 2,219 upstream rows at 0–2 min that "did not arrive"
 *    were exactly this — a bus sitting at the stop, so the first arrival at or
 *    after the prediction was a lap away.
 *  - "arrived": the first detected arrival at or after `at`, within 45 min.
 *  - "missing": neither — the bus did not reach the stop within 45 min.
 */
export function truthFor(idx: ArrivalsIndex, bus: string, routeId: number, stopId: number, at: number): Truth {
  const list = idx.byKey.get(`${bus}:${routeId}:${stopId}`);
  if (!list || list.length === 0) return { kind: "missing", det: null, since: null };
  const i = lowerBoundEv(list, at);
  if (i > 0) {
    const prev = list[i - 1]!;
    if (prev.d === null || prev.d >= at) return { kind: "already", det: null, since: prev.t };
  }
  if (i < list.length && list[i]!.t - at <= MATCH_MS) return { kind: "arrived", det: list[i]!.t, since: null };
  return { kind: "missing", det: null, since: null };
}
/** Detector arrival: first arrival of (bus, route, stop) at or after `at`, within MATCH_MS; null = did not arrive. */
export function detectorArrival(idx: ArrivalsIndex, bus: string, routeId: number, stopId: number, at: number): number | null {
  return truthFor(idx, bus, routeId, stopId, at).det;
}

// -- Captures (positions) -----------------------------------------------------
export interface Pos {
  i: number; // bus_id
  b: string; // normalised bus name
  r: number;
  lat: number;
  lon: number;
  h: number;
  l: number | null;
  t: number;
}
/** Every capture row in [from, to], de-duplicated on (bus_id, collected_at), sorted by time then bus. */
export function loadCaptures(from: number, to: number, paths: readonly string[] = CAPTURE_PATHS): Pos[] {
  const seen = new Set<string>();
  const out: Pos[] = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    let start = 0;
    while (start < text.length) {
      let end = text.indexOf("\n", start);
      if (end < 0) end = text.length;
      const line = text.slice(start, end);
      start = end + 1;
      if (!line) continue;
      let j: any;
      try { j = JSON.parse(line); } catch { continue; }
      const t = Number(j.collected_at);
      if (!(t >= from && t <= to)) continue;
      const k = `${j.bus_id}:${t}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ i: j.bus_id, b: normBus(String(j.bus_name)), r: j.route_id, lat: j.lat, lon: j.lon, h: j.heading ?? 0, l: j.last_stop_id ?? null, t });
    }
  }
  out.sort((a, b) => a.t - b.t || a.i - b.i);
  return out;
}
export function tracksByBus(pos: readonly Pos[]): Map<string, Pos[]> {
  const m = new Map<string, Pos[]>();
  for (const p of pos) (m.get(p.b) ?? m.set(p.b, []).get(p.b)!).push(p);
  return m;
}

// -- Statistics ---------------------------------------------------------------
export function quantile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const rank = (n - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (rank - lo) * (sorted[hi]! - sorted[lo]!);
}
export interface ErrStats { n: number; p10: number; p50: number; p90: number; absP50: number; absP90: number; mean: number; within60: number; within120: number; opt120: number; pes120: number }
export function errStats(errs: readonly number[]): ErrStats {
  const n = errs.length;
  if (n === 0) return { n, p10: NaN, p50: NaN, p90: NaN, absP50: NaN, absP90: NaN, mean: NaN, within60: NaN, within120: NaN, opt120: NaN, pes120: NaN };
  const s = Float64Array.from(errs).sort();
  const a = Float64Array.from(errs, Math.abs).sort();
  let sum = 0, w60 = 0, w120 = 0, o = 0, pe = 0;
  for (const e of errs) { sum += e; if (Math.abs(e) <= 60) w60++; if (Math.abs(e) <= 120) w120++; if (e < -120) o++; if (e > 120) pe++; }
  const pc = (x: number) => Math.round((1000 * x) / n) / 10;
  return { n, p10: quantile(s, 0.1), p50: quantile(s, 0.5), p90: quantile(s, 0.9), absP50: quantile(a, 0.5), absP90: quantile(a, 0.9), mean: sum / n, within60: pc(w60), within120: pc(w120), opt120: pc(o), pes120: pc(pe) };
}
export const r0 = (x: number): string => (Number.isFinite(x) ? String(Math.round(x)) : "–");
export const r1 = (x: number): string => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toFixed(1) : "–");
export const r2 = (x: number): string => (Number.isFinite(x) ? (Math.round(x * 100) / 100).toFixed(2) : "–");

/** Markdown table. */
export function mdTable(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const line = (cells: readonly (string | number)[]) => `| ${cells.map(String).join(" | ")} |`;
  return [line(header), `|${header.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}

export function routeNames(db: any): Map<number, string> {
  return new Map((db.prepare("SELECT id, name FROM routes").all() as Array<{ id: number; name: string }>).map((r) => [r.id, shortRoute(r.name)]));
}
export function shortRoute(name: string): string {
  return name
    .replace("Weekday Daytime", "Day").replace("Weekend Daytime", "Wknd").replace(" - ", " ")
    .replace("Pink - VA Hospital / Med School", "Pink").replace("Weekend Grocery (to Trader Joes)", "Grocery TJ")
    .replace("Weekend Grocery (to Hamden)", "Grocery Ham").replace(" - West Campus", " WC").replace(" Route", "").replace(" Connector", "");
}

export function ensureOut(): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}
export function writeJson(name: string, data: unknown): string {
  const p = path.join(ensureOut(), name);
  fs.writeFileSync(p, JSON.stringify(data, null, 1));
  return p;
}
export function writeText(name: string, text: string): string {
  const p = path.join(ensureOut(), name);
  fs.writeFileSync(p, text);
  return p;
}

// -- Proximity truth (gps-replay.ts's definition) -----------------------------
import { distanceToSegmentM, haversineMeters, progressAlongSegment } from "../../web/src/geo";
export const PROX_ENTER_M = 50, PROX_EXIT_M = 120, PROX_BEFORE_MS = 90_000, PROX_AFTER_MS = 300_000;
/**
 * First entry within 50 m of the stop along the bus's own track (hysteresis
 * out at 120 m), nearest the detector event — what a rider at the kerb would
 * call the arrival. Measured on these three days the detector fires a median
 * 15 s (p90 85 s) BEFORE this instant.
 */
export function makeProximity(tracks: Map<string, Pos[]>, stopCoords: Map<number, { lat: number; lon: number }>) {
  const entryCache = new Map<string, Float64Array>();
  function entries(bus: string, stopId: number): Float64Array {
    const key = `${bus} ${stopId}`;
    const hit = entryCache.get(key);
    if (hit) return hit;
    const track = tracks.get(bus) ?? [];
    const s = stopCoords.get(stopId)!;
    const out: number[] = [];
    let inside = false;
    let prev: Pos | null = null;
    for (const p of track) {
      if (prev && p.t - prev.t <= 60_000) {
        const d = distanceToSegmentM(s, prev, p);
        if (!inside && d <= PROX_ENTER_M) {
          const tt = Math.max(0, Math.min(1, progressAlongSegment(s, prev, p)));
          out.push(prev.t + tt * (p.t - prev.t));
          inside = true;
        } else if (inside && haversineMeters(s, p) >= PROX_EXIT_M) inside = false;
      } else {
        const d = haversineMeters(s, p);
        if (!inside && d <= PROX_ENTER_M) { out.push(p.t); inside = true; } else if (inside && d >= PROX_EXIT_M) inside = false;
      }
      prev = p;
    }
    const e = Float64Array.from(out);
    entryCache.set(key, e);
    return e;
  }
  return function proximityArrival(bus: string, stopId: number, detT: number): number | null {
    if (!stopCoords.has(stopId)) return null;
    const e = entries(bus, stopId);
    let best: number | null = null;
    for (let i = 0; i < e.length; i++) {
      const x = e[i]!;
      if (x < detT - PROX_BEFORE_MS) continue;
      if (x > detT + PROX_AFTER_MS) break;
      if (best === null || Math.abs(x - detT) < Math.abs(best - detT)) best = x;
    }
    return best;
  };
}
/** Last fix of a continuous presence (gaps ≤ 10 min) of the bus starting at or after t; null when never seen after t. */
export function makeLastSeen(tracks: Map<string, Pos[]>) {
  const cache = new Map<string, Float64Array>();
  return function lastSeenAfter(bus: string, t: number): number | null {
    let ts = cache.get(bus);
    if (!ts) cache.set(bus, (ts = Float64Array.from((tracks.get(bus) ?? []).map((p) => p.t))));
    if (ts.length === 0) return null;
    let lo = 0, hi = ts.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (ts[m]! < t) lo = m + 1; else hi = m; }
    if (lo >= ts.length) return null;
    let i = lo;
    while (i + 1 < ts.length && ts[i + 1]! - ts[i]! <= 600_000) i++;
    return ts[i]!;
  };
}
