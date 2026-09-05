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
import { distanceMeters } from "../network/geo.js";
import { TransitNetwork } from "../network/TransitNetwork.js";

import {
  attachDrives,
  attachLegQuantiles,
  attachOccurrenceStandTables,
  attachStandTables,
  calibrate,
  computeDwellStats,
  computePace,
  computeSegmentStats,
  foldRoutes,
  hourWindow,
  PACE_MIN_CHORD_M,
  SPLIT_SERVED_ROUTE_IDS,
  splitWithheldRoutes,
  parseValueList,
  STAND_Q_COUNT,
  standQuantiles,
  type ValueGroup,
} from "./calibrator.js";
import { median, percentile, shrink } from "./shrinkage.js";

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

  /** A stopped visit whose pinned stand is `standSec` (departed_at − pinned_at). */
  function addVisit(
    routeId: number,
    stopId: number,
    standSec: number | null,
    opts: { outcome?: "stopped" | "passed"; anchoredAt?: number; pinned?: boolean; stopIndex?: number } = {},
  ) {
    const anchoredAt = opts.anchoredAt ?? now.getTime() - 3_600_000;
    const pinnedAt = opts.pinned === false ? null : anchoredAt + 10_000;
    const departedAt = standSec === null || pinnedAt === null ? null : pinnedAt + standSec * 1000;
    bundle.sqlite
      .prepare(
        `INSERT INTO stop_visits (bus_id, bus_name, anchor_bus_id, route_id, stop_id, stop_index,
           anchored_at, pinned_at, arrived_at, departed_at, stand_sec, inside_sec, outcome, how,
           confidence, first_step_m, steps, far_m, confirm_sec, rest_polls, shuffles, first_moved_at,
           last_at_rest_at, closest_m, dow, hour)
         VALUES (1, 'Bus 1', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'far', 1, 31, 3, 160, 15, 4, 0, NULL, NULL, 5, ?, ?)`,
      )
      .run(routeId, stopId, opts.stopIndex ?? 0, anchoredAt, pinnedAt, pinnedAt, departedAt, standSec, standSec, opts.outcome ?? "stopped", dow, hour);
  }

  /** A one-hop leg whose pinned drive is `driveSec` (to_pinned_at − departed_at). */
  function addLeg(
    routeId: number,
    from: number,
    to: number,
    driveSec: number,
    opts: { hops?: number; departedAt?: number; toPinned?: boolean } = {},
  ) {
    const departedAt = opts.departedAt ?? now.getTime() - 3_600_000;
    const arrivedAt = departedAt + driveSec * 1000;
    const toPinnedAt = opts.toPinned === false ? null : arrivedAt;
    bundle.sqlite
      .prepare(
        `INSERT INTO legs (bus_id, bus_name, route_id, from_stop_id, from_index, to_stop_id, to_index,
           hops, departed_at, arrived_at, to_pinned_at, leg_sec, hold_sec, drive_sec, holds, reached, dow, hour)
         VALUES (1, 'Bus 1', ?, ?, 0, ?, 1, ?, ?, ?, ?, ?, 0, ?, 0, 1, ?, ?)`,
      )
      .run(routeId, from, to, opts.hops ?? 1, departedAt, arrivedAt, toPinnedAt, driveSec, driveSec, dow, hour);
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
      standCount: 0,
      driveCount: 0,
      splitSampleCount: 0,
    });
    expect(captured.segments.size).toBe(0);
    expect(captured.dwells.size).toBe(0);
  });

  // The stand/drive split (PR #81's contract): `q`/`qn` on the stop, `drive`/
  // `driveN` on the hop, both on the at_stop_since clock, pooled over the
  // window and served with their TRUE counts — the client gates on the count,
  // so nothing here may pre-filter.
  it("serves the pinned-clock stand quantiles and drive from stop_visits / legs", () => {
    // The hop 1→2 has arrival-to-arrival samples (what `avg` is made of)...
    for (const v of [300, 320, 340]) addSegment(1, 1, 2, v, inWindow);
    addArrival(1, 1, 310, inWindow);
    // ...and, from the derivation, three stopped visits at stop 1, one PINNED
    // pass-through (at_stop was set while the bus rolled by: a 0 s stand on
    // the client's clock, so P(stop) enters the table), and three one-hop legs
    // 1→2. A visit never pinned has no at_stop_since to measure from and is
    // not a sample; a two-hop leg is a different hop; a leg pinned at B before
    // it left A (0 s) is not a drive.
    addVisit(1, 1, 100);
    addVisit(1, 1, 200);
    addVisit(1, 1, 400);
    addVisit(1, 1, null, { outcome: "passed" });
    addVisit(1, 1, null, { outcome: "passed", pinned: false });
    addVisit(1, 1, 50, { pinned: false });
    addLeg(1, 1, 2, 20);
    addLeg(1, 1, 2, 25);
    addLeg(1, 1, 2, 90); // one long red light
    addLeg(1, 1, 3, 40, { hops: 2 });
    addLeg(1, 1, 2, 0);
    // A stop with visits but no arrivals-based dwell entry still gets its table.
    addVisit(1, 7, 60);
    // A hop with legs but no arrival-to-arrival segment is answered from the
    // distance prior, which carries no drive.
    addLeg(1, 7, 8, 30);
    // Outside the 30-day window: not a sample.
    addVisit(1, 1, 9_999, { anchoredAt: now.getTime() - 40 * 86_400_000 });
    addLeg(1, 1, 2, 9_999, { departedAt: now.getTime() - 40 * 86_400_000 });

    const stats = calibrate(bundle.db, sink, now);

    const dwell = captured.dwells.get("1:1")!;
    expect(dwell.q).toEqual(standQuantiles([0, 100, 200, 400]));
    expect(dwell.q).toHaveLength(STAND_Q_COUNT);
    expect(dwell.qn).toBe(4);
    // ...and the arrival-based numbers beside it are untouched.
    expect(dwell.mean).toBe(310);

    const seg = captured.segments.get("1:1:2")!;
    expect(seg.drive).toBe(25); // the median, not the mean (45): one red light is not the hop
    expect(seg.driveN).toBe(3);
    expect(seg.mean).toBe(shrink({ samples: [300, 320, 340], priorMean: 320, k: 8 }).mean);

    const orphanStop = captured.dwells.get("1:7")!;
    expect(orphanStop.q).toEqual(standQuantiles([60]));
    expect(orphanStop.qn).toBe(1);
    expect(orphanStop.n).toBe(0); // the warm-up defaults, not a fabricated dwell

    expect(captured.segments.has("1:7:8")).toBe(false);

    expect(stats.standCount).toBe(2);
    expect(stats.driveCount).toBe(1);
    expect(stats.splitSampleCount).toBe(5 + 4); // stand samples (incl. the pinned pass) + one-hop legs with a positive drive (7→8 counts as a sample even though it is not attached)
  });

  // The estimator's fields (the ring plan, step 1): `dq`/`dqn` are the whole
  // hop's quantiles (leg_sec) on the same hops that carry a drive; `pstop`
  // counts EVERY pass, pinned or not, on the rows that carry `q`; `pace` is
  // per route and needs stop geometry, which this sink has none of.
  it("serves the whole-hop quantiles and P(stop) beside the split, and no pace without geometry", () => {
    for (const v of [300, 320, 340]) addSegment(1, 1, 2, v, inWindow);
    addArrival(1, 1, 310, inWindow);
    addVisit(1, 1, 100);
    addVisit(1, 1, 200);
    addVisit(1, 1, null, { outcome: "passed" });
    addVisit(1, 1, null, { outcome: "passed", pinned: false }); // not in `q`, but in pstop
    addVisit(1, 1, 50, { pinned: false }); // stopped, unpinned: not in `q`, but in pstop
    addVisit(1, 1, 9_999, { anchoredAt: now.getTime() - 40 * 86_400_000 }); // outside the window
    addLeg(1, 1, 2, 20);
    addLeg(1, 1, 2, 25);
    addLeg(1, 1, 2, 90);
    addLeg(1, 1, 3, 40, { hops: 2 }); // a two-hop leg is a different quantity
    addLeg(1, 1, 2, 0); // not a sample
    addLeg(1, 1, 2, 9_999, { departedAt: now.getTime() - 40 * 86_400_000 }); // outside the window
    addLeg(1, 7, 8, 30); // legs but no calibrated segment: nowhere to carry dq

    const stats = calibrate(bundle.db, sink, now);

    const seg = captured.segments.get("1:1:2")!;
    expect(seg.dq).toEqual(standQuantiles([20, 25, 90]));
    expect(seg.dq).toHaveLength(STAND_Q_COUNT);
    expect(seg.dqn).toBe(3);
    expect(seg.drive).toBe(25); // untouched beside it
    expect(captured.segments.has("1:7:8")).toBe(false);

    const dwell = captured.dwells.get("1:1")!;
    expect(dwell.q).toEqual(standQuantiles([0, 100, 200]));
    expect(dwell.qn).toBe(3);
    expect(dwell.pstop).toBeCloseTo(3 / 5, 10); // 3 stopped of 5 resolved visits in the window

    expect(stats.legQuantileCount).toBe(1);
    expect(stats.paceRouteCount).toBe(0); // the sink carries no stops, so no chord
  });

  it("serves a pooled pace per route from the legs and the stop geometry", () => {
    const network = TransitNetwork.build(
      [
        { id: 1, name: "A", lat: 41.31, lon: -72.93 },
        { id: 2, name: "B", lat: 41.31, lon: -72.92 }, // ~836 m east of A
        { id: 3, name: "C", lat: 41.31, lon: -72.91 },
      ],
      [{ id: 3, name: "Red", shortName: "R", color: "#c00", stops: [1, 2, 3] }],
    );
    const chordAB = distanceMeters({ lat: 41.31, lon: -72.93 }, { lat: 41.31, lon: -72.92 });
    addLeg(3, 1, 2, 100);
    addLeg(3, 1, 2, 200);
    addLeg(3, 2, 3, 150);
    addLeg(3, 1, 2, 0); // not a sample
    addLeg(3, 1, 3, 400, { hops: 2 }); // not a sample

    const stats = calibrate(bundle.db, network, now);

    const pace = network.getPace(3)!;
    expect(pace.n).toBe(3);
    // A→B and B→C have the same chord, so the pool is {100, 200, 150} / chord.
    expect(pace.spm).toEqual(standQuantiles([100 / chordAB, 200 / chordAB, 150 / chordAB]));
    expect(stats.paceRouteCount).toBe(1);
    expect(network.getPace(1)).toBeUndefined();
  });

  // Pace is per ROAD metre when the published line supplies the hop: the same
  // trace the client cuts its ring from (src/network/legs.ts), so a winding
  // hop is not priced as if it were straight.
  it("prices the pace per road metre of the published line, chord only where the line cannot supply the hop", () => {
    // A rectangle: A and B on the bottom side, C on the top. A→B runs straight
    // along the bottom (road = chord); B→C goes round the corner (road > chord).
    const path: [number, number][] = [
      [41.31, -72.93], [41.31, -72.91], [41.312, -72.91], [41.312, -72.93],
    ];
    const stops = [
      { id: 1, name: "A", lat: 41.31, lon: -72.93 },
      { id: 2, name: "B", lat: 41.31, lon: -72.92 },
      { id: 3, name: "C", lat: 41.312, lon: -72.92 },
    ];
    const network = TransitNetwork.build(stops, [
      { id: 3, name: "Red", shortName: "R", color: "#c00", stops: [1, 2, 3], path },
      { id: 8, name: "Pink", shortName: "K", color: "#f8c", stops: [1, 2, 3] }, // no path: chord
    ]);
    const roadAB = network.getLegMeters(3, 1, 2)!;
    const roadBC = network.getLegMeters(3, 2, 3)!;
    const chordBC = distanceMeters(stops[1]!, stops[2]!);
    expect(roadBC).toBeGreaterThan(chordBC * 3); // ~840 + 222 + 840 m vs ~222 m
    expect(network.getLegMeters(8, 2, 3)).toBeUndefined();
    addLeg(3, 1, 2, 100);
    addLeg(3, 2, 3, 300);
    addLeg(8, 2, 3, 300);

    calibrate(bundle.db, network, now);

    expect(network.getPace(3)!.spm).toEqual(standQuantiles([100 / roadAB, 300 / roadBC]));
    expect(network.getPace(8)!.spm).toEqual(standQuantiles([300 / chordBC]));
  });

  // Routes 9 and 10 visit a West Campus stop twice per lap and the two passes
  // stand very differently (Purple stop 25: mean 107 s at index 6, 42 s at
  // index 12). One table per pass goes out beside the pooled one.
  it("serves a stand table per pass of a repeated stop, beside the pooled one", () => {
    const network = TransitNetwork.build(
      [
        { id: 1, name: "A", lat: 41.31, lon: -72.93 },
        { id: 2, name: "B", lat: 41.31, lon: -72.92 },
        { id: 3, name: "C", lat: 41.31, lon: -72.91 },
      ],
      [{ id: 10, name: "Purple", shortName: "P", color: "#808", stops: [1, 2, 3, 2] }],
    );
    // Outbound pass of B (index 1): a layover. Inbound (index 3): a pass-through and a short stop.
    addVisit(10, 2, 100, { stopIndex: 1 });
    addVisit(10, 2, 120, { stopIndex: 1 });
    addVisit(10, 2, null, { stopIndex: 3, outcome: "passed" });
    addVisit(10, 2, 20, { stopIndex: 3 });
    addVisit(10, 2, 30, { stopIndex: 3, pinned: false }); // in pstop, not in q
    // A stale index the current sequence no longer has: dropped, not served.
    addVisit(10, 2, 999, { stopIndex: 7 });
    // A stop the route lists once: the pooled table only, no "#" entry.
    addVisit(10, 1, 60, { stopIndex: 0 });

    const stats = calibrate(bundle.db, network, now);

    const pooled = network.getDwellStats(10, 2);
    expect(pooled.q).toEqual(standQuantiles([0, 20, 100, 120, 999]));
    expect(pooled.qn).toBe(5);
    expect(pooled.mean).toBe(15); // the warm-up default: the pooled entry is untouched

    const out = network.getOccurrenceDwellStats(10, 2, 1)!;
    expect(out.q).toEqual(standQuantiles([100, 120]));
    expect(out.qn).toBe(2);
    expect(out.pstop).toBe(1);
    expect(out.mean).toBe(110); // the pass's median stand
    expect(out.stddev).toBe(Math.max(percentile([100, 120], 0.9) - 110, 5));
    expect(out.n).toBe(2);

    const back = network.getOccurrenceDwellStats(10, 2, 3)!;
    expect(back.q).toEqual(standQuantiles([0, 20]));
    expect(back.qn).toBe(2);
    expect(back.pstop).toBeCloseTo(2 / 3, 10); // stopped 2 of 3 resolved passes, pinned or not

    expect(network.getOccurrenceDwellStats(10, 2, 7)).toBeUndefined();
    expect(network.getOccurrenceDwellStats(10, 1, 0)).toBeUndefined();
    expect(stats.occurrenceStandCount).toBe(2);
    expect(stats.standCount).toBe(2);
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

// The stand/drive split: the quantile levels are the client's reading of `q`
// ((i + 0.5) / n), and both halves are attached with their true counts.
describe("stand tables and drives", () => {
  it("places the quantiles at (i + 0.5) / STAND_Q_COUNT, ascending", () => {
    const samples = [118, 136, 145, 176, 242, 303, 386, 452, 480, 566, 598]; // 344 Winchester, reference table
    const q = standQuantiles(samples);
    expect(q).toHaveLength(STAND_Q_COUNT);
    for (let i = 1; i < q.length; i++) expect(q[i]!).toBeGreaterThanOrEqual(q[i - 1]!);
    expect(q[0]).toBe(percentile(samples, 0.05));
    expect(q[STAND_Q_COUNT - 1]).toBe(percentile(samples, 0.95));
    // The median sits between the two middle knots.
    expect(median(samples)).toBeGreaterThanOrEqual(q[4]!);
    expect(median(samples)).toBeLessThanOrEqual(q[5]!);
    // A single sample is a flat table — served as such, with qn = 1 for the gate.
    expect(standQuantiles([60])).toEqual(new Array(STAND_Q_COUNT).fill(60));
  });

  it("attaches q/qn to the dwell entry and leaves the rest of it alone", () => {
    const dwells = new Map<string, DwellStats>([["1:1", { mean: 310, stddev: 20, n: 4, low: 200 }]]);
    const n = attachStandTables(dwells, [
      { key: "1:1", n: 2, all: [100, 300], windowed: [] },
      { key: "1:9", n: 1, all: [60], windowed: [] },
      { key: "1:5", n: 0, all: [], windowed: [] },
    ]);
    expect(n).toBe(2);
    expect(dwells.get("1:1")).toEqual({ mean: 310, stddev: 20, n: 4, low: 200, q: standQuantiles([100, 300]), qn: 2 });
    expect(dwells.get("1:9")).toEqual({ mean: 15, stddev: 10, n: 0, q: standQuantiles([60]), qn: 1 });
    expect(dwells.has("1:5")).toBe(false);
  });

  // Every route gets its tables wherever data exists (2026-09-05): the
  // estimator prices every line, and the legacy client's split gate lives on
  // its side. The fold/allowlist sets are still computable — the replay
  // rebuilds the old production payload from them — but `calibrate` no
  // longer consults them, and the attachers withhold nothing unless asked.
  it("serves both halves on a fold route and on a line off the legacy allowlist", () => {
    const stops = [
      { id: 1, name: "A", lat: 41.31, lon: -72.93 },
      { id: 2, name: "B", lat: 41.311, lon: -72.931 },
      { id: 3, name: "C", lat: 41.312, lon: -72.932 },
    ];
    const network = TransitNetwork.build(stops, [
      { id: 10, name: "Purple", shortName: "P", color: "#808", stops: [1, 2, 3, 2] },
      { id: 3, name: "Red", shortName: "R", color: "#c00", stops: [1, 2, 3] },
      { id: 8, name: "Pink", shortName: "K", color: "#f8c", stops: [1, 2, 3] },
    ]);
    expect([...foldRoutes(network)]).toEqual([10]);
    expect(SPLIT_SERVED_ROUTE_IDS.has(3)).toBe(true);
    expect(SPLIT_SERVED_ROUTE_IDS.has(8)).toBe(false);
    expect([...splitWithheldRoutes(network)].sort()).toEqual([10, 8]);

    const dwells = new Map<string, DwellStats>();
    expect(attachStandTables(dwells, [
      { key: "10:2", n: 30, all: [20, 300], windowed: [] },
      { key: "8:2", n: 2, all: [20, 40], windowed: [] },
      { key: "3:2", n: 2, all: [20, 40], windowed: [] },
    ])).toBe(3);
    expect(dwells.get("10:2")!.qn).toBe(2);
    expect(dwells.get("8:2")!.qn).toBe(2);

    const segments = new Map<string, SegmentStats>([
      ["10:2:3", { mean: 60, stddev: 5, n: 3, source: "specific" }],
      ["8:2:3", { mean: 60, stddev: 5, n: 3, source: "specific" }],
    ]);
    expect(attachDrives(segments, [
      { key: "10:2:3", n: 12, all: [30, 31], windowed: [] },
      { key: "8:2:3", n: 12, all: [30, 31], windowed: [] },
    ])).toBe(2);
    expect(segments.get("10:2:3")!.drive).toBe(30.5);
    expect(segments.get("8:2:3")!.drive).toBe(30.5);

    // Asked to, the attachers still withhold — the replay's "served" arm.
    const withheld = splitWithheldRoutes(network);
    const again = new Map<string, DwellStats>();
    expect(attachStandTables(again, [
      { key: "10:2", n: 30, all: [20, 300], windowed: [] },
      { key: "3:2", n: 2, all: [20, 40], windowed: [] },
    ], withheld)).toBe(1);
    expect(again.has("10:2")).toBe(false);
  });

  it("attaches per-pass tables only to stops the route repeats, at indices it still has", () => {
    const network = TransitNetwork.build(
      [
        { id: 1, name: "A", lat: 41.31, lon: -72.93 },
        { id: 2, name: "B", lat: 41.311, lon: -72.931 },
        { id: 3, name: "C", lat: 41.312, lon: -72.932 },
      ],
      [{ id: 10, name: "Purple", shortName: "P", color: "#808", stops: [1, 2, 3, 2] }],
    );
    const dwells = new Map<string, DwellStats>([["10:2", { mean: 15, stddev: 10, n: 0, q: standQuantiles([5, 100]), qn: 2 }]]);
    const shares = new Map([["10:2#1", 0.9], ["10:2#3", 0.4]]);
    expect(attachOccurrenceStandTables(dwells, network, [
      { key: "10:2#1", n: 1, all: [100], windowed: [] },
      { key: "10:2#3", n: 1, all: [5], windowed: [] },
      { key: "10:2#9", n: 1, all: [50], windowed: [] }, // not an index the sequence has
      { key: "10:1#0", n: 1, all: [50], windowed: [] }, // not a repeated stop
      { key: "11:2#1", n: 1, all: [50], windowed: [] }, // unknown route
      { key: "10:2#5", n: 0, all: [], windowed: [] },
      { key: "10:2", n: 1, all: [50], windowed: [] }, // a pooled key: not this attacher's
    ], shares)).toBe(2);
    expect(dwells.get("10:2#1")).toEqual({ mean: 100, stddev: 5, n: 1, q: standQuantiles([100]), qn: 1, pstop: 0.9 });
    expect(dwells.get("10:2#3")).toEqual({ mean: 5, stddev: 5, n: 1, q: standQuantiles([5]), qn: 1, pstop: 0.4 });
    expect([...dwells.keys()].sort()).toEqual(["10:2", "10:2#1", "10:2#3"]);
    expect(dwells.get("10:2")!.qn).toBe(2); // the pooled entry is untouched
  });

  it("attaches the median drive only where a calibrated segment exists", () => {
    const segments = new Map<string, SegmentStats>([["1:1:2", { mean: 495, stddev: 5, n: 0, source: "route-segment" }]]);
    const n = attachDrives(segments, [
      { key: "1:1:2", n: 3, all: [15, 20, 90], windowed: [] },
      { key: "1:2:3", n: 5, all: [30, 30, 30, 30, 30], windowed: [] },
    ]);
    expect(n).toBe(1);
    expect(segments.get("1:1:2")).toEqual({ mean: 495, stddev: 5, n: 0, source: "route-segment", drive: 20, driveN: 3 });
    expect(segments.has("1:2:3")).toBe(false);
  });

  it("attaches the whole-hop quantiles under the same rules as the drive", () => {
    const segments = new Map<string, SegmentStats>([
      ["1:1:2", { mean: 495, stddev: 5, n: 0, source: "route-segment", drive: 20, driveN: 3 }],
      ["9:1:2", { mean: 60, stddev: 5, n: 3, source: "specific" }],
    ]);
    const n = attachLegQuantiles(segments, [
      { key: "1:1:2", n: 3, all: [15, 20, 90], windowed: [] },
      { key: "1:2:3", n: 5, all: [30, 30, 30, 30, 30], windowed: [] }, // no calibrated segment
      { key: "9:1:2", n: 2, all: [30, 40], windowed: [] }, // withheld
      { key: "1:3:4", n: 0, all: [], windowed: [] },
    ], new Set([9]));
    expect(n).toBe(1);
    expect(segments.get("1:1:2")).toEqual({
      mean: 495, stddev: 5, n: 0, source: "route-segment", drive: 20, driveN: 3,
      dq: standQuantiles([15, 20, 90]), dqn: 3,
    });
    expect(segments.get("1:1:2")!.dq).toHaveLength(STAND_Q_COUNT);
    expect(segments.has("1:2:3")).toBe(false);
    expect(segments.get("9:1:2")!.dq).toBeUndefined();
  });

  it("rides P(stop) on the rows that carry q, and nowhere else", () => {
    const dwells = new Map<string, DwellStats>();
    const shares = new Map([["1:1", 0.75], ["1:5", 0.5], ["9:1", 0.9]]);
    expect(attachStandTables(dwells, [
      { key: "1:1", n: 2, all: [100, 300], windowed: [] },
      { key: "1:9", n: 1, all: [60], windowed: [] }, // no share row
      { key: "1:5", n: 0, all: [], windowed: [] }, // share but no table
      { key: "9:1", n: 2, all: [10, 20], windowed: [] }, // withheld
    ], new Set([9]), shares)).toBe(2);
    expect(dwells.get("1:1")).toEqual({ mean: 15, stddev: 10, n: 0, q: standQuantiles([100, 300]), qn: 2, pstop: 0.75 });
    expect(dwells.get("1:9")).toEqual({ mean: 15, stddev: 10, n: 0, q: standQuantiles([60]), qn: 1 });
    expect(dwells.has("1:5")).toBe(false);
    expect(dwells.has("9:1")).toBe(false);
  });

  it("pools the pace per route over the hop length, dropping short hops and (when asked) withheld routes", () => {
    const network = TransitNetwork.build(
      [
        { id: 1, name: "A", lat: 41.31, lon: -72.93 },
        { id: 2, name: "B", lat: 41.31, lon: -72.92 },
        { id: 3, name: "C", lat: 41.31, lon: -72.91 },
        { id: 4, name: "C'", lat: 41.31001, lon: -72.91 }, // ~1 m from C
      ],
      [
        { id: 3, name: "Red", shortName: "R", color: "#c00", stops: [1, 2, 3, 4] },
        { id: 8, name: "Pink", shortName: "K", color: "#f8c", stops: [1, 2, 3] },
      ],
    );
    const chord = distanceMeters({ lat: 41.31, lon: -72.93 }, { lat: 41.31, lon: -72.92 });
    expect(distanceMeters({ lat: 41.31, lon: -72.91 }, { lat: 41.31001, lon: -72.91 })).toBeLessThan(PACE_MIN_CHORD_M);
    const pace = computePace([
      { key: "3:1:2", n: 2, all: [100, 200], windowed: [] },
      { key: "3:2:3", n: 1, all: [150], windowed: [] },
      { key: "3:3:4", n: 3, all: [5, 5, 5], windowed: [] }, // chord < 30 m: not a sample
      { key: "3:4:1", n: 1, all: [0], windowed: [] }, // non-positive: not a sample
      { key: "3:1:99", n: 1, all: [50], windowed: [] }, // unknown stop: no chord
      { key: "8:1:2", n: 4, all: [100, 100, 100, 100], windowed: [] }, // withheld
    ], network, new Set([8]));
    expect([...pace.keys()]).toEqual([3]);
    expect(pace.get(3)).toEqual({ spm: standQuantiles([100 / chord, 200 / chord, 150 / chord]), n: 3 });
    expect(pace.get(3)!.spm).toHaveLength(STAND_Q_COUNT);
    // No legs at all: no pace at all — the payload's `pace` is then `{}`.
    expect(computePace([], network).size).toBe(0);
  });
});
