import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cdf, fromQuantiles, quantile, residual, type Dist } from "./dist";
import { stepBelief, type Belief } from "./filter";
import { buildRing, type Ring } from "./ring";
import { buildTables, hiddenRest, PACE_KEY, type RouteTables } from "./tables";
import { ceilingArmsOnStanding, K, priceRoute, setCeilingArmsOnStanding, setClampTrace, type ClampEvent, type Floors } from "./arrival";
import { LEAD_SWITCH_MASS } from "./filter";
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

  it("the departure poll moves the number to the drive, and the next poll finishes it", () => {
    const { ring, tables } = setup();
    let now = 300_000;
    let b = stepBelief(undefined, ring, standAt1(0), now - 30_000, STOPS);
    for (let t = 1; t <= 6; t++) b = stepBelief(b, ring, standAt1(0), now - 30_000 + t * 5000, STOPS);
    const before = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5).find((r) => r.stopId === 2 && r.occurrence === 0)!;
    // Departure: a fresh fix 35 m on, no server clock any more.
    now += 5000;
    b = stepBelief(b, ring, { lat: at(35, 0).lat, lon: at(35, 0).lon }, now, STOPS);
    const dep = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5).find((r) => r.stopId === 2 && r.occurrence === 0)!;
    expect(dep.eta).toBeLessThan(before.eta - 60);
    expect(dep.eta).toBeLessThan(quantile(tables.hops[0]!.drive, 0.9) + 5);
    now += 5000;
    b = stepBelief(b, ring, { lat: at(70, 0).lat, lon: at(70, 0).lon }, now, STOPS);
    const after = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5).find((r) => r.stopId === 2 && r.occurrence === 0)!;
    expect(after.eta).toBeLessThan(dep.eta);
    // After the second fresh fix 0.87 has left (measured), so q90 still reads
    // the standing branch; the third settles it (0.95) and the range collapses.
    now += 5000;
    b = stepBelief(b, ring, { lat: at(105, 0).lat, lon: at(105, 0).lon }, now, STOPS);
    const third = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5).find((r) => r.stopId === 2 && r.occurrence === 0)!;
    expect(third.high - third.low).toBeLessThan(110); // the drive's own q10-q90 spread is ~90 s at this fraction
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
    // Departure releases it: the number drops to the drive.
    const now = t0 + 705_000;
    b = stepBelief(b, ring, { lat: at(35, 0).lat, lon: at(35, 0).lon }, now, STOPS);
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

