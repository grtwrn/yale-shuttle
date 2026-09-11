import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { openDb, type DbBundle } from "../db/client.js";
import { outsideReports, operatorIds, seedOperatorIds } from "./outsideReports.js";

let tmpDir: string;
let bundle: DbBundle;

const OPERATOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/**
 * Midnight ET on the counting epoch (2026-08-31 is on daylight time, so
 * UTC-4), and the two moments either side of it. Every fixture below is
 * stamped after it: the panel counts from the same epoch the dashboard
 * prints, so a report from 2023 would simply not be there.
 */
const EPOCH_MS = Date.UTC(2026, 7, 31, 4);
const BEFORE_EPOCH_MS = EPOCH_MS - 1;
const AFTER_EPOCH_MS = EPOCH_MS + 36 * 3_600_000; // 2026-09-01, noon ET

function file(
  body: string,
  opts: {
    anonId?: string | null;
    note?: string;
    status?: string;
    kind?: string;
    createdAt?: number;
  } = {},
): number {
  const info = bundle.sqlite.prepare(`
    INSERT INTO reports (kind, body, anon_id, note, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.kind ?? "feedback",
    body,
    opts.anonId === undefined ? OTHER : opts.anonId,
    opts.note ?? null,
    opts.status ?? "open",
    opts.createdAt ?? AFTER_EPOCH_MS,
  );
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-reports-"));
  bundle = openDb(path.join(tmpDir, "test.db"));
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("outsideReports — did anyone but the operator write in?", () => {
  it("keeps a stranger's report and drops the operator's own", () => {
    seedOperatorIds(bundle, OPERATOR);
    file("mine, from my phone", { anonId: OPERATOR });
    const theirs = file("Hi! could you add Trader Joe's?");
    const out = outsideReports(bundle);
    expect(out.reports.map((r) => r.id)).toEqual([theirs]);
    expect(out.total).toBe(1);
    expect(out.newestId).toBe(theirs);
  });

  it("drops the map-bot's own filings, which arrive like a rider's", () => {
    file("[map-bot] Trip from A to B: ground truth disagreed", { anonId: null });
    const human = file("the bus never came");
    expect(outsideReports(bundle).reports.map((r) => r.id)).toEqual([human]);
  });

  it("counts a report with NO anon id as outside", () => {
    // Storage may simply have been blocked. A false "someone wrote in" is a
    // cheap error; missing the one person who did is not.
    seedOperatorIds(bundle, OPERATOR);
    const anon = file("no id on this one", { anonId: null });
    expect(outsideReports(bundle).reports.map((r) => r.id)).toEqual([anon]);
  });

  it("never returns anything that identifies a reporter", () => {
    // This endpoint is reachable with the stats cookie, so the shape is the
    // security boundary: no IP, no anon id, no context blob.
    bundle.sqlite.prepare(`
      INSERT INTO reports (kind, body, anon_id, client_ip, context, created_at)
      VALUES ('feedback', 'hello', ?, '203.0.113.9', '{"lat":41.3}', ?)
    `).run(OTHER, AFTER_EPOCH_MS);
    const [row] = outsideReports(bundle).reports;
    expect(row).toBeDefined();
    const keys = Object.keys(row!).sort();
    expect(keys).toEqual(["answered", "createdAt", "excerpt", "id", "kind", "routeId", "status"]);
    expect(JSON.stringify(row)).not.toContain("203.0.113.9");
    expect(JSON.stringify(row)).not.toContain(OTHER);
  });

  it("says whether the rider has been answered, and trims the excerpt", () => {
    file("short one", { note: "[fixed] thanks!" });
    file("x".repeat(400));
    const [long, answered] = outsideReports(bundle).reports;
    expect(long!.excerpt).toHaveLength(240);
    expect(answered!.answered).toBe(true);
  });

  it("newest first, and honours a sane limit", () => {
    const ids = [file("a"), file("b"), file("c")];
    expect(outsideReports(bundle, 2).reports.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    expect(outsideReports(bundle, 0).reports).toHaveLength(3);   // 0 → default
    expect(outsideReports(bundle, 9999).reports).toHaveLength(3); // capped, not thrown
  });

  it("hides a report filed before the counting epoch, keeps one filed on it", () => {
    // The dashboard prints "counting from Mon Aug 31" over this very panel;
    // the pre-launch reports it used to lead with are development traffic.
    const old = file("filed during development", { createdAt: BEFORE_EPOCH_MS });
    const onTheDay = file("midnight ET on launch Monday", { createdAt: EPOCH_MS });
    const later = file("a real rider, days later");
    const out = outsideReports(bundle);
    expect(out.reports.map((r) => r.id)).toEqual([later, onTheDay]);
    expect(out.reports.map((r) => r.id)).not.toContain(old);
  });

  it("counts the total and the newest id over the SAME filtered set", () => {
    // stats.html prints data.total beside the list and remembers newestId as
    // "seen"; a total over hidden rows would say "1 of 3", and a newestId
    // from a hidden row would mark unread reports as already read.
    file("older than the epoch", { createdAt: BEFORE_EPOCH_MS });
    file("older still", { createdAt: 1_700_000_000_000 });
    const visible = file("the only one that counts");
    const out = outsideReports(bundle);
    expect(out.total).toBe(1);
    expect(out.newestId).toBe(visible);
  });

  it("honours an explicit epoch, as the app passes from the actives tracker", () => {
    const early = file("well before", { createdAt: BEFORE_EPOCH_MS });
    expect(outsideReports(bundle, 20, { sinceDay: "2000-01-01" }).reports.map((r) => r.id))
      .toEqual([early]);
    expect(outsideReports(bundle, 20, { sinceDay: "2099-01-01" }).reports).toHaveLength(0);
  });

  it("seeds a comma-separated list, ignores blanks, and never throws", () => {
    seedOperatorIds(bundle, ` ${OPERATOR} , , ${OTHER} `);
    expect(operatorIds(bundle)).toEqual([OPERATOR, OTHER].sort());
    expect(() => seedOperatorIds(bundle, undefined)).not.toThrow();
    expect(() => seedOperatorIds(bundle, "")).not.toThrow();
    // Seeding twice must not duplicate or fail.
    seedOperatorIds(bundle, OPERATOR);
    expect(operatorIds(bundle)).toHaveLength(2);
  });
});
