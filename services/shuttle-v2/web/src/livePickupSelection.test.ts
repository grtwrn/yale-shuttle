import { describe, expect, it } from 'vitest';
import { forecastPickupSelection, rawPickupSelection } from './livePickupSelection';
import { pickLiveArrival, rideBoardArrivals } from './planner';
import { compareDeadline } from './arriveBy';
import { journeyArrival } from './journeyArrival';
import type { UpcomingArrival } from './arrivals';

const row = (busName: string, stopId: number, stopsAhead: number, eta: number): UpcomingArrival => ({
  busName, routeLabel: 'Red', color: 'red', stopId, stopsAhead, eta,
  low: Math.max(0, eta - 20), high: eta + 80, departNow: eta, lowFloor: 0, estimated: false,
});
const first = row('#307', 48, 1, 20), later = row('307', 48, 30, 1200);
const dest = row('307', 121, 10, 500), laterDest = row('307', 121, 39, 1800);
const other = row('309', 48, 3, 300), otherDest = row('309', 121, 12, 800);
const select = (rows: UpcomingArrival[], walk: number) => pickLiveArrival(rideBoardArrivals(rows, 48, 121), '#307', walk);

describe('projection of the actual selected pickup', () => {
  it.each([
    { rows: [first, dest, later, laterDest], walk: 200, relation: 'same-bus-later-visit', bus: '307' },
    { rows: [first, other, dest, otherDest, later, laterDest], walk: 100, relation: 'different-bus', bus: '309' },
  ])('preserves $relation when destination rows disappear', ({ rows, walk, relation, bus }) => {
    const before = structuredClone(rows);
    const picked = select(rows, walk)!;
    const withoutDestination = rows.filter(r => r.stopId !== 121);
    const missing = select(withoutDestination, walk)!;
    const metadata = forecastPickupSelection(picked, 1000);
    expect(metadata).toMatchObject({ relation, boarding: { busName: bus }, countdown: { busName: '307' } });
    expect(forecastPickupSelection(missing, 1000)).toEqual(metadata);
    expect(journeyArrival(missing.boardable, withoutDestination, 121, walk, 0, 1000)).toBeUndefined();
    expect(rows).toEqual(before);
  });
  it('follows actual folded-route selection when destination missingness changes it', () => {
    const foldFirst = row('307', 48, 1, 20), returned = row('307', 48, 6, 150), target = row('307', 121, 9, 500);
    expect(forecastPickupSelection(select([foldFirst, returned, target], 0), 1000)?.boarding)
      .toMatchObject({ stopsAhead: 6 });
    expect(forecastPickupSelection(select([foldFirst, returned], 0), 1000)?.boarding)
      .toMatchObject({ stopsAhead: 1 });
  });
  it('retains the pinned walking tolerance without inventing a catchability guarantee', () => {
    const picked = select([first, dest], 129)!;
    expect(picked.departed).toBe(false);
    expect(picked.boardable).toBe(first);
    expect(forecastPickupSelection(picked, 1000)?.relation).toBe('same-visit');
  });
  it('clears absent or departed selections', () => {
    expect(forecastPickupSelection(null, 1000)).toBeUndefined();
    expect(forecastPickupSelection(select([first, dest], 1000), 1000)).toBeUndefined();
  });
  it('compares occurrence evidence rather than equal times or object identity', () => {
    expect(forecastPickupSelection({ match: first, boardable: { ...first, stopsAhead: 30 }, departed: false }, 1000)?.relation)
      .toBe('same-bus-later-visit');
    expect(forecastPickupSelection({ match: first, boardable: { ...first, busName: '307', eta: 999 }, departed: false }, 1000)?.relation)
      .toBe('same-visit');
  });
  it('keeps raw-current evidence free of an invented forecast occurrence', () => {
    const raw = { source: 'raw-at-stop', busName: '307', stopId: 48 };
    expect(rawPickupSelection('#307', 48, 1000)).toEqual({ selectedAtMs: 1000, countdown: raw, boarding: raw, relation: 'raw-current' });
  });
});


describe('pickup evidence is not a destination forecast', () => {
  it.each(['different-bus', 'same-bus-later-visit', 'raw-current'] as const)('retains unknown class arrival for %s', relation => {
    const selected = relation === 'raw-current' ? rawPickupSelection('307', 48, 1000)
      : forecastPickupSelection({ match: first, boardable: relation === 'different-bus' ? other : later, departed: false }, 1000);
    const result = compareDeadline([{
      mode: 'shuttle', routeLabel: 'Red', color: 'red', busName: '307', boardStopId: 48, alightStopId: 121,
      walkToSec: 100, walkFromSec: 0, waitSec: 200, rideSec: 500, totalSec: 800, directWalkSec: 1500,
      livePickupSelection: selected,
    }], 2_000_000, 5, 1000, 1000, false);
    expect(result.shuttle?.status).toBe('unknown');
    expect(result.recommendation).toBeUndefined();
  });
});
