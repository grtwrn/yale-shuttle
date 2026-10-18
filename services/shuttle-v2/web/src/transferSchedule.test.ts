import { describe, expect, it } from 'vitest';
import { planScheduledTransfers } from './transferSchedule';
import type { TransferPath } from './transferPaths';
import type { PublishedWindow } from './schedule';
const now = Date.UTC(2026, 9, 18, 16), depart = Date.UTC(2026, 9, 19, 16);
function path(): TransferPath {
  return { key: 'Red-to-Orange',
    first: { routeLabel: 'Red', color: '#123456', routeId: '3', boardStopId: 1, alightStopId: 3, stops: [1, 2, 3], plannedRideSec: 200 },
    second: { routeLabel: 'Orange Day', color: '#654321', routeId: '2', boardStopId: 4, alightStopId: 6, stops: [4, 5, 6], plannedRideSec: 200 },
    walkToSec: 100, transferWalkSec: 60, walkFromSec: 120, directWalkSec: 1800 };
}
const hours: Record<string, PublishedWindow> = {
  '3': { days: [1, 2, 3, 4, 5], startMin: 420, endMin: 1080 },
  '2': { days: [1, 2, 3, 4, 5], startMin: 360, endMin: 1080 },
  '14': { days: [0, 1, 2, 3, 4, 5, 6], startMin: 1080, endMin: 1440 },
};

describe('explicit future transfer plans', () => {
  it('keeps typical waits, rides, walks and changing time separate without assigning live buses', () => {
    const [trip] = planScheduledTransfers([path()], depart, now, hours);
    expect(trip?.timing).toBe('typical');
    expect(trip?.first).toMatchObject({ busName: null, pickupAtMs: depart + 340_000, alightAtMs: depart + 540_000, waitSec: 240 });
    expect(trip?.second).toMatchObject({ busName: null, pickupAtMs: depart + 960_000, alightAtMs: depart + 1_160_000, waitSec: 300 });
    expect(trip?.changeSec).toBe(60);
    expect(trip?.arrivalAtMs).toBe(depart + 1_280_000); expect(trip?.totalSec).toBe(1280);
    expect(trip).not.toHaveProperty('confidenceHighSec');
  });
  it('omits a first pickup whose walk and typical wait extend beyond published closing', () => {
    expect(planScheduledTransfers([path()], Date.parse('2026-10-19T21:58:00Z'), now, hours)).toEqual([]);
  });
  it('checks the second pickup at transfer time even if the route is running at departure', () => {
    expect(planScheduledTransfers([path()], Date.parse('2026-10-19T21:50:00Z'), now, hours)).toEqual([]);
  });
  it('can connect to an evening route that begins after the first leg starts', () => {
    const p = path(); p.second.routeLabel = 'Orange Night'; p.second.routeId = '14';
    const [trip] = planScheduledTransfers([p], Date.parse('2026-10-19T21:50:00Z'), now, hours);
    expect(trip).toBeDefined(); expect(trip!.first.pickupAtMs).toBeLessThan(Date.parse('2026-10-19T22:00:00Z'));
    expect(trip!.second.pickupAtMs).toBeGreaterThan(Date.parse('2026-10-19T22:00:00Z'));
  });
  it('allows the second bus to finish after closing when boarding was within its window', () => {
    const p = path(); p.second.plannedRideSec = 1200;
    const [trip] = planScheduledTransfers([p], Date.parse('2026-10-19T21:40:00Z'), now, hours);
    expect(trip).toBeDefined(); expect(trip!.second.pickupAtMs).toBeLessThan(Date.parse('2026-10-19T22:00:00Z'));
    expect(trip!.arrivalAtMs).toBeGreaterThan(Date.parse('2026-10-19T22:00:00Z'));
  });
  it('respects the service calendar even when the structural grocery route remains in a feed', () => {
    const p = path(); p.second.routeLabel = 'Grocery TJ'; p.second.routeId = '5';
    expect(planScheduledTransfers([p], Date.parse('2026-10-24T16:00:00Z'), now, {
      '3': { days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 },
      '5': { days: [0, 6], startMin: 420, endMin: 1020 },
    })).toEqual([]);
  });
  it('handles service across midnight with the existing Eastern-time calendar', () => {
    const p = path(); p.first.routeLabel = 'Blue Night'; p.first.routeId = '13';
    p.second.routeLabel = 'Orange Night'; p.second.routeId = '14';
    expect(planScheduledTransfers([p], Date.parse('2026-10-20T03:30:00Z'), now)).toHaveLength(1);
  });
  it.each([NaN, Infinity, now, now - 1])('does not use invalid or past departures as a live fallback: %s', at => {
    expect(planScheduledTransfers([path()], at, now, hours)).toEqual([]);
  });
  it('leaves both routes and their shared path untouched', () => {
    const p = path(), before = structuredClone(p);
    planScheduledTransfers([p], depart, now, hours);
    expect(p).toEqual(before);
  });
});
