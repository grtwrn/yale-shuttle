import { sql } from "drizzle-orm";

import type { DB } from "../db/client.js";
import { distanceMeters } from "../network/geo.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type {
  DwellStats,
  SegmentStats,
} from "../network/TransitNetwork.js";

import { median, percentile, shrink } from "./shrinkage.js";

// Tuning ---------------------------------------------------------------------

/** Shrinkage strength: how many pseudo-samples the prior is worth. */
const SHRINKAGE_K = 8;

/** Sliding window of segment data fed to the calibrator. */
/**
 * Fastest a shuttle can plausibly cover the straight-line distance between two
 * stops, m/s. 22 m/s is ~79 km/h — generous, since the West Campus legs really
 * are highway runs, so anything above it is not a slow bus, it is bad data.
 *
 * This is not hypothetical. Route 9's Orange/Bradley (S) -> Building 900 is a
 * genuine 8,204 m consecutive hop, and 2,411 of its 2,421 recorded samples came
 * in under five minutes — a median of 90 s, i.e. 328 km/h. Calibration served
 * that median, so the planner offered the 8.4 km West Campus ride as a 97-second
 * trip. Across 30 days, 2.5% of all segments imply over 60 km/h, concentrated on
 * exactly these long hops (10:122->127, 9:81->26, 9:80->91, 19:4->172).
 *
 * The detector's duration gates cannot catch this: 90 s is a perfectly ordinary
 * segment time until you know the two stops are 8 km apart. Only a speed test
 * sees it, and only calibration knows both the samples and the geometry.
 *
 * Dropping every sample for a pair leaves it absent from the map, so
 * `getSegmentStats` falls back to its distance prior (meters / 5.5), which puts
 * that same hop at a believable ~25 minutes.
 */
// Exported because the CLIENT mirrors it: web/src/arrivals.ts floors the first
// hop at distance / MAX_PLAUSIBLE_M_S so a stall credit cannot promise a bus
// faster than a shuttle can physically travel. arrivals.test.ts parses this
// line, so the two cannot drift.
export const MAX_PLAUSIBLE_M_S = 22;

const SEGMENT_WINDOW_DAYS = 30;

/** Sliding window of dwell data fed to the calibrator. */
const DWELL_WINDOW_DAYS = 14;

/**
 * Quantile served as `DwellStats.low` and the samples needed to place it.
 *
 * The estimator does NOT consume this — see the warning on `DwellStats.low`.
 * It stays calibrated so the field remains available and honest, not because
 * anything currently depends on 0.35.
 */
const DWELL_LOW_QUANTILE = 0.35;
const DWELL_LOW_MIN_SAMPLES = 5;

/**
 * The stand/drive split (`DwellStats.q`, `SegmentStats.drive`), from the
 * departure derivation's `stop_visits` / `legs` (docs/departure-derivation.md).
 *
 * Pooled over the whole window, not the (dow, hour) slice: a stop sees ~25
 * stopped visits on a good day and a (stop, hour) cell has a median of TWO
 * samples (3 of 1,371 cells reach five), so an hourly table has nothing to
 * stand on. The client conditions on how long THIS bus has stood, which is
 * where the within-day information actually is.
 *
 * Served as measured, with the true sample counts. The client gates on the
 * counts (`MIN_STAND_SAMPLES` / `MIN_DRIVE_SAMPLES` in `web/src/hopPricing.ts`)
 * and prices a thin hop exactly as it did before the split existed — so the
 * server must NOT pre-filter, or the two gates drift apart and a cell the
 * client would accept silently never arrives.
 */
const SPLIT_WINDOW_DAYS = 30;

/**
 * Quantiles served in `DwellStats.q`. The client reads entry i as the
 * (i + 0.5) / STAND_Q_COUNT quantile, so this count is part of the wire
 * contract: change it and the levels move with it, nothing else has to. Ten
 * knots keep the conditional median continuous in r (three reintroduce the
 * stepping the client's tests caught) at ~40 bytes per stop rounded to whole
 * seconds.
 */
export const STAND_Q_COUNT = 10;

/**
 * Hour-window half-width: a sample at hour H is considered "current" for
 * any of (H-1, H, H+1) modulo 24. Mirrors the v1 `hour BETWEEN h-1 AND h+1`
 * but wraps midnight correctly (the v1 bug fixed in the recent commit).
 */
const HOUR_WINDOW = 1;

// Public API -----------------------------------------------------------------

export interface CalibrationStats {
  segmentCount: number;
  dwellCount: number;
  sampleCount: number;
  /** Stops carrying a stand table (`q`) and hops carrying a `drive`. */
  standCount: number;
  driveCount: number;
  /** Stopped visits + one-hop legs behind them. */
  splitSampleCount: number;
  durationMs: number;
}

