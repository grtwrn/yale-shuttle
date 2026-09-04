import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Collector } from "../collector/collector.js";
import type { RawBus, UpstreamClient } from "../collector/upstream.js";
import { openDb, type DbBundle } from "../db/client.js";
import type { Route, Stop } from "../schema/api.js";

import { buildApp, parseShownBatch } from "./app.js";
import { resetRateLimits } from "./reports.js";
import {
  createPredictionRecorder,
  DEFAULT_PREDICTION_RETAIN_DAYS,
  MAX_READING_AGE_MS,
  MIN_COMPARE_PAIRS,
  PREDICTION_BUCKET_MS,
  RIDER_SURFACES_SQL,
  UPSTREAM_SURFACE,
  type ShownReading,
} from "./predictions.js";

const stops: Stop[] = [
  { id: 1, name: "A", lat: 41.31, lon: -72.93 },
  { id: 2, name: "B", lat: 41.31, lon: -72.92 },
  { id: 3, name: "C", lat: 41.31, lon: -72.91 },
];

const routes: Route[] = [
  { id: 10, name: "Loop", shortName: "L", color: "#000", stops: [1, 2, 3] },
  { id: 11, name: "Other", shortName: "O", color: "#111", stops: [3] },
];

const NOW = 1_700_000_000_000;
const TEST_ADMIN_TOKEN = "test-admin-token";

function fakeUpstream(buses: RawBus[]): UpstreamClient {
  return {
    buses: async () => buses,
    stops: async () => stops.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })),
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

let tmpDir: string;
let bundle: DbBundle;
let collector: Collector;

/** One live bus, #40, on route 10 next to stop 1. */
const LIVE_BUS: RawBus = { id: 900, name: "#40", lat: 41.31, lon: -72.93, heading: 0, route: 10 };

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-pred-"));
  bundle = openDb(path.join(tmpDir, "test.db"));
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
  collector = await Collector.create(bundle, {
    upstream: fakeUpstream([LIVE_BUS]),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await (collector as unknown as { refreshStaticIfNeeded: (f: boolean) => Promise<void> })
    .refreshStaticIfNeeded(true);
  await (collector as unknown as { runPoll: () => Promise<void> }).runPoll();
  resetRateLimits();
});

afterEach(() => {
  collector.stop();
  bundle.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = () => ({
  buses: collector.getLiveBuses(),
  network: collector.ref.get(),
  clientBuild: "abc123",
  now: NOW,
});

const reading = (over: Partial<ShownReading> = {}): ShownReading => ({
  busName: "40",
  stopId: 2,
  etaSec: 300,
  lowSec: 240,
  highSec: 360,
  stopsAhead: 1,
  ageMs: 0,
  surface: "trip",
  ...over,
});

const rows = () =>
  bundle.sqlite.prepare("SELECT * FROM predictions_log ORDER BY id").all() as Array<
    Record<string, unknown>
  >;

describe("what gets stored", () => {
  it("writes nothing until the flush — a reading must never cost a write per request", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    for (let i = 0; i < 50; i++) rec.record([reading()], ctx());
    expect(rows()).toHaveLength(0);
    rec.flush();
    expect(rows()).toHaveLength(1);
  });

  it("stores no viewer — the column set IS the privacy promise", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    rec.record([reading()], ctx());
    rec.flush();
    const cols = Object.keys(rows()[0]!);
    // A future column has to argue with this test. Nothing here can identify a
    // browser, a person or a place a rider was standing.
    //
    // `surface` argued with it on 2026-09-04 and won. It names the SCREEN
    // ("trip" / "ride" / "card"), which is a property of the app, not of a
    // reader: it is deduplicated across every browser exactly as the rest of
    // the row is, so it still says "at least one client somewhere had this on
    // that screen". It earns its place because the route cards stopped running
    // their own estimator that day, and without it their much larger, mostly
    // far-horizon population would pool with the trip card's and move the
    // median for reasons that have nothing to do with the estimator
    // (docs/card-vs-trip.md).
    expect(cols.sort()).toEqual(
      [
        "bus_id",
        "bus_name",
        "client_build",
        "from_stop_id",
        "id",
        "predicted_at",
        "predicted_high_sec",
        "predicted_low_sec",
        "predicted_sec",
        "route_id",
        "stops_ahead",
        "surface",
        "to_stop_id",
      ].sort(),
    );
    for (const forbidden of ["anon_id", "ip", "user_agent", "lat", "lon", "session"]) {
      expect(cols).not.toContain(forbidden);
    }
  });

  it("resolves the vehicle and route from the LIVE fleet, never from the client", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    rec.record([reading()], ctx());
    rec.flush();
    expect(rows()[0]).toMatchObject({
      bus_id: 900,
      bus_name: "#40",
      route_id: 10,
      to_stop_id: 2,
      predicted_sec: 300,
      client_build: "abc123",
    });
  });

  it("re-floors a bucket age back onto the same bucket, latency and all", () => {
    // The client sends the age of the BUCKET at send time; the server subtracts
    // it from its own clock and floors. That round-trip has to land on the
    // instant the client bucketed to, or a logged sequence and a replayed one
    // stop lining up — which is the whole reason the bucket is 15 s.
    const bucket = Math.floor((NOW - 40_000) / PREDICTION_BUCKET_MS) * PREDICTION_BUCKET_MS;
    for (const latencyMs of [0, 200, 2_000, 14_999]) {
      const sentAt = NOW - latencyMs;
      const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
      rec.record([reading({ ageMs: sentAt - bucket })], ctx());
      rec.flush();
      const written = rows().at(-1)!.predicted_at as number;
      expect(written).toBe(bucket);
      bundle.sqlite.prepare("DELETE FROM predictions_log").run();
    }
  });

  it("quantises the instant, and takes it from the SERVER clock via the age", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    // 7 s ago; the bucket floor is what lands, so the row's instant is coarse
    // and cannot be a client's (possibly wrong, possibly hostile) clock.
    rec.record([reading({ ageMs: 7_000 })], ctx());
    rec.flush();
    const at = rows()[0]!.predicted_at as number;
    expect(at % PREDICTION_BUCKET_MS).toBe(0);
    expect(at).toBe(Math.floor((NOW - 7_000) / PREDICTION_BUCKET_MS) * PREDICTION_BUCKET_MS);
  });
});

