import { describe, expect, it } from "vitest";
import { planningTimeError } from "./planningTime";
const now = new Date("2026-09-10T10:00:30").getTime();
describe("planning time validation", () => {
  it("rejects a past choice rather than treating it as Now", () => {
    expect(planningTimeError("2026-09-10T08:00", now)).toBe("Choose a future time or tap Now.");
    expect(planningTimeError("2026-09-09T17:00", now)).not.toBeNull();
  });
  it("accepts the current minute, a future departure, and explicit Now", () => {
    for (const value of ["", "2026-09-10T10:00", "2026-09-10T17:00"]) {
      expect(planningTimeError(value, now)).toBeNull();
    }
  });
  it("rejects a value already in the past when selected", () => {
    expect(planningTimeError("2026-09-10T10:00", now + 90_000)).not.toBeNull();
  });
  it("rejects malformed restored values", () => {
    expect(planningTimeError("not a date", now)).toMatch(/valid departure time/);
  });
});
