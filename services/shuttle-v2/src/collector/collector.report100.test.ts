import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import type { BusPosition, Route, Stop } from "../schema/api.js";

import { Collector } from "./collector.js";
import {
  BLUE_DAY,
  CEDAR_333,
  FEED,
  NEXT_STOP,
  RESTARTS,
  RESTING,
  STAND_BEGAN,
  T0,
} from "./__fixtures__/report100-cedar-stand.js";
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
  const byId = new Map(allStops.map((s) => [s.id, s]));
  const stops = BLUE_DAY.map((id) => byId.get(id)!);
  const routes: Route[] = [
    { id: 1, name: "Blue - Weekday Daytime", shortName: "BD", color: "#1565C0", stops: BLUE_DAY },
  ];

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

/**
 * The half report #100 left behind: one stand, one arrival, one full-length
 * stand measurement.
 *
 * PR #129 recovered the rider-visible clock and deliberately stopped there —
 * seeding `enteredAt` moves calibration, so it wanted a measurement first. It
 * has one now. Over the seven days to 2026-09-04, 1,486 stands in `arrivals`
 * were split by a restart (1,719 duplicate rows, 4.3% of every arrival), and
 * because `stop_visits.pinned_at` is where the served stand table measures from
 * (`departed_at − pinned_at`), each split fed the quantiles the piece AFTER the
 * restart instead of the stand. On the two routes whose tables riders are
 * actually served, the medians were short by: 344 Winchester (3:11) 273 s
 * against 310 s, Winchester / Mansfield (3:121) 383 against 479, and 333 Cedar
 * itself (1:10) 405 against 475.
 *
 * So this replays #44's own stand through FOUR fresh Collector processes — the
 * boot plus the three restarts the holes in the feed record — against one
 * database, and asks for the row a single uninterrupted process would have
 * written. On master that replay produces four arrival rows and a 40 s stand;
 * the stand it is measuring lasted 375 s.
 */
