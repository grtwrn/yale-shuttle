import { describe, expect, it } from "vitest";
import { driveAdequate, flooredStandSec, forgetStandFloor, MIN_DRIVE_SAMPLES, MIN_STAND_SAMPLES, priceFirstHop, remainingStandSec, standAdequate, standingAt, STANDING_HOLD_M } from "./hopPricing";

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

describe("sample adequacy — a thin cell is withheld, never blended", () => {
  it("stand needs an ascending table with >= MIN_STAND_SAMPLES behind it", () => {
    expect(standAdequate({ q: Q, qn: 24, n: 3 })).toBe(true);        // Red, 344 Winchester after one day
    expect(standAdequate({ q: Q, qn: 1, n: 40 })).toBe(false);       // a Green fold table
    expect(standAdequate({ q: Q, n: 19 })).toBe(false);              // no qn: falls back to n
    expect(standAdequate({ q: Q, n: 20 })).toBe(true);
    expect(standAdequate({ q: [300, 200, 400], qn: 50, n: 50 })).toBe(false); // not a quantile table
    expect(standAdequate({ q: [300], qn: 50, n: 50 })).toBe(false);
    expect(standAdequate({ med: 400, sd: 50, n: 400 } as any)).toBe(false);   // Building 750: no q at all
    expect(standAdequate(undefined)).toBe(false);
  });
  it("drive needs a non-negative value with >= MIN_DRIVE_SAMPLES behind it", () => {
    expect(driveAdequate({ drive: 25, driveN: 25, n: 2 })).toBe(true);
    expect(driveAdequate({ drive: 25, driveN: 9, n: 200 })).toBe(false);
    expect(driveAdequate({ drive: 25, n: 10 })).toBe(true);
    expect(driveAdequate({ drive: -1, driveN: 50, n: 50 })).toBe(false);
    expect(driveAdequate({ avg: 300, n: 50 } as any)).toBe(false);
  });
  it("thresholds are the documented ones", () => {
    expect(MIN_STAND_SAMPLES).toBe(20);
    expect(MIN_DRIVE_SAMPLES).toBe(10);
  });
});

// The live table the operator was watching on 2026-09-04: Red #310 standing at
// 344 Winchester (route 3, stop 11), qn = 34. Copied off the production payload.
const Q_WINCHESTER = [83, 129, 145, 191, 288, 333, 437, 473, 543, 674];

