/**
 * The upstream ETA census: what it asks, how fast, and what lands in
 * `upstream_etas`. Nothing here touches the network — the fetch is a stub
 * answering with `__fixtures__/routes_eta.stop116.json`, a verbatim capture
 * from the live provider (Sun 2026-09-06 11:08 ET).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import { NetworkRef } from "../network/NetworkRef.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { BusPosition, Route, Stop } from "../schema/api.js";

import { Collector, type Logger } from "./collector.js";
import { UpstreamClient } from "./upstream.js";
import {
  IDLE_PROBE_MS,
  RAW_MAX_CHARS,
  SUMMARY_MS,
  UpstreamEtaSampler,
} from "./upstreamEtaSampler.js";

const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./__fixtures__/routes_eta.stop116.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const stops: Stop[] = [
  { id: 116, name: "Stop & Shop", lat: 41.32, lon: -72.9 },
  { id: 100, name: "Prospect / Canner", lat: 41.3255, lon: -72.9234 },
  { id: 11, name: "344 Winchester", lat: 41.3187, lon: -72.9297 },
  { id: 72, name: "72 LEPH / 60 College", lat: 41.3037, lon: -72.9322 },
  { id: 55, name: "Elsewhere", lat: 41.31, lon: -72.94 },
  { id: 26, name: "West Campus", lat: 41.27, lon: -72.96 },
];

const routes: Route[] = [
  { id: 4, name: "Blue - Weekend", shortName: "B", color: "#00f", stops: [116, 100, 11] },
  { id: 3, name: "Red", shortName: "R", color: "#f00", stops: [72, 11, 55] },
  { id: 10, name: "Purple", shortName: "P", color: "#808", stops: [26, 72] },
];

const NOW = 1_788_707_320_000; // the fixture's calculation_time, in ms

let tmpDir: string;
let bundle: DbBundle;
let requested: string[];
let clock: number;

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function bus(routeId: number, name = "#49"): BusPosition {
  return {
    busId: 66029,
    busName: name,
    routeId,
    lat: 41.3,
    lon: -72.9,
    heading: 0,
    lastStopId: null,
    atStopId: null,
    atStopSince: null,
    stationarySince: null,
  } as BusPosition;
}

/** A client whose every stop answers from `body(pathname)`; undefined = HTTP 500. */
function stubClient(
  body: (key: string) => unknown | undefined,
  opts: { delay?: () => Promise<void> } = {},
): UpstreamClient {
  const fetchImpl = (async (url: string | URL) => {
    const u = new URL(String(url));
    const key = `${u.pathname}${u.search}`;
    requested.push(key);
    if (opts.delay) await opts.delay();
    const found = body(key);
    if (found === undefined) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify(found), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return new UpstreamClient({ baseUrl: "https://example.invalid", fetchImpl });
}

function fixtureFor(key: string): unknown {
  // Any stop answers the recorded shape, re-keyed to the stop asked for, so
  // the rows can be attributed; stop 55 answers nothing, like a quiet stop.
  const m = /stop=(\d+)$/.exec(key);
  const id = m ? m[1]! : "116";
  if (id === "55") return {};
  const inner = (FIXTURE.etas as Record<string, unknown>)["116"];
  return { etas: { [id]: inner }, calculation_time: FIXTURE.calculation_time };
}

function makeSampler(
  client: UpstreamClient,
  over: Partial<ConstructorParameters<typeof UpstreamEtaSampler>[0]> = {},
): UpstreamEtaSampler {
  return new UpstreamEtaSampler({
    sqlite: bundle.sqlite,
    ref: new NetworkRef(TransitNetwork.build(stops, routes)),
    upstream: client,
    liveBuses: () => [bus(4)],
    routeActive: () => new Map([[4, true]]),
    logger: quiet,
    now: () => clock,
    ...over,
  });
}

function rows(): Array<Record<string, unknown>> {
  return bundle.sqlite
    .prepare(
      `SELECT sampled_at, calc_at, stop_id, route_id, bus_id, bus_name, eta_min, eta_sec,
              probe, raw FROM upstream_etas ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-etalog-"));
  bundle = openDb(path.join(tmpDir, "test.db"));
  migrate(bundle.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  requested = [];
  clock = NOW;
  // The fixture's calculation_time is trusted only within 5 min of Date.now().
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
  bundle.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("the recorded routes_eta.php response", () => {
  it("parses the live capture onto our identifiers, with nothing left over", async () => {
    const client = stubClient((k) => (k === "/routes_eta.php?stop=116" ? FIXTURE : undefined));
    const answer = await client.stopEtas(116);
    expect(answer).toEqual({
      calculatedAtMs: NOW,
      etas: [{ stopId: 116, busId: 66029, busName: "#49", routeId: 4, avgMin: 40 }],
    });
  });

  it("keeps any field the schema does not name, on the row and on the envelope", async () => {
    const client = stubClient(() => ({
      etas: {
        "116": {
          etas: [
            { avg: 3, bus_id: 1, bus_name: "#1", route: 4, status: "in service" },
            { avg: "n/a", bus_id: "x", bus_name: "#2", route: 4 },
          ],
          note: "detour",
        },
      },
      calculation_time: 1_000, // 1970: implausible, so it must not become calc_at
      service: "ended",
    }));
    const answer = await client.stopEtas(116);
    expect(answer.calculatedAtMs).toBeNull();
    expect(answer.etas).toHaveLength(1);
    expect(answer.etas[0]!.extra).toEqual({ status: "in service" });
    expect(answer.extra).toEqual({
      "etas.116.note": "detour",
      service: "ended",
      calculation_time: 1_000,
      rejected: [{ avg: "n/a", bus_id: "x", bus_name: "#2", route: 4 }],
    });
  });
});

describe("UpstreamEtaSampler rotation", () => {
  it("walks the stops of live routes in route then sequence order, deduplicated", () => {
    const s = makeSampler(stubClient(fixtureFor), {
      liveBuses: () => [bus(4), bus(3, "#38")],
      routeActive: () => new Map(),
    });
    const picked = Array.from({ length: 6 }, () => s.next()!.stopId);
    // Route 3 first (lower id): 72, 11, 55; then route 4: 116, 100 — 11 is
    // shared and asked once. Then round again.
    expect(picked).toEqual([72, 11, 55, 116, 100, 72]);
  });

  it("carries the cursor across a change in the live set", () => {
    let live = [bus(4), bus(3, "#38")];
    const s = makeSampler(stubClient(fixtureFor), {
      liveBuses: () => live,
      routeActive: () => new Map(),
    });
    expect([s.next()!.stopId, s.next()!.stopId]).toEqual([72, 11]);
    live = [bus(4)]; // route 3's bus went home
    // 11 is still on route 4's list, so the walk continues after it: 116, 100, 11.
    expect([s.next()!.stopId, s.next()!.stopId, s.next()!.stopId]).toEqual([116, 100, 11]);
  });

  it("asks nothing when no route has a bus and none is active", () => {
    const s = makeSampler(stubClient(fixtureFor), {
      liveBuses: () => [],
      routeActive: () => new Map([[4, false]]),
    });
    expect(s.next()).toBeNull();
  });

  it("probes one stop of each active-but-empty route once a minute, ahead of the rotation", () => {
    // Route 10 is active with no bus; route 4 has a bus. Route 3: a bus but inactive.
    const s = makeSampler(stubClient(fixtureFor), {
      liveBuses: () => [bus(4), bus(3, "#38")],
      routeActive: () => new Map([[4, true], [10, true], [3, false]]),
    });
    expect(s.next()).toEqual({ stopId: 26, probeRouteId: 10 });
    expect(s.next()).toEqual({ stopId: 72, probeRouteId: null });
    // Within the minute: no further probe.
    clock += IDLE_PROBE_MS - 1;
    expect(s.next()!.probeRouteId).toBeNull();
    // Next minute: the probe walks to route 10's next stop.
    clock += 1;
    expect(s.next()).toEqual({ stopId: 72, probeRouteId: 10 });
    clock += IDLE_PROBE_MS;
    expect(s.next()).toEqual({ stopId: 26, probeRouteId: 10 });
  });
});

describe("UpstreamEtaSampler rows", () => {
  it("writes one row per prediction, verbatim minutes plus derived seconds", async () => {
    const s = makeSampler(stubClient(fixtureFor));
    await s.tick();
    expect(requested).toEqual(["/routes_eta.php?stop=116"]);
    expect(rows()).toEqual([
      {
        sampled_at: NOW,
        calc_at: NOW,
        stop_id: 116,
        route_id: 4,
        bus_id: 66029,
        bus_name: "#49",
        eta_min: 40,
        eta_sec: 2400,
        probe: 0,
        raw: null,
      },
    ]);
    expect(s.totals).toMatchObject({ calls: 1, rows: 1, empty: 0, failures: 0 });
  });

  it("writes a marker row for a stop that answered nothing", async () => {
    const s = makeSampler(stubClient(fixtureFor), {
      liveBuses: () => [bus(3)],
      routeActive: () => new Map(),
    });
    await s.tick(); // 72
    await s.tick(); // 11
    await s.tick(); // 55 answers {}
    const r = rows();
    expect(r).toHaveLength(3);
    expect(r[2]).toMatchObject({
      stop_id: 55,
      route_id: null,
      bus_id: null,
      bus_name: null,
      eta_min: null,
      eta_sec: null,
      probe: 0,
      raw: null,
    });
    expect(s.totals.empty).toBe(1);
  });

  it("marks an idle-route probe with the route it was for", async () => {
    const s = makeSampler(stubClient(fixtureFor), {
      liveBuses: () => [],
      routeActive: () => new Map([[3, true]]),
    });
    await s.tick(); // probe: 72 for route 3, answers the fixture (a route-4 bus)
    clock += IDLE_PROBE_MS;
    await s.tick(); // probe: 11
    clock += IDLE_PROBE_MS;
    await s.tick(); // probe: 55 → {}
    const r = rows();
    expect(r.map((x) => [x.stop_id, x.probe, x.route_id])).toEqual([
      [72, 1, 4], // upstream's own route wins on a prediction row
      [11, 1, 4],
      [55, 1, 3], // the marker keeps the probed route
    ]);
    expect(s.totals.probes).toBe(3);
  });

  it("keeps unknown fields in raw, clipped", async () => {
    const big = "x".repeat(RAW_MAX_CHARS * 2);
    const s = makeSampler(
      stubClient(() => ({
        etas: { "116": { etas: [{ avg: 2, bus_id: 1, bus_name: "#1", route: 4, flag: big }] } },
        calculation_time: NOW / 1000,
      })),
    );
    await s.tick();
    const raw = rows()[0]!.raw as string;
    expect(raw.length).toBe(RAW_MAX_CHARS);
    expect(raw.startsWith('{"flag":"xxx')).toBe(true);
  });
});

describe("UpstreamEtaSampler rate and failure", () => {
  it("makes at most one call per interval, and none while one is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const client = stubClient(fixtureFor, { delay: () => gate });
    const s = makeSampler(client, { intervalMs: 1_000, now: () => Date.now() });
    s.start();
    await vi.advanceTimersByTimeAsync(5_000);
    // Five ticks fired; the first call never returned, so the rest were skipped.
    expect(requested).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(requested).toHaveLength(4);
    // Spacing: exactly one per interval once free.
    s.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requested).toHaveLength(4);
  });

  it("never throws out of a failing upstream, warns once per outage, and recovers", async () => {
    const logs: Array<[string, string]> = [];
    const logger: Logger = {
      info: (m) => logs.push(["info", m]),
      warn: (m) => logs.push(["warn", m]),
      error: (m) => logs.push(["error", m]),
    };
    let down = true;
    const s = makeSampler(
      stubClient((k) => (down ? undefined : fixtureFor(k))),
      { logger },
    );
    await expect(s.tick()).resolves.toBeUndefined();
    await expect(s.tick()).resolves.toBeUndefined();
    await expect(s.tick()).resolves.toBeUndefined();
    expect(s.totals.failures).toBe(3);
    expect(logs.filter(([, m]) => m === "collector.eta_sample_upstream")).toHaveLength(1);
    expect(rows()).toHaveLength(0);
    down = false;
    await s.tick();
    expect(logs.at(-1)).toEqual(["info", "collector.eta_sample_recovered"]);
    expect(rows()).toHaveLength(1);
  });

  it("summarises every five minutes, not per call", async () => {
    const logs: Array<Record<string, unknown> | undefined> = [];
    const logger: Logger = {
      info: (m, meta) => { if (m === "collector.eta_sampled") logs.push(meta); },
      warn: () => {},
      error: () => {},
    };
    const s = makeSampler(stubClient(fixtureFor), { logger });
    for (let i = 0; i < 4; i++) { await s.tick(); clock += 1_000; }
    expect(logs).toHaveLength(0);
    clock += SUMMARY_MS;
    await s.tick();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ calls: 5, rows: 5, empty: 0, probes: 0, failures: 0, stops: 3 });
  });
});

describe("Collector wiring", () => {
  it("is off when an upstream client is injected, unless asked for", async () => {
    const off = await Collector.create(bundle, { upstream: stubClient(fixtureFor), logger: quiet });
    expect(off.etaSampler).toBeNull();
    const on = await Collector.create(bundle, {
      upstream: stubClient(fixtureFor),
      logger: quiet,
      etaSampler: true,
    });
    expect(on.etaSampler).not.toBeNull();
    off.stop();
    on.stop();
  });

  it("sweeps rows older than the window with the hourly retention", async () => {
    const c = await Collector.create(bundle, { upstream: stubClient(fixtureFor), logger: quiet });
    const ins = bundle.sqlite.prepare(
      "INSERT INTO upstream_etas (sampled_at, stop_id, probe) VALUES (?, ?, 0)",
    );
    const day = 24 * 60 * 60_000;
    ins.run(Date.now() - 31 * day, 116); // past the 30 d window
    ins.run(Date.now() - 29 * day, 116); // inside it
    ins.run(Date.now(), 116);
    (c as unknown as { runRetention: () => void }).runRetention();
    const left = bundle.sqlite
      .prepare("SELECT sampled_at AS at FROM upstream_etas ORDER BY at")
      .all() as Array<{ at: number }>;
    expect(left).toHaveLength(2);
    expect(left[0]!.at).toBeGreaterThan(Date.now() - 30 * day);
    c.stop();
  });
});
