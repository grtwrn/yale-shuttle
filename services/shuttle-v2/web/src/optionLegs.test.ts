import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { displayWalkToSec, legsAgreeWithTotal, legsSumSec } from "./optionLegs";
import type { DisplayedLegs } from "./optionLegs";
import { commuteSec } from "./planner";
import type { TripOption } from "./planner";
import { fmtWalk } from "./format";

const min = (m: number) => m * 60;

/**
 * THE REPORTED CARD (report #108, operator 2026-09-12 18:45 ET, "This is
 * horrible"), reconstructed from the diagnosis that was verified by simulation
 * against production's own logged arrival list:
 *
 *     walk 17m -> slot0 35 min, slot1 51 min, no banner, wait 18, total 57
 *     walk 46m -> slot0 51 min, slot1 35 min, banner #48, wait  5, total 73
 *
 * The rider had walked away from the board stop, so the live recompute priced
 * the trip on a 46-minute walk (hence wait 5 and total 73) while every chip on
 * the card still printed the 17-minute walk `planTrip` had measured from the
 * search origin. 17 + 5 + 12 + 10 = 44 min of legs under a 73-minute headline.
 */
const reported = (): TripOption & DisplayedLegs => ({
  mode: "shuttle", routeLabel: "Blue Day", color: "#4285F4",
  boardStopId: 48, alightStopId: 11, busName: "48",
  walkToSec: min(17),       // what planTrip measured from the search origin
  liveWalkToSec: min(46),   // what the live recompute PRICED
  waitSec: min(5), rideSec: min(12), walkFromSec: min(10),
  totalSec: min(46) + min(5) + min(12) + min(10),   // 73 min
  directWalkSec: min(80),
});

/** What every display site did before this fix — kept so the bug can be shown. */
const oldRule = (o: DisplayedLegs) => o.walkToSec + o.waitSec + o.rideSec + o.walkFromSec;

describe("the legs a rider reads add up to the total above them (report #108)", () => {
  it("prints the walk the total was PRICED on, not the one it was planned with", () => {
    const o = reported();
    expect(displayWalkToSec(o)).toBe(min(46));
    expect(fmtWalk(displayWalkToSec(o))).toBe("46 min");
    // The screenshot: the card said 17.
    expect(fmtWalk(o.walkToSec)).toBe("17 min");
  });

  it("THE INVARIANT: displayed walk + wait + ride + walkFrom == displayed total", () => {
    const o = reported();
    expect(legsSumSec(o)).toBe(o.totalSec);
    expect(legsAgreeWithTotal(o)).toBe(true);
    // And the defect, as the rider met it: four legs 29 minutes short of the
    // headline, with nothing on screen to explain the gap.
    expect(oldRule(o)).toBe(min(44));
    expect(o.totalSec - oldRule(o)).toBe(min(29));
  });

  it("holds for a rider who has reached the stop (AT_PLACE_M, walk 0)", () => {
    // A live walk of 0 must be DISPLAYED as 0 — the chip disappears — rather
    // than falling back to the plan's walk because 0 is falsy. `?? ` not `|| `.
    const o: DisplayedLegs = {
      ...reported(), liveWalkToSec: 0, waitSec: min(4),
      totalSec: 0 + min(4) + min(12) + min(10),
    };
    expect(displayWalkToSec(o)).toBe(0);
    expect(legsAgreeWithTotal(o)).toBe(true);
    // Pre-fix this card printed a 17-minute walk it no longer had, and its legs
    // overshot the total instead of undershooting it.
    expect(oldRule(o)).toBeGreaterThan(o.totalSec);
  });

  it("is the plan's own walk when there is no live recompute (future mode)", () => {
    const { liveWalkToSec: _drop, ...o } = reported();
    expect(displayWalkToSec(o)).toBe(min(17));
    expect(legsSumSec({ ...o, totalSec: min(44) })).toBe(min(44));
  });

  it("does NOT move the number the card list is ordered by", () => {
    // THE TRAP. commuteSec / slowerThanWalk / directPromotion / the tier sort
    // all read walkToSec, which planner.ts holds constant for a given plan so
    // card ORDER cannot flicker on GPS jitter. Overwriting it — the cheaper
    // fix — would reorder the list underneath a walking rider.
    const o = reported();
    expect(commuteSec(o)).toBe(min(17) + min(12) + min(10));
    const { liveWalkToSec: _drop, ...planned } = o;
    expect(commuteSec(o)).toBe(commuteSec(planned as TripOption));
  });
});

describe("TransitMap reads the priced walk at every site that prints one", () => {
  const src = readFileSync(new URL("./TransitMap.tsx", import.meta.url), "utf8");

  /**
   * The per-poll live recompute — the memo that rewrites waitSec/totalSec off
   * the rider's current position. Sliced out by source so the two assertions
   * below cannot be satisfied by some unrelated part of a 6.8k-line file.
   */
  const recompute = (() => {
    const a = src.indexOf("const options: TripOption[] | null = useMemo(");
    const b = src.indexOf("}, [stableOptions, tripTimeError, buses,");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    return src.slice(a, b);
  })();

  it("carries the priced walk out of BOTH live return sites", () => {
    // The dwelling-bus early return and the pickLiveArrival return.
    expect(recompute.split("liveWalkToSec: effectiveWalkToSec").length - 1).toBe(2);
  });

  it("never writes over walkToSec itself", () => {
    // planner.ts keeps it constant on purpose; an assignment here is the
    // flickering-card regression, not a simplification.
    expect(/\bwalkToSec:/.test(recompute)).toBe(false);
  });

  it("prints no walk chip from the planned walk", () => {
    expect(src).not.toContain("fmtWalk(o.walkToSec)");
    expect(src.split("fmtWalk(walkToShown)").length - 1).toBe(2);   // collapsed + expanded
  });

  it("subtracts the priced walk from the wait leg, not the planned one", () => {
    // waitLegText prints `eta - walk`; handed the planned walk it would print a
    // wait the card's own total disagrees with.
    expect(src).not.toContain("waitLegText(leadBand, busEtaLive, o.walkToSec");
    expect(src).toContain("waitLegText(leadBand, busEtaLive, walkToShown, o.waitSec)");
  });
});
