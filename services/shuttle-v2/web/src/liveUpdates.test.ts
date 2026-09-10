import { describe, expect, it } from "vitest";
import { liveUpdateMessage, LIVE_UPDATE_STALE_MS } from "./liveUpdates";

describe("live update notice", () => {
  it("allows initial loading and the normal hidden-tab poll interval", () => {
    expect(liveUpdateMessage(null, 1000, 2000, false)).toBeNull();
    expect(liveUpdateMessage(1000, 0, 31_000, false)).toBeNull();
  });
  it("distinguishes a failed first load from old predictions still on screen", () => {
    expect(liveUpdateMessage(null, 1000, 2000, true)).toContain("unavailable");
    expect(liveUpdateMessage(1000, 0, 2000, true)).toContain("may be out of date");
  });
  it("warns even when stalled requests never finish with an error", () => {
    expect(liveUpdateMessage(null, 1000, 1000 + LIVE_UPDATE_STALE_MS, false)).toContain("unavailable");
    expect(liveUpdateMessage(1000, 0, 1000 + LIVE_UPDATE_STALE_MS, false)).toContain("may be out of date");
  });
  it("clears immediately when fresh data resumes", () => {
    expect(liveUpdateMessage(1000, 0, 60_000, true)).not.toBeNull();
    expect(liveUpdateMessage(60_000, 0, 60_001, false)).toBeNull();
  });
});
