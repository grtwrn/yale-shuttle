// ── Cycling model ──────────────────────────────────────────────────────────
//
// New Haven is flat and small: for most campus pairs a bike beats both the
// walk and the shuttle, and a lot of riders own one. This module adds a
// BIKE row to the trip options, built exactly like the direct-walk row — an
// alternative to the whole trip, not a leg of one.
//
// There is deliberately no "bike to the stop, then ride": the Downtowner has
// no racks, so a bike cannot be combined with a shuttle. Bike is a complete
// answer or it is not offered.
//
// The numbers, and why they are what they are:
//
//   BIKE_SPEED_M_S = 4.0   ground pace, 14.4 km/h — a city average INCLUDING
//                          the lights, the crossings and the dismount at
//                          Cross Campus. Fit riders hit 20 km/h on open road;
//                          quoting that here would make every estimate a lie
//                          the first time someone rode it.
//   BIKE_DETOUR    = 1.25  street detour over crow-flies. Slightly worse than
//                          walking's 1.2: a bike is on the road network, so
//                          the footpath cut-throughs and plaza crossings a
//                          pedestrian takes are not available.
//   BIKE_OVERHEAD_SEC = 120  unlock and set off at one end, find a rack, park
//                          and lock at the other. Small, constant, and the
//                          reason a 400 m "bike" is not offered: without it
//                          the model would claim to save four minutes on a
//                          trip where the lock alone eats them.
//
// Structure mirrors walk.ts on purpose — effective rate over crow-flies, with
// the detour kept visible rather than folded away — so the two models can be
// read side by side. Unlike the walk model it has no server counterpart to
// stay in step with: `/api/plan` plans shuttles and walking only, so nothing
// can drift.

import { haversineMeters } from "./geo";
import type { LatLon } from "./geo";
import type { TripOption } from "./planner";
import { walkSecFromMeters } from "./walk";

/** Ground pace actually ridden, m/s (14.4 km/h — city average, with stops). */
export const BIKE_SPEED_M_S = 4.0;

/** Street-network detour multiplier over crow-flies distance. */
export const BIKE_DETOUR = 1.25;

/**
 * Effective riding rate over CROW-FLIES distance, m/s. Derived, not tuned —
 * it is whatever the two constants above require.
 */
export const BIKE_EFFECTIVE_M_S = BIKE_SPEED_M_S / BIKE_DETOUR;

/** Unlock + park + lock, seconds. Constant, paid once per trip. */
export const BIKE_OVERHEAD_SEC = 120;

/** Seconds in the saddle for `m` metres of crow-flies distance. */
export const bikeTravelSecFromMeters = (m: number) => (m * BIKE_DETOUR) / BIKE_SPEED_M_S;

/** Door-to-door seconds by bike, including the lock at both ends. */
export const bikeSecFromMeters = (m: number) => bikeTravelSecFromMeters(m) + BIKE_OVERHEAD_SEC;

/**
 * The bike must beat the direct walk by this much to be worth offering.
 * Below it the rider spends the saving on the lock and gets a bike to park at
 * the far end for their trouble — that is not an option, it is clutter. Five
 * minutes puts the floor at ~700 m crow-flies (an 11-minute walk).
 */
export const BIKE_MIN_SAVING_SEC = 5 * 60;

/**
 * Above this the ride stops being a campus trip (~8 km). The walk row has the
 * same kind of ceiling for the same reason; see WALK_ONLY_MAX_SEC. There is no
 * "unless it is the only option" carve-out here: unlike walking, a bike is not
 * a last resort every rider has.
 */
export const BIKE_MAX_SEC = 45 * 60;

/**
 * Teal, and deliberately not any route's colour: the bike row is not a shuttle
 * and must never read as one. Only the expanded map's line uses it — the
 * collapsed chip is outlined like the walk chip, which is what groups the two
 * self-powered options together visually.
 */
export const BIKE_COLOR = "#00796B";

/**
 * Label for the standalone row, used only when there is no walk row to join.
 * Option identity is the label, so it must not collide with a line.
 */
export const BIKE_LABEL = "Bike";

/**
 * The bike half of the self-powered row: what a rider needs to be told about
 * riding this trip, with the lock broken out because the row prints it.
 */
export type BikeLeg = {
  /** Door to door, including the lock at both ends. What the row ranks on. */
  totalSec: number;
  /** Seconds in the saddle. */
  travelSec: number;
  /** Unlock + park + lock. */
  overheadSec: number;
};

/**
 * The bike leg for this trip, or null when biking it is not worth suggesting
 * (too short to beat walking, or too far to be a campus errand).
 */
export function bikeLegFor(from: LatLon, to: LatLon): BikeLeg | null {
  const meters = haversineMeters(from, to);
  const totalSec = bikeSecFromMeters(meters);
  if (totalSec > BIKE_MAX_SEC) return null;
  if (walkSecFromMeters(meters) - totalSec < BIKE_MIN_SAVING_SEC) return null;
  return { totalSec, travelSec: bikeTravelSecFromMeters(meters), overheadSec: BIKE_OVERHEAD_SEC };
}

/**
 * `options` with the bike folded in, re-sorted by total time.
 *
 * The bike JOINS THE WALK ROW rather than taking a row of its own. Walking and
 * biking are the same answer to the same question — "get there yourself" — and
 * as two rows they could not even sit together: honest sorting puts a shuttle
 * between a 9-minute bike and a 22-minute walk, so the picker showed one kind
 * of answer in two places with an unrelated one wedged between them. One row
 * carrying both times reads as the single choice it actually is, and costs a
 * row of a list a rider is scanning on a phone.
 *
 * The merged row STAYS THE WALK: same `totalSec`, so it keeps the rank and the
 * headline time it had before a bike was ever attached. Ranking it on the bike
 * was tried first and is wrong — it puts a time on the top row that only a
 * rider who owns a bike can actually have, and every rider who does not owns
 * the walk. The bike is not buried by that: it sits on its own chip on the
 * same row, one tap from taking over the headline, and the row itself is never
 * hidden behind "show more" (see topVisibleOptions). Discoverable without
 * being presumed.
 *
 * When the walk row has been suppressed (a walk over an hour) there is nothing
 * to join, and the bike becomes a row of its own — which is exactly the trip
 * where it is worth the most: too far to walk, and under the 45-minute cap.
 *
 * Pure, and a no-op when disabled or when the trip does not warrant a bike, so
 * callers can apply it unconditionally.
 */
export function withBikeOption(
  options: TripOption[],
  from: LatLon,
  to: LatLon,
  enabled: boolean,
): TripOption[] {
  if (!enabled) return options;
  const bike = bikeLegFor(from, to);
  if (!bike) return options;
  const walkIdx = options.findIndex((o) => o.mode === "walk");
  const merged = walkIdx >= 0
    // `totalSec` is deliberately untouched: it is the row's rank AND its
    // headline, and both belong to the walk until the rider says otherwise.
    ? options.map((o, i) => (i === walkIdx ? { ...o, bike } : o))
    : [...options, {
        mode: "bike" as const,
        routeLabel: BIKE_LABEL,
        color: BIKE_COLOR,
        boardStopId: 0, alightStopId: 0,
        walkToSec: 0, waitSec: 0, rideSec: 0, walkFromSec: 0,
        totalSec: bike.totalSec, busName: "",
        directWalkSec: walkSecFromMeters(haversineMeters(from, to)),
        bike,
      }];
  return [...merged].sort((a, b) => a.totalSec - b.totalSec);
}
