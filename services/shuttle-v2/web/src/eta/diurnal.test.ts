import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { etHourOf } from "../schedule";
import { fromQuantiles, quantile, residualMedian } from "./dist";
import {
  hourFactor, stopModel, STAND_HOUR_SHRINK_K, STAND_HOUR_MAX_FACTOR, STAND_HOUR_MIN_FACTOR,
  type ClassPools, type DwellLike, type StandHourProfile,
} from "./tables";

const NO_POOLS: ClassPools = { layover: null, ordinary: null };

/** 344 Winchester's real served table, 2026-09-08. */
const WINCHESTER: DwellLike = { med: 420.3, n: 17, q: [39, 118, 140, 164, 265, 311, 371, 438, 492, 654], qn: 63, pstop: 0.952 };
const KERB: DwellLike = { med: 60, n: 40, q: [0, 0, 15, 20, 25, 30, 38, 50, 70, 120], qn: 40, pstop: 0.8 };

function profile(over: Partial<StandHourProfile> = {}): StandHourProfile {
  return {
    layover: new Array(24).fill(1),
    ordinary: new Array(24).fill(1),
    layoverN: new Array(24).fill(0),
    ordinaryN: new Array(24).fill(0),
    ...over,
  };
}

describe("the diurnal factor is the server's own, on the server's own clock", () => {
  it("mirrors src/calibrator/diurnal.ts's constants — parsed out of its source", () => {
    const src = readFileSync(new URL("../../../src/calibrator/diurnal.ts", import.meta.url), "utf8");
    const num = (name: string) => {
      const m = src.match(new RegExp(`export const ${name} = ([0-9.]+);`));
      expect(m, `${name} in src/calibrator/diurnal.ts`).toBeTruthy();
      return Number(m![1]);
    };
    expect(STAND_HOUR_SHRINK_K).toBe(num("STAND_HOUR_SHRINK_K"));
    expect(STAND_HOUR_MIN_FACTOR).toBe(num("STAND_HOUR_MIN_FACTOR"));
    expect(STAND_HOUR_MAX_FACTOR).toBe(num("STAND_HOUR_MAX_FACTOR"));
  });

  it("resolves the hour in America/New_York on any device timezone", () => {
    // 2026-09-08 13:30 UTC is 09:30 EDT. The five timezones timezone-check.mjs
    // drives the live site with; the app must name hour 9 in all of them.
    const t = Date.parse("2026-09-08T13:30:00Z");
    // Node resolves the zone from the formatter, not from TZ, so this asserts
    // the property that matters: the answer does not depend on the device.
    expect(etHourOf(new Date(t))).toBe(9);
    // Midnight-adjacent: 03:30 UTC is 23:30 the previous ET day.
    expect(etHourOf(new Date(Date.parse("2026-09-08T03:30:00Z")))).toBe(23);
  });

  it("does not shift by an hour across the DST boundary", () => {
    // 2026-11-01 06:00 UTC is 02:00 EDT; 07:00 UTC is 02:00 EST. Both are the
    // 2 o'clock hour in ET, and the profile must index the same cell.
    expect(etHourOf(new Date(Date.parse("2026-11-01T05:30:00Z")))).toBe(1); // 01:30 EDT
    expect(etHourOf(new Date(Date.parse("2026-11-01T06:30:00Z")))).toBe(1); // 01:30 EST
    // And the spring gap: 2026-03-08 07:00 UTC is 03:00 EDT (02:00 never runs).
    expect(etHourOf(new Date(Date.parse("2026-03-08T07:30:00Z")))).toBe(3);
    // A summer instant and a winter instant at the same ET hour agree.
    expect(etHourOf(new Date(Date.parse("2026-07-01T13:30:00Z")))).toBe(9);   // EDT
    expect(etHourOf(new Date(Date.parse("2026-01-01T14:30:00Z")))).toBe(9);   // EST
  });
});

describe("no data means today's behaviour, exactly", () => {
  it("is byte-identical with no hour context at all", () => {
    const a = stopModel(WINCHESTER, NO_POOLS);
    const b = stopModel(WINCHESTER, NO_POOLS, undefined);
    expect([...b.stand.xs]).toEqual([...a.stand.xs]);
    expect([...b.stand.ps]).toEqual([...a.stand.ps]);
    expect(b.stand.tailHazard).toBe(a.stand.tailHazard);
  });

  it("is byte-identical when the profile has no samples at this hour", () => {
    const base = stopModel(WINCHESTER, NO_POOLS);
    const m = stopModel(WINCHESTER, NO_POOLS, { hour: 9, profile: profile() });
    expect([...m.stand.xs]).toEqual([...base.stand.xs]);
    expect([...m.stand.ps]).toEqual([...base.stand.ps]);
    expect(m.stand.tailHazard).toBe(base.stand.tailHazard);
  });

  it("is byte-identical when the payload carries no profile", () => {
    const base = stopModel(WINCHESTER, NO_POOLS);
    const m = stopModel(WINCHESTER, NO_POOLS, { hour: 9, profile: undefined });
    expect([...m.stand.xs]).toEqual([...base.stand.xs]);
    expect([...m.stand.ps]).toEqual([...base.stand.ps]);
  });

  it("leaves an out-of-range or non-integer hour alone", () => {
    for (const hour of [-1, 24, 9.5, NaN]) {
      expect(hourFactor(WINCHESTER, { hour, profile: profile({ layover: new Array(24).fill(1.4) }) }, true)).toBe(1);
    }
  });
});

