import { describe, expect, it } from "vitest";

import {
  isVerticalPull,
  PULL_RESISTANCE,
  PULL_THRESHOLD_PX,
  pullDistance,
  shouldRefresh,
} from "./pullToRefresh";

describe("pull-to-refresh gesture math", () => {
  it("damps finger travel so the pull feels elastic", () => {
    expect(pullDistance(100, 200)).toBe(100 * PULL_RESISTANCE);
  });

  it("never reports a negative pull for an upward drag", () => {
    expect(pullDistance(200, 100)).toBe(0);
  });

  it("needs real finger travel to trigger — threshold over damped distance", () => {
    const fingerPx = PULL_THRESHOLD_PX / PULL_RESISTANCE;
    expect(shouldRefresh(0, fingerPx - 1)).toBe(false);
    expect(shouldRefresh(0, fingerPx + 1)).toBe(true);
  });

  it("rejects mostly-horizontal drags as swipes, not pulls", () => {
    expect(isVerticalPull(100, 40)).toBe(false); // sideways swipe
    expect(isVerticalPull(10, 40)).toBe(true);   // clean pull
    expect(isVerticalPull(0, -20)).toBe(false);  // scrolling up
  });
});
