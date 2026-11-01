import { describe, expect, it } from 'vitest';
import { strictCycleOrder } from './order.js';

/** Independent finite grid oracle: for integer endpoints N+1 subdivisions
 * contain a witness for any strict order among N variables in one unit gap.
 */
function gridOracle(intervals: { lo: number; hi: number }[], loop: number): boolean {
  const scale = intervals.length + 1;
  const choose = (index: number, positions: number[]): boolean => {
    if (index === intervals.length) return positions.at(-1)! < positions[0]! + loop * scale;
    const range = intervals[index]!;
    for (let point = range.lo * scale; point <= range.hi * scale; point++) {
      if (index && point <= positions.at(-1)!) continue;
      if (choose(index + 1, [...positions, point])) return true;
    }
    return false;
  };
  return choose(0, []);
}

describe('exact strict interval-cycle feasibility', () => {
  it('matches a separately enumerated tiny witness grid including repeated/overlapping intervals', () => {
    const ranges = [{ lo: 0, hi: 0 }, { lo: 0, hi: 1 }, { lo: 0, hi: 2 },
      { lo: 1, hi: 1 }, { lo: 1, hi: 2 }, { lo: 2, hi: 2 }];
    for (const a of ranges) for (const b of ranges) for (const c of ranges) {
      const intervals = [a, b, c];
      expect(strictCycleOrder(intervals, 2).feasible).toBe(gridOracle(intervals, 2));
    }
  });

  it('retains strict closure/equality and subnormal distinctions without a minimum epsilon', () => {
    expect(strictCycleOrder([{ lo: -0, hi: 0 }, { lo: 0, hi: 0 }], 1).feasible).toBe(false);
    expect(strictCycleOrder([{ lo: 0, hi: 0 }, { lo: Number.MIN_VALUE, hi: Number.MIN_VALUE }], 1).feasible).toBe(true);
    expect(strictCycleOrder([{ lo: 0, hi: 0 }, { lo: 1, hi: 1 }], 1)).toMatchObject({ feasible: false, reason: 'strict-cycle' });
    expect(strictCycleOrder([{ lo: 0, hi: 2 }, { lo: 1, hi: 3 }, { lo: 2, hi: 4 }], 3).feasible).toBe(true);
    expect(strictCycleOrder([{ lo: 2, hi: 2 }, { lo: 1, hi: 1 }], 3)).toMatchObject({ feasible: false, reason: 'strict-order' });
  });
});
