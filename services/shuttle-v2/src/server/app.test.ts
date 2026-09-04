import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_ANON_ID } from "./actives.js";
import { Collector } from "../collector/collector.js";
import type { UpstreamClient, RawBus } from "../collector/upstream.js";
import { openDb, type DbBundle } from "../db/client.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

import type { BusPosition, Route, Stop } from "../schema/api.js";

import { buildApp } from "./app.js";
import { resetRateLimits } from "./reports.js";

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
        ...(r.description !== undefined ? { description: r.description } : {}),
      })),
  } as UpstreamClient;
}

const stops: Stop[] = [
  { id: 1, name: "A", lat: 41.31, lon: -72.93 },
  { id: 2, name: "B", lat: 41.31, lon: -72.92 },
  { id: 3, name: "C", lat: 41.31, lon: -72.91 },
];

const routes: Route[] = [
  { id: 10, name: "Loop", shortName: "L", color: "#000", stops: [1, 2, 3], description: "7am - 6pm, M - F" },
  // A description the parser cannot read: must be absent from route_hours,
  // never a crash or a half-parsed window.
  { id: 11, name: "Shuttle", shortName: "S", color: "#111", stops: [3, 2, 1], description: "See website" },
  { id: 12, name: "Bare", shortName: "B", color: "#222", stops: [1, 3] },
];

