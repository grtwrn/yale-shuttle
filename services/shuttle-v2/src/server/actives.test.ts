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
    const t = createActivesTracker(bundle.db);
    for (let i = 0; i < 500; i++) t.seen(ID_A, T + i * 5_000);
    expect(rowCount()).toBe(1);
    expect(t.stats(T).today).toBe(1);
  });

  it("counts distinct riders separately", () => {
    const t = createActivesTracker(bundle.db);
    t.seen(ID_A, T);
    t.seen(ID_B, T);
    t.seen(ID_A, T);
    expect(t.stats(T).today).toBe(2);
  });

  it("counts the same rider again on a new day", () => {
    const t = createActivesTracker(bundle.db);
    t.seen(ID_A, T);
    t.seen(ID_A, T + DAY_MS);
    expect(rowCount()).toBe(2);
    expect(t.stats(T + DAY_MS).today).toBe(1);
    expect(t.stats(T + DAY_MS).last7Days).toBe(1); // one PERSON, two days
  });

  it("reports trailing windows over distinct people", () => {
    const t = createActivesTracker(bundle.db);
    t.seen(ID_A, T - 2 * DAY_MS);
    t.seen(ID_B, T - 20 * DAY_MS);
    t.seen(ID_C, T);
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
    const t = createActivesTracker(bundle.db);
    t.seen(undefined, T);
    t.seen(null, T);
    t.seen("", T);
    t.seen("not-a-uuid", T);
    t.seen("../../etc/passwd", T);
    t.seen("x".repeat(10_000), T);
    t.seen("'; DROP TABLE daily_actives; --", T);
    expect(rowCount()).toBe(0);
    // The table is still there and still usable.
    t.seen(ID_A, T);
    expect(rowCount()).toBe(1);
  });

  it("cannot be used to flood the table with junk ids", () => {
    const t = createActivesTracker(bundle.db);
    for (let i = 0; i < 1000; i++) t.seen(`junk-${i}`, T);
    expect(rowCount()).toBe(0);
  });
});

describe("retention", () => {
  it("drops days older than the retention window at the rollover", () => {
    const t = createActivesTracker(bundle.db);
    // Seed a day well outside the window, then cross a day boundary.
    t.seen(ID_A, T - 200 * DAY_MS);
    expect(rowCount()).toBe(1);
    t.seen(ID_B, T);
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
    const t = createActivesTracker(bundle.db);
    t.seen(ID_A, T);
    bundle.sqlite.exec("DROP TABLE daily_actives");
    // /api/buses is what every rider depends on; a broken counter must not
    // take it down.
    expect(() => t.seen(ID_B, T)).not.toThrow();
  });
});
