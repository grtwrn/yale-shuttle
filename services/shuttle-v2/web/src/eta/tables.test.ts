/**
 * THE POOLED PRIORS — the level above the route, so a line the collector has
 * not timed yet is still priced by the model.
 *
 * `buildTables` reported `priced: false` for a route whose tables carried no
 * measured drive, and `computeUpcomingArrivals` then ran a second arithmetic
 * for it. Two lines were in that state most weeks — the grocery lines, which
 * run one weekend and whose legs the retention window often does not hold —
 * and every canary finding and every row where upstream's ETAs beat ours sat
 * on them. What fills the gap is one more level of the same hierarchy:
 *
 *   stand at a stop  stop's table -> route's class pool -> NETWORK's class pool
 *   drive on a hop   hop's dq/drive -> route's pace -> NETWORK's pooled pace
 *
 * The network pace is served by the calibrator (`computePooledPace` /
 * `withPooledPace`, tested in src/calibrator/calibrator.test.ts) and rides the
 * same `__pace` carrier row; the network class pools are pooled here from the
 * payload's whole `dwells` table.
 *
 * A BRIDGED ring still declines — see eta/index.ts and
 * docs/eta-ring-posterior.md §2 for the measurement that deferred that.
 */
import { describe, expect, it } from "vitest";

import { quantile } from "./dist";
import {
  buildTables, classPools, globalClassPools, hopModel, poolsWithFallback, stopModel,
  type ClassPools, type DwellLike, type SegmentLike,
} from "./tables";
import { buildRing } from "./ring";
import type { LatLon } from "../geo";

// A rectangular loop, as in filter.test.ts / arrival.test.ts.
const LAT0 = 41.31, LON0 = -72.93;
const mLat = 1 / 111_195, mLon = 1 / 83_500;
const at = (xm: number, ym: number): LatLon => ({ lat: LAT0 + ym * mLat, lon: LON0 + xm * mLon });
const corners = [at(0, 0), at(900, 0), at(900, 450), at(0, 450)];
const STOPS = [1, 2, 3, 4];
const COORDS: Record<number, LatLon> = { 1: corners[0]!, 2: corners[1]!, 3: corners[2]!, 4: corners[3]! };
const PATH: [number, number][] = [...corners, corners[0]!].map((c) => [c.lat, c.lon]);

/** 344 Winchester's real stand table (a layover) and an ordinary kerb stop's. */
const LAYOVER_Q = [83, 129, 145, 191, 288, 333, 437, 473, 543, 674];
const KERB_Q = [0, 12, 15, 18, 22, 26, 31, 40, 55, 90];
/** The all-routes pooled pace as the calibrator served it on 2026-09-04, s/m. */
const POOLED_SPM = [0.0769, 0.0971, 0.1117, 0.1259, 0.1363, 0.1535, 0.1713, 0.1979, 0.2459, 0.3357];

const measuredRoute: Record<string, DwellLike> = {
  "1": { med: 400, n: 50, q: LAYOVER_Q, qn: 50 },
  "2": { med: 30, n: 50, q: KERB_Q, qn: 50 },
  "3": { med: 30, n: 50, q: KERB_Q, qn: 50 },
};
/** The grocery lines' usual state: rows exist, but not one stand table among them. */
const unmeasuredRoute: Record<string, DwellLike> = {
  "1": { med: 0, n: 0 },
  "2": { med: 0, n: 0 },
};

describe("the network's class pools", () => {
  it("pool every route's tables into the same two classes", () => {
    const global = globalClassPools({ "3": measuredRoute, "18": unmeasuredRoute });
    const own = classPools(measuredRoute);
    expect(global.layover).not.toBeNull();
    expect(global.ordinary).not.toBeNull();
    // One route carries every table here, so the pooled shape is that route's.
    expect(quantile(global.layover!, 0.5)).toBeCloseTo(quantile(own.layover!, 0.5), 6);
    expect(quantile(global.ordinary!, 0.5)).toBeCloseTo(quantile(own.ordinary!, 0.5), 6);
    // A layover is not a kerb stop, whichever level supplies it.
    expect(quantile(global.layover!, 0.5)).toBeGreaterThan(quantile(global.ordinary!, 0.5) + 120);
  });

  it("are null before any route has a table, and pool nothing from a route without one", () => {
    expect(globalClassPools({})).toEqual({ layover: null, ordinary: null });
    expect(globalClassPools({ "18": unmeasuredRoute })).toEqual({ layover: null, ordinary: null });
  });

  it("stand behind a route that has no pool of that class, and never in front of one", () => {
    const global = globalClassPools({ "3": measuredRoute });
    const kerbOnly = classPools({ "2": { med: 30, n: 50, q: KERB_Q, qn: 50 } });
    expect(kerbOnly.layover).toBeNull();
    const filled = poolsWithFallback(kerbOnly, global);
    // The missing class comes from the network...
    expect(filled.layover).toBe(global.layover);
    // ...and the class the route HAS is the route's own, untouched.
    expect(filled.ordinary).toBe(kerbOnly.ordinary);
    // With nothing above it, a missing class stays missing (stopModel then
    // falls back to DEFAULT_STAND).
    expect(poolsWithFallback(kerbOnly, undefined).layover).toBeNull();
  });

  it("a stop with no table of its own is priced from the pool and flagged unmeasured", () => {
    const global = globalClassPools({ "3": measuredRoute });
    const pools = poolsWithFallback(classPools(unmeasuredRoute), global);
    const m = stopModel(undefined, pools);
    expect(m.measured).toBe(false);
    expect(m.stand).toBe(global.ordinary);
  });
});

