// Locating a bus on its route's stop sequence, and rejecting buses that aren't
// on the route at all. Extracted from TransitMap.tsx: this is the single most
// bug-prone piece of maths in the app (reports #27, #32, #37, #38 all landed
// here) and it deserves to be tested directly.

import { distanceToSegmentM, haversineMeters } from "./geo";
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

// Locate a bus on a route's stop sequence. First-principles algorithm:
//
//   1. Find all segments stops[i] → stops[i+1] within GPS_THRESHOLD_M
//      of the bus's actual GPS — these are plausible candidates.
//   2. If the feed provides last_stop_id and it's on the route, among
//      the candidates prefer the one with the shortest FORWARD
//      distance from last_stop_id. This disambiguates routes that
//      revisit the same vicinity twice (e.g., Red passes 130 Prospect
//      on both inbound and outbound legs) without letting the
//      feed override fresh GPS.
//   3. If no segment is within threshold (bus is genuinely off-route
//      or on a part of the route the stop list doesn't model), fall
//      back to the globally-nearest segment.
//
// Returns the starting-stop index of the segment. The downstream step
// loop treats this as "bus is currently on segment i → i+1" which is
// the correct mental model for both dwelling-at-stop and mid-segment
// cases.
export const ANCHOR_GPS_THRESHOLD_M = 150;

// --- which way is it going? -------------------------------------------------
//
// Steps 1–2 above are the whole algorithm on a plain loop, and they are not
// enough on an out-and-back. Green and Purple run out to West Campus and back
// along the same road, so the SAME coordinates belong to two legs at once —
// the outbound chord and the inbound chord, anti-parallel, both well inside
// GPS_THRESHOLD_M. A point-valued anchor must choose, and choosing wrong is
// not a small error: it puts the bus a full lap out of position. Measured on
// 2026-09-03's capture, the anchor is shown a lap wrong at 118 of 380 Purple
// departures and 104 of 383 Green ones. `last_stop_id` cannot break the tie —
// it lags at every arrival and was observed frozen at Orange / Willow for an
// entire 5 km I-95 run — and neither can distance: on that run the bus was
// 135 m from the outbound chord and 139 m from the inbound one.
//
// But a MOVING bus says which branch it is on, with no filter, no belief and
// no state beyond the last fix it actually moved to: across two distinct
// fixes, progress along the outbound chord rises and progress along the
// inbound chord falls. So when two candidate legs point opposite ways, the
// direction of travel decides between them and nothing else has to.
//
// A STATIONARY bus on a shared segment with no history is genuinely
// undecidable — the information is not in the feed — so this deliberately
// does nothing there rather than guess. `anchorGate.ts` holds the previous
// branch, which is the right answer in the absence of evidence.
//
// HOW MUCH OF THE PROBLEM THIS IS. Over the 2026-09-03 capture, counting the
// polls where two candidate legs within GPS_THRESHOLD_M run anti-parallel:
//
//   route   ambiguous polls   bus moving   within 100 m of a stop   direction decides
//   Green      55.2%             57.8%            58.8%                  76.8%
//   Purple     44.9%             42.0%            68.2%                  57.2%
//   Red        27.5%             42.9%            82.6%                  70.5%
//
// So the two folds are not one problem. Green's ambiguity is largely open
// road — the I-95 run, where the bus is moving and direction settles it three
// times in four. Purple's sits at station loops (333 Cedar, Buildings
// 400/600/800/900), where the bus is frozen on 58% of the ambiguous polls and
// direction can settle barely half. **Purple's remainder is the half this
// cannot fix**, and it is the half `docs/eta-estimator-design.md` says needs a
// distribution rather than a point. That is why the rider numbers below move
// Green further than Purple, and it is not a tuning failure.

/**
 * The feed publishes a new coordinate only once a bus has moved ~30 m (2 of
 * 33,118 distinct fixes moved less, whether 5 s or 20 s elapsed). So 30 m is
 * the smallest displacement that proves any movement at all — below it there
 * is no direction to read, only noise.
 */
export const ANCHOR_DIRECTION_MIN_M = 30;

/**
 * How much of a heading disagreement counts. cos ≥ +0.6 is "the bus is
 * travelling this leg's way" (within ~53°); cos ≤ −0.6 is "this leg runs
 * against the bus", more than 127° from the step. Everything between is
 * uninformative — a leg at right angles to the step says nothing, a leg
 * mid-turn even less — and is left alone.
 *
 * **0.6 is measured, and looser is worse.** Swept on the rider simulator
 * (8,327 paired waits, 2026-09-03 capture), strand share Green / Purple /
 * Red-holdout: master 32.3 / 29.5 / 18.0%, **0.6 → 27.4 / 27.1 / 18.2**,
 * 0.15 → 27.2 / 27.7 / 20.3, 0.0 → 24.3 / 30.2 / 20.7. Loosening keeps
 * helping Green and starts hurting Purple and Red, and it is clear why: on
 * Red 82.6% of the polls with two anti-parallel candidate legs are within
 * 100 m of a stop, where the "step" between two fixes is a bus shuffling at a
 * kerb rather than a bus travelling. At 127° only a genuine reversal passes,
 * which is the fold and nothing else.
 *
 * (A branch-lock count against the detector's own anchor prefers 0.0 on every
 * route — `scripts/eta-replay/branch-lock.ts`. It is the wrong instrument to
 * decide this on: it scores an index, and the rider reads a countdown.)
 */
