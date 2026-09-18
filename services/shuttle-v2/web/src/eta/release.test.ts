import { describe, expect, it } from "vitest";
import { quantile } from "./dist";
import {
  releaseDist,
  releaseFitOf,
  releaseResidual,
  type ReleaseFit,
} from "./release";
const fit: ReleaseFit = {
  stopId: 11,
  referenceLap: 3030,
  n: 102,
  days: 4,
  coefficients: [
    -4.8431815541, 1.1137968594, 0.24887738, 0.031191458, 0.061437861,
    1.394109687, 0.030911025, 1.280917789, -0.185989364,
  ],
};

describe("conditional layover release", () => {
  it("rejects unsupported cells, thin fits, malformed coefficients and absent laps", () => {
    expect(releaseFitOf(fit)).toBe(fit);
    for (const patch of [
      { stopId: 121 },
      { n: 2 },
      { days: 1 },
      { coefficients: [NaN] },
      { referenceLap: 0 },
    ]) {
      expect(releaseFitOf({ ...fit, ...patch })).toBeUndefined();
    }
    for (const lap of [undefined, NaN, 100, 10_000])
      expect(releaseDist(fit, 0, lap)).toBeNull();
  });
  it("conditions one survival curve without moving absolute quantiles backwards or capping a late bus", () => {
    const d = releaseDist(fit, Date.parse("2026-09-17T14:50:00Z"), 3000)!;
    for (const p of [0.1, 0.5, 0.9]) {
      let previous = quantile(d, p);
      for (let age = 5; age <= 2400; age += 5) {
        const absolute = age + releaseResidual(d, age)(p);
        expect(absolute).toBeGreaterThanOrEqual(previous - 1e-7);
        expect(Number.isFinite(absolute)).toBe(true);
        previous = absolute;
      }
    }
    expect(releaseResidual(d, 2400)(0.5)).toBeGreaterThan(0);
    expect(releaseDist(fit, 900_000, 3000)).toBe(releaseDist(fit, 0, 3000));
  });
});
