import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";

import { createActivesTracker, etDay, etHour, TEST_ANON_ID } from "./actives.js";

const ID_A = "11111111-2222-4333-8444-555555555555";
const ID_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const ID_C = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

// A fixed instant so day arithmetic is deterministic: 2026-08-31 16:00 ET.
const T = Date.parse("2026-08-31T20:00:00Z");
const DAY_MS = 86_400_000;
// Most of this file seeds a synthetic history that predates the real counting
// epoch, so those trackers count from the beginning of time.
const OPEN_EPOCH = "2000-01-01";

let tmpDir: string;
let bundle: DbBundle;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "actives-test-"));
  bundle = openDb(path.join(tmpDir, "test.db"));
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const rowCount = () =>
  (bundle.sqlite.prepare("SELECT COUNT(*) AS n FROM daily_actives").get() as { n: number }).n;

// Counters accumulate in memory and reach the database on a timer, so a test
// that inspects rows has to flush first. `stats()` flushes too.
const flushed = (t: { flush: (now?: number) => void }, now?: number) => {
  t.flush(now);
  return rowCount();
};

describe("etDay", () => {
  it("is anchored to Eastern Time, not the process timezone", () => {
    // 03:00 UTC on Sep 1 is still Aug 31 in New Haven. Getting this wrong would
    // roll the counter over in the middle of the evening service.
    expect(etDay(Date.parse("2026-09-01T03:00:00Z"))).toBe("2026-08-31");
    expect(etDay(Date.parse("2026-09-01T05:00:00Z"))).toBe("2026-09-01");
  });

  it("sorts lexicographically, which the retention sweep relies on", () => {
    expect(etDay(T - DAY_MS) < etDay(T)).toBe(true);
  });
});

describe("counting riders", () => {
  // The whole point: /api/buses is polled every 5 s, so a rider present for an
  // hour must not cost 720 writes.
  it("records a rider once per day no matter how often they poll", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    for (let i = 0; i < 500; i++) t.seen(ID_A, "poll", T + i * 5_000);
    expect(flushed(t, T)).toBe(1);
    expect(t.stats(T).today).toBe(1);
  });

  it("counts distinct riders separately", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T);
    t.seen(ID_B, "poll", T);
    t.seen(ID_A, "poll", T);
    expect(t.stats(T).today).toBe(2);
  });

  it("counts the same rider again on a new day", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T);
    t.seen(ID_A, "poll", T + DAY_MS);
    expect(flushed(t, T + DAY_MS)).toBe(2);
    expect(t.stats(T + DAY_MS).today).toBe(1);
    expect(t.stats(T + DAY_MS).last7Days).toBe(1); // one PERSON, two days
  });

  it("reports trailing windows over distinct people", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T - 2 * DAY_MS);
    t.seen(ID_B, "poll", T - 20 * DAY_MS);
    t.seen(ID_C, "poll", T);
    const s = t.stats(T);
    expect(s.today).toBe(1);
    expect(s.last7Days).toBe(2);
    expect(s.last30Days).toBe(3);
    expect(s.allTime).toBe(3);
  });
});

describe("hostile or missing input", () => {
  // The id arrives in a request header, so it is attacker-controlled.
  it("ignores anything that is not a well-formed id", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(undefined, "poll", T);
    t.seen(null, "poll", T);
    t.seen("", "poll", T);
    t.seen("not-a-uuid", "poll", T);
    t.seen("../../etc/passwd", "poll", T);
    t.seen("x".repeat(10_000), "poll", T);
    t.seen("'; DROP TABLE daily_actives; --", "poll", T);
    expect(flushed(t, T)).toBe(0);
    // The table is still there and still usable.
    t.seen(ID_A, "poll", T);
    expect(flushed(t, T)).toBe(1);
  });

  it("cannot be used to flood the table with junk ids", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    for (let i = 0; i < 1000; i++) t.seen(`junk-${i}`, "poll", T);
    expect(flushed(t, T)).toBe(0);
  });
});

