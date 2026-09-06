import KDBush from "kdbush";

import type { Route, Stop } from "../schema/api.js";

import { distanceMeters, makeProjector } from "./geo.js";
import { routeLegMeters } from "./legs.js";

// Tuning constants ------------------------------------------------------------

/**
 * EFFECTIVE walking rate applied to CROW-FLIES distance, m/s.
 *
 * Not a walking speed: every caller here divides straight-line metres by it, so
 * it has to absorb the street detour as well as the pace. This codebase already
 * measured that detour against OSRM foot routes over six representative campus
 * pairs — ratios 1.05–1.38, mean ~1.22. With an unhurried 1.3 m/s pace on the
 * ground that gives 1.3 / 1.22 ≈ 1.07, rounded to 1.1.
 *
 * It was 1.4, which reads as "≈5 km/h" and looks reasonable until you notice
 * the missing detour: 1.4 m/s over crow-flies is a ~1.7 m/s (6 km/h) pace on
 * real pavement. Every walk estimate the rider saw was ~25% optimistic, which
 * matters most at the decision it drives — walk now, or wait for the shuttle.
 *
 * The client mirrors this exactly (`WALK_EFFECTIVE_M_S` in web/src/walk.ts) and
 * its test parses THIS line, so the two cannot drift apart again. Change both
 * together, starting here.
 */
export const WALK_M_PER_S = 1.1;

/**
 * Upper bound for precomputed walking transfers between stops.
 * 400 m ≈ 5 min — beyond this, the planner falls back to a direct walk
 * leg from origin/destination rather than chaining stop-to-stop hops.
 */
export const WALK_TRANSFER_MAX_M = 400;

/**
 * Cap on how many of the closest stops to keep as walking transfers
 * per origin stop. Keeps adjacency lists small even in dense clusters.
 */
export const WALK_TRANSFER_MAX_K = 8;

// Types -----------------------------------------------------------------------

export interface SegmentStats {
  /** Calibrated expected travel time in seconds. */
  mean: number;
  /** Standard deviation in seconds — drives confidence intervals. */
  stddev: number;
  /** Number of observations that produced this estimate. */
  n: number;
  /**
   * Where the estimate came from, for debugging/observability.
   *   `specific`     — direct samples at this (route, segment, dow, hour)
   *   `route-segment`— pooled across hours/days at this segment
   *   `route`        — pooled across all segments of the route (poor-data fallback)
   *   `prior`        — distance-based prior; no samples seen
   */
  source: "specific" | "route-segment" | "route" | "prior";
  /**
   * Seconds from the bus's departure at the from-stop to `at_stop_since` at
   * the to-stop — the DRIVE half of the hop, on the pinned clock, from `legs`
   * (the departure derivation). `mean` above is arrival-to-arrival and holds
   * every second the bus stood at A; this does not. The client prices the
   * first hop as `stand(A) + drive` and prorates ONLY this en route
   * (`web/src/hopPricing.ts`). Absent until a leg has been recorded.
   */
  drive?: number;
  /** Legs behind `drive`. The client gates on it (`MIN_DRIVE_SAMPLES`). */
  driveN?: number;
  /**
   * Ascending quantiles of the WHOLE hop, `legs.leg_sec` (drive + every
   * mid-leg hold, departure at A to the first rest at B), at levels
   * (i + 0.5) / dq.length over one-hop legs in the split window. `drive` is
   * one number; this is the distribution the probabilistic estimator sums
   * over. Absent until a leg has been recorded.
   */
  dq?: number[];
  /** Legs behind `dq`. */
  dqn?: number;
}

/**
 * Route-level pooled pace: quantiles of seconds per ROAD metre
 * (`legs.leg_sec` / the length of the published line between the two stops,
 * {@link TransitNetwork.getLegMeters}; the chord only where the line cannot
 * supply the leg) over every one-hop leg on the route in the split window, at
 * levels (i + 0.5) / spm.length. The thin-cell prior — a hop with too few
 * legs of its own is priced from the route's pace times its own `legM`.
 * Hops whose stops are closer than `PACE_MIN_CHORD_M` are not samples.
 */
export interface PaceStats {
  spm: number[];
  /** Legs behind `spm`. */
  n: number;
}

