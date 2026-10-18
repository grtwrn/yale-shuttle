import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route } from "../schema/api.js";
import { openDb } from "../db/client.js";
import { Collector } from "./collector.js";
import { UpstreamClient, type RawBus } from "./upstream.js";
import { stepManyWithVisits } from "./departure.js";
import fixture from "./__fixtures__/route15-shortcut-20261014.json";

async function collect(restartAt?: number) {
  const bundle = openDb(":memory:");
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
  let latest = fixture.observations[0]!, collector: Collector | undefined;
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
    vi.setSystemTime(latest.collectedAt);
    collector = await Collector.create(bundle, options);
    await (collector as unknown as Inner).refreshStaticIfNeeded(true);
    for (const obs of fixture.observations) {
      latest = obs; vi.setSystemTime(obs.collectedAt);
      if (obs.collectedAt === restartAt) {
        collector.stop(); collector = await Collector.create(bundle, options);
      }
      await (collector as unknown as Inner).runPoll();
      positions.push({ at: obs.collectedAt, buses: collector.getLiveBuses() });
    }
    expect(errors).not.toHaveBeenCalled();
    return { positions, arrivals: bundle.sqlite.prepare("SELECT * FROM arrivals ORDER BY id").all(),
      visits: bundle.sqlite.prepare("SELECT * FROM stop_visits ORDER BY id").all(),
      legs: bundle.sqlite.prepare("SELECT * FROM legs ORDER BY id").all(),
      segments: bundle.sqlite.prepare("SELECT * FROM segments ORDER BY id").all() };
  } finally { collector?.stop(); vi.useRealTimers(); bundle.sqlite.close(); }
}

describe("observed shortcuts away from a published approach", () => {
  it("keeps the Howe/Edgewood pin and resting plateau when the bus bypasses Chapel/Dwight", () => {
    const network = TransitNetwork.build(fixture.stops, [fixture.route as Route]);
    const states = new Map(), visitStates = new Map();
    const events = fixture.observations.flatMap(obs => stepManyWithVisits(network, states, visitStates, [obs]).visits);
    const visits = events.filter(e => e.kind === "visit" && e.stopId === 155);
    expect(visits).toEqual([expect.objectContaining({
      pinnedAt: fixture.provenance.sourceRow.pinned_at,
      arrivedAt: fixture.provenance.sourceRow.arrived_at,
      departedAt: fixture.provenance.sourceRow.departed_at,
      standSec: fixture.provenance.sourceRow.stand_sec,
    })]);
  });

  it.each([
    fixture.observations.find(o => o.collectedAt > 1792005864297)!.collectedAt,
    fixture.observations.find(o => o.collectedAt > 1792005954202)!.collectedAt,
  ])("preserves source rows and every live clock through a collector restart at %s", async at => {
    const uninterrupted = await collect();
    expect(uninterrupted.visits).toContainEqual(expect.objectContaining({ stop_id: 155,
      pinned_at: fixture.provenance.sourceRow.pinned_at, arrived_at: fixture.provenance.sourceRow.arrived_at,
      departed_at: fixture.provenance.sourceRow.departed_at, stand_sec: fixture.provenance.sourceRow.stand_sec }));
    expect(await collect(at)).toEqual(uninterrupted);
  });
});