/**
 * Read recent segment/dwell observations, compute shrinkage-pooled estimates
 * for the current (dow, hour) window, and push them into the network atomically.
 * Designed to run on a 5-minute timer.
 */
export function calibrate(
  db: DB,
  network: TransitNetwork,
  now: Date = new Date(),
): CalibrationStats {
  const t0 = Date.now();
  const nowMs = now.getTime();
  const dow = now.getDay();
  const hours = hourWindow(now.getHours(), HOUR_WINDOW);

  const segmentGroups = loadSegmentGroups(db, SEGMENT_WINDOW_DAYS, nowMs, dow, hours);
  const dwellGroups = loadDwellGroups(db, DWELL_WINDOW_DAYS, nowMs, dow, hours);

  const segmentStats = computeSegmentStats(segmentGroups, network);
  const dwellStats = computeDwellStats(dwellGroups);

  const standGroups = loadStandGroups(db, SPLIT_WINDOW_DAYS, nowMs);
  const driveGroups = loadDriveGroups(db, SPLIT_WINDOW_DAYS, nowMs);
  const standCount = attachStandTables(dwellStats, standGroups);
  const driveCount = attachDrives(segmentStats, driveGroups);

  network.setCalibration(segmentStats, dwellStats);

  return {
    segmentCount: segmentStats.size,
    dwellCount: dwellStats.size,
    sampleCount: countSamples(segmentGroups) + countSamples(dwellGroups),
    standCount,
    driveCount,
    splitSampleCount: countSamples(standGroups) + countSamples(driveGroups),
    durationMs: Date.now() - t0,
  };
}

// Internals ------------------------------------------------------------------

/**
 * One (route, segment) or (route, stop) bucket, already collapsed by SQLite.
 *
 * `all` is every observation inside the lookback window — the backbone the
 * prior is drawn from. `windowed` is the subset that also falls in the current
 * (dow, hour ± HOUR_WINDOW) slice. `windowed` is always a subset of `all`, so
 * `n` counts `all`.
 */
export interface ValueGroup {
  key: string;
  n: number;
  all: number[];
  windowed: number[];
}

/**
 * Why the values arrive as a delimited string instead of one row per sample:
 *
 * better-sqlite3 is synchronous and shares this process's single connection
 * with the collector and the HTTP server, so every millisecond the calibrator
 * spends is a millisecond of blocked request handling. At production row counts
 * the old `SELECT ... FROM segments` + `FROM arrivals` pulled ~207k rows across
 * the C++/JS boundary every five minutes; that crossing — not the scan, not the
 * index, not the object shape — was ~1.1 s of frozen event loop. Grouping in
 * SQL drops it to ~570 rows.
 *
 * The prior is a *median* (and a p90 for dwells), and order statistics don't
 * decompose into AVG/SUM, so the values themselves still have to come back —
 * just batched per group instead of one JS object per sample. `group_concat`
 * is the only aggregate SQLite offers that can carry them.
 *
 * The encoding has to be *lossless*, and SQLite's default REAL→TEXT is not:
 * it renders ~15 significant digits, so 0.30000000000000004 comes back as
 * "0.3" (~30% of arbitrary doubles are perturbed this way). A silently shifted
 * median is exactly the bug this code must not have, so every sample is
 * rendered one of two provably reversible ways:
 *
 *  - `<integer>`  — the value is exactly `<integer> / 1000`. travel_sec and
 *    dwell_sec are `(ms delta) / 1000`, so this is the normal case. SQLite
 *    itself checks the round-trip (`CAST(ROUND(v*1000) AS INT)/1000.0 = v`)
 *    before choosing this branch, and JS re-runs the identical IEEE-754
 *    division, so the double that comes back is bit-for-bit the stored one.
 *    Roughly half the bytes of the general form, which matters: this string is
 *    megabytes per run and all of it is garbage afterwards.
 *  - `x<digits>`  — anything else, rendered with `printf('%!.17g', …)`. 17
 *    significant digits always round-trips a double, and the `x` marker keeps
 *    the two forms unambiguous. Verified: zero mismatches over 60k values
 *    spanning integral, ms-quantised and arbitrary doubles.
 */
const SEG_VALUE = sql.raw(losslessText("travel_sec"));
const DWELL_VALUE = sql.raw(losslessText("dwell_sec"));

function losslessText(column: string): string {
  return (
    `CASE WHEN CAST(ROUND(${column} * 1000) AS INTEGER) / 1000.0 = ${column}` +
    ` THEN CAST(ROUND(${column} * 1000) AS INTEGER)` +
    ` ELSE 'x' || printf('%!.17g', ${column}) END`
  );
}