// Injected rather than read from $SHUTTLE_ADMIN_TOKEN so the suite doesn't
// depend on (or leak into) the ambient environment.
const TEST_ADMIN_TOKEN = "test-admin-token";

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
  app = buildApp({
    collector,
    bundle,
    now: () => 1_700_000_000_000,
    adminToken: TEST_ADMIN_TOKEN,
    // The clock here is frozen in 2023; count from before it.
    statsSinceDay: "2000-01-01",
    // Keeps /api/geocode off the network; the external half (Photon and
    // Nominatim, with a stubbed fetch) is covered in v1compat.geocode.test.ts.
    geocoder: { lookup: async () => [] },
  });
  // Per-browser budgets now key on the anon id, which the tests reuse across
  // the file; with the frozen clock a bucket never expires on its own.
  resetRateLimits();
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

  // These counters stay flat in normal operation, so a non-zero value is the
  // only outward signal that upstream latency is causing dropped poll ticks.
  it("surfaces collector poll counters", async () => {
    const res = await app.request("/healthz");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("pollSkipped");
    expect(body).toHaveProperty("droppedObservations");
    expect(body.pollSkipped).toBe(0);
    expect(body.droppedObservations).toBe(0);
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
    // The limit is sized for a downscaled screenshot (3 MB); anything past it
    // is refused before parsing.
    const res = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "x".repeat(3 * 1024 * 1024 + 1024) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("report screenshots", () => {
  // 1x1 red PNG — a real one, since the server verifies magic bytes.
  const PNG_1PX =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

  it("stores an attached screenshot and serves it back to the operator", async () => {
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "map is blank", image: PNG_1PX, source: "feedback" }),
    });
    expect(submit.status).toBe(200);
    const d = (await submit.json()) as { ok: boolean; id: number; attached: boolean };
    expect(d.attached).toBe(true);

    const img = await app.request(`/api/reports/${d.id}/image`, {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await img.arrayBuffer());
    expect(bytes[0]).toBe(0x89); // PNG magic survived the round trip

    // ...and never to anyone without the token.
    const anon = await app.request(`/api/reports/${d.id}/image`);
    expect(anon.status).toBe(401);
  });

  it("keeps the report when the image is garbage", async () => {
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "real words", image: "data:image/png;base64,AAAA" }),
    });
    expect(submit.status).toBe(200);
    const d = (await submit.json()) as { ok: boolean; attached: boolean };
    expect(d.ok).toBe(true);
    expect(d.attached).toBe(false); // words kept, junk image dropped
  });

  it("404s for a report with no screenshot", async () => {
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "no image here" }),
    });
    const d = (await submit.json()) as { id: number };
    const img = await app.request(`/api/reports/${d.id}/image`, {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    expect(img.status).toBe(404);
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

// /api/buses is memoized on the collector's data version (plus a 1 s
// wall-clock bound) so 200 riders polling in one collector tick cost one
// build. These guard the two ways that can go wrong: a changed shape, and a
// stale answer.
describe("GET /api/buses", () => {
  const observe = (busId: number, collectedAt: number) =>
    (collector as unknown as {
      updateLivePositions: (o: readonly Record<string, unknown>[]) => void;
    }).updateLivePositions([
      {
        busId,
        busName: `#${busId}`,
        routeId: 10,
        lat: 41.31,
        lon: -72.93,
        heading: 0,
        lastStopId: 1,
        collectedAt,
      },
    ]);

  it("serves the v1 payload shape as JSON", async () => {
    const res = await app.request("/api/buses");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "announcements",
      "bus_pace",
      "buses",
      "dwells",
      "dwells_by_bus",
      "route_hours",
      "route_paths",
      "route_peaks",
      "routes",
      "segments",
      "stop_coords",
      "stop_names",
    ]);
    expect(Object.keys(body.stop_names as object).sort()).toEqual(["1", "2", "3"]);
    expect((body.routes as Record<string, number[]>)["10"]).toEqual([1, 2, 3]);
  });

  it("publishes the operator's timetable per route as route_hours", async () => {
    const body = (await (await app.request("/api/buses")).json()) as {
      route_hours: Record<string, { days: number[]; startMin: number; endMin: number; text: string }>;
      routes: Record<string, number[]>;
    };
    // Every route is in the topology…
    expect(Object.keys(body.routes).sort()).toEqual(["10", "11", "12"]);
    // …but only the one whose description parsed carries hours. Keyed by
    // route id, as the client's ROUTE_LISTS.routeIds are.
    expect(body.route_hours).toEqual({
      "10": { days: [1, 2, 3, 4, 5], startMin: 7 * 60, endMin: 18 * 60, text: "7am - 6pm, M - F" },
    });
  });

  // The stand/drive split the client's hopPricing.ts consumes: `q`/`qn` on the
  // stop, `drive`/`driveN` on the hop, whole seconds, present only where the
  // calibrator attached them and always with the true count (the client gates
  // on it; the server never pre-filters).
  it("carries the stand quantiles and drive beside v1's numbers, and omits them where absent", async () => {
    const net = collector.ref.get();
    net.setCalibration(
      new Map([
        ["10:1:2", { mean: 495.06, stddev: 5, n: 0, source: "route-segment" as const, drive: 15.1, driveN: 25 }],
        ["10:2:3", { mean: 60, stddev: 5, n: 3, source: "specific" as const }],
      ]),
      new Map([
        ["10:1", { mean: 415.3, stddev: 279.8, n: 0, q: [118.1, 136.5, 302.8, 598.1], qn: 24 }],
        ["10:2", { mean: 20, stddev: 5, n: 2 }],
      ]),
    );
    (collector as unknown as { version: number }).version++;
    const body = (await (await app.request("/api/buses")).json()) as {
      segments: Record<string, Record<string, Record<string, unknown>>>;
      dwells: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(body.segments["10"]!["1-2"]).toEqual({ avg: 495.1, sd: 5, n: 0, drive: 15, driveN: 25 });
    expect(body.segments["10"]!["2-3"]).toEqual({ avg: 60, sd: 5, n: 3 });
    expect(body.dwells["10"]!["1"]).toEqual({ med: 415.3, sd: 279.8, n: 0, q: [118, 137, 303, 598], qn: 24 });
    expect(body.dwells["10"]!["2"]).toEqual({ med: 20, sd: 5, n: 2 });
  });

  it("rebuilds when the collector observes a new position", async () => {
    const first = (await (await app.request("/api/buses")).json()) as { buses: unknown[] };
    expect(first.buses).toEqual([]);
    observe(7, Date.now());
    const second = (await (await app.request("/api/buses")).json()) as {
      buses: Array<{ bus_id: number }>;
    };
    expect(second.buses.map((b) => b.bus_id)).toEqual([7]);
  });

  // The version key alone isn't enough: during an upstream outage no poll
  // lands, so the version never moves — but getLiveBuses() still ages buses
  // out against the clock, and a version-only cache would serve ghosts.
  it("drops buses that age out with no further polls", async () => {
    observe(7, Date.now());
    const before = (await (await app.request("/api/buses")).json()) as { buses: unknown[] };
    expect(before.buses).toHaveLength(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000); // past LIVE_BUS_TTL_MS
      const after = (await (await app.request("/api/buses")).json()) as { buses: unknown[] };
      expect(after.buses).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// predictions_log has no writers, so this is the only answer the endpoint can
// give — it just has to give it without touching SQLite.
describe("GET /api/accuracy", () => {
  it("returns the empty rollup", async () => {
    const res = await app.request("/api/accuracy");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ overall: null, buckets: [], stops: [] });
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

  // departAt was required by the schema while the handler had a `?? now()`
  // fallback, so omitting it — the natural way to say "leaving now" — 400'd.
  it("treats a missing departAt as 'now'", async () => {
    const res = await app.request("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: { lat: 41.31, lon: -72.93 },
        to: { lat: 41.3105, lon: -72.93 },
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
    const admin = { "x-admin-token": TEST_ADMIN_TOKEN };
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "issue", routeId: 10, body: "wrong ETA" }),
    });
    expect(submit.status).toBe(200);
    const { id } = (await submit.json()) as { id: number };
    expect(id).toBeGreaterThan(0);

    const list = await app.request("/api/reports?status=open", { headers: admin });
    const body = (await list.json()) as { reports: Array<{ id: number; status: string }> };
    expect(body.reports[0]?.id).toBe(id);
    expect(body.reports[0]?.status).toBe("open");

    const update = await app.request(`/api/reports/${id}/update`, {
      method: "POST",
      headers: { "content-type": "application/json", ...admin },
      body: JSON.stringify({ status: "addressed", note: "fixed in v2" }),
    });
    expect(update.status).toBe(200);

    const reList = await app.request("/api/reports?status=addressed", { headers: admin });
    const reBody = (await reList.json()) as { reports: Array<{ id: number }> };
    expect(reBody.reports[0]?.id).toBe(id);
  });

  // Rider counts are operator-only: an audience number should not be public
  // just because it happens to be anonymous.
  it("refuses rider stats without the admin token", async () => {
    const res = await app.request("/api/stats");
    expect(res.status).toBe(401);
  });

  it("returns rider counts with the admin token", async () => {
    const anon = "11111111-2222-4333-8444-555555555555";
    // Two polls from one rider must count as one person.
    await app.request("/api/buses", { headers: { "x-anon-id": anon } });
    await app.request("/api/buses", { headers: { "x-anon-id": anon } });
    const res = await app.request("/api/stats", {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { riders: { today: number; allTime: number } };
    expect(body.riders.today).toBe(1);
    expect(body.riders.allTime).toBe(1);
  });

  it("serves /api/buses normally when no anon id is sent", async () => {
    // Counting must be strictly optional — an old client, or one with
    // localStorage disabled, still gets its data.
    const res = await app.request("/api/buses");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { buses: unknown[] }).buses).toBeDefined();
  });

  // The triage endpoints served reporter IPs and accepted destructive writes
  // from anyone. Riders never call them; only operator curl and the map-bot do.
  it("refuses to list reports without the admin token", async () => {
    const res = await app.request("/api/reports?status=open");
    expect(res.status).toBe(401);
    // The reporter's IP must not appear in the rejection.
    expect(await res.text()).not.toContain("clientIp");
  });

  it("refuses to list reports with a wrong admin token", async () => {
    const res = await app.request("/api/reports?status=open", {
      headers: { "x-admin-token": "wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("refuses to update a report without the admin token", async () => {
    const res = await app.request("/api/reports/1/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "addressed" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an oversized triage-update body with 413", async () => {
    const res = await app.request("/api/reports/1/update", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": TEST_ADMIN_TOKEN },
      body: JSON.stringify({ status: "addressed", note: "x".repeat(10_000) }),
    });
    expect(res.status).toBe(413);
  });

  // An unconfigured deploy must be inert, not open.
  it("fails closed when no admin token is configured", async () => {
    const openApp = buildApp({
      collector,
      bundle,
      now: () => 1_700_000_000_000,
      adminToken: "",
    });
    const res = await openApp.request("/api/reports?status=open");
    expect(res.status).toBe(503);
  });
});

describe("rider self-service (my-reports)", () => {
  const OWNER = "11111111-2222-4333-8444-555555555555";
  const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  // The rate-limit buckets are module-level and the test clock is frozen, so
  // every request from the default "anon" IP shares one never-expiring
  // bucket across the whole file. A fresh IP per request keeps these tests
  // about reports, not rate limits.
  let ipCounter = 0;
  const freshIp = () => {
    ipCounter += 1;
    return { "fly-client-ip": `10.9.${ipCounter >> 8}.${ipCounter & 255}` };
  };

  async function submit(anonId: string | null, note: string): Promise<number> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...freshIp(),
    };
    if (anonId) headers["x-anon-id"] = anonId;
    const res = await app.request("/api/report", {
      method: "POST",
      headers,
      body: JSON.stringify({ note, source: "feedback" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number; attached: boolean };
    // The v1 payload contract must survive the anon-id capture untouched.
    expect(body.ok).toBe(true);
    expect(body.attached).toBe(false);
    return body.id;
  }

  it("stores the submitter's anon id when present and valid", async () => {
    const id = await submit(OWNER, "wheel fell off");
    const row = bundle.sqlite
      .prepare("SELECT anon_id FROM reports WHERE id = ?")
      .get(id) as { anon_id: string | null };
    expect(row.anon_id).toBe(OWNER);
  });

  it("stores null for a missing or implausible anon id", async () => {
    const noHeader = await submit(null, "no header");
    const res = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": "not-a-uuid", ...freshIp() },
      body: JSON.stringify({ note: "bad header" }),
    });
    const badHeader = ((await res.json()) as { id: number }).id;
    const rows = bundle.sqlite
      .prepare("SELECT id, anon_id FROM reports WHERE id IN (?, ?)")
      .all(noHeader, badHeader) as Array<{ anon_id: string | null }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.anon_id).toBeNull();
  });

  it("returns only the owner's reports, newest first, in the contract shape", async () => {
    const first = await submit(OWNER, "mine, older");
    const second = await submit(OWNER, "mine, newer");
    await submit(OTHER, "someone else's");
    await submit(null, "anonymous");

    const res = await app.request("/api/my-reports", {
      headers: { "x-anon-id": OWNER, ...freshIp() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { reports: Array<Record<string, unknown>> };
    expect(body.reports).toHaveLength(2);
    expect(body.reports.map((r) => r.id)).toEqual([second, first]);

    const r = body.reports[0]!;
    // Exact contract with the frontend: these keys and no others.
    expect(Object.keys(r).sort()).toEqual(
      ["archived", "body", "createdAt", "followups", "hasImage", "id", "kind", "note", "priority", "replies", "status"],
    );
    expect(r.kind).toBe("feedback");
    expect(r.body).toBe("mine, newer");
    expect(r.status).toBe("open");
    expect(r.note).toBeNull();
    expect(r.replies).toEqual([]);
    expect(r.hasImage).toBe(false);
    expect(r.followups).toEqual([]);
    expect(typeof r.createdAt).toBe("number");
    // Leak check on the raw payload: nothing internal escapes.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("client_ip");
    expect(raw).not.toContain("clientIp");
    expect(raw).not.toContain("context");
    expect(raw).not.toContain(OTHER);
  });

  it("reports hasImage for a report submitted with a screenshot", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const res = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": OWNER, ...freshIp() },
      body: JSON.stringify({
        note: "see attached",
        image: `data:image/png;base64,${png.toString("base64")}`,
      }),
    });
    expect(((await res.json()) as { attached: boolean }).attached).toBe(true);
    const list = await app.request("/api/my-reports", { headers: { "x-anon-id": OWNER } });
    const body = (await list.json()) as { reports: Array<{ hasImage: boolean }> };
    expect(body.reports[0]!.hasImage).toBe(true);
    // hasImage is a boolean, not the filename — the file stays admin-only.
    expect(JSON.stringify(body)).not.toContain("imageFile");
  });

  it("returns an empty list without a valid anon id", async () => {
    await submit(OWNER, "exists");
    for (const headers of [freshIp(), { "x-anon-id": "zzz", ...freshIp() }, { "x-anon-id": "", ...freshIp() }]) {
      const res = await app.request("/api/my-reports", { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ reports: [] });
    }
  });

  it("lets the reporter mark their report resolved without touching the operator note", async () => {
    const id = await submit(OWNER, "eta was wrong");
    // Operator triages it first with a note.
    await app.request(`/api/reports/${id}/update`, {
      method: "POST",
      headers: { "x-admin-token": TEST_ADMIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ status: "open", note: "investigating" }),
    });

    const res = await app.request(`/api/my-reports/${id}/update`, {
      method: "POST",
      headers: { "x-anon-id": OWNER, "content-type": "application/json", ...freshIp() },
      body: JSON.stringify({ action: "resolve" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "addressed" });

    const list = await app.request("/api/my-reports", { headers: { "x-anon-id": OWNER } });
    const body = (await list.json()) as {
      reports: Array<{ status: string; note: string | null; followups: Array<{ text: string; at: number }> }>;
    };
    expect(body.reports[0]!.status).toBe("addressed");
    // Append, don't replace: the operator's note survives.
    expect(body.reports[0]!.note).toBe("investigating");
    expect(body.reports[0]!.followups).toHaveLength(1);
    expect(body.reports[0]!.followups[0]!.text).toMatch(/resolved/i);
    expect(body.reports[0]!.followups[0]!.at).toBe(1_700_000_000_000);
  });

  it("reopens an addressed report when the reporter follows up", async () => {
    const id = await submit(OWNER, "bus vanished");
    await app.request(`/api/reports/${id}/update`, {
      method: "POST",
      headers: { "x-admin-token": TEST_ADMIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ status: "addressed", note: "fixed in deploy" }),
    });

    const res = await app.request(`/api/my-reports/${id}/update`, {
      method: "POST",
      headers: { "x-anon-id": OWNER, "content-type": "application/json", ...freshIp() },
      body: JSON.stringify({ action: "followup", text: "still happening today" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "open" });

    const list = await app.request("/api/my-reports", { headers: { "x-anon-id": OWNER } });
    const body = (await list.json()) as {
      reports: Array<{ status: string; note: string | null; followups: Array<{ text: string; at: number }> }>;
    };
    expect(body.reports[0]!.status).toBe("open");
    expect(body.reports[0]!.note).toBe("fixed in deploy");
    expect(body.reports[0]!.followups).toEqual([
      { text: "still happening today", at: 1_700_000_000_000 },
    ]);
  });

  it("shows the rider only the part of a note above the --- rule, tag stripped", async () => {
    const id = await submit(OWNER, "rain warning please");
    await app.request(`/api/reports/${id}/update`, {
      method: "POST",
      headers: { "x-admin-token": TEST_ADMIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({
        status: "open",
        note: "[pr] Thanks — a fix is in the works!\n---\nPR: https://github.com/x/y/pull/2 (planner.ts:218)",
      }),
    });
    const list = await app.request("/api/my-reports", { headers: { "x-anon-id": OWNER, ...freshIp() } });
    const body = (await list.json()) as { reports: Array<{ note: string | null }> };
    expect(body.reports[0]!.note).toBe("Thanks — a fix is in the works!");
    expect(JSON.stringify(body)).not.toContain("github");
    // The operator still sees the whole note.
    const admin = await app.request("/api/reports?limit=50", { headers: { "x-admin-token": TEST_ADMIN_TOKEN } });
    const all = (await admin.json()) as { reports: Array<{ id: number; note: string }> };
    expect(all.reports.find((r) => r.id === id)!.note).toContain("github");
  });

  it("budgets report submissions per browser, not per shared IP", async () => {
    // A whole building behind one campus NAT address: browser A exhausting
    // its 10/min must not lock browser B out, and vice versa.
    const ip = { "fly-client-ip": "10.200.0.1" };
    const A = "aaaaaaaa-0000-4000-8000-000000000001";
    const B = "aaaaaaaa-0000-4000-8000-000000000002";
    const post = (anon: string) => app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": anon, ...ip },
      body: JSON.stringify({ note: "x", source: "feedback" }),
    });
    for (let i = 0; i < 10; i++) expect((await post(A)).status).toBe(200);
    expect((await post(A)).status).toBe(429);
    expect((await post(B)).status).toBe(200);
    // The list endpoint likewise: A's budget is A's alone.
    const list = (anon: string) => app.request("/api/my-reports", { headers: { "x-anon-id": anon, ...ip } });
    for (let i = 0; i < 30; i++) expect((await list(A)).status).toBe(200);
    expect((await list(A)).status).toBe(429);
    expect((await list(B)).status).toBe(200);
  });

  it("does not store an oversized context snapshot", async () => {
    const res = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": OWNER, ...freshIp() },
      body: JSON.stringify({ note: "huge", source: "feedback", junk: "z".repeat(200 * 1024) }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: number };
    const row = bundle.sqlite.prepare("SELECT context FROM reports WHERE id = ?").get(id) as { context: string };
    expect(row.context.length).toBeLessThan(1024);
    expect(JSON.parse(row.context)).toMatchObject({ note: "huge", contextTruncated: true });
  });

  it("keeps every reply as its own thread entry instead of overwriting", async () => {
    // The rider was watching one bubble get rewritten: answered twice, they
    // only ever saw the second answer.
    const id = await submit(OWNER, "bus never came");
    const note = (text: string) => app.request(`/api/reports/${id}/update`, {
      method: "POST",
      headers: { "x-admin-token": TEST_ADMIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ status: "open", note: text }),
    });
    await note("[triage] Looking into it.\n---\noperator log one");
    await note("[triage] Looking into it.\n---\noperator log one"); // re-stamp: not a new bubble
    await note("[fixed] Fixed now.\n---\noperator log two");

    const list = await app.request("/api/my-reports", { headers: { "x-anon-id": OWNER, ...freshIp() } });
    const body = (await list.json()) as {
      reports: Array<{ note: string | null; replies: Array<{ text: string; at: number }> }>;
    };
    const r = body.reports[0]!;
    expect(r.replies.map((x) => x.text)).toEqual(["Looking into it.", "Fixed now."]);
    // Rider-facing filtering still applies to every entry, not just the last.
    expect(JSON.stringify(r.replies)).not.toContain("operator log");
    // `note` still carries the latest for older clients.
    expect(r.note).toBe("Fixed now.");
    // The operator keeps the full text of the latest note.
    const admin = await app.request("/api/reports?limit=50", { headers: { "x-admin-token": TEST_ADMIN_TOKEN } });
    const all = (await admin.json()) as { reports: Array<{ id: number; note: string }> };
    expect(all.reports.find((x) => x.id === id)!.note).toContain("operator log two");
  });

  it("shows a single reply for a report answered before the thread existed", async () => {
    const id = await submit(OWNER, "older report");
    // Simulate the pre-thread world: a note on the row, no history in context.
    bundle.sqlite.prepare("UPDATE reports SET note = ? WHERE id = ?").run("Thanks, sorted.", id);
    const list = await app.request("/api/my-reports", { headers: { "x-anon-id": OWNER, ...freshIp() } });
    const body = (await list.json()) as { reports: Array<{ id: number; replies: Array<{ text: string }> }> };
    const r = body.reports.find((x) => x.id === id)!;
    expect(r.replies.map((x) => x.text)).toEqual(["Thanks, sorted."]);
  });

  it("accepts a screenshot on a follow-up and keeps it admin-only", async () => {
    const id = await submit(OWNER, "the map looked wrong");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const res = await app.request(`/api/my-reports/${id}/update`, {
      method: "POST",
      headers: { "x-anon-id": OWNER, "content-type": "application/json", ...freshIp() },
      body: JSON.stringify({
        action: "followup",
        text: "here is what I meant",
        image: `data:image/png;base64,${png.toString("base64")}`,
      }),
    });
    expect(res.status).toBe(200);

    const list = await app.request("/api/my-reports", { headers: { "x-anon-id": OWNER, ...freshIp() } });
    const body = (await list.json()) as {
      reports: Array<{ followups: Array<{ text: string; hasImage?: boolean }> }>;
    };
    const f = body.reports[0]!.followups[0]!;
    expect(f.text).toBe("here is what I meant");
    expect(f.hasImage).toBe(true);
    // A boolean, never the filename — the file is admin-only, like the
    // report's own screenshot.
    expect(JSON.stringify(body)).not.toContain("imageFile");
    expect(JSON.stringify(body)).not.toMatch(/[a-f0-9]{24}\.png/);

    const img = await app.request(`/api/reports/${id}/followups/0/image`, {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    const unauth = await app.request(`/api/reports/${id}/followups/0/image`);
    expect(unauth.status).toBe(401);
    const missing = await app.request(`/api/reports/${id}/followups/9/image`, {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    expect(missing.status).toBe(404);
  });

  it("still records a follow-up when the attachment is unusable", async () => {
    const id = await submit(OWNER, "words matter more than the picture");
    const res = await app.request(`/api/my-reports/${id}/update`, {
      method: "POST",
      headers: { "x-anon-id": OWNER, "content-type": "application/json", ...freshIp() },
      body: JSON.stringify({ action: "followup", text: "still broken", image: "data:text/plain;base64,aGk=" }),
    });
    expect(res.status).toBe(200);
    const list = await app.request("/api/my-reports", { headers: { "x-anon-id": OWNER, ...freshIp() } });
    const body = (await list.json()) as { reports: Array<{ followups: Array<{ text: string; hasImage?: boolean }> }> };
    const f = body.reports[0]!.followups[0]!;
    expect(f.text).toBe("still broken");
    expect(f.hasImage).toBeUndefined();
  });

  it("404s a rider update for a report they do not own", async () => {
    const id = await submit(OWNER, "not yours");
    for (const headers of [
      { "x-anon-id": OTHER, "content-type": "application/json", ...freshIp() },
      { "content-type": "application/json", ...freshIp() }, // no id at all
    ]) {
      const res = await app.request(`/api/my-reports/${id}/update`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "resolve" }),
      });
      expect(res.status).toBe(404);
      // Existence is never confirmed: same body as a nonexistent id.
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    // ...and the report is untouched.
    const list = await app.request("/api/my-reports", { headers: { "x-anon-id": OWNER } });
    const body = (await list.json()) as { reports: Array<{ status: string }> };
    expect(body.reports[0]!.status).toBe("open");
  });

  it("rejects a malformed rider update", async () => {
    const id = await submit(OWNER, "hello");
    for (const bad of [
      {},
      { action: "delete" },
      { action: "followup" }, // no text
      { action: "followup", text: "   " },
    ]) {
      const res = await app.request(`/api/my-reports/${id}/update`, {
        method: "POST",
        headers: { "x-anon-id": OWNER, "content-type": "application/json", ...freshIp() },
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
  });

  it("caps follow-up text at 2000 chars", async () => {
    const id = await submit(OWNER, "long one");
    const res = await app.request(`/api/my-reports/${id}/update`, {
      method: "POST",
      headers: { "x-anon-id": OWNER, "content-type": "application/json", ...freshIp() },
      body: JSON.stringify({ action: "followup", text: "y".repeat(5000) }),
    });
    expect(res.status).toBe(200);
    const list = await app.request("/api/my-reports", { headers: { "x-anon-id": OWNER } });
    const body = (await list.json()) as { reports: Array<{ followups: Array<{ text: string }> }> };
    expect(body.reports[0]!.followups[0]!.text).toHaveLength(2000);
  });
});

describe("operator ownership backfill", () => {
  const ANON = "7a3dbbac-0000-4000-8000-000000000001";
  it("links a pre-anon-id report to a browser, but never overwrites", async () => {
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "old report" }),
    });
    const { id } = (await submit.json()) as { id: number };

    const link = await app.request(`/api/reports/${id}/update`, {
      method: "POST",
      headers: { "x-admin-token": TEST_ADMIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ status: "open", anonId: ANON }),
    });
    expect(link.status).toBe(200);
    const mine = await app.request("/api/my-reports", { headers: { "x-anon-id": ANON } });
    const d = (await mine.json()) as { reports: Array<{ id: number }> };
    expect(d.reports.some((r) => r.id === id)).toBe(true);

    // A second backfill with a different id must NOT steal the report.
    await app.request(`/api/reports/${id}/update`, {
      method: "POST",
      headers: { "x-admin-token": TEST_ADMIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ status: "open", anonId: "9a9a9a9a-0000-4000-8000-000000000009" }),
    });
    const still = await app.request("/api/my-reports", { headers: { "x-anon-id": ANON } });
    expect(((await still.json()) as { reports: Array<{ id: number }> }).reports.some((r) => r.id === id)).toBe(true);
  });
});

describe("rider archive", () => {
  const ANON = "cafe0001-0000-4000-8000-00000000cafe";
  it("archives and unarchives without touching triage status", async () => {
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": ANON },
      body: JSON.stringify({ note: "old one" }),
    });
    const { id } = (await submit.json()) as { id: number };

    const arch = await app.request(`/api/my-reports/${id}/update`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": ANON },
      body: JSON.stringify({ action: "archive" }),
    });
    expect(arch.status).toBe(200);
    let mine = (await (await app.request("/api/my-reports", { headers: { "x-anon-id": ANON } })).json()) as
      { reports: Array<{ id: number; archived: boolean; status: string }> };
    let r = mine.reports.find((x) => x.id === id)!;
    expect(r.archived).toBe(true);
    expect(r.status).toBe("open"); // archive is list-tidying, not resolution

    await app.request(`/api/my-reports/${id}/update`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": ANON },
      body: JSON.stringify({ action: "unarchive" }),
    });
    mine = (await (await app.request("/api/my-reports", { headers: { "x-anon-id": ANON } })).json()) as typeof mine;
    expect(mine.reports.find((x) => x.id === id)!.archived).toBe(false);
  });

  it("cannot archive someone else's report", async () => {
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": ANON },
      body: JSON.stringify({ note: "mine" }),
    });
    const { id } = (await submit.json()) as { id: number };
    const res = await app.request(`/api/my-reports/${id}/update`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": "dead0002-0000-4000-8000-00000000beef" },
      body: JSON.stringify({ action: "archive" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("report priority", () => {
  it("operator sets it; list filters by it; the rider sees it", async () => {
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": "beef0003-0000-4000-8000-0000000000ff" },
      body: JSON.stringify({ note: "brakes on fire" }),
    });
    const { id } = (await submit.json()) as { id: number };

    const up = await app.request(`/api/reports/${id}/update`, {
      method: "POST",
      headers: { "x-admin-token": TEST_ADMIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ status: "open", priority: "urgent" }),
    });
    expect(up.status).toBe(200);

    const filtered = await app.request("/api/reports?priority=urgent", {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    const list = (await filtered.json()) as { reports: Array<{ id: number; priority: string }> };
    expect(list.reports.some((r) => r.id === id)).toBe(true);
    expect(list.reports.every((r) => r.priority === "urgent")).toBe(true);

    const mine = await app.request("/api/my-reports", {
      headers: { "x-anon-id": "beef0003-0000-4000-8000-0000000000ff" },
    });
    const d = (await mine.json()) as { reports: Array<{ id: number; priority: string }> };
    expect(d.reports.find((r) => r.id === id)?.priority).toBe("urgent");
  });

  it("garbage priority values are ignored, not stored", async () => {
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "x" }),
    });
    const { id } = (await submit.json()) as { id: number };
    await app.request(`/api/reports/${id}/update`, {
      method: "POST",
      headers: { "x-admin-token": TEST_ADMIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ status: "open", priority: "DEFCON 1; DROP TABLE reports" }),
    });
    const list = (await (await app.request("/api/reports?limit=5", { headers: { "x-admin-token": TEST_ADMIN_TOKEN } })).json()) as
      { reports: Array<{ id: number; priority: string }> };
    expect(list.reports.find((r) => r.id === id)?.priority).toBe("normal");
  });
});

