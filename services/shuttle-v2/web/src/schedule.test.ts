import { afterEach, describe, expect, it, vi } from "vitest";

import {
  etDayAndMinutes, fmtSchedule, fmtScheduleDays, fmtScheduleTime,
  isBusInService, isRouteActiveAt, nextActiveWindow, SERVICE_GRACE_MS,
} from "./schedule";
import { makeBus } from "./__fixtures__/payload";

// 2026-08-31T20:30:00Z is Monday 16:30 in America/New_York (EDT, UTC-4).
// Blue Day runs M–F 07:00–18:00 ET, so this instant is squarely IN service.
const MON_1630_ET = new Date("2026-08-31T20:30:00Z");

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
  vi.resetModules();
  vi.useRealTimers();
});

describe("etDayAndMinutes", () => {
  it("reads the Eastern wall clock, not the device clock", () => {
    expect(etDayAndMinutes(MON_1630_ET)).toEqual({ day: 1, mins: 16 * 60 + 30 });
  });

  // The schedule is published in ET. Reading it with getDay()/getHours() gave
  // the DEVICE's timezone, so a phone left on UTC (or any visitor still on
  // their home zone) mapped ET afternoon into the overnight window and the app
  // announced "No shuttles running right now" while shuttles drove past the
  // window. Every one of these zones must still resolve to Monday 16:30 ET.
  const zones = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati", "Europe/London"];
  for (const tz of zones) {
    it(`resolves America/New_York under TZ=${tz}`, async () => {
      process.env.TZ = tz;
      vi.resetModules();
      const mod = await import("./schedule");
      expect(mod.etDayAndMinutes(MON_1630_ET)).toEqual({ day: 1, mins: 16 * 60 + 30 });
      expect(mod.isRouteActiveAt("Blue Day", MON_1630_ET)).toBe(true);
    });
  }

  it("proves the device clock WOULD have been wrong (the actual bug)", () => {
    process.env.TZ = "UTC";
    // What the old device-local code saw: Monday 20:30 — past Blue Day's
    // 18:00 close, i.e. "not running".
    expect(MON_1630_ET.getDay()).toBe(1);
    expect(MON_1630_ET.getHours() * 60 + MON_1630_ET.getMinutes()).toBe(20 * 60 + 30);
    // And what the ET-anchored reader sees instead.
    expect(etDayAndMinutes(MON_1630_ET).mins).toBe(16 * 60 + 30);
    expect(isRouteActiveAt("Blue Day", MON_1630_ET)).toBe(true);
  });

  it("crosses the ET date boundary correctly", () => {
    // 04:30 UTC on Tuesday is still Tuesday 00:30 ET (UTC-4), i.e. the ET day
    // rolls over four hours after UTC does.
    expect(etDayAndMinutes(new Date("2026-09-01T04:30:00Z"))).toEqual({ day: 2, mins: 30 });
    // 03:30 UTC on Tuesday is Monday 23:30 ET — the day must roll BACK.
    expect(etDayAndMinutes(new Date("2026-09-01T03:30:00Z"))).toEqual({ day: 1, mins: 23 * 60 + 30 });
  });
});

describe("isRouteActiveAt", () => {
  it("honours a same-day window", () => {
    expect(isRouteActiveAt("Blue Day", MON_1630_ET)).toBe(true);
    // Monday 06:30 ET — before the 07:00 open.
    expect(isRouteActiveAt("Blue Day", new Date("2026-08-31T10:30:00Z"))).toBe(false);
    // Monday 18:00 ET — endMin is exclusive.
    expect(isRouteActiveAt("Blue Day", new Date("2026-08-31T22:00:00Z"))).toBe(false);
  });

  it("keeps weekend-only routes off on weekdays", () => {
    expect(isRouteActiveAt("Blue Weekend", MON_1630_ET)).toBe(false);
    // Saturday 2026-09-05, 12:00 ET.
    expect(isRouteActiveAt("Blue Weekend", new Date("2026-09-05T16:00:00Z"))).toBe(true);
  });

  it("handles overnight windows on both sides of midnight", () => {
    // Blue Night: daily 18:00 → 25:00 (i.e. 01:00 next day).
    // Monday 23:00 ET — same-day portion.
    expect(isRouteActiveAt("Blue Night", new Date("2026-09-01T03:00:00Z"))).toBe(true);
    // Tuesday 00:30 ET — previous-day portion of Monday's window.
    expect(isRouteActiveAt("Blue Night", new Date("2026-09-01T04:30:00Z"))).toBe(true);
    // Tuesday 02:00 ET — past the 01:00 end.
    expect(isRouteActiveAt("Blue Night", new Date("2026-09-01T06:00:00Z"))).toBe(false);
  });

  it("never filters a route with no published schedule", () => {
    expect(isRouteActiveAt("Route That Does Not Exist", MON_1630_ET)).toBe(true);
  });
});

