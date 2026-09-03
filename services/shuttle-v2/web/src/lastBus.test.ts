import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HEADWAY_MIN, detailLine, fmtHourAmPm, lastBusVerdict, windowPosition, windowsFor,
} from "./lastBus";
import { ROUTE_LISTS } from "./routes";
import { HEADWAY_MIN, ROUTE_HOURS } from "./schedule";
import type { PublishedWindow } from "./schedule";

// September is EDT (UTC-4). Every instant below is written in UTC and named
// by its Eastern wall-clock time so the arithmetic is auditable.
const THU_NOON   = new Date("2026-09-03T16:00:00Z"); // Thu 12:00 ET
const THU_0630   = new Date("2026-09-03T10:30:00Z"); // Thu 06:30 ET
const THU_1740   = new Date("2026-09-03T21:40:00Z"); // Thu 17:40 ET
const THU_1753   = new Date("2026-09-03T21:53:00Z"); // Thu 17:53 ET
const THU_1758   = new Date("2026-09-03T21:58:00Z"); // Thu 17:58 ET
const THU_1815   = new Date("2026-09-03T22:15:00Z"); // Thu 18:15 ET — the operator's report
const THU_1855   = new Date("2026-09-03T22:55:00Z"); // Thu 18:55 ET
const THU_2330   = new Date("2026-09-04T03:30:00Z"); // Thu 23:30 ET
const THU_2350   = new Date("2026-09-04T03:50:00Z"); // Thu 23:50 ET
const FRI_0010   = new Date("2026-09-04T04:10:00Z"); // Fri 00:10 ET
const FRI_0050   = new Date("2026-09-04T04:50:00Z"); // Fri 00:50 ET
const FRI_0110   = new Date("2026-09-04T05:10:00Z"); // Fri 01:10 ET
const FRI_0200   = new Date("2026-09-04T06:00:00Z"); // Fri 02:00 ET
const SUN_1740   = new Date("2026-09-06T21:40:00Z"); // Sun 17:40 ET

// What /api/buses serves for Red today: the operator's own text, parsed.
const RED_PUBLISHED: PublishedWindow = {
  days: [1, 2, 3, 4, 5], startMin: 7 * 60, endMin: 18 * 60, text: "7am - 6pm, M - F",
};
const PURPLE_PUBLISHED: PublishedWindow = {
  days: [0, 1, 2, 3, 4, 5, 6], startMin: 5 * 60 + 30, endMin: 23 * 60 + 45, text: "5:30am - 11:45pm, Daily",
};
const BLUE_NIGHT_PUBLISHED: PublishedWindow = {
  days: [0, 1, 2, 3, 4, 5, 6], startMin: 18 * 60, endMin: 24 * 60, text: "6pm - 12am, Daily",
};

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
  vi.resetModules();
});

describe("fmtHourAmPm", () => {
  it("spells the hour the way the weather line does — 6pm, never 6p", () => {
    expect(fmtHourAmPm(18 * 60)).toBe("6pm");
    expect(fmtHourAmPm(18 * 60 + 30)).toBe("6:30pm");
    expect(fmtHourAmPm(23 * 60 + 45)).toBe("11:45pm");
    expect(fmtHourAmPm(12 * 60)).toBe("12pm");
    expect(fmtHourAmPm(0)).toBe("12am");
  });
  it("wraps overnight closes stored past 1440", () => {
    expect(fmtHourAmPm(24 * 60)).toBe("12am");
    expect(fmtHourAmPm(25 * 60)).toBe("1am");
  });
});

