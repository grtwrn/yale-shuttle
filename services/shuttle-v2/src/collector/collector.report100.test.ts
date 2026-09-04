import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import type { BusPosition, Route, Stop } from "../schema/api.js";

import { Collector } from "./collector.js";
import { UpstreamClient, type RawBus } from "./upstream.js";

/**
 * Report #100, end to end: the wiring, not the rule.
 *
 * `detector.report100.test.ts` pins the reconstruction itself against the real
 * feed. This one asks the only question that file cannot: does a REAL collector,
 * started fresh against a database that already holds the bus standing there,
 * publish the wait it can recover — or the zero the rider saw?
 */
describe("report #100: a restarted collector recovers the wait it can read", () => {
  const allStops: Stop[] = JSON.parse(
    readFileSync(new URL("../server/__fixtures__/stops.json", import.meta.url), "utf8"),
  ) as Stop[];
  // Production `routes.stops_json` for route 1 (Blue - Weekday Daytime).
  const BLUE_DAY = [
    106, 34, 101, 47, 100, 102, 105, 69, 139, 136, 130, 129, 140, 133, 135, 138,
    97, 118, 42, 98, 38, 39, 72, 43, 10, 2, 5, 52, 41, 20, 108,
  ];
  const byId = new Map(allStops.map((s) => [s.id, s]));
  const stops = BLUE_DAY.map((id) => byId.get(id)!);
  const routes: Route[] = [
    { id: 1, name: "Blue - Weekday Daytime", shortName: "BD", color: "#1565C0", stops: BLUE_DAY },
  ];

  const CEDAR_333 = 10;
  /** #44's real resting coordinate, 35 m short of the 333 Cedar sign. */
  const RESTING = { lat: 41.302953, lon: -72.934122 };

  class StubUpstream extends UpstreamClient {
    constructor() {
      super({ baseUrl: "http://invalid.test" });
    }
    override async buses(): Promise<RawBus[]> {
      return [
        {
          id: 65959,
          name: "#44",
          lat: RESTING.lat,
          lon: RESTING.lon,
          heading: 337,
          route: 1,
          lastStop: 43,
        } as RawBus,
      ];
    }
    override async stops(): Promise<Stop[]> {
      return stops;
    }
    override async routes(): Promise<Route[]> {
      return routes;
    }
  }

  let tmpDir: string;
  let bundle: DbBundle;
  let collector: Collector;

  type Internals = {
    runPoll: () => Promise<void>;
    refreshStaticIfNeeded: (force: boolean) => Promise<void>;
  };

  /** History as `raw_positions` holds it: the bus already standing at the kerb. */
  function recordStandSince(startedAt: number, until: number): void {
    const insert = bundle.sqlite.prepare(
      "INSERT INTO raw_positions (bus_id, bus_name, route_id, lat, lon, heading, last_stop_id, collected_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let t = startedAt; t <= until; t += 5_000) {
      insert.run(65959, "#44", 1, RESTING.lat, RESTING.lon, 337, 43, t);
    }
  }

  async function bootAndPoll(): Promise<BusPosition> {
    collector = await Collector.create(bundle, { upstream: new StubUpstream() });
    const inner = collector as unknown as Internals;
    await inner.refreshStaticIfNeeded(true);
    // Four polls: `updateLivePositions` publishes `at_stop_id` only once the
    // bus has been anchored for 15 s, which after a restart is measured afresh.
    for (let i = 0; i < 4; i++) {
      await inner.runPoll();
      vi.setSystemTime(Date.now() + 5_000);
    }
    const live = collector.getLiveBuses();
    expect(live).toHaveLength(1);
    return live[0]!;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-report100-"));
    bundle = openDb(path.join(tmpDir, "test.db"));
    migrate(bundle.db, { migrationsFolder: "./drizzle" });
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-04T15:56:53.903Z"));
  });

  afterEach(() => {
    collector.stop();
    vi.useRealTimers();
    bundle.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("publishes the wait that began before this process existed", async () => {
    const boot = Date.now();
    const standBegan = boot - 194_000; // 15:53:39.903, where #44's stand really started
    recordStandSince(standBegan, boot - 5_000);

    const bus = await bootAndPoll();
    expect(bus.atStopId).toBe(CEDAR_333);
    expect(bus.atStopSince).toBe(standBegan);
    // Not the restart, which is what the rider's payload carried.
    expect(bus.atStopSince).not.toBe(boot);
  });

  it("starts the wait now when it has nothing to read", async () => {
    // An empty database is a genuinely new sighting; there is nothing to recover
    // and the clock must not invent a wait.
    const boot = Date.now();
    const bus = await bootAndPoll();
    expect(bus.atStopId).toBe(CEDAR_333);
    expect(bus.atStopSince).toBe(boot);
  });

  it("does not reach back across a feed absence", async () => {
    // The bus stood here, went off the air for four minutes, and is back. The
    // running rules would have re-anchored it, so the seed must not claim the
    // earlier wait.
    const boot = Date.now();
    recordStandSince(boot - 600_000, boot - 240_000);

    const bus = await bootAndPoll();
    expect(bus.atStopId).toBe(CEDAR_333);
    expect(bus.atStopSince).toBe(boot);
  });
});
