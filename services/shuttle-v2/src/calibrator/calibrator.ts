import { sql } from "drizzle-orm";

import type { DB } from "../db/client.js";
import { distanceMeters } from "../network/geo.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type {
  DwellStats,
  PaceStats,
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
export const SPLIT_WINDOW_DAYS = 30;

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
  /** Hops carrying leg quantiles (`dq`) and routes carrying a pooled `pace`. */
  legQuantileCount: number;
  paceRouteCount: number;
  /** Per-pass stand tables (`"<stop>#<index>"`) on routes that repeat a stop. */
  occurrenceStandCount: number;
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

  // Every route gets its tables wherever data exists — nothing is withheld
  // here any more. The legacy client's split arithmetic is gated on ITS side
  // (`SPLIT_SERVED_ROUTE_IDS` is kept exported for that and for the replay's
  // "served" comparison); the ring estimator prices every route and reads
  // whatever a route has. A route with no `legs` / `stop_visits` rows simply
  // carries no split fields, as before.
  const standGroups = loadStandGroups(db, SPLIT_WINDOW_DAYS, nowMs);
  const driveGroups = loadDriveGroups(db, SPLIT_WINDOW_DAYS, nowMs);
  const legGroups = loadLegGroups(db, SPLIT_WINDOW_DAYS, nowMs);
  const stopShares = loadStopShares(db, SPLIT_WINDOW_DAYS, nowMs);
  const standCount = attachStandTables(dwellStats, standGroups, undefined, stopShares);
  const occurrenceStandCount = attachOccurrenceStandTables(
    dwellStats, network,
    loadStandOccurrenceGroups(db, SPLIT_WINDOW_DAYS, nowMs),
    loadStopOccurrenceShares(db, SPLIT_WINDOW_DAYS, nowMs),
  );
  const driveCount = attachDrives(segmentStats, driveGroups);
  const legQuantileCount = attachLegQuantiles(segmentStats, legGroups);
  const pace = computePace(legGroups, network);

  network.setCalibration(segmentStats, dwellStats, pace);

  return {
    segmentCount: segmentStats.size,
    dwellCount: dwellStats.size,
    sampleCount: countSamples(segmentGroups) + countSamples(dwellGroups),
    standCount,
    driveCount,
    legQuantileCount,
    paceRouteCount: pace.size,
    occurrenceStandCount,
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
 * at_stop_since` runs on — with one deliberate difference: a PINNED
 * pass-through (`passed`, `at_stop` was set for a poll or two while the bus
 * rolled by) is a 0 s stand here, where the reference keeps `pStop` beside a
 * stopped-only table. The client bills `median(stand − r | stand > r)` from the
 * instant `at_stop` appears; over stopped visits only, that promised the
 * median stopped stand (30–60 s at an ordinary stop) to a rider whose bus was
 * about to roll through, and the rider simulator counted it as strands (Pink
 * 280 → 431, Blue Day's Prospect / Huntington +28). With the zeros in, P(stop)
 * enters at r = 0 and the conditional on `stand > r` drops them as soon as the
 * bus has actually stood. A pass never pinned has no `at_stop_since` to
 * measure from and stays out.
 *
 * `windowed` is unused for the split (see SPLIT_WINDOW_DAYS); it is left empty
 * so the group shape matches the other loaders.
 */
const STAND_VALUE = sql.raw(losslessText("CASE WHEN outcome = 'passed' THEN 0 ELSE (departed_at - pinned_at) / 1000.0 END"));
const DRIVE_VALUE = sql.raw(losslessText("(COALESCE(to_pinned_at, arrived_at) - departed_at) / 1000.0"));
const LEG_VALUE = sql.raw(losslessText("leg_sec"));

interface StandGroupRow { routeId: number; stopId: number; n: number; allValues: string | null }
interface StandOccurrenceRow extends StandGroupRow { stopIndex: number }
interface DriveGroupRow { routeId: number; fromStopId: number; toStopId: number; n: number; allValues: string | null }

/**
 * The four split loaders are bounded ABOVE at `nowMs` as well as below. In
 * production that is the wall clock and changes nothing; in a time-travelled
 * replay (scripts/eta-replay/model-patch.ts, MODEL_NOW) it is what keeps a
 * table built "as of 9/3" from seeing 9/4's visits.
 */
export function loadStandGroups(db: DB, windowDays: number, nowMs: number): ValueGroup[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const rows = db.all<StandGroupRow>(sql`
    SELECT
      route_id AS routeId,
      stop_id  AS stopId,
      COUNT(*) AS n,
      group_concat(${STAND_VALUE}) AS allValues
    FROM stop_visits
    WHERE anchored_at >= ${cutoff} AND anchored_at <= ${nowMs}
      AND pinned_at IS NOT NULL
      AND (
        (outcome = 'stopped' AND departed_at IS NOT NULL AND departed_at >= pinned_at)
        OR outcome = 'passed'
      )
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
 * {@link loadStandGroups} split by PASS: grouped by (route, stop,
 * `stop_index`), keyed {@link TransitNetwork.occurrenceDwellKey}. The same
 * rows and the same value; only the grouping differs, so the pooled table is
 * exactly the union of a stop's occurrence tables. Attached only for stops a
 * route lists more than once (see {@link attachOccurrenceStandTables}); the
 * rest of the rows are read and dropped, which at a few hundred visits a day
 * is cheaper than a second filtered query.
 */
export function loadStandOccurrenceGroups(db: DB, windowDays: number, nowMs: number): ValueGroup[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const rows = db.all<StandOccurrenceRow>(sql`
    SELECT
      route_id   AS routeId,
      stop_id    AS stopId,
      stop_index AS stopIndex,
      COUNT(*)   AS n,
      group_concat(${STAND_VALUE}) AS allValues
    FROM stop_visits
    WHERE anchored_at >= ${cutoff} AND anchored_at <= ${nowMs}
      AND pinned_at IS NOT NULL
      AND (
        (outcome = 'stopped' AND departed_at IS NOT NULL AND departed_at >= pinned_at)
        OR outcome = 'passed'
      )
    GROUP BY route_id, stop_id, stop_index
  `);
  return rows.map((r) => ({
    key: TransitNetwork.occurrenceDwellKey(r.routeId, r.stopId, r.stopIndex),
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
export function loadDriveGroups(db: DB, windowDays: number, nowMs: number): ValueGroup[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const rows = db.all<DriveGroupRow>(sql`
    SELECT
      route_id     AS routeId,
      from_stop_id AS fromStopId,
      to_stop_id   AS toStopId,
      COUNT(*)     AS n,
      group_concat(${DRIVE_VALUE}) AS allValues
    FROM legs
    WHERE departed_at >= ${cutoff} AND departed_at <= ${nowMs}
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

/**
 * The WHOLE hop per consecutive stop pair: `legs.leg_sec` (= drive_sec +
 * hold_sec, departure at A to the first rest at B), the quantity the
 * probabilistic estimator sums over and `pace` pools. Same window, same
 * one-hop rule as {@link loadDriveGroups}; the two differ in the clock at B
 * (first rest here, `at_stop_since` there) and in that the holds are in. A
 * leg of 0 s or less is not a sample.
 */
export function loadLegGroups(db: DB, windowDays: number, nowMs: number): ValueGroup[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const rows = db.all<DriveGroupRow>(sql`
    SELECT
      route_id     AS routeId,
      from_stop_id AS fromStopId,
      to_stop_id   AS toStopId,
      COUNT(*)     AS n,
      group_concat(${LEG_VALUE}) AS allValues
    FROM legs
    WHERE departed_at >= ${cutoff} AND departed_at <= ${nowMs}
      AND hops = 1
      AND leg_sec > 0
    GROUP BY route_id, from_stop_id, to_stop_id
  `);
  return rows.map((r) => ({
    key: TransitNetwork.segmentKey(r.routeId, r.fromStopId, r.toStopId),
    n: r.n,
    all: parseValueList(r.allValues),
    windowed: [],
  }));
}

interface StopShareRow { routeId: number; stopId: number; stopped: number; total: number }
interface StopOccurrenceShareRow extends StopShareRow { stopIndex: number }

/**
 * P(stop) per (route, stop): the share of visits that stopped, over visits
 * with outcome `stopped` or `passed` in the window — EVERY pass, pinned or
 * not, unlike the zero mass in `q` (see {@link loadStandGroups}). An
 * unresolved visit is neither and is not counted. Keyed like the dwell table.
 */
export function loadStopShares(db: DB, windowDays: number, nowMs: number): Map<string, number> {
  const cutoff = nowMs - windowDays * 86_400_000;
  const rows = db.all<StopShareRow>(sql`
    SELECT
      route_id AS routeId,
      stop_id  AS stopId,
      SUM(CASE WHEN outcome = 'stopped' THEN 1 ELSE 0 END) AS stopped,
      COUNT(*) AS total
    FROM stop_visits
    WHERE anchored_at >= ${cutoff} AND anchored_at <= ${nowMs}
      AND outcome IN ('stopped', 'passed')
    GROUP BY route_id, stop_id
  `);
  const out = new Map<string, number>();
  for (const r of rows) if (r.total > 0) out.set(TransitNetwork.dwellKey(r.routeId, r.stopId), r.stopped / r.total);
  return out;
}

/** {@link loadStopShares} split by pass, keyed {@link TransitNetwork.occurrenceDwellKey}. */
export function loadStopOccurrenceShares(db: DB, windowDays: number, nowMs: number): Map<string, number> {
  const cutoff = nowMs - windowDays * 86_400_000;
  const rows = db.all<StopOccurrenceShareRow>(sql`
    SELECT
      route_id   AS routeId,
      stop_id    AS stopId,
      stop_index AS stopIndex,
      SUM(CASE WHEN outcome = 'stopped' THEN 1 ELSE 0 END) AS stopped,
      COUNT(*) AS total
    FROM stop_visits
    WHERE anchored_at >= ${cutoff} AND anchored_at <= ${nowMs}
      AND outcome IN ('stopped', 'passed')
    GROUP BY route_id, stop_id, stop_index
  `);
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.total > 0) out.set(TransitNetwork.occurrenceDwellKey(r.routeId, r.stopId, r.stopIndex), r.stopped / r.total);
  }
  return out;
}

/** Ascending stand quantiles at levels (i + 0.5) / STAND_Q_COUNT — the client's reading of `q`. */
export function standQuantiles(samples: readonly number[]): number[] {
  const out = new Array<number>(STAND_Q_COUNT);
  for (let i = 0; i < STAND_Q_COUNT; i++) out[i] = percentile(samples, (i + 0.5) / STAND_Q_COUNT);
  return out;
}

/**
 * Routes that list a stop more than once — the West Campus out-and-backs
 * (Green 9, Purple 10).
 *
 * These USED to have the split withheld (until 2026-09-05). The payload keyed
 * a stop's stand table by stop id, so a stop the loop visits twice got ONE
 * table pooled over two different passes (Building 800 outbound is a
 * pass-through; inbound it is a layover), and the rider simulator scored that
 * on 2026-09-03 as Purple 163 -> 188 strands, Green 165 -> 173 (on stops
 * 23/24/25/9, the repeated buildings). The fix is structural, not a
 * withhold: {@link attachOccurrenceStandTables} now serves a table PER PASS
 * (`"<stop>#<index>"`) beside the pooled one, and the estimator reads the
 * pass it is on. The pooled table still goes out — the legacy client's
 * split arithmetic is gated on its own side. Kept as the definition of "a
 * fold" for the replay tooling and the tests.
 */
export function foldRoutes(network: TransitNetwork): ReadonlySet<number> {
  const out = new Set<number>();
  if (!network.routes) return out;
  for (const r of network.routes.values()) if (new Set(r.stops).size !== r.stops.length) out.add(r.id);
  return out;
}

/**
 * Routes on which the LEGACY client's split arithmetic is enabled. The
 * calibrator no longer withholds anything by this list (every route gets its
 * tables wherever data exists, since 2026-09-05 — the ring estimator prices
 * every route); the gate moved to the client, which reads this set's twin.
 * It stays exported so the replay's `MODEL_ROUTES=served` can rebuild the old
 * production payload for a paired comparison, and as the record of what was
 * measured. Every id here is a rider-simulator result (docs/rider-sim.md;
 * master vs the served tables, paired wait for wait, 2026-09-03 capture),
 * and a route is added ONLY with that run:
 *
 *   Red (3)       strands 1,041 -> 769 (477 fixed / 205 introduced), riders
 *                 seeing a jump >= 180 s 39.1% -> 22.6%; the 344 Winchester
 *                 chain's departure-poll rise +220 s -> +2 s.
 *   Blue Day (1)  jumps >= 180 s 25.6% -> 8.6%, reversals 25.2% -> 13.1%,
 *                 p90 drift 405 -> 170 s; strands 233 -> 242 (+9 of 6,470,
 *                 46 fixed / 55 introduced) — within run-to-run noise, and
 *                 stated here so nobody has to rediscover it.
 *
 * Why an allowlist and not the client's gate alone: Pink passed the gate on
 * 11 hops and went 280 -> 431 strands (LEPH / 60 College +122). Master there
 * is PESSIMISTIC — the stall credit is bounded by the dwell, so a rider at
 * LEPH is promised ~400 s while the bus stands at York / Cedar — and the
 * conditional median replaces that with an unbiased number, which strands
 * the half of riders whose bus leaves before its median. That is a property
 * of the client's arithmetic at every layover-ish stop, and Red only nets a
 * win because master's departure cliff there was worse. Serving a line
 * therefore needs its own measurement, not a sample count. Orange East and
 * the night lines have data trickling in and are unmeasured.
 */
export const SPLIT_SERVED_ROUTE_IDS: ReadonlySet<number> = new Set([3, 1]);

/**
 * Every route the split USED to be withheld from: not allowlisted, or a fold.
 * No longer consulted by {@link calibrate}; the attachers still take a
 * `withheld` set so `scripts/eta-replay/model-patch.ts` can reproduce the
 * pre-2026-09-05 payload (`MODEL_ROUTES=served`) beside the current one.
 */
export function splitWithheldRoutes(network: TransitNetwork): ReadonlySet<number> {
  const out = new Set<number>(foldRoutes(network));
  if (!network.routes) return out;
  for (const id of network.routes.keys()) if (!SPLIT_SERVED_ROUTE_IDS.has(id)) out.add(id);
  return out;
}

const routeOf = (key: string): number => Number(key.slice(0, key.indexOf(":")));

/**
 * Put a stand table on every stop that has one. A stop with visits but no
 * arrival-based dwell entry gets the same warm-up defaults `getDwellStats`
 * would have answered with, so the table is not lost. Returns the number of
 * stops carrying a table.
 */
export function attachStandTables(
  dwells: Map<string, DwellStats>,
  groups: readonly ValueGroup[],
  withheld: ReadonlySet<number> = new Set(),
  /** P(stop) per dwell key ({@link loadStopShares}); rides on the same rows as `q`. */
  shares: ReadonlyMap<string, number> = new Map(),
): number {
  let count = 0;
  for (const g of groups) {
    if (g.all.length === 0 || withheld.has(routeOf(g.key))) continue;
    const q = standQuantiles(g.all);
    const cur = dwells.get(g.key) ?? { mean: 15, stddev: 10, n: 0 };
    const pstop = shares.get(g.key);
    dwells.set(g.key, { ...cur, q, qn: g.all.length, ...(pstop !== undefined ? { pstop } : {}) });
    count++;
  }
  return count;
}

/**
 * Put a stand table on every PASS of a stop the route lists more than once,
 * under {@link TransitNetwork.occurrenceDwellKey} (`"<route>:<stop>#<index>"`),
 * beside the pooled entry {@link attachStandTables} wrote. The plain entry
 * stays the pooled table; a client that knows which pass a bus is on reads
 * the per-pass one first and falls back to the pooled one.
 *
 * Only stops that genuinely repeat get an entry (a single-occurrence stop's
 * pass table would duplicate its pooled one byte for byte), and only for an
 * index the CURRENT sequence still has (a resequenced route leaves stale
 * indices in `stop_visits`; those are dropped, not served).
 *
 * The entry's `mean`/`stddev`/`n` are the same stand summary the quantiles
 * come from — median stand, p90 − median (floored at 5 s like
 * {@link computeDwellStats}), and the count — rather than the pooled entry's
 * arrival-to-arrival dwell, which has no per-pass form. So for these keys
 * `med` really is a standing time; the payload documents it. `pstop` comes
 * from {@link loadStopOccurrenceShares}. Returns the number of entries.
 */
export function attachOccurrenceStandTables(
  dwells: Map<string, DwellStats>,
  network: TransitNetwork,
  groups: readonly ValueGroup[],
  shares: ReadonlyMap<string, number> = new Map(),
): number {
  // Tests inject a bare setCalibration sink without routes; nothing to do.
  if (!network.routes || typeof network.positionsOnRoute !== "function") return 0;
  let count = 0;
  for (const g of groups) {
    if (g.all.length === 0) continue;
    const parsed = parseOccurrenceKey(g.key);
    if (!parsed) continue;
    const route = network.routes.get(parsed.routeId);
    if (!route) continue;
    const positions = network.positionsOnRoute(parsed.routeId, parsed.stopId);
    if (positions.length < 2 || !positions.includes(parsed.stopIndex)) continue;
    const med = median(g.all);
    const p90 = percentile(g.all, 0.9);
    const pstop = shares.get(g.key);
    dwells.set(g.key, {
      mean: med,
      stddev: Math.max(p90 - med, 5),
      n: g.all.length,
      q: standQuantiles(g.all),
      qn: g.all.length,
      ...(pstop !== undefined ? { pstop } : {}),
    });
    count++;
  }
  return count;
}

/** `"<route>:<stop>#<index>"` → its parts, or null for a pooled key. */
function parseOccurrenceKey(key: string): { routeId: number; stopId: number; stopIndex: number } | null {
  const hash = key.indexOf("#");
  const colon = key.indexOf(":");
  if (hash < 0 || colon < 0 || hash < colon) return null;
  const routeId = Number(key.slice(0, colon));
  const stopId = Number(key.slice(colon + 1, hash));
  const stopIndex = Number(key.slice(hash + 1));
  if (!Number.isInteger(routeId) || !Number.isInteger(stopId) || !Number.isInteger(stopIndex)) return null;
  return { routeId, stopId, stopIndex };
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
  withheld: ReadonlySet<number> = new Set(),
): number {
  let count = 0;
  for (const g of groups) {
    if (g.all.length === 0 || withheld.has(routeOf(g.key))) continue;
    const cur = segments.get(g.key);
    if (!cur) continue;
    segments.set(g.key, { ...cur, drive: median(g.all), driveN: g.all.length });
    count++;
  }
  return count;
}

/**
 * Put the whole-hop quantiles (`dq`/`dqn`) on every hop that has legs AND a
 * calibrated segment — the same two conditions as {@link attachDrives}, so a
 * hop carries `dq` exactly where it can carry a `drive` (the leg rows behind
 * them differ only in the clock at B; see {@link loadLegGroups}). Returns
 * the number of hops carrying one.
 */
export function attachLegQuantiles(
  segments: Map<string, SegmentStats>,
  groups: readonly ValueGroup[],
  withheld: ReadonlySet<number> = new Set(),
): number {
  let count = 0;
  for (const g of groups) {
    if (g.all.length === 0 || withheld.has(routeOf(g.key))) continue;
    const cur = segments.get(g.key);
    if (!cur) continue;
    segments.set(g.key, { ...cur, dq: standQuantiles(g.all), dqn: g.all.length });
    count++;
  }
  return count;
}

/** A hop whose stops are closer than this (chord) is not a pace sample: 30 m / 5 s is noise, not a speed. */
export const PACE_MIN_CHORD_M = 30;

/**
 * Route-level pooled pace ({@link PaceStats}): seconds per ROAD metre over
 * every one-hop leg on the route, quantiles at the STAND_Q_COUNT levels. The
 * metres are the published line between the two stops
 * ({@link TransitNetwork.getLegMeters}, the same trace the client cuts its
 * ring cells from); the chord only where the line cannot supply the leg. The
 * chord used to be the divisor everywhere, and it under-priced winding hops:
 * road/chord runs to a p90 of 1.9 on Red and 4.8 on Blue Night. The
 * too-short gate stays on the chord (it is about the stops, not the road).
 * Needs the network's stop geometry — a network without stops (the test sink)
 * yields no pace at all rather than a fabricated one. `withheld` is for the
 * replay's reconstruction of the old payload; production passes nothing.
 */
export function computePace(
  groups: readonly ValueGroup[],
  network: TransitNetwork,
  withheld: ReadonlySet<number> = new Set(),
): Map<number, PaceStats> {
  const samples = new Map<number, number[]>();
  for (const g of groups) {
    const rid = routeOf(g.key);
    if (g.all.length === 0 || withheld.has(rid)) continue;
    const chord = segmentMeters(network, g.key);
    if (chord === null || chord < PACE_MIN_CHORD_M) continue;
    const meters = legMeters(network, g.key) ?? chord;
    let l = samples.get(rid);
    if (!l) samples.set(rid, (l = []));
    for (const sec of g.all) {
      const spm = sec / meters;
      if (Number.isFinite(spm) && spm > 0) l.push(spm);
    }
  }
  const out = new Map<number, PaceStats>();
  for (const [rid, l] of samples) if (l.length > 0) out.set(rid, { spm: standQuantiles(l), n: l.length });
  return out;
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

/** Road metres for a "routeId:fromStopId:toStopId" key, if the route's line supplies the hop. */
function legMeters(network: TransitNetwork, key: string): number | null {
  const parts = key.split(":");
  if (parts.length !== 3 || typeof network.getLegMeters !== "function") return null;
  return network.getLegMeters(Number(parts[0]), Number(parts[1]), Number(parts[2])) ?? null;
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