describe("retention", () => {
  it("drops days older than the retention window at the rollover", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    // Seed a day well outside the window, then cross a day boundary.
    t.seen(ID_A, "poll", T - 200 * DAY_MS);
    expect(flushed(t, T - 200 * DAY_MS)).toBe(1);
    t.seen(ID_B, "poll", T);
    t.flush(T);
    // The rollover swept the ancient row and kept the new one.
    const days = bundle.sqlite
      .prepare("SELECT day FROM daily_actives ORDER BY day")
      .all() as Array<{ day: string }>;
    expect(days).toHaveLength(1);
    expect(days[0]?.day).toBe(etDay(T));
  });
});

describe("counting must never break the endpoint", () => {
  it("survives the table disappearing underneath it", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T);
    bundle.sqlite.exec("DROP TABLE daily_actives");
    // /api/buses is what every rider depends on; a broken counter must not
    // take it down.
    expect(() => t.seen(ID_B, "poll", T)).not.toThrow();
  });
});

describe("depth: time in app and searches", () => {
  it("records first/last sighting and separates polls from searches", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T);
    t.seen(ID_A, "search", T + 60_000);
    t.seen(ID_A, "poll", T + 12 * 60_000);
    t.flush(T);
    const row = bundle.sqlite
      .prepare("SELECT first_seen_ms, last_seen_ms, polls, searches FROM daily_actives")
      .get() as { first_seen_ms: number; last_seen_ms: number; polls: number; searches: number };
    expect(row.first_seen_ms).toBe(T);
    expect(row.last_seen_ms).toBe(T + 12 * 60_000);
    expect(row.polls).toBe(2);
    expect(row.searches).toBe(1);
    // 12 minutes between first and last sighting.
    expect(t.stats(T).medianMinutesPerDay).toBe(12);
    expect(t.stats(T).searchesToday).toBe(1);
  });

  // The reason counters are accumulated in memory at all.
  it("does not write once per request", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    for (let i = 0; i < 500; i++) t.seen(ID_A, "poll", T + i * 5_000);
    t.flush(T);
    expect(rowCount()).toBe(1);
    const row = bundle.sqlite.prepare("SELECT polls FROM daily_actives").get() as { polls: number };
    expect(row.polls).toBe(500);
  });
});

describe("do they come back", () => {
  it("splits today into new and returning", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T - 3 * DAY_MS); // seen before
    t.seen(ID_A, "poll", T);              // ...and again today
    t.seen(ID_B, "poll", T);              // first time today
    const s = t.stats(T);
    expect(s.today).toBe(2);
    expect(s.returningToday).toBe(1);
    expect(s.newToday).toBe(1);
  });

  it("reports the share of browsers that ever came back", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T - DAY_MS);
    t.seen(ID_A, "poll", T);      // returned
    t.seen(ID_B, "poll", T);      // one-and-done so far
    expect(t.stats(T).repeatRate).toBeCloseTo(0.5, 6);
    expect(t.stats(T).medianDaysActive).toBeCloseTo(1.5, 6);
  });

  // Retention must not be diluted by browsers that have not HAD a week yet.
  it("counts week-1 retention only over browsers old enough to judge", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    // Arrived 10 days ago, came back 2 days later -> retained.
    t.seen(ID_A, "poll", T - 10 * DAY_MS);
    t.seen(ID_A, "poll", T - 8 * DAY_MS);
    // Arrived 10 days ago, never returned -> not retained.
    t.seen(ID_B, "poll", T - 10 * DAY_MS);
    // Arrived today: too new to judge, must be excluded from the cohort.
    t.seen(ID_C, "poll", T);
    const s = t.stats(T);
    expect(s.week1Cohort).toBe(2);
    expect(s.week1Retention).toBeCloseTo(0.5, 6);
  });

  it("reports null retention rather than 0 when nobody is old enough", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T);
    const s = t.stats(T);
    expect(s.week1Cohort).toBe(0);
    expect(s.week1Retention).toBeNull();
  });
});