describe("a stop with a measured hour prices differently, by the measured amount", () => {
  it("prices 09:00 above 14:00 when the profile says so, in proportion", () => {
    const layover = new Array(24).fill(1);
    layover[9] = 1.30;
    layover[14] = 0.90;
    const p = { profile: profile({ layover }), hour: 9 };
    const nine = stopModel(WINCHESTER, NO_POOLS, p);
    const two = stopModel(WINCHESTER, NO_POOLS, { ...p, hour: 14 });
    const flat = stopModel(WINCHESTER, NO_POOLS);
    const m = (d: typeof flat) => quantile(d.stand, 0.5);
    expect(m(nine) / m(flat)).toBeCloseTo(1.30, 6);
    expect(m(two) / m(flat)).toBeCloseTo(0.90, 6);
    // The WHOLE distribution scales, not just the median.
    for (const p50 of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(quantile(nine.stand, p50) / quantile(flat.stand, p50)).toBeCloseTo(1.30, 6);
    }
  });

  it("never moves P(stop): the mass at zero stays at zero", () => {
    const ordinary = new Array(24).fill(1);
    ordinary[9] = 1.5;
    const flat = stopModel(KERB, NO_POOLS);
    const nine = stopModel(KERB, NO_POOLS, { hour: 9, profile: profile({ ordinary }) });
    expect(nine.pStop).toBe(flat.pStop);
    expect(nine.stand.xs[0]).toBe(0);
  });

  it("classifies the stop before scaling, so an hour cannot change its class", () => {
    // A kerb stop at an hour with a big layover factor must still be priced
    // against the ORDINARY profile, not the layover one.
    const p = profile({ layover: new Array(24).fill(1.9), ordinary: new Array(24).fill(1) });
    const m = stopModel(KERB, NO_POOLS, { hour: 9, profile: p });
    expect(quantile(m.stand, 0.5)).toBeCloseTo(quantile(stopModel(KERB, NO_POOLS).stand, 0.5), 6);
  });
});

describe("shrinkage: the stop's own hour earns its weight", () => {
  const CLASS = 1.0;
  const own = 1.6;
  const withN = (n: number): DwellLike => {
    const hq = new Array(24).fill(0), hqn = new Array(24).fill(0);
    hq[9] = Math.round(100 * own); hqn[9] = n;
    return { ...WINCHESTER, hq, hqn };
  };
  const ctx = { hour: 9, profile: profile({ layover: new Array(24).fill(CLASS), layoverN: new Array(24).fill(500) }) };

  it("moves monotonically toward the stop's own factor with sample count", () => {
    let prev = hourFactor(WINCHESTER, ctx, true);
    expect(prev).toBe(CLASS);
    for (const n of [1, 3, 6, 12, 25, 60, 200, 2000]) {
      const f = hourFactor(withN(n), ctx, true);
      expect(f).toBeGreaterThan(prev);
      expect(f).toBeLessThanOrEqual(own + 1e-9);
      prev = f;
    }
    expect(prev).toBeCloseTo(own, 2);
  });

  it("puts half the weight on the stop at n = k", () => {
    const f = hourFactor(withN(STAND_HOUR_SHRINK_K), ctx, true);
    expect(Math.log(f)).toBeCloseTo(0.5 * Math.log(own) + 0.5 * Math.log(CLASS), 9);
  });

  it("falls back to the class factor when the stop has no cell at that hour", () => {
    const d = withN(6);
    expect(hourFactor(d, { ...ctx, hour: 10 }, true)).toBe(CLASS);
  });

  it("clamps a corrupt factor into the served band", () => {
    const bad = { ...WINCHESTER, hq: new Array(24).fill(0), hqn: new Array(24).fill(0) };
    bad.hq[9] = 100000; bad.hqn[9] = 10_000;
    expect(hourFactor(bad, ctx, true)).toBeLessThanOrEqual(STAND_HOUR_MAX_FACTOR);
    const tiny = { ...WINCHESTER, hq: new Array(24).fill(0), hqn: new Array(24).fill(0) };
    tiny.hq[9] = 1; tiny.hqn[9] = 10_000;
    expect(hourFactor(tiny, ctx, true)).toBeGreaterThanOrEqual(STAND_HOUR_MIN_FACTOR);
  });
});

describe("the residual-given-elapsed arithmetic stays coherent under the scaling", () => {
  it("is exactly f x the unscaled residual at r / f", () => {
    const f = 1.3;
    const flat = fromQuantiles(WINCHESTER.q!);
    const scaledStand = stopModel(WINCHESTER, NO_POOLS, {
      hour: 9, profile: profile({ layover: Object.assign(new Array(24).fill(1), { 9: f }) }),
    }).stand;
    for (const r of [0, 60, 141, 300, 600, 1200]) {
      expect(residualMedian(scaledStand, r)).toBeCloseTo(f * residualMedian(flat, r / f), 4);
    }
  });

  it("keeps the conditional total non-decreasing in elapsed, as it is unscaled", () => {
    for (const f of [0.7, 1, 1.4]) {
      const stand = stopModel(WINCHESTER, NO_POOLS, {
        hour: 9, profile: profile({ layover: Object.assign(new Array(24).fill(1), { 9: f }) }),
      }).stand;
      let prev = -Infinity;
      for (let r = 0; r <= 1800; r += 30) {
        const total = r + residualMedian(stand, r);
        expect(total).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = total;
      }
    }
  });
});
