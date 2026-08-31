import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Collector } from "../collector/collector.js";
import type { UpstreamClient, RawBus } from "../collector/upstream.js";
import { openDb, type DbBundle } from "../db/client.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import type { BusPosition, Route, Stop } from "../schema/api.js";

import { buildApp } from "./app.js";

// A fake upstream that returns a fixed snapshot. The collector contract
// is just "give me these three methods" so we don't need network access.
function fakeUpstream(buses: RawBus[], stops: Stop[], routes: Route[]): UpstreamClient {
  return {
    buses: async () => buses,
    stops: async () =>
      stops.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })),
    routes: async () =>
      routes.map((r) => ({
        id: r.id,
        name: r.name,
        shortName: r.shortName,
        color: r.color,
        stops: r.stops,
      })),
  } as UpstreamClient;
}

const stops: Stop[] = [
  { id: 1, name: "A", lat: 41.31, lon: -72.93 },
  { id: 2, name: "B", lat: 41.31, lon: -72.92 },
  { id: 3, name: "C", lat: 41.31, lon: -72.91 },
];

const routes: Route[] = [
  { id: 10, name: "Loop", shortName: "L", color: "#000", stops: [1, 2, 3] },
];

let tmpDir: string;
let bundle: DbBundle;
let collector: Collector;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-test-"));
  bundle = openDb(path.join(tmpDir, "test.db"));
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
  collector = await Collector.create(bundle, {
    upstream: fakeUpstream([], stops, routes),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  // Don't call start() — we don't want background timers in tests. The
  // refreshStaticIfNeeded call below does the static load synchronously.
  await (collector as unknown as { refreshStaticIfNeeded: (force: boolean) => Promise<void> })
    .refreshStaticIfNeeded(true);
  app = buildApp({ collector, bundle, now: () => 1_700_000_000_000 });
});

afterEach(() => {
  collector.stop();
  bundle.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /healthz", () => {
  it("reports liveness and bus count", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; knownBuses: number };
    expect(body.ok).toBe(true);
    expect(body.knownBuses).toBe(0);
  });

  it("returns 503 when the poll loop is wedged", async () => {
    (collector as unknown as { lastPollAttemptAt: number }).lastPollAttemptAt =
      Date.now() - 5 * 60_000;
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });
});

describe("body limits", () => {
  it("rejects an oversized report payload with 413", async () => {
    const res = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "x".repeat(70_000) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("GET /api/live", () => {
  it("returns stops + routes from the static refresh", async () => {
    const res = await app.request("/api/live");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stops: Stop[]; routes: Route[] };
    expect(body.stops.map((s) => s.id).sort()).toEqual([1, 2, 3]);
    expect(body.routes[0]!.shortName).toBe("L");
  });
});

describe("POST /api/plan", () => {
  it("rejects malformed bodies", async () => {
    const res = await app.request("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: { lat: 41 }, to: { lat: 41, lon: -72 } }),
    });
    expect(res.status).toBe(400);
  });

  it("returns a walk-only plan with no buses available", async () => {
    const res = await app.request("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: { lat: 41.31, lon: -72.93 },
        to: { lat: 41.3105, lon: -72.93 }, // ~55 m away
        departAt: null,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plans: { badge: string | null }[] };
    expect(body.plans[0]?.badge).toBe("walk-only");
  });
});

describe("GET /api/geocode", () => {
  // The geocode endpoint speaks v1's shape: {display_name, lat, lon, type, class}.
  it("ranks shuttle stops with name matches", async () => {
    const res = await app.request("/api/geocode?q=A");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ display_name: string; class: string }> };
    expect(body.results.some((r) => r.display_name === "A" && r.class === "shuttle")).toBe(true);
  });

  it("falls back to landmarks for landmark-shaped queries", async () => {
    const res = await app.request("/api/geocode?q=peabody");
    const body = (await res.json()) as { results: Array<{ display_name: string; class: string }> };
    expect(body.results.some((r) => r.class === "yale")).toBe(true);
  });

  // Report #14: "yale school of public health" found nothing while
  // "school of public health" worked — superset queries must still match.
  it("matches landmarks when the query has a redundant 'yale' prefix", async () => {
    const res = await app.request(
      "/api/geocode?q=" + encodeURIComponent("yale school of public health"),
    );
    const body = (await res.json()) as { results: Array<{ display_name: string }> };
    expect(
      body.results.some((r) => r.display_name.includes("School of Public Health")),
    ).toBe(true);
  });

  it("matches landmarks on out-of-order token subsets", async () => {
    const res = await app.request(
      "/api/geocode?q=" + encodeURIComponent("yale peabody museum"),
    );
    const body = (await res.json()) as { results: Array<{ display_name: string }> };
    expect(body.results.some((r) => r.display_name === "Peabody Museum")).toBe(true);
  });
});

describe("getLiveBuses staleness", () => {
  it("evicts buses not seen within the live TTL", () => {
    const lp = (collector as unknown as { livePositions: Map<number, BusPosition> })
      .livePositions;
    const now = Date.now();
    const mk = (busId: number, collectedAt: number): BusPosition => ({
      busId,
      busName: `#${busId}`,
      routeId: 10,
      lat: 41.31,
      lon: -72.93,
      heading: 0,
      lastStopId: 1,
      atStopId: null,
      atStopSince: null,
      collectedAt,
    });
    lp.set(1, mk(1, now)); // fresh
    lp.set(2, mk(2, now - 5 * 60_000)); // 5 min stale — out of service

    const ids = collector.getLiveBuses().map((b) => b.busId).sort();
    expect(ids).toEqual([1]);
  });
});

describe("reports", () => {
  it("submits, lists, and updates a report", async () => {
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "issue", routeId: 10, body: "wrong ETA" }),
    });
    expect(submit.status).toBe(200);
    const { id } = (await submit.json()) as { id: number };
    expect(id).toBeGreaterThan(0);

    const list = await app.request("/api/reports?status=open");
    const body = (await list.json()) as { reports: Array<{ id: number; status: string }> };
    expect(body.reports[0]?.id).toBe(id);
    expect(body.reports[0]?.status).toBe("open");

    const update = await app.request(`/api/reports/${id}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "addressed", note: "fixed in v2" }),
    });
    expect(update.status).toBe(200);

    const reList = await app.request("/api/reports?status=addressed");
    const reBody = (await reList.json()) as { reports: Array<{ id: number }> };
    expect(reBody.reports[0]?.id).toBe(id);
  });
});
