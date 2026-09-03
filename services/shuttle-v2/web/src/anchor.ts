// Locating a bus on its route's stop sequence, and rejecting buses that aren't
// on the route at all. Extracted from TransitMap.tsx: this is the single most
// bug-prone piece of maths in the app (reports #27, #32, #37, #38 all landed
// here) and it deserves to be tested directly.

import { distanceToSegmentM, traceStopLegs } from "./geo";
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
// argument through every caller of `isBusOnRoute` and `findRouteAnchor`.
let routePathsById: Record<string, readonly (readonly [number, number])[]> = {};

export function registerRoutePaths(
  paths: Record<string, readonly (readonly [number, number])[]> | null | undefined,
): void {
  routePathsById = paths ?? {};
  legCache.clear();
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

// The road each leg actually follows, sliced out of the route's published
// polyline by `traceStopLegs` (a chord where the polyline cannot supply the
// leg), computed once per route and reused for every bus on every poll.
//
// The legs of a route used to be measured as stop-to-stop CHORDS. That is
// fine downtown, where a leg is a block or two, and hopeless on the highway:
// Green's Orange/Bradley → Building 900 leg is an 8.2 km chord under a
// 14.4 km road that strays 1.6 km from it, and Purple's Union Station → West
// Haven leg strays 984 m. A bus on those roads was > 150 m from EVERY chord,
// so the scan fell through to "globally nearest", which ignores
// `last_stop_id` — and since Orange/Bradley (N) and (S) are 30 m apart, the
// outbound and return chords are the same line and the choice between them
// was a coin flip. Replayed over 69,228 production positions (7 h of
// 2026-09-02) the chord scan disagreed with the collector's position on 13 %
// of them, and those carried a median ETA error of 367 s against 99 s when
// it agreed.
type Leg = readonly LatLon[];
const legCache = new Map<string, Leg[] | null>();
const LEG_CACHE_MAX = 64;

function routeLegs(
  routeId: number | string,
  stops: number[],
  stopCoords: Record<number, LatLon>,
): Leg[] | null {
  const path = routePathsById[String(routeId)];
  if (!path || path.length < 2) return null;
  const key = `${routeId}|${stops.join(",")}`;
  const hit = legCache.get(key);
  if (hit !== undefined) return hit;
  let legs: Leg[] | null = null;
  const ll: LatLon[] = [];
  for (const sid of stops) {
    const c = stopCoords[sid];
    if (!c) break;
    ll.push(c);
  }
  if (ll.length === stops.length && ll.length >= 2) {
    ll.push(ll[0]!); // close the loop: the last leg runs back to the first stop
    const traced = traceStopLegs(path as [number, number][], ll);
    if (traced.length === stops.length) {
      legs = traced.map((t) => t.slice.map(([lat, lon]) => ({ lat, lon })));
    }
  }
  if (legCache.size >= LEG_CACHE_MAX) legCache.clear();
  legCache.set(key, legs);
  return legs;
}

/** Distance from the bus to the nearest point of a leg's road. */
function distanceToLegM(bus: LatLon, leg: Leg): number {
  let d = Infinity;
  for (let i = 0; i + 1 < leg.length; i++) {
    const m = distanceToSegmentM(bus, leg[i]!, leg[i + 1]!);
    if (m < d) d = m;
  }
  return d;
}

// Locate a bus on a route's stop sequence. First-principles algorithm:
//
//   1. Find all legs stops[i] → stops[i+1] within GPS_THRESHOLD_M of the
//      bus's actual GPS — these are plausible candidates. A leg is the road
//      the route's polyline follows between the two stops (see `routeLegs`),
//      or the chord when no polyline is registered for the route.
//   2. If the feed provides last_stop_id and it's on the route, among
//      the candidates prefer the one with the shortest FORWARD
//      distance from last_stop_id. This disambiguates routes that
//      revisit the same vicinity twice (e.g., Red passes 130 Prospect
//      on both inbound and outbound legs) without letting the
//      feed override fresh GPS.
//   3. If no leg is within threshold (bus is genuinely off-route
//      or on a part of the route the stop list doesn't model), fall
//      back to the globally-nearest leg.
//
// Returns the starting-stop index of the leg. The downstream step
// loop treats this as "bus is currently on leg i → i+1" which is
// the correct mental model for both dwelling-at-stop and mid-leg
// cases.
//
// Measured on the replay above, road legs alone take the overall median ETA
// error from 114.9 s to 111.9 s and leave the downtown routes unchanged, with
// NO change in anchor stability (multi-stop swings that snap back within a
// minute: 93 on master, 90 here). Two other ideas were measured and rejected:
// resolving the West Campus routes' repeated stop ids to the occurrence
// nearest the GPS makes things worse (116.6 s — a stale `last_stop_id`
// resolved to its later occurrence pulls the anchor onto the return leg), and
// filtering candidates by the feed's heading buys 2 s more but raises those
// multi-stop swings by 70 % on the downtown routes, because a leg's nearest
// segment can run the other way at a corner. Direction on a shared road is
// therefore still decided by forward order from `last_stop_id`, stale or not.
export const ANCHOR_GPS_THRESHOLD_M = 150;

export type AnchorBus = {
  lat: number;
  lon: number;
  last_stop_id?: number | undefined;
  at_stop_id?: number | undefined;
  /** Upstream route id — selects the polyline registered by `registerRoutePaths`. */
  route_id?: number | string | undefined;
};

export function findRouteAnchor(
  bus: AnchorBus,
  stops: number[],
  stopCoords: Record<number, LatLon>,
): number {
  const N = stops.length;
  if (N === 0) return -1;

  // No GPS — fall back to feed's last_stop_id (or 0 if not on route).
  if (!bus.lat || !bus.lon) {
    const idx = bus.last_stop_id != null ? stops.indexOf(bus.last_stop_id) : -1;
    return idx >= 0 ? idx : 0;
  }

  // Distance to each leg's road (or chord).
  const legs = bus.route_id != null ? routeLegs(bus.route_id, stops, stopCoords) : null;
  const dists: number[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = stopCoords[stops[i]];
    const b = stopCoords[stops[(i + 1) % N]];
    if (!a || !b) { dists[i] = Infinity; continue; }
    const leg = legs?.[i];
    dists[i] = leg && leg.length >= 2 ? distanceToLegM(bus, leg) : distanceToSegmentM(bus, a, b);
  }

  const lastIdx = bus.last_stop_id != null ? stops.indexOf(bus.last_stop_id) : -1;

  // Candidates within threshold, sorted by forward distance from
  // last_stop_id (if available) so a route that revisits a vicinity
  // twice picks the right leg. Distance tiebreaker for ties.
  const candidates: number[] = [];
  for (let i = 0; i < N; i++) {
    if (dists[i] < ANCHOR_GPS_THRESHOLD_M) candidates.push(i);
  }
  if (candidates.length > 0) {
    if (lastIdx >= 0) {
      candidates.sort((a, b) => {
        const fa = (a - lastIdx + N) % N;
        const fb = (b - lastIdx + N) % N;
        if (fa !== fb) return fa - fb;
        return dists[a] - dists[b];
      });
    } else {
      candidates.sort((a, b) => dists[a] - dists[b]);
    }
    return refineWithAtStop(candidates[0]);
  }

  // Nothing within threshold — bus is off-route-ish. Just pick
  // globally-nearest so downstream code still has a valid anchor.
  let bestIdx = 0;
  let bestD = dists[0];
  for (let i = 1; i < N; i++) {
    if (dists[i] < bestD) { bestD = dists[i]; bestIdx = i; }
  }
  return refineWithAtStop(bestIdx);

  // at_stop_id REFINES the GPS anchor; it must never contradict it. It used to
  // short-circuit the whole scan, which is how a bus appeared to travel
  // backwards: many routes pass two stops that sit almost on top of each other
  // but are far apart in sequence — Broadway/York and Elm/York are 23 m apart
  // yet 2 stops apart on Blue Weekend, and Orange/Pearl (N)/(S) are 35 m apart
  // yet 9 stops apart on Green. A few metres of GPS noise picked the wrong one
  // and threw the anchor a third of a loop (reports #37, #38; the same swing
  // drove the "6 min then 16 min" ETA in #32).
  //
  // So accept it only when the bus is really there AND it is the GPS anchor or
  // exactly one stop ahead — which still preserves report #27's fix, where the
  // segment scan lags one stop behind at a shared segment endpoint.
  function refineWithAtStop(gpsIdx: number): number {
    if (bus.at_stop_id == null) return gpsIdx;
    const ai = stops.indexOf(bus.at_stop_id);
    if (ai < 0) return gpsIdx;
    const sc = stopCoords[stops[ai]];
    if (!sc) return gpsIdx;
    const dlat = (bus.lat - sc.lat) * 111_000;
    const dlon = (bus.lon - sc.lon) * 84_000;
    const near = dlat * dlat + dlon * dlon < ANCHOR_GPS_THRESHOLD_M * ANCHOR_GPS_THRESHOLD_M;
    return near && (ai - gpsIdx + N) % N <= 1 ? ai : gpsIdx;
  }
}