describe("rows predating the depth columns", () => {
  // Real case: rows written before first_seen_ms/last_seen_ms existed have
  // NULL there. SQLite's MIN()/MAX() return NULL if any argument is NULL, so a
  // naive upsert would leave those rows without a session length forever.
  it("backfills a NULL timestamp instead of propagating the NULL", () => {
    bundle.sqlite
      .prepare("INSERT INTO daily_actives (day, anon_id, polls, searches) VALUES (?,?,0,0)")
      .run(etDay(T), ID_A);
    const before = bundle.sqlite
      .prepare("SELECT first_seen_ms AS f FROM daily_actives")
      .get() as { f: number | null };
    expect(before.f).toBeNull();

    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T);
    t.seen(ID_A, "poll", T + 5 * 60_000);
    t.flush(T);

    const after = bundle.sqlite
      .prepare("SELECT first_seen_ms AS f, last_seen_ms AS l, polls FROM daily_actives")
      .get() as { f: number; l: number; polls: number };
    expect(after.f).toBe(T);
    expect(after.l).toBe(T + 5 * 60_000);
    expect(after.polls).toBe(2);
    expect(t.stats(T + 5 * 60_000).medianMinutesPerDay).toBe(5);
  });
});

describe("excluding test traffic", () => {
  const exclude = (id: string, note = "test") =>
    bundle.sqlite
      .prepare("INSERT OR IGNORE INTO excluded_anon_ids (anon_id, note) VALUES (?,?)")
      .run(id, note);

  it("seeds the harness id so a browser check never counts", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(TEST_ANON_ID, "poll", T);
    t.seen(TEST_ANON_ID, "search", T);
    t.seen(ID_A, "poll", T);
    const s = t.stats(T);
    expect(s.today).toBe(1);      // only the real browser
    expect(s.allTime).toBe(1);
    expect(s.searchesToday).toBe(0);
  });

  // Excluding must not delete: the rows stay for audit, the counts ignore them.
  it("keeps the underlying rows", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(TEST_ANON_ID, "poll", T);
    t.flush(T);
    expect(rowCount()).toBe(1);
    expect(t.stats(T).today).toBe(0);
  });

  it("excludes a flagged browser from every figure, not just the headline", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    // A "tester" active on two days would otherwise inflate repeat rate,
    // retention, days-active and session length.
    t.seen(ID_B, "poll", T - 10 * DAY_MS);
    t.seen(ID_B, "poll", T - 8 * DAY_MS);
    t.seen(ID_B, "poll", T);
    t.seen(ID_A, "poll", T);
    t.flush(T);
    exclude(ID_B, "pre-launch testing");

    const s = t.stats(T);
    expect(s.today).toBe(1);
    expect(s.returningToday).toBe(0);
    expect(s.newToday).toBe(1);
    expect(s.repeatRate).toBe(0);
    expect(s.week1Cohort).toBe(0);
    expect(s.week1Retention).toBeNull();
    expect(s.medianDaysActive).toBe(1);
  });

  it("still counts a real browser after others are excluded", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T);
    t.seen(ID_B, "poll", T);
    t.seen(ID_C, "poll", T);
    t.flush(T);
    exclude(ID_A);
    exclude(ID_B);
    expect(t.stats(T).today).toBe(1);
  });
});