export interface DwellStats {
  mean: number;
  stddev: number;
  n: number;
  /**
   * The 35th percentile of this stop's `dwell_sec` samples.
   *
   * ⚠️ **Nothing in the ETA reads this.** It is calibrated and served, and it
   * is deliberately dormant.
   *
   * It was introduced (2026-09-03) to price a rest the bus had not started at
   * a low quantile, on the premise that a hop's served time is "the dwell at
   * its from-stop plus the drive". That premise is false. `detector.ts`
   * computes one `elapsedSec` per transition — the time from the bus becoming
   * nearest stop A to it becoming nearest stop B — and emits it as BOTH
   * `DwellEvent.dwellSec` and `SegmentEvent.travelSec`. Joined on their shared
   * anchor over 30 days, 119,329 of 119,329 rows are identical. So
   * `dwell_sec` is not the standing-still part of a hop; it is the whole hop,
   * keyed by from-stop instead of by (from, to) pair, and on the live payload
   * this median exceeds the whole segment average on 41.2% of hops.
   *
   * Subtracting it therefore discounted nothing and, through the consumer's
   * floor, SURCHARGED 77% of hops. Replayed over 262,762 real pairs that cost
   * 9.2 s of median absolute error and moved the board 2 points more
   * pessimistic. Reverted; see WHAT A DWELL STATISTIC ACTUALLY MEASURES in
   * `web/src/arrivals.ts` and docs/eta-accuracy.md.
   *
   * Kept, rather than deleted, because a rest model derived from a quantity
   * that really is a dwell would want exactly this shape — and because
   * removing it is a wider diff for no rider-visible gain.
   *
   * Undefined until the calibrator has enough samples to place a quantile.
   */
  low?: number;
  /**
   * Ascending quantiles of the STANDING time at this stop, in seconds on the
   * `at_stop_since` clock (departure instant − `pinned_at`, over stopped
   * visits in `stop_visits`), at levels (i + 0.5) / q.length. Unlike `mean`
   * above this really is standing time — it comes from the departure
   * derivation, not from anchor residence. The client reads it as the knots of
   * a piecewise-linear CDF and prices the first hop as the conditional median
   * of (stand − r | stand > r) plus the drive (`web/src/hopPricing.ts`).
   * Absent until the stop has a stopped visit.
   */
  q?: number[];
  /** Stopped visits behind `q`. The client gates on it (`MIN_STAND_SAMPLES`). */
  qn?: number;
  /**
   * Share of visits that STOPPED here, over visits with outcome `stopped` or
   * `passed` in the split window (unresolved visits are neither). `q` carries
   * the same information as its zero mass, but only for PINNED passes; this
   * counts every pass. Absent wherever `q` is.
   */
  pstop?: number;
}

export interface WalkTransfer {
  toStopId: number;
  meters: number;
  seconds: number;
}

/**
 * Where a bus sits on a route: which stop, and — crucially for out-and-back
 * routes, where one stop id occupies two positions — which entry in the
 * route's sequence.
 */
export interface RouteAnchor {
  stopId: number;
  /** Index into the route's raw stop sequence. */
  index: number;
  meters: number;
}

/** A segment edge keyed by (routeId, fromStopId, toStopId). */
export interface SegmentEdge {
  routeId: number;
  fromStopId: number;
  toStopId: number;
}

// Implementation --------------------------------------------------------------

/** Shared empty result so `positionsOnRoute` misses don't allocate. */
const EMPTY_POSITIONS: ReadonlyArray<number> = Object.freeze([]);

/**
 * The shuttle network as a typed graph.
 *
 * Nodes are stops; directed edges are either:
 *  - segment edges from a route's stop adjacency (one edge per route per pair)
 *  - walking-transfer edges between stops within {@link WALK_TRANSFER_MAX_M}
 *
 * Construction is O(stops × log stops) thanks to the k-d tree for walking
 * transfers, and routes contribute O(Σ |route.stops|) edges. Everything is
 * precomputed once when the static feed is loaded; the only mutable state is
 * the per-segment travel-time calibration, updated by the calibrator on a
 * timer.
 */
export class TransitNetwork {
  readonly stops: ReadonlyMap<number, Stop>;
  readonly routes: ReadonlyMap<number, Route>;

  /** Outgoing segment edges from each stop. */
  readonly segmentEdges: ReadonlyMap<number, ReadonlyArray<SegmentEdge>>;

