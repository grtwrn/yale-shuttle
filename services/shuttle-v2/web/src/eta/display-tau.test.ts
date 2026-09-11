import { describe, expect, it } from "vitest";

import { DISPLAY_TAU } from "./index";

/**
 * τ IS PINNED BECAUSE IT WAS SWEPT, NOT BECAUSE NOBODY LOOKED.
 *
 * `DISPLAY_TAU` is the one product constant in the estimator: the quantile of
 * the arrival distribution the countdown shows. Raising it buys punctuality
 * at the cost of stranding riders, and the trade is NOT visible in any pooled
 * accuracy median — which is exactly how it nearly shipped.
 *
 * The sweep (`docs/display-quantile-sweep.md`, PR #165) found the aggregates
 * favouring 0.55–0.60, and then the paired rider simulator overturned them on
 * 2,001 identical Red waits: **τ = 0.55 cost 42% more strands (38 → 54) and
 * 42% more reversals (133 → 189)**, with more jumps and more drops. The
 * detector's own truth points the other way (0.45), and the hazard argument in
 * §3 of that doc puts the optimum below 0.35 unless a rider carries about four
 * minutes of slack — at which point it is exactly 0.50. Three different
 * arguments, and 0.5 is the only value none of them refuses.
 *
 * So this test is not asserting that 0.5 is optimal. It is asserting that
 * moving it is a MEASURED decision: change this number and you must re-run the
 * paired rider simulator (`rider-sim/run.ts` + `pair-by-route.mjs`), not a
 * median. Two other changes died at that same gate — τ = 0.55 at 4 fixed / 20
 * introduced, and per-route ROUTE_SCALE at 1 / 10 — after both looked good
 * pooled.
 *
 * The incident that prompted the sweep (344 Winchester showing ~4:48 against a
 * ~10 min typical stand) was NOT a τ problem: 667 s is the 0.95 knot of that
 * stop's own stand table, so the band carried it and no point estimate could.
 */
describe("the display quantile", () => {
  it("is the median, and moving it requires a paired rider-level measurement", () => {
    expect(DISPLAY_TAU).toBe(0.5);
  });

  it("is a probability, so the quantile arithmetic it feeds is defined", () => {
    expect(DISPLAY_TAU).toBeGreaterThan(0);
    expect(DISPLAY_TAU).toBeLessThan(1);
  });
});