describe("deduplication — one row per (bus, stop, bucket, screen), whoever reports it", () => {
  it("keeps the trip card and a route card apart", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    // One vehicle, one stop, one bucket, two screens. Since 2026-09-04 both run
    // `computeUpcomingArrivals`, so the NUMBER is the same; what differs is the
    // population each screen samples, and pooling them would move a median for
    // a reason that has nothing to do with the estimator.
    rec.record([reading({ surface: "trip" }), reading({ surface: "card" })], ctx());
    rec.flush();
    expect(rows()).toHaveLength(2);
    expect(rows().map((r) => r.surface).sort()).toEqual(["card", "trip"]);
  });

  it("still collapses two browsers on the SAME screen", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    rec.record([reading({ surface: "card", etaSec: 300 })], ctx());
    rec.record([reading({ surface: "card", etaSec: 311 })], ctx());
    rec.flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.predicted_sec).toBe(300);
  });

  it("drops a reading claiming a screen that does not exist", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    // The surface is part of the dedup key, so an unrecognised value would
    // quietly open a parallel population rather than fail loudly.
    expect(rec.record([reading({ surface: "everywhere" as never })], ctx())).toBe(0);
    rec.flush();
    expect(rows()).toHaveLength(0);
  });

  it("collapses many browsers watching one stop into one row", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    // Thirty riders, same bucket, slightly different numbers.
    for (let i = 0; i < 30; i++) rec.record([reading({ etaSec: 300 + i })], ctx());
    rec.flush();
    expect(rows()).toHaveLength(1);
    // First writer wins, in memory and in SQLite alike.
    expect(rows()[0]!.predicted_sec).toBe(300);
  });

  it("a later poster cannot overwrite a bucket another client established", () => {
    const a = createPredictionRecorder(bundle, { sampleRate: 1 });
    a.record([reading({ etaSec: 300 })], ctx());
    a.flush();
    const b = createPredictionRecorder(bundle, { sampleRate: 1 });
    b.record([reading({ etaSec: 9 })], ctx());
    b.flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.predicted_sec).toBe(300);
  });

  it("keeps separate buckets, so a sequence survives", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    rec.record([reading({ etaSec: 300, ageMs: 30_000 })], ctx());
    rec.record([reading({ etaSec: 280, ageMs: 15_000 })], ctx());
    rec.record([reading({ etaSec: 260, ageMs: 0 })], ctx());
    rec.flush();
    expect(rows().map((r) => r.predicted_sec)).toEqual([300, 280, 260]);
  });
});

