import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DestinationArrival, destinationArrivalView } from './DestinationArrival';
import { journeyArrival } from './journeyArrival';
import type { UpcomingArrival } from './arrivals';
import type { TripOption } from './planner';

const now = new Date(2026, 8, 18, 10, 0).getTime();
const row = (stopId: number, stopsAhead: number, eta: number, overrides: Partial<UpcomingArrival> = {}): UpcomingArrival => ({
  routeLabel: 'Red', color: '#f00', busName: '309', stopId, stopsAhead, eta, low: eta - 60, high: eta + 120,
  estimated: false, departNow: eta - 60, lowFloor: eta - 60, ...overrides,
});
const board = row(48, 2, 180);
const destination = row(121, 8, 600, { low: 461, high: 841 });
const option: TripOption = { mode: 'shuttle', routeLabel: 'Red', color: '#f00', busName: '307', boardStopId: 48,
  alightStopId: 121, walkToSec: 60, waitSec: 120, rideSec: 420, walkFromSec: 120, totalSec: 720, directWalkSec: 900,
  journeyArrival: journeyArrival(board, [board, row(121, 1, 60, { busName: '307' }), destination, row(121, 37, 3000)], 121, 60, 120, now),
};

describe('route card destination arrival', () => {
  it('uses the joined forward destination and final walk, not the countdown bus or pickup band', () => {
    const view = destinationArrivalView(option, now)!;
    expect(view.kind).toBe('window');
    expect(view.text).toBe('10:09a–10:17a'); // floor 9:41 and ceil 16:01
    expect(view.description).toContain('shuttle #309');
    expect(view.description).toContain('including the final walk');
    expect(view.description).toContain('earlier or later');
  });
  it('keeps both endpoints visible for narrow windows', () => {
    const arrival = { ...option.journeyArrival!, pointMs: now + 601_000, lowMs: now + 600_000, highMs: now + 602_000 };
    expect(destinationArrivalView({ ...option, journeyArrival: arrival }, now)?.text).toBe('10:10a–10:11a');
  });
  it('does not show a destination time for stale or departed shuttle options', () => {
    expect(destinationArrivalView({ ...option, etaUnavailable: true }, now)).toBeNull();
    expect(destinationArrivalView({ ...option, departed: true }, now)).toBeNull();
  });
  it('does not invent a window for walking, future departures or missing destination forecasts', () => {
    const walk = destinationArrivalView({ ...option, mode: 'walk' }, now)!;
    expect(walk).toMatchObject({ kind: 'point', text: '~10:12a' });
    expect(walk.description).toContain('on foot');
    const future = destinationArrivalView(option, now, now + 3600_000)!;
    expect(future).toMatchObject({ kind: 'point', text: '~11:12a' });
    expect(future.description).toContain('planned departure');
    expect(destinationArrivalView({ ...option, journeyArrival: undefined }, now)).toMatchObject({ kind: 'point', text: '~10:12a' });
    // Keep the existing point clock's minute bucket in sync with the map.
    expect(destinationArrivalView({ ...option, mode: 'walk', totalSec: 759 }, now)?.text).toBe('~10:12a');
  });
  it('retains catch and limited-data cautions without claiming absolute arrival limits', () => {
    const view = destinationArrivalView({ ...option, journeyArrival: { ...option.journeyArrival!, catchRisk: true, estimated: true } }, now)!;
    expect(view.description).toContain('could reach pickup before you');
    expect(view.description).toContain('Limited trip data');
    expect(view.description).not.toMatch(/earliest|latest|guarantee|80%/);
  });
  it('shows the date when a window crosses midnight', () => {
    const at = new Date(2026, 8, 18, 23, 50).getTime();
    const view = destinationArrivalView({ ...option, journeyArrival: {
      ...option.journeyArrival!, pointMs: at + 660_000, lowMs: at + 540_000, highMs: at + 900_000,
    } }, at)!;
    expect(view.text).toContain('11:59p–');
    expect(view.text).toContain('12:05a');
    expect(view.text).toContain(new Date(2026, 8, 19).toLocaleDateString([], { month: 'short', day: 'numeric' }));
  });
  it('labels the destination separately from pickup in visible and accessible text', () => {
    const html = renderToStaticMarkup(<DestinationArrival option={option} destination="Rosenkranz Hall" now={now} />);
    expect(html).toContain('At destination (est.)');
    expect(html).toContain('Estimated arrival at Rosenkranz Hall: 10:09a–10:17a');
  });
});
