import { describe, expect, it } from 'vitest';
import { compareDeadline } from './arriveBy';
import { deadlineMessage } from './arriveByMessage';
import type { TripOption } from './planner';

const now = 1_000_000;
const shuttle: TripOption = { mode: 'shuttle', routeLabel: 'Red', color: 'red', boardStopId: 48, alightStopId: 121,
  walkToSec: 60, waitSec: 180, rideSec: 420, walkFromSec: 60, totalSec: 720, busName: '307', directWalkSec: 1500,
  journeyArrival: { busName: '309', pointMs: now + 660_000, lowMs: now + 300_000, highMs: now + 840_000,
    catchRisk: false, estimated: false } };
const walk: TripOption = { ...shuttle, mode: 'walk', routeLabel: 'Walk', totalSec: 1500, journeyArrival: undefined };
const late: TripOption = { ...shuttle, journeyArrival: { ...shuttle.journeyArrival!, highMs: now + 1500_000 } };
const missing: TripOption = { ...shuttle, routeLabel: 'Blue', journeyArrival: undefined };
const bufferWalk = { ...walk, totalSec: 1080 };
const fitWalk = { ...walk, totalSec: 600 };
const compare = (options: TripOption[], at: number | null = now, failed = false, departure?: number) =>
  compareDeadline(options, now + 1200_000, 5, now, at, failed, departure);
const message = (c: ReturnType<typeof compareDeadline>) => deadlineMessage(c, { 48: 'Winchester / Mansfield' });

describe('class-deadline presentation', () => {
  it('preserves a safe recommendation, pickup name and catchable bus identity', () => {
    const c = compare([shuttle, walk]);
    expect(message(c).kind).toBe('recommendation');
    expect(message(c).heading).toContain('Red');
    expect(message(c).explanation).toContain('Winchester / Mansfield');
    expect(c.recommendation?.option.journeyArrival?.busName).toBe('309');
  });
  it('keeps walking advice when it fits even if shuttle data is missing', () => {
    expect(message(compare([missing, fitWalk])).heading).toBe('Walk now');
    expect(message(compare([missing, fitWalk], now, false, now + 60_000)).heading).toBe('Walking fits your buffer');
  });
  it('distinguishes reaching class within the buffer from possible lateness', () => {
    for (const bus of [late, missing, { ...shuttle, journeyArrival: { ...shuttle.journeyArrival!, catchRisk: true } }]) {
      const c = compare([bus, bufferWalk]);
      expect(c.recommendation).toBeUndefined();
      expect(message(c).kind).toBe('buffer');
      expect(message(c).explanation).toContain('walking estimate');
    }
  });
  it('considers a buffer-fitting second shuttle without changing the selected row', () => {
    const bufferBus = { ...shuttle, routeLabel: 'Blue', journeyArrival: { ...shuttle.journeyArrival!, highMs: now + 1100_000 } };
    const c = compare([late, bufferBus, walk]);
    expect(c.shuttle?.option.routeLabel).toBe('Red');
    expect(message(c).kind).toBe('buffer');
    expect(message(c).explanation).toContain('Blue');
    expect(message(c).supportingRow).toBe(c.rows[1]);
  });
  it('does not infer lateness from unavailable, interrupted, old, or future windows', () => {
    for (const c of [compare([missing, walk]), compare([shuttle, walk], null),
      compare([shuttle, walk], now, true), compare([shuttle, walk], now - 45_000),
      compare([shuttle, walk], now, false, now + 600_000)]) {
      expect(c.recommendation).toBeUndefined();
      expect(c.walk?.status).toBe('late');
      expect(message(c).kind).toBe('unknown');
      expect(message(c).heading).toBe('Live shuttle times unavailable');
    }
  });
  it('notices unknown alternatives beyond the two displayed comparison rows', () => {
    const c = compare([late, missing, walk]);
    expect(c.shuttle?.status).toBe('late');
    expect(c.walk?.status).toBe('late');
    expect(message(c).kind).toBe('unknown');
    expect(message(c).heading).toBe('Some shuttle times are unavailable');
    expect(message(c).explanation).toContain('Blue');
    expect(message(compare([late, { ...missing, departed: true }, walk])).kind).toBe('late');
  });
  it('describes conditional fits without recommending an uncertain connection or sparse data', () => {
    for (const [patch, kind] of [[{ catchRisk: true }, 'connection'], [{ estimated: true }, 'limited']] as const) {
      const bus = { ...shuttle, journeyArrival: { ...shuttle.journeyArrival!, ...patch } };
      for (const options of [[bus, walk], [bus, missing, walk]]) {
        const c = compare(options);
        expect(c.recommendation).toBeUndefined();
        expect(message(c).kind).toBe(kind);
        expect(message(c).explanation).toContain(c.shuttle!.caution);
        expect(message(c).supportingRow).toBe(c.shuttle);
      }
    }
  });
  it('calls windows past class possibly late, retaining any connection caution in the row', () => {
    const c = compare([{ ...late, journeyArrival: { ...late.journeyArrival!, catchRisk: true } }, walk]);
    expect(message(c).kind).toBe('late');
    expect(message(c).heading).toContain('may');
    expect(c.shuttle?.caution).toContain('before you');
  });
  it('handles no options and avoids suggesting a nonexistent walking row', () => {
    expect(message(compare([])).heading).toBe('Arrival time unavailable');
    expect(message(compare([missing])).kind).toBe('unknown');
    expect(message(compare([missing])).explanation).not.toContain('walking');
  });
});
