import { describe, expect, it } from "vitest";
import { priceRoute } from "./arrival";
import { fromQuantiles, median, residual, scaled } from "./dist";
import { stepBelief, type Belief } from "./filter";
import { LAP_BAND_HI, LAP_BAND_LO, LAP_F_MAX, LAP_F_MIN, LAP_SHRINK_K, lapFactor, lapFitOf } from "./lap";
import { buildRing, type Ring } from "./ring";
import { buildTables, type DwellLike, type RouteTables } from "./tables";
import type { LatLon } from "../geo";

// The same rectangular loop arrival.test.ts uses: stop 1 is the layover and
// carries 344 Winchester's real served vector.
const LAT0 = 41.31, LON0 = -72.93;
const mLat = 1 / 111_195, mLon = 1 / 83_500;
function at(xm: number, ym: number): LatLon { return { lat: LAT0 + ym * mLat, lon: LON0 + xm * mLon }; }
const corners = [at(0, 0), at(900, 0), at(900, 450), at(0, 450)];
const STOPS = [1, 2, 3, 4];
const COORDS: Record<number, LatLon> = { 1: corners[0]!, 2: corners[1]!, 3: corners[2]!, 4: corners[3]! };
const PATH: [number, number][] = [...corners, corners[0]!].map((c) => [c.lat, c.lon]);
const Q11 = [83, 129, 145, 191, 288, 333, 437, 473, 543, 674];
const ORD = [0, 12, 15, 18, 22, 26, 31, 40, 55, 90];
function dq(sec: number): number[] { return [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2, 1.35, 1.6].map((f) => Math.round(sec * f)); }
const SEGS = {
  "1-2": { avg: 140, sd: 20, n: 50, drive: 128, driveN: 50, dq: dq(128), dqn: 50 },
  "2-3": { avg: 70, sd: 10, n: 50, drive: 64, driveN: 50, dq: dq(64), dqn: 50 },
  "3-4": { avg: 140, sd: 20, n: 50, drive: 128, driveN: 50, dq: dq(128), dqn: 50 },
  "4-1": { avg: 70, sd: 10, n: 50, drive: 64, driveN: 50, dq: dq(64), dqn: 50 },
};
const PLAIN: Record<string, DwellLike> = {
  "1": { med: 400, sd: 200, n: 50, q: Q11, qn: 50 } as DwellLike,
  "2": { med: 30, sd: 20, n: 50, q: ORD, qn: 50 } as DwellLike,
  "3": { med: 30, sd: 20, n: 50, q: ORD, qn: 50 } as DwellLike,
  "4": { med: 30, sd: 20, n: 50, q: ORD, qn: 50 } as DwellLike,
};
// 344 Winchester's own 90-day fit: slope -0.49 s of stand per second of lap on
// a 536 s median, i.e. -8.9e-4 as a fraction; reference lap 50.1 min.
const FIT = { lapB: -8.89e-4, lapM: 3006, lapN: 1667 };
const FITTED: Record<string, DwellLike> = { ...PLAIN, "1": { ...PLAIN["1"]!, ...FIT } };

function build(dwells: Record<string, DwellLike>): { ring: Ring; tables: RouteTables } {
  const ring = buildRing("t", PATH, STOPS, COORDS)!;
  return { ring, tables: buildTables(STOPS, COORDS, SEGS, dwells) };
}
const since = (ms: number) => new Date(ms).toISOString().replace("Z", "");

/** A belief for a bus that has been standing at stop 1 for `r` seconds at `now`. */
function standing(ring: Ring, now: number, r: number): Belief {
  let b: Belief | undefined;
  const fix = { lat: corners[0]!.lat, lon: corners[0]!.lon, stationary_since: since(now - r * 1000) };
  for (let t = now - r * 1000; t <= now; t += 15_000) b = stepBelief(b, ring, fix, t, STOPS);
  return stepBelief(b, ring, fix, now, STOPS);
}

/** A belief for a bus `ym` metres SHORT of stop 1 on leg 3 (stop 4 -> stop 1), moving. */
function approaching1(ring: Ring, now: number, ym: number): Belief {
  let b: Belief | undefined;
  for (let i = 4; i >= 0; i--) {
    const p = at(0, Math.min(450, ym + i * 30));
    b = stepBelief(b, ring, { lat: p.lat, lon: p.lon }, now - i * 5000, STOPS);
  }
  return b!;
}