describe("windowPosition", () => {
  const red = [RED_PUBLISHED];
  it("open, with the close in minutes from today's midnight", () => {
    expect(windowPosition(red, THU_1740)).toEqual({ kind: "open", closeMin: 18 * 60 });
  });
  it("after-close once the window has ended today", () => {
    expect(windowPosition(red, THU_1815)).toEqual({ kind: "after-close", closeMin: 18 * 60 });
  });
  it("before-open on a service day before the start", () => {
    expect(windowPosition(red, THU_0630)).toEqual({ kind: "before-open" });
  });
  it("off-day when the timetable has no service today", () => {
    expect(windowPosition(red, SUN_1740)).toEqual({ kind: "off-day" });
  });

  describe("overnight windows (endMin > 1440)", () => {
    const night = ROUTE_HOURS["Blue Night"]; // Daily 18:00–01:00
    it("the same-day portion is open and closes past midnight", () => {
      expect(windowPosition(night, THU_2350)).toEqual({ kind: "open", closeMin: 25 * 60 });
    });
    it("the tail belongs to the previous service day and closes today", () => {
      expect(windowPosition(night, FRI_0050)).toEqual({ kind: "open", closeMin: 60 });
    });
    it("after the tail it is after-close, NOT before tonight's open", () => {
      expect(windowPosition(night, FRI_0110)).toEqual({ kind: "after-close", closeMin: 60 });
      // 02:00 is inside the 90-min grace the gate allows past a 01:00 close,
      // so a bus can still be on screen — the story is the service that just
      // ended, not the one that opens at six.
      expect(windowPosition(night, FRI_0200)).toEqual({ kind: "after-close", closeMin: 60 });
    });
  });
});

describe("windowsFor — the same precedence as the card's own 'Runs …' line", () => {
  it("the published timetable when the payload carries one", () => {
    expect(windowsFor("Red", RED_PUBLISHED)).toEqual([RED_PUBLISHED]);
  });
  it("ROUTE_HOURS when it does not", () => {
    expect(windowsFor("Red", undefined)).toBe(ROUTE_HOURS["Red"]);
  });
  it("nothing for a line neither knows", () => {
    expect(windowsFor("Teal", undefined)).toBeNull();
  });
});

describe("lastBusVerdict — Red, the operator's report", () => {
  const red = (now: Date, over: Partial<Parameters<typeof lastBusVerdict>[0]> = {}) =>
    lastBusVerdict({ label: "Red", published: RED_PUBLISHED, now, busEtaSec: 120, liveCount: 1, ...over });

  it("says nothing at noon", () => {
    expect(red(THU_NOON)).toBeNull();
  });

  it("says nothing while the bus AFTER this one is still due before the close", () => {
    // 17:40 + 2 min ETA + 8 min headway = 17:50, before 18:00.
    expect(red(THU_1740)).toBeNull();
  });

  it("'could be the last' once the next one would be due past the close", () => {
    // 17:53 + 2 + 8 = 18:03 ≥ 18:00.
    const v = red(THU_1753);
    expect(v?.kind).toBe("closing");
    expect(v?.closeMin).toBe(18 * 60);
    expect(v?.headline).toBe("⚠️ Could be the last bus — hours end 6pm");
    expect(v?.detail).toBe("Only 1 bus is out · don't count on a ride back");
  });

  it("a bus that reaches the stop after the close, while the window is still open, is 'closing'", () => {
    expect(red(THU_1758, { busEtaSec: 300 })?.kind).toBe("closing");
  });

  it("18:15 with one bus live: past published hours, maybe the last loop", () => {
    const v = red(THU_1815);
    expect(v?.kind).toBe("after-close");
    expect(v?.headline).toBe("⚠️ Hours ended 6pm — maybe the last loop");
    expect(v?.detail).toBe("Only 1 bus still out · don't count on a ride back");
  });

  it("reports a second vehicle honestly — it is real information", () => {
    expect(red(THU_1753, { liveCount: 2 })?.detail).toBe("2 buses are out · don't count on a ride back");
    expect(red(THU_1815, { liveCount: 3 })?.detail).toBe("3 buses still out · don't count on a ride back");
  });

  it("never claims 'only 1' when the pinned bus failed the on-route check", () => {
    expect(red(THU_1815, { liveCount: 0 })?.detail).toBe("Don't count on a ride back");
  });

  it("a Sunday Red bus is off the timetable entirely (report #30's ghost, had the gate let it through)", () => {
    const v = red(SUN_1740);
    expect(v?.kind).toBe("off-day");
    expect(v?.headline).toBe("⚠️ Not scheduled today — runs M–F");
    expect(v?.detail).toBe("Only 1 bus still out · don't count on a ride back");
  });

  it("a plan for a future departure has no live bus to be the last of", () => {
    expect(red(THU_1815, { future: true })).toBeNull();
  });

  it("before the open says nothing — the stranding risk is the evening's", () => {
    expect(red(THU_0630)).toBeNull();
  });

  it("no pinned bus is judged as 'now', the cautious end", () => {
    expect(red(THU_1753, { busEtaSec: null })?.kind).toBe("closing");
    expect(red(THU_1740, { busEtaSec: null })).toBeNull();
  });

  it("a negative ETA (already there) clamps rather than pulling the arrival earlier", () => {
    expect(red(THU_1753, { busEtaSec: -600 })?.kind).toBe("closing");
  });
});

