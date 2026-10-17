import { describe, expect, it } from "vitest";
import { getOffAlertTitle, getOffPromptTitle } from "./rideAlert";
import { formatRideEta } from "./format";

describe("an undismissed get-off prompt", () => {
  it("does not turn Blue #40's off-pole route anchor into an instruction to get off", () => {
    // Oct 15 rider samples, 16:10:25–16:11:25Z, replayed through the current
    // model and production SPA. The route count was zero at these distances.
    for (const metres of [185.4276196, 208.6503193, 172.6155635, 135.7331690, 162.3393489]) {
      expect(getOffAlertTitle(0, metres)).toBe("Watch for your stop");
      expect(getOffPromptTitle(0, metres)).toBe("Watch for your stop");
    }
    // An open prompt can move both ways without retaining an imperative.
    expect([185, 12, 162].map(m => getOffPromptTitle(0, m))).toEqual([
      "Watch for your stop", "Get off here", "Watch for your stop",
    ]);
  });
  it("requires finite nearby GPS distance for 'here', retaining early reminders", () => {
    for (const metres of [null, NaN, Infinity, -1, 75.001]) {
      expect(getOffAlertTitle(0, metres)).toBe("Watch for your stop");
    }
    expect(getOffAlertTitle(0)).toBe("Watch for your stop");
    for (const metres of [0, 12, 75]) expect(getOffAlertTitle(0, metres)).toBe("Get off here");
    expect(getOffAlertTitle(1, 200)).toBe("Get off at the next stop");
    expect(getOffAlertTitle(2, 200)).toBe("Get off in 2 stops");
  });
  it("updates through the recorded Red approach instead of retaining two stops", () => {
    expect([2, 1, 0].map(count => getOffAlertTitle(count, 0))).toEqual([
      "Get off in 2 stops", "Get off at the next stop", "Get off here",
    ]);
  });
  it("does not invent an imminent arrival without a nearby stop count", () => {
    expect(getOffAlertTitle(null)).toBeNull();
    expect(getOffAlertTitle(3)).toBeNull();
  });
  it("replaces an open instruction when current position is unavailable or farther away", () => {
    expect([2, 1, 0, null, 5, 1].map(count => getOffPromptTitle(count, 0))).toEqual([
      "Get off in 2 stops", "Get off at the next stop", "Get off here",
      "Live stop position unavailable", "Your stop is 5 stops away", "Get off at the next stop",
    ]);
    // Updating an existing prompt must not broaden the notification trigger.
    expect(getOffAlertTitle(null)).toBeNull();
    expect(getOffAlertTitle(5)).toBeNull();
  });
});

describe("Red approach countdown wording", () => {
  it("keeps a sub-minute prediction distinct from the get-off instruction", () => {
    for (const eta of [0, 20, 59]) {
      expect(formatRideEta(eta)).toBe("<1 min");
      expect(getOffAlertTitle(1)).toBe("Get off at the next stop");
    }
    expect(getOffAlertTitle(0, 0)).toBe("Get off here");
  });
  it("retains minute estimates outside the final minute", () => {
    expect(formatRideEta(60)).toBe("1 min");
    expect(formatRideEta(90)).toBe("1 min");
    expect(formatRideEta(110)).toBe("1 min");
    expect(formatRideEta(780)).toBe("13 min");
  });
});
