import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { TransitNetwork } from "../network/TransitNetwork.js";
import { distanceMeters } from "../network/geo.js";
import type { Route, Stop } from "../schema/api.js";
import { step, type BusState } from "./detector.js";
import { stepManyWithVisits, type StopVisitEvent } from "./departure.js";
import { openDb } from "../db/client.js";
import { Collector } from "./collector.js";
import { UpstreamClient, type RawBus } from "./upstream.js";
import fixture from "./__fixtures__/blue-night-moving-detour-20261014.json";

const network = () => TransitNetwork.build(structuredClone(fixture.stops) as Stop[], [structuredClone(fixture.route) as Route]);

async function collect(capture: typeof fixture.cases[number], restartAt?: number) {
  const bundle = openDb(":memory:"); migrate(bundle.db, { migrationsFolder: "./drizzle" });
  let latest = capture.observations[0]!, collector: Collector | undefined;
  class Stub extends UpstreamClient {
    constructor() { super({ baseUrl: "http://invalid.test" }); }
    override async stops() { return fixture.stops; }
    override async routes() { return [fixture.route as Route]; }
    override async buses(): Promise<RawBus[]> {
      return [{ id: latest.busId, name: latest.busName, route: latest.routeId, lat: latest.lat,
        lon: latest.lon, heading: latest.heading, lastStop: latest.lastStopId } as RawBus];
    }
  }
  const errors = vi.fn(), options = { upstream: new Stub(), upstreamEta: false, etaSampler: false,
    logger: { info() {}, warn() {}, error: errors } };
  type Inner = { refreshStaticIfNeeded(force: boolean): Promise<void>; runPoll(): Promise<void> };
  const positions: Array<{ at: number; buses: ReturnType<Collector["getLiveBuses"]> }> = [];
  vi.useFakeTimers();
  try {
    vi.setSystemTime(latest.collectedAt); collector = await Collector.create(bundle, options);
    await (collector as unknown as Inner).refreshStaticIfNeeded(true);
    for (const obs of capture.observations) {
      latest = obs; vi.setSystemTime(obs.collectedAt);
      if (obs.collectedAt === restartAt) { collector.stop(); collector = await Collector.create(bundle, options); }
      await (collector as unknown as Inner).runPoll(); positions.push({ at: obs.collectedAt, buses: collector.getLiveBuses() });
    }
    expect(errors).not.toHaveBeenCalled();
    return { positions, arrivals: bundle.sqlite.prepare("SELECT * FROM arrivals ORDER BY id").all(),
      visits: bundle.sqlite.prepare("SELECT * FROM stop_visits ORDER BY id").all(),
      legs: bundle.sqlite.prepare("SELECT * FROM legs ORDER BY id").all(),
      segments: bundle.sqlite.prepare("SELECT * FROM segments ORDER BY id").all() };
  } finally { collector?.stop(); vi.useRealTimers(); bundle.sqlite.close(); }
}

describe("moving fixes before a real intervening route detour", () => {
  it.each(fixture.cases)("keeps one Wall/York then Gym then Elm/York encounter in source interval $name", capture => {
    const net = network(), states = new Map(), visits = new Map();
    const events = capture.observations.flatMap(obs => stepManyWithVisits(net, states, visits, [obs]).visits);
    const calls = events.filter((e): e is StopVisitEvent => e.kind === "visit" && [67, 96, 53].includes(e.stopId));
    expect(calls.map(e => e.stopId)).toEqual([67, 96, 53]);
    expect(calls.find(e => e.stopId === 53)).toMatchObject({
      pinnedAt: capture.realCall.pinned_at, arrivedAt: capture.realCall.arrived_at,
      departedAt: capture.realCall.departed_at, standSec: capture.realCall.stand_sec,
    });
    expect(calls.find(e => e.stopId === 67)).toMatchObject({ departedAt: capture.wallCall.departed_at });
  });

  it.each(fixture.cases)("keeps all source rows and live clocks through approach and curb restarts in $name", async capture => {
    const expected = await collect(capture);
    expect(expected.visits).toContainEqual(expect.objectContaining({ stop_id: 53,
      pinned_at: capture.realCall.pinned_at, arrived_at: capture.realCall.arrived_at,
      departed_at: capture.realCall.departed_at, stand_sec: capture.realCall.stand_sec }));
    for (const at of [capture.falseApproach.anchored_at, capture.wallCall.pinned_at, capture.realCall.pinned_at]) {
      expect(await collect(capture, at!)).toEqual(expected);
    }
  });

  function beforeSkip() {
    const capture = fixture.cases[0]!, net = network();
    let state: BusState | null = null;
    for (const obs of capture.observations) {
      if (obs.collectedAt >= capture.falseApproach.anchored_at) break;
      state = step(net, state, obs).state;
    }
    expect(state?.nearestStopId).toBe(67);
    const obs = capture.observations.find(o => o.collectedAt === capture.falseApproach.anchored_at)!;
    expect(distanceMeters(state!, obs)).toBeGreaterThan(8);
    expect(distanceMeters(net.stops.get(67)!, net.stops.get(53)!)).toBeGreaterThan(75);
    return { net, state: state!, obs };
  }

  it("does not jump past the Gym on the next moving five-second fix", () => {
    const { net, state, obs } = beforeSkip();
    const result = step(net, state, obs);
    expect(result.state?.nearestStopId).toBe(67); expect(result.events).toEqual([]);
  });

  it("allows the same coordinates after a gap long enough for the detour", () => {
    const { net, state, obs } = beforeSkip();
    expect(step(net, state, { ...obs, collectedAt: state.lastObservedAt + 180000 }).state?.nearestStopId).toBe(53);
  });

  it("withholds the detour constraint if the intermediate marker is missing", () => {
    const { net, state, obs } = beforeSkip(); (net.stops as Map<number, Stop>).delete(96);
    expect(step(net, state, obs).state?.nearestStopId).toBe(53);
  });

  it("still permits a genuinely short two-hop journey between markers more than75m apart", () => {
    const stops: Stop[] = [
      { id: 1, name: "A", lat: 41.31, lon: -72.93 },
      { id: 2, name: "B", lat: 41.3107, lon: -72.93 },
      { id: 3, name: "C", lat: 41.3114, lon: -72.93 },
    ];
    const net = TransitNetwork.build(stops, [{ id: 1, name: "Line", shortName: "L", color: "#000", stops: [1, 2, 3] }]);
    const first = { busId: 1, busName: "#1", routeId: 1, collectedAt: 1000000, lat: stops[0]!.lat, lon: stops[0]!.lon, heading: 0, lastStopId: 1 };
    const state = step(net, null, first).state!;
    const result = step(net, state, { ...first, lat: stops[2]!.lat, collectedAt: first.collectedAt + 5000 });
    expect(result.state?.nearestStopId).toBe(3);
    expect(result.events.some(e => e.kind === "arrival" && e.stopId === 3)).toBe(true);
  });
});
