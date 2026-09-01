/**
 * The derivation job end-to-end: samples in `raw_positions` become a stored
 * route path, that path outlives the samples, and `/api/buses` serves it.
 *
 * The behaviour these tests exist to pin down is the awkward one. A route can
 * only be derived while it is running, and the samples are swept after six
 * hours — so the normal state of the world is "nothing to derive right now",
 * and the job must sit through that without losing what it already has.
 */

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import { buildBusesPayload, createBusesPayloadCache } from "../server/v1compat.js";

import { Collector, type Logger } from "./collector.js";

// Serving derived geometry to riders is opt-in: production sends the published
// path byte-for-byte so the map matches the operator's own site. These tests
// exercise the opt-in path end to end.
beforeEach(() => { process.env.SHUTTLE_SERVE_DERIVED_PATHS = "1"; });
afterEach(() => { delete process.env.SHUTTLE_SERVE_DERIVED_PATHS; });
import { UpstreamClient, type RawBus } from "./upstream.js";
import type { Route, Stop } from "../schema/api.js";

// -- Fixture: one circular route a bus laps -----------------------------------

const CENTER = { lat: 41.31, lon: -72.93 };
const R_LAT = 500 / 111_320; // 500 m radius
const R_LON = 500 / (111_320 * Math.cos((CENTER.lat * Math.PI) / 180));
const RUNNING_ROUTE = 14;
const IDLE_ROUTE = 9;

/** A point at `frac` of the way around the loop. */
function onCircle(frac: number, scale = 1): { lat: number; lon: number } {
  const a = frac * 2 * Math.PI;
  return {
    lat: CENTER.lat + Math.cos(a) * R_LAT * scale,
    lon: CENTER.lon + Math.sin(a) * R_LON * scale,
  };
}

const STOPS_PER_ROUTE = 8;
/** Stop ids 100.. for the running route, 200.. for the idle one. */
const stopsFor = (base: number): Stop[] =>
  Array.from({ length: STOPS_PER_ROUTE }, (_, i) => ({
    id: base + i,
    name: `S${base + i}`,
    ...onCircle(i / STOPS_PER_ROUTE),
  }));

/**
 * An unusable published polyline: the right loop, but coarse AND running
 * counter to the stop order, so tracing wraps on every leg (96 undrawable legs
 * against the derived path's 0).
 *
 * It is deliberately this broken. Merely coarse is NOT the defect — a published
 * line needs a vertex only where the road turns, so 37 points can describe a
 * 9.5 km loop perfectly, and Yale's own map draws exactly these lines correctly.
 * Once the client began projecting stops onto the segments instead of snapping
 * them to vertices, every real published path became traceable and a
 * six-point hexagon stopped being a defect at all. Derivation now exists for
 * the case where the published geometry genuinely cannot be followed, so the
 * fixture has to be genuinely unfollowable.
 */
const coarseUpstreamPath = (): [number, number][] =>
  Array.from({ length: 6 }, (_, i) => {
    const p = onCircle(i / 6);
    return [p.lat, p.lon] as [number, number];
  }).reverse();

/** A dense, faithful polyline — what upstream would publish if it fixed one. */
const fineUpstreamPath = (): [number, number][] =>
  Array.from({ length: 240 }, (_, i) => {
    const p = onCircle(i / 240);
    return [p.lat, p.lon] as [number, number];
  });

const stops: Stop[] = [...stopsFor(100), ...stopsFor(200)];
const baseRoutes = (): Route[] => [
  {
    id: RUNNING_ROUTE,
    name: "Night",
    shortName: "ON",
    color: "#f80",
    stops: stopsFor(100).map((s) => s.id),
    path: coarseUpstreamPath(),
  },
  {
    id: IDLE_ROUTE,
    name: "Green",
    shortName: "GRN",
    color: "#0a0",
    stops: stopsFor(200).map((s) => s.id),
    path: coarseUpstreamPath(),
  },
];
/** What upstream is publishing right now; a test may replace it and refresh. */
let routes: Route[] = baseRoutes();

class StubUpstream extends UpstreamClient {
  constructor() {
    super({ baseUrl: "http://invalid.test" });
  }
  override async buses(): Promise<RawBus[]> {
    return [];
  }
  override async stops(): Promise<Stop[]> {
    return stops;
  }
  override async routes(): Promise<Route[]> {
    return routes;
  }
}

interface LogLine {
  level: string;
  msg: string;
  meta?: Record<string, unknown>;
}

let tmpDir: string;
let bundle: DbBundle;
let collector: Collector;
let logs: LogLine[];

const runDerive = (c: Collector = collector): void =>
  (c as unknown as { runDerivePaths(): void }).runDerivePaths();

/** Drive a full sweep of the route list, whatever order the cursor is in. */
const sweep = (times = routes.length, c: Collector = collector): void => {
  for (let i = 0; i < times; i++) runDerive(c);
};