  /** Walking-transfer edges from each stop, sorted nearest-first. */
  readonly walkTransfers: ReadonlyMap<number, ReadonlyArray<WalkTransfer>>;

  /**
   * First index of each stop on each route.
   *
   * ⚠️ Lossy for out-and-back routes. Routes 9 (Green) and 10 (Purple) visit
   * West Campus with a genuine out-and-back leg, so their upstream sequences
   * repeat stop ids (route 10 is `…26,25,24,23,22,23,24,25,26,72`). This map
   * keeps only the FIRST occurrence. Use {@link routeStopPositions} /
   * {@link positionsOnRoute} whenever "where is this stop on the route" needs
   * to be right for a repeated stop.
   */
  readonly routeStopIndex: ReadonlyMap<number, ReadonlyMap<number, number>>;

  /**
   * Every index at which a stop appears on a route, ascending. The lossless
   * counterpart to {@link routeStopIndex}; a stop with one occurrence has a
   * single-element array, so callers can treat both cases uniformly.
   */
  readonly routeStopPositions: ReadonlyMap<
    number,
    ReadonlyMap<number, ReadonlyArray<number>>
  >;

  /**
   * Road metres of each consecutive hop, keyed like the segment stats
   * (`segmentKey`), traced along the route's PUBLISHED polyline exactly as the
   * client traces it (`src/network/legs.ts`, a pinned copy of
   * `web/src/geo.ts`). Absent where the route has no path, a stop has no
   * coordinate, or the line cannot supply the leg (a bridged chord is not
   * road). Static per network, so computed once here rather than on every
   * payload. On a fold (routes 9/10) the outbound and inbound hops are
   * different (from, to) pairs and get their own lengths; if a pair ever
   * repeats verbatim the first occurrence is kept.
   */
  private readonly legMeters: ReadonlyMap<string, number>;

  private readonly segmentStats = new Map<string, SegmentStats>();
  private readonly dwellStats = new Map<string, DwellStats>();
  private readonly paceStats = new Map<number, PaceStats>();

  private constructor(args: {
    stops: ReadonlyMap<number, Stop>;
    routes: ReadonlyMap<number, Route>;
    segmentEdges: ReadonlyMap<number, ReadonlyArray<SegmentEdge>>;
    walkTransfers: ReadonlyMap<number, ReadonlyArray<WalkTransfer>>;
    routeStopIndex: ReadonlyMap<number, ReadonlyMap<number, number>>;
    routeStopPositions: ReadonlyMap<
      number,
      ReadonlyMap<number, ReadonlyArray<number>>
    >;
    legMeters: ReadonlyMap<string, number>;
  }) {
    this.stops = args.stops;
    this.routes = args.routes;
    this.segmentEdges = args.segmentEdges;
    this.walkTransfers = args.walkTransfers;
    this.routeStopIndex = args.routeStopIndex;
    this.routeStopPositions = args.routeStopPositions;
    this.legMeters = args.legMeters;
  }

  static build(stops: readonly Stop[], routes: readonly Route[]): TransitNetwork {
    const stopMap = new Map(stops.map((s) => [s.id, s]));
    const routeMap = new Map(routes.map((r) => [r.id, r]));
    const segmentEdges = buildSegmentEdges(routes);
    const walkTransfers = buildWalkTransfers(stops);
    const routeStopPositions = buildRouteStopPositions(routes);
    const routeStopIndex = buildRouteStopIndex(routeStopPositions);
    const legMeters = buildLegMeters(stopMap, routes);
    return new TransitNetwork({
      stops: stopMap,
      routes: routeMap,
      segmentEdges,
      walkTransfers,
      routeStopIndex,
      routeStopPositions,
      legMeters,
    });
  }

  // -- Segment / dwell calibration -------------------------------------------

  static segmentKey(routeId: number, fromStopId: number, toStopId: number): string {
    return `${routeId}:${fromStopId}:${toStopId}`;
  }

  static dwellKey(routeId: number, stopId: number): string {
    return `${routeId}:${stopId}`;
  }

