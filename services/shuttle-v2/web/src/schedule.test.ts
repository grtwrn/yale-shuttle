import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_FLAG_SETTLE_MIN, calendarAllows, etDayAndMinutes, etDayNumber, fmtSchedule, fmtScheduleDays, fmtScheduleTime, fmtWindows,
  isBusInService, isClosedOn, isRouteActiveAt, isRouteScheduledAt, isWindowActiveAt, nextActiveWindow, nextWindowStart,
  ROUTE_CALENDAR, ROUTE_HOURS, SERVICE_GRACE_MS, serviceStateAt,
} from "./schedule";
import { ROUTE_LISTS } from "./routes";
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
    // Blue Weekend opens 07:00 ET on Saturday 2026-09-05 (observed: the 07:00
    // hour was in service on all 13 Saturdays and all 13 Sundays sampled).
    expect(etDayAndMinutes(next!)).toEqual({ day: 6, mins: 7 * 60 });
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
    expect(fmtSchedule("Blue Weekend")).toBe("Sa/Su 7a–6p");
    expect(fmtSchedule("Red")).toBe("M–F 5:40a–7p");
    expect(fmtSchedule("Route That Does Not Exist")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Windows pinned against observed service.
//
// Every instant below is a real Eastern wall-clock time taken from the
// 2026-08-31 reconciliation of ROUTE_HOURS against 565,739 `arrivals` rows
// (2026-06-02 → 2026-08-31, 13 full weeks). "runs" times are hours that were
// in service on a majority of that weekday's service days; "dead" times are
// hours with essentially no arrivals in 90 days. These exist so that widening
// or narrowing a window is a deliberate act with a failing test attached.
// ---------------------------------------------------------------------------

// All of these dates fall inside EDT, so a literal -04:00 offset is exact and
// stays correct whatever TZ the test process runs under.
const et = (day: string, hh: number, mm = 0) =>
  new Date(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-04:00`);
const WED = "2026-09-02";   // Wednesday
const FRI = "2026-09-04";   // Friday
const SAT = "2026-09-05";   // Saturday
const SUN = "2026-09-06";   // Sunday

const OBSERVED: { label: string; runs: Date[]; dead: Date[] }[] = [
  // M–F 06:30–18:30 observed; the published 05:40–19:00 brackets it.
  { label: "Red",
    runs: [et(WED, 7), et(WED, 17)],
    dead: [et(WED, 3), et(SUN, 12)] },
  // M–F 07:00–18:00, sharp at both ends.
  { label: "Blue Day",
    runs: [et(WED, 7), et(WED, 17, 30)],
    dead: [et(WED, 6), et(WED, 3), et(SAT, 12)] },
  // 07:00 open, an hour earlier than the published 08:00.
  { label: "Blue Weekend",
    runs: [et(SAT, 7, 15), et(SUN, 7, 15), et(SAT, 17)],
    dead: [et(SAT, 3), et(WED, 12)] },
  // Evening routes: 18:00 → ~00:15, seven days a week.
  { label: "Blue Night",
    runs: [et(FRI, 22), et(SAT, 0, 30)],
    dead: [et(WED, 3), et(WED, 12)] },
  { label: "Blue West",
    runs: [et(FRI, 22), et(SAT, 0, 30)],
    dead: [et(WED, 3), et(WED, 12)] },
  { label: "Orange Night",
    runs: [et(WED, 21), et(WED, 0, 30)],
    dead: [et(WED, 3), et(WED, 12)] },
  { label: "Orange East",
    runs: [et(WED, 21), et(WED, 0, 30)],
    dead: [et(WED, 3), et(WED, 12)] },
  // M–F 06:35–18:15.
  { label: "Orange Day",
    runs: [et(WED, 7), et(WED, 17, 30)],
    dead: [et(WED, 3), et(SUN, 12)] },
  // ~05:50 open (not 05:00), and the 18:00 hour is full service, not a
  // straggler — it ran on 85–100 % of weekdays.
  { label: "Brown",
    runs: [et(WED, 6), et(WED, 18, 30)],
    dead: [et(WED, 3), et(WED, 5), et(SUN, 12)] },
  // 05:25–18:50. The 05:00 hour ran on 92–100 % of weekdays; the 04:00 hour
  // appeared on 2 days out of 65 and is deliberately NOT in the window.
  { label: "Pink",
    runs: [et(WED, 5, 30), et(WED, 18, 30)],
    dead: [et(WED, 4), et(WED, 3), et(SAT, 12)] },
  // Daily from 05:25; weekdays to ~19:15, weekends to ~18:35.
  { label: "Green",
    runs: [et(WED, 5, 30), et(WED, 19, 15), et(SUN, 6), et(SAT, 18)],
    dead: [et(WED, 3), et(WED, 21)] },
  // The all-day/all-evening route: 100 % occupancy 05:00–23:00 every day —
  // but zero arrivals after midnight in 90 days, so the window closes at 24:00.
  { label: "Purple",
    runs: [et(WED, 5, 30), et(WED, 23, 30), et(SUN, 12)],
    dead: [et(WED, 0, 30), et(WED, 3)] },
  // 08:00–17:45, flat across 13 weeks; 07:00 ran on ≤ 15 % of days.
  { label: "Gold",
    runs: [et(WED, 8), et(WED, 17, 30)],
    dead: [et(WED, 6, 30), et(WED, 3), et(SAT, 12)] },
  // Both grocery runs open at 07:00, not the published 10:00, and never run
  // on a weekday (0 arrivals, M–F, in 90 days).
  { label: "Grocery TJ",
    runs: [et(SAT, 7, 30), et(SUN, 15)],
    dead: [et(SAT, 3), et(WED, 12)] },
  { label: "Grocery Ham",
    runs: [et(SAT, 7, 30), et(SUN, 15)],
    dead: [et(SAT, 3), et(WED, 12)] },
];

describe("ROUTE_HOURS vs observed service", () => {
  it("has a window for every route the app can show", () => {
    for (const cfg of ROUTE_LISTS) expect(ROUTE_HOURS[cfg.label]).toBeDefined();
    // And no orphan windows keyed to a label that no longer exists.
    const labels = new Set(ROUTE_LISTS.map((c) => c.label));
    for (const label of Object.keys(ROUTE_HOURS)) expect(labels.has(label)).toBe(true);
  });

  for (const { label, runs, dead } of OBSERVED) {
    it(`${label}: active when it demonstrably runs`, () => {
      for (const t of runs) {
        const { day, mins } = etDayAndMinutes(t);
        expect(
          isRouteActiveAt(label, t),
          `${label} should be active on day ${day} at ${fmtScheduleTime(mins)} ET`,
        ).toBe(true);
      }
    });

    it(`${label}: inactive when it demonstrably does not`, () => {
      for (const t of dead) {
        const { day, mins } = etDayAndMinutes(t);
        expect(
          isRouteActiveAt(label, t),
          `${label} should be inactive on day ${day} at ${fmtScheduleTime(mins)} ET`,
        ).toBe(false);
      }
    });
  }

  // The dead-of-night sweep: nothing at all ran between 01:00 and 05:00 ET in
  // 90 days, and isBusInService — the function that DELETES buses from the map,
  // planner and arrival boards — must agree even after ±90 min of grace.
  it("shows no route at 03:00 ET, grace included", () => {
    const deadOfNight = et(WED, 3).getTime();
    for (const cfg of ROUTE_LISTS) {
      const bus = makeBus({ route_id: cfg.busRouteIds[0], lat: 41.31, lon: -72.93 });
      expect(isBusInService(bus, deadOfNight), `${cfg.label} at 03:00 ET`).toBe(false);
    }
  });

  // ...and the converse: every route must be visible during a slot the data
  // says it really runs, once grace is applied.
  it("shows every route during its own observed service", () => {
    const byLabel = new Map(ROUTE_LISTS.map((c) => [c.label, c.busRouteIds[0]] as const));
    for (const { label, runs } of OBSERVED) {
      const routeId = byLabel.get(label)!;
      const bus = makeBus({ route_id: routeId, lat: 41.31, lon: -72.93 });
      for (const t of runs) {
        expect(isBusInService(bus, t.getTime()), `${label} at ${t.toISOString()}`).toBe(true);
      }
    }
  });

  // Report #30 stays fixed: a weekday-only route seen on a Sunday afternoon is
  // a parked shuttle with a live transponder. Red logged 1 arrival across 13
  // Sundays; Pink, Brown and Gold logged none on any weekend day.
  it("still deletes the weekday-only ghosts (report #30)", () => {
    const sundayAfternoon = et(SUN, 17, 40).getTime();
    for (const label of ["Red", "Blue Day", "Orange Day", "Pink", "Brown", "Gold"]) {
      const routeId = ROUTE_LISTS.find((c) => c.label === label)!.busRouteIds[0];
      const bus = makeBus({ route_id: routeId, lat: 41.31, lon: -72.93 });
      expect(isBusInService(bus, sundayAfternoon), `${label} on a Sunday`).toBe(false);
    }
  });

  // Purple's old 01:00 close was a 65-minute ghost window every night. The
  // window now ends at midnight; grace still carries a genuinely late bus to
  // 01:30, and only after that does Purple disappear.
  it("closes Purple's overnight ghost window", () => {
    const purpleId = ROUTE_LISTS.find((c) => c.label === "Purple")!.busRouteIds[0];
    const bus = makeBus({ route_id: purpleId, lat: 41.31, lon: -72.93 });
    expect(isBusInService(bus, et(WED, 23, 50).getTime())).toBe(true);
    expect(isBusInService(bus, et(WED, 1, 0).getTime())).toBe(true);   // grace
    expect(isBusInService(bus, et(WED, 2, 0).getTime())).toBe(false);  // ghost
  });

  // Gold was narrowed (07:30, from a published 06:00 never once observed).
  // That narrowing must not be able to hide a bus that shows up at the old
  // published start — grace has to still reach it.
  it("keeps Gold visible back to its published 06:00 start", () => {
    const goldId = ROUTE_LISTS.find((c) => c.label === "Gold")!.busRouteIds[0];
    const bus = makeBus({ route_id: goldId, lat: 41.31, lon: -72.93 });
    expect(isRouteActiveAt("Gold", et(WED, 6))).toBe(false);
    expect(isBusInService(bus, et(WED, 6).getTime())).toBe(true);
  });

  // The grace is sized to the largest gap the corrected windows still leave:
  // Blue Day's Friday tail, observed out to 19:05 against an 18:00 close.
  it("covers Blue Day's observed Friday tail", () => {
    const blueDay = makeBus({ route_id: 1, lat: 41.31, lon: -72.93 });
    expect(SERVICE_GRACE_MS).toBeGreaterThanOrEqual(65 * 60 * 1000);
    expect(isRouteActiveAt("Blue Day", et(FRI, 19, 5))).toBe(false);
    expect(isBusInService(blueDay, et(FRI, 19, 5).getTime())).toBe(true);
  });
});

// The published-hours generalisations: ROUTE_HOURS is the gate riders are NOT
// shown; these take any window list, so the operator's parsed description
// (`/api/buses` `route_hours`) renders and is judged the same way.
describe("fmtWindows / isWindowActiveAt / nextWindowStart", () => {
  const redPublished = { days: [1, 2, 3, 4, 5], startMin: 7 * 60, endMin: 18 * 60, text: "7am - 6pm, M - F" };
  const nightPublished = { days: [0, 1, 2, 3, 4, 5, 6], startMin: 18 * 60, endMin: 24 * 60, text: "6pm - 12am, Daily" };

  it("renders published windows in the house style", () => {
    expect(fmtWindows([redPublished])).toBe("M–F 7a–6p");
    expect(fmtWindows([nightPublished])).toBe("Daily 6p–12a");
    expect(fmtWindows([{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 5 * 60 + 30, endMin: 23 * 60 + 45 }])).toBe("Daily 5:30a–11:45p");
    expect(fmtWindows([{ days: [0, 6], startMin: 7 * 60, endMin: 17 * 60 }])).toBe("Sa/Su 7a–5p");
    expect(fmtWindows([])).toBe("");
  });

  it("fmtSchedule is the same formatter over ROUTE_HOURS", () => {
    for (const label of Object.keys(ROUTE_HOURS)) {
      expect(fmtSchedule(label)).toBe(fmtWindows(ROUTE_HOURS[label]!));
    }
    // And the gate table really does disagree with what Yale publishes — the
    // reason the display was split off from it.
    expect(fmtSchedule("Red")).toBe("M–F 5:40a–7p");
    expect(fmtWindows([redPublished])).toBe("M–F 7a–6p");
  });

  it("judges an instant against the supplied windows, in ET", () => {
    // Wednesday 2026-09-02, 06:10 ET: inside the ROUTE_HOURS gate (05:40 open)
    // but before the published 07:00.
    const wed0610 = new Date("2026-09-02T06:10:00-04:00");
    const wed0710 = new Date("2026-09-02T07:10:00-04:00");
    expect(isRouteActiveAt("Red", wed0610)).toBe(true);
    expect(isWindowActiveAt([redPublished], wed0610)).toBe(false);
    expect(isWindowActiveAt([redPublished], wed0710)).toBe(true);
    // 12am end: 23:59 in, 00:00 out.
    expect(isWindowActiveAt([nightPublished], new Date("2026-09-02T23:59:00-04:00"))).toBe(true);
    expect(isWindowActiveAt([nightPublished], new Date("2026-09-03T00:00:00-04:00"))).toBe(false);
    expect(isWindowActiveAt([], wed0710)).toBe(false);
  });

  it("finds the next opening of the supplied windows", () => {
    const wed0610 = new Date("2026-09-02T06:10:00-04:00");
    expect(nextWindowStart([redPublished], wed0610)?.toISOString()).toBe(new Date("2026-09-02T07:00:00-04:00").toISOString());
    // Friday 19:00 → Monday 07:00.
    const fri1900 = new Date("2026-09-04T19:00:00-04:00");
    expect(nextWindowStart([redPublished], fri1900)?.toISOString()).toBe(new Date("2026-09-07T07:00:00-04:00").toISOString());
    expect(nextWindowStart([], wed0610)).toBeNull();
  });

  it("the ROUTE_HOURS wrappers are unchanged: identical answers to the generalisations", () => {
    const instants = [
      MON_1630_ET,
      new Date("2026-08-31T10:30:00Z"),
      new Date("2026-09-01T04:30:00Z"),
      new Date("2026-09-05T16:00:00Z"),
    ];
    for (const label of Object.keys(ROUTE_HOURS)) {
      for (const d of instants) {
        expect(isRouteActiveAt(label, d)).toBe(isWindowActiveAt(ROUTE_HOURS[label]!, d));
        expect(nextActiveWindow(label, d)?.getTime()).toBe(nextWindowStart(ROUTE_HOURS[label]!, d)?.getTime());
      }
    }
  });
});

// The two grocery lines alternate whole weekends. Yale publishes it: the "2026
// Grocery Shuttle Calendar" colours every weekend — Schedule #1 Trader Joe's,
// Schedule #2 Hamden, Dec 24–31 struck through — and the `arrivals` table
// agrees on every weekend 2026-06-13 → 2026-09-06 (13 of 13). On Sun
// 2026-09-06 10:28 ET the operator planned to Trader Joe's and read "Should
// be running now — no bus reporting yet" on a Hamden weekend.
describe("ROUTE_CALENDAR (the grocery lines' alternate weekends)", () => {
  // Saturdays of every Trader Joe's weekend on the published 2026 calendar.
  const TJ_2026 = [
    "2026-01-03", "2026-01-17", "2026-01-31", "2026-02-14", "2026-02-28", "2026-03-14", "2026-03-28",
    "2026-04-11", "2026-04-25", "2026-05-09", "2026-05-23", "2026-06-06", "2026-06-20", "2026-07-04",
    "2026-07-18", "2026-08-01", "2026-08-15", "2026-08-29", "2026-09-12", "2026-09-26", "2026-10-10",
    "2026-10-24", "2026-11-07", "2026-11-21", "2026-12-05", "2026-12-19",
  ];
  // Hamden weekends the calendar lists explicitly (the rest are "the others").
  const HAM_2026 = ["2026-09-05", "2026-09-19", "2026-10-03", "2026-10-17", "2026-10-31", "2026-11-14", "2026-11-28", "2026-12-12"];
  // What the arrivals table saw, Jun 13 → Sep 6.
  const TJ_SEEN = ["2026-06-20", "2026-07-04", "2026-07-18", "2026-08-01", "2026-08-15", "2026-08-29"];
  const HAM_SEEN = ["2026-06-13", "2026-06-27", "2026-07-11", "2026-07-25", "2026-08-08", "2026-08-22", "2026-09-05"];
  const sat = (iso: string, h = 10) => new Date(`${iso}T${String(h).padStart(2, "0")}:00:00-04:00`);
  const sun = (iso: string, h = 10) => new Date(sat(iso, h).getTime() + 86_400_000);
  const tj = ROUTE_CALENDAR["Grocery TJ"]!, ham = ROUTE_CALENDAR["Grocery Ham"]!;
  const TJ_WINS = ROUTE_HOURS["Grocery TJ"]!, HAM_WINS = ROUTE_HOURS["Grocery Ham"]!;
  const SUN_0906_1028 = new Date("2026-09-06T10:28:00-04:00");
  const SAT_0912_0700 = new Date("2026-09-12T07:00:00-04:00");

  it("reproduces the published 2026 calendar, both days of every weekend, for both lines", () => {
    for (const w of TJ_2026) {
      expect(calendarAllows(tj, sat(w)), `TJ on ${w}`).toBe(true);
      expect(calendarAllows(tj, sun(w)), `TJ on ${w}+1`).toBe(true);
      expect(calendarAllows(ham, sat(w)), `Ham off ${w}`).toBe(false);
      expect(calendarAllows(ham, sun(w)), `Ham off ${w}+1`).toBe(false);
    }
    for (const w of HAM_2026) {
      expect(calendarAllows(ham, sat(w)), `Ham on ${w}`).toBe(true);
      expect(calendarAllows(ham, sun(w)), `Ham on ${w}+1`).toBe(true);
      expect(calendarAllows(tj, sat(w)), `TJ off ${w}`).toBe(false);
      expect(calendarAllows(tj, sun(w)), `TJ off ${w}+1`).toBe(false);
    }
    // Every Saturday of 2026 outside the winter recess belongs to exactly one line.
    for (let d = sat("2026-01-03"); d.getTime() < sat("2026-12-24").getTime(); d = new Date(d.getTime() + 7 * 86_400_000)) {
      expect(calendarAllows(tj, d) !== calendarAllows(ham, d), d.toISOString()).toBe(true);
    }
  });

  it("agrees with the arrivals table on all 13 observed weekends", () => {
    for (const w of TJ_SEEN) { expect(calendarAllows(tj, sat(w))).toBe(true); expect(calendarAllows(ham, sat(w))).toBe(false); }
    for (const w of HAM_SEEN) { expect(calendarAllows(ham, sat(w))).toBe(true); expect(calendarAllows(tj, sat(w))).toBe(false); }
  });

  it("closes both lines Dec 24–31 (struck through on the calendar) and reopens after", () => {
    for (const iso of ["2026-12-24", "2026-12-26", "2026-12-27", "2026-12-31"]) {
      expect(isClosedOn(tj, sat(iso))).toBe(true);
      expect(calendarAllows(tj, sat(iso))).toBe(false);
      expect(calendarAllows(ham, sat(iso))).toBe(false);
    }
    expect(isClosedOn(tj, sat("2026-12-23"))).toBe(false);
    expect(isClosedOn(tj, sat("2027-01-01"))).toBe(false);
    // Sat Dec 26 would be Hamden's by the cycle; the next Hamden start is Sat Jan 9 2027.
    const dec26 = new Date("2026-12-26T10:00:00-05:00");
    const st = serviceStateAt(HAM_WINS, "Grocery Ham", dec26);
    expect(st.open).toBe(false);
    expect(st.off).toEqual({ partner: "Grocery TJ" });
    expect(st.next?.toISOString()).toBe(new Date("2027-01-09T07:00:00-05:00").toISOString());
  });

  it("a TJ weekend day is in service; a Hamden weekend day is 'not this weekend', with TJ's next date", () => {
    expect(isRouteScheduledAt("Grocery TJ", sat("2026-09-12"))).toBe(true);
    expect(serviceStateAt(TJ_WINS, "Grocery TJ", sat("2026-09-12"))).toMatchObject({ open: true, off: null });
    expect(isRouteScheduledAt("Grocery TJ", SUN_0906_1028)).toBe(false);
    const st = serviceStateAt(TJ_WINS, "Grocery TJ", SUN_0906_1028);
    expect(st.open).toBe(false);
    expect(st.off).toEqual({ partner: "Grocery Ham" });
    expect(st.next?.toISOString()).toBe(SAT_0912_0700.toISOString());
    expect(serviceStateAt(HAM_WINS, "Grocery Ham", SUN_0906_1028)).toMatchObject({ open: true, off: null });
  });

  it("the same answers against the operator's PUBLISHED window (what riders are shown)", () => {
    const published = [{ days: [0, 6], startMin: 7 * 60, endMin: 17 * 60, text: "7am - 5pm, Sat - Sun" }];
    const st = serviceStateAt(published, "Grocery TJ", SUN_0906_1028);
    expect(st).toMatchObject({ open: false, off: { partner: "Grocery Ham" } });
    expect(st.next?.toISOString()).toBe(SAT_0912_0700.toISOString());
    expect(serviceStateAt(published, "Grocery TJ", sat("2026-09-12"))).toMatchObject({ open: true, off: null });
  });

  it("a weekday is simply not running — no 'off' — and next is the line's own Saturday", () => {
    const wed = new Date("2026-09-09T12:00:00-04:00");
    const st = serviceStateAt(TJ_WINS, "Grocery TJ", wed);
    expect(st).toMatchObject({ open: false, off: null });
    expect(st.next?.toISOString()).toBe(SAT_0912_0700.toISOString());
    expect(serviceStateAt(HAM_WINS, "Grocery Ham", wed).next?.toISOString()).toBe(new Date("2026-09-19T07:00:00-04:00").toISOString());
    const satEve = new Date("2026-09-12T20:00:00-04:00");
    expect(serviceStateAt(TJ_WINS, "Grocery TJ", satEve)).toMatchObject({ open: false, off: null });
    expect(nextWindowStart(TJ_WINS, satEve, tj)?.toISOString()).toBe(new Date("2026-09-13T07:00:00-04:00").toISOString());
  });

  describe("upstream's active flag comes first", () => {
    const live = (active: boolean | undefined, now: Date, labels: string[] = []) => ({ labels: new Set(labels), now, active });

    it("active=false on the line's own weekend, once the window has settled, is 'not this weekend'", () => {
      const at = new Date("2026-09-12T10:00:00-04:00");
      const st = serviceStateAt(TJ_WINS, "Grocery TJ", at, live(false, at));
      expect(st).toMatchObject({ open: false, off: { partner: "Grocery Ham" } });
      // Next: after this weekend, the cycle having shifted — Sat Sep 19, not Sep 26.
      expect(st.next?.toISOString()).toBe(new Date("2026-09-19T07:00:00-04:00").toISOString());
    });

    it("active=false in the first minutes of the window is not yet 'not running' (the flag may lag the bus)", () => {
      const at = new Date(`2026-09-12T07:${String(ACTIVE_FLAG_SETTLE_MIN - 1).padStart(2, "0")}:00-04:00`);
      expect(serviceStateAt(TJ_WINS, "Grocery TJ", at, live(false, at))).toMatchObject({ open: true, off: null });
      const settled = new Date(`2026-09-12T07:${String(ACTIVE_FLAG_SETTLE_MIN).padStart(2, "0")}:00-04:00`);
      expect(serviceStateAt(TJ_WINS, "Grocery TJ", settled, live(false, settled)).open).toBe(false);
    });

    it("active=true on the partner's weekend overrides the calendar: the line is out", () => {
      const st = serviceStateAt(TJ_WINS, "Grocery TJ", SUN_0906_1028, live(true, SUN_0906_1028, ["Grocery Ham"]));
      expect(st).toMatchObject({ open: true, off: null });
    });

    it("a line that does not alternate reads 'not running today' from the flag, next tomorrow", () => {
      const at = new Date("2026-09-08T12:00:00-04:00"); // Tue noon; Blue Day is open by the hours
      const st = serviceStateAt(ROUTE_HOURS["Blue Day"], "Blue Day", at, live(false, at));
      expect(st).toMatchObject({ open: false, off: { partner: null } });
      expect(st.next?.toISOString()).toBe(new Date("2026-09-09T07:00:00-04:00").toISOString());
      // Off-hours the flag says nothing new.
      const night = new Date("2026-09-08T22:00:00-04:00");
      expect(serviceStateAt(ROUTE_HOURS["Blue Day"], "Blue Day", night, live(false, night))).toMatchObject({ open: false, off: null });
    });

    it("the flag bears on today only", () => {
      const now = SUN_0906_1028;
      const nextSat = new Date("2026-09-12T10:00:00-04:00");
      expect(serviceStateAt(TJ_WINS, "Grocery TJ", nextSat, live(false, now)).open).toBe(true);
    });
  });

  it("the partner's bus out today is the fallback when no flag is served, today only", () => {
    const live = { labels: new Set(["Grocery Ham"]), now: sat("2026-09-12") };
    const st = serviceStateAt(TJ_WINS, "Grocery TJ", sat("2026-09-12"), live);
    expect(st).toMatchObject({ open: false, off: { partner: "Grocery Ham" } });
    expect(st.next?.toISOString()).toBe(new Date("2026-09-19T07:00:00-04:00").toISOString());
    expect(serviceStateAt(TJ_WINS, "Grocery TJ", sat("2026-09-19"), { labels: new Set(["Grocery Ham"]), now: sat("2026-09-12") }).open).toBe(false);
    expect(serviceStateAt(TJ_WINS, "Grocery TJ", sat("2026-09-26"), { labels: new Set(["Grocery Ham"]), now: sat("2026-09-19") }).open).toBe(true);
    expect(serviceStateAt(HAM_WINS, "Grocery Ham", sat("2026-09-19"), { labels: new Set(["Grocery Ham"]), now: sat("2026-09-19") }).open).toBe(true);
  });

  it("the in-service gate stays wide: a TJ bus on a Hamden weekend is still shown", () => {
    const bus = makeBus({ route_id: 6, lat: 41.2513, lon: -73.0177 });
    expect(isBusInService(bus, SUN_0906_1028.getTime())).toBe(true);
    expect(isRouteActiveAt("Grocery TJ", SUN_0906_1028)).toBe(true);
  });

  it("lines without a calendar are untouched", () => {
    const d = new Date("2026-09-05T10:00:00-04:00");
    expect(serviceStateAt(ROUTE_HOURS["Blue Weekend"], "Blue Weekend", d, { labels: new Set(["Grocery Ham"]), now: d })).toMatchObject({ open: true, off: null });
    expect(serviceStateAt(undefined, "Nowhere", d)).toEqual({ open: true, off: null, next: null });
    expect(isRouteScheduledAt("Nowhere", d)).toBe(true);
  });

  it("carries the published sheet's note and source for both lines", () => {
    for (const cal of [tj, ham]) {
      expect(cal.note).toMatch(/FlexiStop/);
      expect(cal.note).toMatch(/holidays and recess/);
      expect(cal.source).toMatch(/2026 grocery shuttle calendar/);
    }
  });

  // Fri 2026-09-11 23:30 ET is 03:30 UTC on Sat Sep 12. On the ET calendar
  // that is still the Hamden week's Friday; on a UTC device it is TJ's
  // Saturday. Every zone must read the ET calendar.
  const FRI_2330_ET = new Date("2026-09-12T03:30:00Z");
  const zones = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati", "Europe/London"];
  for (const tz of zones) {
    it(`resolves the weekend on the ET calendar under TZ=${tz}`, async () => {
      process.env.TZ = tz;
      vi.resetModules();
      const mod = await import("./schedule");
      const rule = mod.ROUTE_CALENDAR["Grocery TJ"]!.alternation!;
      expect(mod.etDayNumber(FRI_2330_ET)).toBe(etDayNumber(new Date("2026-09-11T12:00:00-04:00")));
      expect(mod.isOnWeekAt(rule, FRI_2330_ET)).toBe(false);
      expect(mod.isOnWeekAt(rule, new Date(FRI_2330_ET.getTime() + 5 * 3_600_000))).toBe(true);
      expect(mod.serviceStateAt(mod.ROUTE_HOURS["Grocery TJ"], "Grocery TJ", SUN_0906_1028)).toMatchObject({ open: false, off: { partner: "Grocery Ham" } });
      expect(mod.serviceStateAt(mod.ROUTE_HOURS["Grocery TJ"], "Grocery TJ", SUN_0906_1028).next?.toISOString()).toBe(SAT_0912_0700.toISOString());
    });
  }
});
