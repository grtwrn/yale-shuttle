import { describe, expect, it } from 'vitest';
import { findTransferPaths, type TransferPathInputs } from './transferPaths';
import { haversineMeters } from './geo';
import type { RouteListConfig } from './routes';

const point = (north: number, east = 0) => ({ lat: 41.31 + north / 111_320, lon: -72.93 + east / 83_600 });
const cfg = (id: string, label: string): RouteListConfig => ({ routeIds: [id], busRouteIds: [Number(id)], label, color: '#123456' });
function input(): TransferPathInputs {
  return { from: point(0), to: point(2000),
    routeConfigs: [cfg('1', 'A'), cfg('2', 'B')],
    routeStops: { '1': [1, 2, 3, 4], '2': [5, 6, 7, 8] },
    stopCoords: { 1: point(0), 2: point(500), 3: point(1000), 4: point(500, 800),
      5: point(1010), 6: point(1500), 7: point(2000), 8: point(1500, 800) },
    segmentTimes: { '1': { '1-2': { avg: 100, n: 10 }, '2-3': { avg: 100, n: 10 } },
      '2': { '5-6': { avg: 100, n: 10 }, '6-7': { avg: 100, n: 10 } } } };
}
const desired = (i: TransferPathInputs) => findTransferPaths(i).find(p => p.first.routeLabel === 'A'
  && p.first.boardStopId === 1 && p.first.alightStopId === 3
  && p.second.routeLabel === 'B' && p.second.boardStopId === 5 && p.second.alightStopId === 7);

describe('transfer route connections', () => {
  it('finds a two-bus path that saves walking, keeping each ride and the connecting walk separate', () => {
    const p = desired(input());
    expect(p).toBeDefined();
    expect(p!.first.stops).toEqual([1, 2, 3]);
    expect(p!.second.stops).toEqual([5, 6, 7]);
    expect(p!.first.plannedRideSec).toBe(200);
    expect(p!.second.plannedRideSec).toBe(200);
    expect(p!.walkToSec).toBe(0); expect(p!.walkFromSec).toBe(0);
    expect(p!.transferWalkSec).toBeGreaterThan(8); expect(p!.transferWalkSec).toBeLessThan(10);
    expect(p!).not.toHaveProperty('busName');
    expect(p!).not.toHaveProperty('arrival');
  });
  it('accepts a change at a shared stop with no invented walking leg', () => {
    const i = input(); i.routeStops['2'] = [3, 6, 7, 8];
    const p = findTransferPaths(i).find(p => p.first.boardStopId === 1 && p.first.alightStopId === 3
      && p.second.boardStopId === 3 && p.second.alightStopId === 7);
    expect(p?.transferWalkSec).toBe(0);
  });
  it('applies the connecting-walk limit to the actual two stops, including its boundary', () => {
    const i = input(); i.maxTransferWalkM = haversineMeters(i.stopCoords[3]!, i.stopCoords[5]!);
    expect(desired(i)).toBeDefined();
    i.maxTransferWalkM -= 0.01;
    expect(desired(i)).toBeUndefined();
  });
  it('does not recommend riding a shuttle and changing back to the same line', () => {
    const i = input(); i.routeConfigs = [cfg('1', 'A')];
    expect(findTransferPaths(i)).toEqual([]);
  });
  it('drops a first ride when walking straight to the same second pickup is already easier', () => {
    const i = input(); i.stopCoords[5] = point(0);
    expect(desired(i)).toBeUndefined();
  });
  it('drops a second ride when walking from the first exit is already easier', () => {
    const i = input(); i.stopCoords[3] = point(2000); i.stopCoords[5] = point(1990);
    expect(desired(i)).toBeUndefined();
  });
  it('uses the same meaningful walking savings as the single-bus planner', () => {
    const i = input();
    i.stopCoords[1] = point(900); i.stopCoords[2] = point(950);
    i.stopCoords[5] = point(1010); i.stopCoords[6] = point(1050); i.stopCoords[7] = point(1100);
    // Both rides individually reduce walking, but together save only190m
    // of the2km direct walk, below the shared10% minimum.
    expect(desired(i)).toBeUndefined();
  });
  it('caps each forward ride at the existing single-ride limit without cutting another leg', () => {
    const i = input(); i.segmentTimes['1']!['1-2']!.avg = 500; i.segmentTimes['1']!['2-3']!.avg = 1000;
    expect(desired(i)?.first.plannedRideSec).toBe(1500);
    i.segmentTimes['1']!['2-3']!.avg = 1001;
    expect(desired(i)).toBeUndefined();
  });
  it('walks forward around a circular route when the pickup is late in its array', () => {
    const i = input(); i.from = point(1000); i.routeStops['1'] = [1, 2, 3];
    i.routeStops['2'] = [2, 6, 7];
    expect(findTransferPaths(i).some(p => p.first.boardStopId === 3 && p.first.alightStopId === 2
      && p.first.stops.join(',') === '3,1,2' && p.second.alightStopId === 7)).toBe(true);
  });
  it('preserves repeated intermediate calls but does not ride past the next pickup visit', () => {
    const i = input(); i.routeStops['1'] = [1, 2, 3, 2, 4]; i.routeStops['2'] = [4, 6, 7];
    const paths = findTransferPaths(i);
    expect(paths.some(p => p.first.stops.join(',') === '1,2,3,2,4')).toBe(true);
    expect(paths.some(p => p.first.stops.join(',') === '2,3,2,4')).toBe(false);
    expect(paths.some(p => p.first.stops.join(',') === '2,4')).toBe(true);
  });
  it('keeps deterministic distinct paths and never edits the supplied network', () => {
    const i = input(), before = structuredClone(i);
    const a = findTransferPaths(i), b = findTransferPaths(i);
    expect(a.length).toBeGreaterThan(1);
    expect(a).toEqual(b); expect(new Set(a.map(p => p.key)).size).toBe(a.length);
    expect(i).toEqual(before);
  });
  it('falls back to route geometry for unmeasured hops without inventing an arrival time', () => {
    const i = input(); i.segmentTimes = {};
    expect(desired(i)?.first.plannedRideSec).toBeGreaterThan(100);
    expect(desired(i)?.first.plannedRideSec).toBeLessThan(200);
  });
  it('omits paths whose boarding or exit stop coordinates are unavailable', () => {
    const i = input(); delete i.stopCoords[5];
    expect(desired(i)).toBeUndefined();
  });
  it.each([NaN, Infinity, -1])('rejects an invalid connecting-walk bound: %s', value => {
    const i = input(); i.maxTransferWalkM = value;
    expect(findTransferPaths(i)).toEqual([]);
  });
  it('rejects invalid endpoints without guessing a campus location', () => {
    const i = input(); i.from.lat = NaN;
    expect(findTransferPaths(i)).toEqual([]);
  });
});
