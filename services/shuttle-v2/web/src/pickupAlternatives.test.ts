import { describe, expect, it } from 'vitest';
import { routePickupChoices, type TripOption } from './planner';

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
});
