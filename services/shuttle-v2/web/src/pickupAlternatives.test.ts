import { describe, expect, it } from 'vitest';
import { MAX_RIDE_SEC, planTrip, routePickupChoices, type TripOption } from './planner';
import { readFileSync } from 'node:fs';
import { attachServerEta } from './etaSource';

// Captured report #143 forecast/topology; endpoints are stop-coordinate proxies,
// because the reporter's precise origin and destination were not recorded.
const captured = JSON.parse(readFileSync(new URL('./__fixtures__/blue-same-bus-pickup-2026-10-20.json', import.meta.url), 'utf8'));
function capturedBlue(change = (_input: typeof captured) => {}, future = false) {
  const input = structuredClone(captured);
  change(input);
  const now = input.server_eta.servedAt;
  attachServerEta(input.buses, input.server_eta, now);
  return planTrip(input.from, input.to, input.buses, input.routes, input.stop_coords,
    input.segments, input.dwells, future ? new Date(now + 120_000) : null, now)
    .find(o => o.routeLabel === 'Blue Day')!;
}

describe('one bus and one onward destination (report #143)', () => {
  it('keeps the closest pickup with the same better exit beyond the historical ride cutoff', () => {
    const option = capturedBlue();
    expect(option).toMatchObject({boardStopId: 72, alightStopId: 100, busName: '45', walkFromSec: 0});
    expect(option.plannedRideSec).toBeGreaterThan(MAX_RIDE_SEC);
    expect(option.journeyArrival?.pointMs).toBeCloseTo(captured.server_eta.at + 2086_000, 0);
    expect(option.pickupAlternatives).toBeUndefined();
  });
  it('does not extend an untimed ride past the fallback limit when the destination forecast is missing', () => {
    const option = capturedBlue(input => {
      const keep = input.server_eta.rows.map((row: number[], i: number) => ({row, i})).filter(({row}: {row: number[]}) => row[5] <= 15);
      input.server_eta.rows = keep.map(({row}: {row: number[]}) => row);
      input.server_eta.distributions = keep.map(({i}: {i: number}) => input.server_eta.distributions[i]);
    });
    expect(option.boardStopId).toBe(72);
    expect(option.alightStopId).not.toBe(100);
    expect(option.plannedRideSec).toBeLessThanOrEqual(MAX_RIDE_SEC);
  });
  it('retains the fallback limit for future plans without live visit evidence', () => {
    const option = capturedBlue(undefined, true);
    expect(option.plannedRideSec).toBeLessThanOrEqual(MAX_RIDE_SEC);
    expect(option.journeyArrival).toBeUndefined();
  });
  it('does not suppress a real earlier visit just because the vehicle name is the same', () => {
    const option = routePickupChoices([close, {...farther, busName: close.busName}]);
    expect(option.pickupAlternatives?.[0]).toMatchObject({boardStopId: 129, busName: close.busName, pickupPreference: 'arrive-sooner'});
  });
});

const close: TripOption = { mode: 'shuttle', routeLabel: 'Blue Day', color: '#1565c0',
  boardStopId: 100, alightStopId: 97, walkToSec: 120, walkFromSec: 60,
  waitSec: 2400, rideSec: 600, plannedRideSec: 600, totalSec: 3180,
  directWalkSec: 1800, busName: '44', busEtaSec: 2520, departed: false };
const farther: TripOption = { ...close, boardStopId: 129, walkToSec: 480,
  waitSec: 0, rideSec: 300, plannedRideSec: 300, totalSec: 840, busName: '48', busEtaSec: 480 };

describe('walking versus earlier-arriving pickups on one line', () => {
  it('keeps the close stop and its long wait while offering the earlier bus separately', () => {
    const choice = routePickupChoices([farther, close]);
    expect(choice.boardStopId).toBe(100);
    expect(choice.waitSec).toBe(2400);
    expect(choice.busName).toBe('44');
    expect(choice.pickupAlternatives).toEqual([{ ...farther, pickupPreference: 'arrive-sooner' }]);
  });
  it('does not let a changing wait replace the close pickup', () => {
    for (const waitSec of [0, 600, 3600]) {
      expect(routePickupChoices([farther, { ...close, waitSec, totalSec: waitSec + 780 }]).boardStopId).toBe(100);
    }
  });
  it('does not present an uncatchable farther bus as an earlier arrival', () => {
    const choice = routePickupChoices([close, { ...farther, departed: true }]);
    expect(choice.boardStopId).toBe(100);
    expect(choice.pickupAlternatives).toBeUndefined();
  });
  it('keeps the closest stop visible without claiming a departed bus is catchable', () => {
    const choice = routePickupChoices([{ ...close, departed: true }, farther]);
    expect(choice.boardStopId).toBe(100);
    expect(choice.departed).toBe(true);
    expect(choice.pickupAlternatives?.[0]?.departed).toBe(false);
  });
  it('avoids duplicate choices when the closest trip also arrives first', () => {
    const choice = routePickupChoices([{ ...close, totalSec: 780, waitSec: 0 }, farther]);
    expect(choice.boardStopId).toBe(100);
    expect(choice.pickupAlternatives).toBeUndefined();
  });
  it('keeps the sensible exit at the close pickup instead of taking an extra lap to save a few steps', () => {
    const extraLap = { ...close, alightStopId: 98, walkFromSec: 0, totalSec: close.totalSec + 900, rideSec: close.rideSec + 900 };
    const choice = routePickupChoices([extraLap, farther, close]);
    expect(choice.boardStopId).toBe(100);
    expect(choice.alightStopId).toBe(97);
    expect(choice.pickupAlternatives?.[0]?.boardStopId).toBe(129);
  });
});