describe("nothing is trusted", () => {
  const dropped = (r: Partial<ShownReading>) => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    const n = rec.record([reading(r)], ctx());
    rec.flush();
    return n === 0 && rows().length === 0;
  };

  it("drops a bus that is not live", () => {
    expect(dropped({ busName: "99" })).toBe(true);
  });

  it("drops a stop the bus's route does not serve", () => {
    // Stop 3 IS on route 11, but this bus is on route 10... which also has 3.
    // Use a stop id that exists nowhere.
    expect(dropped({ stopId: 4242 })).toBe(true);
  });

  it("drops an ETA outside the range the client can produce", () => {
    expect(dropped({ etaSec: -1 })).toBe(true);
    expect(dropped({ etaSec: 99_999 })).toBe(true);
    expect(dropped({ etaSec: Number.NaN })).toBe(true);
  });

  it("drops a reading that claims to be from the future or the distant past", () => {
    expect(dropped({ ageMs: -1 })).toBe(true);
    expect(dropped({ ageMs: MAX_READING_AGE_MS + 1 })).toBe(true);
  });

  it("drops an implausible stops-ahead", () => {
    expect(dropped({ stopsAhead: 0 })).toBe(true);
    expect(dropped({ stopsAhead: 1.5 })).toBe(true);
    expect(dropped({ stopsAhead: 5000 })).toBe(true);
  });

  it("stores no build rather than an arbitrary string", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    rec.record([reading()], { ...ctx(), clientBuild: "../../etc/passwd" });
    rec.flush();
    expect(rows()[0]!.client_build).toBeNull();
  });
});

describe("it must never break the endpoint", () => {
  it("swallows a broken database rather than throwing at a rider", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    rec.record([reading()], ctx());
    bundle.sqlite.prepare("DROP TABLE predictions_log").run();
    expect(() => rec.flush()).not.toThrow();
    expect(() => rec.record([reading()], ctx())).not.toThrow();
    expect(() => rec.paired()).not.toThrow();
  });

  it("records nothing at all when the sample rate is zero", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 0 });
    expect(rec.record([reading()], ctx())).toBe(0);
    rec.flush();
    expect(rows()).toHaveLength(0);
  });
});

describe("the pairing — the thing nobody could do before", () => {
  it("answers 'we said 5 min at T; it arrived at T+400s'", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    rec.record([reading({ etaSec: 300 })], ctx());
    rec.flush();
    const at = rows()[0]!.predicted_at as number;
    bundle.sqlite
      .prepare(
        `INSERT INTO arrivals (bus_id, bus_name, route_id, stop_id, arrived_at, dow, hour)
         VALUES (?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(901, "#40", 10, 2, at + 400_000);

    const { summary, rows: paired } = rec.paired({ now: NOW, hours: 24 });
    expect(summary.n).toBe(1);
    expect(summary.paired).toBe(1);
    // Told 300 s, waited 400 s: 100 s late.
    expect(paired[0]!.errorSec).toBeCloseTo(100, 5);
    expect(paired[0]!.arrivedAt).toBe(at + 400_000);
    expect(summary.builds).toEqual([{ build: "abc123", n: 1 }]);
  });

  it("pairs on bus_NAME, because bus_id is reissued per service block", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    rec.record([reading()], ctx());
    rec.flush();
    const at = rows()[0]!.predicted_at as number;
    // Same vehicle, brand new id — exactly what TransLoc does every few hours.
    bundle.sqlite
      .prepare(
        `INSERT INTO arrivals (bus_id, bus_name, route_id, stop_id, arrived_at, dow, hour)
         VALUES (?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(65_540, "#40", 10, 2, at + 300_000);
    expect(rec.paired({ now: NOW }).summary.paired).toBe(1);
  });

  it("reports an unpaired prediction rather than dropping it", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    rec.record([reading()], ctx());
    rec.flush();
    const { summary, rows: paired } = rec.paired({ now: NOW });
    expect(summary.n).toBe(1);
    expect(summary.paired).toBe(0);
    expect(paired[0]!.arrivedAt).toBeNull();
    expect(paired[0]!.errorSec).toBeNull();
  });
});