describe("departNow — the drive floor the display had been reconstructing", () => {
  it("is the same chain with the stand in progress ended, and equals eta for a moving bus", () => {
    const { ring, tables } = setup();
    let b = stepBelief(undefined, ring, { lat: at(35, 0).lat, lon: at(35, 0).lon }, 0, STOPS);
    b = stepBelief(b, ring, { lat: at(70, 0).lat, lon: at(70, 0).lon }, 5000, STOPS);
    b = stepBelief(b, ring, { lat: at(105, 0).lat, lon: at(105, 0).lon }, 10_000, STOPS);
    const row = priceRoute(b, ring, tables, STOPS, new Set([3]), 10_000, 0.5)
      .find((r) => r.stopId === 3 && r.occurrence === 0)!;
    // Nothing is resting, so there is no rest to end: the floor IS the number.
    expect(row.standingAt).toBe(-1);
    expect(row.departNow).toBe(row.eta);
  });

  it("drops exactly the residual stand, and is the drive alone at the next stop", () => {
    const { ring, tables } = setup();
    const now = 300_000; // 300 s into stop 1's 400-ish second layover
    let b = stepBelief(undefined, ring, standAt1(0), now - 30_000, STOPS);
    for (let t = 1; t <= 6; t++) b = stepBelief(b, ring, standAt1(0), now - 30_000 + t * 5000, STOPS);
    const row = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5)
      .find((r) => r.stopId === 2 && r.occurrence === 0)!;
    expect(row.standingAt).toBe(0);
    // One hop on, the chain past the stand is the drive out of stop 1 and
    // nothing else, so the floor is that drive's own median.
    const drive = quantile(tables.hops[0]!.drive, 0.5);
    expect(Math.abs(row.departNow - drive)).toBeLessThan(12);
    // And it is what the price is MISSING once the stand ends: the residual.
    const rest = residual(tables.stops[0]!.stand, 300);
    expect(Math.abs((row.eta - row.departNow) - rest(0.5))).toBeLessThan(15);
  });

  it("does not fall with the clamp — a drive is not standing time", () => {
    // #119 holds the shown number down while the conditional stand climbs.
    // The drive underneath does not move, and the floor must not move with it:
    // that is precisely how the display's subtraction lost the drive term.
    const { ring, tables } = setup();
    const floors: Floors = { map: new Map() };
    let b: Belief | undefined;
    const seen: { eta: number; departNow: number }[] = [];
    for (let r = 30; r <= 700; r += 5) {
      const now = r * 1000;
      b = stepBelief(b, ring, standAt1(0), now, STOPS);
      const row = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5, floors)
        .find((x) => x.stopId === 2 && x.occurrence === 0);
      if (row) seen.push({ eta: row.eta, departNow: row.departNow });
    }
    expect(seen.length).toBeGreaterThan(50);
    const floor = seen.map((s) => s.departNow);
    const drive = quantile(tables.hops[0]!.drive, 0.5);
    // Flat, at the drive, for the whole stand — while `eta` is clamped and
    // walks downward around it.
    for (const f of floor) expect(Math.abs(f - drive)).toBeLessThan(15);
    expect(Math.min(...seen.map((s) => s.eta))).toBeLessThan(Math.max(...floor) + 200);
  });
});

describe("the band's floor (lowFloor) — the rest-less chain at the band's own quantile", () => {
  it("is the band's own low end while nothing rests", () => {
    const { ring, tables } = setup();
    let b = stepBelief(undefined, ring, { lat: at(35, 0).lat, lon: at(35, 0).lon }, 0, STOPS);
    b = stepBelief(b, ring, { lat: at(70, 0).lat, lon: at(70, 0).lon }, 5000, STOPS);
    b = stepBelief(b, ring, { lat: at(105, 0).lat, lon: at(105, 0).lon }, 10_000, STOPS);
    const row = priceRoute(b, ring, tables, STOPS, new Set([3]), 10_000, 0.5)
      .find((r) => r.stopId === 3 && r.occurrence === 0)!;
    expect(row.standingAt).toBe(-1);
    expect(row.lowFloor).toBe(row.low);
    expect(row.low).toBeLessThanOrEqual(row.eta);
  });

  it("is the drive's own q10 one hop past a stand, under departNow, and never above the shown number", () => {
    // The rest-less chain's q10 is a floor on a q10 IN THE MODEL: the lead
    // chain is that chain plus a non-negative residual, sample for sample. It
    // is served so the replay can score it against the world (arrival.ts
    // `lowFloor` records why it is not enforced).
    const { ring, tables } = setup();
    const floors: Floors = { map: new Map() };
    let b: Belief | undefined;
    const q10 = quantile(tables.hops[0]!.drive, 0.1);
    let rows = 0;
    for (let r = 30; r <= 700; r += 5) {
      const now = r * 1000;
      b = stepBelief(b, ring, standAt1(0), now, STOPS);
      const row = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5, floors)
        .find((x) => x.stopId === 2 && x.occurrence === 0);
      if (!row) continue;
      rows++;
      expect(row.standingAt).toBe(0);
      expect(Math.abs(row.lowFloor - q10)).toBeLessThan(15);
      // Reported, not applied: `low` may sit under it (the measurement in
      // its docstring is why), but the band still contains the shown number.
      expect(row.low).toBeLessThanOrEqual(row.eta + 1e-9);
      expect(row.lowFloor).toBeLessThanOrEqual(row.eta + 1e-9);
      // The floor is a q10, not the median: it sits under `departNow`.
      expect(row.lowFloor).toBeLessThanOrEqual(row.departNow + 1e-9);
    }
    expect(rows).toBeGreaterThan(50);
  });
});