describe("lastBusVerdict — without a published timetable it judges by ROUTE_HOURS", () => {
  // Red's gate closes at 19:00, so at 18:15 the gate-only verdict is quiet and
  // the published-timetable verdict is not: the two clocks are DIFFERENT, and
  // the warning quotes whichever one the card's 'Runs …' line shows.
  it("quiet at 18:15 when only the wide gate is known", () => {
    expect(lastBusVerdict({ label: "Red", now: THU_1815, busEtaSec: 120, liveCount: 1 })).toBeNull();
  });
  it("closing against the gate's own 7pm", () => {
    const v = lastBusVerdict({ label: "Red", now: THU_1855, busEtaSec: 120, liveCount: 1 });
    expect(v?.kind).toBe("closing");
    expect(v?.headline).toBe("⚠️ Could be the last bus — hours end 7pm");
  });
  it("nothing for a line nobody has a schedule for", () => {
    expect(lastBusVerdict({ label: "Teal", now: THU_1815, busEtaSec: 0, liveCount: 1 })).toBeNull();
  });
});

describe("lastBusVerdict — overnight and late closes", () => {
  it("Purple's 11:45pm close, 20-min headway: closing from 23:25", () => {
    const v = lastBusVerdict({ label: "Purple", published: PURPLE_PUBLISHED, now: THU_2330, busEtaSec: 60, liveCount: 2 });
    expect(v?.kind).toBe("closing");
    expect(v?.headline).toBe("⚠️ Could be the last bus — hours end 11:45pm");
  });

  it("Blue Night published to 12am: closing before midnight, after-close past it", () => {
    const base = { label: "Blue Night", published: BLUE_NIGHT_PUBLISHED, busEtaSec: 180, liveCount: 1 };
    const before = lastBusVerdict({ ...base, now: THU_2350 });
    expect(before?.kind).toBe("closing");
    expect(before?.headline).toBe("⚠️ Could be the last bus — hours end 12am");
    const after = lastBusVerdict({ ...base, now: FRI_0010 });
    expect(after?.kind).toBe("after-close");
    expect(after?.headline).toBe("⚠️ Hours ended 12am — maybe the last loop");
  });

  it("Purple's 11:45pm close is still the story at 00:10 — not 'before tomorrow's 5:30am'", () => {
    const v = lastBusVerdict({ label: "Purple", published: PURPLE_PUBLISHED, now: FRI_0010, busEtaSec: 60, liveCount: 1 });
    expect(v?.kind).toBe("after-close");
    expect(v?.headline).toBe("⚠️ Hours ended 11:45pm — maybe the last loop");
  });

  it("but yesterday's close stops being the story once the gate's grace has run out", () => {
    // Red closed at 18:00 yesterday; at 06:30 the position is before today's
    // 7am open, not 'after-close' — a Red bus at 06:30 is pre-positioning.
    expect(lastBusVerdict({ label: "Red", published: RED_PUBLISHED, now: THU_0630, busEtaSec: 60, liveCount: 1 })).toBeNull();
  });

  it("Blue Night by its 1am gate: the tail is the previous day's service", () => {
    const base = { label: "Blue Night", busEtaSec: 180, liveCount: 1 };
    expect(lastBusVerdict({ ...base, now: FRI_0050 })?.headline).toBe("⚠️ Could be the last bus — hours end 1am");
    expect(lastBusVerdict({ ...base, now: FRI_0110 })?.headline).toBe("⚠️ Hours ended 1am — maybe the last loop");
  });
});

