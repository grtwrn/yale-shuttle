import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import type { Route, Stop } from "../schema/api.js";

import { Collector } from "./collector.js";
import { BLUE_DAY } from "./__fixtures__/report100-cedar-stand.js";
import { UpstreamClient, type RawBus } from "./upstream.js";

/**
 * The lap clock survives a restart.
 *
 * `Collector.lapClock` is in-memory and fed only by the detector's dwell
 * events, so a fresh process knows nothing about any bus's lap: without a warm
 * start a bus carries no `lap` until it completes a loop AND departs a fitted
 * stop again — on Red up to an hour, and only at two stops. This app deploys
 * several times a day, so the correction would be inert for a lap after every
 * one of them. Measured on production at 18:26 ET on 2026-09-10, minutes after
 * #206 shipped: `lapB` served on both Red cells, and `lap` on **0 of 13** live
 * buses.
 *
 * Same failure as report #100 (`seedStationaryFromHistory`) and as PR #81
 * (served, live and inert). Same fix: the data is already on disk.
 */
describe("the lap clock is warm-started from history", () => {
  const allStops: Stop[] = JSON.parse(
    readFileSync(new URL("../server/__fixtures__/stops.json", import.meta.url), "utf8"),
  ) as Stop[];
  const byId = new Map(allStops.map((s) => [s.id, s]));
  const stops = BLUE_DAY.map((id) => byId.get(id)!);
  const routes: Route[] = [
    { id: 1, name: "Blue - Weekday Daytime", shortName: "BD", color: "#1565C0", stops: BLUE_DAY },
  ];

  class StubUpstream extends UpstreamClient {
    constructor() { super({ baseUrl: "http://invalid.test" }); }
    override async buses(): Promise<RawBus[]> { return []; }
    override async stops(): Promise<Stop[]> { return stops; }
    override async routes(): Promise<Route[]> { return routes; }
  }

  let tmpDir: string;
  let bundle: DbBundle;
  let collector: Collector;

  const DAY = 24 * 3600_000;
  /** Red / 344 Winchester — a cell the rollout gate actually serves. */
  const ROUTE = 3, STOP = 11;
  const LOOP = 3600_000;

  /**
   * Ninety days of `arrivals` at one cell with a real slope, so the calibrator
   * has a fit to seed against at all. The seed only visits cells the fitter
   * serves; a cell with no fit is not worth a query.
   */
  function history(endMs: number): void {
    const insert = bundle.sqlite.prepare(
      "INSERT INTO arrivals (bus_id, bus_name, route_id, stop_id, arrived_at, departed_at, dwell_sec, dow, hour) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const tx = bundle.sqlite.transaction(() => {
      for (let d = 20; d >= 1; d--) {
        for (const bus of ["#304", "#310", "#316"]) {
          let t = endMs - d * DAY + Number(bus.slice(1)) * 1000;
          for (let i = 0; i < 10; i++) {
            const lap = LOOP + (rnd() - 0.5) * 1_200_000;
            const stand = Math.max(30_000, 600_000 - 0.5 * (lap - LOOP) + (rnd() - 0.5) * 120_000);
            const arrived = t + lap;
            const dt = new Date(arrived);
            insert.run(1, bus, ROUTE, STOP, arrived, arrived + stand, stand / 1000, dt.getDay(), dt.getHours());
            t = arrived + stand;
          }
        }
      }
    });
    tx();
  }

  /** One recent departure per bus, `agoMs` before now. */
  function recentDeparture(busName: string, agoMs: number): number {
    const departed = Date.now() - agoMs;
    const arrived = departed - 300_000;
    const dt = new Date(arrived);
    bundle.sqlite
      .prepare(
        "INSERT INTO arrivals (bus_id, bus_name, route_id, stop_id, arrived_at, departed_at, dwell_sec, dow, hour) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(1, busName, ROUTE, STOP, arrived, departed, 300, dt.getDay(), dt.getHours());
    return departed;
  }

  async function boot(): Promise<Collector> {
    collector = await Collector.create(bundle, { upstream: new StubUpstream() });
    await collector.start();
    return collector;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-lapseed-"));
    bundle = openDb(path.join(tmpDir, "test.db"));
    migrate(bundle.db, { migrationsFolder: "./drizzle" });
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-10T22:26:00Z"));
    history(Date.now());
  });

  afterEach(() => {
    collector.stop();
    vi.useRealTimers();
    bundle.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("answers immediately for a bus whose last departure is on disk", async () => {
    const departed = recentDeparture("#304", 40 * 60_000);
    const c = await boot();
    const ages = c.lapAges("#304", Date.now());
    expect(ages).toBeDefined();
    expect(ages![String(STOP)]).toBe(Math.round((Date.now() - departed) / 1000));
  });

  it("seeds every bus at the cell, not just one", async () => {
    recentDeparture("#304", 40 * 60_000);
    recentDeparture("#310", 12 * 60_000);
    const c = await boot();
    expect(c.lapAges("#304", Date.now())).toBeDefined();
    expect(c.lapAges("#310", Date.now())).toBeDefined();
    expect(c.lapAges("#999", Date.now())).toBeUndefined();
  });

  it("does not reach back past the clock's TTL", async () => {
    // A gap this long is outside every cell's band, so the client would ignore
    // it anyway — seeding it would only cost a wire field that means nothing.
    recentDeparture("#316", 3 * 60 * 60_000);
    const c = await boot();
    expect(c.lapAges("#316", Date.now())).toBeUndefined();
  });

  it("keeps the LIVE departure, not the seeded one, once the bus is seen leaving", async () => {
    recentDeparture("#304", 40 * 60_000);
    const c = await boot();
    const before = c.lapAges("#304", Date.now())![String(STOP)]!;
    (c as unknown as { noteDeparture(b: string, s: number, t: number): void })
      .noteDeparture("#304", STOP, Date.now() - 60_000);
    expect(c.lapAges("#304", Date.now())![String(STOP)]).toBe(60);
    expect(before).toBeGreaterThan(60);
  });

  it("costs the collector nothing when there is no history to read", async () => {
    // An empty cell is a genuinely cold start: no lap is served, the client
    // prices every stand exactly as before, and the collector still boots.
    bundle.sqlite.prepare("DELETE FROM arrivals").run();
    const c = await boot();
    expect(c.lapAges("#304", Date.now())).toBeUndefined();
    expect(c.getLiveBuses()).toEqual([]);
  });
});
