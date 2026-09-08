import { describe, expect, it } from "vitest";

import {
  buildProfile, cellBaseline, clampFactor, emptyProfile, stopHourFactors,
  HOURS, STAND_HOUR_CLASS_K, STAND_HOUR_MIN_BASE, STAND_HOUR_MIN_CELL, STAND_HOUR_MIN_CLASS,
  type HourCell,
} from "./diurnal.js";

/** n visits at `hour`, each of `sec` seconds. */
const cell = (key: string, hour: number, n: number, sec: number): HourCell =>
  ({ key, hour, n, logSum: n * Math.log(sec) });

/** A cell whose stands are `sec` at every hour except the ones overridden. */
function stopCells(key: string, base: number, over: Record<number, [number, number]> = {}, hours = [7, 8, 9, 10, 11, 12]): HourCell[] {
  return hours.map((h) => {
    const o = over[h];
    return o ? cell(key, h, o[0], o[1]) : cell(key, h, 4, base);
  });
}

describe("the class profile is estimated within cell", () => {
  it("is 1 everywhere with no data", () => {
    const p = buildProfile(new Map(), () => "ordinary");
    expect(p.ordinary).toEqual(new Array(HOURS).fill(1));
    expect(p.ordinaryN).toEqual(new Array(HOURS).fill(0));
    expect(p).toEqual(emptyProfile());
  });

  it("recovers a factor applied to every cell, whatever their levels", () => {
    // Ten stops with wildly different typical stands, all 40% longer at 08:00.
    const byCell = new Map<string, HourCell[]>();
    for (let i = 0; i < 10; i++) {
      const base = 30 + i * 40;
      byCell.set(`1:${i}`, stopCells(`1:${i}`, base, { 8: [6, base * 1.4] }));
    }
    const p = buildProfile(byCell, () => "ordinary");
    // The cell's own baseline is the geometric mean over ALL its hours, which
    // the 08:00 excess lifts a little; the factor is measured against that, so
    // the recovered number is the excess relative to the day, not to the
    // other hours alone.
    // ...and then damped by STAND_HOUR_CLASS_K, because 60 visits is not a
    // well-measured hour: the raw excess survives at 60 / (60 + 84).
    expect(p.ordinary[8]!).toBeGreaterThan(1.05);
    expect(p.ordinary[8]!).toBeLessThan(1.2);
    expect(p.ordinary[9]!).toBeLessThan(1);
    expect(p.ordinaryN[8]).toBe(60);
    // The two classes are kept apart.
    expect(p.layover).toEqual(new Array(HOURS).fill(1));
  });

  it("is NOT moved by the route and stop mix changing with the hour", () => {
    // A long-standing stop that only runs in the morning and a short one that
    // only runs at night. Pooled naively, the morning would read 10x; within
    // cell each is its own baseline, so both hours read 1.
    const byCell = new Map<string, HourCell[]>([
      ["1:1", [cell("1:1", 8, 10, 600), cell("1:1", 9, 10, 600)]],
      ["1:2", [cell("1:2", 22, 10, 60), cell("1:2", 23, 10, 60)]],
    ]);
    const p = buildProfile(byCell, () => "ordinary");
    for (const h of [8, 9, 22, 23]) expect(p.ordinary[h]!).toBeCloseTo(1, 6);
  });

  it("publishes an hour only from STAND_HOUR_MIN_CLASS positive stands", () => {
    const thin = new Map<string, HourCell[]>([
      ["1:1", [cell("1:1", 8, STAND_HOUR_MIN_CLASS - 1, 200), cell("1:1", 9, 20, 100)]],
    ]);
    expect(buildProfile(thin, () => "ordinary").ordinary[8]).toBe(1);
    const fat = new Map<string, HourCell[]>([
      ["1:1", [cell("1:1", 8, STAND_HOUR_MIN_CLASS, 200), cell("1:1", 9, 30, 100)]],
    ]);
    expect(buildProfile(fat, () => "ordinary").ordinary[8]).toBeGreaterThan(1);
  });

  it("skips a cell with no class and one with too few to have a baseline", () => {
    const byCell = new Map<string, HourCell[]>([
      ["1:1", [cell("1:1", 8, 100, 300)]],
      ["1:2", [cell("1:2", 8, STAND_HOUR_MIN_BASE - 1, 300)]],
    ]);
    expect(buildProfile(byCell, (k) => (k === "1:1" ? null : "ordinary")).ordinaryN[8]).toBe(0);
  });

  it("damps a class-hour by its own precision, monotonically in n", () => {
    // The same raw excursion, measured from more and more visits.
    const at = (n: number) => {
      const byCell = new Map<string, HourCell[]>([
        ["1:1", [cell("1:1", 8, n, 200), cell("1:1", 9, n, 100)]],
      ]);
      return buildProfile(byCell, () => "ordinary").ordinary[8]!;
    };
    // Raw factor is sqrt(2) = 1.414 at every n; what changes is the damping.
    const raw = Math.SQRT2;
    let prev = 1;
    for (const n of [30, 60, 120, 400, 2000, 20_000]) {
      const f = at(n);
      expect(f).toBeGreaterThan(prev);
      expect(f).toBeLessThan(raw + 1e-9);
      prev = f;
    }
    expect(prev).toBeCloseTo(raw, 2);
    // Half the excursion at n = k.
    expect(Math.log(at(STAND_HOUR_CLASS_K))).toBeCloseTo(0.5 * Math.log(raw), 6);
  });

  it("clamps a factor into the served band", () => {
    expect(clampFactor(50)).toBe(2);
    expect(clampFactor(0.001)).toBe(0.5);
    expect(clampFactor(0)).toBe(1);
    expect(clampFactor(NaN)).toBe(1);
  });
});

describe("a stop's own hourly factors", () => {
  it("are null with nothing to say", () => {
    expect(stopHourFactors([cell("1:1", 8, STAND_HOUR_MIN_BASE - 1, 100)])).toBeNull();
    // Enough for a baseline, but no single hour reaches the wire gate.
    expect(stopHourFactors(stopCells("1:1", 100))).toBeNull();
  });

  it("publish only hours reaching STAND_HOUR_MIN_CELL, x100, with their counts", () => {
    const cells = stopCells("1:1", 100, { 8: [STAND_HOUR_MIN_CELL, 200], 9: [STAND_HOUR_MIN_CELL - 1, 200] });
    const f = stopHourFactors(cells)!;
    expect(f.hq[9]).toBe(0);
    expect(f.hqn[9]).toBe(0);
    expect(f.hq[8]).toBeGreaterThan(100);
    expect(f.hqn[8]).toBe(STAND_HOUR_MIN_CELL);
    expect(f.hq).toHaveLength(HOURS);
  });

  it("measure against the cell's own all-hours geometric mean", () => {
    const cells = [cell("1:1", 8, 10, 200), cell("1:1", 9, 10, 50)];
    // geometric mean = sqrt(200 * 50) = 100
    expect(Math.exp(cellBaseline(cells)!)).toBeCloseTo(100, 6);
    const f = stopHourFactors(cells)!;
    expect(f.hq[8]).toBe(200);
    expect(f.hq[9]).toBe(50);
  });
});