describe("per-day history", () => {
  const exclude = (id: string, note = "test") =>
    bundle.sqlite
      .prepare("INSERT OR IGNORE INTO excluded_anon_ids (anon_id, note) VALUES (?,?)")
      .run(id, note);

  it("splits each day into first-ever and returning browsers", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T - 2 * DAY_MS);
    t.seen(ID_A, "poll", T);
    t.seen(ID_B, "poll", T);

    const h = t.history(30, T);
    expect(h.map((d) => d.day)).toEqual([etDay(T - 2 * DAY_MS), etDay(T)]);
    // Same browser: new on the day it first appeared, returning on the next.
    expect(h[0]).toMatchObject({ riders: 1, newRiders: 1, returningRiders: 0 });
    expect(h[1]).toMatchObject({ riders: 2, newRiders: 1, returningRiders: 1 });
  });

  // "New" means first EVER seen, not first seen inside the window — otherwise
  // a narrow window would relabel every long-standing rider as an arrival.
  it("does not call a browser new just because the window starts after its first day", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T - 5 * DAY_MS);
    t.seen(ID_A, "poll", T);
    const h = t.history(2, T);
    expect(h.map((d) => d.day)).toEqual([etDay(T)]);
    expect(h[0]).toMatchObject({ riders: 1, newRiders: 0, returningRiders: 1 });
  });

  it("omits days with no rows rather than inventing zeros", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T - 3 * DAY_MS);
    t.seen(ID_A, "poll", T);
    // Nothing on the two days in between: they are absent, not zero, so a
    // chart cannot imply the app existed and was unused.
    expect(t.history(30, T).map((d) => d.day)).toEqual([etDay(T - 3 * DAY_MS), etDay(T)]);
  });

  it("never shows a flagged browser, on any day", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_B, "poll", T - DAY_MS);
    t.seen(ID_B, "search", T);
    t.seen(ID_A, "poll", T);
    t.flush(T);
    exclude(ID_B, "pre-launch testing");

    const h = t.history(30, T);
    // The excluded browser was the only one on T-1, so that day disappears.
    expect(h.map((d) => d.day)).toEqual([etDay(T)]);
    expect(h[0]).toMatchObject({ riders: 1, newRiders: 1, returningRiders: 0, searches: 0 });
  });

  it("counts searches and median session length per day", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T);
    t.seen(ID_A, "search", T + 4 * 60_000);
    t.seen(ID_B, "poll", T);
    t.seen(ID_B, "poll", T + 10 * 60_000);
    t.seen(ID_B, "search", T + 10 * 60_000);

    const h = t.history(30, T + 10 * 60_000);
    expect(h).toHaveLength(1);
    expect(h[0]!.searches).toBe(2);
    // Sessions of 4 min and 10 min.
    expect(h[0]!.medianMinutesPerDay).toBe(7);
  });

  it("reports zero minutes for a day of single-sighting browsers", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T);
    expect(t.history(30, T)[0]!.medianMinutesPerDay).toBe(0);
  });

  it("clamps the window at both ends", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T - 2 * DAY_MS);
    t.seen(ID_A, "poll", T);
    // A zero or negative window still yields today, never an empty range.
    expect(t.history(0, T).map((d) => d.day)).toEqual([etDay(T)]);
    expect(t.history(-5, T).map((d) => d.day)).toEqual([etDay(T)]);
    // And a huge window stops at the retention horizon.
    bundle.sqlite
      .prepare("INSERT INTO daily_actives (day, anon_id, first_seen_ms, last_seen_ms, polls, searches) VALUES (?,?,?,?,1,0)")
      .run(etDay(T - 95 * DAY_MS), ID_C, T - 95 * DAY_MS, T - 95 * DAY_MS);
    const wide = t.history(1000, T).map((d) => d.day);
    expect(wide).not.toContain(etDay(T - 95 * DAY_MS));
    expect(wide).toEqual([etDay(T - 2 * DAY_MS), etDay(T)]);
  });

  it("returns the days oldest first", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T - 4 * DAY_MS);
    t.seen(ID_B, "poll", T - DAY_MS);
    t.seen(ID_C, "poll", T);
    const days = t.history(30, T).map((d) => d.day);
    expect([...days].sort()).toEqual(days);
  });
});

describe("the counting epoch (SHUTTLE_STATS_SINCE_DAY)", () => {
  // These two use the real default epoch, not the open one the rest of the
  // file seeds history against.
  const tracker = () => createActivesTracker(bundle);
  // The operator's numbers describe the service, not the build: sightings from
  // before the app reached riders are development traffic.
  const BEFORE = Date.parse("2026-08-29T16:00:00Z"); // Sat 2026-08-29, before the epoch
  it("ignores days before the epoch entirely", () => {
    const t = tracker();
    t.seen(ID_A, "poll", BEFORE);
    t.seen(ID_A, "search", BEFORE + 1000);
    const s = t.stats(BEFORE + 60_000);
    expect(s.allTime).toBe(0);
    expect(s.today).toBe(0);
    expect(t.history(90, BEFORE + 60_000)).toEqual([]);
    // The row is stored — only the counting ignores it.
    expect(rowCount()).toBe(1);
  });

  it("does not let a pre-epoch sighting make a later visit 'returning'", () => {
    const t = tracker();
    t.seen(ID_A, "poll", BEFORE);   // development traffic
    t.seen(ID_A, "poll", T);        // the rider's first real day
    const s = t.stats(T);
    expect(s.today).toBe(1);
    expect(s.newToday).toBe(1);
    expect(s.returningToday).toBe(0);
    expect(s.repeatRate).toBe(0);
    const today = t.history(30, T).at(-1)!;
    expect(today.newRiders).toBe(1);
    expect(today.returningRiders).toBe(0);
  });
});

