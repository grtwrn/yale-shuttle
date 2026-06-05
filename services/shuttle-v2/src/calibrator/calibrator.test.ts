import { describe, expect, it } from "vitest";

import { hourWindow } from "./calibrator.js";

describe("hourWindow", () => {
  it("returns a centered window inside the day", () => {
    expect(hourWindow(12, 1)).toEqual([11, 12, 13]);
    expect(hourWindow(12, 2)).toEqual([10, 11, 12, 13, 14]);
  });

  it("wraps midnight without losing samples — the v1 bug", () => {
    // The v1 code used `hour BETWEEN h-1 AND h+1` which excluded the wraparound,
    // so segments near midnight never collected enough data to advance past
    // the route-wide fallback. This is the regression test.
    expect(hourWindow(0, 1).sort((a, b) => a - b)).toEqual([0, 1, 23]);
    expect(hourWindow(23, 1).sort((a, b) => a - b)).toEqual([0, 22, 23]);
    expect(hourWindow(23, 2).sort((a, b) => a - b)).toEqual([0, 1, 21, 22, 23]);
  });
});
