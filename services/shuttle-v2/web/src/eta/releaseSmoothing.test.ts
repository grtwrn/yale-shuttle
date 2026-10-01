import { describe, expect, it } from 'vitest';
import { poolReleaseArrivals as pool, type ModelEntry } from './index';
import type { StopArrival } from './arrival';

const row = (stopId: number, occurrence: number, stopsAhead: number, eta: number): StopArrival => ({
  stopId, occurrence, stopsAhead, eta, low: eta * 0.8, high: eta * 1.2,
  distribution: Array.from({ length: 50 }, (_, i) => eta * (0.8 + i * 0.4 / 49)),
  departNow: eta, lowFloor: eta * 0.8, leadMass: 1, estimated: false, standingAt: -1,
});
const memory = (): NonNullable<ModelEntry['releaseSmoothing']> => new Map();
const poolReleaseArrivals = (m: ReturnType<typeof memory>, rows: StopArrival[], at: number, active: boolean) => pool(m, rows, at, active, 29);

describe('release smoothing occurrence identity', () => {
  it.each([11, 146])('preserves current arrival and following lap at stop %s through repeated hypothesis flips', stop => {
    const m = memory();
    const moving = () => [row(stop, 0, 29, 3000), row(stop, 1, 58, 5000)];
    const standing = () => [row(stop, 0, 0, 0), row(stop, 1, 29, 3100)];
    poolReleaseArrivals(m, moving(), 0, true);
    for (let t = 5000; t <= 25000; t += 10000) {
      const arrived = standing(), expected = structuredClone(arrived);
      poolReleaseArrivals(m, arrived, t, true);
      expect(arrived).toEqual(expected);
      const future = moving(), expectedFuture = structuredClone(future);
      poolReleaseArrivals(m, future, t + 5000, true);
      expect(future).toEqual(expectedFuture);
    }
  });

  it('keeps an already-arrived row exact even with legacy contaminated checkpoint memory', () => {
    const m = memory();
    m.set(22, { at: 0, row: row(11, 0, 0, 1804) });
    const arrived = row(11, 0, 0, 0);
    poolReleaseArrivals(m, [arrived], 5000, true);
    expect(arrived).toEqual(row(11, 0, 0, 0));
  });

  it('allows a new later estimate across a traversal boundary, then resumes smoothing both occurrences', () => {
    const m = memory();
    poolReleaseArrivals(m, [row(48, 0, 29, 100), row(48, 1, 58, 2000)], 0, true);
    const changed = [row(48, 0, 0, 0), row(48, 1, 29, 3000)];
    poolReleaseArrivals(m, changed, 5000, true);
    expect(changed.map(r => r.eta)).toEqual([0, 3000]);
    const later = [row(48, 0, 3, 600), row(48, 1, 29, 3600)];
    poolReleaseArrivals(m, later, 10000, true);
    expect(later[0]!.eta).toBe(600);
    for (const [i, r] of later.entries()) {
      expect(r.eta).toBeGreaterThan(changed[i]!.eta);
      if (i === 1) expect(r.eta).toBeLessThan(3600);
      expect(r.low).toBeLessThanOrEqual(r.eta);
      expect(r.high).toBeGreaterThanOrEqual(r.eta);
      expect(r.distribution).toEqual([...r.distribution!].sort((a, b) => a - b));
    }
  });

  it('keeps ordinary forward progress smoothed on both future traversals', () => {
    const m = memory();
    poolReleaseArrivals(m, [row(48, 0, 4, 100), row(48, 1, 33, 2000)], 0, true);
    const later = [row(48, 0, 3, 400), row(48, 1, 32, 3000)];
    poolReleaseArrivals(m, later, 5000, true);
    expect(later[0]!.eta).toBeGreaterThan(100);
    expect(later[0]!.eta).toBeLessThan(400);
    expect(later[1]!.eta).toBeGreaterThan(2000);
    expect(later[1]!.eta).toBeLessThan(3000);
  });

  it.each([[-1, true], [16000, true], [5000, false]])('bypasses stale/reversed/inactive memory (%s, %s)', (at, active) => {
    const m = memory();
    poolReleaseArrivals(m, [row(48, 0, 3, 100)], 0, true);
    const fresh = row(48, 0, 3, 500);
    poolReleaseArrivals(m, [fresh], at as number, active as boolean);
    expect(fresh).toEqual(row(48, 0, 3, 500));
  });
});
