import { describe, expect, it } from "vitest";
import { pickupUncertainty } from "./pickupUncertainty";
const now = Date.parse("2026-09-10T19:51:45.853Z");
describe("pickup position uncertainty", () => {
  it("explains the recorded Gold hold even though stationary was false", () => {
    expect(pickupUncertainty("2026-09-10T19:41:45.853", now))
      .toBe("Bus position unchanged for 10 min. Pickup time is uncertain.");
  });
  it("accepts UTC and explicit offsets consistently", () => {
    expect(pickupUncertainty("2026-09-10T15:41:45.853-04:00", now))
      .toBe(pickupUncertainty("2026-09-10T19:41:45.853Z", now));
  });
  it("waits five minutes, then clears as soon as a new position arrives", () => {
    expect(pickupUncertainty(new Date(now - 299_999).toISOString(), now)).toBeNull();
    expect(pickupUncertainty(new Date(now - 300_000).toISOString(), now)).toContain("5 min");
    expect(pickupUncertainty(new Date(now).toISOString(), now)).toBeNull();
  });
  it("does not invent evidence from missing, invalid or future timestamps", () => {
    for (const t of [null, undefined, "", "invalid", new Date(now + 1000).toISOString()]) {
      expect(pickupUncertainty(t, now)).toBeNull();
    }
    expect(pickupUncertainty("2026-09-10T19:41:45Z", NaN)).toBeNull();
  });
});
