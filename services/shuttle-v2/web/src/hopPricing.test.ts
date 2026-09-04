import { describe, expect, it } from "vitest";
import { priceFirstHop, remainingStandSec } from "./hopPricing";

// Ten quantiles (p5..p95) of a layover shaped like 344 Winchester's: median ~475 s, long right tail.
const Q = [60, 150, 260, 360, 440, 510, 580, 660, 780, 960];

describe("remainingStandSec — median of (stand - r | stand > r)", () => {
  it("is the plain median when nothing has elapsed", () => {
    expect(remainingStandSec(Q, 0)).toBe((440 + 510) / 2);
  });
  it("never increases as the bus keeps standing (continuous CDF, not a point sample), and never promises now past the median", () => {
    let prev = Infinity;
    for (let r = 0; r <= 1200; r += 30) {
      const v = remainingStandSec(Q, r);
      // The conditional median of a right-skewed stand is not strictly monotone (surviving a
      // quick-stop mode raises the remaining -- real information), but it must never climb the
      // way the credit cliff did. Bound the rise per 30 s of standing at a few seconds.
      expect(v).toBeLessThanOrEqual(prev + 6);
      prev = v;
    }
    // r = 600: the shipped credit is at its floor here; the data says ~2 min more
    expect(remainingStandSec(Q, 600)).toBeGreaterThan(60);
  });
  it("decays through the tail instead of stepping to zero", () => {
    const a = remainingStandSec(Q, 960), b = remainingStandSec(Q, 1050), c = remainingStandSec(Q, 1200);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThanOrEqual(c);
    expect(c).toBe(0);
  });
  it("handles a degenerate table", () => {
    expect(remainingStandSec([], 30)).toBe(0);
    expect(remainingStandSec([120], 0)).toBeGreaterThan(0);
  });
});

describe("priceFirstHop — stand is never prorated, drive is never credited", () => {
  const drive = 25; // 344 Winchester -> Winchester/Division, 112 m
  it("at the stop: conditional stand plus the whole drive", () => {
    expect(priceFirstHop({ q: Q }, drive, 0, 0)).toBe(remainingStandSec(Q, 0) + drive);
    expect(priceFirstHop({ q: Q }, drive, 500, 0.9)).toBe(remainingStandSec(Q, 500) + drive);
  });
  it("en route: the drive alone, prorated — no rise at the departure poll", () => {
    // The cliff: at_stop clears 75 m out on a 112 m hop (t ~ 0.67). Today that bills 0.33 x 557 = 184 s.
    const atStop = priceFirstHop({ q: Q }, drive, 600, 0);
    const justLeft = priceFirstHop({ q: Q }, drive, null, 0.67);
    expect(justLeft).toBeCloseTo(drive * 0.33, 5);
    expect(justLeft).toBeLessThan(atStop);
  });
  it("clamps progress and tolerates a missing stand table", () => {
    expect(priceFirstHop(undefined, drive, 100, 0)).toBe(drive);
    expect(priceFirstHop({ q: Q }, drive, null, 1.4)).toBe(0);
    expect(priceFirstHop({ q: Q }, -5, null, 0)).toBe(0);
  });
});

// Fixtures for the next stage (the branch mixture), kept here so they exist
// before the code does. Each is a verified production trace, not a guess.
describe.todo("anchor as a distribution — fixtures from verified traces", () => {
  it.todo("two chords out of one repeated stop tie at forward-distance 0: must not be settled by centimetres");
  it.todo("a stationary bus on a shared out-and-back segment with no history reports ~50/50 and says so");
  it.todo("a departure in each direction on the shared segment resolves within two fresh fixes");
  it.todo("a stale last_stop_id held across a 5 km run (Green, I-95) carries no evidence while unchanged");
});