  /**
   * The dwell-table key for ONE PASS of a stop the route visits more than
   * once: `"<route>:<stop>#<index>"`, `index` being the position in the raw
   * stop sequence (`stop_visits.stop_index`). Routes 9 and 10 stand very
   * differently on the two passes of a West Campus stop (Purple stop 25: mean
   * stand 107 s at index 6, 42 s at index 12), so the calibrator keeps a table
   * per pass beside the pooled `dwellKey` one; the payload spells it
   * `dwells[route]["<stop>#<index>"]`.
   */
  static occurrenceDwellKey(routeId: number, stopId: number, stopIndex: number): string {
    return `${TransitNetwork.dwellKey(routeId, stopId)}#${stopIndex}`;
  }

  getSegmentStats(routeId: number, fromStopId: number, toStopId: number): SegmentStats {
    const direct = this.segmentStats.get(
      TransitNetwork.segmentKey(routeId, fromStopId, toStopId),
    );
    if (direct) return direct;
    return this.distancePrior(routeId, fromStopId, toStopId);
  }

  getDwellStats(routeId: number, stopId: number): DwellStats {
    return (
      this.dwellStats.get(TransitNetwork.dwellKey(routeId, stopId)) ?? {
        mean: 15, // sensible fallback while the calibrator warms up
        stddev: 10,
        n: 0,
      }
    );
  }

  /**
   * The stand table for one pass of a repeated stop (see
   * {@link occurrenceDwellKey}), or undefined — there is no warm-up default
   * here, because the pooled {@link getDwellStats} entry IS the fallback.
   */
  getOccurrenceDwellStats(routeId: number, stopId: number, stopIndex: number): DwellStats | undefined {
    return this.dwellStats.get(TransitNetwork.occurrenceDwellKey(routeId, stopId, stopIndex));
  }

  /** The route's pooled pace, if the calibrator has one (see PaceStats). */
  getPace(routeId: number): PaceStats | undefined {
    return this.paceStats.get(routeId);
  }

  /**
   * Road metres from `fromStopId` to `toStopId` along the route's published
   * line (see the `legMeters` field), or undefined where the line cannot
   * supply the hop. Served as `segments[route]["A-B"].legM`.
   */
  getLegMeters(routeId: number, fromStopId: number, toStopId: number): number | undefined {
    return this.legMeters.get(TransitNetwork.segmentKey(routeId, fromStopId, toStopId));
  }

  /**
   * Bulk replacement of all calibrated stats. Atomic from the caller's POV.
   * `pace` is replaced too — omitting it clears it, so a calibration without
   * pace never serves a stale one.
   */
  setCalibration(
    segments: ReadonlyMap<string, SegmentStats>,
    dwells: ReadonlyMap<string, DwellStats>,
    pace: ReadonlyMap<number, PaceStats> = new Map(),
  ): void {
    this.segmentStats.clear();
    for (const [k, v] of segments) this.segmentStats.set(k, v);
    this.dwellStats.clear();
    for (const [k, v] of dwells) this.dwellStats.set(k, v);
    this.paceStats.clear();
    for (const [k, v] of pace) this.paceStats.set(k, v);
  }

  // -- Queries ---------------------------------------------------------------

  /**
   * FIRST index of `stopId` on `routeId`, or null if the stop isn't on that
   * route. For a stop that a route visits twice (West Campus out-and-back),
   * this is deliberately the earlier, more pessimistic occurrence — a rider
   * told "the bus still has the whole out-and-back to do" is disappointed far
   * less often than one told the opposite. Use {@link positionsOnRoute} when
   * you need every occurrence.
   */
  positionOnRoute(routeId: number, stopId: number): number | null {
    return this.routeStopIndex.get(routeId)?.get(stopId) ?? null;
  }

  /**
   * Every index at which `stopId` appears on `routeId`, ascending. Empty if
   * the stop isn't on the route (or the route is unknown).
   */
  positionsOnRoute(routeId: number, stopId: number): ReadonlyArray<number> {
    return this.routeStopPositions.get(routeId)?.get(stopId) ?? EMPTY_POSITIONS;
  }

  /** Number of entries in a route's raw stop sequence (duplicates included). */
  routeLength(routeId: number): number {
    return this.routes.get(routeId)?.stops.length ?? 0;
  }

