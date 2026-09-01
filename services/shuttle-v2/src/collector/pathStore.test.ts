import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import type { DerivedPath } from "../network/derivePath.js";
import { traceFailures } from "../network/derivePath.js";
import type { LatLon } from "../network/geo.js";

import {
  PathStore,
  REPLACE_IMPROVEMENT,
  shouldReplacePath,
  STALE_MS,
  stopFitM,
  toStoredPath,
  upstreamNowBeats,
  type StoredPath,
} from "./pathStore.js";

// -- Fixtures -----------------------------------------------------------------

// A north-south run of points near campus, with stops on or beside it. Real
// coordinates, so the metre thresholds under test are the production ones.
const LAT0 = 41.31;
const LON0 = -72.93;

/** `n` points 0.0005 deg (~56 m) apart, optionally shifted east. */
const line = (n: number, offsetDeg = 0): [number, number][] =>
  Array.from({ length: n }, (_, i) => [LAT0 + i * 0.0005, LON0 + offsetDeg] as [number, number]);

const stopsOnLine = (n: number, offsetDeg = 0): LatLon[] =>
  Array.from({ length: n }, (_, i) => ({ lat: LAT0 + i * 0.002, lon: LON0 + offsetDeg }));

/** A closed loop and stops around it, for the cases where tracing is the point. */
const R_LAT = 500 / 111_320;
const R_LON = 500 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
const onCircle = (frac: number): [number, number] => [
  LAT0 + Math.cos(frac * 2 * Math.PI) * R_LAT,
  LON0 + Math.sin(frac * 2 * Math.PI) * R_LON,
];
const circle = (n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => onCircle(i / n));
const circleStops = (n: number): LatLon[] =>
  Array.from({ length: n }, (_, i) => {
    const [lat, lon] = onCircle(i / n);
    return { lat, lon };
  });

function derived(over: Partial<DerivedPath> = {}): DerivedPath {
  return {
    path: line(40),
    stopCount: 6,
    medianStopM: 20,
    p90StopM: 30,
    maxStopM: 60,
    lengthM: 5_000,
    busId: 7,
    ...over,
  };
}

function stored(over: Partial<StoredPath> = {}): StoredPath {
  return { ...toStoredPath(10, derived(), [], 3_000, 1_000_000), ...over };
}

// -- Tests --------------------------------------------------------------------

describe("stopFitM", () => {
  it("is small when stops sit on the line and large when they do not", () => {
    const stops = stopsOnLine(6);
    expect(stopFitM(line(40), stops).medianM).toBeLessThan(30);
    // 0.001 deg of longitude at this latitude is ~84 m.
    expect(stopFitM(line(40, 0.001), stops).medianM).toBeGreaterThan(50);
  });

  it("separates a good middle from a bad tail", () => {
    // Five stops on the line, one stranded 840 m east: exactly the shape that
    // makes a median look fine while a tenth of the route is undrawable.
    const stops = [...stopsOnLine(5), { lat: LAT0, lon: LON0 + 0.01 }];
    const fit = stopFitM(line(40), stops);
    expect(fit.medianM).toBeLessThan(60);
    expect(fit.p90M).toBeGreaterThan(500);
  });

  it("refuses to score a degenerate line rather than reporting it as perfect", () => {
    // A one-point path would otherwise measure "closest point" against a single
    // coordinate and could beat a real polyline by accident.
    expect(stopFitM([[LAT0, LON0]], stopsOnLine(6)).p90M).toBe(Infinity);
    expect(stopFitM(line(40), []).p90M).toBe(Infinity);
  });
});

