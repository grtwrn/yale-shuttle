import { describe, expect, it } from 'vitest';
import { routePickupChoices, type TripOption } from './planner';
import { admitTripRoutes, retainedTripRoutes } from './tripRouteAdmissions';

const red: TripOption = { mode: 'shuttle', routeLabel: 'Red', color: '#c00',
  boardStopId: 48, alightStopId: 11, walkToSec: 60, walkFromSec: 60,
  waitSec: 300, rideSec: 600, totalSec: 1020, directWalkSec: 2400, busName: '146' };
const close: TripOption = { ...red, routeLabel: 'Blue Day', boardStopId: 100,
  alightStopId: 97, walkToSec: 120, walkFromSec: 60, waitSec: 2400,
  rideSec: 600, totalSec: 3180, busName: '44' };
const farther: TripOption = { ...close, boardStopId: 129, walkToSec: 480,
  waitSec: 0, rideSec: 300, totalSec: 840, busName: '48' };
const blue = routePickupChoices([farther, close], 'planned');
const walk: TripOption = { ...red, mode: 'walk', routeLabel: 'Walk', boardStopId: -1,
  alightStopId: -1, walkToSec: 0, walkFromSec: 0, waitSec: 0, rideSec: 0, totalSec: 2400 };

describe('new route admission within an existing trip', () => {
  it('adds the fresh closest Blue and its earlier alternative without replacing Red or its catalog', () => {
    const redAlternative = { ...red, boardStopId: 49 };
    const originalRed = { ...red, pickupAlternatives: [redAlternative] };
    const plan = [walk, originalRed];
    const changedRed = { ...red, boardStopId: 50, busName: '999', pickupAlternatives: [] };
    const admitted = admitTripRoutes(plan, null, [changedRed, blue])!;
    const options = retainedTripRoutes(plan, admitted)!;
    expect(admitted.plan).toBe(plan);
    expect(options).toEqual([walk, originalRed, blue]);
    expect(options[1]).toBe(originalRed);
    expect(options[1]!.pickupAlternatives![0]).toBe(redAlternative);
    expect(options[2]).toBe(blue);
    expect(options[2]!.boardStopId).toBe(100);
    expect(options[2]!.pickupAlternatives![0]!.boardStopId).toBe(129);
    expect(plan).toEqual([walk, originalRed]);
  });

  it('retains the admitted line and both pickups when its bus disappears', () => {
    const plan = [red];
    const admitted = admitTripRoutes(plan, null, [red, blue])!;
    const missingBlue = admitTripRoutes(plan, admitted, [red]);
    expect(missingBlue).toBe(admitted);
    expect(retainedTripRoutes(plan, missingBlue)![1]).toBe(blue);
    expect(retainedTripRoutes(plan, missingBlue)![1]!.pickupAlternatives).toBe(blue.pickupAlternatives);
    expect(admitTripRoutes(plan, missingBlue, [])).toBe(admitted);
  });

  it('does not redirect an admitted pickup when a later plan favors another stop or bus', () => {
    const plan = [red];
    const admitted = admitTripRoutes(plan, null, [blue])!;
    const changedBlue = { ...blue, boardStopId: 72, busName: '45', pickupAlternatives: [] };
    expect(admitTripRoutes(plan, admitted, [changedBlue])).toBe(admitted);
    expect(retainedTripRoutes(plan, admitted)![1]).toBe(blue);
  });

  it('adds service to a walk-only plan without discarding the original walk', () => {
    const plan = [walk];
    const admitted = admitTripRoutes(plan, null, [walk, blue])!;
    expect(retainedTripRoutes(plan, admitted)).toEqual([walk, blue]);
    expect(retainedTripRoutes(plan, admitted)![0]).toBe(walk);
    expect(admitTripRoutes(plan, admitted, [walk])).toBe(admitted);
  });

  it('resets admissions for a genuinely new plan, even when its original choices are identical', () => {
    const plan = [red];
    const admitted = admitTripRoutes(plan, null, [blue])!;
    const nextPlan = [red];
    expect(retainedTripRoutes(nextPlan, admitted)).toBe(nextPlan);
    expect(admitTripRoutes(nextPlan, admitted, [red])).toBeNull();
    const nextAdmission = admitTripRoutes(nextPlan, admitted, [blue])!;
    expect(nextAdmission.plan).toBe(nextPlan);
    expect(nextAdmission.options).toEqual([red, blue]);
    expect(retainedTripRoutes(null, admitted)).toBeNull();
  });

  it('keeps the original catalog identity when fresh results add no route', () => {
    const plan = [walk, red];
    expect(admitTripRoutes(plan, null, [walk, { ...red, busName: '147' }])).toBeNull();
    expect(retainedTripRoutes(plan, null)).toBe(plan);
  });
});