describe("report #100: four restarts through one stand leave one arrival row", () => {
  const allStops: Stop[] = JSON.parse(
    readFileSync(new URL("../server/__fixtures__/stops.json", import.meta.url), "utf8"),
  ) as Stop[];
  const byId = new Map(allStops.map((s) => [s.id, s]));
  const stops = BLUE_DAY.map((id) => byId.get(id)!);
  const routes: Route[] = [
    { id: 1, name: "Blue - Weekday Daytime", shortName: "BD", color: "#1565C0", stops: BLUE_DAY },
  ];
  const cedarCongress = byId.get(NEXT_STOP)!;

  /** Where the bus is at `T0 + ms`: the recorded feed, then the drive onward. */
  let position = { lat: FEED[0]![1], lon: FEED[0]![2] };

  class Playback extends UpstreamClient {
    constructor() {
      super({ baseUrl: "http://invalid.test" });
    }
    override async buses(): Promise<RawBus[]> {
      return [
        {
          id: 65959,
          name: "#44",
          lat: position.lat,
          lon: position.lon,
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
  let collector: Collector | null = null;

  type Internals = {
    runPoll: () => Promise<void>;
    refreshStaticIfNeeded: (force: boolean) => Promise<void>;
  };

  /** Start a fresh process against the same database — what a deploy does. */
  async function boot(): Promise<void> {
    collector?.stop();
    collector = await Collector.create(bundle, { upstream: new Playback() });
    await (collector as unknown as Internals).refreshStaticIfNeeded(true);
  }

  async function pollAt(ms: number, lat: number, lon: number): Promise<void> {
    position = { lat, lon };
    vi.setSystemTime(T0 + ms);
    await (collector as unknown as Internals).runPoll();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-report100-stand-"));
    bundle = openDb(path.join(tmpDir, "test.db"));
    migrate(bundle.db, { migrationsFolder: "./drizzle" });
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    collector?.stop();
    collector = null;
    vi.useRealTimers();
    bundle.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Replay the whole stand, restarting the process under each of the three
   * holes, then drive the bus to the next stop so the stand closes.
   *
   * The stand cannot be measured while it is still running: the dwell patch and
   * the `stop_visits` row are both written on the anchor transition.
   */
  async function replayWithRestarts(): Promise<void> {
    await boot();
    for (const [ms, lat, lon] of FEED) {
      if (RESTARTS.includes(ms)) await boot();
      await pollAt(ms, lat, lon);
    }
    // Cedar / Congress, the next stop on the line. Four polls: one to open the
    // candidate, the rest to let the detector settle its new anchor.
    const last = FEED[FEED.length - 1]![0];
    for (let i = 1; i <= 4; i++) {
      await pollAt(last + i * 5_000, cedarCongress.lat, cedarCongress.lon);
    }
  }

  const arrivalsAtCedar = () =>
    bundle.sqlite
      .prepare(
        "SELECT arrived_at AS arrivedAt, departed_at AS departedAt, dwell_sec AS dwellSec " +
          "FROM arrivals WHERE bus_name = '#44' AND stop_id = ? ORDER BY arrived_at",
      )
      .all(CEDAR_333) as Array<{
        arrivedAt: number;
        departedAt: number | null;
        dwellSec: number | null;
      }>;

  const visitsAtCedar = () =>
    bundle.sqlite
      .prepare(
        "SELECT anchored_at AS anchoredAt, pinned_at AS pinnedAt, arrived_at AS arrivedAt, " +
          "departed_at AS departedAt, stand_sec AS standSec, outcome " +
          "FROM stop_visits WHERE bus_name = '#44' AND stop_id = ? ORDER BY anchored_at",
      )
      .all(CEDAR_333) as Array<{
        anchoredAt: number;
        pinnedAt: number | null;
        arrivedAt: number | null;
        departedAt: number | null;
        standSec: number | null;
        outcome: string;
      }>;

  it("writes one arrival for the stand, not one per restart", async () => {
    await replayWithRestarts();
    const rows = arrivalsAtCedar();
    // Production wrote four for this very stand: 15:53:39, 15:55:11, 15:56:53,
    // 15:59:14 — the original and one per restart.
    expect(rows).toHaveLength(1);
    // ...and it is the row the FIRST process opened, closed by the departure.
    expect(rows[0]!.arrivedAt).toBeLessThanOrEqual(T0 + STAND_BEGAN);
    expect(rows[0]!.departedAt).not.toBeNull();
    expect(rows[0]!.dwellSec).not.toBeNull();
  });

  it("measures the whole stand, not the piece after the last restart", async () => {
    await replayWithRestarts();
    const visits = visitsAtCedar();
    expect(visits).toHaveLength(1);
    const v = visits[0]!;
    expect(v.outcome).toBe("stopped");
    // `pinned_at` is what the served stand table measures from, and it is the
    // poll the bus first came within AT_STOP_PIN_M — recovered from
    // `raw_positions`, not the last restart at +353684.
    expect(v.pinnedAt).toBe(T0 + STAND_BEGAN);
    expect(v.arrivedAt).toBe(T0 + STAND_BEGAN);
    // The whole stand. `departedAt` is the last poll at the resting fix before
    // the 30 m creep to the kerb (+393792): the recorded feed ends three polls
    // into that creep, which is one short of the three the reducer needs to
    // call it a shuffle rather than a departure — so the drive-away confirms
    // against the pre-creep plateau. Master, measuring from the last restart at
    // +353684 instead of from the pin, would have called this stand 40 s.
    const standSec = (v.departedAt! - v.pinnedAt!) / 1000;
    expect(standSec).toBeCloseTo(374.95, 2);
    expect(v.standSec).toBeCloseTo(374.95, 2);
    // Which is what a single uninterrupted process would have written, and
    // nine times what four processes did.
    expect(standSec / ((v.departedAt! - (T0 + RESTARTS[2]!)) / 1000)).toBeGreaterThan(9);
  });

  it("publishes the recovered wait through every restart, with the stop named", async () => {
    await boot();
    const seen: Array<{ ms: number; atStopId: number | null; atStopSince: number | null }> = [];
    for (const [ms, lat, lon] of FEED) {
      if (RESTARTS.includes(ms)) await boot();
      await pollAt(ms, lat, lon);
      // From the first restart on. Before it the ordinary 15 s warm-up is
      // running, and that gate is correct on a genuine arrival — the defect is
      // only that a restart used to re-run it.
      if (ms >= RESTARTS[0]!) {
        const live = collector!.getLiveBuses()[0]!;
        seen.push({ ms, atStopId: live.atStopId, atStopSince: live.atStopSince });
      }
    }
    // A restart used to withhold `at_stop_id` for 15 s, because that gate is
    // measured from `enteredAt` — which the resumed row now supplies. Every
    // poll from the moment the bus is pinned names the stop.
    expect(seen.filter((s) => s.atStopId !== CEDAR_333)).toEqual([]);
    // ...and every one of them reports the same wait, the real one.
    expect([...new Set(seen.map((s) => s.atStopSince))]).toEqual([T0 + STAND_BEGAN]);
  });

  it("still opens a new visit for a bus that only LOOKS like the same stand", async () => {
    // The guard: a stand that ended is not resumable. Here the bus stands,
    // drives away to the next stop, comes back and stands again — the second
    // stand must get its own arrival row, because the first one closed.
    await boot();
    for (const [ms, lat, lon] of FEED) await pollAt(ms, lat, lon);
    const last = FEED[FEED.length - 1]![0];
    for (let i = 1; i <= 4; i++) await pollAt(last + i * 5_000, cedarCongress.lat, cedarCongress.lon);
    // Back at Cedar, with the process restarted under it.
    await boot();
    for (let i = 5; i <= 10; i++) await pollAt(last + i * 5_000, RESTING.lat, RESTING.lon);

    const rows = arrivalsAtCedar();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.departedAt).not.toBeNull();
    expect(rows[1]!.arrivedAt).toBeGreaterThan(rows[0]!.departedAt!);
  });
});
