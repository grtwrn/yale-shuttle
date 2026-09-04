/**
 * The upstream-ETA poller, against a RECORDED `routes_eta.php` response.
 *
 * The fixture below is a verbatim capture from the live provider on
 * 2026-09-04 (stops 72 and 100). Nothing here touches the network: the
 * fetch implementation is a stub, per CLAUDE.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import { NetworkRef } from "../network/NetworkRef.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { BusPosition, Route, Stop } from "../schema/api.js";
import { PREDICTION_BUCKET_MS, UPSTREAM_SURFACE } from "../server/predictions.js";

import { UpstreamClient } from "./upstream.js";
import { FOCUS_STOP_NAMES, UpstreamEtaPoller } from "./upstreamEta.js";

// Two of the real focus stops plus a third the fixture also answers for.
const stops: Stop[] = [
  { id: 72, name: "72 LEPH / 60 College", lat: 41.3037, lon: -72.9322 },
  { id: 100, name: "Prospect / Canner", lat: 41.3255, lon: -72.9234 },
  { id: 11, name: "344 Winchester", lat: 41.3187, lon: -72.9297 },
  { id: 55, name: "Elsewhere", lat: 41.31, lon: -72.94 },
];

const routes: Route[] = [
  { id: 1, name: "Blue", shortName: "B", color: "#00f", stops: [100, 11, 72] },
  { id: 3, name: "Red", shortName: "R", color: "#f00", stops: [72, 55] },
];

/** Verbatim capture, 2026-09-04. */
const CAPTURE: Record<string, unknown> = {
  "/routes_eta.php?stop=72": {
    etas: {
      "72": {
        etas: [
          { avg: 14, bus_id: 65954, bus_name: "#38", route: 1 },
          { avg: 5, bus_id: 65956, bus_name: "#310", route: 3 },
          // Route 2 does not exist in this network: upstream can name a route
          // whose sequence we do not have, and such a row must be dropped.
          { avg: 31, bus_id: 65967, bus_name: "#49", route: 2 },
        ],
      },
    },
    calculation_time: 0, // rewritten per-test to sit near the frozen clock
  },
  "/routes_eta.php?stop=100": {
    etas: {
      "100": {
        etas: [
          { avg: 38, bus_id: 65954, bus_name: "#38", route: 1 },
          { avg: 0, bus_id: 65986, bus_name: "#44", route: 1 },
        ],
      },
    },
  },
  // A stop with nothing approaching. Not an error.
  "/routes_eta.php?stop=11": {},
};

const NOW = 1_788_547_380_000;

let tmpDir: string;
let bundle: DbBundle;
let requested: string[];

