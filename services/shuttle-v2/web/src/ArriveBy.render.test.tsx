import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArriveBy } from './ArriveBy';
import { compareDeadline } from './arriveBy';
import { arrivalClock, localDateTime } from './journeyArrival';
import { topVisibleOptions, type TripOption } from './planner';
import { preferredTripOrder } from './tripRanking';

const now = Date.parse('2026-09-17T14:00:00-04:00');
function shuttle(routeLabel: string, busName: string, rideSec: number, highSec: number): TripOption {
  return { mode: 'shuttle', routeLabel, busName: 'previous-bus', color: '#f00', boardStopId: 48, alightStopId: 121,
    walkToSec: 60, waitSec: 300, rideSec, walkFromSec: 60, totalSec: rideSec + 420, directWalkSec: 1500, computedAtMs: now,
    journeyArrival: { busName, pointMs: now + (rideSec + 420) * 1000, lowMs: now + 300_000,
      highMs: now + highSec * 1000, catchRisk: false, estimated: false } };
}
const red = shuttle('Red', '309', 300, 1800);
const walk: TripOption = { ...red, mode: 'walk', routeLabel: 'Walk', totalSec: 1500, journeyArrival: undefined };
const blue = shuttle('Blue Day', '410', 650, 1100);
function render(options: TripOption[]) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const html = renderToStaticMarkup(<ArriveBy value={localDateTime(now + 1200_000)} onChange={() => {}}
    bufferMin={5} onBufferChange={() => {}} options={options} destination="Class" lastBusUpdateAt={now}
    busUpdateFailed={false} stopNames={{ 48: 'Winchester / Mansfield' }} onSelect={() => {}} />);
  return [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gs)].map(m => m[1].replace(/<[^>]*>/g, ''));
}
afterEach(() => vi.restoreAllMocks());

describe('rendered class advice keeps its supporting trip actionable', () => {
  it.each(['buffer', 'connection', 'limited'] as const)('shows the %s route outside the main visible slice with its own bus and window', kind => {
    const supporting = { ...blue, journeyArrival: { ...blue.journeyArrival!,
      catchRisk: kind === 'connection', estimated: kind === 'limited' } };
    const options = preferredTripOrder([red, shuttle('Green', '305', 400, 1800), shuttle('Brown', '507', 500, 1800), supporting, walk]);
    expect(topVisibleOptions(options).some(o => o.routeLabel === 'Blue Day')).toBe(false);
    const comparison = compareDeadline(options, now + 1200_000, 5, now, now, false);
    expect(comparison.shuttle?.option.routeLabel).toBe('Red');
    expect(comparison.recommendation).toBeUndefined();
    const buttons = render(options);
    const blueButtons = buttons.filter(b => b.startsWith('Blue Day'));
    expect(blueButtons).toHaveLength(1);
    expect(blueButtons[0]).toContain('#410');
    expect(blueButtons[0]).not.toContain('previous-bus');
    expect(blueButtons[0]).toContain(`${arrivalClock(supporting.journeyArrival.lowMs, 'low')}–${arrivalClock(supporting.journeyArrival.highMs, 'high')}`);
    expect(blueButtons[0]).toContain('View trip');
    expect(blueButtons[0]).toContain(kind === 'buffer' ? 'May use your buffer'
      : kind === 'connection' ? 'Connection uncertain' : 'Limited trip data');
    expect(buttons.slice(1).map(b => b.split(' · ')[0])).toEqual([
      expect.stringMatching(/^Red/), expect.stringMatching(/^Blue Day/), expect.stringMatching(/^Walk/),
    ]);
  });

  it('does not duplicate the selected shuttle or walking row when they support the advice', () => {
    for (const options of [[blue, walk], [red, { ...walk, totalSec: 1080 }]]) {
      const buttons = render(options);
      expect(buttons).toHaveLength(3); // Clear, one shuttle, one walk.
      expect(buttons.filter(b => b.startsWith('Walk'))).toHaveLength(1);
    }
  });
});