describe("history() and stats() cannot drift apart", () => {
  it("agrees with today's row on every figure they share", () => {
    // Two independent SQL paths (a grouped `firsts` CTE vs an INTERSECT):
    // the whole dashboard rests on them telling the same story about today.
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T - 2 * DAY_MS);
    t.seen(ID_B, "poll", T - DAY_MS);
    t.seen(ID_A, "poll", T);              // returning today
    t.seen(ID_C, "poll", T);              // new today
    t.seen(ID_C, "search", T + 1000);
    const s = t.stats(T);
    const today = t.history(30, T).at(-1)!;
    expect(today.day).toBe(etDay(T));
    expect(today.riders).toBe(s.today);
    expect(today.newRiders).toBe(s.newToday);
    expect(today.returningRiders).toBe(s.returningToday);
    expect(today.searches).toBe(s.searchesToday);
    expect(today.newRiders + today.returningRiders).toBe(today.riders);
  });
});

describe("per-hour shape of a day", () => {
  // 2026-08-31T20:00:00Z is 16:00 ET — the hour the fixtures below hang off.
  const ET_HOUR_OF_T = 16;

  it("reads the hour in ET, not the machine's timezone", () => {
    expect(etHour(T)).toBe(ET_HOUR_OF_T);
    // Midnight ET must be 0, never 24.
    expect(etHour(Date.parse("2026-09-01T04:00:00Z"))).toBe(0);
  });

  it("counts a browser in every hour between its first and last sighting", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T);                        // 16:00 ET
    t.seen(ID_A, "poll", T + 2 * 60 * 60_000);      // 18:00 ET, same browser
    t.seen(ID_B, "poll", T);                        // 16:00 ET only
    const [day] = t.hourly(7, T + 3 * 60 * 60_000);
    expect(day!.day).toBe(etDay(T));
    expect(day!.hours).toHaveLength(24);
    expect(day!.hours[16]).toBe(2);   // both browsers
    expect(day!.hours[17]).toBe(1);   // A is still in its span
    expect(day!.hours[18]).toBe(1);
    expect(day!.hours[19]).toBe(0);
    expect(day!.hours[9]).toBe(0);
  });

  it("gives each day its own line, oldest first, and skips days with nothing", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T - 2 * DAY_MS);
    t.seen(ID_B, "poll", T);
    const days = t.hourly(7, T);
    expect(days.map((d) => d.day)).toEqual([etDay(T - 2 * DAY_MS), etDay(T)]);
    // The day between them had no rows: absent, not a row of zeroes.
    expect(days).toHaveLength(2);
  });

  it("ignores browsers the statistics exclude", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(TEST_ANON_ID, "poll", T);   // seeded into excluded_anon_ids
    t.seen(ID_A, "poll", T);
    expect(t.hourly(7, T)[0]!.hours[ET_HOUR_OF_T]).toBe(1);
  });

  it("flushes first, so today is not an hour behind", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    t.seen(ID_A, "poll", T);
    // No explicit flush(): hourly() must do it, as stats() and history() do.
    expect(t.hourly(7, T)[0]!.hours[ET_HOUR_OF_T]).toBe(1);
  });

  it("does not wrap a session that ran past midnight into the same day", () => {
    const t = createActivesTracker(bundle, { sinceDay: OPEN_EPOCH });
    const lateNight = Date.parse("2026-09-01T03:30:00Z"); // 23:30 ET on the 31st
    t.seen(ID_A, "poll", lateNight);
    t.seen(ID_A, "poll", lateNight + 60 * 60_000);        // 00:30 ET next day
    const day = t.hourly(7, lateNight + 2 * 60 * 60_000).find((d) => d.day === etDay(lateNight))!;
    // The row belongs to the 31st, so it fills to 23 rather than wrapping
    // round into hours that belong to the 1st.
    expect(day.hours[23]).toBe(1);
    expect(day.hours[0]).toBe(0);
  });
});
