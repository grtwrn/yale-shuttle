import { and, gte } from "drizzle-orm";

import type { DB } from "../db/client.js";
import { arrivals, segments } from "../db/schema.js";
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
const SEGMENT_WINDOW_DAYS = 30;

/** Sliding window of dwell data fed to the calibrator. */
const DWELL_WINDOW_DAYS = 14;

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
  const dow = now.getDay();
  const hour = now.getHours();
  const currentWindow = hourWindow(hour, HOUR_WINDOW);

  const segmentSamples = loadSegments(db, SEGMENT_WINDOW_DAYS);
  const dwellSamples = loadDwells(db, DWELL_WINDOW_DAYS);

  const segmentStats = computeSegmentStats(segmentSamples, dow, currentWindow);
  const dwellStats = computeDwellStats(dwellSamples, dow, currentWindow);

  network.setCalibration(segmentStats, dwellStats);

  return {
    segmentCount: segmentStats.size,
    dwellCount: dwellStats.size,
    sampleCount: segmentSamples.length + dwellSamples.length,
    durationMs: Date.now() - t0,
  };
}

// Internals ------------------------------------------------------------------

interface SegmentSample {
  routeId: number;
  fromStopId: number;
  toStopId: number;
  travelSec: number;
  dow: number;
  hour: number;
}

interface DwellSample {
  routeId: number;
  stopId: number;
  dwellSec: number;
  dow: number;
  hour: number;
}

function loadSegments(db: DB, windowDays: number): SegmentSample[] {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000);
  const rows = db
    .select({
      routeId: segments.routeId,
      fromStopId: segments.fromStopId,
      toStopId: segments.toStopId,
      travelSec: segments.travelSec,
      dow: segments.dow,
      hour: segments.hour,
    })
    .from(segments)
    .where(gte(segments.startedAt, cutoff))
    .all();
  return rows;
}

function loadDwells(db: DB, windowDays: number): DwellSample[] {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000);
  const rows = db
    .select({
      routeId: arrivals.routeId,
      stopId: arrivals.stopId,
      dwellSec: arrivals.dwellSec,
      dow: arrivals.dow,
      hour: arrivals.hour,
    })
    .from(arrivals)
    .where(and(gte(arrivals.arrivedAt, cutoff)))
    .all();
  return rows
    .filter((r): r is DwellSample & { dwellSec: number } => r.dwellSec !== null)
    .map((r) => ({
      routeId: r.routeId,
      stopId: r.stopId,
      dwellSec: r.dwellSec,
      dow: r.dow,
      hour: r.hour,
    }));
}

/**
 * Build the per-(route, segment) shrinkage estimates for the current window.
 *
 * Pooling hierarchy, applied in one pass:
 *  1. Group samples by (routeId, fromStopId, toStopId).
 *  2. Compute the segment-wide prior (across all hours/days) for that group.
 *  3. Filter to the (dow, hour ± HOUR_WINDOW) window.
 *  4. Shrink the windowed samples toward the segment-wide prior.
 *
 * Step 2 replaces v1's `route.dow` and `route.any` cascades — pooling across
 * hours/days for the same segment is the natural backbone signal. We don't
 * pool across segments because pace varies wildly (a segment crossing campus
 * is nothing like one on a stroad).
 */
function computeSegmentStats(
  samples: readonly SegmentSample[],
  dow: number,
  hourWindow: ReadonlyArray<number>,
): Map<string, SegmentStats> {
  const grouped = groupBy(samples, (s) =>
    TransitNetwork.segmentKey(s.routeId, s.fromStopId, s.toStopId),
  );

  const hourSet = new Set(hourWindow);
  const out = new Map<string, SegmentStats>();

  for (const [key, group] of grouped) {
    const allTravel = group.map((s) => s.travelSec);
    // Median for the prior (robust to outliers — a broken-down bus skews
    // the mean badly; the median is unmoved).
    const priorMean = median(allTravel);

    const windowed = group
      .filter((s) => s.dow === dow && hourSet.has(s.hour))
      .map((s) => s.travelSec);

    const est = shrink({
      samples: windowed,
      priorMean,
      k: SHRINKAGE_K,
    });

    out.set(key, {
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

function computeDwellStats(
  samples: readonly DwellSample[],
  dow: number,
  hourWindow: ReadonlyArray<number>,
): Map<string, DwellStats> {
  const grouped = groupBy(samples, (s) =>
    TransitNetwork.dwellKey(s.routeId, s.stopId),
  );

  const hourSet = new Set(hourWindow);
  const out = new Map<string, DwellStats>();

  for (const [key, group] of grouped) {
    // Dwell distributions are heavy-tailed (driver bathroom breaks, late
    // boarders). Use the median + 90th-percentile spread instead of mean +
    // stddev so a single 4-minute dwell doesn't ruin the whole stop's stats.
    const all = group.map((s) => s.dwellSec);
    const priorMedian = median(all);

    const windowed = group
      .filter((s) => s.dow === dow && hourSet.has(s.hour))
      .map((s) => s.dwellSec);

    if (windowed.length === 0) {
      out.set(key, {
        mean: priorMedian,
        stddev: Math.max(percentile(all, 0.9) - priorMedian, 5),
        n: 0,
      });
      continue;
    }

    const med = median(windowed);
    const p90 = percentile(windowed, 0.9);
    out.set(key, {
      mean: med,
      stddev: Math.max(p90 - med, 5),
      n: windowed.length,
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

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}