interface SegmentGroupRow {
  routeId: number;
  fromStopId: number;
  toStopId: number;
  n: number;
  allValues: string | null;
  windowValues: string | null;
}

interface DwellGroupRow {
  routeId: number;
  stopId: number;
  n: number;
  allValues: string | null;
  windowValues: string | null;
}

function loadSegmentGroups(
  db: DB,
  windowDays: number,
  nowMs: number,
  dow: number,
  hours: readonly number[],
): ValueGroup[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const inWindow = sql`dow = ${dow} AND hour IN (${hourList(hours)})`;
  const rows = db.all<SegmentGroupRow>(sql`
    SELECT
      route_id     AS routeId,
      from_stop_id AS fromStopId,
      to_stop_id   AS toStopId,
      COUNT(*)     AS n,
      group_concat(${SEG_VALUE}) AS allValues,
      group_concat(CASE WHEN ${inWindow} THEN ${SEG_VALUE} END) AS windowValues
    FROM segments
    WHERE started_at >= ${cutoff}
    GROUP BY route_id, from_stop_id, to_stop_id
  `);
  return rows.map((r) => ({
    key: TransitNetwork.segmentKey(r.routeId, r.fromStopId, r.toStopId),
    n: r.n,
    all: parseValueList(r.allValues),
    windowed: parseValueList(r.windowValues),
  }));
}

function loadDwellGroups(
  db: DB,
  windowDays: number,
  nowMs: number,
  dow: number,
  hours: readonly number[],
): ValueGroup[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const inWindow = sql`dow = ${dow} AND hour IN (${hourList(hours)})`;
  // `dwell_sec IS NOT NULL` reproduces the old JS-side filter: an arrival whose
  // departure was never observed carries a null dwell and was dropped before
  // grouping, so a stop with only null dwells produced no entry at all.
  const rows = db.all<DwellGroupRow>(sql`
    SELECT
      route_id AS routeId,
      stop_id  AS stopId,
      COUNT(*) AS n,
      group_concat(${DWELL_VALUE}) AS allValues,
      group_concat(CASE WHEN ${inWindow} THEN ${DWELL_VALUE} END) AS windowValues
    FROM arrivals
    WHERE arrived_at >= ${cutoff} AND dwell_sec IS NOT NULL
    GROUP BY route_id, stop_id
  `);
  return rows.map((r) => ({
    key: TransitNetwork.dwellKey(r.routeId, r.stopId),
    n: r.n,
    all: parseValueList(r.allValues),
    windowed: parseValueList(r.windowValues),
  }));
}

/**
 * Standing time per (route, stop) on the client's clock: `departed_at −
 * pinned_at` over STOPPED visits. `pinned_at` is production's `at_stop_since`
 * (the first poll within 75 m while anchored) and `departed_at` the end of the
 * final resting plateau, so this is the `standPinned` table of
 * docs/departure-derivation.md — the clock the client's `r = now −
 * at_stop_since` runs on. A pass-through (`passed`) is an outcome, not a 0 s
 * stand, and is not a sample here.
 *
 * `windowed` is unused for the split (see SPLIT_WINDOW_DAYS); it is left empty
 * so the group shape matches the other loaders.
 */
const STAND_VALUE = sql.raw(losslessText("(departed_at - pinned_at) / 1000.0"));
const DRIVE_VALUE = sql.raw(losslessText("(COALESCE(to_pinned_at, arrived_at) - departed_at) / 1000.0"));

interface StandGroupRow { routeId: number; stopId: number; n: number; allValues: string | null }
interface DriveGroupRow { routeId: number; fromStopId: number; toStopId: number; n: number; allValues: string | null }

function loadStandGroups(db: DB, windowDays: number, nowMs: number): ValueGroup[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const rows = db.all<StandGroupRow>(sql`
    SELECT
      route_id AS routeId,
      stop_id  AS stopId,
      COUNT(*) AS n,
      group_concat(${STAND_VALUE}) AS allValues
    FROM stop_visits
    WHERE anchored_at >= ${cutoff}
      AND outcome = 'stopped'
      AND pinned_at IS NOT NULL
      AND departed_at IS NOT NULL
      AND departed_at >= pinned_at
    GROUP BY route_id, stop_id
  `);
  return rows.map((r) => ({
    key: TransitNetwork.dwellKey(r.routeId, r.stopId),
    n: r.n,
    all: parseValueList(r.allValues),
    windowed: [],
  }));
}

