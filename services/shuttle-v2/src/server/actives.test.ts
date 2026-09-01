import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";

import { createActivesTracker, etDay } from "./actives.js";

const ID_A = "11111111-2222-4333-8444-555555555555";
const ID_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const ID_C = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

// A fixed instant so day arithmetic is deterministic: 2026-08-31 16:00 ET.
const T = Date.parse("2026-08-31T20:00:00Z");
const DAY_MS = 86_400_000;

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
    const t = createActivesTracker(bundle);
    for (let i = 0; i < 500; i++) t.seen(ID_A, "poll", T + i * 5_000);
    expect(flushed(t, T)).toBe(1);
    expect(t.stats(T).today).toBe(1);
  });

  it("counts distinct riders separately", () => {
    const t = createActivesTracker(bundle);
    t.seen(ID_A, "poll", T);
    t.seen(ID_B, "poll", T);
    t.seen(ID_A, "poll", T);
    expect(t.stats(T).today).toBe(2);
  });

  it("counts the same rider again on a new day", () => {
    const t = createActivesTracker(bundle);
    t.seen(ID_A, "poll", T);
    t.seen(ID_A, "poll", T + DAY_MS);
    expect(flushed(t, T + DAY_MS)).toBe(2);
    expect(t.stats(T + DAY_MS).today).toBe(1);
    expect(t.stats(T + DAY_MS).last7Days).toBe(1); // one PERSON, two days
  });

  it("reports trailing windows over distinct people", () => {
    const t = createActivesTracker(bundle);
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
    const t = createActivesTracker(bundle);
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
    const t = createActivesTracker(bundle);
    for (let i = 0; i < 1000; i++) t.seen(`junk-${i}`, "poll", T);
    expect(flushed(t, T)).toBe(0);
  });
});

describe("retention", () => {
  it("drops days older than the retention window at the rollover", () => {
    const t = createActivesTracker(bundle);
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
    const t = createActivesTracker(bundle);
    t.seen(ID_A, "poll", T);
    bundle.sqlite.exec("DROP TABLE daily_actives");
    // /api/buses is what every rider depends on; a broken counter must not
    // take it down.
    expect(() => t.seen(ID_B, "poll", T)).not.toThrow();
  });
});

describe("depth: time in app and searches", () => {
  it("records first/last sighting and separates polls from searches", () => {
    const t = createActivesTracker(bundle);
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
    const t = createActivesTracker(bundle);
    for (let i = 0; i < 500; i++) t.seen(ID_A, "poll", T + i * 5_000);
    t.flush(T);
    expect(rowCount()).toBe(1);
    const row = bundle.sqlite.prepare("SELECT polls FROM daily_actives").get() as { polls: number };
    expect(row.polls).toBe(500);
  });
});

describe("do they come back", () => {
  it("splits today into new and returning", () => {
    const t = createActivesTracker(bundle);
    t.seen(ID_A, "poll", T - 3 * DAY_MS); // seen before
    t.seen(ID_A, "poll", T);              // ...and again today
    t.seen(ID_B, "poll", T);              // first time today
    const s = t.stats(T);
    expect(s.today).toBe(2);
    expect(s.returningToday).toBe(1);
    expect(s.newToday).toBe(1);
  });

  it("reports the share of browsers that ever came back", () => {
    const t = createActivesTracker(bundle);
    t.seen(ID_A, "poll", T - DAY_MS);
    t.seen(ID_A, "poll", T);      // returned
    t.seen(ID_B, "poll", T);      // one-and-done so far
    expect(t.stats(T).repeatRate).toBeCloseTo(0.5, 6);
    expect(t.stats(T).medianDaysActive).toBeCloseTo(1.5, 6);
  });

  // Retention must not be diluted by browsers that have not HAD a week yet.
  it("counts week-1 retention only over browsers old enough to judge", () => {
    const t = createActivesTracker(bundle);
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
    const t = createActivesTracker(bundle);
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

    const t = createActivesTracker(bundle);
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
