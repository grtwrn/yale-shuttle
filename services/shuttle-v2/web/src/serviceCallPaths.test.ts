import { afterEach, describe, expect, it } from 'vitest';
import { alignStopsToPath } from '../../src/network/alignStops';
import green from './__fixtures__/green-published-order.json';
import purple from './__fixtures__/purple-published-order.json';
import { registerRoutePaths } from './anchor';
import { ringForBus } from './eta';
import { attachServerEta, type ServerEtaWire } from './etaSource';
import type { LatLon } from './geo';
import { rideApproach, rideCalls, rideStopsToExit, serviceCallSequence } from './liveAnchor';
import type { BusData } from './map-data';
import { isUnambiguousRideArrival, rideEvidence } from './rideArrival';
import { ROUTE_LISTS } from './routes';

afterEach(() => registerRoutePaths(null));
const now = Date.parse('2026-10-30T14:00:00Z');
const coordsOf = (fixture: { stopCoords: Record<string, number[]> }): Record<number, LatLon> =>
  Object.fromEntries(Object.entries(fixture.stopCoords).map(([id, c]) => [id, { lat: c[0]!, lon: c[1]! }]));
const track = (label: string, routeId: number, point: LatLon, index: number, travel: number, stationary = false, stopId?: number) => {
  const bus: BusData = { bus_id: 1, bus_name: '#proof', route_id: routeId, ...point,
    heading: 0, last_stop_id: stopId ?? 0, stationary, ...(stopId === undefined ? {} : { at_stop_id: stopId }), observed_at: now };
  const wire: ServerEtaWire = { v: 2, at: now, servedAt: now,
    buses: [['proof', label, index, null]], travel: [travel], rows: [] };
  expect(attachServerEta([bus], wire, now)).toBe(true);
  return bus;
};

describe('current exit and next pickup are different service visits', () => {
  for (const [label, routeId, fixture, board, index, lap] of [
    ['Purple', 10, purple, 1, 2, [1, 122, 127, 26, 25, 24, 23, 22, 23, 24, 25, 26, 127, 72, 10, 9]],
    ['Green', 9, green, 24, 16, [24, 25, 26, 127, 80, 91, 87, 78, 84, 89, 77, 94, 143, 144, 133, 88, 92, 81, 127, 26, 25, 23, 22, 23]],
  ] as const) {
    it(`${label} counts the real station SPUR on the next lap and retains current exit zero`, () => {
      registerRoutePaths({ [routeId]: fixture.path as [number, number][] });
      const coords = coordsOf(fixture), routes = { [routeId]: fixture.stops };
      const cfg = ROUTE_LISTS.find(c => c.label === label)!;
      const bus = track(label, routeId, coords[board]!, index, index);
      const calls = serviceCallSequence(bus, fixture.stops, coords)!;
      // Independent fixture order contains BOTH station calls: outbound
      // 81→127→26 on Green and return 26→127→72 on Purple.
      expect(calls.filter(id => id === 127)).toHaveLength(2);
      expect(lap).toHaveLength(fixture.stops.length + 1);
      expect(rideApproach(bus, cfg, routes, coords, board, [[lap.length, board]], now)).toEqual(lap);
      expect(rideApproach(bus, cfg, routes, coords, board, [[lap.length, board]], now, undefined, false)).toEqual([]);
      expect(rideApproach(bus, cfg, routes, coords, board, [[1, board]], now)).toEqual([]);
      expect(rideStopsToExit(bus, cfg, routes, coords, board,
        [{ stopId: board, stopsAhead: lap.length, serviceStopsAhead: lap.length }], now)).toBe(0);
    });
  }

  for (const [label, routeId, fixture, index, travel, later] of [
    ['Green', 9, green, 18, 10, 9], ['Purple', 10, purple, 4, 13, 6],
  ] as const) {
    it(`${label} does not collapse the station's later return to the current physical marker`, () => {
      registerRoutePaths({ [routeId]: fixture.path as [number, number][] });
      const coords = coordsOf(fixture), routes = { [routeId]: fixture.stops };
      const cfg = ROUTE_LISTS.find(c => c.label === label)!;
      const bus = track(label, routeId, coords[127]!, index, travel, true, 127);
      const calls = serviceCallSequence(bus, fixture.stops, coords)!;
      expect(calls.filter(id => id === 127)).toHaveLength(2);
      expect(isUnambiguousRideArrival(calls, 127, 0, 0, true)).toBe(false);
      const count = rideStopsToExit(bus, cfg, routes, coords, 127,
        [{ stopId: 127, stopsAhead: later, serviceStopsAhead: later }], now);
      expect(count).toBe(later);
      expect(rideEvidence('rode', 0, 1, 0, calls.length, count === 0)).toBe('rode');
      expect(rideStopsToExit(bus, cfg, routes, coords, 127,
        [{ stopId: 127, stopsAhead: 1, serviceStopsAhead: 1 }], now)).toBe(0);
    });
  }
});

it('keeps a real SPUR in ride calls even when every published stop is unique', () => {
  const lat = 41.29, west = -72.99, east = -72.95;
  const path: [number, number][] = [[lat, west], [lat, east], [lat + .0002, east], [lat + .0002, west], [lat, west]];
  const stops = [1001, 1002, 1003];
  const coords: Record<number, LatLon> = {
    1001: { lat, lon: west }, 1002: { lat: lat + .0001, lon: (west + east) / 2 }, 1003: { lat, lon: east },
  };
  const aligned = alignStopsToPath(path, stops.map(id => coords[id]!))!;
  expect(aligned.origins).toEqual(['published', 'published', 'published', 'spur']);
  expect(aligned.order.map(i => stops[i])).toEqual([1001, 1002, 1003, 1002]);
  registerRoutePaths({ '8': path });
  const cfg = ROUTE_LISTS.find(c => c.label === 'Pink')!;
  const bus = track(cfg.label, 8, coords[1003]!, 2, 2);
  expect(ringForBus(bus, stops, coords)!.serviceEligible).toEqual([true, true, true, true]);
  expect(rideCalls(cfg, { '8': stops }, coords, 1003, 1001)).toEqual([1003, 1002, 1001]);
  expect(rideApproach(bus, cfg, { '8': stops }, coords, 1001, [[2, 1001]], now)).toEqual([1003, 1002]);
});
