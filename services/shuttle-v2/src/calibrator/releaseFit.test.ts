import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  fitRelease,
  loadReleaseObservations,
  ReleaseFitCache,
  type Observation,
} from "./releaseFit.js";
import { releaseDist } from "../../web/src/eta/release.js";
import { quantile } from "../../web/src/eta/dist.js";

describe("server release fit", () => {
  it("requires independent service days and learns shorter waits after a longer lap without trimming a long wait", () => {
    const rows: Observation[] = [];
    for (const day of [
      "2026-09-03",
      "2026-09-04",
      "2026-09-08",
      "2026-09-09",
    ]) {
      for (let i = 0; i < 20; i++) {
        const a = Date.parse(day + "T12:00:00Z") + i * 900_000,
          lap = 2500 + i * 50,
          y = 650 - i * 24 + (i % 3) * 15;
        rows.push({ a, ready: a + y * 1000 + 120_000, stop: 11, lap, y, day });
      }
    }
    const before = Date.parse("2026-09-10T04:00:00Z");
    expect(fitRelease(rows.slice(0, 20), 11, before)).toBeNull();
    const fit = fitRelease(rows, 11, before)!;
    expect(fit.n).toBe(80);
    const early = releaseDist(fit, 0, 2600)!,
      late = releaseDist(fit, 0, 3300)!;
    expect(quantile(late, 0.5)).toBeLessThan(quantile(early, 0.5));
    const long = fitRelease(
      [...rows, { ...rows[0]!, y: 3600, ready: rows[0]!.a + 3_720_000 }],
      11,
      before,
    )!;
    expect(long.n).toBe(81);
    expect(long.coefficients.every(Number.isFinite)).toBe(true);
  });
  it("uses only available prior departures and retains legitimate short and long stopped visits", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE arrivals(bus_name TEXT,route_id INTEGER,stop_id INTEGER,departed_at INTEGER);
      CREATE TABLE stop_visits(bus_name TEXT,route_id INTEGER,stop_id INTEGER,pinned_at INTEGER,
       departed_at INTEGER,first_moved_at INTEGER,confirm_sec REAL,outcome TEXT,how TEXT,closest_m REAL);`);
    const a = Date.parse("2026-09-16T14:00:00Z"),
      before = a + 2_000_000;
    const departure = db.prepare("INSERT INTO arrivals VALUES(?,?,?,?)");
    departure.run("#309", 3, 11, a - 3_000_000);
    departure.run("#309", 3, 121, a - 1_000_000);
    departure.run("#309", 3, 11, a - 60_000); // Not yet conservatively available at pin.
    departure.run("#309", 3, 11, a + 300_000); // Future relative to pin, despite complete by fit time.
    const visit = db.prepare(
      "INSERT INTO stop_visits VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    visit.run(
      "#309",
      3,
      11,
      a,
      a + 150_000,
      a + 155_000,
      15,
      "stopped",
      "next",
      20,
    );
    visit.run(
      "#310",
      3,
      11,
      a,
      a + 1_020_000,
      a + 1_025_000,
      15,
      "stopped",
      "far",
      20,
    );
    visit.run(
      "#309",
      3,
      11,
      before - 100_000,
      before - 50_000,
      before - 45_000,
      15,
      "stopped",
      "next",
      20,
    );
    const rows = loadReleaseObservations(db, before);
    expect(rows.map((r) => r.y)).toEqual([150, 1020]);
    expect(rows[0]!.lap).toBe(3000);
    expect(rows[1]!.lap).toBeNull();
    const cache = new ReleaseFitCache(db);
    expect(cache.get(before).size).toBe(0); // Thin server history falls back.
    db.close();
    expect(() => cache.get(before + 7 * 3_600_000)).not.toThrow();
  });
});
