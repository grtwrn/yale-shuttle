import { describe, expect, it } from 'vitest';
import { planTrip } from './planner';
import type { PublishedWindow } from './schedule';

const now = Date.UTC(2026, 9, 18, 16);
const coords = { 1: { lat: 41.31, lon: -72.93 }, 2: { lat: 41.319, lon: -72.93 }, 3: { lat: 41.328, lon: -72.93 } };
const hours: Record<string, PublishedWindow> = { '3': { days: [1, 2, 3, 4, 5], startMin: 420, endMin: 1080, text: '7am - 6pm, M - F' } };
function plans(depart: string, from = coords[1], published: Record<string, PublishedWindow> | undefined = hours) {
  return planTrip(from, coords[3], [], { '3': [1, 2, 3] }, coords,
    { '3': { '1-2': { avg: 100, n: 10 }, '2-3': { avg: 100, n: 10 } } }, {},
    new Date(depart), now, undefined, published).filter(p => p.mode === 'shuttle');
}

describe('future pickup hours shared with transfer planning', () => {
  it('uses the published close for an unobserved future pickup rather than the wider live-bus gate', () => {
    expect(plans('2026-10-19T22:30:00Z')).toEqual([]); //18:30ET, Red published close18:00
  });
  it('checks the expected pickup after the typical wait crosses closing', () => {
    expect(plans('2026-10-19T21:58:00Z')).toEqual([]);
  });
  it('includes the initial walk before testing the pickup against closing', () => {
    expect(plans('2026-10-19T21:45:00Z', { lat: 41.301, lon: -72.93 })).toEqual([]);
  });
  it('allows a boarded bus to finish its ride after closing', () => {
    const list = plans('2026-10-19T21:55:00Z');
    expect(list).toHaveLength(1); expect(list[0]!.boardStopId).toBe(1);
    expect(list[0]!.totalSec).toBeGreaterThan(5 * 60);
  });
  it('can reach a pickup that opens while the rider waits or walks', () => {
    expect(plans('2026-10-19T10:58:00Z')).toHaveLength(1); //pickup07:02ET
  });
  it('uses published operating days at the actual future pickup', () => {
    expect(plans('2026-10-20T16:00:00Z', coords[1], { '3': { ...hours['3']!, days: [1] } })).toEqual([]);
  });
  it('retains the established fallback when no published description was supplied', () => {
    expect(plans('2026-10-19T22:30:00Z', coords[1], {})).toHaveLength(1);
  });
});