export const ANCHOR_DIRECTION_COS = 0.6;

/**
 * The previous DISTINCT fix this bus reported — the other end of the step
 * whose direction is read. `anchorGate.ts` remembers it (`noteFix`); a caller
 * with no memory passes nothing and gets exactly the old behaviour.
 */
export type TravelHint = LatLon | null | undefined;

/**
 * Is the bus driving this leg's way? +1 with it, -1 against it, 0 no opinion —
 * the step is too short to be a step, the leg is broadside to it, or one of
 * the two has no length.
 *
 * Exported for `scripts/eta-replay/branch-lock.ts`, which counts how often the
 * anchor lands a lap out of position; nothing in the app calls it directly.
 */
export function legAgreement(
  legIdx: number,
  bus: LatLon,
  stops: number[],
  stopCoords: Record<number, LatLon>,
  travelFrom: TravelHint,
): 1 | 0 | -1 {
  const N = stops.length;
  if (!travelFrom || legIdx < 0 || legIdx >= N) return 0;
  if (haversineMeters(bus, travelFrom) < ANCHOR_DIRECTION_MIN_M) return 0;
  const a = stopCoords[stops[legIdx]!];
  const b = stopCoords[stops[(legIdx + 1) % N]!];
  if (!a || !b) return 0;
  const c = headingCos(travelFrom, bus, a, b);
  if (c === null) return 0;
  return c >= ANCHOR_DIRECTION_COS ? 1 : c <= -ANCHOR_DIRECTION_COS ? -1 : 0;
}

/** cos of the angle between a→b and prev→now, or null if either has no length. */
function headingCos(prev: LatLon, now: LatLon, a: LatLon, b: LatLon): number | null {
  // Local flat-earth frame: longitude degrees shrink by cos(lat), latitude
  // degrees do not, so both components are proportional to metres and the
  // ratio below is a true cosine.
  const scale = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const lx = (b.lon - a.lon) * scale, ly = b.lat - a.lat;
  const dx = (now.lon - prev.lon) * scale, dy = now.lat - prev.lat;
  const ln = Math.hypot(lx, ly), dn = Math.hypot(dx, dy);
  if (ln < 1e-12 || dn < 1e-12) return null;
  return (lx * dx + ly * dy) / (ln * dn);
}

export type AnchorBus = {
  lat: number;
  lon: number;
  last_stop_id?: number | undefined;
  at_stop_id?: number | undefined;
};

export function findRouteAnchor(
  bus: AnchorBus,
  stops: number[],
  stopCoords: Record<number, LatLon>,
  /** Where the bus was at its previous distinct fix, if the caller remembers. */
  travelFrom?: TravelHint,
): number {
  const N = stops.length;
  if (N === 0) return -1;

  // No GPS — fall back to feed's last_stop_id (or 0 if not on route).
  if (!bus.lat || !bus.lon) {
    const idx = bus.last_stop_id != null ? stops.indexOf(bus.last_stop_id) : -1;
    return idx >= 0 ? idx : 0;
  }

  // Distance to each segment.
  const dists: number[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = stopCoords[stops[i]];
    const b = stopCoords[stops[(i + 1) % N]];
    if (!a || !b) { dists[i] = Infinity; continue; }
    dists[i] = distanceToSegmentM(bus, a, b);
  }

  const lastIdx = bus.last_stop_id != null ? stops.indexOf(bus.last_stop_id) : -1;

  // Candidates within threshold, sorted by forward distance from
  // last_stop_id (if available) so a route that revisits a vicinity
  // twice picks the right leg. Distance tiebreaker for ties.
  let candidates: number[] = [];
  for (let i = 0; i < N; i++) {
    if (dists[i] < ANCHOR_GPS_THRESHOLD_M) candidates.push(i);
  }

  // Two candidates that run opposite ways are the fold. Drop the ones the bus
  // is demonstrably NOT travelling, but only when the step is long enough to
  // be a step at all and only when some other candidate agrees with it — a
  // move that contradicts every candidate is evidence about the candidates,
  // not a reason to have none.
  if (candidates.length > 1 && travelFrom) {
    const here = { lat: bus.lat, lon: bus.lon };
    const agree = candidates.map((i) => legAgreement(i, here, stops, stopCoords, travelFrom));
    if (agree.some((a) => a > 0)) {
      const kept = candidates.filter((_, k) => agree[k]! >= 0);
      if (kept.length > 0) candidates = kept;
    }
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
