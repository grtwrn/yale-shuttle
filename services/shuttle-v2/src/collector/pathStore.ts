/**
 * Persistence and selection for route geometry derived from observed GPS.
 *
 * `derivePath` (src/network/derivePath.ts) turns a bag of polled positions into
 * one ordered loop. This module answers the two questions that surround it:
 * where the result lives once `raw_positions` has been swept, and whether a new
 * candidate should displace the one already stored.
 *
 * Both answers are shaped by the same fact: **a route can only be derived while
 * it is running.** Green and Purple stop by ~19:30, the night routes run
 * 18:00-01:00, Grocery only at weekends — and `raw_positions` is retained for
 * six hours. So at any given moment most routes have no usable samples, and the
 * job that calls this will spend most of its attempts finding nothing. That is
 * the normal case, not a failure: the store accumulates, keeps the best result
 * it has ever seen per route, and never drops one because the route happens to
 * be idle right now.
 */

import type Database from "better-sqlite3";

import type { DerivedPath } from "../network/derivePath.js";
import { stopDistances, traceFailures } from "../network/derivePath.js";
import type { LatLon } from "../network/geo.js";

/** A derivation as it is stored: the line plus how good it was measured to be. */
export interface StoredPath {
  routeId: number;
  path: [number, number][];
  pointCount: number;
  stopCount: number;
  medianStopM: number;
  p90StopM: number;
  maxStopM: number;
  lengthM: number;
  /**
   * Legs of the route that could not be traced along this line when it was
   * stored — the measure `isBetterThanUpstream` decides on, kept so an operator
   * can see why a path is still in place without re-deriving it.
   */
  traceFailures: number;
  busId: number;
  sampleCount: number;
  derivedAt: number;
}

/**
 * How much better a candidate must be to displace the incumbent: its worst-tenth
 * stop must sit at most 85% as far from the line.
 *
 * A bare "is it better" test would rewrite the geometry most nights, because two
 * derivations of the same loop from different laps differ by a metre or two of
 * noise. The map would then redraw a rider's route slightly differently every
 * few hours for no visible gain. Requiring a clear margin means a replacement
 * corresponds to something real — a better-covered lap, or a changed road.
 */
export const REPLACE_IMPROVEMENT = 0.85;

/**
 * Does `a` clear the replacement margin against `b`?
 *
 * The strict inequality is not redundant with the ratio. Two lines that both
 * fit perfectly measure 0 and 0, and `0 <= 0 * 0.85` is true — so the ratio
 * alone would have each of a pair of equally good paths forever displacing the
 * other, which is exactly the churn the margin exists to prevent.
 */
const clearlyBetter = (a: number, b: number): boolean => a < b && a <= b * REPLACE_IMPROVEMENT;

/**
 * After this long, accept any candidate that is not actually worse.
 *
 * The margin above is deliberately hard to clear, which is right for churn and
 * wrong for drift: a detour around construction, a re-routed block, or a stop
 * that upstream nudged 40 m would otherwise be locked out for as long as the
 * incumbent's number stays nominally better. Two weeks is far longer than any
 * plausible thrash cycle (candidates arrive hours apart) and far shorter than a
 * semester, so real geometry changes land within a fortnight.
 */
export const STALE_MS = 14 * 24 * 60 * 60 * 1_000;

