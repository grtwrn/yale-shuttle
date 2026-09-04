import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import type {
  DwellStats,
  SegmentStats,
} from "../network/TransitNetwork.js";
import { TransitNetwork } from "../network/TransitNetwork.js";

import {
  attachStandDrive,
  calibrate,
  computeDwellStats,
  computeSegmentStats,
  hourWindow,
  MIN_DRIVE_SAMPLES,
  MIN_STAND_SAMPLES,
  parseValueList,
  STAND_QUANTILE_LEVELS,
  type ValueGroup,
} from "./calibrator.js";
import { median, percentile, shrink } from "./shrinkage.js";
import {
  MIN_DRIVE_SAMPLES as CLIENT_MIN_DRIVE,
  MIN_STAND_SAMPLES as CLIENT_MIN_STAND,
} from "../../web/src/hopPricing.js";

describe("hourWindow", () => {
  it("returns a centered window inside the day", () => {
    expect(hourWindow(12, 1)).toEqual([11, 12, 13]);
    expect(hourWindow(12, 2)).toEqual([10, 11, 12, 13, 14]);
  });

  it("wraps midnight without losing samples — the v1 bug", () => {
    // The v1 code used `hour BETWEEN h-1 AND h+1` which excluded the wraparound,
    // so segments near midnight never collected enough data to advance past
    // the route-wide fallback. This is the regression test.
    expect(hourWindow(0, 1).sort((a, b) => a - b)).toEqual([0, 1, 23]);
    expect(hourWindow(23, 1).sort((a, b) => a - b)).toEqual([0, 22, 23]);
    expect(hourWindow(23, 2).sort((a, b) => a - b)).toEqual([0, 1, 21, 22, 23]);
  });
});

// The samples now arrive from SQLite as one `group_concat` blob per group
// instead of one row per observation, so the decoder is load-bearing: every
// ETA in the app is downstream of it.
describe("parseValueList", () => {
  it("treats a missing or empty payload as no samples", () => {
    // group_concat returns NULL when every input row was NULL — i.e. no sample
    // fell in the current (dow, hour) window.
    expect(parseValueList(null)).toEqual([]);
    expect(parseValueList(undefined)).toEqual([]);
    expect(parseValueList("")).toEqual([]);
  });

  it("decodes the compact integer-milliseconds form", () => {
    expect(parseValueList("30115")).toEqual([30.115]);
    expect(parseValueList("30115,0,900000")).toEqual([30.115, 0, 900]);
  });

  it("decodes the verbatim form for doubles that aren't a whole millisecond", () => {
    // 0.1 + 0.2 is the canonical example: SQLite's default REAL→TEXT renders it
    // "0.3", which is a *different* double. The x-prefixed 17-digit form is
    // what keeps the median honest.
    expect(parseValueList("x0.30000000000000004")).toEqual([0.1 + 0.2]);
    expect(parseValueList("x0.33333333333333331")).toEqual([1 / 3]);
  });

  it("decodes a mixed payload", () => {
    expect(parseValueList("15165,x0.30000000000000004,60003")).toEqual([
      15.165,
      0.1 + 0.2,
      60.003,
    ]);
  });
});

describe("computeSegmentStats", () => {
  const group = (
    key: string,
    all: number[],
    windowed: number[] = [],
  ): ValueGroup => ({ key, n: all.length, all, windowed });

  it("returns an empty map for empty input", () => {
    expect(computeSegmentStats([]).size).toBe(0);
  });

  it("shrinks the windowed samples toward the segment-wide median prior", () => {
    // prior = median([10, 20, 30, 1000]) = 25 (even count → mean of the middle
    // pair). Posterior = (2 * 15 + 8 * 25) / (2 + 8) = 23.
    const out = computeSegmentStats([group("s", [10, 20, 30, 1000], [10, 20])]);
    const stats = out.get("s")!;
    expect(stats.mean).toBe(23);
    expect(stats.n).toBe(2);
    expect(stats.stddev).toBeCloseTo(Math.sqrt(50), 12);
    // 2 < SHRINKAGE_K, so the estimate is still mostly the prior.
    expect(stats.source).toBe("route-segment");
  });

  it("uses an odd-count median for the prior", () => {
    const out = computeSegmentStats([group("s", [7, 9, 11])]);
    // No windowed samples at all → the estimate *is* the prior.
    expect(out.get("s")!.mean).toBe(9);
    expect(out.get("s")!.n).toBe(0);
    expect(out.get("s")!.stddev).toBe(5); // minStddev floor
  });

  it("handles a group with a single sample", () => {
    const out = computeSegmentStats([group("s", [60], [60])]);
    const stats = out.get("s")!;
    // (1 * 60 + 8 * 60) / 9 = 60, and a one-sample variance is 0 → floored.
    expect(stats.mean).toBe(60);
    expect(stats.n).toBe(1);
    expect(stats.stddev).toBe(5);
  });

  it("calls the estimate specific once the window carries k samples", () => {
    const windowed = [50, 51, 52, 53, 54, 55, 56, 57];
    const out = computeSegmentStats([group("s", [...windowed, 900], windowed)]);
    expect(out.get("s")!.source).toBe("specific");
    expect(out.get("s")!.n).toBe(8);
  });
});