describe("shouldReplacePath", () => {
  const stops = stopsOnLine(6);
  const now = 2_000_000;
  // A believable incumbent: a real derivation ~25 m off the stops. Stops
  // sitting exactly on the line would make every ratio below vacuous.
  const incumbentPath = line(40, 0.0003);
  const incumbentP90 = stopFitM(incumbentPath, stops).p90M;
  // These cases are about the distance tail, so the sequence is withheld to
  // keep the traced-leg check (which short-circuits) out of the way; the block
  // below covers it directly.
  const noSequence: LatLon[] = [];

  it("stores the first path for a route", () => {
    expect(shouldReplacePath(undefined, derived(), stops, noSequence, now)).toBe(true);
  });

  it("replaces the incumbent when the candidate's tail is materially closer", () => {
    const incumbent = stored({ path: line(40, 0.001) }); // ~84 m off
    expect(shouldReplacePath(incumbent, derived({ p90StopM: 20 }), stops, noSequence, now)).toBe(
      true,
    );
  });

  it("keeps the incumbent when the candidate is only marginally better", () => {
    const incumbent = stored({ path: incumbentPath });
    // Better, but inside the margin — this is the case that would otherwise
    // rewrite the map's geometry every night for a metre of GPS noise.
    const marginal = derived({ p90StopM: incumbentP90 * 0.95 });
    expect(marginal.p90StopM).toBeLessThan(incumbentP90);
    expect(shouldReplacePath(incumbent, marginal, stops, noSequence, now)).toBe(false);
    const clear = derived({ p90StopM: incumbentP90 * (REPLACE_IMPROVEMENT - 0.05) });
    expect(shouldReplacePath(incumbent, clear, stops, noSequence, now)).toBe(true);
  });

  it("never replaces a good path with a worse one", () => {
    const incumbent = stored({ path: incumbentPath });
    expect(shouldReplacePath(incumbent, derived({ p90StopM: 500 }), stops, noSequence, now)).toBe(
      false,
    );
  });

  it("accepts a sideways move once the incumbent is stale, but still not a downgrade", () => {
    const incumbent = stored({ path: incumbentPath, derivedAt: now - STALE_MS - 1 });
    const fit = stopFitM(incumbentPath, stops);
    const sideways = derived({ p90StopM: fit.p90M, medianStopM: fit.medianM });
    expect(shouldReplacePath(incumbent, sideways, stops, noSequence, now)).toBe(true);
    // Equal tail but a worse middle is still a downgrade.
    expect(
      shouldReplacePath(
        incumbent,
        derived({ p90StopM: fit.p90M, medianStopM: fit.medianM + 1 }),
        stops,
        noSequence,
        now,
      ),
    ).toBe(false);
  });

  it("does not churn between two paths that fit equally well", () => {
    const incumbent = stored({ path: incumbentPath });
    const fit = stopFitM(incumbentPath, stops);
    expect(
      shouldReplacePath(incumbent, derived({ p90StopM: fit.p90M }), stops, noSequence, now),
    ).toBe(false);
    // And when both are a perfect fit, where the ratio alone reads "better".
    const perfect = stored({ path: line(40) });
    expect(stopFitM(perfect.path, stops).p90M).toBe(0);
    expect(shouldReplacePath(perfect, derived({ p90StopM: 0 }), stops, noSequence, now)).toBe(
      false,
    );
  });

  it("re-measures the incumbent against today's stops, not the figures in its row", () => {
    // The row claims a 30 m tail, but the stops have since moved 84 m off the
    // stored line. Trusting the column would lock out every honest candidate.
    const incumbent = stored({ path: incumbentPath, p90StopM: 30, medianStopM: 20 });
    const movedStops = stopsOnLine(6, 0.001);
    expect(
      shouldReplacePath(incumbent, derived({ p90StopM: 35 }), movedStops, noSequence, now),
    ).toBe(true);
  });

  it("takes the fresh reading when upstream reshapes the route", () => {
    const incumbent = stored({ path: incumbentPath, stopCount: 6 });
    const moreStops = stopsOnLine(9);
    // Nominally worse, but measured over a different loop — not comparable.
    expect(
      shouldReplacePath(
        incumbent,
        derived({ p90StopM: 60, stopCount: 9 }),
        moreStops,
        noSequence,
        now,
      ),
    ).toBe(true);
  });

  describe("when the two paths draw the route differently", () => {
    const sequence = circleStops(8);
    const dense = circle(240);
    // The same loop drawn the other way round. Every leg then has to scan
    // almost the whole line to reach the next stop, which is precisely the
    // "draws most of the route" defect this feature exists to stop — and it is
    // invisible to stop-proximity, since the two paths share their points.
    const backwards = [...circle(240)].reverse();

    it("prefers the line that can draw more of the route's legs", () => {
      expect(traceFailures(backwards, sequence)).toBeGreaterThan(traceFailures(dense, sequence));
      expect(stopFitM(backwards, sequence)).toEqual(stopFitM(dense, sequence));
      const incumbent = stored({ path: backwards, stopCount: sequence.length });
      // Deliberately given a WORSE tail than the incumbent measures, to prove
      // the traced legs decide first: proximity to stops says nothing about
      // whether they fall along the line in order.
      const candidate = derived({
        path: dense,
        stopCount: sequence.length,
        p90StopM: 9_999,
        medianStopM: 9_999,
      });
      expect(shouldReplacePath(incumbent, candidate, sequence, sequence, now)).toBe(true);
    });

    it("refuses a candidate that draws worse, however close it sits to the stops", () => {
      const incumbent = stored({ path: dense, stopCount: sequence.length });
      const candidate = derived({
        path: backwards,
        stopCount: sequence.length,
        p90StopM: 0,
        medianStopM: 0,
      });
      expect(shouldReplacePath(incumbent, candidate, sequence, sequence, now)).toBe(false);
    });
  });
});

