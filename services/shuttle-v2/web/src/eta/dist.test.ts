import { describe, expect, it } from "vitest";
import { cdf, fromQuantiles, lognormalMeanSd, median, point, quantile, residual, residualMedian, scaled, shrinkToward, TAIL_P } from "./dist";
import { remainingStandSec } from "../hopPricing";

// Red stop 11 (344 Winchester), the served stand table on 2026-09-04.
const Q11 = [83, 129, 145, 191, 288, 333, 437, 473, 543, 674];

describe("dist: a quantile vector is a CDF", () => {
  it("interpolates the served knots and is monotone", () => {
    const d = fromQuantiles(Q11);
    expect(cdf(d, 0)).toBe(0);
    expect(cdf(d, 83)).toBeCloseTo(0.05, 6);
    expect(cdf(d, 333)).toBeCloseTo(0.55, 6);
    let prev = -1;
    for (let x = 0; x < 2000; x += 7) {
      const f = cdf(d, x);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
    expect(cdf(d, 1e6)).toBeCloseTo(1, 6);
  });

  it("quantile inverts cdf", () => {
    const d = fromQuantiles(Q11);
    for (const p of [0.05, 0.2, 0.5, 0.8, 0.95, 0.999]) {
      expect(cdf(d, quantile(d, p))).toBeCloseTo(p, 4);
    }
    expect(quantile(d, 0.55)).toBeCloseTo(333, 6);
  });

  it("keeps pass mass at zero as a jump", () => {
    const d = fromQuantiles([0, 0, 0, 15, 20, 25, 30, 40, 55, 90]);
    expect(cdf(d, 0)).toBeCloseTo(0.25, 6);
    expect(quantile(d, 0.2)).toBe(0);
    expect(quantile(d, 0.26)).toBeGreaterThan(0);
  });

  it("closes one gap past the last knot and then carries a tail", () => {
    const d = fromQuantiles(Q11);
    // Knot at 674 + gap (131) = 805 carries TAIL_P.
    expect(cdf(d, 805)).toBeCloseTo(TAIL_P, 6);
    expect(quantile(d, 0.9999)).toBeGreaterThan(805);
  });
});

describe("dist: the residual given elapsed time", () => {
  it("matches hopPricing's conditional median at every elapsed r", () => {
    const d = fromQuantiles(Q11);
    for (const r of [0, 30, 100, 168, 240, 300, 420, 600, 700]) {
      const ours = residualMedian(d, r);
      const shipped = remainingStandSec(Q11, r);
      // Same knots, same interpolation, same closing gap: identical until the
      // tail, where hopPricing decays to zero and we keep an exponential tail.
      if (r < 674) expect(ours).toBeCloseTo(shipped, 3);
      else expect(ours).toBeGreaterThanOrEqual(shipped - 1e-9);
    }
  });

  it("never promises leaving now to a bus that out-sat the table", () => {
    const d = fromQuantiles(Q11);
    expect(residualMedian(d, 900)).toBeGreaterThan(30);
  });

  it("samples the residual with the right distribution", () => {
    const d = fromQuantiles(Q11);
    const f = residual(d, 200);
    expect(f(0)).toBeCloseTo(0, 9);
    expect(f(0.5)).toBeCloseTo(residualMedian(d, 200), 9);
    expect(f(0.9)).toBeGreaterThan(f(0.5));
  });
});

describe("dist: shrinkage, scaling, lognormal", () => {
  it("shrinks toward the prior with weight n/(n+k)", () => {
    const emp = fromQuantiles(Q11);
    const prior = fromQuantiles([0, 15, 17, 20, 24, 29, 35, 44, 60, 95]);
    const half = shrinkToward(emp, prior, 8, 8);
    for (const x of [20, 100, 300, 500]) {
      expect(cdf(half, x)).toBeCloseTo(0.5 * cdf(emp, x) + 0.5 * cdf(prior, x), 3);
    }
    expect(shrinkToward(emp, prior, 10_000, 8)).toBe(emp);
    expect(shrinkToward(emp, prior, 0, 8)).toBe(prior);
  });

  it("scales a drive by the fraction of the leg left", () => {
    const d = fromQuantiles([10, 12, 14, 15, 16, 17, 20, 22, 25, 30]);
    expect(median(scaled(d, 0.5))).toBeCloseTo(median(d) * 0.5, 6);
    expect(median(scaled(d, 0))).toBe(0);
  });

  it("builds a lognormal with the requested moments, roughly", () => {
    const d = lognormalMeanSd(100, 30);
    const m = median(d);
    expect(m).toBeGreaterThan(85);
    expect(m).toBeLessThan(100);
    expect(quantile(d, 0.9)).toBeGreaterThan(130);
  });

  it("a point mass", () => {
    const d = point(42);
    expect(quantile(d, 0.1)).toBe(42);
    expect(quantile(d, 0.9)).toBe(42);
  });
});