  /**
   * Stop id at `index` in a route's sequence, wrapping the loop in both
   * directions. Null if the route is unknown or has no stops.
   *
   * Index-addressed traversal is the only way to walk an out-and-back route
   * correctly: `stopIdAtIndex` distinguishes the two visits to a repeated
   * stop, whereas id-addressed stepping (see {@link nextOnRoute}) cannot.
   */
  stopIdAtIndex(routeId: number, index: number): number | null {
    const route = this.routes.get(routeId);
    const n = route?.stops.length ?? 0;
    if (!route || n === 0) return null;
    return route.stops[((index % n) + n) % n] ?? null;
  }

  /**
   * Next stop along the route loop after `stopId`. Wraps from the last stop
   * back to the first. Returns null if the stop isn't on the route.
   *
   * ⚠️ Ambiguous — and non-terminating if you iterate it — on a route that
   * visits a stop twice. Route 10 is `…26,25,24,23,22,23,24,25,26,72`: this
   * resolves `next(23)` from the FIRST 23 (→ 22) and `next(22)` (→ 23), so
   * chasing `nextOnRoute` from stop 23 oscillates 23→22→23→22 forever and
   * never reaches 24. Walk indices with {@link stopIdAtIndex} instead; this
   * method is kept only for single-visit lookups.
   */
  nextOnRoute(routeId: number, stopId: number): number | null {
    const idx = this.positionOnRoute(routeId, stopId);
    if (idx === null) return null;
    return this.stopIdAtIndex(routeId, idx + 1);
  }

  /**
   * Number of stops from `fromStopId` to `toStopId` going forward along the
   * route's loop. Returns null if either stop isn't on the route.
   * Loops wrap: stop 5 → stop 2 on a 7-stop route is 4 hops, not -3.
   *
   * When either stop is visited more than once, this returns the SMALLEST
   * forward distance over all (from-occurrence, to-occurrence) pairs — i.e.
   * the shortest ride that could actually connect them. Anything else breaks
   * the detector: with first-occurrence-only indexing, route 10's return leg
   * (`22→23`, `23→24`, `24→25`, `25→26`) scored 14 hops apiece, blew past
   * MAX_SEGMENT_HOPS, and was discarded — half of West Campus had *zero*
   * calibration samples in 3.2k recorded segments.
   */
  hopsForward(routeId: number, fromStopId: number, toStopId: number): number | null {
    const n = this.routeLength(routeId);
    if (n === 0) return null;
    const fromIdxs = this.positionsOnRoute(routeId, fromStopId);
    const toIdxs = this.positionsOnRoute(routeId, toStopId);
    if (fromIdxs.length === 0 || toIdxs.length === 0) return null;
    let best = Infinity;
    for (const from of fromIdxs) {
      for (const to of toIdxs) {
        const d = (((to - from) % n) + n) % n;
        if (d < best) best = d;
      }
    }
    return Number.isFinite(best) ? best : null;
  }

  /**
   * Closest stop on `routeId` to `point`, or null if the route doesn't exist,
   * has no stops, or nothing falls within `maxMeters`. Linear scan over the
   * route's stop list — the longest route has 33 entries, so a spatial index
   * would be overkill.
   *
   * This is the input to arrival detection: when a bus's `nearestStopOnRoute`
   * changes between polls, we treat it as having departed the previous stop
   * and arrived at the new one.
   *
   * ⚠️ Two things this deliberately does NOT do:
   *  - No direction: a bus between A and B anchors to whichever is closer,
   *    not to the one it is heading toward.
   *  - No occurrence disambiguation: on an out-and-back route the two visits
   *    to a stop are the same physical coordinate, so distance alone can
   *    never tell them apart. {@link hopsForward} resolves that ambiguity
   *    downstream by taking the shortest forward distance.
   *
   * `maxMeters` defaults to Infinity to preserve the "always anchor
   * somewhere" behaviour the detector relies on; callers that need a real
   * "the bus is AT this stop" answer must pass a radius.
   */
  nearestStopOnRoute(
    routeId: number,
    point: { lat: number; lon: number },
    maxMeters = Infinity,
  ): RouteAnchor | null {
    const route = this.routes.get(routeId);
    if (!route || route.stops.length === 0) return null;
    let best: RouteAnchor | null = null;
    for (let i = 0; i < route.stops.length; i++) {
      const stopId = route.stops[i]!;
      const stop = this.stops.get(stopId);
      if (!stop) continue;
      const m = distanceMeters(point, stop);
      if (!best || m < best.meters) best = { stopId, index: i, meters: m };
    }
    if (!best || best.meters > maxMeters) return null;
    return best;
  }