describe("the ceiling arms on the standing hypothesis, not the mixture (2026-09-11)", () => {
  // The variant is what this block measures, so arm it per test — and leave
  // the module on the SHIPPED default, so nothing that runs later in this file
  // can read an armed switch as the default.
  beforeEach(() => { setCeilingArmsOnStanding(true); });
  afterEach(() => { setCeilingArmsOnStanding(false); setClampTrace(null); });

  /**
   * A bus driving down the 4 -> 1 leg on fresh fixes and then repeating its fix
   * at the marker with no server clock. `stepM` is the approach speed, which is
   * what decides how much moving mass survives the arrival poll: at 35 m a poll
   * the belief is already ~0.85 standing when the bus reaches the stop (the
   * MEDIAN production rest — measured, the standing mass clears the gate on the
   * arrival poll itself for 53% of Red rests >= 60 s), and at 70 m a poll it is
   * not, which is the other half. Each poll is returned with the clamp decision
   * taken on it, so an assertion can never drift out of alignment with the
   * series the way an index into a slice can.
   */
  function arrive(ring: Ring, tables: RouteTables, standPolls: number, stepM = 35) {
    const floors: Floors = { map: new Map() };
    const evs: ClampEvent[] = [];
    setClampTrace((e) => { if (e.occurrence === 0 && e.stopIdx === 1) evs.push(e); });
    const polls: { ev?: ClampEvent; shown: number; standing: boolean }[] = [];
    let b: Belief | undefined;
    let now = 0;
    const price = (standing: boolean) => {
      const before = evs.length;
      const row = priceRoute(b!, ring, tables, STOPS, new Set([2]), now, 0.5, floors).find((x) => x.stopId === 2 && x.occurrence === 0);
      if (row) polls.push({ ev: evs.length > before ? evs[evs.length - 1] : undefined, shown: row.eta, standing });
    };
    for (let y = 9 * stepM; y >= 0; y -= stepM) {
      now += 5000;
      b = stepBelief(b, ring, { lat: at(0, y).lat, lon: at(0, y).lon }, now, STOPS);
      price(false);
    }
    for (let i = 0; i < standPolls; i++) {
      now += 5000;
      b = stepBelief(b, ring, { lat: at(0, 0).lat, lon: at(0, 0).lon }, now, STOPS);
      price(true);
    }
    setClampTrace(null);
    return { polls, evs, floors, belief: b!, now };
  }
  const rises = (xs: number[]) => xs.slice(1).filter((x, i) => x > xs[i]! + 1e-6).length;
  const standing = (r: { polls: { shown: number; standing: boolean }[] }) => r.polls.filter((p) => p.standing).map((p) => p.shown);

  it("where the mass clears the gate on the arrival poll, master arms from the mixture and the variant from the standing hypothesis", () => {
    const { ring, tables } = setup();
    setCeilingArmsOnStanding(false);
    const m = arrive(ring, tables, 20);
    setCeilingArmsOnStanding(true);
    const v = arrive(ring, tables, 20);
    const mArm = m.polls.find((p) => p.ev)!, vArm = v.polls.find((p) => p.ev)!;
    // Both arm on the same poll: this fixture is already past the gate there.
    expect(mArm.ev!.action).toBe("arm");
    expect(vArm.ev!.action).toBe("arm");
    expect(vArm.ev!.standMass).toBeGreaterThanOrEqual(LEAD_SWITCH_MASS);
    // Master's ceiling IS the mixture; the variant's is the standing variant's
    // own quantile, which is higher by what the moving half of the mixture cost.
    expect(Math.abs(mArm.shown - mArm.ev!.mixture)).toBeLessThan(1e-6);
    expect(Math.abs(vArm.shown - vArm.ev!.standing)).toBeLessThan(1e-6);
    expect(vArm.shown).toBeGreaterThan(mArm.shown + 20);
    // The rider-visible invariant #119 exists for: neither arm ever climbs.
    expect(rises(standing(m))).toBe(0);
    expect(rises(standing(v))).toBe(0);
  });

  it("below the gate the entry is written provisional, and re-arms exactly once — the poll the mass clears", () => {
    const { ring, tables } = setup();
    const v = arrive(ring, tables, 20, 70);
    const prov = v.evs.filter((e) => e.action === "provisional");
    expect(prov.length).toBeGreaterThan(0);
    for (const e of prov) expect(e.standMass).toBeLessThan(LEAD_SWITCH_MASS);
    const rearms = v.evs.filter((e) => e.action === "rearm");
    expect(rearms.length).toBe(1);
    expect(rearms[0]!.standMass).toBeGreaterThanOrEqual(LEAD_SWITCH_MASS);
    // A provisional entry holds the number exactly as master's ceiling does,
    // so the one rise a stand may show is the arming and nothing else.
    expect(rises(standing(v))).toBeLessThanOrEqual(1);
  });

  it("the variant never shows less than master while the bus stands, and both land on the same number as the rest runs out", () => {
    const { ring, tables } = setup();
    setCeilingArmsOnStanding(false);
    const m = arrive(ring, tables, 20);
    setCeilingArmsOnStanding(true);
    const v = arrive(ring, tables, 20);
    expect(v.polls.length).toBe(m.polls.length);
    for (let i = 0; i < m.polls.length; i++) expect(v.polls[i]!.shown).toBeGreaterThanOrEqual(m.polls[i]!.shown - 1e-6);
    // Before the stand the two are byte-identical.
    const pre = m.polls.filter((p) => !p.standing).length - 1;
    for (let i = 0; i < pre; i++) expect(v.polls[i]!.shown).toBe(m.polls[i]!.shown);
    // The gap is the arming, not a permanent offset: the conditional residual
    // converges as the stand outlives its own table.
    const mv = standing(m), vv = standing(v);
    expect(Math.abs(vv.at(-1)! - mv.at(-1)!)).toBeLessThan(1);
  });

  it("arms once per rest identity and holds it flat through a longer stand", () => {
    const { ring, tables } = setup();
    const v = arrive(ring, tables, 140);
    expect(v.evs.filter((e) => e.action === "rearm" || e.action === "arm").length).toBe(1);
    expect(rises(standing(v))).toBeLessThanOrEqual(1);
    // Never reads "now" for a bus still standing: it decays, it does not run out.
    for (const x of standing(v)) expect(x).toBeGreaterThan(quantile(tables.hops[0]!.drive, 0.5) - 1);
  });

  it("departure still collapses on the poll it is seen", () => {
    const { ring, tables } = setup();
    const r = arrive(ring, tables, 60);
    const before = standing(r).at(-1)!;
    const floors: Floors = { map: new Map() };
    // Re-price the last standing poll into fresh floors so the ceiling is armed here too.
    priceRoute(r.belief, ring, tables, STOPS, new Set([2]), r.now, 0.5, floors);
    const now = r.now + 5000;
    const b = stepBelief(r.belief, ring, { lat: at(35, 0).lat, lon: at(35, 0).lon }, now, STOPS);
    const dep = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5, floors).find((x) => x.stopId === 2 && x.occurrence === 0)!;
    expect(dep.standingAt).toBe(-1);
    expect(dep.eta).toBeLessThan(before - 60);
    expect(dep.eta).toBeLessThan(quantile(tables.hops[0]!.drive, 0.9) + 5);
  });

  it("with the switch off the rule is master's: armed from the mixture, and no entry is ever provisional", () => {
    const { ring, tables } = setup();
    setCeilingArmsOnStanding(false);
    const r = arrive(ring, tables, 10);
    expect(r.evs[0]!.action).toBe("arm");
    expect(r.evs.filter((e) => e.action === "provisional" || e.action === "rearm").length).toBe(0);
    for (const v of r.floors.map.values()) expect(v.armed).toBe(true);
  });
});

