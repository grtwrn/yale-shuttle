import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MiniMapKey } from './MiniMapKey';
import { bestRoutePickup, labelPickupChoices, routePickupChoices, type TripOption } from './planner';

const now = 1793365638521;
// Values read from the unchanged Red124 seq69278 current UI option: its last
// live ride was1368s, while the plan's route travel times total1217.1s.
const close: TripOption = { mode: 'shuttle', routeLabel: 'Red', color: '#c62828', busName: '124',
  boardStopId: 115, alightStopId: 11, walkToSec: 0, walkFromSec: 0, waitSec: 0,
  rideSec: 1368, plannedRideSec: 1217.1, totalSec: 1368, directWalkSec: 2400, computedAtMs: now,
  busEtaSec: 0, etaUnavailable: false, destinationEtaUnavailable: false };
const joined = (option: TripOption, seconds: number): TripOption => ({ ...option,
  journeyArrival: { busName: option.busName, pointMs: now + seconds * 1000,
    lowMs: now + (seconds - 60) * 1000, highMs: now + (seconds + 60) * 1000,
    catchRisk: false, estimated: false } });
const farther: TripOption = { ...close, boardStopId: 45, walkToSec: 300, walkToMeters: 400,
  rideSec: 300, plannedRideSec: 300, totalSec: 600, busName: '317', busEtaSec: 300 };
const render = (option: TripOption, departureMs?: number) => renderToStaticMarkup(
  <MiniMapKey rows={[{ option, status: 'At stop' }]} destination="344 Winchester" departureMs={departureMs} />);
afterEach(() => vi.restoreAllMocks());

describe('live route duration presentation', () => {
  it('qualifies the planned ride instead of recycling the old live ride through a missing join', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const html = render(close);
    expect(html).toContain('Typical ride ~20 min');
    expect(html).not.toContain('🚌 22 min');
    expect(html).toContain('Arrival unavailable');
  });
  it('keeps a valid live ride duration and future estimates', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    for (const html of [render(joined(close, 1368)), render(close, now + 3600_000)]) {
      expect(html).toContain('🚌 22 min');
      expect(html).not.toContain('Typical ride');
    }
  });
  it('withholds a ride duration when neither a current join nor a planned duration supports it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(render({ ...close, plannedRideSec: undefined })).toContain('Ride time unavailable');
    expect(render({ ...close, plannedRideSec: undefined })).not.toContain('🚌 22 min');
  });
});

describe('pickup comparisons have an explicit timing mode', () => {
  it('does not turn missing live destination evidence into an earlier-arrival claim', () => {
    expect(labelPickupChoices([farther, close], 'live').map(o => o.pickupPreference))
      .toEqual(['more-walking', 'closest-stop']);
    expect(labelPickupChoices([joined(farther, 600), close], 'live')[0]!.pickupPreference).toBe('more-walking');
    expect(labelPickupChoices([farther, joined(close, 1368)], 'live')[0]!.pickupPreference).toBe('more-walking');
    expect(labelPickupChoices([joined(farther, 600), joined(close, 1368)], 'live')[0]!.pickupPreference).toBe('arrive-sooner');
  });
  it('retains the existing planned departure comparison without live windows', () => {
    expect(labelPickupChoices([farther, close], 'planned')[0]!.pickupPreference).toBe('arrive-sooner');
    expect(routePickupChoices([close, farther], 'planned').pickupAlternatives?.[0]?.pickupPreference).toBe('arrive-sooner');
  });
  it('cannot use a cached total to eliminate a shorter-walking live choice with unknown arrival', () => {
    const cheapCached = { ...farther, totalSec: 1 };
    expect(bestRoutePickup([cheapCached, close], 'live')).toBe(close);
    expect(bestRoutePickup([cheapCached, close], 'planned')).toBe(cheapCached);
    expect(routePickupChoices([close, cheapCached], 'live').boardStopId).toBe(close.boardStopId);
  });
  it('keeps a known alternative separately when the closest pickup has no destination window', () => {
    const choice = routePickupChoices([close, joined(farther, 600)], 'live');
    expect(choice.boardStopId).toBe(close.boardStopId);
    expect(choice.pickupPreference).toBe('closest-stop');
    expect(choice.pickupAlternatives?.[0]).toMatchObject({ boardStopId: farther.boardStopId, pickupPreference: 'more-walking' });
  });
  it('reads current joined points for comparisons instead of an inconsistent cached total', () => {
    const liveClose = joined({ ...close, totalSec: 1 }, 1368);
    const liveFarther = joined({ ...farther, totalSec: 99999 }, 600);
    expect(labelPickupChoices([liveFarther, liveClose], 'live')[0]!.pickupPreference).toBe('arrive-sooner');
    expect(bestRoutePickup([liveFarther, liveClose], 'live')).toBe(liveFarther);
    expect(labelPickupChoices([liveFarther, { ...liveClose, journeyArrival: {
      ...liveClose.journeyArrival!, highMs: Number.NaN } }], 'live')[0]!.pickupPreference).toBe('more-walking');
  });
});