describe("the network's pooled pace", () => {
  const ROAD_M = 900;

  it("prices a hop the route has never timed, and says it is not a measurement", () => {
    const hop = hopModel({ avg: 0, n: 0 }, ROAD_M, POOLED_SPM);
    expect(hop.measured).toBe(false);
    expect(hop.includesStand).toBe(false);
    // road metres x the pooled seconds per metre, quantile by quantile.
    expect(quantile(hop.drive, 0.5)).toBeCloseTo(((0.1363 + 0.1535) / 2) * ROAD_M, 0);
    expect(hop.speedMps).toBeCloseTo(ROAD_M / quantile(hop.drive, 0.5), 6);
  });

  it("widens the range where the route is unmeasured rather than showing false confidence", () => {
    const own = [0.1376, 0.1450, 0.1500, 0.1550, 0.1600, 0.1624, 0.1700, 0.1750, 0.1800, 0.1900];
    const routeHop = hopModel({ avg: 0, n: 0 }, ROAD_M, own);
    const pooledHop = hopModel({ avg: 0, n: 0 }, ROAD_M, POOLED_SPM);
    const width = (h: typeof routeHop) => quantile(h.drive, 0.9) - quantile(h.drive, 0.1);
    expect(width(pooledHop)).toBeGreaterThan(width(routeHop));
  });

  it("never outranks a measurement of the hop itself", () => {
    const measured: SegmentLike = { avg: 200, sd: 30, n: 50, drive: 128, driveN: 50, dq: [110, 118, 122, 126, 128, 130, 134, 140, 150, 170], dqn: 50 };
    const hop = hopModel(measured, ROAD_M, POOLED_SPM);
    expect(hop.measured).toBe(true);
    // Shrunk toward the prior, but the served quantiles dominate at n = 50.
    expect(quantile(hop.drive, 0.5)).toBeLessThan(0.5 * (0.1363 + 0.1535) * ROAD_M);
  });
});

describe("a line the collector has not timed yet is priced", () => {
  const ring = buildRing("t", PATH, STOPS, COORDS)!;
  /** v1 rows only: no dq, no drive, no stand table anywhere on the route. */
  const bareSegs: Record<string, SegmentLike> = {
    "1-2": { avg: 0, n: 0 }, "2-3": { avg: 0, n: 0 },
    "3-4": { avg: 0, n: 0 }, "4-1": { avg: 0, n: 0 },
  };
  const withPace = (segs: Record<string, SegmentLike>, spm: number[]) =>
    ({ ...segs, __pace: { avg: 0, sd: 0, n: 0, spm, spmN: 9077, spmPooled: true } as SegmentLike });
  const global: ClassPools = globalClassPools({ "3": measuredRoute });

  it("is `priced`, from the pooled pace and the network's stand pool", () => {
    const t = buildTables(STOPS, COORDS, withPace(bareSegs, POOLED_SPM), unmeasuredRoute, ring, global);
    expect(t.priced).toBe(true);
    expect(t.hops).toHaveLength(4);
    for (const h of t.hops) {
      expect(quantile(h.drive, 0.5)).toBeGreaterThan(0);
      expect(h.measured).toBe(false);
    }
    for (const s of t.stops) {
      expect(s.stand).toBe(global.ordinary);
      expect(s.measured).toBe(false);
    }
  });

  it("is NOT priced with no pace anywhere — a cold database has nothing to price on", () => {
    // The only remaining decline that is about the tables rather than the
    // geometry. Before any route in the network has a leg the calibrator
    // serves `pace: {}`, and there is nothing to put a number on.
    const t = buildTables(STOPS, COORDS, bareSegs, unmeasuredRoute, ring, global);
    expect(t.priced).toBe(false);
  });

  it("a measured route is priced as it always was", () => {
    const segs: Record<string, SegmentLike> = { ...withPace({}, POOLED_SPM) };
    for (let i = 0; i < STOPS.length; i++) {
      segs[`${STOPS[i]}-${STOPS[(i + 1) % STOPS.length]}`] = {
        avg: 200, sd: 30, n: 50, drive: 128, driveN: 50,
        dq: [110, 118, 122, 126, 128, 130, 134, 140, 150, 170], dqn: 50,
      };
    }
    const t = buildTables(STOPS, COORDS, segs, measuredRoute, ring, global);
    expect(t.priced).toBe(true);
    expect(t.hops.every((h) => h.measured)).toBe(true);
  });
});
