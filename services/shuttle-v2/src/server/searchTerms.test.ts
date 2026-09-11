import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type DbBundle } from "../db/client.js";
import {
  collapsePrefixes,
  createSearchTermsTracker,
  normalizeQuery,
  type SearchTermsTracker,
} from "./searchTerms.js";

const T = Date.parse("2026-09-03T20:00:00Z"); // 16:00 ET
const DAY = 86_400_000;

let tmpDir: string;
let bundle: DbBundle;
let tracker: SearchTermsTracker;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-terms-"));
  bundle = openDb(path.join(tmpDir, "t.db"));
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
  tracker = createSearchTermsTracker(bundle);
});

afterEach(() => {
  tracker.stop();
  bundle.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("normalizeQuery", () => {
  it("folds the spellings a rider varies on into one row", () => {
    // The matcher already treats these as one thing; the counts must too, or
    // a popular place looks like three unpopular ones.
    expect(normalizeQuery("Elena's")).toBe("elenas");
    expect(normalizeQuery("  ELENA’S   on   Orange ")).toBe("elenas on orange");
    expect(normalizeQuery("Trader Joe's!!")).toBe("trader joes");
  });

  it("caps a pasted essay", () => {
    expect(normalizeQuery("x".repeat(500)).length).toBe(60);
  });
});

describe("collapsePrefixes", () => {
  it("keeps the question, not the keystrokes on the way to it", () => {
    // The lookup fires on a debounce as the rider types, so the prefixes
    // reach the server too. The longest form is the place worth adding.
    const rows = [
      { q: "one", n: 3, zero: 3 },
      { q: "one6", n: 2, zero: 2 },
      { q: "one6three", n: 1, zero: 1 },
      { q: "ice rink", n: 4, zero: 4 },
    ];
    expect(collapsePrefixes(rows).map((r) => r.q)).toEqual(["ice rink", "one6three"]);
  });

  it("leaves two genuinely different terms alone", () => {
    const rows = [{ q: "chapel", n: 5, zero: 0 }, { q: "chase", n: 2, zero: 0 }];
    expect(collapsePrefixes(rows)).toHaveLength(2);
  });
});

describe("what riders searched for", () => {
  it("counts a term and how often it found nothing", () => {
    tracker.record("one6three", 0, T);
    tracker.record("one6three", 0, T);
    tracker.record("elenas", 3, T);
    const r = tracker.report(30, 25, T);
    expect(r.searches).toBe(3);
    expect(r.zeroSearches).toBe(2);
    expect(r.top.find((t) => t.q === "one6three")?.n).toBe(2);
  });

  it("surfaces only the terms that NEVER found anything", () => {
    // A term that works most of the time and missed once is a flaky upstream,
    // not a gap in the list.
    tracker.record("ice rink", 0, T);
    tracker.record("ice rink", 0, T);
    tracker.record("pepes", 0, T);
    tracker.record("pepes", 2, T);
    const r = tracker.report(30, 25, T);
    expect(r.missing.map((m) => m.q)).toEqual(["ice rink"]);
  });

  it("ignores the prefixes a debounced box sends on the way", () => {
    for (const q of ["one", "one6", "one6t", "one6three"]) tracker.record(q, 0, T);
    expect(tracker.report(30, 25, T).missing.map((m) => m.q)).toEqual(["one6three"]);
  });

  it("ignores a query too short to be a question", () => {
    tracker.record("ab", 0, T);
    tracker.record("a", 0, T);
    expect(tracker.report(30, 25, T).searches).toBe(0);
  });

  it("adds to the day's tally rather than replacing it across a restart", () => {
    // daily_actives got this wrong and lost counts on every deploy.
    tracker.record("chapel", 1, T);
    tracker.flush(T);
    const second = createSearchTermsTracker(bundle);
    second.record("chapel", 1, T);
    expect(second.report(30, 25, T).top.find((t) => t.q === "chapel")?.n).toBe(2);
    second.stop();
  });

  it("keeps days apart and forgets old ones", () => {
    tracker.record("chapel", 1, T - 40 * DAY);
    tracker.record("chapel", 1, T);
    // The 40-day-old row is swept when a new day is first seen.
    expect(tracker.report(30, 25, T).top.find((t) => t.q === "chapel")?.n).toBe(1);
  });

  it("never throws, whatever it is handed", () => {
    expect(() => tracker.record("", 0, T)).not.toThrow();
    expect(() => tracker.record("ok", NaN, T)).not.toThrow();
    expect(() => tracker.record("x".repeat(5000), 1, T)).not.toThrow();
  });

  it("stores the words and NOTHING that narrows a row to a person", () => {
    // The privacy shape is the reason this table is allowed to exist: no id,
    // no IP, no user agent, no time of day, no session. Asserted on the
    // schema itself so a future column has to argue with this test.
    tracker.record("elenas", 1, T);
    tracker.flush(T);
    const cols = bundle.sqlite.prepare("PRAGMA table_info(search_terms)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual(["day", "n", "q", "zero"]);
    const row = bundle.sqlite.prepare("SELECT * FROM search_terms").get() as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(["day", "n", "q", "zero"]);
    // The day is a date, never a timestamp: no time of day survives.
    expect(String(row.day)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