/** A belief for a bus `xm` metres along leg 0 (stop 1 -> stop 2), moving. */
function movingAt(ring: Ring, now: number, xm: number): Belief {
  let b: Belief | undefined;
  for (let i = 4; i >= 0; i--) {
    const p = at(Math.max(0, xm - i * 35), 0);
    b = stepBelief(b, ring, { lat: p.lat, lon: p.lon }, now - i * 5000, STOPS);
  }
  return b!;
}

const etaTo = (ring: Ring, tables: RouteTables, b: Belief, stop: number, now: number, lap?: Record<number, number>) =>
  priceRoute(b, ring, tables, STOPS, new Set([stop]), now, 0.5, undefined, lap)
    .find((r) => r.stopId === stop && r.occurrence === 0)!.eta;

describe("lapFactor", () => {
  it("is exactly 1 with no fit, no lap, or a gap that is not a lap", () => {
    const fit = lapFitOf(FIT)!;
    expect(lapFactor(null, 3000)).toBe(1);
    expect(lapFactor(fit, null)).toBe(1);
    expect(lapFactor(fit, undefined)).toBe(1);
    // The five overnight "laps" that flipped the sign of the correlation: a
    // bus back from the depot carries no slack and must not be corrected.
    expect(lapFactor(fit, 7084 * 60)).toBe(1);
    expect(lapFactor(fit, FIT.lapM * (LAP_BAND_HI + 0.01))).toBe(1);
    expect(lapFactor(fit, FIT.lapM * (LAP_BAND_LO - 0.01))).toBe(1);
    expect(lapFactor(fit, FIT.lapM * LAP_BAND_LO)).toBeGreaterThan(1);
  });

  it("runs the right way and is clamped", () => {
    const fit = lapFitOf(FIT)!;
    // An EARLY bus (short lap) stands longer; a late one turns straight round.
    expect(lapFactor(fit, FIT.lapM - 600)).toBeGreaterThan(1.4);
    expect(lapFactor(fit, FIT.lapM + 600)).toBeLessThan(0.6);
    expect(lapFactor(fit, FIT.lapM)).toBeCloseTo(1, 6);
    for (const lap of [1804, 2000, 2500, 3006, 3500, 4000, 5000]) {
      const f = lapFactor(fit, lap);
      expect(f).toBeGreaterThanOrEqual(LAP_F_MIN);
      expect(f).toBeLessThanOrEqual(LAP_F_MAX);
    }
  });

  it("degrades to 1 on a thin cell, and shrinks by n/(n+k)", () => {
    expect(lapFitOf({ ...FIT, lapN: 10 })).toBeNull();
    const thin = lapFitOf({ ...FIT, lapN: 60 })!;
    const fat = lapFitOf(FIT)!;
    const dThin = Math.abs(lapFactor(thin, FIT.lapM - 600) - 1);
    const dFat = Math.abs(lapFactor(fat, FIT.lapM - 600) - 1);
    expect(dThin).toBeLessThan(dFat);
    expect(dThin / dFat).toBeCloseTo((60 / (60 + LAP_SHRINK_K)) / (1667 / (1667 + LAP_SHRINK_K)), 6);
    expect(lapFitOf(PLAIN["2"] as never)).toBeNull();
  });
});

