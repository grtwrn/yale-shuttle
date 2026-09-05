import { describe, expect, it } from "vitest";
import { cdf, fromQuantiles, quantile, residual, type Dist } from "./dist";
import { stepBelief, type Belief } from "./filter";
import { buildRing, type Ring } from "./ring";
import { buildTables, hiddenRest, PACE_KEY, type RouteTables } from "./tables";
import { K, priceRoute, type Floors } from "./arrival";
import type { LatLon } from "../geo";

// The same rectangular loop as filter.test.ts.
const LAT0 = 41.31, LON0 = -72.93;
const mLat = 1 / 111_195, mLon = 1 / 83_500;
function at(xm: number, ym: number): LatLon { return { lat: LAT0 + ym * mLat, lon: LON0 + xm * mLon }; }
const corners = [at(0, 0), at(900, 0), at(900, 450), at(0, 450)];
const STOPS = [1, 2, 3, 4];
const COORDS: Record<number, LatLon> = { 1: corners[0]!, 2: corners[1]!, 3: corners[2]!, 4: corners[3]! };
const PATH: [number, number][] = [...corners, corners[0]!].map((c) => [c.lat, c.lon]);

// Red-like tables: stop 1 is a layover (344 Winchester's real table), the
// others ordinary; drives from leg lengths at ~7 m/s.
const Q11 = [83, 129, 145, 191, 288, 333, 437, 473, 543, 674];
const ORD = [0, 12, 15, 18, 22, 26, 31, 40, 55, 90];
function dq(sec: number): number[] { return [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2, 1.35, 1.6].map((f) => Math.round(sec * f)); }
const SEGS = {
  "1-2": { avg: 140, sd: 20, n: 50, drive: 128, driveN: 50, dq: dq(128), dqn: 50 },
  "2-3": { avg: 70, sd: 10, n: 50, drive: 64, driveN: 50, dq: dq(64), dqn: 50 },
  "3-4": { avg: 140, sd: 20, n: 50, drive: 128, driveN: 50, dq: dq(128), dqn: 50 },
  "4-1": { avg: 70, sd: 10, n: 50, drive: 64, driveN: 50, dq: dq(64), dqn: 50 },
};
const DWELLS = {
  "1": { med: 400, sd: 200, n: 50, q: Q11, qn: 50 },
  "2": { med: 30, sd: 20, n: 50, q: ORD, qn: 50 },
  "3": { med: 30, sd: 20, n: 50, q: ORD, qn: 50 },
  "4": { med: 30, sd: 20, n: 50, q: ORD, qn: 50 },
};

function setup(): { ring: Ring; tables: RouteTables } {
  const ring = buildRing("t", PATH, STOPS, COORDS)!;
  return { ring, tables: buildTables(STOPS, COORDS, SEGS, DWELLS) };
}
const since = new Date(0).toISOString().replace("Z", "");
function standAt1(t: number) { return { lat: corners[0]!.lat, lon: corners[0]!.lon, stationary_since: since }; }

/** Exact convolution of independent distributions on a 1 s grid, as a CDF sampler. */
function convolve(ds: Dist[], maxSec = 4000): (p: number) => number {
  let pmf = new Float64Array(maxSec + 1);
  pmf[0] = 1;
  for (const d of ds) {
    const dp = new Float64Array(maxSec + 1);
    let prev = 0;
    for (let x = 0; x <= maxSec; x++) { const F = cdf(d, x + 0.5); dp[x] = F - prev; prev = F; }
    const out = new Float64Array(maxSec + 1);
    for (let a = 0; a <= maxSec; a++) {
      if (pmf[a]! === 0) continue;
      for (let b = 0; a + b <= maxSec; b++) out[a + b] = out[a + b]! + pmf[a]! * dp[b]!;
    }
    pmf = out;
  }
  const cum: number[] = [];
  let s = 0;
  for (let x = 0; x <= maxSec; x++) { s += pmf[x]!; cum.push(s); }
  return (p) => cum.findIndex((c) => c >= p);
}

