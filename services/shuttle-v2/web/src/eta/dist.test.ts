import { describe, expect, it } from "vitest";
import { cdf, fromQuantiles, hazard, lognormalMeanSd, median, point, quantile, residual, residualMedian, scaled, shrinkToward } from "./dist";
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

  it("continues past the last knot at the last segment's hazard, with no forced closing knot", () => {
    const d = fromQuantiles(Q11);
    // Last segment 543 -> 674 takes S from 0.15 to 0.05: hazard ln 3 / 131 s.
    const h = Math.log(3) / 131;
    expect(hazard(d, 600)).toBeCloseTo(h, 6);
    expect(hazard(d, 900)).toBeCloseTo(h, 6);
    expect(quantile(d, 0.95)).toBeCloseTo(674, 6);
    // No saw-tooth: the residual median is smooth in r across the tail.
    let prev = residualMedian(d, 600);
    for (let r = 605; r <= 1200; r += 5) {
      const m = residualMedian(d, r);
      expect(Math.abs(m - prev)).toBeLessThan(3);
      prev = m;
    }
    expect(residualMedian(d, 900)).toBeCloseTo(Math.log(2) / h, 3);
  });
});

describe("dist: the residual given elapsed time", () => {
  it("agrees with hopPricing's conditional median to within the interpolation, and is smoother", () => {
    // Same knots; hopPricing joins them linearly in F, this joins them
    // log-linearly in S. They agree at the knots and differ inside segments.
    const d = fromQuantiles(Q11);
    for (const r of [0, 30, 100, 168, 240, 300, 420]) {
      const ours = residualMedian(d, r);
      const shipped = remainingStandSec(Q11, r);
      expect(Math.abs(ours - shipped)).toBeLessThan(45);
    }
    // The residual median never jumps between consecutive seconds of r.
    let prev = residualMedian(d, 0);
    for (let r = 1; r <= 800; r++) {
      const m = residualMedian(d, r);
      expect(Math.abs(m - prev), `at r=${r}`).toBeLessThan(6);
      prev = m;
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
      expect(cdf(half, x)).toBeCloseTo(0.5 * cdf(emp, x) + 0.5 * cdf(prior, x), 2);
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