describe("retention", () => {
  it("the collector's sweep default agrees with the documented one", () => {
    // Nothing in src/collector imports from src/server, so the number lives in
    // both files. This is the walk.test.ts idiom: parse the other side rather
    // than let the two drift.
    const src = fs.readFileSync("src/collector/collector.ts", "utf8");
    const m = /const PREDICTION_RETAIN_DAYS_DEFAULT = (\d+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(DEFAULT_PREDICTION_RETAIN_DAYS);
  });

  it("the sweep knows which column dates a prediction", () => {
    const src = fs.readFileSync("src/collector/collector.ts", "utf8");
    expect(src).toContain('case "predictions_log":');
    expect(src).toContain('return "predicted_at";');
  });

  it("the operator's arm ages out far sooner than the riders'", () => {
    // Not a policy difference, a capacity one: the upstream poller writes
    // ~40x the rows (one per vehicle per sampled stop every 30 s, awake or
    // not) and 30 days of it would fill the volume. `arrivals` still outlives
    // the shorter window many times over, so every row stays pairable.
    const src = fs.readFileSync("src/collector/collector.ts", "utf8");
    const m = /const UPSTREAM_PREDICTION_RETAIN_DAYS_DEFAULT = (\d+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(DEFAULT_PREDICTION_RETAIN_DAYS);
    // And the sweep must actually narrow to that arm, or it would take the
    // rider rows with it.
    expect(src).toContain("WHERE surface = 'upstream' ");
  });
});

// ---------------------------------------------------------------------------
// The HTTP surface.

describe("POST /api/shown", () => {
  const app = () =>
    buildApp({
      collector,
      bundle,
      now: () => NOW,
      adminToken: TEST_ADMIN_TOKEN,
      statsSinceDay: "2000-01-01",
      geocoder: { lookup: async () => [] },
      predictionSampleRate: 1,
    });

  const post = (body: unknown) =>
    app().request("/api/shown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("accepts the compact batch and echoes the live sample rate", async () => {
    const res = await post({ b: "abc123", p: [["40", 2, 300, 240, 360, 1, 0]] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sample: 1 });
  });

  it("answers sample:0 and reads nothing when the feature is off", async () => {
    const off = buildApp({
      collector,
      bundle,
      now: () => NOW,
      adminToken: TEST_ADMIN_TOKEN,
      statsSinceDay: "2000-01-01",
      geocoder: { lookup: async () => [] },
      predictionSampleRate: 0,
    });
    const res = await off.request("/api/shown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ b: "abc123", p: [["40", 2, 300, 240, 360, 1, 0]] }),
    });
    expect(await res.json()).toEqual({ sample: 0 });
  });

  it("a seven-element reading is a pre-2026-09-04 bundle, and it is a trip-card one", async () => {
    // Old bundles keep posting for as long as browsers keep them loaded, and
    // every reading they ever sent came from the trip card. Requiring the
    // eighth element would have thrown those away for a field whose value is
    // already known.
    const res = await post({ b: "abc123", p: [["40", 2, 300, 240, 360, 1, 0]] });
    expect(res.status).toBe(200);
    expect(parseShownBatch({ p: [["40", 2, 300, 240, 360, 1, 0]] })[0]!.surface).toBe("trip");
  });

  it("takes the screen when the bundle names one", () => {
    expect(parseShownBatch({ p: [["40", 2, 300, 240, 360, 1, 0, "card"]] })[0]!.surface)
      .toBe("card");
  });

  it("a browser may not claim the operator's arm", () => {
    // `upstream` is a real value of the surface COLUMN — it is how the
    // official app's own ETAs are stored — but it is not on the WIRE
    // allowlist. If a client could post it, anyone could write rows into the
    // arm we score ourselves against and the comparison would measure
    // nothing. Only the in-process poller writes it.
    expect(parseShownBatch({ p: [["40", 2, 300, 240, 360, 1, 0, UPSTREAM_SURFACE]] }))
      .toEqual([]);
  });

  it("drops a reading naming a screen that does not exist", () => {
    // Not "falls back to trip": a client asserting an unknown population would
    // otherwise land in the trip card's, which is the one every accuracy number
    // published so far is about.
    expect(parseShownBatch({ p: [["40", 2, 300, 240, 360, 1, 0, "billboard"]] })).toEqual([]);
    expect(parseShownBatch({ p: [["40", 2, 300, 240, 360, 1, 0, 7]] })).toEqual([]);
  });

  it("shrugs off a malformed body rather than erroring at a rider", async () => {
    for (const body of [{}, { p: "nope" }, { p: [[]] }, { p: [["40"]] }, null]) {
      const res = await post(body);
      expect(res.status).toBe(200);
    }
  });

  it("is rate limited per IP — high enough that a NAT'd building is not the cap", async () => {
    const a = app();
    let limited = false;
    for (let i = 0; i < 700; i++) {
      const res = await a.request("/api/shown", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
        body: JSON.stringify({ b: "abc123", p: [["40", 2, 300, 240, 360, 1, 0]] }),
      });
      if (res.status === 429) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });
});

