// Which buses are on their route at all, and the published line each route
// is measured against. Extracted from TransitMap.tsx.
//
// The anchor that used to live below `isBusOnRoute` — `findRouteAnchor`, the
// stateless "which leg is the bus on" scan with its candidate window, its
// `last_stop_id` exclusion and its direction filter — was retired on
// 2026-09-06 with the rest of the legacy arithmetic: the ring estimator
// (web/src/eta/) answers that question from a posterior over the polyline
// (`resolveAnchorIndex` in liveAnchor.ts reads its lead leg). The replays
// keep a copy as their counterfactual baseline: scripts/eta-replay/legacy/anchor.ts.

import { distanceToSegmentM, haversineMeters, traceStopLegs } from "./geo";
import type { LatLon } from "./geo";

// Drop buses whose GPS sits far from the route.
// TransLoc keeps reporting a bus when it's parked at a depot or
// deadheading between shifts — at the Hamden yard we see Red bus #122
// show up ~2 km north of the route, creating phantom arrivals and
// stranded pins on the minimap. 500 m is generous enough to tolerate
// routes that briefly drift off the stop-list geometry (shortcut
// turns, etc.) while rejecting anything that's genuinely off-route.
export const OFF_ROUTE_THRESHOLD_M = 500;

// "Far from the route" is measured against the route's road polyline when
// we have one, and only falls back to "far from every stop" when we don't.
// The stop test alone is wrong for routes with long stopless legs: Purple's
// Building 900 → LEPH hop is 6.7 km and Green's 81 → 26 is 8.2 km with no
// stop in between, so a bus honestly on the highway sat > 500 m from every
// stop for 50–60 % of its lap and vanished from the boards and planner
// (while the map, which does not filter, still drew it). Measured against
// the served `route_paths`: 51 % of Green's and 50 % of Purple's polyline
// fails the stop test; 0 % fails the polyline test by construction.
//
// The polylines arrive in the same `/api/buses` payload as the buses, so
// the shell registers them here once per poll rather than threading a new
// argument through every caller of `isBusOnRoute`.
let routePathsById: Record<string, readonly (readonly [number, number])[]> = {};

export function registerRoutePaths(
  paths: Record<string, readonly (readonly [number, number])[]> | null | undefined,
): void {
  routePathsById = paths ?? {};
}

/** The published polyline registered for a route, if any (read by the ring estimator, web/src/eta/). */
export function routePathFor(routeId: string | number): readonly (readonly [number, number])[] | undefined {
  return routePathsById[String(routeId)];
}

function distanceToPathM(bus: LatLon, path: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = { lat: path[i]![0], lon: path[i]![1] };
    const b = { lat: path[i + 1]![0], lon: path[i + 1]![1] };
    const d = distanceToSegmentM(bus, a, b);
    if (d < best) {
      best = d;
      if (best < OFF_ROUTE_THRESHOLD_M) break; // good enough — on route
    }
  }
  return best;
}

export function isBusOnRoute(
  bus: LatLon & { route_id?: number | string },
  stops: number[],
  stopCoords: Record<number, LatLon>,
): boolean {
  if (!bus.lat || !bus.lon) return true; // no GPS → don't filter
  const path = bus.route_id !== undefined ? routePathsById[String(bus.route_id)] : undefined;
  if (path && path.length >= 2) {
    return distanceToPathM(bus, path) < OFF_ROUTE_THRESHOLD_M;
  }
  let bestM2 = Infinity;
  for (const sid of stops) {
    const sc = stopCoords[sid];
    if (!sc) continue;
    const dlat = (bus.lat - sc.lat) * 111_000;
    const dlon = (bus.lon - sc.lon) * 84_000;
    const m2 = dlat * dlat + dlon * dlon;
    if (m2 < bestM2) bestM2 = m2;
    if (bestM2 < OFF_ROUTE_THRESHOLD_M * OFF_ROUTE_THRESHOLD_M) return true;
  }
  return bestM2 < OFF_ROUTE_THRESHOLD_M * OFF_ROUTE_THRESHOLD_M;
}
