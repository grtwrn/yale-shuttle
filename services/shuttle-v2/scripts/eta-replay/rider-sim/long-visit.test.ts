import { describe, expect, it } from 'vitest';
import { stopVisits, type PosRow } from './lib';
import { blueWeekend116 } from './blue-weekend116.fixture';
const c = { 116: {lat: 41.315041, lon: -72.938202} };
const rows: PosRow[] = blueWeekend116.map(([t, lat, lon, l]) => ({i: 1, b: '#44', r: 4, h: 0, t, lat, lon, l}));
describe('a delayed served flip corroborates the same continuously observed curb visit', () => {
  it('retains the recorded Stop & Shop entry instead of re-dating it to departure', () => {
    const v = stopVisits(rows, () => [116], c).get(116)!;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ source: 'curb', enter: 1791113917544, exit: 1791114657643 });
  });
  it('does not extend a short drive-by to a later service occurrence', () => {
    const track: PosRow[] = [
      {...rows[0]!, t: 0, l: 21, lat: c[116].lat + 0.003},
      {...rows[0]!, t: 5000, l: 21, ...c[116]},
      {...rows[0]!, t: 10000, l: 21, lat: c[116].lat + 0.003},
      ...Array.from({length: 70}, (_, i) => ({...rows[0]!, t: 15000 + i * 5000, l: 21, lat: c[116].lat + 0.003})),
      {...rows[0]!, t: 365000, l: 116, ...c[116]},
    ];
    const v = stopVisits(track, () => [116], c).get(116)!;
    expect(v).toHaveLength(1);
    expect(v[0]!.enter).toBe(365000);
  });
  it('does not extend corroboration across a missing-feed gap', () => {
    const sparse = rows.filter((r) => r.t <= 1791113922544 || r.t >= 1791114642742);
    const v = stopVisits(sparse, () => [116], c).get(116)!;
    expect(v).toHaveLength(1);
    expect(v[0]!.source).toBe('feed');
    expect(v[0]!.enter).toBeGreaterThan(1791113922544);
  });
  it('does not join through another served stop occurrence', () => {
    const changed = rows.map((r) => r.t >= 1791114020000 && r.t < 1791114642742 ? {...r, l: 53} : r);
    const v = stopVisits(changed, () => [116], c).get(116)!;
    expect(v).toHaveLength(1);
    expect(v[0]!.source).toBe('feed');
    expect(v[0]!.enter).toBeGreaterThan(1791113922544);
  });
  it('does not borrow a served flip from a different route', () => {
    const switched = rows.map((r) => r.t >= 1791114642742 ? {...r, r: 3} : r);
    const v = stopVisits(switched, () => [116], c).get(116)!;
    expect(v.every((x) => x.enter > 1791113922544)).toBe(true);
  });
});