describe("the lap correction in the chain", () => {
  it("is byte-identical when the payload carries no fit and when it carries no ages", () => {
    const plain = build(PLAIN), fitted = build(FITTED);
    const now = 1_700_000_000_000;
    const ages = { 1: 2200 };
    for (const ym of [450, 300, 120, 0]) {
      const a = etaTo(plain.ring, plain.tables, approaching1(plain.ring, now, ym), 2, now, ages);
      const b = etaTo(plain.ring, plain.tables, approaching1(plain.ring, now, ym), 2, now, undefined);
      const c = etaTo(fitted.ring, fitted.tables, approaching1(fitted.ring, now, ym), 2, now, undefined);
      expect(a).toBe(b);
      expect(c).toBe(b);
    }
    for (const r of [0, 120, 400]) {
      const a = etaTo(plain.ring, plain.tables, standing(plain.ring, now, r), 2, now, ages);
      const b = etaTo(plain.ring, plain.tables, standing(plain.ring, now, r), 2, now, undefined);
      const c = etaTo(fitted.ring, fitted.tables, standing(fitted.ring, now, r), 2, now, undefined);
      expect(a).toBe(b);
      expect(c).toBe(b);
    }
  });

  it("prices a stop BEYOND the layover with the corrected stand, before the bus gets there", () => {
    const { ring, tables } = build(FITTED);
    const now = 1_700_000_000_000;
    // 300 m short of stop 1 on leg 3, so stop 1's stand is still ahead and
    // stop 2 is on the far side of it.
    const b = approaching1(ring, now, 300);
    const toStop1 = etaTo(ring, tables, b, 1, now);
    const flat = etaTo(ring, tables, b, 2, now);
    // An EARLY bus (a short lap when it gets there) is promised a LONGER stand,
    // so a rider past stop 1 waits longer; a late one, less.
    const early = etaTo(ring, tables, b, 2, now, { 1: 3006 - 900 - Math.round(toStop1) });
    const late = etaTo(ring, tables, b, 2, now, { 1: 3006 + 900 - Math.round(toStop1) });
    expect(early).toBeGreaterThan(flat + 200);
    expect(late).toBeLessThan(flat - 150);
    // Stop 1 itself is reached BEFORE its own stand, so its own ETA does not move.
    expect(etaTo(ring, tables, b, 1, now, { 1: 3006 - 900 - Math.round(toStop1) })).toBeCloseTo(toStop1, 6);
  });

  it("arrives CONTINUOUSLY over an approach — the difference from PR #184", () => {
    const { ring, tables } = build(FITTED);
    const plain = build(PLAIN);
    const now0 = 1_700_000_000_000;
    // ONE belief, stepped over a 450 m approach to the layover. #184 read its
    // covariate once, for the stop the bus already stood at, so the whole
    // correction landed in a single poll (|slot - pooled| median 204 s at
    // Winchester) and it fixed 3 jumps >= 180 s while introducing 43. Here the
    // correction is in the chain the entire approach, and what it adds moves
    // by seconds a poll.
    const arriveAge = 2200;
    const A = 24;
    let bf: Belief | undefined, bp: Belief | undefined;
    const gap: number[] = [], ratio: number[] = [];
    for (let i = A; i >= 1; i--) {
      const t = now0 - i * 5000;
      const p = at(0, (i / A) * 450);
      const fix = { lat: p.lat, lon: p.lon };
      bf = stepBelief(bf, ring, fix, t, STOPS);
      bp = stepBelief(bp, plain.ring, fix, t, STOPS);
      const a = etaTo(ring, tables, bf, 2, t, { 1: arriveAge - i * 5 });
      const b = etaTo(plain.ring, plain.tables, bp, 2, t);
      gap.push(a - b);
      ratio.push(a / b);
    }
    // The first two polls are a COLD belief finding the bus at all, which is
    // not what this measures; from the third the approach is settled.
    const settled = gap.slice(2), rs = ratio.slice(2);
    // It is worth minutes the whole way in, not only once the bus is there.
    expect(Math.min(...settled)).toBeGreaterThan(120);
    // The correction is MULTIPLICATIVE, so what has to be steady across the
    // approach is the ratio: the absolute gap shrinks honestly as the stand
    // itself is consumed. Steady to a few per cent, poll to poll and end to
    // end — there is nothing left to land when the bus arrives.
    expect(Math.abs(rs[0]! - rs[rs.length - 1]!)).toBeLessThan(0.1);
    // Measured 0.071, and it falls on the ONE poll where the chain hands over
    // from the whole stand to its residual — the same poll on which the
    // uncorrected arm itself moves 97 s. Everywhere else it is under 0.02.
    expect(Math.max(...rs.slice(1).map((x, i) => Math.abs(x - rs[i]!)))).toBeLessThan(0.08);
  });

  it("keeps the correction across a departure while the served lap clock still lags (Blue Night 9/6)", () => {
    // The served age counts from the collector's departure event, which fires
    // a poll or more after the belief releases the rest. In that window the
    // stop being left still carries the PREVIOUS lap's departure — a lap and
    // a stand old — so a future visit to it (the second slot on a one-bus
    // line) is priced under twice a lap, out of band, and the correction on
    // that stand vanishes for the departure polls and comes back when the
    // clock resets: 333 Cedar read "then 66 | 62 | 61 | 62 | 66 min" across
    // the departure (docs/stand-lap-covariate.md section 6b). The belief has
    // seen the departure; a served departure older than the rest is not it.
    // A fit sized to this ring's ~480 s nominal loop: reference lap 580 s,
    // -0.5 % of the stand per second, band [377, 957] s. A stale age (a lap
    // and a stand old) puts the next visit at ~1,275 s — out of band.
    const { ring, tables } = build({ ...PLAIN, "1": { ...PLAIN["1"]!, lapB: -5e-3, lapM: 580, lapN: 1667 } });
    const plain = build(PLAIN);
    const now0 = 1_700_000_000_000;
    const L = 380, r = 400;
    const occ1 = (b: Belief, bp: Belief, t: number, ages?: Record<number, number>) => {
      const f = priceRoute(b, ring, tables, STOPS, new Set([2]), t, 0.5, undefined, ages).find((x) => x.stopId === 2 && x.occurrence === 1)!;
      const p = priceRoute(bp, plain.ring, plain.tables, STOPS, new Set([2]), t, 0.5, undefined, undefined).find((x) => x.stopId === 2 && x.occurrence === 1)!;
      return f.eta - p.eta;
    };
    // Standing at stop 1 for r seconds — a NEW observation object each poll,
    // since `stepBelief` treats the same object as the same poll — so the
    // rest is established by the repeated fix and attributed to stop 1. The
    // served clock says the bus left stop 1 a lap + r ago (its PREVIOUS
    // departure).
    const stood = (rg: Ring): Belief => {
      let b: Belief | undefined;
      for (let t = now0 - r * 1000; t <= now0; t += 15_000) {
        b = stepBelief(b, rg, { lat: corners[0]!.lat, lon: corners[0]!.lon, stationary_since: since(now0 - r * 1000) }, t, STOPS);
      }
      return b!;
    };
    let bf = stood(ring), bp = stood(plain.ring);
    expect(bf.rested).toBe(true);
    expect(bf.restStop).toBe(0);
    expect(occ1(bf, bp, now0, { 1: L + r })).toBeGreaterThan(120);
    // The departure poll: a fresh fix 100 m out on leg 0 — inside the rest
    // radius, so the rest is still HELD, but the lead is now the moving
    // variant. The served age has not reset.
    const t0 = now0 + 10_000;
    for (const [xm, dt] of [[45, 5_000], [100, 10_000]] as const) {
      const f0 = at(xm, 0);
      bf = stepBelief(bf, ring, { lat: f0.lat, lon: f0.lon }, now0 + dt, STOPS);
      bp = stepBelief(bp, plain.ring, { lat: f0.lat, lon: f0.lon }, now0 + dt, STOPS);
    }
    expect(bf.rested).toBe(true);
    expect(bf.restStop).toBe(0);
    const gapHeld = occ1(bf, bp, t0, { 1: L + r + 10 });
    // Next poll: 140 m out, past the rest radius, so the belief releases the
    // rest — and the served age has STILL not reset.
    const t1 = now0 + 15_000;
    const f1 = at(140, 0);
    bf = stepBelief(bf, ring, { lat: f1.lat, lon: f1.lon }, t1, STOPS);
    bp = stepBelief(bp, plain.ring, { lat: f1.lat, lon: f1.lon }, t1, STOPS);
    expect(bf.rested).toBe(false);
    expect(bf.leftStop).toBe(0);
    const gapDeparture = occ1(bf, bp, t1, { 1: L + r + 15 });
    // The defect, for the record: read off the wire alone (no memory of the
    // rest that just ended) the same poll prices the stand uncorrected.
    expect(Math.abs(occ1({ ...bf, leftStop: -1 }, bp, t1, { 1: L + r + 15 }))).toBeLessThan(30);
    // One poll later the collector has fired and the age counts from now.
    const t2 = now0 + 30_000;
    const f2 = at(220, 0);
    bf = stepBelief(bf, ring, { lat: f2.lat, lon: f2.lon }, t2, STOPS);
    bp = stepBelief(bp, plain.ring, { lat: f2.lat, lon: f2.lon }, t2, STOPS);
    const gapNext = occ1(bf, bp, t2, { 1: 20 });
    // A short lap so far -> a longer stand next time, worth minutes in slot 2.
    expect(gapNext).toBeGreaterThan(120);
    // The correction does not step at the departure poll: what it adds there
    // is what it adds a poll later, and what it added while standing.
    expect(Math.abs(gapHeld - gapNext)).toBeLessThan(30);
    expect(Math.abs(gapDeparture - gapNext)).toBeLessThan(30);
    // A served age younger than the rest is the collector's own event and is
    // taken as served: nothing is rewritten.
    expect(occ1(bf, bp, t2, { 1: 20 })).toBe(gapNext);
    // And the stop AHEAD on this lap has no fitted stand before it, so slot 1
    // at the departure poll is priced identically with and without ages.
    const b1 = stepBelief(stood(ring), ring, { lat: f1.lat, lon: f1.lon }, t1, STOPS);
    expect(etaTo(ring, tables, b1, 2, t1, { 1: L + r + 15 })).toBe(etaTo(ring, tables, b1, 2, t1));
  });

  it("does not read a hold on the APPROACH to a stop as a departure from it (Red #310, Union Station)", () => {
    // The seed trusts the belief's rest identity, and the belief attributes a
    // rest short of a layover stop to that stop's approach zone. A hold at a
    // light there is not a visit: read as a departure it declared the served
    // lap stale for the stop the bus was about to serve, and replaced a
    // correct served lap (a long one, f 0.59) with "departed just now" (f 1)
    // — +150 s on the second bus for one poll, 13 reversals introduced on an
    // otherwise byte-identical Red day. Only a rest in the stop's OWN zone
    // is a departure from it.
    const { ring, tables } = build({ ...PLAIN, "1": { ...PLAIN["1"]!, lapB: -5e-3, lapM: 580, lapN: 1667 } });
    const now0 = 1_700_000_000_000;
    let b: Belief | undefined;
    // Approach stop 1 down leg 3, then hold 150 m short of it for a minute.
    for (let i = 6; i >= 1; i--) { const p = at(0, 150 + i * 40); b = stepBelief(b, ring, { lat: p.lat, lon: p.lon }, now0 - 60_000 - i * 5000, STOPS); }
    const hold = at(0, 150);
    for (let t = now0 - 60_000; t <= now0; t += 15_000) b = stepBelief(b, ring, { lat: hold.lat, lon: hold.lon }, t, STOPS);
    expect(b!.rested).toBe(true);
    expect(b!.restStop).toBe(0);
    expect(b!.restApproach).toBe(true);
    // Drive on: a fresh fix 140 m further, at the stop, past the rest radius.
    const t1 = now0 + 10_000;
    const f1 = at(0, 10);
    b = stepBelief(b, ring, { lat: f1.lat, lon: f1.lon }, t1, STOPS);
    expect(b!.rested).toBe(false);
    // The approach hold is NOT recorded as a departure from stop 1 ...
    expect(b!.leftStop).toBe(-1);
    // ... so the stand AHEAD at stop 1 keeps its correction: the served lap
    // (a short one) still prices a longer stand for a rider past it. Had the
    // hold been taken as the departure, the visit 30 s ahead would read as a
    // 30 s lap — out of band, factor 1 — and the correction would vanish.
    const short = 480 - 100;
    const kept = etaTo(ring, tables, b!, 2, t1, { 1: short });
    const flat = etaTo(ring, tables, b!, 2, t1);
    expect(kept).toBeGreaterThan(flat + 120);
    const asDeparture = { ...b!, leftStop: 0, leftSince: now0 - 60_000, leftAt: t1 };
    expect(etaTo(ring, tables, asDeparture, 2, t1, { 1: short })).toBeLessThan(kept - 120);
  });

  it("scales the RESIDUAL of a stand in progress by the identity the code relies on", () => {
    // A stand scaled by f is the variable f x X, so the remaining time given r
    // seconds already stood is f x (X's remainder given r / f). `addResidual`
    // uses that rather than building a scaled distribution, so it must hold
    // exactly — this is the one place the multiplicative form touches the
    // conditional, which is where PR #99's interpolated CDF lives.
    const d = fromQuantiles(Q11);
    for (const f of [0.4, 0.75, 1.25, 1.9]) {
      const sc = scaled(d, f);
      for (const r of [0, 60, 300, 700]) {
        for (const u of [0.1, 0.5, 0.9]) {
          expect(residual(sc, r)(u)).toBeCloseTo(f * residual(d, r / f)(u), 6);
        }
      }
    }
  });
});