// Mirrors `derivePath`'s own quantile so a candidate's figures and an
// incumbent's are computed the same way; comparing two differently-defined
// medians would silently bias every replacement decision.
const quantile = (xs: readonly number[], q: number): number => {
  if (xs.length === 0) return Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

/**
 * How far a route's stops sit from a line, at the median and at the 90th
 * percentile.
 *
 * The tail is the number that decides things, for the reason `derivePath`
 * selects on it: the line is used to locate each stop on it, so one stop
 * stranded 280 m away breaks that leg's geometry however comfortable the
 * typical stop is. Both are computed here, from the stops, rather than read off
 * a stored row — the two agree right up until upstream moves a stop, at which
 * point the row describes a loop that no longer exists.
 */
export function stopFitM(
  path: readonly [number, number][],
  stops: readonly LatLon[],
): { medianM: number; p90M: number } {
  if (path.length < 2 || stops.length === 0) return { medianM: Infinity, p90M: Infinity };
  const d = stopDistances(path, stops);
  return { medianM: quantile(d, 0.5), p90M: quantile(d, 0.9) };
}

/**
 * Whether `candidate` should displace `stored`.
 *
 * Judged on the same two things, in the same order, that decide whether a
 * derived path beats upstream at all — because a rule that disagreed with
 * `isBetterThanUpstream` would let a path in through one door that the other
 * had just refused:
 *
 *  1. **Traced legs.** How many of the route's legs cannot be drawn along the
 *     line. This is the thing riders actually see, and it is not implied by
 *     proximity: a line can sit closer to every stop and still trace worse,
 *     because proximity says nothing about the stops falling along it in order.
 *  2. **The tail**, when the two draw equally well. A stop stranded in the
 *     worst tenth breaks its leg however good the median is.
 *
 * The incumbent is re-measured against the CURRENT stops and sequence rather
 * than read from its row. The two agree until upstream moves a stop or reshapes
 * the route, at which point the stored figure describes a loop that no longer
 * exists and would silently outrank every honest candidate.
 */
export function shouldReplacePath(
  stored: StoredPath | undefined,
  candidate: DerivedPath,
  stops: readonly LatLon[],
  /** The route's ORDERED stop list, duplicates included. */
  sequence: readonly LatLon[],
  nowMs: number,
): boolean {
  // Nothing stored: anything that got this far (it already beat upstream) wins.
  if (!stored) return true;
  // The route itself changed shape. The incumbent was derived for a different
  // set of stops, so none of its numbers are comparable — take the fresh one.
  if (stored.stopCount !== stops.length) return true;

  if (sequence.length >= 2) {
    const candidateFailures = traceFailures(candidate.path, sequence);
    const storedFailures = traceFailures(stored.path, sequence);
    // Strictly better drawing wins outright; strictly worse loses outright,
    // whatever the distance figures say. Only a tie falls through.
    if (candidateFailures !== storedFailures) return candidateFailures < storedFailures;
  }

  const fit = stopFitM(stored.path, stops);
  if (clearlyBetter(candidate.p90StopM, fit.p90M)) return true;
  // Stale: accept a sideways move, never a downgrade on either measure.
  if (
    nowMs - stored.derivedAt >= STALE_MS &&
    candidate.p90StopM <= fit.p90M &&
    candidate.medianStopM <= fit.medianM
  ) {
    return true;
  }
  return false;
}

/**
 * Whether upstream's published path has become better than what we stored.
 *
 * The mirror image of the acceptance test, and the reason it exists: this whole
 * feature is a workaround for coarse published geometry, so upstream fixing its
 * own path is a plausible outcome and would leave us serving a derivation that
 * is now the worse of the two, with nothing to notice it. Judged the same way
 * round — traced legs first, then the tail with the same margin — so a
 * derivation is never dropped over noise.
 */
export function upstreamNowBeats(
  stored: StoredPath,
  upstream: readonly [number, number][] | undefined,
  stops: readonly LatLon[],
  sequence: readonly LatLon[],
): boolean {
  if (!upstream || upstream.length < 2) return false;
  if (sequence.length >= 2) {
    const upstreamFailures = traceFailures(upstream, sequence);
    const storedFailures = traceFailures(stored.path, sequence);
    if (upstreamFailures !== storedFailures) return upstreamFailures < storedFailures;
  }
  const up = stopFitM(upstream, stops);
  const mine = stopFitM(stored.path, stops);
  return clearlyBetter(up.p90M, mine.p90M);
}

/**
 * The `derived_paths` table, as prepared statements.
 *
 * One row per route, upserted. Kept off Drizzle's query builder for the same
 * reason the collector's other hot statements are: these are prepared once at
 * construction and run from a timer, and the raw form is the one that is
 * obviously a single-row write.
 */
export class PathStore {
  private readonly selectAllStmt: Database.Statement;
  private readonly upsertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(sqlite: Database.Database) {
    this.selectAllStmt = sqlite.prepare(`
      SELECT route_id, path_json, point_count, stop_count, median_stop_m,
             p90_stop_m, max_stop_m, length_m, trace_failures, bus_id,
             sample_count, derived_at
      FROM derived_paths
    `);
    this.upsertStmt = sqlite.prepare(`
      INSERT INTO derived_paths (
        route_id, path_json, point_count, stop_count, median_stop_m,
        p90_stop_m, max_stop_m, length_m, trace_failures, bus_id,
        sample_count, derived_at
      ) VALUES (
        @routeId, @pathJson, @pointCount, @stopCount, @medianStopM,
        @p90StopM, @maxStopM, @lengthM, @traceFailures, @busId,
        @sampleCount, @derivedAt
      )
      ON CONFLICT(route_id) DO UPDATE SET
        path_json = excluded.path_json,
        point_count = excluded.point_count,
        stop_count = excluded.stop_count,
        median_stop_m = excluded.median_stop_m,
        p90_stop_m = excluded.p90_stop_m,
        max_stop_m = excluded.max_stop_m,
        length_m = excluded.length_m,
        trace_failures = excluded.trace_failures,
        bus_id = excluded.bus_id,
        sample_count = excluded.sample_count,
        derived_at = excluded.derived_at
    `);
    this.deleteStmt = sqlite.prepare("DELETE FROM derived_paths WHERE route_id = ?");
  }

  /**
   * Every stored derivation, keyed by route. Called once at startup — this is
   * what makes a good path survive a restart, and survive the six-hourly sweep
   * that removes the samples it came from.
   *
   * A row whose JSON will not parse is skipped rather than thrown: one corrupt
   * row must not stop the other fourteen routes from being drawn properly.
   */
  loadAll(): Map<number, StoredPath> {
    const out = new Map<number, StoredPath>();
    for (const row of this.selectAllStmt.all() as DerivedPathRow[]) {
      let path: [number, number][];
      try {
        path = JSON.parse(row.path_json) as [number, number][];
      } catch {
        continue;
      }
      if (!Array.isArray(path) || path.length < 2) continue;
      out.set(row.route_id, {
        routeId: row.route_id,
        path,
        pointCount: row.point_count,
        stopCount: row.stop_count,
        medianStopM: row.median_stop_m,
        p90StopM: row.p90_stop_m,
        maxStopM: row.max_stop_m,
        lengthM: row.length_m,
        traceFailures: row.trace_failures,
        busId: row.bus_id,
        sampleCount: row.sample_count,
        derivedAt: row.derived_at,
      });
    }
    return out;
  }

  /** Forget a route's derivation, so the published path is served again. */
  drop(routeId: number): void {
    this.deleteStmt.run(routeId);
  }

  put(p: StoredPath): void {
    this.upsertStmt.run({
      routeId: p.routeId,
      pathJson: JSON.stringify(p.path),
      pointCount: p.pointCount,
      stopCount: p.stopCount,
      medianStopM: p.medianStopM,
      p90StopM: p.p90StopM,
      maxStopM: p.maxStopM,
      lengthM: p.lengthM,
      traceFailures: p.traceFailures,
      busId: p.busId,
      sampleCount: p.sampleCount,
      derivedAt: p.derivedAt,
    });
  }
}

interface DerivedPathRow {
  route_id: number;
  path_json: string;
  point_count: number;
  stop_count: number;
  median_stop_m: number;
  p90_stop_m: number;
  max_stop_m: number;
  length_m: number;
  trace_failures: number;
  bus_id: number;
  sample_count: number;
  derived_at: number;
}

/** Build the row a `DerivedPath` becomes. */
export function toStoredPath(
  routeId: number,
  d: DerivedPath,
  /** The route's ORDERED stop list, for the traced-leg count. */
  sequence: readonly LatLon[],
  sampleCount: number,
  nowMs: number,
): StoredPath {
  return {
    routeId,
    path: d.path,
    pointCount: d.path.length,
    stopCount: d.stopCount,
    medianStopM: d.medianStopM,
    p90StopM: d.p90StopM,
    maxStopM: d.maxStopM,
    lengthM: d.lengthM,
    traceFailures: sequence.length >= 2 ? traceFailures(d.path, sequence) : 0,
    busId: d.busId,
    sampleCount,
    derivedAt: nowMs,
  };
}
