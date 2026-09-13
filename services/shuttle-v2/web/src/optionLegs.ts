/**
 * WHICH WALK A CARD PRINTS — and the invariant that keeps a card's legs and
 * its headline the same trip.
 *
 * REPORT #108 (operator, 2026-09-12 18:45 ET, body: "This is horrible"). One
 * card, four legs reading 17 + 18 + 12 + 14 min, under a 73-minute total:
 * nothing on screen accounted for the missing half hour.
 *
 * Both numbers were honest on their own, which is why it survived. `planTrip`
 * measures the walk to the board stop from the origin the rider searched from.
 * The per-poll live recompute in TransitMap re-measures it from where the
 * rider is standing NOW (`effectiveWalkToSec`) and prices `waitSec` and
 * `totalSec` on that — so a rider who has walked the wrong way gets a total
 * built on a 46-minute walk while every chip still prints the planned 17.
 * Reproduced against production's own logged arrival list: the same card at a
 * 17-minute walk reads "in 35, 51 min", wait 18, total 57; at 46 it reads
 * "in 51, 35 min", wait 5, total 73 — the screenshot.
 *
 * So the option carries the walk its total was built from (`liveWalkToSec`),
 * and every site that prints or subtracts a walk reads it through here.
 *
 * WHY NOT JUST OVERWRITE `walkToSec`. Because `commuteSec`, `slowerThanWalk`,
 * `directPromotion` and the tier sort are all functions of it, and planner.ts
 * holds it constant for a given plan precisely so card ORDER cannot flicker on
 * GPS jitter. Overwriting it would reorder the list underneath a rider as they
 * walk. The walk the card PRINTS follows the rider; the walk the list is
 * ORDERED by does not.
 *
 * `legsAgreeWithTotal` is the property the rider actually relies on, and it is
 * asserted directly in the tests rather than inferred from the two numbers
 * separately: a card whose visible legs do not add up to its visible total is
 * broken however defensible each half is on its own.
 */

import type { TripOption } from "./planner";

/** The walk a display site must print: the one the total was priced on. */
export type WalkShown = Pick<TripOption, "walkToSec" | "liveWalkToSec">;

/** Everything a card puts on screen about the length of the trip. */
export type DisplayedLegs = WalkShown
  & Pick<TripOption, "waitSec" | "rideSec" | "walkFromSec" | "totalSec">;

/**
 * The walk to the board stop AS DISPLAYED. `liveWalkToSec` when the live
 * recompute set one (including 0 — a rider inside `AT_PLACE_M` is at the stop
 * and the chip must disappear, not print the walk they no longer have), else
 * the plan's own.
 */
export function displayWalkToSec(o: WalkShown): number {
  return o.liveWalkToSec ?? o.walkToSec;
}

/** What a rider adds up when they read the leg chips. */
export function legsSumSec(o: DisplayedLegs): number {
  return displayWalkToSec(o) + o.waitSec + o.rideSec + o.walkFromSec;
}

/**
 * Do the legs on the card add up to the total above them? True for every
 * option the live recompute produces, by construction — `totalSec` is built
 * from the same walk this module displays. Report #108 is exactly this
 * returning false.
 */
export function legsAgreeWithTotal(o: DisplayedLegs): boolean {
  return Math.abs(legsSumSec(o) - o.totalSec) < 1;
}