describe("computeDwellStats", () => {
  const group = (
    key: string,
    all: number[],
    windowed: number[] = [],
  ): ValueGroup => ({ key, n: all.length, all, windowed });

  it("returns an empty map for empty input", () => {
    expect(computeDwellStats([]).size).toBe(0);
  });

  it("falls back to the stop-wide median and p90 spread with no windowed samples", () => {
    const out = computeDwellStats([group("d", [1, 2, 3])]);
    const stats = out.get("d")!;
    expect(stats.mean).toBe(2);
    expect(stats.n).toBe(0);
    // p90([1,2,3]) = 2.8 → spread 0.8, floored to 5.
    expect(stats.stddev).toBe(5);
  });

  it("uses an even-count median and an interpolated p90 for the window", () => {
    const out = computeDwellStats([group("d", [4, 6, 8, 10], [4, 6, 8, 10])]);
    const stats = out.get("d")!;
    expect(stats.mean).toBe(7); // (6 + 8) / 2
    expect(stats.n).toBe(4);
    expect(stats.stddev).toBe(5); // p90 = 9.4 → spread 2.4, floored
  });

  it("uses an odd-count median and keeps a wide spread when the tail is heavy", () => {
    const out = computeDwellStats([group("d", [10, 100, 20], [10, 100, 20])]);
    const stats = out.get("d")!;
    expect(stats.mean).toBe(20);
    // p90 of [10, 20, 100] interpolates between ranks 1 and 2: 20 + 0.8 * 80.
    expect(stats.stddev).toBeCloseTo(64, 9);
    expect(stats.n).toBe(3);
  });

  it("handles a group with a single sample", () => {
    const out = computeDwellStats([group("d", [42.5], [42.5])]);
    const stats = out.get("d")!;
    expect(stats.mean).toBe(42.5);
    expect(stats.stddev).toBe(5); // median === p90 → zero spread → floored
    expect(stats.n).toBe(1);
  });
});

describe("attachStandDrive", () => {
  it("pins the adequacy thresholds to hopPricing.ts", () => {
    expect(MIN_STAND_SAMPLES).toBe(CLIENT_MIN_STAND);
    expect(MIN_DRIVE_SAMPLES).toBe(CLIENT_MIN_DRIVE);
    expect(STAND_QUANTILE_LEVELS).toHaveLength(11);
    expect(STAND_QUANTILE_LEVELS[5]).toBe(0.5);
  });

  it("withholds a thin cell and attaches an adequate one", () => {
    const dwells = new Map<string, DwellStats>();
    const segments = new Map<string, SegmentStats>([
      ["1:11:146", { mean: 400, stddev: 50, n: 30, source: "specific" }],
      ["1:12:13", { mean: 80, stddev: 10, n: 8, source: "route-segment" }],
    ]);
    const thinStand: ValueGroup = {
      key: "1:99",
      n: 5,
      all: [10, 20, 30, 40, 50],
      windowed: [],
    };
    const fatStand: ValueGroup = {
      key: "1:11",
      n: 20,
      all: Array.from({ length: 20 }, (_, i) => 100 + i * 20),
      windowed: [],
    };
    const thinDrive: ValueGroup = {
      key: "1:12:13",
      n: 9,
      all: Array.from({ length: 9 }, () => 25),
      windowed: [],
    };
    const fatDrive: ValueGroup = {
      key: "1:11:146",
      n: 10,
      all: Array.from({ length: 10 }, () => 4),
      windowed: [],
    };
    attachStandDrive(dwells, segments, [thinStand, fatStand], [thinDrive, fatDrive]);

    expect(dwells.has("1:99")).toBe(false);
    const stand = dwells.get("1:11")!;
    expect(stand.qn).toBe(20);
    expect(stand.q).toHaveLength(11);
    expect(stand.q![0]).toBe(percentile(fatStand.all, 0.05));
    expect(stand.q![5]).toBe(percentile(fatStand.all, 0.5));
    expect(stand.mean).toBe(15); // no arrivals row — fallback, q still served

    expect(segments.get("1:12:13")!.drive).toBeUndefined();
    expect(segments.get("1:11:146")!.drive).toBe(4);
    expect(segments.get("1:11:146")!.driveN).toBe(10);
  });

  it("does not invent a segment that calibration omitted", () => {
    const dwells = new Map<string, DwellStats>();
    const segments = new Map<string, SegmentStats>();
    attachStandDrive(
      dwells,
      segments,
      [],
      [{ key: "1:1:2", n: 20, all: Array.from({ length: 20 }, () => 30), windowed: [] }],
    );
    expect(segments.size).toBe(0);
  });
});

