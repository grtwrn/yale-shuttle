import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DestinationArrival, destinationArrivalView } from './DestinationArrival';
import { journeyArrival } from './journeyArrival';
import type { UpcomingArrival } from './arrivals';
import type { TripOption } from './planner';

// Instants, not device-local wall times: the clocks below are New Haven's
// whatever zone the test process (or the rider's phone) is set to.
const now = Date.parse('2026-09-18T10:00:00-04:00');
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

const OLD_TZ = process.env.TZ;
afterEach(() => { process.env.TZ = OLD_TZ; });

describe('route card destination arrival', () => {
  beforeEach(() => { process.env.TZ = 'America/New_York'; });
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
    expect(destinationArrivalView({ ...option, destinationEtaUnavailable: true }, now)).toBeNull();
  });
  it('does not invent a window for walking, future departures or missing destination forecasts', () => {
    const walk = destinationArrivalView({ ...option, mode: 'walk' }, now)!;
    expect(walk).toMatchObject({ kind: 'point', text: '~10:12a' });
    expect(walk.description).toContain('on foot');
    const future = destinationArrivalView(option, now, now + 3600_000)!;
    expect(future).toMatchObject({ kind: 'point', text: '~11:12a' });
    expect(future.description).toContain('planned departure');
    expect(destinationArrivalView({ ...option, journeyArrival: undefined }, now)).toMatchObject({ kind: 'unavailable', text: 'Arrival unavailable' });
    // Keep the existing point clock's minute bucket in sync with the map.
    expect(destinationArrivalView({ ...option, mode: 'walk', totalSec: 759 }, now)?.text).toBe('~10:12a');
  });
  it('does not turn a cached live ride into a new clock while the destination join is missing', () => {
    const originalAt = Date.parse('2026-10-30T09:07:13.627-04:00');
    const missing = { ...option, journeyArrival: undefined, rideSec: 1368, totalSec: 1368 };
    // The recorded Red124 replay retains this old ride duration when its
    // current pickup row is absent. A later render cannot refresh that price.
    for (const at of [originalAt + 4894, originalAt + 60000, originalAt + 120000]) {
      const view = destinationArrivalView(missing, at)!;
      expect(view).toMatchObject({ kind: 'unavailable', text: 'Arrival unavailable' });
      expect(view.text).not.toMatch(/\d:\d|~/);
    }
    const html = renderToStaticMarkup(<DestinationArrival option={missing} destination="344 Winchester" now={originalAt + 4894} compact />);
    expect(html).toContain('Arrival unavailable');
    expect(html).toContain('Arrival time at 344 Winchester unavailable');
    expect(html).not.toContain('~9:30');
  });
  it('withholds an expired joined live arrival instead of rolling the old total forward', () => {
    expect(destinationArrivalView(option, option.journeyArrival!.pointMs + 1)).toMatchObject({ kind: 'unavailable' });
  });
  it('keeps walking and planned-departure point clocks visible without a live journey window', () => {
    const walk = renderToStaticMarkup(<DestinationArrival option={{ ...option, mode: 'walk', journeyArrival: undefined }} destination="Class" now={now} compact />);
    const future = renderToStaticMarkup(<DestinationArrival option={{ ...option, journeyArrival: undefined }} destination="Class" now={now} departureMs={now + 3600_000} compact />);
    expect(walk).toContain('data-kind="point"');
    expect(walk).toContain('~10:12a');
    expect(future).toContain('data-kind="point"');
    expect(future).toContain('~11:12a');
    expect(walk + future).not.toContain('Arrival unavailable');
  });
  it('retains catch and limited-data cautions without claiming absolute arrival limits', () => {
    const view = destinationArrivalView({ ...option, journeyArrival: { ...option.journeyArrival!, catchRisk: true, estimated: true } }, now)!;
    expect(view.description).toContain('could reach pickup before you');
    expect(view.description).toContain('Limited trip data');
    expect(view.description).not.toMatch(/earliest|latest|guarantee|80%/);
  });
  it('shows the date when a window crosses midnight', () => {
    const at = Date.parse('2026-09-18T23:50:00-04:00');
    const view = destinationArrivalView({ ...option, journeyArrival: {
      ...option.journeyArrival!, pointMs: at + 660_000, lowMs: at + 540_000, highMs: at + 900_000,
    } }, at)!;
    expect(view.text).toContain('11:59p–');
    expect(view.text).toContain('12:05a');
    expect(view.text).toContain('Sep 19, 12:05a');
  });
  it('labels the destination separately from pickup in visible and accessible text', () => {
    const html = renderToStaticMarkup(<DestinationArrival option={option} destination="Rosenkranz Hall" now={now} />);
    expect(html).toContain('At destination');
    expect(html).toContain('Estimated arrival at Rosenkranz Hall: 10:09a–10:17a');
  });
});

describe('a phone set to another zone', () => {
  // The 2026-09-17 eval ran on a UTC browser and every trip clock read four
  // hours ahead of the Yale journey it described. The destination clock is
  // New Haven's: render it Eastern and say so.
  beforeEach(() => { process.env.TZ = 'UTC'; });

  it('still reads the destination window on the campus clock, labeled ET', () => {
    expect(destinationArrivalView(option, now)?.text).toBe('10:09a ET–10:17a ET');
    expect(destinationArrivalView({ ...option, mode: 'walk' }, now)?.text).toBe('~10:12a ET');
  });

  it('dates a window by the campus day, not the device day', () => {
    // 19:50 Eastern is 23:50 UTC: the window ends after UTC midnight but on
    // the same New Haven evening, so it carries no date.
    const at = Date.parse('2026-09-18T19:50:00-04:00');
    const view = destinationArrivalView({ ...option, journeyArrival: {
      ...option.journeyArrival!, pointMs: at + 660_000, lowMs: at + 540_000, highMs: at + 900_000,
    } }, at)!;
    expect(view.text).toBe('7:59p ET–8:05p ET');
  });

  it('keeps each clock and its zone label together when the window wraps', () => {
    const html = renderToStaticMarkup(<DestinationArrival option={option} destination="Rosenkranz Hall" now={now} />);
    expect(html).toContain('<span style="white-space:nowrap">10:09a ET</span>');
    expect(html).toContain('<span style="white-space:nowrap">10:17a ET</span>');
  });
});