/**
 * Drive per consecutive hop on the same clock: departure at A to
 * `at_stop_since` at B (`to_pinned_at`; the first rest at B when the bus was
 * never pinned there) — `drivePinned` in the derivation. Only one-hop legs: the
 * payload keys hops by consecutive stop pair, and a leg that skipped a stop is
 * a different quantity. A leg of 0 s or less (two 75 m radii overlap on a
 * 112 m hop, so the bus can be pinned at B before its plateau at A ends) is
 * not a sample, matching the reference table.
 */
function loadDriveGroups(db: DB, windowDays: number, nowMs: number): ValueGroup[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const rows = db.all<DriveGroupRow>(sql`
    SELECT
      route_id     AS routeId,
      from_stop_id AS fromStopId,
      to_stop_id   AS toStopId,
      COUNT(*)     AS n,
      group_concat(${DRIVE_VALUE}) AS allValues
    FROM legs
    WHERE departed_at >= ${cutoff}
      AND hops = 1
      AND COALESCE(to_pinned_at, arrived_at) > departed_at
    GROUP BY route_id, from_stop_id, to_stop_id
  `);
  return rows.map((r) => ({
    key: TransitNetwork.segmentKey(r.routeId, r.fromStopId, r.toStopId),
    n: r.n,
    all: parseValueList(r.allValues),
    windowed: [],
  }));
}

/** Ascending stand quantiles at levels (i + 0.5) / STAND_Q_COUNT — the client's reading of `q`. */
export function standQuantiles(samples: readonly number[]): number[] {
  const out = new Array<number>(STAND_Q_COUNT);
  for (let i = 0; i < STAND_Q_COUNT; i++) out[i] = percentile(samples, (i + 0.5) / STAND_Q_COUNT);
  return out;
}

/**
 * Put a stand table on every stop that has one. A stop with visits but no
 * arrival-based dwell entry gets the same warm-up defaults `getDwellStats`
 * would have answered with, so the table is not lost. Returns the number of
 * stops carrying a table.
 */
export function attachStandTables(
  dwells: Map<string, DwellStats>,
  groups: readonly ValueGroup[],
): number {
  let count = 0;
  for (const g of groups) {
    if (g.all.length === 0) continue;
    const q = standQuantiles(g.all);
    const cur = dwells.get(g.key) ?? { mean: 15, stddev: 10, n: 0 };
    dwells.set(g.key, { ...cur, q, qn: g.all.length });
    count++;
  }
  return count;
}

/**
 * Put a drive on every hop that has one AND already has a calibrated segment
 * (a hop with legs but no arrival-to-arrival sample is answered from the
 * distance prior, which has no place to carry a drive; it is also the thin
 * case the client would refuse). The median, not the mean: a drive includes
 * any hold at a light, and one long red on ten legs should not move the
 * number the way it moves an average. Returns the number of hops carrying one.
 */
export function attachDrives(
  segments: Map<string, SegmentStats>,
  groups: readonly ValueGroup[],
): number {
  let count = 0;
  for (const g of groups) {
    if (g.all.length === 0) continue;
    const cur = segments.get(g.key);
    if (!cur) continue;
    segments.set(g.key, { ...cur, drive: median(g.all), driveN: g.all.length });
    count++;
  }
  return count;
}

/** `hour IN (…)` list, parameterised so the hours can't be interpolated raw. */
function hourList(hours: readonly number[]) {
  return sql.join(
    hours.map((h) => sql`${h}`),
    sql`, `,
  );
}

/** `'x'` — marks a sample written in the general 17-significant-digit form. */
const VERBATIM_MARKER = 120;

/**
 * Decode a `group_concat` payload written by {@link losslessText} back into the
 * exact doubles that were stored. SQLite returns NULL for a group where every
 * input was NULL — that's the "no samples in the current (dow, hour) window"
 * case, which is common and means an empty list.
 */
export function parseValueList(concatenated: string | null | undefined): number[] {
  if (concatenated === null || concatenated === undefined || concatenated === "") {
    return [];
  }
  const parts = concatenated.split(",");
  const out = new Array<number>(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    out[i] =
      part.charCodeAt(0) === VERBATIM_MARKER
        ? Number(part.slice(1))
        : Number(part) / 1000;
  }
  return out;
}

function countSamples(groups: readonly ValueGroup[]): number {
  let total = 0;
  for (const g of groups) total += g.n;
  return total;
}

