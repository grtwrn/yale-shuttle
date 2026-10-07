import { describe, expect, it } from 'vitest';
import { stopVisits, type PosRow } from './lib';

const coords = { 1: { lat: 41.3, lon: -72.9 } };
const row = (t: number, near: boolean, l: number | null, r = 3): PosRow =>
  ({ i: 1, b: '#1', r, h: 0, t: t * 1000, lat: coords[1].lat + (near ? 0 : 0.003), lon: coords[1].lon, l });
const visits = (rs: PosRow[]) => stopVisits(rs, () => [1], coords).get(1) ?? [];

describe('a served flip cannot independently corroborate several curb visits', () => {
  it('counts a long hold, departure and served return only once', () => {
    const rs = [row(0, false, 2), ...Array.from({ length: 85 }, (_, i) => row(5 + i * 5, true, 2)),
      ...Array.from({ length: 24 }, (_, i) => row(430 + i * 5, false, 2)),
      row(550, true, 2), row(565, true, 1), row(600, false, 1)];
    expect(visits(rs)).toEqual([{ enter: 550000, exit: 600000, busName: '#1', routeId: 3, source: 'curb' }]);
  });
  it('retains the earlier visit when the flip occurs inside it, not blindly the latest', () => {
    const rs = [row(0, false, 2), row(10, true, 2), row(20, true, 1), row(30, false, 1),
      row(100, true, 1), row(110, false, 1)];
    expect(visits(rs)).toEqual([{ enter: 10000, exit: 30000, busName: '#1', routeId: 3, source: 'curb' }]);
  });
  it('prefers the nearest observed interval when the flip precedes both visits', () => {
    const rs = [row(0, false, 2), row(5, false, 1), row(20, true, 1), row(30, false, 1),
      row(100, true, 1), row(110, false, 1)];
    expect(visits(rs).map(v => v.enter)).toEqual([20000]);
  });
  it('reassigns ambiguous support to preserve two visits with two distinct flips', () => {
    // First flip is nearest visit 2 but can support either. Second can ONLY
    // support visit 2. A nearest-only greedy pass would drop visit 1.
    const rs = [row(0, false, 2), row(10, true, 2), row(20, false, 2),
      row(100, true, 2), row(110, false, 2), row(120, false, 1),
      row(125, false, 2), row(350, false, 1), row(355, false, 1)];
    expect(visits(rs).map(v => v.enter)).toEqual([10000, 100000]);
    expect(visits(rs).every(v => v.source === 'curb')).toBe(true);
  });
  it('does not invent another visit for feed bounces during one continuous curb stay', () => {
    const rs = [row(0, false, 2), row(10, true, 2), row(20, true, 1),
      row(30, true, 2), row(40, true, 1), row(50, false, 1)];
    expect(visits(rs)).toHaveLength(1);
    expect(visits(rs)[0]).toMatchObject({ enter: 10000, source: 'curb' });
  });
  it('preserves separate missed-radius served occurrences', () => {
    const rs = [row(0, false, 2), row(10, false, 1), row(20, false, 2), row(30, false, 1)];
    expect(visits(rs)).toHaveLength(2);
    expect(visits(rs).every(v => v.source === 'feed')).toBe(true);
  });
  it('preserves separate geometry visits when the feed has no stop opinion', () => {
    const rs = [row(0, false, null), row(10, true, null), row(20, false, null),
      row(100, true, null), row(110, false, null)];
    expect(visits(rs).map(v => v.enter)).toEqual([10000, 100000]);
    expect(visits(rs).every(v => v.source === 'curb-only')).toBe(true);
  });
  it('never shares a served flip across routes', () => {
    const rs = [row(0, false, 2), row(10, true, 2), row(20, false, 2),
      row(100, true, 2, 4), row(105, true, 1, 4), row(110, false, 1, 4)];
    expect(visits(rs)).toEqual([{ enter: 100000, exit: 110000, busName: '#1', routeId: 4, source: 'curb' }]);
  });
});

import { servedReturn } from './served-return.fixture';
it('retains the closer earlier recorded Purple23 visit, not both or blindly the latest', () => {
  const v = stopVisits(servedReturn.filter(r => r.t < 1790772466191), () => [23], { 23: { lat: 41.256341, lon: -72.99019 } }).get(23)!;
  expect(v).toHaveLength(1);
  expect(v[0]).toMatchObject({ enter: 1790771991121, source: 'curb', routeId: 10 });
});

it('preserves both recorded Purple23 visits once the second distinct flip is observed', () => {
  const v = stopVisits(servedReturn, () => [23], { 23: { lat: 41.256341, lon: -72.99019 } }).get(23)!;
  expect(v.map(x => x.enter)).toEqual([1790771991121, 1790772456183]);
  expect(v.every(x => x.source === 'curb')).toBe(true);
});

it('does not re-date two distinct missed-radius flips to the same earlier approach', () => {
  const almost = { ...row(10, false, 1), lat: coords[1].lat + 0.0006 }; // 67m, never curb
  const rs = [row(0, false, 2), almost, row(20, false, 2), row(30, false, 1)];
  expect(visits(rs).map(v => v.enter)).toEqual([10000, 30000]);
  expect(visits(rs).every(v => v.source === 'feed')).toBe(true);
});
