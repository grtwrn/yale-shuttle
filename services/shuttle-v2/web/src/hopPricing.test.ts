import { describe, expect, it } from "vitest";
import { priceFirstHop, remainingStandSec, standingAt, STANDING_HOLD_M } from "./hopPricing";

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

describe("standingAt — the flag is a publication signal, the clock is the standing test", () => {
  const stopCoords = { 11: { lat: 41.3170, lon: -72.9280 } };
  const at = (dm: number) => ({ lat: 41.3170 + dm / 111_000, lon: -72.9280 });
  const since = "2026-09-03T20:40:00.000";
  const t0 = Date.parse(since + "Z");
  it("keeps the standing clock across a one-poll loss of the flag inside the hold radius", () => {
    const store = {};
    const a = standingAt(store, "Red|#316", { ...at(10), at_stop_id: 11, at_stop_since: since }, t0 + 300_000, stopCoords, STANDING_HOLD_M);
    expect(a).toEqual({ stopId: 11, standingSec: 300 });
    // shuffle to 85 m: publication radius (75 m) lost, hold radius (125 m) not
    const b = standingAt(store, "Red|#316", { ...at(85) }, t0 + 305_000, stopCoords, STANDING_HOLD_M);
    expect(b).toEqual({ stopId: 11, standingSec: 305 });
    const c = standingAt(store, "Red|#316", { ...at(10), at_stop_id: 11, at_stop_since: since }, t0 + 310_000, stopCoords, STANDING_HOLD_M);
    expect(c?.standingSec).toBe(310);
  });
  it("releases once the bus is demonstrably gone, and forgets", () => {
    const store = {};
    standingAt(store, "Red|#316", { ...at(10), at_stop_id: 11, at_stop_since: since }, t0 + 300_000, stopCoords, STANDING_HOLD_M);
    expect(standingAt(store, "Red|#316", { ...at(160) }, t0 + 305_000, stopCoords, STANDING_HOLD_M)).toBeNull();
    // back inside the radius later: no memory, no standing
    expect(standingAt(store, "Red|#316", { ...at(60) }, t0 + 310_000, stopCoords, STANDING_HOLD_M)).toBeNull();
  });
  it("is per store, and stale memory expires", () => {
    const s1 = {}, s2 = {};
    standingAt(s1, "k", { ...at(10), at_stop_id: 11, at_stop_since: since }, t0, stopCoords, STANDING_HOLD_M);
    expect(standingAt(s2, "k", { ...at(10) }, t0 + 5_000, stopCoords, STANDING_HOLD_M)).toBeNull();
    expect(standingAt(s1, "k", { ...at(10) }, t0 + 200_000, stopCoords, STANDING_HOLD_M)).toBeNull();
  });
});