describe("isBusInService", () => {
  const blueDayBus = makeBus({ route_id: 1, lat: 41.31, lon: -72.93 });
  const blueWeekendBus = makeBus({ route_id: 4, lat: 41.31, lon: -72.93 });

  it("keeps a bus inside its window", () => {
    expect(isBusInService(blueDayBus, MON_1630_ET.getTime())).toBe(true);
  });

  it("drops a ghost far outside its window (report #30)", () => {
    // Blue Weekend is Sa/Su only; a Monday afternoon sighting is a parked
    // shuttle with its transponder left on.
    expect(isBusInService(blueWeekendBus, MON_1630_ET.getTime())).toBe(false);
  });

  // The filter DELETES buses from the map, planner and arrival boards alike,
  // so it fails wide: ±90 min of grace around the published window.
  it("keeps a bus within SERVICE_GRACE_MS of the window", () => {
    // Monday 18:45 ET — 45 min past Blue Day's close, inside the grace.
    const justAfter = new Date("2026-08-31T22:45:00Z").getTime();
    expect(isRouteActiveAt("Blue Day", new Date(justAfter))).toBe(false);
    expect(isBusInService(blueDayBus, justAfter)).toBe(true);
    // Monday 20:00 ET — two hours past close, beyond the grace.
    const wellAfter = justAfter + SERVICE_GRACE_MS;
    expect(isBusInService(blueDayBus, wellAfter)).toBe(false);
  });

  it("never filters a route id it has no label for", () => {
    expect(isBusInService(makeBus({ route_id: 999, lat: 41.31, lon: -72.93 }), MON_1630_ET.getTime()))
      .toBe(true);
  });
});

describe("nextActiveWindow", () => {
  it("finds the next opening of a weekend route from a weekday", () => {
    const next = nextActiveWindow("Blue Weekend", MON_1630_ET);
    expect(next).not.toBeNull();
    // Blue Weekend opens 08:00 ET on Saturday 2026-09-05.
    expect(etDayAndMinutes(next!)).toEqual({ day: 6, mins: 8 * 60 });
    expect(next!.getTime()).toBeGreaterThan(MON_1630_ET.getTime());
  });

  it("returns null for a route with no schedule", () => {
    expect(nextActiveWindow("Route That Does Not Exist", MON_1630_ET)).toBeNull();
  });

  it("skips today's window once it has already opened", () => {
    // At Monday 16:30 ET, Blue Day's 07:00 opening is past — the answer must
    // be Tuesday, not a time in the past.
    const next = nextActiveWindow("Blue Day", MON_1630_ET);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(MON_1630_ET.getTime());
    expect(etDayAndMinutes(next!)).toEqual({ day: 2, mins: 7 * 60 });
  });
});

describe("schedule formatting", () => {
  it("formats times without a stray :00 and handles past-midnight windows", () => {
    expect(fmtScheduleTime(7 * 60)).toBe("7a");
    expect(fmtScheduleTime(5 * 60 + 40)).toBe("5:40a");
    expect(fmtScheduleTime(12 * 60)).toBe("12p");
    expect(fmtScheduleTime(18 * 60)).toBe("6p");
    expect(fmtScheduleTime(25 * 60)).toBe("1a");
  });

  it("collapses common day sets", () => {
    expect(fmtScheduleDays([1, 2, 3, 4, 5])).toBe("M–F");
    expect(fmtScheduleDays([0, 6])).toBe("Sa/Su");
    expect(fmtScheduleDays([0, 1, 2, 3, 4, 5, 6])).toBe("Daily");
    expect(fmtScheduleDays([2, 4])).toBe("Tu/Th");
  });

  it("renders a whole route schedule", () => {
    expect(fmtSchedule("Blue Weekend")).toBe("Sa/Su 8a–6p");
    expect(fmtSchedule("Red")).toBe("M–F 5:40a–7p");
    expect(fmtSchedule("Route That Does Not Exist")).toBe("");
  });
});