function stubClient(
  body: (pathname: string) => unknown | undefined,
  opts: { status?: number; garbage?: boolean } = {},
): UpstreamClient {
  const fetchImpl = (async (url: string | URL) => {
    const u = new URL(String(url));
    const key = `${u.pathname}${u.search}`;
    requested.push(key);
    const found = body(key);
    if (found === undefined) {
      return new Response("not found", { status: opts.status ?? 404 });
    }
    if (opts.garbage) return new Response("<!doctype html><html></html>", { status: 200 });
    return new Response(JSON.stringify(found), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return new UpstreamClient({ baseUrl: "https://example.invalid", fetchImpl });
}

function makePoller(
  client: UpstreamClient,
  buses: BusPosition[] = [],
  over: Partial<ConstructorParameters<typeof UpstreamEtaPoller>[0]> = {},
): UpstreamEtaPoller {
  return new UpstreamEtaPoller({
    sqlite: bundle.sqlite,
    ref: new NetworkRef(TransitNetwork.build(stops, routes)),
    upstream: client,
    liveBuses: () => buses,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => NOW,
    sleep: async () => {}, // no real waiting in tests
    spacingMs: 0,
    ...over,
  });
}

function rows(): Array<Record<string, unknown>> {
  return bundle.sqlite
    .prepare(
      `SELECT bus_id, bus_name, route_id, from_stop_id, to_stop_id, stops_ahead,
              predicted_sec, predicted_low_sec, predicted_high_sec, predicted_at,
              client_build, surface
       FROM predictions_log ORDER BY to_stop_id, bus_id`,
    )
    .all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-uveta-"));
  bundle = openDb(path.join(tmpDir, "test.db"));
  migrate(bundle.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  requested = [];
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("UpstreamClient.stopEtas", () => {
  it("parses the recorded response onto our identifiers", async () => {
    const client = stubClient((k) => CAPTURE[k]);
    const answer = await client.stopEtas(72);
    expect(answer.etas).toEqual([
      { stopId: 72, busId: 65954, busName: "#38", routeId: 1, avgMin: 14 },
      { stopId: 72, busId: 65956, busName: "#310", routeId: 3, avgMin: 5 },
      { stopId: 72, busId: 65967, busName: "#49", routeId: 2, avgMin: 31 },
    ]);
  });

  it("reads a stop with nothing approaching as empty, not an error", async () => {
    const client = stubClient((k) => CAPTURE[k]);
    await expect(client.stopEtas(11)).resolves.toEqual({ calculatedAtMs: null, etas: [] });
  });

  it("ignores a calculation_time nowhere near our clock", async () => {
    const client = stubClient(() => ({
      etas: {},
      calculation_time: 1_000_000, // 1970
    }));
    const answer = await client.stopEtas(72);
    expect(answer.calculatedAtMs).toBeNull();
  });

  it("keeps the good rows when one vehicle is malformed", async () => {
    const client = stubClient(() => ({
      etas: {
        "72": {
          etas: [
            { avg: 4, bus_id: 1, bus_name: "#1", route: 1 },
            { avg: null, bus_id: null }, // upstream junk
            { avg: 9, bus_id: 2, bus_name: "#2", route: 1 },
          ],
        },
      },
    }));
    const answer = await client.stopEtas(72);
    expect(answer.etas.map((e) => e.busId)).toEqual([1, 2]);
  });

  it("throws UpstreamError when the host answers its SPA HTML", async () => {
    const client = stubClient(() => ({}), { garbage: true });
    await expect(client.stopEtas(72)).rejects.toThrow(/invalid JSON/);
  });
});

describe("UpstreamEtaPoller", () => {
  it("writes each upstream prediction with surface=upstream", async () => {
    const poller = makePoller(stubClient((k) => CAPTURE[k]), [], { stopsPerCycle: 3 });
    await poller.runCycle();

    const written = rows();
    expect(written.length).toBeGreaterThan(0);
    for (const r of written) expect(r["surface"]).toBe(UPSTREAM_SURFACE);
    // Route 2 is not in this network, so #49 is dropped — an upstream route we
    // cannot place a stop on is not a prediction we can score.
    expect(written.map((r) => r["bus_name"])).not.toContain("#49");
  });

  it("converts upstream minutes to seconds and carries no interval", async () => {
    const poller = makePoller(stubClient((k) => CAPTURE[k]), [], { stopsPerCycle: 3 });
    await poller.runCycle();
    const r = rows().find((x) => x["to_stop_id"] === 72 && x["bus_id"] === 65956)!;
    expect(r["predicted_sec"]).toBe(5 * 60);
    // No interval upstream: low = high = the point estimate, never invented.
    expect(r["predicted_low_sec"]).toBe(5 * 60);
    expect(r["predicted_high_sec"]).toBe(5 * 60);
    // A row nobody's browser produced carries no bundle hash.
    expect(r["client_build"]).toBeNull();
  });

  it("keeps avg:0 — upstream's 'Arrived' is a prediction like any other", async () => {
    const poller = makePoller(stubClient((k) => CAPTURE[k]), [], { stopsPerCycle: 3 });
    await poller.runCycle();
    const r = rows().find((x) => x["bus_id"] === 65986);
    expect(r?.["predicted_sec"]).toBe(0);
  });

  it("quantises predicted_at to the shared 15 s bucket", async () => {
    const poller = makePoller(stubClient((k) => CAPTURE[k]), [], { stopsPerCycle: 3 });
    await poller.runCycle();
    for (const r of rows()) {
      expect(Number(r["predicted_at"]) % PREDICTION_BUCKET_MS).toBe(0);
    }
  });

  it("takes from_stop_id and stops_ahead from our own live fleet, not upstream", async () => {
    const bus: BusPosition = {
      busId: 65954,
      busName: "#38",
      routeId: 1,
      lat: 41.32,
      lon: -72.92,
      heading: 0,
      lastStopId: 100, // route 1 is [100, 11, 72]
      atStopId: null,
      atStopSince: null,
      stationarySince: null,
      collectedAt: NOW,
    } as unknown as BusPosition;
    const poller = makePoller(stubClient((k) => CAPTURE[k]), [bus], { stopsPerCycle: 3 });
    await poller.runCycle();
    const r = rows().find((x) => x["to_stop_id"] === 72 && x["bus_id"] === 65954)!;
    expect(r["from_stop_id"]).toBe(100);
    expect(r["stops_ahead"]).toBe(2);
  });

  it("says -1 / 0 rather than inventing an anchor for a bus we cannot see", async () => {
    const poller = makePoller(stubClient((k) => CAPTURE[k]), [], { stopsPerCycle: 3 });
    await poller.runCycle();
    const r = rows().find((x) => x["to_stop_id"] === 72 && x["bus_id"] === 65954)!;
    expect(r["from_stop_id"]).toBe(-1);
    expect(r["stops_ahead"]).toBe(0);
  });

  it("polling the same stop twice in a bucket writes one row", async () => {
    const poller = makePoller(stubClient((k) => CAPTURE[k]), [], { stopsPerCycle: 3 });
    await poller.runCycle();
    const first = rows().length;
    await poller.runCycle();
    expect(rows().length).toBe(first);
  });

  it("polls the focus stops first, every cycle", async () => {
    const poller = makePoller(stubClient((k) => CAPTURE[k]), [], { stopsPerCycle: 3 });
    const picked = poller.pickStops();
    // The three focus stops this fixture's network knows, in FOCUS order.
    const known = FOCUS_STOP_NAMES.map((n) => stops.find((s) => s.name === n)?.id).filter(
      (x): x is number => x !== undefined,
    );
    expect(picked.slice(0, known.length)).toEqual(known);
  });

  it("rotates over the stops riders have watched", async () => {
    // One rider-reported row at stop 55, which is NOT a focus stop.
    bundle.sqlite
      .prepare(
        `INSERT INTO predictions_log
           (bus_id, bus_name, route_id, from_stop_id, to_stop_id, stops_ahead,
            predicted_sec, predicted_low_sec, predicted_high_sec, predicted_at,
            client_build, surface)
         VALUES (1, '#1', 3, 72, 55, 1, 120, 100, 140, ?, NULL, 'trip')`,
      )
      .run(NOW - 60_000);
    const poller = makePoller(stubClient((k) => CAPTURE[k]), [], { stopsPerCycle: 4 });
    expect(poller.pickStops()).toContain(55);
  });

  it("one stop's failure costs one stop", async () => {
    const poller = makePoller(
      stubClient((k) => (k.includes("stop=72") ? undefined : CAPTURE[k])),
      [],
      { stopsPerCycle: 3 },
    );
    await poller.runCycle();
    expect(poller.failures).toBe(1);
    // Stop 100 still answered and was written.
    expect(rows().some((r) => r["to_stop_id"] === 100)).toBe(true);
  });

  it("never throws, whatever upstream does", async () => {
    const poller = makePoller(stubClient(() => undefined, { status: 500 }), [], {
      stopsPerCycle: 3,
    });
    await expect(poller.runCycle()).resolves.toBeUndefined();
    expect(rows()).toHaveLength(0);
  });

  it("does not overlap itself", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client = {
      stopEtas: async () => {
        await gate;
        return { calculatedAtMs: null, etas: [] };
      },
    } as unknown as UpstreamClient;
    const poller = makePoller(client, [], { stopsPerCycle: 2 });
    const first = poller.runCycle();
    await poller.runCycle(); // returns immediately, does not queue
    release();
    await first;
    expect(poller.cycles).toBe(1);
  });
});