/**
 * Build the per-(route, segment) shrinkage estimates for the current window.
 *
 * Pooling hierarchy:
 *  1. Group samples by (routeId, fromStopId, toStopId)  — done in SQL.
 *  2. Compute the segment-wide prior (across all hours/days) for that group.
 *  3. Shrink the (dow, hour ± HOUR_WINDOW) samples toward that prior.
 *
 * Step 2 replaces v1's `route.dow` and `route.any` cascades — pooling across
 * hours/days for the same segment is the natural backbone signal. We don't
 * pool across segments because pace varies wildly (a segment crossing campus
 * is nothing like one on a stroad).
 */
export function computeSegmentStats(
  groups: readonly ValueGroup[],
  network?: TransitNetwork,
): Map<string, SegmentStats> {
  const out = new Map<string, SegmentStats>();

  for (const group of groups) {
    // Drop physically impossible samples before any statistic sees them. The
    // median is robust to a few outliers but not to a majority: on the long
    // West Campus hops nearly every recorded sample is impossible, so the
    // median itself is nonsense. See MAX_PLAUSIBLE_M_S.
    const meters = network ? segmentMeters(network, group.key) : null;
    const all = meters == null ? group.all : plausible(group.all, meters);
    const windowed = meters == null ? group.windowed : plausible(group.windowed, meters);
    // Nothing credible left: omit the entry entirely so getSegmentStats falls
    // back to its distance prior rather than serving a fabricated number.
    if (all.length === 0) continue;

    // Median for the prior (robust to outliers — a broken-down bus skews
    // the mean badly; the median is unmoved).
    const priorMean = median(all);

    const est = shrink({
      samples: windowed,
      priorMean,
      k: SHRINKAGE_K,
    });

    out.set(group.key, {
      mean: est.mean,
      stddev: est.stddev,
      n: est.n,
      // Provenance: if the window contributed real data, call it specific;
      // otherwise we're effectively serving the segment-wide median.
      source: est.n >= SHRINKAGE_K ? "specific" : "route-segment",
    });
  }

  return out;
}

/** Straight-line metres for a "routeId:fromStopId:toStopId" key, if known. */
function segmentMeters(network: TransitNetwork, key: string): number | null {
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  // Tests inject a bare setCalibration sink; without geometry there is nothing
  // to check against, so fall through to the unfiltered path rather than throw.
  if (!network.stops) return null;
  const from = network.stops.get(Number(parts[1]));
  const to = network.stops.get(Number(parts[2]));
  if (!from || !to) return null;
  return distanceMeters(from, to);
}

/** Samples whose implied straight-line speed is physically possible. */
function plausible(values: readonly number[], meters: number): number[] {
  return values.filter((sec) => sec > 0 && meters / sec <= MAX_PLAUSIBLE_M_S);
}

export function computeDwellStats(
  groups: readonly ValueGroup[],
): Map<string, DwellStats> {
  const out = new Map<string, DwellStats>();

  for (const group of groups) {
    // Dwell distributions are heavy-tailed (driver bathroom breaks, late
    // boarders). Use the median + 90th-percentile spread instead of mean +
    // stddev so a single 4-minute dwell doesn't ruin the whole stop's stats.
    const priorMedian = median(group.all);

    // The low quantile is drawn from the WHOLE lookback, never the current
    // (dow, hour) slice: a slice can hold a handful of visits, and a quantile
    // of five samples is noise. See DwellStats.low for what it is for.
    const low = group.all.length >= DWELL_LOW_MIN_SAMPLES
      ? percentile(group.all, DWELL_LOW_QUANTILE)
      : undefined;

    if (group.windowed.length === 0) {
      out.set(group.key, {
        mean: priorMedian,
        stddev: Math.max(percentile(group.all, 0.9) - priorMedian, 5),
        n: 0,
        ...(low !== undefined ? { low } : {}),
      });
      continue;
    }

    const med = median(group.windowed);
    const p90 = percentile(group.windowed, 0.9);
    out.set(group.key, {
      mean: med,
      stddev: Math.max(p90 - med, 5),
      n: group.windowed.length,
      // A quantile of the whole history can land above the current window's
      // median (a stop that is quiet this hour); it is a floor on optimism,
      // not a second estimate, so never let it exceed the median it replaces.
      ...(low !== undefined ? { low: Math.min(low, med) } : {}),
    });
  }

  return out;
}

/**
 * Hours in a ±halfWidth window around `center`, modulo 24. Mirrors the
 * detector's hour math and fixes the v1 midnight-wrap bug where
 * `hour BETWEEN h-1 AND h+1` quietly excluded all samples near 23/0.
 */
export function hourWindow(center: number, halfWidth: number): number[] {
  const out: number[] = [];
  for (let d = -halfWidth; d <= halfWidth; d++) {
    out.push((center + d + 24) % 24);
  }
  return out;
}