describe("arrival: the sum of the chain", () => {
  it("matches exact convolution at every quantile for a moving bus", () => {
    const { ring, tables } = setup();
    // Moving on leg 0 at fraction 0 (just left stop 1), stop 3 two hops on:
    // D_0 + S_2 + D_1.
    let b = stepBelief(undefined, ring, { lat: at(35, 0).lat, lon: at(35, 0).lon }, 0, STOPS);
    b = stepBelief(b, ring, { lat: at(70, 0).lat, lon: at(70, 0).lon }, 5000, STOPS);
    b = stepBelief(b, ring, { lat: at(105, 0).lat, lon: at(105, 0).lon }, 10_000, STOPS);
    const rows = priceRoute(b, ring, tables, STOPS, new Set([3]), 10_000, 0.5);
    const row = rows.find((r) => r.stopId === 3 && r.occurrence === 0)!;
    expect(row).toBeDefined();
    const frac = 105 / 900;
    const exact = convolve([
      fromQuantiles(dq(128).map((x) => x * (1 - frac))),
      tables.stops[1]!.stand,
      tables.hops[1]!.drive,
    ]);
    // Within a few seconds of the exact sum at the median and below (K = 256
    // strata; the moving mass is spread over a few cells). The upper tail is
    // wider than the pure-drive convolution because the belief also carries a
    // small "came to a hold" situation, which is the model being honest.
    expect(Math.abs(row.eta - exact(0.5))).toBeLessThan(6);
    expect(Math.abs(row.low - exact(0.1))).toBeLessThan(8);
    expect(row.high - exact(0.9)).toBeLessThan(20);
    expect(row.high - exact(0.9)).toBeGreaterThan(-8);
    expect(row.stopsAhead).toBe(2);
    expect(row.estimated).toBe(false);
  });

  it("prices a standing bus from the residual stand, and the number is the chip's", () => {
    const { ring, tables } = setup();
    const now = 300_000; // 300 s into the stand at stop 1
    let b = stepBelief(undefined, ring, standAt1(0), now - 30_000, STOPS);
    for (let t = 1; t <= 6; t++) b = stepBelief(b, ring, standAt1(0), now - 30_000 + t * 5000, STOPS);
    const rows = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5);
    const row = rows.find((r) => r.stopId === 2 && r.occurrence === 0)!;
    const rest = residual(tables.stops[0]!.stand, 300);
    // Median of (rest + drive): close to rest median + drive median for a tight drive.
    const approx = rest(0.5) + quantile(tables.hops[0]!.drive, 0.5);
    expect(Math.abs(row.eta - approx)).toBeLessThan(15);
    expect(row.standingAt).toBe(0);
    expect(row.stopsAhead).toBe(1);
  });

  it("the departure moves the number to the drive once the bus is beyond the rest radius", () => {
    const { ring, tables } = setup();
    let now = 300_000;
    let b = stepBelief(undefined, ring, standAt1(0), now - 30_000, STOPS);
    for (let t = 1; t <= 6; t++) b = stepBelief(b, ring, standAt1(0), now - 30_000 + t * 5000, STOPS);
    const before = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5).find((r) => r.stopId === 2 && r.occurrence === 0)!;
    // A first fresh fix 35 m on, no server clock any more: inside the rest
    // radius the bus may be creeping — a repeat there would put it back on
    // the SAME stand — so the shown mode stays "standing" (filter.ts
    // `standingShare`) and the number is the rest continuing, then the
    // drive: it does not climb, and it does not yet collapse.
    now += 5000;
    b = stepBelief(b, ring, { lat: at(35, 0).lat, lon: at(35, 0).lon }, now, STOPS);
    const dep = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5).find((r) => r.stopId === 2 && r.occurrence === 0)!;
    expect(dep.standingAt).toBe(0);
    expect(dep.eta).toBeLessThanOrEqual(before.eta + 10);
    // ...and the range already carries the departure hypothesis.
    expect(dep.low).toBeLessThan(quantile(tables.hops[0]!.drive, 0.5));
    now += 5000;
    b = stepBelief(b, ring, { lat: at(70, 0).lat, lon: at(70, 0).lon }, now, STOPS);
    const second = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5).find((r) => r.stopId === 2 && r.occurrence === 0)!;
    expect(second.eta).toBeLessThanOrEqual(dep.eta + 10);
    // Beyond REST_RADIUS_M the rest has ended and a repeat could no longer
    // return the bus to it: the decision flips and the number is the drive.
    now += 5000;
    b = stepBelief(b, ring, { lat: at(140, 0).lat, lon: at(140, 0).lon }, now, STOPS);
    const gone = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5).find((r) => r.stopId === 2 && r.occurrence === 0)!;
    expect(gone.standingAt).toBe(-1);
    expect(gone.eta).toBeLessThan(before.eta - 60);
    expect(gone.eta).toBeLessThan(quantile(tables.hops[0]!.drive, 0.9) + 5);
    now += 5000;
    b = stepBelief(b, ring, { lat: at(175, 0).lat, lon: at(175, 0).lon }, now, STOPS);
    const fourth = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5).find((r) => r.stopId === 2 && r.occurrence === 0)!;
    expect(fourth.eta).toBeLessThan(gone.eta);
    expect(fourth.high - fourth.low).toBeLessThan(110); // the drive's own q10-q90 spread is ~90 s at this fraction
  });

  it("the shown number never climbs while the bus stands (the clamp), and the clamp releases on departure", () => {
    const { ring, tables } = setup();
    const floors: Floors = { map: new Map() };
    let b: Belief | undefined;
    let prevEta = Infinity;
    let t0 = 0;
    let ticked = 0;
    for (let r = 30; r <= 700; r += 5) {
      const now = t0 + r * 1000;
      b = stepBelief(b, ring, standAt1(0), now, STOPS);
      const row = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5, floors).find((x) => x.stopId === 2 && x.occurrence === 0)!;
      expect(row.eta).toBeLessThanOrEqual(prevEta + 1e-9);
      if (row.eta < prevEta - 1) ticked++;
      prevEta = row.eta;
      // ...and it never reads "now" for a bus that is still standing: the
      // rest is conditioned on the time already stood, so it decays, it does
      // not run out.
      expect(row.eta).toBeGreaterThan(quantile(tables.hops[0]!.drive, 0.5) - 1);
    }
    expect(ticked).toBeGreaterThan(20);
    // Departure releases it: inside the rest radius the floor still holds
    // (the bus may be creeping); beyond it the number drops to the drive.
    let now = t0 + 705_000;
    b = stepBelief(b, ring, { lat: at(35, 0).lat, lon: at(35, 0).lon }, now, STOPS);
    const creep = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5, floors).find((x) => x.stopId === 2 && x.occurrence === 0)!;
    expect(creep.standingAt).toBe(0);
    expect(creep.eta).toBeLessThanOrEqual(prevEta + 1e-9);
    now += 5000;
    b = stepBelief(b, ring, { lat: at(140, 0).lat, lon: at(140, 0).lon }, now, STOPS);
    const row = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5, floors).find((x) => x.stopId === 2 && x.occurrence === 0)!;
    expect(row.standingAt).toBe(-1);
    expect(row.eta).toBeLessThan(quantile(tables.hops[0]!.drive, 0.9) + 5);
  });

  it("gives two entries per stop: this lap and the next", () => {
    const { ring, tables } = setup();
    let b = stepBelief(undefined, ring, { lat: at(300, 0).lat, lon: at(300, 0).lon }, 0, STOPS);
    b = stepBelief(b, ring, { lat: at(335, 0).lat, lon: at(335, 0).lon }, 5000, STOPS);
    const rows = priceRoute(b, ring, tables, STOPS, new Set([2]), 5000, 0.5);
    expect(rows.filter((r) => r.stopId === 2).length).toBe(2);
    const [a, c] = rows.filter((r) => r.stopId === 2).sort((x, y) => x.occurrence - y.occurrence);
    expect(c!.eta).toBeGreaterThan(a!.eta + 500);
    expect(c!.stopsAhead).toBe(a!.stopsAhead + 4);
  });

  it("is deterministic: the same belief prices to the same numbers", () => {
    const { ring, tables } = setup();
    let b = stepBelief(undefined, ring, { lat: at(300, 0).lat, lon: at(300, 0).lon }, 0, STOPS);
    b = stepBelief(b, ring, { lat: at(335, 0).lat, lon: at(335, 0).lon }, 5000, STOPS);
    const a = priceRoute(b, ring, tables, STOPS, new Set([2, 3, 4]), 5000, 0.5);
    const c = priceRoute(b, ring, tables, STOPS, new Set([2, 3, 4]), 5000, 0.5);
    expect(c).toEqual(a);
    expect(K).toBe(256);
  });
});