/**
 * THE INSTRUMENT'S COST (review, 2026-09-12). This branch is a measured
 * negative result, kept for the next attempt — so the one thing it may not do
 * is cost the fleet anything. With `armOnStanding` off and no clamp trace set
 * (production, permanently) `priceRoute` allocates nothing extra per row and
 * must price every row by master's rule, the running `min(ceiling, mixture)`
 * over one rest identity. Captured at IMPORT time so no test ordering can make
 * the default assertion pass.
 */
const DEFAULT_ARMS_ON_STANDING = ceilingArmsOnStanding();

describe("the refused experiment is off by default, and costs nothing when it is (2026-09-12)", () => {
  afterEach(() => { setCeilingArmsOnStanding(false); setClampTrace(null); });

  /**
   * The 4 -> 1 leg driven in on fresh fixes, then a stand at the marker. Each
   * poll is priced TWICE: once into a throwaway `Floors` (no held entry, so
   * master's else-branch runs and the number IS the mixture — the raw one), and
   * once into the running floors. The pair is what makes "master's rule" a
   * measurement rather than a reading of the source.
   */
  function series(ring: Ring, tables: RouteTables, standPolls: number, trace: boolean) {
    const floors: Floors = { map: new Map() };
    if (trace) setClampTrace(() => {});
    const out: { shown: number; raw: number; standingAt: number }[] = [];
    let b: Belief | undefined;
    let now = 0;
    const poll = (pos: LatLon) => {
      now += 5000;
      b = stepBelief(b, ring, { lat: pos.lat, lon: pos.lon }, now, STOPS);
      const raw = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5, { map: new Map() }).find((x) => x.stopId === 2 && x.occurrence === 0);
      const row = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5, floors).find((x) => x.stopId === 2 && x.occurrence === 0);
      if (row && raw) out.push({ shown: row.eta, raw: raw.eta, standingAt: row.standingAt });
    };
    for (let y = 9 * 35; y >= 0; y -= 35) poll(at(0, y));
    for (let i = 0; i < standPolls; i++) poll(at(0, 0));
    setClampTrace(null);
    return { rows: out, floors };
  }

  it("is off by default, so every other caller prices exactly as before", () => {
    expect(DEFAULT_ARMS_ON_STANDING).toBe(false);
  });

  it("with the switch off every row is master's rule exactly: min(ceiling, mixture), and nothing is ever provisional", () => {
    const { ring, tables } = setup();
    setCeilingArmsOnStanding(false);
    const { rows, floors } = series(ring, tables, 30, false);
    expect(rows.length).toBeGreaterThan(30);
    let clamped = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (Math.abs(r.shown - r.raw) < 1e-9) continue; // no ceiling in force, or it did not bind
      // The only other thing the shown number may be is the running minimum
      // over this rest — master's `min(prev, eta)`, and never a rise.
      expect(i).toBeGreaterThan(0);
      expect(r.shown).toBeCloseTo(Math.min(rows[i - 1]!.shown, r.raw), 9);
      expect(r.shown).toBeLessThan(r.raw);
      clamped++;
    }
    // The path was really exercised: this stand does bind the ceiling.
    expect(clamped).toBeGreaterThan(5);
    // Every entry armed, so none of them can re-arm on a later poll.
    for (const v of floors.map.values()) expect(v.armed).toBe(true);
  });

  it("setting the clamp trace changes no number — it is an observation, not a rule", () => {
    const { ring, tables } = setup();
    setCeilingArmsOnStanding(false);
    const off = series(ring, tables, 30, false).rows;
    const on = series(ring, tables, 30, true).rows;
    expect(on.length).toBe(off.length);
    for (let i = 0; i < off.length; i++) expect(on[i]!.shown).toBe(off[i]!.shown);
  });
});