describe("the wall clock is Eastern, whatever the phone is set to", () => {
  // The bug this guards against: a phone left on its home zone once saw "No
  // shuttles running" while buses ran. Every zone must reach the same verdict
  // for the same instant.
  const zones = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati"];
  for (const tz of zones) {
    it(`TZ=${tz}: 18:15 ET Thursday is after Red's close, noon is not`, async () => {
      process.env.TZ = tz;
      vi.resetModules();
      const mod = await import("./lastBus");
      const at = (now: Date) => mod.lastBusVerdict({ label: "Red", published: RED_PUBLISHED, now, busEtaSec: 120, liveCount: 1 });
      expect(at(THU_1815)?.kind).toBe("after-close");
      expect(at(THU_1753)?.kind).toBe("closing");
      expect(at(THU_NOON)).toBeNull();
      expect(at(SUN_1740)?.kind).toBe("off-day");
    });
  }
});

describe("every line has a headway, so the default never silently prices a real one", () => {
  for (const cfg of ROUTE_LISTS) {
    it(cfg.label, () => {
      expect(HEADWAY_MIN[cfg.label]).toBeGreaterThan(0);
    });
  }
  it("the default is a plausible middle value", () => {
    expect(DEFAULT_HEADWAY_MIN).toBe(15);
  });
});

// The box is two nowrap lines inside the option card. Measured 2026-09-03 in
// the real DOM (Playwright, 390×844, every string injected into the rendered
// box, collapsed row and details view alike): the box is 324px outside and
// 306px inside. Widest headline 295.9px ("⚠️ Hours ended 11:15pm — maybe the
// last loop", bold 13px); widest detail 283.1px ("Only 1 bus still out ·
// don't count on a ride back"); the shortest close, "6pm", is 20px narrower.
// Each branch's WIDEST string is pinned here so a rewording has to re-measure
// — a line shipped wrapping once because only a short branch was measured.
describe("the widest string each branch can produce", () => {
  const closing = lastBusVerdict({ label: "Purple", published: PURPLE_PUBLISHED, now: THU_2330, busEtaSec: 60, liveCount: 10 });
  const afterClose = lastBusVerdict({
    label: "Purple", published: { ...PURPLE_PUBLISHED, endMin: 23 * 60 + 15 }, now: THU_2330, busEtaSec: 60, liveCount: 1,
  });
  const offDay = lastBusVerdict({
    label: "Red", published: { days: [1, 2, 3, 4], startMin: 420, endMin: 1080 }, now: SUN_1740, busEtaSec: 60, liveCount: 10,
  });
  it("closing", () => {
    expect(closing?.headline).toBe("⚠️ Could be the last bus — hours end 11:45pm");
    expect(closing?.detail).toBe("10 buses are out · don't count on a ride back");
  });
  it("after-close", () => {
    expect(afterClose?.headline).toBe("⚠️ Hours ended 11:15pm — maybe the last loop");
    expect(afterClose?.detail).toBe("Only 1 bus still out · don't count on a ride back");
  });
  it("off-day, with an unusual day list", () => {
    expect(offDay?.headline).toBe("⚠️ Not scheduled today — runs M/Tu/W/Th");
    expect(offDay?.detail).toBe("10 buses still out · don't count on a ride back");
  });
  it("no branch grows past the measured envelope", () => {
    for (const v of [closing, afterClose, offDay]) {
      expect(v?.headline.length).toBeLessThanOrEqual(46);
      expect(v?.detail.length).toBeLessThanOrEqual(50);
    }
  });
  it("detailLine keeps the same envelope at any realistic count", () => {
    for (const n of [0, 1, 2, 9, 12]) {
      expect(detailLine("closing", n).length).toBeLessThanOrEqual(50);
      expect(detailLine("after-close", n).length).toBeLessThanOrEqual(50);
    }
  });
});