  /**
   * Closest stop to `point` among the next `lookahead` entries of the route
   * sequence starting at `fromIndex` (inclusive, wrapping). Null if the route
   * is unknown or every candidate stop is missing from the stop table.
   *
   * ## Why a window instead of a global scan
   *
   * `nearestStopOnRoute` has no notion of where the bus already is, so on a
   * route that comes back within a few dozen metres of itself the anchor
   * teleports across the sequence. Route 1 lists `College / Wall (S)` at
   * index 18 and `College / Wall (N)` at index 28 — **28 m apart**, far
   * inside GPS noise. A southbound bus at College/Wall therefore flickers
   * between index 18 and index 28 on consecutive polls, and the damage is
   * twofold:
   *
   *  - Each flicker is a "transition" 10 or 21 hops long, so it is discarded
   *    by MAX_SEGMENT_HOPS...
   *  - ...and worse, it leaves the anchor at index 28, so the *next* genuine
   *    transition (to `Phelps Gate`, index 19) also scores 9 hops and is
   *    discarded too.
   *
   * Replaying 59,605 recorded positions, this cost every sample on
   * `42→98`, `52→41`, `41→20`, `97→118` and eleven other legs across routes
   * 1, 2, 3 and 9 — all of them (N)/(S) pairs on the same street, or a stop
   * the route passes near out of sequence. Restricting candidates to the
   * stops the bus could plausibly reach next makes the far-away twin
   * ineligible, which is exactly the direction information a pure distance
   * scan throws away.
   *
   * The window includes `fromIndex` itself, so a bus that has not moved
   * simply stays where it is.
   */
  nearestStopAheadOnRoute(
    routeId: number,
    point: { lat: number; lon: number },
    fromIndex: number,
    lookahead: number,
  ): RouteAnchor | null {
    const route = this.routes.get(routeId);
    const n = route?.stops.length ?? 0;
    if (!route || n === 0) return null;
    const span = Math.min(lookahead, n - 1);
    let best: RouteAnchor | null = null;
    for (let step = 0; step <= span; step++) {
      const index = (((fromIndex + step) % n) + n) % n;
      const stopId = route.stops[index]!;
      const stop = this.stops.get(stopId);
      if (!stop) continue;
      const m = distanceMeters(point, stop);
      if (!best || m < best.meters) best = { stopId, index, meters: m };
    }
    return best;
  }

  /** Stops within `radiusM` of a coordinate, with walking time. */
  stopsNear(point: { lat: number; lon: number }, radiusM: number): WalkTransfer[] {
    // Linear scan — there are ~170 stops in the whole network, no need for
    // a separate k-d tree for ad-hoc origin/destination queries.
    const out: WalkTransfer[] = [];
    for (const stop of this.stops.values()) {
      const meters = distanceMeters(point, stop);
      if (meters <= radiusM) {
        out.push({ toStopId: stop.id, meters, seconds: meters / WALK_M_PER_S });
      }
    }
    out.sort((a, b) => a.meters - b.meters);
    return out;
  }

  // -- Internals -------------------------------------------------------------

  /**
   * Distance-based prior used when we've never seen a (route, segment) before.
   * Assumes a city-average bus speed of ~20 km/h between stops (≈5.5 m/s);
   * stddev scales with mean so the confidence interval widens for longer hops.
   */
  private distancePrior(
    routeId: number,
    fromStopId: number,
    toStopId: number,
  ): SegmentStats {
    const from = this.stops.get(fromStopId);
    const to = this.stops.get(toStopId);
    if (!from || !to) {
      return { mean: 60, stddev: 60, n: 0, source: "prior" };
    }
    const meters = distanceMeters(from, to);
    const mean = Math.max(20, meters / 5.5);
    return { mean, stddev: mean * 0.5, n: 0, source: "prior" };
  }
}

// Construction helpers --------------------------------------------------------

