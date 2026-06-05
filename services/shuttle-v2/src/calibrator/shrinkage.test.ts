import { describe, expect, it } from "vitest";

import {
  confidenceHalfWidth,
  mean,
  median,
  percentile,
  shrink,
  variance,
} from "./shrinkage.js";

describe("shrink", () => {
  it("returns the prior with no samples", () => {
    const r = shrink({ samples: [], priorMean: 60, k: 10 });
    expect(r.mean).toBe(60);
    expect(r.n).toBe(0);
    expect(r.stddev).toBeGreaterThan(0); // minStddev floor
  });

  it("pulls the posterior toward the prior with few samples", () => {
    const r = shrink({ samples: [120], priorMean: 60, k: 10 });
    // 1 sample @ 120 + 10 pseudo-samples @ 60 → posterior = (120 + 600) / 11 ≈ 65.45
    expect(r.mean).toBeCloseTo(720 / 11, 4);
    expect(r.n).toBe(1);
  });

  it("converges to the sample mean as n grows large", () => {
    const samples = Array.from({ length: 200 }, () => 100);
    const r = shrink({ samples, priorMean: 60, k: 10 });
    // 200 @ 100, 10 pseudo @ 60 → (20000 + 600)/210 ≈ 98.1, very near 100.
    expect(r.mean).toBeGreaterThan(95);
    expect(r.mean).toBeLessThan(100);
  });

  it("handles zero-valued samples — the v1 falsy-skip bug", () => {
    // The v1 code did `if (avg && n >= MIN)` which silently dropped any
    // segment whose calibrated mean was exactly 0. This test pins the fix:
    // zeros are real data, not "missing".
    const r = shrink({ samples: [0, 0, 0], priorMean: 30, k: 10 });
    // (3*0 + 10*30) / 13 ≈ 23.08
    expect(r.mean).toBeCloseTo(300 / 13, 4);
    expect(r.n).toBe(3);
  });

  it("floors stddev so confidence intervals stay sane", () => {
    // Two identical samples → sample variance is 0 mathematically.
    const r = shrink({ samples: [50, 50], priorMean: 60, k: 10, minStddev: 7 });
    expect(r.stddev).toBe(7);
  });
});

describe("confidenceHalfWidth", () => {
  it("shrinks as the effective sample size grows", () => {
    const big = confidenceHalfWidth({ mean: 100, stddev: 20, n: 100 }, 10);
    const small = confidenceHalfWidth({ mean: 100, stddev: 20, n: 1 }, 10);
    expect(big).toBeLessThan(small);
  });
});

describe("stats helpers", () => {
  it("computes mean / variance / median / percentile", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(4.571428, 4);
    expect(median([1, 2, 3, 4, 5])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBeCloseTo(9.55, 2);
  });

  it("handles empty inputs without throwing", () => {
    expect(mean([])).toBe(0);
    expect(variance([])).toBe(0);
    expect(median([])).toBe(0);
    expect(percentile([], 0.5)).toBe(0);
  });
});