describe("GET /api/predictions", () => {
  const app = () =>
    buildApp({
      collector,
      bundle,
      now: () => NOW,
      adminToken: TEST_ADMIN_TOKEN,
      statsSinceDay: "2000-01-01",
      geocoder: { lookup: async () => [] },
      predictionSampleRate: 1,
    });

  it("requires the admin HEADER", async () => {
    expect((await app().request("/api/predictions")).status).toBe(401);
    const ok = await app().request("/api/predictions", {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    expect(ok.status).toBe(200);
  });

  it("is NOT unlocked by the stats-session cookie", async () => {
    // The cookie is scoped Path=/api/stats and must never widen. This route
    // deliberately sits outside that path AND outside requireStatsAuth.
    const session = await app().request("/api/stats/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TEST_ADMIN_TOKEN }),
    });
    const cookie = session.headers.get("set-cookie") ?? "";
    const value = /stats_session=([^;]+)/.exec(cookie)?.[1] ?? "";
    expect(value).not.toBe("");
    const res = await app().request("/api/predictions", {
      headers: { cookie: `stats_session=${value}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns the reading beside its outcome", async () => {
    const a = app();
    await a.request("/api/shown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ b: "abc123", p: [["40", 2, 300, 240, 360, 1, 0]] }),
    });
    const bucket = Math.floor(NOW / PREDICTION_BUCKET_MS) * PREDICTION_BUCKET_MS;
    bundle.sqlite
      .prepare(
        `INSERT INTO arrivals (bus_id, bus_name, route_id, stop_id, arrived_at, dow, hour)
         VALUES (?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(900, "#40", 10, 2, bucket + 360_000);

    const res = await a.request("/api/predictions?hours=24", {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    });
    const body = (await res.json()) as {
      summary: { n: number; paired: number; builds: Array<{ build: string; n: number }> };
      rows: Array<{ errorSec: number; stopId: number; clientBuild: string }>;
    };
    expect(body.summary.n).toBe(1);
    expect(body.summary.paired).toBe(1);
    expect(body.rows[0]!.stopId).toBe(2);
    expect(body.rows[0]!.clientBuild).toBe("abc123");
    expect(body.rows[0]!.errorSec).toBeCloseTo(60, 5);
  });
});

// ---------------------------------------------------------------------------

describe("the operator's arm must never be counted as ours", () => {
  /** One row in each arm, for the same bus at the same stop, wildly apart. */
  function seedBothArms(): void {
    const ins = bundle.sqlite.prepare(
      `INSERT OR IGNORE INTO predictions_log
         (bus_id, bus_name, route_id, from_stop_id, to_stop_id, stops_ahead,
          predicted_sec, predicted_low_sec, predicted_high_sec, predicted_at,
          client_build, surface)
       VALUES (900, '#40', 10, 1, 2, 1, ?, ?, ?, ?, NULL, ?)`,
    );
    const at = Math.floor((NOW - 300_000) / PREDICTION_BUCKET_MS) * PREDICTION_BUCKET_MS;
    ins.run(300, 300, 300, at, "trip");
    ins.run(3000, 3000, 3000, at, UPSTREAM_SURFACE);
    bundle.sqlite
      .prepare(
        `INSERT INTO arrivals (bus_id, bus_name, route_id, stop_id, arrived_at, dow, hour)
         VALUES (900, '#40', 10, 2, ?, 0, 0)`,
      )
      .run(at + 300_000);
  }

  it("the pairing reader answers about our app alone", () => {
    // It shipped pooled for one hour on 2026-09-04: /api/predictions reported
    // n=3056 of which 1586 were the operator's rows. That is exactly the
    // inference error the surface column exists to prevent.
    seedBothArms();
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    const ours = rec.paired({ now: NOW });
    expect(ours.summary.n).toBe(1);
    expect(ours.rows[0]!.predictedSec).toBe(300);
  });

  it("...and hands over the operator's only when asked by name", () => {
    seedBothArms();
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    const theirs = rec.paired({ now: NOW, surface: UPSTREAM_SURFACE });
    expect(theirs.summary.n).toBe(1);
    expect(theirs.rows[0]!.predictedSec).toBe(3000);
  });

  it("every predictions_log reader carries the surface clause", () => {
    // Three readers scan this table and each one answers "how accurate are
    // WE". A fourth must not be written without the clause, so pin all three
    // by their source rather than only by behaviour.
    for (const file of ["src/server/accuracy.ts", "src/server/v1compat.ts"]) {
      const src = fs.readFileSync(file, "utf8");
      expect(src, `${file} must filter by surface`).toContain("RIDER_SURFACES_SQL");
    }
    // And the fragment must actually name the arm it excludes.
    expect(RIDER_SURFACES_SQL).toContain(UPSTREAM_SURFACE);
  });
});

// ---------------------------------------------------------------------------

describe("officialComparison — ours against the operator's own app", () => {
  /**
   * `n` predictions in one arm, each `driftSec` off the truth, one per vehicle
   * so nothing collapses on the dedup key and each pairs with its own arrival.
   */
  function seed(surface: string, n: number, driftSec: number, at = NOW - 600_000): void {
    const insertPred = bundle.sqlite.prepare(
      `INSERT OR IGNORE INTO predictions_log
         (bus_id, bus_name, route_id, from_stop_id, to_stop_id, stops_ahead,
          predicted_sec, predicted_low_sec, predicted_high_sec, predicted_at,
          client_build, surface)
       VALUES (?, ?, 10, 1, 2, 1, ?, ?, ?, ?, NULL, ?)`,
    );
    const insertArr = bundle.sqlite.prepare(
      `INSERT INTO arrivals (bus_id, bus_name, route_id, stop_id, arrived_at, dow, hour)
       VALUES (?, ?, 10, 2, ?, 0, 0)`,
    );
    const truthSec = 300;
    for (let i = 0; i < n; i++) {
      // Distinct bus per arm, so the arms never share a dedup key and each
      // arm's rows are scored against arrivals of their own.
      const busId = (surface === UPSTREAM_SURFACE ? 10_000 : surface === "card" ? 30_000 : 20_000) + i;
      const busName = `#${busId}`;
      insertPred.run(
        busId, busName,
        truthSec + driftSec, truthSec + driftSec, truthSec + driftSec,
        at, surface,
      );
      insertArr.run(busId, busName, at + truthSec * 1000);
    }
  }

  it("says nothing at all until both arms have enough paired rows", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    seed("trip", MIN_COMPARE_PAIRS + 5, 0);
    seed(UPSTREAM_SURFACE, MIN_COMPARE_PAIRS - 10, 0);
    // A thin arm produces a median that flips sign by the hour. Refusing is
    // the honest failure; printing "n = 6" and hoping is not.
    expect(rec.officialComparison(24, NOW)).toBeNull();
  });

  it("scores both arms against the same arrivals", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    seed("trip", MIN_COMPARE_PAIRS + 5, 30); // 30 s off
    seed(UPSTREAM_SURFACE, MIN_COMPARE_PAIRS + 5, 150); // 150 s off
    const cmp = rec.officialComparison(24, NOW);
    expect(cmp).not.toBeNull();
    expect(cmp!.hours).toBe(24);
    expect(cmp!.ours.medianAbsErrorSec).toBeCloseTo(30, 5);
    expect(cmp!.official.medianAbsErrorSec).toBeCloseTo(150, 5);
    // 30 s is inside two minutes; 150 s is not.
    expect(cmp!.ours.within120Pct).toBe(100);
    expect(cmp!.official.within120Pct).toBe(0);
  });

  it("pools every rider-reported screen into `ours`, and only `upstream` into theirs", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    seed("trip", MIN_COMPARE_PAIRS, 10);
    seed("card", MIN_COMPARE_PAIRS, 10);
    seed(UPSTREAM_SURFACE, MIN_COMPARE_PAIRS + 1, 10);
    const cmp = rec.officialComparison(24, NOW);
    expect(cmp!.ours.paired).toBe(2 * MIN_COMPARE_PAIRS);
    expect(cmp!.official.paired).toBe(MIN_COMPARE_PAIRS + 1);
  });

  it("is null on an empty database rather than a row of zeroes", () => {
    const rec = createPredictionRecorder(bundle, { sampleRate: 1 });
    expect(rec.officialComparison(24, NOW)).toBeNull();
  });
});
