/**
 * The server-side belief's contract: it is ON by default, it cannot break the
 * poll, it keys on the bus NAME, and it lets go of a bus that stops reporting.
 *
 * The parity test (`serverEta.parity.test.ts`) is the deliverable; this file is
 * the safety net around it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from 'node:zlib';

import { Collector } from "../collector/collector.js";
import type { RawBus, UpstreamClient } from "../collector/upstream.js";
import { openDb, type DbBundle } from "../db/client.js";
import type { Route, Stop } from "../schema/api.js";
import { registerRoutePaths } from "../../web/src/anchor.js";
import type { DwellTimes, SegmentTimes } from "../../web/src/arrivals.js";
import type { LatLon } from "../../web/src/geo.js";
import type { BusData } from "../../web/src/map-data.js";
import { ROUTE_LISTS } from "../../web/src/routes.js";
import {
  BELIEF_EVICT_MS, DEFAULT_SERVER_ETA_ROUTES, ServerEta, serverEtaFromEnv,
  type EtaPayloadView,
} from "./serverEta.js";
import { buildBusesPayload, createBusesPayloadCache } from "./v1compat.js";
import { BLUE_K10_MODELS, blueK10GroupPredictions } from './blueK10Trial.js';
import { ADDITIONAL_K10_MODELS } from './routeK10Trial.js';
import type { K10Evidence } from '../collector/k10Clock.js';

// Read rather than `import ... from`: `resolveJsonModule` would have tsc infer
// a literal type for a quarter-megabyte of captured JSON on every typecheck.
const capture: unknown = JSON.parse(
  fs.readFileSync(new URL("./__fixtures__/live-frames.json", import.meta.url), "utf8"),
);

const CAP = capture as {
  static: {
    routes: Record<string, number[]>;
    route_paths: Record<string, [number, number][]>;
    stop_coords: Record<number, LatLon>;
    segments: SegmentTimes;
    dwells: DwellTimes;
  };
  frames: { t: number; buses: BusData[] }[];
};

function payloadFor(i: number): EtaPayloadView {
  return {
    buses: CAP.frames[i]!.buses,
    routes: CAP.static.routes,
    stop_coords: CAP.static.stop_coords,
    segments: CAP.static.segments,
    dwells: CAP.static.dwells,
    route_paths: CAP.static.route_paths,
  };
}

const ALL_ROUTES = ROUTE_LISTS.map((c) => c.label);

describe("the flag", () => {
  it('reads the displayed history origin without advancing belief and expires missing buses', () => {
    const engine = new ServerEta({ routes: ALL_ROUTES });
    const t = CAP.frames[0]!.t, payload = payloadFor(0);
    const wire = engine.contribute(payload, 1, t)!;
    const row = wire.rows.find(r => r[5] > 0)!;
    const bus = wire.buses[row[0]]!;
    const steps = engine.stats().steps;
    expect(engine.historyPosition(bus[1], bus[0], row[1], row[2], t)).toMatchObject({ index: bus[2], stopsAhead: row[5] });
    expect(engine.stats().steps).toBe(steps);
    expect(engine.historyPosition(bus[1], bus[0], row[1], row[2], t + 45_000)).toBeNull();
    engine.contribute({ ...payload, buses: [] }, 1, t + 1000);
    expect(engine.historyPosition(bus[1], bus[0], row[1], row[2], t + 1000)).toBeNull();
  });
  it("runs by default and can explicitly withhold forecasts", () => {
    expect(serverEtaFromEnv({} as NodeJS.ProcessEnv)).toBeInstanceOf(ServerEta);
    expect(serverEtaFromEnv({ SHUTTLE_SERVER_ETA: "0" } as unknown as NodeJS.ProcessEnv)).toBeNull();

  });

  it("serves all supported lines by default", () => {
    const on = serverEtaFromEnv({ SHUTTLE_SERVER_ETA: "1" } as unknown as NodeJS.ProcessEnv)!;
    expect(on.servedRoutes()).toEqual([...DEFAULT_SERVER_ETA_ROUTES]);
    expect(on.servedRoutes()).toEqual(ALL_ROUTES);
    for (const label of on.servedRoutes()) {
      expect(ALL_ROUTES, `${label} is not a route`).toContain(label);
    }
  });

  it("takes an explicit list, and `*` for every line", () => {
    const env = (v: string) => serverEtaFromEnv(
      { SHUTTLE_SERVER_ETA: "1", SHUTTLE_SERVER_ETA_ROUTES: v } as unknown as NodeJS.ProcessEnv,
    )!;
    expect(env("Red").servedRoutes()).toEqual(["Red"]);
    expect(env(" Red , Green ").servedRoutes()).toEqual(["Red", "Green"]);
    expect(env("*").servedRoutes()).toEqual(ALL_ROUTES);
  });
});

describe("the served answer", () => {
  beforeEach(() => registerRoutePaths(CAP.static.route_paths));
  afterEach(() => registerRoutePaths(null));

  for (const model of [...BLUE_K10_MODELS, ...ADDITIONAL_K10_MODELS]) it(`serves ${model.label}'s updated and usual forecasts from one live step`, () => {
    // Use an observed, supported service-time clock. An arbitrary midday
    // departure is not representative of Blue West's operating history.
    const fixtureFile = model.routeId === 14 ? 'route-k10-parity.json.gz' : 'blue-k10-parity.json.gz';
    const cases = JSON.parse(gunzipSync(fs.readFileSync(new URL(`./__fixtures__/${fixtureFile}`, import.meta.url))).toString()) as
      { route: number; now: number; evidence: K10Evidence | null; expected: { changed: boolean } }[];
    const sample = cases.find(f => f.route === model.routeId && f.expected.changed
      && f.evidence?.index === model.waitIndex && f.evidence.phase === 'hold')!;
    expect(sample).toBeDefined();
    const now = sample.now, stopId = model.sequence[model.waitIndex]!;
    expect(blueK10GroupPredictions(model, sample.evidence!.origin.departed, now)).not.toBeNull();
    const bus: BusData = { bus_id: 99, bus_name: '#306', route_id: model.routeId,
      ...CAP.static.stop_coords[stopId]!, heading: 0, last_stop_id: stopId, observed_at: now,
      stationary: true, at_stop_id: stopId, at_stop_since: new Date(now - 60_000).toISOString(),
      stationary_since: new Date(now - 60_000).toISOString(), last_moved_at: new Date(now - 60_000).toISOString() };
    const payload = { ...payloadFor(0), routes: { ...CAP.static.routes, [model.routeId]: model.sequence }, buses: [bus] };
    const engine = new ServerEta({ routes: [model.label] });
    let released = false;
    engine.useK10Trial(at => new Map([['306', { routeId: model.routeId, index: model.waitIndex,
      phase: 'hold' as const, observedAt: at, origin: sample.evidence!.origin, released }]]));
    const usual = engine.contribute(payload, 1, now)!, updated = engine.contribute(payload, 1, now, true)!;
    expect(updated.trial!.byRoute![model.label]).toBeGreaterThan(0);
    expect(usual.trial).toBeUndefined(); expect(engine.stats().steps).toBe(1);
    const row = updated.rows.find(r => r[2] !== usual.rows.find(c => c[0] === r[0] && c[1] === r[1] && c[5] === r[5])![2])!;
    expect(engine.historyPosition(model.label, '306', row[1], row[2], now, true)).not.toBeNull();
    released = true;
    const next = { ...payload, buses: [{ ...bus, observed_at: now + 5000 }] };
    const live = engine.contribute(next, 2, now + 5000)!, handedOff = engine.contribute(next, 2, now + 5000, true)!;
    expect(handedOff.rows).toEqual(live.rows); expect(handedOff.distributions).toEqual(live.distributions);
    expect(engine.stats().steps).toBe(2);
  });

  it('serves both variants from one warm step and hands the trial back to the exact live wire', () => {
    const now = Date.parse('2026-09-21T16:00:00Z');
    const position = CAP.static.stop_coords[128]!;
    const bus: BusData = { bus_id: 99, bus_name: '#306', route_id: 3, ...position, heading: 0,
      last_stop_id: 128, observed_at: now, stationary: true, at_stop_id: 128,
      at_stop_since: new Date(now - 60_000).toISOString(),
      stationary_since: new Date(now - 60_000).toISOString(), last_moved_at: new Date(now - 60_000).toISOString() };
    const payload = { ...payloadFor(0), buses: [bus] };
    const engine = new ServerEta({ routes: ['Red'] });
    let released = false;
    engine.useK10Trial(at => new Map([['306', { index: 9, phase: 'hold' as const, observedAt: at,
      origin: { departed: now - 600_000, knownAt: now - 595_000 }, released }]]));
    const control = engine.contribute(payload, 1, now)!;
    const trial = engine.contribute(payload, 1, now, true)!;
    expect(trial.trial!.changedRows).toBeGreaterThan(0);
    expect(engine.stats().steps).toBe(1);
    expect(engine.contribute(payload, 1, now)).toEqual(control);
    expect(control.trial).toBeUndefined();
    const row = trial.rows.find(r => r[2] !== control.rows.find(c => c[0] === r[0] && c[1] === r[1] && c[5] === r[5])![2])!;
    expect(engine.historyPosition('Red','306',row[1],row[2],now,true)).not.toBeNull();
    released = true;
    const next = { ...payload, buses: [{ ...bus, observed_at: now + 5000 }] };
    const live = engine.contribute(next, 2, now + 5000)!;
    const handedOff = engine.contribute(next, 2, now + 5000, true)!;
    expect(handedOff.rows).toEqual(live.rows);
    expect(handedOff.distributions).toEqual(live.distributions);
    expect(engine.stats().steps).toBe(2);
    expect(engine.contribute({ ...next, buses: [] }, 2, now + 6000, true)).toBeNull();
  });

  it("carries only the allowlisted lines", () => {
    const red = new ServerEta({ routes: ["Red"] });
    const wire = red.contribute(payloadFor(0), 1, CAP.frames[0]!.t)!;
    expect(wire).not.toBeNull();
    expect(new Set(wire.buses.map((b) => b[1]))).toEqual(new Set(["Red"]));
    // But every route was still STEPPED — warmth is not gated on the
    // allowlist, or a widened list would start cold.
    expect(red.stats().beliefs).toBeGreaterThan(wire.buses.length);
  });

  it("names a bus that has aged off the live list nowhere", () => {
    // /api/buses applies its 120 s liveness TTL at READ time, so during an
    // upstream outage the bus array empties while the collector's data version
    // never moves. The field must empty with it.
    const eta = new ServerEta({ routes: ALL_ROUTES });
    const t = CAP.frames[0]!.t;
    const full = eta.contribute(payloadFor(0), 1, t)!;
    expect(full.buses.length).toBeGreaterThan(5);

    const one = CAP.frames[0]!.buses[0]!;
    const thinned = eta.contribute({ ...payloadFor(0), buses: [one] }, 1, t + 900)!;
    expect(thinned.buses.map((b) => b[0])).toEqual([one.bus_name.replace("#", "")]);
    // Reindexed, not left with holes: `buses` is the row index space.
    for (const r of thinned.rows) expect(r[0]).toBe(0);
    expect(full.distributions).toHaveLength(full.rows.length);
    expect(full.distributions!.every(d => d.length === 50 && d.every(Number.isFinite))).toBe(true);
    expect(thinned.distributions).toEqual(full.distributions!.filter((_, i) =>
      full.buses[full.rows[i]![0]]![0] === one.bus_name.replace('#', '')));


    expect(eta.contribute({ ...payloadFor(0), buses: [] }, 1, t + 1_800)).toBeNull();
  });
});

describe("beliefs", () => {
  beforeEach(() => registerRoutePaths(CAP.static.route_paths));
  afterEach(() => registerRoutePaths(null));

  it("are keyed on the bus NAME, so a reissued bus_id keeps its belief", () => {
    // `bus_id` is NOT a stable vehicle id — TransLoc reissues it per service
    // block (~1,000 ids for 50 buses in 30 days). Renumbering every id must
    // not create a second belief for the same vehicle.
    const eta = new ServerEta({ routes: ALL_ROUTES });
    const f0 = CAP.frames[0]!, f1 = CAP.frames[1]!;
    eta.contribute(payloadFor(0), 1, f0.t);
    const before = eta.stats().beliefs;
    const reissued = f1.buses.map((b) => ({ ...b, bus_id: b.bus_id + 500_000 }));
    eta.contribute({ ...payloadFor(1), buses: reissued }, 2, f1.t);
    expect(eta.stats().beliefs).toBe(before);
  });

  it("are evicted once a bus stops reporting", () => {
    const eta = new ServerEta({ routes: ALL_ROUTES });
    const f0 = CAP.frames[0]!;
    eta.contribute(payloadFor(0), 1, f0.t);
    expect(eta.stats().beliefs).toBeGreaterThan(0);
    const one = f0.buses[0]!;
    // Still within the window: the rest of the fleet keeps its belief, so a
    // one-poll gap in the feed does not cost every bus its history.
    eta.contribute({ ...payloadFor(0), buses: [one] }, 2, f0.t + BELIEF_EVICT_MS - 1_000);
    expect(eta.stats().beliefs).toBeGreaterThan(1);
    // Past it: only the bus still reporting is left.
    eta.contribute({ ...payloadFor(0), buses: [one] }, 3, f0.t + BELIEF_EVICT_MS + 1_000);
    const cfgs = ROUTE_LISTS.filter((c) => c.busRouteIds.includes(one.route_id));
    expect(eta.stats().beliefs).toBe(cfgs.length);
  });
});

describe("failure containment", () => {
  it("swallows an estimator exception and serves no field", () => {
    const logged: string[] = [];
    const eta = new ServerEta({ routes: ALL_ROUTES, log: (e) => logged.push(e) });
    // A payload the estimator cannot walk. The contract is that the poll and
    // the endpoint survive it; the field simply goes absent.
    const broken = { ...payloadFor(0), routes: null } as unknown as EtaPayloadView;
    expect(() => eta.contribute(broken, 1, Date.now())).not.toThrow();
    expect(eta.contribute(broken, 2, Date.now())).toBeNull();
    expect(eta.stats().failures).toBeGreaterThan(0);
    expect(logged).toContain("server_eta.step_failed");
  });
});

// -- The payload with the flag off is the payload we serve today -------------

const stops: Stop[] = [
  { id: 1, name: "A", lat: 41.31, lon: -72.93 },
  { id: 2, name: "B", lat: 41.31, lon: -72.92 },
  { id: 3, name: "C", lat: 41.31, lon: -72.91 },
];
const routes: Route[] = [
  { id: 10, name: "Loop", shortName: "L", color: "#000", stops: [1, 2, 3] },
];
const rawBuses: RawBus[] = [
  { id: 1, name: "#1", route: 10, lat: 41.31, lon: -72.929, heading: 90, lastStop: 1 } as RawBus,
];
function fakeUpstream(): UpstreamClient {
  return {
    buses: async () => rawBuses,
    stops: async () => stops.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })),
    routes: async () => routes.map((r) => ({
      id: r.id, name: r.name, shortName: r.shortName, color: r.color, stops: r.stops,
    })),
  } as UpstreamClient;
}

describe("/api/buses with the flag off", () => {
  let tmpDir: string;
  let bundle: DbBundle;
  let collector: Collector;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-eta-"));
    bundle = openDb(path.join(tmpDir, "test.db"));
    migrate(bundle.db, { migrationsFolder: "./drizzle" });
    collector = await Collector.create(bundle, {
      upstream: fakeUpstream(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await (collector as unknown as { refreshStaticIfNeeded: (f: boolean) => Promise<void> })
      .refreshStaticIfNeeded(true);
  });
  afterEach(() => {
    collector.stop();
    bundle.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("survives a throwing poll observer", async () => {
    // The observer runs after the collector's own work, inside its own
    // try/catch: an estimator exception must cost the served ETA field and
    // nothing else. A rejected poll promise would surface as an
    // unhandledRejection and could take the whole process down.
    const errors: string[] = [];
    const c = await Collector.create(bundle, {
      upstream: fakeUpstream(),
      logger: { info: () => {}, warn: () => {}, error: (m: string) => errors.push(m) },
    });
    await (c as unknown as { refreshStaticIfNeeded: (f: boolean) => Promise<void> })
      .refreshStaticIfNeeded(true);
    c.setPollObserver(() => { throw new Error("boom"); });
    await expect(
      (c as unknown as { runPoll: () => Promise<void> }).runPoll(),
    ).resolves.toBeUndefined();
    expect(errors).toContain("collector.poll_observer_failed");
    // The poll itself still did its work.
    expect(c.getLiveBuses().length).toBe(1);
    c.stop();
  });

  it("is byte-identical to the payload the builder produces on its own", () => {
    // The module is loaded either way — it is imported by app.ts. What must be
    // absent is its OUTPUT. A client that ignores the field must see exactly
    // the bytes it sees today, which is what makes this change additive.
    const off = createBusesPayloadCache(collector, null);
    expect(off()).toBe(JSON.stringify(buildBusesPayload(collector, null)));
    expect(off()).not.toContain("server_eta");
    expect(createBusesPayloadCache(collector, null, null)()).toBe(off());
  });

  it("adds the field and nothing else when it is on", () => {
    const off = JSON.parse(createBusesPayloadCache(collector, null)()) as Record<string, unknown>;
    const on = JSON.parse(
      createBusesPayloadCache(collector, null, new ServerEta({ routes: ALL_ROUTES }))(),
    ) as Record<string, unknown>;
    // The one route in this fixture is not a real line, so there is nothing to
    // price and no field — which is itself the invariant: absent, never a stub.
    delete on["server_eta"];
    expect(on).toEqual(off);
  });
});

describe('restart recovery and observation freshness', () => {
  afterEach(() => registerRoutePaths(null));

  it('continues the same forecast after restoring a recent checkpoint', () => {
    let bytes: Uint8Array | null = null;
    const checkpoint = { load: () => bytes, save: (b: Uint8Array) => { bytes = b; } };
    const original = new ServerEta({ routes: ALL_ROUTES });
    original.useCheckpoint(checkpoint, CAP.frames[0]!.t);
    original.contribute(payloadFor(0), 0, CAP.frames[0]!.t);
    expect((bytes as Uint8Array | null)?.byteLength).toBeGreaterThan(1000);
    const restarted = new ServerEta({ routes: ALL_ROUTES });
    restarted.useCheckpoint(checkpoint, CAP.frames[1]!.t);
    expect(restarted.stats().restored).toBe(original.stats().beliefs);
    for (let i = 1; i < 8; i++) {
      expect(restarted.contribute(payloadFor(i), i, CAP.frames[i]!.t))
        .toEqual(original.contribute(payloadFor(i), i, CAP.frames[i]!.t));
    }
  });

  it('discards corrupt and old checkpoints, and write failures do not suppress live arrivals', () => {
    let bytes: Uint8Array | null = null;
    const original = new ServerEta({ routes: ALL_ROUTES });
    original.useCheckpoint({ load: () => null, save: b => { bytes = b; } });
    original.contribute(payloadFor(0), 0, CAP.frames[0]!.t);
    for (const value of [bytes, new Uint8Array([0, 1, 2])]) {
      const restarted = new ServerEta({ routes: ALL_ROUTES });
      restarted.useCheckpoint({ load: () => value, save: () => { throw new Error('disk full'); } }, CAP.frames[0]!.t + 180_000);
      expect(restarted.stats().restored).toBe(0);
      expect(restarted.contribute(payloadFor(1), 1, CAP.frames[1]!.t)).not.toBeNull();
      expect(restarted.stats().failures).toBe(0);
    }
  });

  it('expires a missing bus even while other buses keep polling', () => {
    const server = new ServerEta({ routes: ALL_ROUTES });
    const t = CAP.frames[0]!.t;
    const p = payloadFor(0);
    p.buses = p.buses.map(b => ({ ...b, observed_at: t }));
    const first = server.contribute(p, 0, t)!;
    const missing = first.buses[0]![0];
    const next = { ...p, buses: p.buses.map(b => ({ ...b, observed_at: b.bus_name.replace(/^#/, '') === missing ? t : t + 44_000 })) };
    expect(server.contribute(next, 1, t + 44_000)!.buses.some(b => b[0] === missing)).toBe(true);
    const wire = server.contribute(next, 1, t + 45_000)!;
    expect(wire.buses.some(b => b[0] === missing)).toBe(false);
    expect(wire.buses.length).toBeGreaterThan(0);
    expect(server.stats().steps).toBe(2);
  });
});
