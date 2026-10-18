import { describe, expect, it } from 'vitest';
import { chooseTransferOptions, transferAddsChoice, transferRideStillServed } from './transferChoices';
import type { ScheduledTransferJourney } from './transferSchedule';
import type { LiveTransferJourney } from './transferTiming';
import type { TransferPath } from './transferPaths';
import type { TripOption } from './planner';
const path = (key: string, walkToSec = 100, transferWalkSec = 50, walkFromSec = 100): TransferPath => ({ key,
  first: { routeLabel: 'Red', color: '#c00', routeId: '3', boardStopId: 11, alightStopId: 113, stops: [11, 48, 113], plannedRideSec: 300 },
  second: { routeLabel: 'Orange Day', color: '#f60', routeId: '2', boardStopId: 34, alightStopId: 95, stops: [34, 82, 95], plannedRideSec: 400 },
  walkToSec, transferWalkSec, walkFromSec, directWalkSec: 1300 });
const typical = (p: TransferPath, totalSec: number): ScheduledTransferJourney => ({ path: p, timing: 'typical', totalSec,
  departAtMs: 1000, computedAtMs: 0, arrivalAtMs: 1000 + totalSec * 1000, changeSec: 60,
  first: { path: p.first, busName: null, pickupAtMs: 2000, alightAtMs: 3000, waitSec: 200 },
  second: { path: p.second, busName: null, pickupAtMs: 4000, alightAtMs: 5000, waitSec: 300 } });
const live = (p: TransferPath, uncertain: boolean) => ({ ...typical(p, 1200), timing: 'live',
  firstPickupUncertain: false, connection: { uncertain, bufferSec: 200 } }) as unknown as LiveTransferJourney;
const direct = (change: Partial<TripOption> = {}): TripOption => ({ mode: 'shuttle', walkToSec: 100, walkFromSec: 100,
  totalSec: 1000, journeyArrival: { catchRisk: false }, ...change } as TripOption);
describe('transfer choices', () => {
  it('keeps closest pickup, least total walking, and earlier arrival as independent route-pair choices', () => {
    const closest = path('close', 0, 200, 300), walking = path('walk', 50, 20, 30), early = path('early', 200, 100, 100), extra = path('extra', 250, 200, 300);
    const paths = [closest, walking, early, extra], times = paths.map((p, i) => typical(p, [1800, 1500, 1200, 2400][i]!));
    const before = structuredClone({ paths, times }), choices = chooseTransferOptions(paths, times);
    expect(choices.map(c => c.key)).toEqual(['early', 'walk', 'close']);
    expect(choices.find(c => c.key === 'close')?.preferences).toContain('closest-pickup');
    expect(choices.find(c => c.key === 'walk')?.preferences).toContain('less-walking');
    expect({ paths, times }).toEqual(before);
  });
  it('retains an untimed closest pickup and deduplicates preference labels on one path', () => {
    const closest = path('close', 0), timed = path('timed');
    expect(chooseTransferOptions([closest, timed], [typical(timed, 1200)]).map(c => c.key)).toEqual(['timed', 'close']);
    expect(chooseTransferOptions([closest], [typical(closest, 1200)])[0]?.preferences).toEqual(['closest-pickup', 'less-walking', 'earlier-arrival']);
  });
  it('uses stable path identity across visit-hop and vehicle changes', () => {
    const p = path('selected'), a = { ...live(p, false), key: 'hops-7', totalSec: 1200 }, b = { ...live(p, false), key: 'hops-6', totalSec: 1100 };
    expect(chooseTransferOptions([p], [a])[0]?.key).toBe('selected');
    expect(chooseTransferOptions([p], [b])[0]?.key).toBe('selected');
    expect(chooseTransferOptions([p], [a, b])[0]?.timing).toBe(b);
  });
  it('breaks equal arrival ties by connection uncertainty, then available change time', () => {
    const p = path('selected'), risky = live(p, true), safer = live(p, false), longer = { ...safer, connection: { ...safer.connection, bufferSec: 300 } };
    expect(chooseTransferOptions([p], [risky, safer, longer])[0]?.timing).toBe(longer);
  });
  it('keeps separate route pairs, including when all connection forecasts are unavailable', () => {
    const a = path('a'), b = { ...path('b'), second: { ...path('b').second, routeLabel: 'Pink', routeId: '12' } };
    expect(chooseTransferOptions([a, b], [])).toHaveLength(2);
  });
  it('collapses a strictly worse transfer while preserving walking, arrival, and pickup-risk tradeoffs', () => {
    const p = path('a'), choice = { key: p.key, path: p, timing: live(p, false), preferences: [] };
    expect(transferAddsChoice(choice, [direct()], false)).toBe(false);
    expect(transferAddsChoice(choice, [direct({ walkToSec: 200 })], false)).toBe(true);
    expect(transferAddsChoice(choice, [direct({ totalSec: 1300 })], false)).toBe(true);
    expect(transferAddsChoice(choice, [direct({ journeyArrival: { catchRisk: true } as TripOption['journeyArrival'] })], false)).toBe(true);
    expect(transferAddsChoice(choice, [direct({ etaUnavailable: true })], false)).toBe(true);
    expect(transferAddsChoice(choice, [direct({ departed: true })], false)).toBe(true);
  });
  it('does not suppress an available transfer behind a direct ride with no destination estimate', () => {
    const p = path('a'), choice = { key: p.key, path: p, timing: typical(p, 1200), preferences: [] };
    expect(transferAddsChoice(choice, [direct({ journeyArrival: undefined })], false)).toBe(true);
    expect(transferAddsChoice(choice, [direct({ journeyArrival: undefined })], true)).toBe(false);
  });
  it('checks a restored ride against exact canonical travel order, including a wrap and repeated calls', () => {
    const p = path('a').first;
    expect(transferRideStillServed(p, { '3': [11, 48, 113, 99] })).toBe(true);
    expect(transferRideStillServed(p, { '3': [48, 113, 99, 11] })).toBe(true);
    expect(transferRideStillServed(p, { '3': [11, 113, 48, 99] })).toBe(false);
    expect(transferRideStillServed(p, { '3': [11, 98, 48, 113] })).toBe(false);
    expect(transferRideStillServed(p, {})).toBe(false);
    expect(transferRideStillServed({ ...p, stops: [11, 48, 11, 113] }, { '3': [11, 48, 11, 113] })).toBe(true);
  });
});
