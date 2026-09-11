import { describe, expect, it } from "vitest";
import { getOffAlertTitle } from "./rideAlert";

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