describe("flooredStandSec — a bus standing still may not push its own arrival later", () => {
  it("the RAW curve is continuous but rises: this is the defect, stated as a fixture", () => {
    // PR #99 interpolated the CDF, so there are no STEPS: no single second of
    // standing moves the remainder by a whole quantile. It still climbs.
    let prev = remainingStandSec(Q_WINCHESTER, 0);
    let biggestJump = 0, totalRise = 0;
    for (let r = 1; r <= 800; r++) {
      const v = remainingStandSec(Q_WINCHESTER, r);
      biggestJump = Math.max(biggestJump, Math.abs(v - prev));
      if (v > prev) totalRise += v - prev;
      prev = v;
    }
    expect(biggestJump).toBeLessThan(3);          // continuous — no quantile-sized step
    expect(totalRise).toBeGreaterThan(50);        // ...and yet it climbs 56.8 s over the hold
    // The two climbing stretches, named so a change to the CDF shows up here.
    expect(remainingStandSec(Q_WINCHESTER, 168)).toBeGreaterThan(remainingStandSec(Q_WINCHESTER, 107));
    expect(remainingStandSec(Q_WINCHESTER, 473)).toBeGreaterThan(remainingStandSec(Q_WINCHESTER, 456));
  });

  it("with a store, the remainder never climbs — over the whole hold, second by second", () => {
    const store = {};
    const t0 = 1_757_000_000_000;
    let prev = Infinity;
    for (let r = 0; r <= 800; r++) {
      const v = flooredStandSec(store, "Red|#310", 11, Q_WINCHESTER, r, t0 + r * 1000);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });

  it("holds flat rather than climbing, and resumes ticking when the raw curve catches up", () => {
    const store = {};
    const t0 = 1_757_000_000_000;
    const at = (r: number) => flooredStandSec(store, "Red|#310", 11, Q_WINCHESTER, r, t0 + r * 1000);
    for (let r = 0; r <= 107; r++) at(r);
    const held = at(107);
    expect(at(140)).toBe(held);                          // the raw curve is climbing here
    expect(at(168)).toBe(held);
    expect(at(240)).toBeLessThan(held);                  // and it comes back down honestly
    expect(at(240)).toBe(remainingStandSec(Q_WINCHESTER, 240));
  });

  it("costs at most the rise it removed — it is a clamp, not a discount", () => {
    const store = {};
    const t0 = 1_757_000_000_000;
    for (let r = 0; r <= 600; r += 5) {
      const v = flooredStandSec(store, "Red|#310", 11, Q_WINCHESTER, r, t0 + r * 1000);
      const raw = remainingStandSec(Q_WINCHESTER, r);
      expect(v).toBeLessThanOrEqual(raw);
      expect(raw - v).toBeLessThanOrEqual(60);
    }
  });

  it("a storeless caller is byte-identical to the raw curve", () => {
    for (const r of [0, 60, 120, 168, 300, 456, 473, 600, 900]) {
      expect(flooredStandSec(undefined, "Red|#310", 11, Q_WINCHESTER, r, 0)).toBe(remainingStandSec(Q_WINCHESTER, r));
    }
  });

  it("is per store, per vehicle and per stop — no ceiling is ever inherited", () => {
    const s1 = {}, s2 = {};
    const t0 = 1_757_000_000_000;
    for (let r = 0; r <= 168; r++) flooredStandSec(s1, "Red|#310", 11, Q_WINCHESTER, r, t0 + r * 1000);
    const held = flooredStandSec(s1, "Red|#310", 11, Q_WINCHESTER, 168, t0 + 168_000);
    expect(held).toBeLessThan(remainingStandSec(Q_WINCHESTER, 168));
    // another store (another rider's tab, a replay, a hypothetical)
    expect(flooredStandSec(s2, "Red|#310", 11, Q_WINCHESTER, 168, t0 + 168_000)).toBe(remainingStandSec(Q_WINCHESTER, 168));
    // another vehicle on the same store
    expect(flooredStandSec(s1, "Red|#316", 11, Q_WINCHESTER, 168, t0 + 168_000)).toBe(remainingStandSec(Q_WINCHESTER, 168));
    // the same vehicle at a different stop
    expect(flooredStandSec(s1, "Red|#310", 146, Q_WINCHESTER, 168, t0 + 168_000)).toBe(remainingStandSec(Q_WINCHESTER, 168));
  });

  it("a restarted hold clock starts a fresh ceiling", () => {
    const store = {};
    const t0 = 1_757_000_000_000;
    for (let r = 0; r <= 168; r++) flooredStandSec(store, "Red|#310", 11, Q_WINCHESTER, r, t0 + r * 1000);
    // the bus left, came back, and the clock is 20 s in again
    expect(flooredStandSec(store, "Red|#310", 11, Q_WINCHESTER, 20, t0 + 200_000)).toBe(remainingStandSec(Q_WINCHESTER, 20));
  });

  it("a stale entry is not carried across a gap in the polling", () => {
    const store = {};
    const t0 = 1_757_000_000_000;
    for (let r = 0; r <= 168; r++) flooredStandSec(store, "Red|#310", 11, Q_WINCHESTER, r, t0 + r * 1000);
    // 3 minutes with no poll at all: the ceiling is no longer evidence about this bus
    expect(flooredStandSec(store, "Red|#310", 11, Q_WINCHESTER, 350, t0 + 350_000)).toBe(remainingStandSec(Q_WINCHESTER, 350));
  });

  it("forgetStandFloor drops it, and tolerates a storeless caller", () => {
    const store = {};
    const t0 = 1_757_000_000_000;
    for (let r = 0; r <= 168; r++) flooredStandSec(store, "Red|#310", 11, Q_WINCHESTER, r, t0 + r * 1000);
    forgetStandFloor(store, "Red|#310");
    expect(flooredStandSec(store, "Red|#310", 11, Q_WINCHESTER, 168, t0 + 168_000)).toBe(remainingStandSec(Q_WINCHESTER, 168));
    expect(() => forgetStandFloor(undefined, "Red|#310")).not.toThrow();
  });
});

describe("priceFirstHop with a ceiling — the departure is untouched", () => {
  const drive = 25;
  const t0 = 1_757_000_000_000;
  const ctx = (store: object | undefined, r: number) => ({ store, key: "Red|#310", stopId: 11, now: t0 + r * 1000 });

  it("clamps the standing term and nothing else", () => {
    const store = {};
    for (let r = 0; r <= 168; r += 5) priceFirstHop({ q: Q_WINCHESTER }, drive, r, 0, ctx(store, r));
    const held = priceFirstHop({ q: Q_WINCHESTER }, drive, 168, 0, ctx(store, 168));
    expect(held).toBeLessThan(remainingStandSec(Q_WINCHESTER, 168) + drive);
    expect(held).toBeGreaterThanOrEqual(drive); // the drive is never credited away
  });

  it("5 -> 1 on an early departure: the ceiling never delays a real collapse", () => {
    const store = {};
    // stood through the climbing stretch, so a ceiling is definitely held
    for (let r = 0; r <= 168; r += 5) priceFirstHop({ q: Q_WINCHESTER }, drive, r, 0, ctx(store, r));
    const standing = priceFirstHop({ q: Q_WINCHESTER }, drive, 168, 0, ctx(store, 168));
    expect(standing).toBeGreaterThan(200);
    // the very next poll it is en route, two thirds of the way to the next stop
    const gone = priceFirstHop({ q: Q_WINCHESTER }, drive, null, 0.67, ctx(store, 173));
    expect(gone).toBeCloseTo(drive * 0.33, 5);
    // ...and the ceiling went with it, so the next hold starts clean
    expect(priceFirstHop({ q: Q_WINCHESTER }, drive, 168, 0, ctx(store, 400)))
      .toBe(remainingStandSec(Q_WINCHESTER, 168) + drive);
  });

  it("without a ceiling context it prices exactly as it did before", () => {
    for (const r of [0, 168, 300, 600]) {
      expect(priceFirstHop({ q: Q_WINCHESTER }, drive, r, 0))
        .toBe(remainingStandSec(Q_WINCHESTER, r) + drive);
    }
    expect(priceFirstHop({ q: Q_WINCHESTER }, drive, 100, 0, ctx(undefined, 100)))
      .toBe(remainingStandSec(Q_WINCHESTER, 100) + drive);
  });
});
