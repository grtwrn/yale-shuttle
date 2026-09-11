import { describe, expect, it } from "vitest";
import { getOffAlertTitle } from "./rideAlert";
import { formatRideEta } from "./format";

describe("an undismissed get-off prompt", () => {
  it("updates through the recorded Red approach instead of retaining two stops", () => {
    expect([2, 1, 0].map(getOffAlertTitle)).toEqual([
      "Get off in 2 stops", "Get off at the next stop", "Get off here",
    ]);
  });
  it("does not invent an imminent arrival without a nearby stop count", () => {
    expect(getOffAlertTitle(null)).toBeNull();
    expect(getOffAlertTitle(3)).toBeNull();
  });
});

describe("Red approach countdown wording", () => {
  it("keeps a sub-minute prediction distinct from the get-off instruction", () => {
    for (const eta of [0, 20, 59]) {
      expect(formatRideEta(eta)).toBe("<1 min");
      expect(getOffAlertTitle(1)).toBe("Get off at the next stop");
    }
    expect(getOffAlertTitle(0)).toBe("Get off here");
  });
  it("retains minute estimates outside the final minute", () => {
    expect(formatRideEta(60)).toBe("1 min");
    expect(formatRideEta(90)).toBe("1 min");
    expect(formatRideEta(110)).toBe("1 min");
    expect(formatRideEta(780)).toBe("13 min");
  });
});