/**
 * Two laps of a bus reporting every 5 s: 200 positions per lap, so consecutive
 * positions are ~16 m apart and every stop is comfortably covered. Two laps
 * because the derivation looks for the shortest window covering every stop and
 * then extends it until the bus comes back round.
 */
function insertLaps(routeId: number, opts: { laps?: number; scale?: number; startMs?: number } = {}): void {
  const { laps = 2, scale = 1, startMs = Date.now() - 60 * 60_000 } = opts;
  const perLap = 200;
  const ins = bundle.sqlite.prepare(
    "INSERT INTO raw_positions (bus_id, bus_name, route_id, lat, lon, heading, last_stop_id, collected_at) " +
      "VALUES (?, ?, ?, ?, ?, 0, NULL, ?)",
  );
  const tx = bundle.sqlite.transaction(() => {
    for (let i = 0; i < laps * perLap; i++) {
      const p = onCircle((i % perLap) / perLap, scale);
      ins.run(42, "#42", routeId, p.lat, p.lon, startMs + i * 5_000);
    }
  });
  tx();
}

beforeEach(async () => {
  routes = baseRoutes();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-derive-"));
  bundle = openDb(path.join(tmpDir, "test.db"));
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
  logs = [];
  const logger: Logger = {
    info: (msg, meta) => logs.push({ level: "info", msg, ...(meta ? { meta } : {}) }),
    warn: (msg, meta) => logs.push({ level: "warn", msg, ...(meta ? { meta } : {}) }),
    error: (msg, meta) => logs.push({ level: "error", msg, ...(meta ? { meta } : {}) }),
  };
  collector = await Collector.create(bundle, { upstream: new StubUpstream(), logger });
  // Populate stops/routes without starting any timers.
  await (
    collector as unknown as { refreshStaticIfNeeded(f: boolean): Promise<void> }
  ).refreshStaticIfNeeded(true);
});

