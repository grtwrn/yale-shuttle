import type { DbBundle } from "../db/client.js";
import { percentile } from "../calibrator/shrinkage.js";
import type { AccuracyBucket, AccuracyResponse } from "../schema/api.js";

const WINDOW_DAYS = 7;
const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 h

/**
 * After-the-fact prediction accuracy. For each logged prediction we look up
 * the actual arrival (matched by bus + stop, with arrival ≥ prediction time
 * and within 2 h), compute the signed error, then summarize medians + p90/p95
 * of the absolute error overall and by stops-ahead bucket.
 *
 * Buckets match the v1 distance buckets and the UI's `distanceBucket()`, so
 * the rollup the rider sees is comparable across versions.
 */
export function getAccuracy(
  bundle: DbBundle,
  now: Date = new Date(),
): AccuracyResponse {
  const cutoff = now.getTime() - WINDOW_DAYS * 86_400_000;

  type PredRow = {
    bus_id: number;
    to_stop_id: number;
    predicted_sec: number;
    predicted_at: number;
    stops_ahead: number;
  };
  type ArrivalRow = {
    bus_id: number;
    stop_id: number;
    arrived_at: number;
  };

  const predictions = bundle.sqlite
    .prepare(
      `SELECT bus_id, to_stop_id, predicted_sec, predicted_at, stops_ahead
       FROM predictions_log
       WHERE predicted_at >= ?`,
    )
    .all(cutoff) as PredRow[];

  if (predictions.length === 0) {
    return { windowDays: WINDOW_DAYS, overall: emptyBucket(), byStopsAhead: [] };
  }

  // Pull every arrival that *could* match any prediction in one pass —
  // earliest matching arrival is at `min(predicted_at)`, latest is at
  // `max(predicted_at) + 2h`. For the 7-day window on this network this
  // is a few thousand rows, well under one ms.
  const earliest = predictions[0]!.predicted_at;
  const latest = predictions[predictions.length - 1]!.predicted_at + MATCH_WINDOW_MS;
  const arrivals = bundle.sqlite
    .prepare(
      `SELECT bus_id, stop_id, arrived_at
       FROM arrivals
       WHERE arrived_at >= ? AND arrived_at <= ?
       ORDER BY arrived_at ASC`,
    )
    .all(earliest, latest) as ArrivalRow[];

  // Index arrivals by (bus_id, stop_id) → sorted timestamps. Lookup per
  // prediction is a binary search for the first arrival ≥ predicted_at.
  const index = new Map<string, number[]>();
  for (const a of arrivals) {
    const key = `${a.bus_id}:${a.stop_id}`;
    const list = index.get(key);
    if (list) list.push(a.arrived_at);
    else index.set(key, [a.arrived_at]);
  }

  const errors: PredictionError[] = [];
  for (const p of predictions) {
    const list = index.get(`${p.bus_id}:${p.to_stop_id}`);
    if (!list) continue;
    const actual = firstAtLeast(list, p.predicted_at);
    if (actual === null || actual > p.predicted_at + MATCH_WINDOW_MS) continue;
    const actualWaitSec = (actual - p.predicted_at) / 1000;
    errors.push({
      stopsAhead: p.stops_ahead,
      errorSec: actualWaitSec - p.predicted_sec,
    });
  }

  if (errors.length === 0) {
    return { windowDays: WINDOW_DAYS, overall: emptyBucket(), byStopsAhead: [] };
  }

  return {
    windowDays: WINDOW_DAYS,
    overall: summarize(errors.map((e) => Math.abs(e.errorSec))),
    byStopsAhead: bucketize(errors),
  };
}

// ---------------------------------------------------------------------------

interface PredictionError {
  stopsAhead: number;
  errorSec: number;
}

/**
 * Bucket assignment for prediction errors keyed by stops-ahead. Matches
 * v1's `_dist_bucket()` / `distanceBucket()` so cross-version accuracy
 * rollups stay comparable.
 */
function bucketFor(stopsAhead: number): number | "10+" {
  if (stopsAhead <= 0) return 1;
  if (stopsAhead >= 10) return "10+";
  return stopsAhead;
}

function bucketOrder(b: number | "10+"): number {
  return b === "10+" ? Infinity : b;
}

function summarize(absErrors: number[]): {
  n: number;
  medianAbsErrorSec: number;
  p90AbsErrorSec: number;
  p95AbsErrorSec: number;
} {
  return {
    n: absErrors.length,
    medianAbsErrorSec: percentile(absErrors, 0.5),
    p90AbsErrorSec: percentile(absErrors, 0.9),
    p95AbsErrorSec: percentile(absErrors, 0.95),
  };
}

function emptyBucket(): AccuracyResponse["overall"] {
  return { n: 0, medianAbsErrorSec: 0, p90AbsErrorSec: 0, p95AbsErrorSec: 0 };
}

function bucketize(errors: PredictionError[]): AccuracyBucket[] {
  const buckets = new Map<number | "10+", number[]>();
  for (const e of errors) {
    const key = bucketFor(e.stopsAhead);
    const list = buckets.get(key);
    if (list) list.push(Math.abs(e.errorSec));
    else buckets.set(key, [Math.abs(e.errorSec)]);
  }
  const out: AccuracyBucket[] = [];
  for (const [stopsAhead, vals] of buckets) {
    out.push({ stopsAhead, ...summarize(vals) });
  }
  out.sort((a, b) => bucketOrder(a.stopsAhead) - bucketOrder(b.stopsAhead));
  return out;
}

/** First element of a sorted ascending list ≥ target, or null. */
function firstAtLeast(sorted: readonly number[], target: number): number | null {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length ? sorted[lo]! : null;
}
