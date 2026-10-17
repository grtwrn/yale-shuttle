import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb, type DbBundle } from "../db/client.js";
import { TransitNetwork, type SegmentStats } from "../network/TransitNetwork.js";
import { distanceMeters } from "../network/geo.js";
import { AT_STOP_PIN_M } from "../collector/detector.js";
import {
  attachDrives, attachLegQuantiles, calibrate, computePace, computePooledPace,
  MAX_PLAUSIBLE_M_S, STAND_Q_COUNT, type ValueGroup,
} from "./calibrator.js";
import capture from "./__fixtures__/blue-weekend-impossible-leg-20261017.json";

const key = "4:116:53";
const network = () => TransitNetwork.build(capture.stops,
  [{ id: 4, name: "Blue Weekend", shortName: "BW", color: "#00f", stops: [116, 53] }]);
const groups = (values = [capture.bad.leg_sec, capture.valid.leg_sec]): ValueGroup[] =>
  [{ key, n: values.length, all: values, windowed: [] }];
const base = (): Map<string, SegmentStats> => new Map([
  [key, { mean: 150, stddev: 25, n: 50, source: "route-segment" }],
]);

describe("split calibration physical travel bound", () => {
  it("rejects the recorded 5.086 s leg while preserving the valid 105.238 s leg and its exact support", () => {
    const net = network(), segments = base();
    expect(distanceMeters(capture.stops[0]!, capture.stops[1]!)).toBeGreaterThan(790);
    expect(attachDrives(segments, groups(), net)).toBe(1);
    expect(attachLegQuantiles(segments, groups(), net)).toBe(1);
    expect(segments.get(key)).toMatchObject({ drive: 105.238, driveN: 1, dqn: 1 });
    expect(segments.get(key)!.dq).toEqual(Array(STAND_Q_COUNT).fill(105.238));
  });

  it("removes the same impossible sample from route and network-wide pace", () => {
    const net = network(), chord = distanceMeters(capture.stops[0]!, capture.stops[1]!);
    const route = computePace(groups(), net).get(4)!;
    const pooled = computePooledPace(groups(), net)!;
    expect(route.n).toBe(1); expect(pooled.n).toBe(1);
    expect(route.spm).toEqual(Array(STAND_Q_COUNT).fill(105.238 / chord));
    expect(pooled.spm).toEqual(route.spm);
  });

  it("leaves split fields and pace absent when no eligible duration remains", () => {
    const net = network(), segments = base(), bad = groups([5.086, 0, -1, Infinity, NaN]);
    expect(attachDrives(segments, bad, net)).toBe(0);
    expect(attachLegQuantiles(segments, bad, net)).toBe(0);
    expect(segments.get(key)).toEqual(base().get(key));
    expect(computePace(bad, net).size).toBe(0);
    expect(computePooledPace(bad, net)).toBeNull();
  });

  it("uses the existing stop-zone allowance without changing road metres in the pace denominator", () => {
    const net = network(), chord = distanceMeters(capture.stops[0]!, capture.stops[1]!);
    const seconds = (chord - 2 * AT_STOP_PIN_M) / 20;
    expect(chord / seconds).toBeGreaterThan(MAX_PLAUSIBLE_M_S);
    const segments = base();
    expect(attachDrives(segments, groups([seconds]), net)).toBe(1);
    expect(segments.get(key)!.drive).toBe(seconds);
    expect(computePace(groups([seconds]), net).get(4)!.spm)
      .toEqual(Array(STAND_Q_COUNT).fill(seconds / chord));
  });

  it("keeps a 4-second hop between overlapping 75-metre stop zones", () => {
    const stops = [{ id: 1, name: "A", lat: 41.31, lon: -72.93 },
      { id: 2, name: "B", lat: 41.311, lon: -72.93 }];
    const net = TransitNetwork.build(stops, [{ id: 1, name: "Line", shortName: "L", color: "#000", stops: [1, 2] }]);
    expect(distanceMeters(stops[0]!, stops[1]!)).toBeLessThan(2 * AT_STOP_PIN_M);
    const values = [{ key: "1:1:2", n: 1, all: [4], windowed: [] }];
    const segments = new Map<string, SegmentStats>([["1:1:2", { mean: 30, stddev: 5, n: 10, source: "specific" }]]);
    expect(attachDrives(segments, values, net)).toBe(1);
    expect(attachLegQuantiles(segments, values, net)).toBe(1);
    expect(segments.get("1:1:2")).toMatchObject({ drive: 4, driveN: 1, dqn: 1 });
    expect(computePace(values, net).get(1)!.n).toBe(1);
  });

  it("preserves the legacy unknown-geometry path and explicit withholding", () => {
    const unknown = TransitNetwork.build([], []), segments = base();
    expect(attachDrives(segments, groups(), unknown)).toBe(1);
    expect(attachLegQuantiles(segments, groups(), unknown)).toBe(1);
    expect(segments.get(key)).toMatchObject({ drive: 55.162, driveN: 2, dqn: 2 });
    expect(computePace(groups(), unknown).size).toBe(0);
    const withheld = base();
    expect(attachDrives(withheld, groups(), network(), new Set([4]))).toBe(0);
    expect(attachLegQuantiles(withheld, groups(), network(), new Set([4]))).toBe(0);
    expect(computePooledPace(groups(), network(), new Set([4]))).toBeNull();
  });
});

let bundle: DbBundle | undefined;
afterEach(() => { bundle?.sqlite.close(); bundle = undefined; });

function database(includeValid: boolean, legacySeconds: number) {
  bundle = openDb(":memory:"); migrate(bundle.db, { migrationsFolder: "drizzle" });
  for (const row of includeValid ? [capture.bad, capture.valid] : [capture.bad]) {
    const fields = Object.keys(row);
    bundle.sqlite.prepare(`INSERT INTO legs (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`)
      .run(...fields.map(f => row[f as keyof typeof row]));
  }
  bundle.sqlite.prepare(`INSERT INTO segments
    (bus_id,bus_name,route_id,from_stop_id,to_stop_id,travel_sec,started_at,dow,hour)
    VALUES (67825,'#58',4,116,53,?,?,6,13)`).run(legacySeconds, capture.valid.departed_at);
  return bundle;
}

describe("production calibration over recorded leg rows", () => {
  it("uses only eligible observations in payload fields, pooled support and diagnostics without deleting raw rows", () => {
    const { db, sqlite } = database(true, 105.238), net = network();
    const stats = calibrate(db, net, new Date("2026-10-17T18:00:00Z"));
    expect(net.getSegmentStats(4, 116, 53)).toMatchObject({ drive: 105.238, driveN: 1, dqn: 1 });
    expect(net.getPace(4)!.n).toBe(1);
    expect(stats.pooledPaceN).toBe(1);
    expect(stats.splitSampleCount).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM legs").get()).toEqual({ n: 2 });
  });

  it("falls back to the distance prior if legacy and split observations are all impossible", () => {
    const { db, sqlite } = database(false, 5.086), net = network();
    const stats = calibrate(db, net, new Date("2026-10-17T18:00:00Z"));
    expect(net.getSegmentStats(4, 116, 53)).toMatchObject({ source: "prior" });
    expect(net.getSegmentStats(4, 116, 53).drive).toBeUndefined();
    expect(net.getPace(4)).toBeUndefined();
    expect(stats.splitSampleCount).toBe(0);
    expect(stats.pooledPaceN).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM legs").get()).toEqual({ n: 1 });
  });
});
