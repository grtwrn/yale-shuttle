import { describe, expect, it } from 'vitest';
import { calendarAllows, groceryServiceNotice, isRouteScheduledAt, nextWindowStart, routeDiscontinuedAt, ROUTE_CALENDAR, ROUTE_HOURS, serviceStateAt } from './schedule';
import { findPotentialRoutes, routeHoursCaption } from './planner';

const saturday = new Date('2026-09-19T10:00:00-04:00');
const ham = ROUTE_HOURS['Grocery Ham'];
const tj = ROUTE_HOURS['Grocery TJ'];

describe('grocery transition on September 19, 2026 in Eastern Time', () => {
  it('switches at Eastern midnight, rather than UTC midnight', () => {
    const before = new Date('2026-09-19T03:59:59Z');
    const after = new Date('2026-09-19T04:00:00Z');
    expect(routeDiscontinuedAt('Grocery TJ', before)).toBe(false);
    expect(routeDiscontinuedAt('Grocery TJ', after)).toBe(true);
    expect(groceryServiceNotice('Grocery Ham', before)).toMatch(/^From Sep 19/);
    expect(groceryServiceNotice('Grocery Ham', after)).toMatch(/^Hamden is the main/);
    expect(groceryServiceNotice('Grocery TJ', after)).toMatch(/Milford service ended/);
    expect(groceryServiceNotice('Red', after)).toBeNull();
  });

  it('does not advertise Milford again, including off hours or stale active flags', () => {
    for (const at of [saturday, new Date('2026-09-21T12:00:00-04:00'), new Date('2026-09-26T10:00:00-04:00')]) {
      const state = serviceStateAt(tj, 'Grocery TJ', at, { now: at, labels: new Set(['Grocery TJ']), active: true });
      expect(state).toEqual({ open: false, off: { partner: null, discontinued: true }, next: null });
      expect(isRouteScheduledAt('Grocery TJ', at)).toBe(false);
    }
    expect(serviceStateAt(undefined, 'Grocery TJ', saturday).off?.discontinued).toBe(true);
    expect(nextWindowStart(tj, new Date('2026-09-18T12:00:00-04:00'), ROUTE_CALENDAR['Grocery TJ'])).toBeNull();
  });

  it('keeps Hamden available on both later weekends without an obsolete partner', () => {
    for (const day of ['2026-09-19', '2026-09-20', '2026-09-26', '2026-09-27']) {
      const at = new Date(`${day}T10:00:00-04:00`);
      expect(serviceStateAt(ham, 'Grocery Ham', at, { now: at, labels: new Set(['Grocery TJ']) }).open).toBe(true);
      expect(isRouteScheduledAt('Grocery Ham', at)).toBe(true);
      expect(serviceStateAt(ham, 'Grocery Ham', at, { now: at, labels: new Set(), active: false }).off).toEqual({ partner: null });
    }
    expect(isRouteScheduledAt('Grocery Ham', new Date('2026-09-21T10:00:00-04:00'))).toBe(false);
    expect(calendarAllows(ROUTE_CALENDAR['Grocery Ham'], new Date('2026-12-26T10:00:00-05:00'))).toBe(false);
  });

  it('planned-trip captions and fallback cards show retirement rather than another start', () => {
    const config = { label: 'Grocery TJ', routeIds: ['6'], busRouteIds: [6] };
    const published = { '6': { days: [0, 6], startMin: 7 * 60, endMin: 17 * 60 } };
    expect(routeHoursCaption(config, published, saturday)).toMatch(/discontinued/);
    expect(routeHoursCaption(config, published, new Date('2026-09-12T10:00:00-04:00'))).toMatch(/^Runs/);
    const coords = { 30: { lat: 41.315, lon: -72.922 }, 119: { lat: 41.251375, lon: -73.018082 } };
    const potential = findPotentialRoutes(coords[30], coords[119], { '6': [30, 119] }, coords, saturday, published);
    const milford = potential.find(p => p.label === 'Grocery TJ');
    expect(milford).toMatchObject({ activeNow: false, nextActive: null, schedule: '', off: { discontinued: true } });
    expect(milford?.note).toMatch(/Use Grocery Ham/);
    expect(milford?.note).not.toMatch(/FlexiStop/);
  });
});