function buildSegmentEdges(
  routes: readonly Route[],
): Map<number, SegmentEdge[]> {
  const byStop = new Map<number, SegmentEdge[]>();
  for (const route of routes) {
    const n = route.stops.length;
    if (n < 2) continue;
    // An out-and-back route yields two distinct edges from the same stop on
    // the same route (route 9's stop 25 goes to both 23 and 127). Both are
    // real, so both are kept; a `seen` key stops the *identical* pair from
    // being stored twice when a route doubles back on itself exactly.
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const fromStopId = route.stops[i]!;
      const toStopId = route.stops[(i + 1) % n]!;
      // A route listing the same stop twice in a row is an upstream typo, not
      // a segment; recording it would teach the calibrator a 0 m hop.
      if (fromStopId === toStopId) continue;
      const key = `${fromStopId}:${toStopId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const edge: SegmentEdge = { routeId: route.id, fromStopId, toStopId };
      const bucket = byStop.get(fromStopId);
      if (bucket) bucket.push(edge);
      else byStop.set(fromStopId, [edge]);
    }
  }
  return byStop;
}

function buildLegMeters(
  stops: ReadonlyMap<number, Stop>,
  routes: readonly Route[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const route of routes) {
    const n = route.stops.length;
    if (!route.path || n < 2) continue;
    const coords: Stop[] = [];
    for (const id of route.stops) {
      const s = stops.get(id);
      if (!s) break;
      coords.push(s);
    }
    // A stop without a coordinate breaks the trace for the whole loop (the
    // tracer walks forward from each stop), so the route gets no lengths at
    // all rather than a mis-cut set.
    if (coords.length !== n) continue;
    const metres = routeLegMeters(route.path, coords);
    for (let i = 0; i < n; i++) {
      const m = metres[i];
      if (m === null || m === undefined) continue;
      const key = TransitNetwork.segmentKey(route.id, route.stops[i]!, route.stops[(i + 1) % n]!);
      if (!out.has(key)) out.set(key, m);
    }
  }
  return out;
}

function buildRouteStopPositions(
  routes: readonly Route[],
): Map<number, Map<number, number[]>> {
  const out = new Map<number, Map<number, number[]>>();
  for (const route of routes) {
    const inner = new Map<number, number[]>();
    for (let i = 0; i < route.stops.length; i++) {
      const stopId = route.stops[i]!;
      const bucket = inner.get(stopId);
      if (bucket) bucket.push(i);
      else inner.set(stopId, [i]);
    }
    out.set(route.id, inner);
  }
  return out;
}

function buildRouteStopIndex(
  positions: ReadonlyMap<number, ReadonlyMap<number, ReadonlyArray<number>>>,
): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  for (const [routeId, byStop] of positions) {
    const inner = new Map<number, number>();
    // First occurrence wins — most Yale routes don't repeat a stop, but the
    // two West Campus routes do; the first hit is the canonical (and
    // pessimistic) board position. See `positionOnRoute`.
    for (const [stopId, idxs] of byStop) inner.set(stopId, idxs[0]!);
    out.set(routeId, inner);
  }
  return out;
}

function buildWalkTransfers(stops: readonly Stop[]): Map<number, WalkTransfer[]> {
  if (stops.length === 0) return new Map();

  // Center the projection on the network centroid to minimize distortion.
  const centroid = {
    lat: stops.reduce((a, s) => a + s.lat, 0) / stops.length,
    lon: stops.reduce((a, s) => a + s.lon, 0) / stops.length,
  };
  const project = makeProjector(centroid);

  const projected = stops.map((s) => ({ stop: s, xy: project(s) }));
  const idx = new KDBush(stops.length);
  for (const { xy } of projected) idx.add(xy[0], xy[1]);
  idx.finish();

  const out = new Map<number, WalkTransfer[]>();
  for (let i = 0; i < projected.length; i++) {
    const { stop: from, xy } = projected[i]!;
    const hits = idx.within(xy[0], xy[1], WALK_TRANSFER_MAX_M);
    const transfers: WalkTransfer[] = [];
    for (const j of hits) {
      if (j === i) continue;
      const { stop: to, xy: txy } = projected[j]!;
      const meters = Math.hypot(txy[0] - xy[0], txy[1] - xy[1]);
      transfers.push({
        toStopId: to.id,
        meters,
        seconds: meters / WALK_M_PER_S,
      });
    }
    transfers.sort((a, b) => a.meters - b.meters);
    out.set(from.id, transfers.slice(0, WALK_TRANSFER_MAX_K));
  }
  return out;
}