describe("arrival: a rest hidden inside a hop", () => {
  // Leg 3 -> 4 (900 m) measured at 128 s + 700 s: a yard rest off every
  // stop, as Blue West's last hop (960 s for 1,044 m against 167 s of driving).
  const spm = [0.11, 0.12, 0.13, 0.135, 0.142, 0.15, 0.16, 0.175, 0.2, 0.25];
  const SEGS_YARD = {
    ...SEGS,
    "3-4": { avg: 840, sd: 200, n: 50, drive: 828, driveN: 50, dq: dq(128).map((x) => x + 700), dqn: 50 },
    [PACE_KEY]: { avg: 0, sd: 0, n: 0, spm, spmN: 500 },
  };
  function setupYard(): { ring: Ring; tables: RouteTables } {
    const ring = buildRing("y", PATH, STOPS, COORDS)!;
    return { ring, tables: buildTables(STOPS, COORDS, SEGS_YARD, DWELLS, ring) };
  }

  it("is the excess of the measured drive over the free-flow drive, and only where it is a layover's length", () => {
    const { tables } = setupYard();
    expect(tables.hops[0]!.hidden).toBeNull();
    expect(tables.hops[1]!.hidden).toBeNull();
    const h = tables.hops[2]!.hidden!;
    expect(h).not.toBeNull();
    expect(Math.abs(quantile(h, 0.5) - 700)).toBeLessThan(60);
    expect(hiddenRest(fromQuantiles(dq(200)), fromQuantiles(dq(128)))).toBeNull();
  });

  it("prices a bus holding mid-leg as that rest continuing plus the free-flow drive left", () => {
    const { ring, tables } = setupYard();
    const yard = at(450, 450); // mid-leg on 3 -> 4, 450 m from either stop
    const t0 = 1_000_000;
    const since = new Date(t0 - 600_000).toISOString().replace("Z", "");
    let b: Belief | undefined;
    for (let k = 0; k <= 12; k++) b = stepBelief(b, ring, { lat: yard.lat, lon: yard.lon, stationary_since: since }, t0 + k * 5000, STOPS);
    const now = t0 + 60_000;
    const row = priceRoute(b!, ring, tables, STOPS, new Set([4]), now, 0.5).find((r) => r.stopId === 4 && r.occurrence === 0)!;
    expect(row.standingAt).toBe(-1);
    const hop = tables.hops[2]!;
    const expected = residual(hop.hidden!, 660)(0.5) + quantile(hop.free!, 0.5) * 0.5;
    const asDriveFraction = quantile(hop.drive, 0.5) * 0.5;
    expect(Math.abs(row.eta - expected)).toBeLessThan(25);
    // ...and not as half of a fourteen-minute "drive".
    expect(Math.abs(row.eta - asDriveFraction)).toBeGreaterThan(60);
  });
});
