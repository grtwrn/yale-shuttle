import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DbBundle } from "../db/client.js";
import { legs, routes as dbRoutes, segments, stops as dbStops, stopVisits } from "../db/schema.js";
import type { Route, Stop } from "../schema/api.js";
import type { TransitNetwork } from "../network/TransitNetwork.js";
import { Collector } from "./collector.js";
import { UpstreamClient, type RawBus } from "./upstream.js";

const NOW = Date.parse("2026-10-17T20:00:00Z");
const stops: Stop[] = [
  { id: 10, name: "First", lat: 41.3, lon: -72.9 },
  { id: 11, name: "Next", lat: 41.301, lon: -72.9 },
];
const route: Route = { id: 1, name: "Test line", shortName: "T", color: "#1565C0", stops: [10, 11] };
type Mode = "fresh" | "empty" | "unavailable";
type Inner = { calibrateNetwork(network: TransitNetwork): unknown };
let bundle: DbBundle;
let collector: Collector | undefined;
let mode: Mode;
let readyAtFirstPoll: unknown[];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

class Stub extends UpstreamClient {
  constructor() { super({ baseUrl: "http://invalid.test" }); }
  override async stops() {
    if (mode === "unavailable") throw new Error("static feed unavailable");
    return mode === "empty" ? [] : stops;
  }
  override async routes() { return mode === "empty" ? [] : [route]; }
  override async announcements() { return []; }
  override async buses(): Promise<RawBus[]> {
    const network = collector!.ref.get();
    readyAtFirstPoll.push({
      dwell: structuredClone(network.getDwellStats(1, 10)),
      segment: structuredClone(network.getSegmentStats(1, 10, 11)),
    });
    return [];
  }
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  bundle = openDb(":memory:"); migrate(bundle.db, { migrationsFolder: "./drizzle" });
  bundle.db.insert(dbStops).values(stops.map(s => ({ ...s, updatedAt: new Date(NOW) }))).run();
  bundle.db.insert(dbRoutes).values({ ...route, stopsJson: JSON.stringify(route.stops), updatedAt: new Date(NOW) }).run();
  for (let i = 0; i < 10; i++) {
    const at = NOW - 86_400_000 - i * 120_000, stopped = i < 8, date = new Date(at);
    bundle.db.insert(stopVisits).values({
      busId: 1, busName: "#test", anchorBusId: 1, routeId: 1, stopId: 10, stopIndex: 0,
      anchoredAt: new Date(at - 5_000), pinnedAt: stopped ? date : null,
      arrivedAt: stopped ? date : null, departedAt: stopped ? new Date(at + 30_000) : null,
      standSec: stopped ? 30 : 0, insideSec: stopped ? 30 : null,
      outcome: stopped ? "stopped" : "passed", how: stopped ? "far" : null,
      confidence: stopped ? 1 : null, steps: stopped ? 4 : 0, restPolls: stopped ? 6 : 0,
      shuffles: 0, closestM: stopped ? 5 : 200, dow: date.getDay(), hour: date.getHours(),
    }).run();
    if (stopped) {
      bundle.db.insert(legs).values({
        busId: 1, busName: "#test", routeId: 1, fromStopId: 10, fromIndex: 0, toStopId: 11, toIndex: 1,
        hops: 1, departedAt: date, arrivedAt: new Date(at + 60_000), toPinnedAt: new Date(at + 60_000),
        legSec: 60, driveSec: 60, holdSec: 0, holds: 0, reached: true, dow: date.getDay(), hour: date.getHours(),
      }).run();
      bundle.db.insert(segments).values({
        busId: 1, busName: "#test", routeId: 1, fromStopId: 10, toStopId: 11,
        startedAt: new Date(at - 30_000), travelSec: 90, dow: date.getDay(), hour: date.getHours(),
      }).run();
    }
  }
  mode = "fresh"; readyAtFirstPoll = []; vi.clearAllMocks();
});
afterEach(() => { collector?.stop(); collector = undefined; bundle.sqlite.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

function expectReady() {
  expect(readyAtFirstPoll[0]).toMatchObject({
    dwell: { qn: 8, q: Array(10).fill(30), pstop: 0.8 },
    segment: { drive: 60, driveN: 8, dq: Array(10).fill(60), dqn: 8 },
  });
}

describe("collector startup calibration", () => {
  it("calibrates fresh topology once and has complete tables before its first bus poll", async () => {
    collector = await Collector.create(bundle, { upstream: new Stub(), logger });
    const calibrate = vi.spyOn(collector as unknown as Inner, "calibrateNetwork");
    await collector.start();
    expectReady();
    expect(calibrate).toHaveBeenCalledTimes(1);
  });

  it.each<Mode>(["empty", "unavailable"])("calibrates the cached network when the static feed is %s", async failure => {
    mode = failure;
    collector = await Collector.create(bundle, { upstream: new Stub(), logger });
    const cached = collector.ref.get(), calibrate = vi.spyOn(collector as unknown as Inner, "calibrateNetwork");
    await collector.start();
    expectReady();
    expect(collector.ref.get()).toBe(cached);
    expect(calibrate).toHaveBeenCalledTimes(1);
  });

  it("warms the cached network if calibration of the rebuilt topology fails", async () => {
    collector = await Collector.create(bundle, { upstream: new Stub(), logger });
    const cached = collector.ref.get(), inner = collector as unknown as Inner;
    const original = inner.calibrateNetwork.bind(inner);
    const calibrate = vi.spyOn(inner, "calibrateNetwork").mockImplementationOnce(() => { throw new Error("rebuilt calibration failed"); });
    calibrate.mockImplementation(network => original(network));
    await collector.start();
    expectReady();
    expect(collector.ref.get()).toBe(cached);
    expect(calibrate).toHaveBeenCalledTimes(2);
  });

  it("continues the five-minute calibration after the single startup pass", async () => {
    collector = await Collector.create(bundle, { upstream: new Stub(), logger });
    const calibrate = vi.spyOn(collector as unknown as Inner, "calibrateNetwork");
    await collector.start();
    expectReady();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calibrate).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