describe("upstreamNowBeats", () => {
  const sequence = circleStops(8);
  const dense = circle(240);
  const backwards = [...circle(240)].reverse();
  const now = 2_000_000;

  it("is false when there is no published path to fall back to", () => {
    const mine = stored({ path: dense, stopCount: sequence.length });
    expect(upstreamNowBeats(mine, undefined, sequence, sequence)).toBe(false);
    expect(upstreamNowBeats(mine, [[LAT0, LON0]], sequence, sequence)).toBe(false);
  });

  it("is false while ours draws the route at least as well", () => {
    const mine = stored({ path: dense, stopCount: sequence.length });
    expect(upstreamNowBeats(mine, backwards, sequence, sequence)).toBe(false);
    expect(upstreamNowBeats(mine, dense, sequence, sequence)).toBe(false);
  });

  it("is true once upstream publishes something better", () => {
    // Upstream fixing its own geometry is the outcome this whole feature is a
    // workaround for; nothing else here would ever hand the route back.
    const mine = stored({ path: backwards, stopCount: sequence.length });
    expect(upstreamNowBeats(mine, dense, sequence, sequence)).toBe(true);
  });

  it("falls back to the tail when both draw the route equally", () => {
    const mine = stored({ path: line(40, 0.002), stopCount: 6 }); // ~170 m off
    const stops = stopsOnLine(6);
    expect(upstreamNowBeats(mine, line(40), stops, [])).toBe(true);
    expect(upstreamNowBeats(mine, line(40, 0.0021), stops, [])).toBe(false);
    expect(now).toBe(2_000_000); // keep the fixture honest about its clock
  });
});

describe("PathStore", () => {
  let tmpDir: string;
  let bundle: DbBundle;
  let store: PathStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-pathstore-"));
    bundle = openDb(path.join(tmpDir, "test.db"));
    migrate(bundle.db, { migrationsFolder: "./drizzle" });
    store = new PathStore(bundle.sqlite);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips a derivation", () => {
    const row = stored({ routeId: 14 });
    store.put(row);
    const loaded = store.loadAll();
    expect(loaded.size).toBe(1);
    expect(loaded.get(14)).toEqual(row);
  });

  it("keeps one row per route, upserting in place", () => {
    store.put(stored({ routeId: 14, p90StopM: 90 }));
    store.put(stored({ routeId: 14, p90StopM: 24, derivedAt: 3_000_000 }));
    const loaded = store.loadAll();
    expect(loaded.size).toBe(1);
    expect(loaded.get(14)?.p90StopM).toBe(24);
    expect(loaded.get(14)?.derivedAt).toBe(3_000_000);
  });

  it("survives a reopen — the whole point, since the samples do not", () => {
    store.put(stored({ routeId: 14 }));
    bundle.sqlite.close();
    bundle = openDb(path.join(tmpDir, "test.db"));
    expect(new PathStore(bundle.sqlite).loadAll().get(14)?.pointCount).toBe(40);
  });

  it("drops a route, handing it back to the published path", () => {
    store.put(stored({ routeId: 14 }));
    store.put(stored({ routeId: 9 }));
    store.drop(14);
    expect([...store.loadAll().keys()]).toEqual([9]);
    // Dropping a route that has none is not an error.
    expect(() => store.drop(14)).not.toThrow();
  });

  it("skips an unreadable row instead of losing every other route", () => {
    store.put(stored({ routeId: 14 }));
    bundle.sqlite
      .prepare(
        "INSERT INTO derived_paths (route_id, path_json, point_count, stop_count, " +
          "median_stop_m, p90_stop_m, max_stop_m, length_m, trace_failures, bus_id, " +
          "sample_count, derived_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(99, "{not json", 3, 3, 1, 1, 1, 1, 0, 1, 1, 1);
    const loaded = store.loadAll();
    expect([...loaded.keys()]).toEqual([14]);
  });
});

describe("toStoredPath", () => {
  it("records how many legs the line failed to draw", () => {
    const sequence = circleStops(8);
    const good = toStoredPath(14, derived({ path: circle(240) }), sequence, 3_000, 1_000_000);
    const bad = toStoredPath(
      14,
      derived({ path: [...circle(240)].reverse() }),
      sequence,
      3_000,
      1_000_000,
    );
    expect(good.traceFailures).toBeLessThan(bad.traceFailures);
    expect(good.pointCount).toBe(240);
  });
});