/**
 * End-to-end guard on the SQL half: the aggregation, the (dow, hour) window
 * predicate, the null-dwell filter and the lossless sample encoding all live in
 * SQLite now, so this seeds a real database and checks the numbers against a
 * plain-JS reference computed from the same values.
 */
describe("calibrate over a real database", () => {
  let tmpDir: string;
  let bundle: DbBundle;
  const now = new Date(2026, 4, 20, 14, 30, 0); // local time — matches now.getDay()/getHours()
  const dow = now.getDay();
  const hour = now.getHours();
  const inWindow = { ts: now.getTime() - 86_400_000, dow, hour };
  const outOfWindow = { ts: now.getTime() - 86_400_000, dow: (dow + 3) % 7, hour: (hour + 6) % 24 };

  let captured: {
    segments: Map<string, SegmentStats>;
    dwells: Map<string, DwellStats>;
  };

  const sink = {
    setCalibration(s: Map<string, SegmentStats>, d: Map<string, DwellStats>) {
      captured = { segments: s, dwells: d };
    },
  } as unknown as TransitNetwork;

  function addSegment(
    routeId: number,
    from: number,
    to: number,
    travelSec: number,
    slot: { ts: number; dow: number; hour: number },
  ) {
    bundle.sqlite
      .prepare(
        `INSERT INTO segments (bus_id, bus_name, route_id, from_stop_id, to_stop_id,
           travel_sec, started_at, dow, hour) VALUES (1, 'Bus 1', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(routeId, from, to, travelSec, slot.ts, slot.dow, slot.hour);
  }

  function addArrival(
    routeId: number,
    stopId: number,
    dwellSec: number | null,
    slot: { ts: number; dow: number; hour: number },
  ) {
    bundle.sqlite
      .prepare(
        `INSERT INTO arrivals (bus_id, bus_name, route_id, stop_id, arrived_at,
           departed_at, dwell_sec, dow, hour) VALUES (1, 'Bus 1', ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(routeId, stopId, slot.ts, dwellSec, slot.dow, slot.hour);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-calibrator-"));
    bundle = openDb(path.join(tmpDir, "test.db"));
    migrate(bundle.db, { migrationsFolder: "./drizzle" });
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reproduces the per-group statistics that a row-by-row pass would produce", () => {
    // Segment 1:1→2: four observations, two of them in the current window.
    const segAll = [10.5, 20.25, 30.125, 1000];
    addSegment(1, 1, 2, segAll[0]!, inWindow);
    addSegment(1, 1, 2, segAll[1]!, inWindow);
    addSegment(1, 1, 2, segAll[2]!, outOfWindow);
    addSegment(1, 1, 2, segAll[3]!, outOfWindow);
    // Segment 1:2→3: nothing in the current window.
    const segB = [7, 9, 11];
    for (const v of segB) addSegment(1, 2, 3, v, outOfWindow);
    // A sample outside the 30-day lookback must not count at all.
    addSegment(1, 2, 3, 99_999, {
      ts: now.getTime() - 40 * 86_400_000,
      dow,
      hour,
    });
    // An hour on each edge of the ±1 window is inside it; two hours away is not.
    addSegment(1, 4, 5, 100, { ...inWindow, hour: (hour + 1) % 24 });
    addSegment(1, 4, 5, 200, { ...inWindow, hour: (hour + 23) % 24 });
    addSegment(1, 4, 5, 900, { ...inWindow, hour: (hour + 2) % 24 });

    // Dwells, including a stop that only ever produced null dwells.
    const dwellAll = [4, 6, 8, 10];
    for (const v of dwellAll) addArrival(1, 10, v, inWindow);
    addArrival(1, 11, 1, outOfWindow);
    addArrival(1, 11, 2, outOfWindow);
    addArrival(1, 11, 3, outOfWindow);
    addArrival(1, 12, null, inWindow);
    addArrival(1, 12, null, outOfWindow);

    const stats = calibrate(bundle.db, sink, now);

    expect(stats.segmentCount).toBe(3);
    expect(stats.dwellCount).toBe(2); // stop 12 contributed no non-null dwell
    // 4 + 3 segments in the lookback (the 40-day-old row is excluded) + 3 edge
    // rows, and 4 + 3 non-null dwells.
    expect(stats.sampleCount).toBe(10 + 7);

    const segA = captured.segments.get("1:1:2")!;
    const expectedA = shrink({
      samples: [segAll[0]!, segAll[1]!],
      priorMean: median(segAll),
      k: 8,
    });
    expect(segA.mean).toBe(expectedA.mean);
    expect(segA.stddev).toBe(expectedA.stddev);
    expect(segA.n).toBe(2);
    expect(segA.source).toBe("route-segment");

    const segBStats = captured.segments.get("1:2:3")!;
    expect(segBStats.mean).toBe(median(segB)); // 9 — the 99999 row aged out
    expect(segBStats.n).toBe(0);

    // hour ± 1 counts, hour ± 2 does not.
    expect(captured.segments.get("1:4:5")!.n).toBe(2);

    const dwellA = captured.dwells.get("1:10")!;
    expect(dwellA.mean).toBe(median(dwellAll));
    expect(dwellA.stddev).toBe(
      Math.max(percentile(dwellAll, 0.9) - median(dwellAll), 5),
    );
    expect(dwellA.n).toBe(4);

    const dwellB = captured.dwells.get("1:11")!;
    expect(dwellB.mean).toBe(2);
    expect(dwellB.n).toBe(0);
    expect(dwellB.q).toBeUndefined();
    expect(captured.dwells.has("1:12")).toBe(false);
  });

  it("round-trips doubles that SQLite's default text rendering would corrupt", () => {
    // SQLite renders these with ~15 significant digits by default, which maps
    // them onto *different* doubles ("0.3", "0.333333333333333"). If the
    // encoding ever regresses, this is the test that catches it: with no
    // windowed samples the reported mean is exactly the prior median, so the
    // stored double has to survive the trip untouched.
    const nasty = 0.1 + 0.2; // 0.30000000000000004
    addSegment(2, 1, 2, nasty, outOfWindow);
    addArrival(2, 20, 1 / 3, outOfWindow);

    calibrate(bundle.db, sink, now);

    expect(captured.segments.get("2:1:2")!.mean).toBe(nasty);
    expect(captured.dwells.get("2:20")!.mean).toBe(1 / 3);
  });

  it("reports zeroes on an empty database", () => {
    const stats = calibrate(bundle.db, sink, now);
    expect(stats).toMatchObject({
      segmentCount: 0,
      dwellCount: 0,
      sampleCount: 0,
    });
    expect(captured.segments.size).toBe(0);
    expect(captured.dwells.size).toBe(0);
  });

  it("serves stand quantiles and clear-clock drive from stop_visits/legs", () => {
    addSegment(1, 11, 146, 400, inWindow);
    const stands = Array.from({ length: 20 }, (_, i) => 120 + i * 15);
    for (let i = 0; i < stands.length; i++) {
      const ts = inWindow.ts + i * 60_000;
      const inside = stands[i]!;
      bundle.sqlite
        .prepare(
          `INSERT INTO stop_visits (
             bus_id, bus_name, anchor_bus_id, route_id, stop_id, stop_index,
             anchored_at, pinned_at, arrived_at, departed_at, stand_sec, inside_sec,
             outcome, how, steps, rest_polls, shuffles, closest_m, dow, hour
           ) VALUES (1, ?, 1, 1, 11, 0, ?, ?, ?, ?, ?, ?, 'stopped', 'far', 3, 4, 0, 8, ?, ?)`,
        )
        .run(
          `Bus ${i}`,
          ts,
          ts,
          ts,
          ts + inside * 1000,
          inside,
          inside,
          inWindow.dow,
          inWindow.hour,
        );
      bundle.sqlite
        .prepare(
          `INSERT INTO legs (
             bus_id, bus_name, route_id, from_stop_id, from_index, to_stop_id, to_index,
             hops, departed_at, arrived_at, to_pinned_at, leg_sec, hold_sec, drive_sec,
             holds, reached, dow, hour
           ) VALUES (1, ?, 1, 11, 0, 146, 1, 1, ?, ?, ?, 30, 0, 30, 0, 1, ?, ?)`,
        )
        .run(
          `Bus ${i}`,
          ts + inside * 1000,
          ts + inside * 1000 + 25_000,
          ts + inside * 1000 + 25_000,
          inWindow.dow,
          inWindow.hour,
        );
    }
    // Thin stop: 5 stands, must not grow a q.
    for (let i = 0; i < 5; i++) {
      const ts = inWindow.ts + i * 1_000;
      bundle.sqlite
        .prepare(
          `INSERT INTO stop_visits (
             bus_id, bus_name, anchor_bus_id, route_id, stop_id, stop_index,
             anchored_at, pinned_at, arrived_at, departed_at, stand_sec, inside_sec,
             outcome, how, steps, rest_polls, shuffles, closest_m, dow, hour
           ) VALUES (1, 'Thin', 1, 1, 99, 0, ?, ?, ?, ?, 40, 40, 'stopped', 'far', 3, 4, 0, 8, ?, ?)`,
        )
        .run(ts, ts, ts, ts + 40_000, inWindow.dow, inWindow.hour);
    }

    calibrate(bundle.db, sink, now);

    const dwell = captured.dwells.get("1:11")!;
    expect(dwell.qn).toBe(20);
    expect(dwell.q).toEqual(STAND_QUANTILE_LEVELS.map((p) => percentile(stands, p)));
    expect(captured.dwells.get("1:99")?.q).toBeUndefined();

    const hop = captured.segments.get("1:11:146")!;
    expect(hop.drive).toBe(25);
    expect(hop.driveN).toBe(20);
  });
});

describe("computeSegmentStats: physical plausibility", () => {
  // Route 9's Orange/Bradley (S) -> Building 900 is a genuine 8,204 m
  // consecutive hop (the highway run to West Campus). 2,411 of its 2,421
  // recorded samples came in under five minutes, median 90 s = 328 km/h, and
  // calibration served that median — so the planner offered the 8.4 km ride as
  // a 97-second trip. A duration gate cannot catch this; only a speed test can.
  const FAR_A = { id: 81, name: "Orange / Bradley (S)", lat: 41.31301, lon: -72.91867 };
  const FAR_B = { id: 26, name: "Building 900", lat: 41.26002, lon: -72.98698 };
  const NEAR_B = { id: 92, name: "Orange / Pearl (S)", lat: 41.31483, lon: -72.91732 };

  const net = (stops: Array<{ id: number; name: string; lat: number; lon: number }>) =>
    TransitNetwork.build(stops, [
      { id: 9, name: "Green", shortName: "G", color: "#0a0", stops: stops.map((s) => s.id) },
    ]);

  it("drops impossible samples and omits the segment entirely", () => {
    const network = net([FAR_A, FAR_B]);
    const key = TransitNetwork.segmentKey(9, 81, 26);
    const stats = computeSegmentStats(
      [{ key, n: 5, all: [90, 95, 88, 5, 120], windowed: [90, 95] }],
      network,
    );
    // Every sample implies >79 km/h over 8.2 km, so nothing credible remains.
    expect(stats.has(key)).toBe(false);
    // ...and the network therefore answers from its distance prior instead,
    // which puts the hop at a believable ~25 min rather than 97 s.
    network.setCalibration(stats, new Map());
    const served = network.getSegmentStats(9, 81, 26);
    expect(served.source).toBe("prior");
    expect(served.mean).toBeGreaterThan(20 * 60);
  });

  it("keeps the plausible samples when a pair has both", () => {
    const network = net([FAR_A, FAR_B]);
    const key = TransitNetwork.segmentKey(9, 81, 26);
    // 1500 s over 8.2 km is ~20 km/h — a real bus. 90 s is not.
    const stats = computeSegmentStats(
      [{ key, n: 4, all: [90, 1500, 1600, 95], windowed: [90, 1500, 1600, 95] }],
      network,
    );
    const got = stats.get(key)!;
    expect(got).toBeDefined();
    // The median must come from the two real samples, not the impossible ones.
    expect(got.mean).toBeGreaterThan(1000);
  });

  it("leaves ordinary short hops untouched", () => {
    const network = net([FAR_A, NEAR_B]);
    const key = TransitNetwork.segmentKey(9, 81, 92);
    const samples = [55, 60, 65, 70];
    const stats = computeSegmentStats(
      [{ key, n: samples.length, all: samples, windowed: samples }],
      network,
    );
    expect(stats.get(key)!.mean).toBeCloseTo(
      computeSegmentStats([{ key, n: samples.length, all: samples, windowed: samples }]).get(key)!.mean,
      9,
    );
  });
});