describe("rider-set priority", () => {
  const ANON = "abcd0004-0000-4000-8000-0000000000aa";
  it("takes the rider's priority at submission and lets them change it later", async () => {
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": ANON, "fly-client-ip": "10.9.0.1" },
      body: JSON.stringify({ note: "shuttle on fire", priority: "urgent" }),
    });
    const { id } = (await submit.json()) as { id: number };
    let mine = (await (await app.request("/api/my-reports", { headers: { "x-anon-id": ANON } })).json()) as
      { reports: Array<{ id: number; priority: string }> };
    expect(mine.reports.find((r) => r.id === id)?.priority).toBe("urgent");

    const set = await app.request(`/api/my-reports/${id}/update`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": ANON },
      body: JSON.stringify({ action: "set_priority", priority: "nice_to_have" }),
    });
    expect(set.status).toBe(200);
    mine = (await (await app.request("/api/my-reports", { headers: { "x-anon-id": ANON } })).json()) as typeof mine;
    expect(mine.reports.find((r) => r.id === id)?.priority).toBe("nice_to_have");
  });

  it("junk priority at submission falls back to normal", async () => {
    const submit = await app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": ANON, "fly-client-ip": "10.9.0.2" },
      body: JSON.stringify({ note: "x", priority: "MAXIMUM OVERDRIVE" }),
    });
    const { id } = (await submit.json()) as { id: number };
    const mine = (await (await app.request("/api/my-reports", { headers: { "x-anon-id": ANON } })).json()) as
      { reports: Array<{ id: number; priority: string }> };
    expect(mine.reports.find((r) => r.id === id)?.priority).toBe("normal");
  });
});

