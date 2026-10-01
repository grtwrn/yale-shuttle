import { describe, expect, it } from 'vitest';
import { compareDeadline } from './arriveBy';
import type { TripOption } from './planner';
const now = 1_000_000;
const shuttle: TripOption = { mode: 'shuttle', routeLabel: 'Red', color: 'red', boardStopId: 48, alightStopId: 121,
  walkToSec: 0, waitSec: 180, rideSec: 420, walkFromSec: 60, totalSec: 660, busName: '307', directWalkSec: 900,
  journeyArrival: { busName: '309', pointMs: now + 660_000, lowMs: now + 300_000, highMs: now + 840_000, catchRisk: false, estimated: false } };
const walk: TripOption = { ...shuttle, mode: 'walk', routeLabel: 'Walk', totalSec: 900, journeyArrival: undefined };
const compare = (options = [shuttle, walk], at = now, failed = false, departure?: number) =>
  compareDeadline(options, now + 1200_000, 5, now, at, failed, departure);

describe('deadline recommendation', () => {
  it('compares destination windows with walking, using the catchable bus identity', () => {
    const c = compare();
    expect(c.recommendation?.option.routeLabel).toBe('Red');
    expect(c.shuttle?.option.journeyArrival?.busName).toBe('309');
    expect(c.walk?.lowMs).toBeUndefined(); // no invented walking distribution
  });
  it('prefers walking when the shuttle median fits but the window runs late', () => {
    const late = { ...shuttle, journeyArrival: { ...shuttle.journeyArrival!, highMs: now + 1300_000 } };
    expect(compare([late, walk]).recommendation?.option.mode).toBe('walk');
    expect(compare([late, walk]).shuttle?.status).toBe('late');
  });
  it('does not recommend a risky connection or a prior-only window', () => {
    for (const patch of [{ catchRisk: true }, { estimated: true }]) {
      const risky = { ...shuttle, journeyArrival: { ...shuttle.journeyArrival!, ...patch } };
      expect(compare([risky, walk]).recommendation?.option.mode).toBe('walk');
    }
  });
  it('withholds bus advice on interrupted, stale, departed, or future feeds', () => {
    for (const c of [compare(undefined, now - 45_000), compare(undefined, now, true),
      compare([{ ...shuttle, departed: true }, walk]), compare(undefined, now, false, now + 60_000)]) {
      expect(c.recommendation?.option.mode).not.toBe('shuttle');
    }
    const future = compare(undefined, now, false, now + 120_000);
    expect(future.walk?.pointMs).toBe(now + 1020_000);
    expect(future.shuttle?.highMs).toBeUndefined();
  });
  it('does not promise a fit when neither alternative fits the buffer', () => {
    const c = compareDeadline([shuttle, walk], now + 600_000, 5, now, now, false);
    expect(c.recommendation).toBeUndefined();
  });
});
