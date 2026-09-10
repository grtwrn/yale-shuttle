/**
 * The server-side belief's contract: it is OFF by default, it cannot break the
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

/**
 * Step, then read — the two halves of what used to be one synchronous call.
 * The step is chunked across event-loop turns now, so every caller that wants
 * THIS poll's answer has to await it; a caller that only wants the latest
 * answer calls `answer()` alone and never steps a belief.
 */
async function stepped(eta: ServerEta, payload: EtaPayloadView, version: number, now: number) {
  await eta.step(payload, version, now);
  return eta.answer(payload.buses);
}

describe("the flag", () => {
  it("is off unless SHUTTLE_SERVER_ETA=1", () => {
    expect(serverEtaFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(serverEtaFromEnv({ SHUTTLE_SERVER_ETA: "0" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(serverEtaFromEnv({ SHUTTLE_SERVER_ETA: "true" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it("serves a bounded set of lines, not the whole network", () => {
    // Client-side a bug is bounded by which routes the bundle prices. There is
    // no such bound on the server, so the allowlist is the bound.
    const on = serverEtaFromEnv({ SHUTTLE_SERVER_ETA: "1" } as unknown as NodeJS.ProcessEnv)!;
    expect(on.servedRoutes()).toEqual([...DEFAULT_SERVER_ETA_ROUTES]);
    expect(on.servedRoutes().length).toBeLessThan(ROUTE_LISTS.length);
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

  it("carries only the allowlisted lines", async () => {
    const red = new ServerEta({ routes: ["Red"] });
    const wire = (await stepped(red, payloadFor(0), 1, CAP.frames[0]!.t))!;
    expect(wire).not.toBeNull();
    expect(new Set(wire.buses.map((b) => b[1]))).toEqual(new Set(["Red"]));
    // But every route was still STEPPED — warmth is not gated on the
    // allowlist, or a widened list would start cold.
    expect(red.stats().beliefs).toBeGreaterThan(wire.buses.length);
  });

  it("names a bus that has aged off the live list nowhere", async () => {
    // /api/buses applies its 120 s liveness TTL at READ time, so during an
    // upstream outage the bus array empties while the collector's data version
    // never moves. The field must empty with it.
    const eta = new ServerEta({ routes: ALL_ROUTES });
    const t = CAP.frames[0]!.t;
    const full = (await stepped(eta, payloadFor(0), 1, t))!;
    expect(full.buses.length).toBeGreaterThan(5);

    const one = CAP.frames[0]!.buses[0]!;
    // Same version: nothing steps, the last answer is simply filtered.
    const thinned = eta.answer([one])!;
    expect(thinned.buses.map((b) => b[0])).toEqual([one.bus_name.replace("#", "")]);
    // Reindexed, not left with holes: `buses` is the row index space.
    for (const r of thinned.rows) expect(r[0]).toBe(0);

    expect(eta.answer([])).toBeNull();
  });
});

describe("beliefs", () => {
  beforeEach(() => registerRoutePaths(CAP.static.route_paths));
  afterEach(() => registerRoutePaths(null));

  it("are keyed on the bus NAME, so a reissued bus_id keeps its belief", async () => {
    // `bus_id` is NOT a stable vehicle id — TransLoc reissues it per service
    // block (~1,000 ids for 50 buses in 30 days). Renumbering every id must
    // not create a second belief for the same vehicle.
    const eta = new ServerEta({ routes: ALL_ROUTES });
    const f0 = CAP.frames[0]!, f1 = CAP.frames[1]!;
    await eta.step(payloadFor(0), 1, f0.t);
    const before = eta.stats().beliefs;
    const reissued = f1.buses.map((b) => ({ ...b, bus_id: b.bus_id + 500_000 }));
    await eta.step({ ...payloadFor(1), buses: reissued }, 2, f1.t);
    expect(eta.stats().beliefs).toBe(before);
  });

  it("are evicted once a bus stops reporting", async () => {
    const eta = new ServerEta({ routes: ALL_ROUTES });
    const f0 = CAP.frames[0]!;
    await eta.step(payloadFor(0), 1, f0.t);
    expect(eta.stats().beliefs).toBeGreaterThan(0);
    const one = f0.buses[0]!;
    // Still within the window: the rest of the fleet keeps its belief, so a
    // one-poll gap in the feed does not cost every bus its history.
    await eta.step({ ...payloadFor(0), buses: [one] }, 2, f0.t + BELIEF_EVICT_MS - 1_000);
    expect(eta.stats().beliefs).toBeGreaterThan(1);
    // Past it: only the bus still reporting is left.
    await eta.step({ ...payloadFor(0), buses: [one] }, 3, f0.t + BELIEF_EVICT_MS + 1_000);
    const cfgs = ROUTE_LISTS.filter((c) => c.busRouteIds.includes(one.route_id));
    expect(eta.stats().beliefs).toBe(cfgs.length);
  });
});

describe("failure containment", () => {
  it("swallows an estimator exception and serves no field", async () => {
    const logged: string[] = [];
    const eta = new ServerEta({ routes: ALL_ROUTES, log: (e) => logged.push(e) });
    // A payload the estimator cannot walk. The contract is that the poll and
    // the endpoint survive it; the field simply goes absent.
    const broken = { ...payloadFor(0), routes: null } as unknown as EtaPayloadView;
    await expect(eta.step(broken, 1, Date.now())).resolves.toBeUndefined();
    expect(await stepped(eta, broken, 2, Date.now())).toBeNull();
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

  it("is byte-identical to the payload the builder produces on its own", async () => {
    // The module is loaded either way — it is imported by app.ts. What must be
    // absent is its OUTPUT. A client that ignores the field must see exactly
    // the bytes it sees today, which is what makes this change additive.
    const off = createBusesPayloadCache(collector, null);
    expect(off()).toBe(JSON.stringify(buildBusesPayload(collector, null)));
    expect(off()).not.toContain("server_eta");
    expect(createBusesPayloadCache(collector, null, null)()).toBe(off());
    // And `prime` with no engine is the plain synchronous build — the poll
    // observer's contract does not change when the flag is off.
    await expect(off.prime()).resolves.toBeUndefined();
    expect(off()).toBe(JSON.stringify(buildBusesPayload(collector, null)));
  });

  it("adds the field and nothing else when it is on", async () => {
    const off = JSON.parse(createBusesPayloadCache(collector, null)()) as Record<string, unknown>;
    const onCache = createBusesPayloadCache(collector, null, new ServerEta({ routes: ALL_ROUTES }));
    await onCache.prime();
    const on = JSON.parse(onCache()) as Record<string, unknown>;
    // The one route in this fixture is not a real line, so there is nothing to
    // price and no field — which is itself the invariant: absent, never a stub.
    delete on["server_eta"];
    expect(on).toEqual(off);
  });
});
