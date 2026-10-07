import { describe, expect, it } from 'vitest';
import { stopVisits, type PosRow } from './lib';

const coords = { 1: { lat: 41.3, lon: -72.9 } };
const row = (t: number, near: boolean, l: number | null): PosRow =>
  ({ i: 1, b: '#1', r: 3, h: 0, t: t * 1000, lat: coords[1].lat + (near ? 0 : 0.003), lon: coords[1].lon, l });
const entries = (rows: PosRow[]) => (stopVisits(rows, () => [1], coords).get(1) ?? []).map(v => v.enter / 1000);

describe('served support rerouting', () => {
  it('uses the free clean alternative instead of rerouting onto crossed service (review P2)', () => {
    // f105: {100 clean,20 crossed}; f115: {100 clean,230 clean}.
    // Both maximum matchings have size two; only {100,230} has no crossing.
    expect(entries([row(0, false, 0), row(20, true, 0), row(30, false, 0), row(50, false, 2),
      row(100, true, 2), row(105, true, 1), row(108, true, 3), row(110, false, 3),
      row(115, false, 1), row(230, true, 1), row(240, false, 1)])).toEqual([100,230]);
  });
  it('preserves the unresolved same-poll P1 boundary, not a physical-service assertion', () => {
    expect(entries([row(0, false, 0), row(10, true, 0), row(40, true, 0), row(60, false, 0),
      row(150, false, 0), row(200, false, 1), row(205, true, 2), row(210, true, 3),
      row(260, true, 3), row(280, false, 3)])).toEqual([205]);
  });
  it('preserves a maximum matching even when a crossing is necessary', () => {
    expect(entries([row(0, false, 2), row(10, true, 2), row(20, false, 2),
      row(100, true, 2), row(110, false, 2), row(120, false, 1),
      row(125, false, 2), row(350, false, 1), row(355, false, 1)])).toEqual([10,100]);
  });
});