afterEach(() => {
  collector.stop();
  bundle.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const derivedRows = (): Array<Record<string, unknown>> =>
  bundle.sqlite.prepare("SELECT * FROM derived_paths").all() as Array<Record<string, unknown>>;

describe("route path derivation", () => {
  it("derives a running route's geometry and stores it", () => {
    insertLaps(RUNNING_ROUTE);
    sweep();

    const stored = collector.derivedPaths().get(RUNNING_ROUTE);
    expect(stored).toBeDefined();
    // Far more detail than upstream's six points, and hugging the stops.
    expect(stored!.length).toBeGreaterThan(20);
    const rows = derivedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.route_id).toBe(RUNNING_ROUTE);
    expect(rows[0]!.stop_count).toBe(STOPS_PER_ROUTE);
    expect(rows[0]!.median_stop_m as number).toBeLessThan(30);
    expect(logs.find((l) => l.msg === "collector.path_derived")).toBeDefined();
  });

  it("leaves a route with no recent samples alone", () => {
    insertLaps(RUNNING_ROUTE);
    sweep();
    // The idle route was considered on the same sweep and produced nothing.
    expect(collector.derivedPaths().has(IDLE_ROUTE)).toBe(false);
    expect(derivedRows()).toHaveLength(1);
    expect(logs.some((l) => l.level === "error")).toBe(false);
  });

  it("keeps a stored path once the route stops running and its samples are swept", () => {
    insertLaps(RUNNING_ROUTE);
    sweep();
    const before = collector.derivedPaths().get(RUNNING_ROUTE);
    expect(before).toBeDefined();

    // What the hourly retention sweep does six hours later — and what happens
    // to every night route by morning.
    bundle.sqlite.exec("DELETE FROM raw_positions");
    sweep(routes.length * 5);

    expect(collector.derivedPaths().get(RUNNING_ROUTE)).toEqual(before);
    expect(derivedRows()).toHaveLength(1);
    // And it is still what the map would be served.
    const payload = buildBusesPayload(collector) as {
      route_paths: Record<string, [number, number][]>;
    };
    expect(payload.route_paths[String(RUNNING_ROUTE)]).toEqual(before);
  });

  it("ignores samples older than the derivation window", () => {
    // Older than the 6 h raw-position retention window: in production these
    // rows would already be gone, and they must not resurrect a derivation.
    insertLaps(RUNNING_ROUTE, { startMs: Date.now() - 20 * 60 * 60_000 });
    sweep();
    expect(collector.derivedPaths().size).toBe(0);
  });

  it("survives a restart, because the samples do not", async () => {
    insertLaps(RUNNING_ROUTE);
    sweep();
    const before = collector.derivedPaths().get(RUNNING_ROUTE);

    // Restart with the samples already swept — the only thing carrying the
    // geometry across is the table.
    bundle.sqlite.exec("DELETE FROM raw_positions");
    const reopened = openDb(path.join(tmpDir, "test.db"));
    const restarted = await Collector.create(reopened, { upstream: new StubUpstream() });
    expect(restarted.derivedPaths().get(RUNNING_ROUTE)).toEqual(before);
    reopened.sqlite.close();
  });

  it("does not rewrite a stored path on the next sweep", () => {
    insertLaps(RUNNING_ROUTE);
    sweep();
    const first = derivedRows()[0]!;
    sweep(routes.length * 3);
    const after = derivedRows();
    expect(after).toHaveLength(1);
    expect(after[0]!.derived_at).toBe(first.derived_at);
    expect(collector.derivedPathStats().stores).toBe(1);
  });

  it("bumps the data version so the memoized /api/buses payload rebuilds", () => {
    const cached = createBusesPayloadCache(collector);
    const before = cached();
    expect(JSON.parse(before).route_paths[String(RUNNING_ROUTE)]).toHaveLength(6);

    insertLaps(RUNNING_ROUTE);
    const version = collector.dataVersion();
    sweep();
    expect(collector.dataVersion()).toBeGreaterThan(version);

    const after = cached();
    expect(after).not.toBe(before);
    const paths = JSON.parse(after).route_paths as Record<string, [number, number][]>;
    expect(paths[String(RUNNING_ROUTE)]!.length).toBeGreaterThan(20);
  });

  it("serves upstream's path for every route it has not derived, unchanged", () => {
    insertLaps(RUNNING_ROUTE);
    sweep();
    const payload = buildBusesPayload(collector) as {
      route_paths: Record<string, [number, number][]>;
      routes: Record<string, number[]>;
    };
    // Untouched: same array upstream published, same key set as before.
    expect(payload.route_paths[String(IDLE_ROUTE)]).toEqual(coarseUpstreamPath());
    expect(Object.keys(payload.route_paths).sort()).toEqual(
      [String(RUNNING_ROUTE), String(IDLE_ROUTE)].sort(),
    );
  });

  it("reports the quality figures an operator needs to judge it", () => {
    insertLaps(RUNNING_ROUTE);
    sweep();
    const stats = collector.derivedPathStats();
    expect(stats.routes).toBe(2);
    expect(stats.derived).toBe(1);
    expect(stats.runs).toBeGreaterThan(0);
    expect(stats.lastRunMs).not.toBeNull();
    const p = stats.paths.find((x) => x.routeId === RUNNING_ROUTE)!;
    expect(p.shortName).toBe("ON");
    expect(p.upstreamPoints).toBe(6);
    // The claim the whole feature rests on: stops sit closer to the derived
    // line than to the published one.
    expect(p.medianStopM).toBeLessThan(p.upstreamMedianStopM!);
    expect(p.currentMedianStopM).toBeLessThan(p.upstreamMedianStopM!);
  });

  it("hands a route back to upstream once upstream publishes something better", async () => {
    // Laps driven 40 m off the stops, so the derivation is a real improvement
    // on the coarse published path without being perfect — which is what makes
    // "upstream later publishes something better" a coherent situation at all.
    insertLaps(RUNNING_ROUTE, { scale: 1.08 });
    sweep();
    expect(collector.derivedPaths().has(RUNNING_ROUTE)).toBe(true);

    // Upstream fixes its own geometry. Nothing else in this job would ever give
    // the route back, so without this check the map would keep the derivation
    // that is now the worse of the two, indefinitely.
    routes = baseRoutes().map((r) =>
      r.id === RUNNING_ROUTE ? { ...r, path: fineUpstreamPath() } : r,
    );
    await (
      collector as unknown as { refreshStaticIfNeeded(f: boolean): Promise<void> }
    ).refreshStaticIfNeeded(true);
    bundle.sqlite.exec("DELETE FROM raw_positions");
    sweep(routes.length * 2);

    expect(collector.derivedPaths().has(RUNNING_ROUTE)).toBe(false);
    expect(derivedRows()).toHaveLength(0);
    const payload = buildBusesPayload(collector) as {
      route_paths: Record<string, [number, number][]>;
    };
    expect(payload.route_paths[String(RUNNING_ROUTE)]).toEqual(fineUpstreamPath());
    expect(logs.some((l) => l.msg === "collector.path_derived_dropped")).toBe(true);
  });

  it("keeps the derivation when the refreshed upstream path is no better", async () => {
    insertLaps(RUNNING_ROUTE);
    sweep();
    const before = collector.derivedPaths().get(RUNNING_ROUTE);
    await (
      collector as unknown as { refreshStaticIfNeeded(f: boolean): Promise<void> }
    ).refreshStaticIfNeeded(true);
    sweep(routes.length * 2);
    expect(collector.derivedPaths().get(RUNNING_ROUTE)).toEqual(before);
  });

  it("does not throw when the route list is empty", () => {
    const empty = openDb(path.join(tmpDir, "empty.db"));
    migrate(empty.db, { migrationsFolder: "./drizzle" });
    return Collector.create(empty, { upstream: new StubUpstream() }).then((c) => {
      expect(() => runDerive(c)).not.toThrow();
      expect(c.derivedPathStats().derived).toBe(0);
      empty.sqlite.close();
    });
  });
});
