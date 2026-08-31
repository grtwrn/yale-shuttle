import KDBush from "kdbush";

import type { Route, Stop } from "../schema/api.js";

import { distanceMeters, makeProjector } from "./geo.js";

// Tuning constants ------------------------------------------------------------

/** Average walking speed in meters per second (≈5 km/h). */
export const WALK_M_PER_S = 1.4;

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
}

export interface DwellStats {
  mean: number;
  stddev: number;
  n: number;
}

export interface WalkTransfer {
  toStopId: number;
  meters: number;
  seconds: number;
}

/** A segment edge keyed by (routeId, fromStopId, toStopId). */
export interface SegmentEdge {
  routeId: number;
  fromStopId: number;
  toStopId: number;
}

// Implementation --------------------------------------------------------------

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

  /** Stops on each route, in loop order (same as Route.stops, but indexed). */
  readonly routeStopIndex: ReadonlyMap<number, ReadonlyMap<number, number>>;

  private readonly segmentStats = new Map<string, SegmentStats>();
  private readonly dwellStats = new Map<string, DwellStats>();

  private constructor(args: {
    stops: ReadonlyMap<number, Stop>;
    routes: ReadonlyMap<number, Route>;
    segmentEdges: ReadonlyMap<number, ReadonlyArray<SegmentEdge>>;
    walkTransfers: ReadonlyMap<number, ReadonlyArray<WalkTransfer>>;
    routeStopIndex: ReadonlyMap<number, ReadonlyMap<number, number>>;
  }) {
    this.stops = args.stops;
    this.routes = args.routes;
    this.segmentEdges = args.segmentEdges;
    this.walkTransfers = args.walkTransfers;
    this.routeStopIndex = args.routeStopIndex;
  }

  static build(stops: readonly Stop[], routes: readonly Route[]): TransitNetwork {
    const stopMap = new Map(stops.map((s) => [s.id, s]));
    const routeMap = new Map(routes.map((r) => [r.id, r]));
    const segmentEdges = buildSegmentEdges(routes);
    const walkTransfers = buildWalkTransfers(stops);
    const routeStopIndex = buildRouteStopIndex(routes);
    return new TransitNetwork({
      stops: stopMap,
      routes: routeMap,
      segmentEdges,
      walkTransfers,
      routeStopIndex,
    });
  }

  // -- Segment / dwell calibration -------------------------------------------

  static segmentKey(routeId: number, fromStopId: number, toStopId: number): string {
    return `${routeId}:${fromStopId}:${toStopId}`;
  }

  static dwellKey(routeId: number, stopId: number): string {
    return `${routeId}:${stopId}`;
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

  /** Bulk replacement of all calibrated stats. Atomic from the caller's POV. */
  setCalibration(
    segments: ReadonlyMap<string, SegmentStats>,
    dwells: ReadonlyMap<string, DwellStats>,
  ): void {
    this.segmentStats.clear();
    for (const [k, v] of segments) this.segmentStats.set(k, v);
    this.dwellStats.clear();
    for (const [k, v] of dwells) this.dwellStats.set(k, v);
  }

  // -- Queries ---------------------------------------------------------------

  /** Index of `stopId` on `routeId`, or null if the stop isn't on that route. */
  positionOnRoute(routeId: number, stopId: number): number | null {
    return this.routeStopIndex.get(routeId)?.get(stopId) ?? null;
  }

  /**
   * Next stop along the route loop after `stopId`. Wraps from the last stop
   * back to the first. Returns null if the stop isn't on the route.
   */
  nextOnRoute(routeId: number, stopId: number): number | null {
    const route = this.routes.get(routeId);
    if (!route) return null;
    const idx = this.positionOnRoute(routeId, stopId);
    if (idx === null) return null;
    return route.stops[(idx + 1) % route.stops.length] ?? null;
  }

  /**
   * Number of stops from `fromStopId` to `toStopId` going forward along the
   * route's loop. Returns null if either stop isn't on the route.
   * Loops wrap: stop 5 → stop 2 on a 7-stop route is 4 hops, not -3.
   */
  hopsForward(routeId: number, fromStopId: number, toStopId: number): number | null {
    const route = this.routes.get(routeId);
    if (!route) return null;
    const from = this.positionOnRoute(routeId, fromStopId);
    const to = this.positionOnRoute(routeId, toStopId);
    if (from === null || to === null) return null;
    const n = route.stops.length;
    return ((to - from) % n + n) % n;
  }

  /**
   * Closest stop on `routeId` to `point`, or null if the route doesn't exist
   * or has no stops. Linear scan over the route's stop list — routes have
   * at most ~20 stops, so a spatial index would be overkill.
   *
   * This is the input to arrival detection: when a bus's `nearestStopOnRoute`
   * changes between polls, we treat it as having departed the previous stop
   * and arrived at the new one.
   */
  nearestStopOnRoute(
    routeId: number,
    point: { lat: number; lon: number },
  ): { stopId: number; meters: number } | null {
    const route = this.routes.get(routeId);
    if (!route || route.stops.length === 0) return null;
    let bestId = -1;
    let bestM = Infinity;
    for (const stopId of route.stops) {
      const stop = this.stops.get(stopId);
      if (!stop) continue;
      const m = distanceMeters(point, stop);
      if (m < bestM) {
        bestM = m;
        bestId = stopId;
      }
    }
    if (bestId < 0) return null;
    return { stopId: bestId, meters: bestM };
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
    for (let i = 0; i < n; i++) {
      const fromStopId = route.stops[i]!;
      const toStopId = route.stops[(i + 1) % n]!;
      const edge: SegmentEdge = { routeId: route.id, fromStopId, toStopId };
      const bucket = byStop.get(fromStopId);
      if (bucket) bucket.push(edge);
      else byStop.set(fromStopId, [edge]);
    }
  }
  return byStop;
}

function buildRouteStopIndex(
  routes: readonly Route[],
): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  for (const route of routes) {
    const inner = new Map<number, number>();
    for (let i = 0; i < route.stops.length; i++) {
      // First occurrence wins — most Yale routes don't repeat a stop, but
      // a few loop variants do; the first hit is the canonical board position.
      const stopId = route.stops[i]!;
      if (!inner.has(stopId)) inner.set(stopId, i);
    }
    out.set(route.id, inner);
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
