import { describe, expect, it } from "vitest";

import { attachErrorText, MAX_EDGE_PX, scaleFor } from "./screenshot";

describe("scaleFor", () => {
  it("shrinks the longest edge to the cap", () => {
    expect(scaleFor(4032, 3024)).toBeCloseTo(MAX_EDGE_PX / 4032);
    expect(scaleFor(1170, 2532)).toBeCloseTo(MAX_EDGE_PX / 2532);
  });

  it("never enlarges a small screenshot", () => {
    expect(scaleFor(390, 844)).toBe(1);
    expect(scaleFor(10, 10)).toBe(1);
  });

  it("survives nonsense dimensions rather than producing NaN", () => {
    for (const [w, h] of [[0, 0], [-5, 10], [NaN, 100], [Infinity, 1]]) {
      const s = scaleFor(w as number, h as number);
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
    }
  });
});

describe("attachErrorText", () => {
  it("has wording for every failure the picker can produce", () => {
    expect(attachErrorText("not_an_image")).toMatch(/image/i);
    expect(attachErrorText("too_large")).toMatch(/large/i);
    expect(attachErrorText("unreadable")).toMatch(/read/i);
  });
});
