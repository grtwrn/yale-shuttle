import { describe, expect, it } from "vitest";

import {
  BIKE_EFFECTIVE_M_S, BIKE_MIN_M, BIKE_ONLY_MAX_SEC, BIKE_SPEED_M_S,
  bikeSecFromMeters, bikeWorthOffering,
} from "./bike";
import { WALK_DETOUR, walkSecFromMeters } from "./walk";

describe("the cycling model", () => {
  it("measures the same geometry the walk model does", () => {
    // Both rates apply to CROW-FLIES distance with the street detour folded
    // in. If the bike ever measured the street network while the walk
    // measured the straight line, the bike would look ~20% better than it is
    // purely from the change of ruler — and the two rows sit next to each
    // other in the same ranked list.
    expect(BIKE_EFFECTIVE_M_S).toBeCloseTo(BIKE_SPEED_M_S / WALK_DETOUR, 10);
  });

  it("is a plausible campus pace, not a sprint", () => {
    // 15 km/h ground pace: fast enough to beat walking, slow enough to be
    // honest about lights, crossings and dismounts.
    expect(BIKE_SPEED_M_S * 3.6).toBeCloseTo(15.1, 0);
    for (const m of [500, 1_500, 4_300]) {
      const ratio = walkSecFromMeters(m) / bikeSecFromMeters(m);
      expect(ratio).toBeGreaterThan(2.5);
      expect(ratio).toBeLessThan(4);
    }
  });

  it("scales linearly with distance", () => {
    expect(bikeSecFromMeters(0)).toBe(0);
    expect(bikeSecFromMeters(3_500)).toBeCloseTo(bikeSecFromMeters(1_750) * 2, 6);
  });
});

describe("when a bike is worth offering", () => {
  it("skips trips too short to be worth unlocking a bike for", () => {
    expect(bikeWorthOffering(BIKE_MIN_M - 1)).toBe(false);
    expect(bikeWorthOffering(0)).toBe(false);
    expect(bikeWorthOffering(BIKE_MIN_M)).toBe(true);
  });

  it("skips a ride longer than an hour", () => {
    const justUnder = BIKE_ONLY_MAX_SEC * BIKE_EFFECTIVE_M_S - 1;
    expect(bikeWorthOffering(justUnder)).toBe(true);
    expect(bikeWorthOffering(justUnder + 10)).toBe(false);
  });

  it("covers the ordinary campus trip", () => {
    for (const m of [600, 1_200, 3_000, 6_000]) {
      expect(bikeWorthOffering(m)).toBe(true);
    }
  });
});