describe("GET /api/weather", () => {
  // The service itself is covered in weather.test.ts; this is about the
  // wiring — that the endpoint is public, non-throwing, and passes the
  // payload through untouched.
  const withWeather = (get: () => Promise<unknown>) =>
    buildApp({
      collector,
      bundle,
      now: () => 1_700_000_000_000,
      adminToken: TEST_ADMIN_TOKEN,
      weather: { get: get as never },
    });

  it("serves the cached forecast to anyone, no token needed", async () => {
    const payload = {
      available: true,
      fetchedAtMs: 1_700_000_000_000,
      hourly: [{ timeMs: 1_700_000_000_000, probability: 60, precipitationMm: 1.2 }],
    };
    const res = await withWeather(async () => payload).request("/api/weather");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    // Shared by every rider, so it may be cached for the whole TTL.
    expect(res.headers.get("Cache-Control")).toContain("max-age=600");
  });

  it("answers unavailable rather than erroring when upstream never worked", async () => {
    const res = await withWeather(async () => ({ available: false })).request("/api/weather");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });
});

// The dashboard at /stats must not keep the admin token in the browser: one
// XSS, or one borrowed phone, would otherwise hand over the triage log with
// every reporter's IP address in it. The token is exchanged once for an
// HttpOnly cookie scoped to /api/stats and nothing else.
describe("operator stats session", () => {
  const FROZEN = 1_700_000_000_000;
  const ANON = "11111111-2222-4333-8444-555555555555";

  /** Mint a cookie value the way the server does, to forge good and bad ones. */
  const mint = (expiryMs: number, key = TEST_ADMIN_TOKEN) =>
    `${expiryMs}.${crypto.createHmac("sha256", key).update(String(expiryMs)).digest("hex")}`;

  const login = async () => {
    const res = await app.request("/api/stats/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TEST_ADMIN_TOKEN }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const value = /stats_session=([^;]+)/.exec(setCookie)?.[1] ?? "";
    return { setCookie, cookie: `stats_session=${value}` };
  };

  it("issues an HttpOnly, Strict, /api/stats-scoped cookie for the right token", async () => {
    const { setCookie } = await login();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    // Scoped so the cookie is never even sent to the report routes.
    expect(setCookie).toContain("Path=/api/stats");
    expect(setCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  });

  it("rejects a wrong token with a generic 401 and no cookie", async () => {
    const res = await app.request("/api/stats/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-the-token" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    // The body must say nothing that helps a guesser.
    expect(await res.text()).not.toContain(TEST_ADMIN_TOKEN);
  });

  // Otherwise the endpoint is a brute-force oracle for the admin token.
  it("rate-limits repeated login attempts", async () => {
    let last = 200;
    for (let i = 0; i < 12; i++) {
      const res = await app.request("/api/stats/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "guess" }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("accepts the session cookie on both stats routes", async () => {
    await app.request("/api/buses", { headers: { "x-anon-id": ANON } });
    const { cookie } = await login();

    const stats = await app.request("/api/stats", { headers: { cookie } });
    expect(stats.status).toBe(200);
    expect(((await stats.json()) as { riders: { today: number } }).riders.today).toBe(1);

    const history = await app.request("/api/stats/history", { headers: { cookie } });
    expect(history.status).toBe(200);
    const body = (await history.json()) as { history: { day: string; newRiders: number }[] };
    expect(body.history).toHaveLength(1);
    expect(body.history[0]!.newRiders).toBe(1);
  });

  // The whole point of scoping the cookie: it must not unlock the triage log.
  it("does not unlock the report routes", async () => {
    const { cookie } = await login();
    expect((await app.request("/api/reports?status=open", { headers: { cookie } })).status).toBe(401);
    expect((await app.request("/api/reports/1/image", { headers: { cookie } })).status).toBe(401);
    const exclude = await app.request("/api/stats/exclude", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ anonId: ANON, note: "nope" }),
    });
    expect(exclude.status).toBe(401);
  });

  it("rejects a tampered or forged cookie", async () => {
    const good = mint(FROZEN + 60_000);
    const flipped = `${good.slice(0, -1)}${good.endsWith("a") ? "b" : "a"}`;
    for (const value of [
      flipped,
      // Expiry rewritten without re-signing.
      `${FROZEN + 999_999_999}.${good.split(".")[1]}`,
      // Signed with a different key.
      mint(FROZEN + 60_000, "some-other-token"),
      "garbage",
      `${FROZEN + 60_000}.`,
      ".deadbeef",
    ]) {
      const res = await app.request("/api/stats", {
        headers: { cookie: `stats_session=${value}` },
      });
      expect(res.status).toBe(401);
    }
  });

  it("rejects an expired cookie and accepts an unexpired one", async () => {
    const expired = await app.request("/api/stats", {
      headers: { cookie: `stats_session=${mint(FROZEN - 1)}` },
    });
    expect(expired.status).toBe(401);

    const live = await app.request("/api/stats", {
      headers: { cookie: `stats_session=${mint(FROZEN + 60_000)}` },
    });
    expect(live.status).toBe(200);
  });

  it("still refuses both stats routes with no auth at all", async () => {
    expect((await app.request("/api/stats")).status).toBe(401);
    expect((await app.request("/api/stats/history")).status).toBe(401);
  });

  it("still accepts the admin header on both stats routes", async () => {
    const headers = { "x-admin-token": TEST_ADMIN_TOKEN };
    expect((await app.request("/api/stats", { headers })).status).toBe(200);
    const res = await app.request("/api/stats/history", { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("clamps the history window to 1..90 days", async () => {
    const headers = { "x-admin-token": TEST_ADMIN_TOKEN };
    for (const q of ["?days=0", "?days=-3", "?days=9999", "?days=abc", ""]) {
      const res = await app.request(`/api/stats/history${q}`, { headers });
      expect(res.status).toBe(200);
      expect(Array.isArray(((await res.json()) as { history: unknown[] }).history)).toBe(true);
    }
  });

  it("fails closed when no admin token is configured", async () => {
    const openApp = buildApp({ collector, bundle, now: () => FROZEN, adminToken: "" });
    expect((await openApp.request("/api/stats/history")).status).toBe(503);
    const res = await openApp.request("/api/stats/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "anything" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("static routes", () => {
  // Vite copies web/public/* verbatim, so stats.html lands beside index.html.
  // The extensionless /stats needs its own route — and must not cost the SPA
  // its fallback.
  const withStatic = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-static-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html>rider app</html>");
    fs.writeFileSync(path.join(dir, "stats.html"), "<html>operator dashboard</html>");
    return {
      dir,
      app: buildApp({
        collector,
        bundle,
        now: () => 1_700_000_000_000,
        adminToken: TEST_ADMIN_TOKEN,
        staticDir: dir,
      }),
    };
  };

  it("serves the dashboard at both /stats and /stats.html", async () => {
    const { dir, app: withDir } = withStatic();
    try {
      const bare = await withDir.request("/stats");
      expect(bare.status).toBe(200);
      expect(await bare.text()).toContain("operator dashboard");
      expect(bare.headers.get("cache-control")).toBe("no-store");

      const explicit = await withDir.request("/stats.html");
      expect(explicit.status).toBe(200);
      expect(await explicit.text()).toContain("operator dashboard");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still falls back to the rider app for unknown paths", async () => {
    const { dir, app: withDir } = withStatic();
    try {
      const res = await withDir.request("/plan/somewhere");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("rider app");
      // And an API path is never answered with HTML.
      expect((await withDir.request("/api/stats")).status).toBe(401);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the stats payload names its counting epoch", () => {
  it("returns `since` so the dashboard can say what it counts", async () => {
    const res = await app.request("/api/stats", { headers: { "x-admin-token": TEST_ADMIN_TOKEN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { since: string; riders: { today: number } };
    expect(body.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof body.riders.today).toBe("number");
  });
});

describe("GET /api/stats/reports — the dashboard's \"someone wrote in\" alert", () => {
  const OPERATOR = "11111111-1111-4111-8111-111111111111";
  const STRANGER = "22222222-2222-4222-8222-222222222222";

  const submit = async (body: string, anonId: string) =>
    app.request("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anon-id": anonId },
      // The public endpoint takes { note, source }, not { body, kind }.
      body: JSON.stringify({ note: body, source: "feedback" }),
    });

  const login = async () => {
    const res = await app.request("/api/stats/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TEST_ADMIN_TOKEN }),
    });
    const value = /stats_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
    return `stats_session=${value}`;
  };

  const claim = (anonId: string) =>
    app.request("/api/stats/operator", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": TEST_ADMIN_TOKEN },
      body: JSON.stringify({ anonId }),
    });

  it("shows a stranger's report and hides the operator's own", async () => {
    expect((await claim(OPERATOR)).status).toBe(200);
    expect((await submit("mine, from my phone", OPERATOR)).status).toBe(200);
    expect((await submit("the bus never came", STRANGER)).status).toBe(200);

    const res = await app.request("/api/stats/reports", {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reports: Array<{ excerpt: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.reports[0]!.excerpt).toBe("the bus never came");
  });

  it("is reachable with the stats cookie, and leaks nothing that identifies a reporter", async () => {
    await submit("something is wrong", STRANGER);
    const cookie = await login();
    const res = await app.request("/api/stats/reports", { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("something is wrong");
    // The cookie must never reach an IP or a browser id — that is the whole
    // reason /api/reports stays header-only.
    expect(text).not.toContain(STRANGER);
    expect(text).not.toContain("client_ip");
    expect(text).not.toContain("clientIp");
  });

  it("still refuses the cookie on the routes that DO carry reporter IPs", async () => {
    await submit("something is wrong", STRANGER);
    const cookie = await login();
    expect((await app.request("/api/reports", { headers: { cookie } })).status).toBe(401);
  });

  it("refuses an unauthenticated caller", async () => {
    expect((await app.request("/api/stats/reports")).status).toBe(401);
    expect((await app.request("/api/stats/operator", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anonId: OPERATOR }),
    })).status).toBe(401);
  });

  it("claims and releases an operator browser, and rejects a malformed id", async () => {
    const claimed = (await (await claim(OPERATOR)).json()) as { operators: string[] };
    expect(claimed.operators).toEqual([OPERATOR]);
    const released = await app.request("/api/stats/operator", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": TEST_ADMIN_TOKEN },
      body: JSON.stringify({ anonId: OPERATOR, remove: true }),
    });
    expect(((await released.json()) as { operators: string[] }).operators).toEqual([]);
    const bad = await app.request("/api/stats/operator", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": TEST_ADMIN_TOKEN },
      body: JSON.stringify({ anonId: "not-a-uuid" }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/stats/searches — what riders looked for", () => {
  const login = async () => {
    const res = await app.request("/api/stats/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TEST_ADMIN_TOKEN }),
    });
    const value = /stats_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
    return `stats_session=${value}`;
  };
  const search = (q: string) => app.request(`/api/geocode?q=${encodeURIComponent(q)}`);

  it("counts what was searched and what found nothing", async () => {
    // A place nothing knows about: the injected geocoder returns [] and no
    // curated landmark matches, so this is a genuine "found nothing" — the
    // signal worth having. ("one6three" would NOT do: #46 added it, which is
    // exactly the outcome this table exists to produce.)
    await search("zzz nowhere plaza");
    await search("zzz nowhere plaza");
    const res = await app.request("/api/stats/searches", {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      searches: number; zeroSearches: number;
      missing: Array<{ q: string; n: number }>;
    };
    expect(body.searches).toBe(2);
    expect(body.zeroSearches).toBe(2);
    expect(body.missing[0]!.q).toBe("zzz nowhere plaza");
  });

  it("is reachable with the stats cookie and carries no rider in it", async () => {
    await search("zzz ice palace");
    const cookie = await login();
    const res = await app.request("/api/stats/searches", { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("zzz ice palace");
    // The words, never the person: the payload has no id, IP or timestamp.
    expect(text).not.toContain("anon");
    expect(text).not.toContain("client_ip");
    expect(text).not.toMatch(/\d{13}/); // no epoch-ms anywhere
  });

  it("refuses an unauthenticated caller", async () => {
    expect((await app.request("/api/stats/searches")).status).toBe(401);
  });

  /**
   * The whole point of this table is to prioritise lookup work by RIDER
   * evidence, and on 2026-09-03 its loudest zero-result term was
   * walk-fallback-check.mjs's own hardcoded destination — 8 of the 12
   * coordinate searches in the window. Because rows carry no anon id BY
   * DESIGN, `daily_actives`'s after-the-fact exclusion is impossible here, so
   * the decision has to happen before the write.
   */
  it("does not record a search from a verification harness", async () => {
    await app.request("/api/geocode?q=zzz robot plaza", {
      headers: { "x-anon-id": TEST_ANON_ID },
    });
    const res = await app.request("/api/stats/searches", {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    const body = (await res.json()) as { searches: number; missing: Array<{ q: string }> };
    expect(body.searches).toBe(0);
    expect(body.missing.map((m) => m.q)).not.toContain("zzz robot plaza");
  });

  it("still records a rider who sends no id at all", async () => {
    // Storage disabled means no header. That rider is not a harness, and a
    // zero-result search from them is exactly the signal we want.
    await app.request("/api/geocode?q=zzz storageless plaza");
    const res = await app.request("/api/stats/searches", {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    const body = (await res.json()) as { missing: Array<{ q: string }> };
    expect(body.missing.map((m) => m.q)).toContain("zzz storageless plaza");
  });
});
