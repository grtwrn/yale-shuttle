import { describe, expect, it } from 'vitest';
import { commuteSec, mostDirectOption, topVisibleOptions, type TripOption } from './planner';
import { preferredTripOrder, stableTripOrder, RANK_CHANGE_HOLD_MS } from './tripRanking';
import { savesWalking } from './walk';

const at = 1_700_000_000_000;
function route(label: string, walk: number, ride: number, low: number, high: number): TripOption {
  return { mode: 'shuttle', routeLabel: label, color: '#000', boardStopId: 1, alightStopId: 2,
    walkToSec: walk / 2, walkFromSec: walk / 2, rideSec: ride, plannedRideSec: ride,
    waitSec: 0, totalSec: (low + high) / 2, busName: '1', directWalkSec: 2400, computedAtMs: at,
    journeyArrival: { busName: '1', pointMs: at + (low + high) * 500, lowMs: at + low * 1000,
      highMs: at + high * 1000, catchRisk: false, estimated: false } };
}
const labels = (os: readonly TripOption[]) => os.map(o => o.routeLabel);

describe('useful route rankings', () => {
  it('prefers a short direct route through the reported ETA and live ride swings', () => {
    const red = route('Red', 60, 300, 120, 1500);
    const blue = route('Blue', 480, 600, 600, 1200);
    let state = null;
    for (const [i, total] of [900, 400, 1200, 149, 800].entries()) {
      const changed = { ...red, totalSec: total, rideSec: total / 2 };
      const result = stableTripOrder([blue, changed], state, at + i * 40_000);
      expect(labels(result.options)).toEqual(['Red', 'Blue']);
      expect(commuteSec(changed)).toBe(360);
      expect(mostDirectOption([blue, changed])?.routeLabel).toBe('Red');
      state = result.state;
    }
  });

  it('still favors a clearly earlier arrival over the shortest route', () => {
    const red = route('Red', 60, 300, 1200, 1800);
    const blue = route('Blue', 180, 600, 500, 700);
    expect(labels(preferredTripOrder([red, blue]))).toEqual(['Blue', 'Red']);
  });

  it('uses the pickup lower bound when the destination window is missing', () => {
    const red = { ...route('Red', 60, 300, 1200, 1800), journeyArrival: undefined, busLowSec: 2400 };
    const blue = route('Blue', 180, 600, 500, 700);
    expect(labels(preferredTripOrder([red, blue]))).toEqual(['Blue', 'Red']);
    // An unknown destination has no manufactured upper bound.
    expect(labels(preferredTripOrder([{ ...red, busLowSec: undefined }, blue]))).toEqual(['Red', 'Blue']);
  });

  it('handles overlapping chains without contradicting separated windows', () => {
    const late = route('Late', 0, 60, 2400, 3000);
    const broad = route('Broad', 0, 120, 300, 3000);
    const early = route('Early', 60, 600, 900, 1200);
    for (const input of [[late, broad, early], [early, broad, late], [broad, late, early]]) {
      expect(labels(preferredTripOrder(input))).toEqual(['Broad', 'Early', 'Late']);
    }
  });

  it('requires a persistent advantage and discards a one-poll reversal', () => {
    const red = route('Red', 60, 300, 120, 1500), blue = route('Blue', 180, 600, 600, 1200);
    const delayed = { ...red, journeyArrival: route('Red', 60, 300, 1500, 1800).journeyArrival };
    const start = stableTripOrder([red, blue], null, at);
    const blip = stableTripOrder([delayed, blue], start.state, at + 5000);
    expect(labels(blip.options)).toEqual(['Red', 'Blue']);
    const recovered = stableTripOrder([red, blue], blip.state, at + 10000);
    expect(recovered.state.pending).toBeUndefined();
    const pending = stableTripOrder([delayed, blue], recovered.state, at + 15000);
    expect(labels(stableTripOrder([delayed, blue], pending.state, at + 15000 + RANK_CHANGE_HOLD_MS).options))
      .toEqual(['Blue', 'Red']);
  });

  it('immediately demotes unavailable/departed routes and accepts roster changes', () => {
    const red = route('Red', 60, 300, 120, 1500), blue = route('Blue', 180, 600, 600, 1200);
    const first = stableTripOrder([red, blue], null, at);
    for (const unavailable of [{ ...red, departed: true }, { ...red, etaUnavailable: true }]) {
      expect(labels(stableTripOrder([unavailable, blue], first.state, at + 1).options)).toEqual(['Blue', 'Red']);
    }
    expect(labels(stableTripOrder([blue], first.state, at + 1).options)).toEqual(['Blue']);
  });

  it('keeps walking when its definite arrival precedes the bus window', () => {
    const red = route('Red', 60, 300, 1500, 1800);
    const walk: TripOption = { ...red, mode: 'walk', routeLabel: 'Walk', totalSec: 900 };
    expect(labels(preferredTripOrder([red, walk]))).toEqual(['Walk', 'Red']);
  });

  it('does not flash a third useful route as only its wait or live ride changes', () => {
    const a = route('A', 60, 300, 120, 1500), b = route('B', 120, 600, 600, 1200);
    const c = route('C', 120, 660, 600, 2000);
    for (const totalSec of [1200, 4000, 600, 3000]) {
      expect(labels(topVisibleOptions([a, b, { ...c, totalSec, rideSec: totalSec }])))
        .toEqual(['A', 'B', 'C']);
    }
  });
});

describe('walking benefit', () => {
  it('suppresses a 19-minute walk plus a bus when direct walking takes 20 minutes', () => {
    expect(savesWalking(1140, 1200)).toBe(false);
    expect(savesWalking(1080, 1200)).toBe(true);
    expect(savesWalking(1200, 1200)).toBe(false);
  });
  it('scales the minimum saving for shorter trips', () => {
    expect(savesWalking(250, 300)).toBe(false);
    expect(savesWalking(240, 300)).toBe(true);
    expect(savesWalking(0, 0)).toBe(false);
  });
  it('does not treat two minutes saved on a long walk as meaningful', () => {
    expect(savesWalking(28 * 60, 30 * 60)).toBe(false);
    expect(savesWalking(27 * 60, 30 * 60)).toBe(true);
  });
});
