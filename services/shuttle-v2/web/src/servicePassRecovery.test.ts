import { afterEach, describe, expect, it } from 'vitest';
import green from './__fixtures__/green-published-order.json';
import purple from './__fixtures__/purple-published-order.json';
import recovery from './__fixtures__/pink-service-pass-recovery-20261101.json';
import { registerRoutePaths } from './anchor';
import { ringForBus, type AnchorStore } from './eta';
import { attachServerEta, serverArrivals, type ServerEtaWire } from './etaSource';
import { observedAtStop, observedServiceAtStop, rideApproach, rideStopsToExit, serviceCallAllowed } from './liveAnchor';
import { isUnambiguousRideArrival, rideEvidence } from './rideArrival';
import { planTrip, rawAtStopBoardable } from './planner';
import { ROUTE_LISTS } from './routes';
import { transferPickup } from './transferPickup';
import type { BusData } from './map-data';
import type { LatLon } from './geo';
import type { UpcomingArrival } from './arrivals';
import type { TransferRidePath } from './transferPaths';

afterEach(() => registerRoutePaths(null));
const coordsOf = (fixture: { stopCoords: Record<string, number[]> }): Record<number, LatLon> =>
  Object.fromEntries(Object.entries(fixture.stopCoords).map(([id, c]) => [id, { lat: c[0]!, lon: c[1]! }]));
const coords: Record<number, LatLon> = recovery.stopCoords;
const routes = recovery.routeStops;
const pinkStops = routes['8'];
const cfg = ROUTE_LISTS.find(route => route.label === 'Pink')!;

// Original Oct30 #326 bus fixes, descriptors, travel indices and clocks.
// Fixture provenance records the explicit selected-bus index remapping.
const southFix = recovery.south.bus as BusData;
const northFix = recovery.north.bus as BusData;
function setup(fix: BusData, index: number, travel: number) {
  registerRoutePaths(recovery.routePaths as Record<string, [number, number][]>);
  const source = fix === southFix ? recovery.south : recovery.north;
  const buses = [{ ...fix }], bus = buses[0]!, now = source.receivedAt;
  const original = source.wire as unknown as ServerEtaWire;
  expect(original.buses[0]![2]).toBe(index);
  expect(original.travel![0]).toBe(travel);
  // Remove forecasts to exercise the raw recovery path; keep the original
  // bus descriptor/travel and clocks, which identify the actual traversal.
  const wire: ServerEtaWire = { v: 2, at: original.at, servedAt: original.servedAt,
    buses: structuredClone(original.buses), travel: [...original.travel!], rows: [] };
  expect(attachServerEta(buses, wire, now)).toBe(true);
  const context = { bus, routeLabel: cfg.label, stops: pinkStops, stopCoords: coords, now };
  return { bus, buses, wire, now, context };
}
const countArrival = (hops: number, count: number | null): UpcomingArrival => ({
  busName: '326', routeLabel: 'Pink', color: cfg.color, stopId: 110,
  stopsAhead: hops, serviceStopsAhead: count, eta: 1200, low: 900, high: 1500,
  departNow: 1200, lowFloor: 900, estimated: false,
});

describe('raw curb evidence cannot reopen a traversal-only pass', () => {
  it('counts to the correct visit using the original South and North published rows', () => {
    for (const [fix, index, travel, source, expected] of [
      [southFix, 9, 5, recovery.south, 4], [northFix, 8, 8, recovery.north, 0],
    ] as const) {
      const { bus, buses, now } = setup(fix, index, travel);
      expect(attachServerEta(buses, source.wire as unknown as ServerEtaWire, now)).toBe(true);
      const arrivals = serverArrivals(buses, [110], now)!;
      expect(arrivals).toHaveLength(4);
      expect(rideStopsToExit(bus, cfg, routes, coords, 110, arrivals, now)).toBe(expected);
      expect(rideApproach(bus, cfg, routes, coords, 110,
        arrivals.map(arrival => [arrival.stopsAhead, arrival.stopId] as [number, number]), now)?.length).toBe(expected);
    }
  });

  it('retains the South GPS marker while withholding current boarding and arrival zero', () => {
    const { bus, buses, now, context } = setup(southFix, 9, 5);
    expect(observedAtStop(bus, 110, coords)).toBe(true);
    expect(serviceCallAllowed(bus, 110, cfg.label, pinkStops, coords, now)).toBe(false);
    expect(observedServiceAtStop(bus, 110, cfg.label, pinkStops, coords, now)).toBe(false);
    expect(rawAtStopBoardable('326', 110, 59, [], context)).toBe(false);
    expect(rideApproach(bus, cfg, routes, coords, 110, [[6, 110]], now)).toEqual([109, 123, 125, 124]);
    expect(rideStopsToExit(bus, cfg, routes, coords, 110, [countArrival(6, 4)], now)).toBe(4);
    expect(isUnambiguousRideArrival(pinkStops, 110, 9, 9,
      serviceCallAllowed(bus, 110, cfg.label, pinkStops, coords, now))).toBe(false);
    expect(rideEvidence('rode', 9, 0, 9, pinkStops.length,
      serviceCallAllowed(bus, 110, cfg.label, pinkStops, coords, now))).toBe('rode');
    // The planner may retain an unavailable option; it cannot manufacture
    // a raw-current pickup from a marker the served pass does not serve.
    const plans = planTrip(coords[110]!, coords[59]!, buses, routes, coords, {}, {}, null, now);
    expect(plans.flatMap(option => [option, ...(option.pickupAlternatives ?? [])])
      .some(option => option.livePickupSelection?.boarding.source === 'raw-at-stop')).toBe(false);
    expect(bus.at_stop_id).toBe(110);
  });

  it('keeps North arrival and boarding while the model is one stop short of its primary curb', () => {
    const { bus, now, context } = setup(northFix, 8, 8);
    expect(observedServiceAtStop(bus, 110, cfg.label, pinkStops, coords, now)).toBe(true);
    expect(rawAtStopBoardable('326', 110, 59, [], context)).toBe(true);
    expect(rideApproach(bus, cfg, routes, coords, 110, [[1, 110]], now)).toEqual([]);
    expect(rideStopsToExit(bus, cfg, routes, coords, 110, [countArrival(1, 1)], now)).toBe(0);
    expect(isUnambiguousRideArrival(pinkStops, 110, 9, 9,
      serviceCallAllowed(bus, 110, cfg.label, pinkStops, coords, now))).toBe(true);
    expect(rideEvidence('rode', 9, 0, 9, pinkStops.length,
      serviceCallAllowed(bus, 110, cfg.label, pinkStops, coords, now))).toBe('reached');
  });

  it('keeps the ordinary future forecast when the raw South shortcut is rejected', () => {
    const { bus, buses, wire, now, context } = setup(southFix, 9, 5);
    wire.rows = [[0, 110, 1200, 900, 1500, 6, 0, 1200, 900]];
    expect(attachServerEta(buses, wire, now)).toBe(true);
    const future = serverArrivals(buses, [110], now)!;
    expect(future[0]).toMatchObject({ stopId: 110, stopsAhead: 6 });
    expect(future[0]!.eta).toBeCloseTo(1200 - (wire.servedAt - wire.at) / 1000, 9);
    expect(rawAtStopBoardable('326', 110, 59, future, context)).toBe(false);
    expect(bus.lat).toBe(southFix.lat);
  });

  it('requires fresh occurrence evidence without creating or advancing a local belief', () => {
    registerRoutePaths(recovery.routePaths as Record<string, [number, number][]>);
    const bus = { ...northFix }, now = northFix.observed_at! + 2000, store: AnchorStore = new Map();
    expect(observedAtStop(bus, 110, coords)).toBe(true);
    expect(serviceCallAllowed(bus, 110, cfg.label, pinkStops, coords, now, store)).toBe(false);
    expect(store.size).toBe(0);
    const active = setup(northFix, 8, 8);
    expect(serviceCallAllowed(active.bus, 110, cfg.label, pinkStops, coords, active.now + 45_000)).toBe(false);
    expect(observedAtStop(active.bus, 110, coords)).toBe(true);
  });

  it.each(['missing', 'empty', 'non-finite'] as const)('withholds raw South recovery when served travel is %s', change => {
    const { bus, buses, wire, now, context } = setup(southFix, 9, 5);
    if (change === 'missing') delete wire.travel;
    else wire.travel = change === 'empty' ? [] : [Number.NaN];
    expect(attachServerEta(buses, wire, now)).toBe(true);
    expect(observedAtStop(bus, 110, coords)).toBe(true);
    expect(serviceCallAllowed(bus, 110, cfg.label, pinkStops, coords, now)).toBe(false);
    expect(rawAtStopBoardable('326', 110, 59, [], context)).toBe(false);
    expect(rideApproach(bus, cfg, routes, coords, 110, [[6, 110]], now)).toBeNull();
    const legacy = countArrival(6, 4);
    delete legacy.serviceStopsAhead;
    expect(rideStopsToExit(bus, cfg, routes, coords, 110, [legacy], now)).toBeNull();
    expect(rideStopsToExit(bus, cfg, routes, coords, 110, [countArrival(0, 0)], now)).toBeNull();
    expect(isUnambiguousRideArrival(pinkStops, 110, 9, 9,
      serviceCallAllowed(bus, 110, cfg.label, pinkStops, coords, now))).toBe(false);
    expect(bus.at_stop_id).toBe(110);
  });

  it('does not authorize a raw override from unavailable geometry or malformed eligibility', () => {
    const { bus, now } = setup(northFix, 8, 8);
    // Populate the cache first: absence or corruption in the CURRENT
    // coordinates must not borrow a complete ring from a previous payload.
    expect(serviceCallAllowed(bus, 110, cfg.label, pinkStops, coords, now)).toBe(true);
    const missingIntermediate = { ...coords };
    delete missingIntermediate[123];
    const invalidCoordinates: Record<number, LatLon>[] = [
      {},
      missingIntermediate,
      { ...coords, 110: { ...coords[110]!, lat: Number.NaN } },
      { ...coords, 123: { ...coords[123]!, lon: Number.POSITIVE_INFINITY } },
      { ...coords, 110: { ...coords[110]!, lat: 91 } },
      { ...coords, 123: { ...coords[123]!, lon: 181 } },
    ];
    for (const current of invalidCoordinates) {
      expect(serviceCallAllowed(bus, 110, cfg.label, pinkStops, current, now)).toBe(false);
    }
    expect(serviceCallAllowed(bus, 110, cfg.label, pinkStops, coords, now)).toBe(true);
    const ring = ringForBus(bus, pinkStops, coords)!, original = ring.serviceEligible;
    try {
      ring.serviceEligible = [];
      expect(serviceCallAllowed(bus, 110, cfg.label, pinkStops, coords, now)).toBe(false);
    } finally { ring.serviceEligible = original; }
  });

  it('withholds an ambiguous nearest pass on a generic folded route', () => {
    const south = 41.29, north = 41.2902, west = -72.99, east = -72.95;
    registerRoutePaths({ '8': [[south, west], [south, east], [north, east], [north, west], [south, west]] });
    const stops = [1004, 1001, 1002, 1003];
    const points: Record<number, LatLon> = {
      1001: { lat: 41.2901, lon: -72.9890 }, 1002: { lat: south, lon: -72.9700 },
      1003: { lat: 41.2901, lon: -72.9505 }, 1004: { lat: north, lon: -72.9695 },
    };
    const buses: BusData[] = [{ ...northFix, ...points[1004]!, at_stop_id: 1004 }], now = northFix.observed_at!;
    // The apex is equally close in traversal hops to the added outbound
    // marker and its published return call; neither may win by array order.
    const wire: ServerEtaWire = { v: 2, at: now, servedAt: now,
      buses: [['326', 'Pink', 3, null]], travel: [3], rows: [] };
    expect(attachServerEta(buses, wire, now)).toBe(true);
    expect(serviceCallAllowed(buses[0]!, 1004, 'Pink', stops, points, now)).toBe(false);
    wire.buses = [['326', 'Pink', 0, null]];
    expect(attachServerEta(buses, wire, now)).toBe(true);
    expect(serviceCallAllowed(buses[0]!, 1004, 'Pink', stops, points, now)).toBe(true);
  });

  it('keeps an explicit unknown service count unknown without losing the future arrival', () => {
    const { bus, now } = setup(southFix, 9, 5);
    expect(rideStopsToExit(bus, cfg, routes, coords, 110, [countArrival(6, null)], now)).toBeNull();
  });
});

describe('service recovery preserves real calls and legacy handoffs', () => {
  for (const [label, routeId, fixture] of [['Green', 9, green], ['Purple', 10, purple]] as const) {
    it(`${label} retains raw recovery for its real SPUR station and repeated published calls`, () => {
      registerRoutePaths({ [routeId]: fixture.path as [number, number][] });
      const points = coordsOf(fixture);
      for (const stopId of [127, 23]) {
        const bus: BusData = { ...northFix, bus_name: '#test', route_id: routeId,
          ...points[stopId]!, at_stop_id: stopId };
        expect(serviceCallAllowed(bus, stopId, label, fixture.stops, points, northFix.observed_at!)).toBe(true);
        expect(observedServiceAtStop(bus, stopId, label, fixture.stops, points, northFix.observed_at!)).toBe(true);
        // Legacy ordinary/repeated/SPUR raw recovery does not require the
        // optional travel sidecar that is essential for a mixed twin target.
        const wire: ServerEtaWire = { v: 2, at: northFix.observed_at!, servedAt: northFix.observed_at!,
          buses: [['test', label, 0, null]], rows: [] };
        expect(attachServerEta([bus], wire, northFix.observed_at!)).toBe(true);
        expect(rawAtStopBoardable('test', stopId, stopId === 127 ? 72 : 22, [],
          { bus, routeLabel: label, stops: fixture.stops, stopCoords: points, now: northFix.observed_at! })).toBe(true);
      }
    });
  }

  it('uses the same guard for a saved transfer pickup, without removing the GPS bus', () => {
    const path: TransferRidePath = { routeLabel: 'Pink', color: cfg.color, routeId: '8',
      boardStopId: 110, alightStopId: 59, stops: [110, 59], plannedRideSec: 120 };
    const south = setup(southFix, 9, 5);
    expect(transferPickup(path, south.buses, 0, south.now, true, '326', {},
      { routeStops: routes, stopCoords: coords }).selection).toBeUndefined();
    expect(south.buses).toHaveLength(1);
    const north = setup(northFix, 8, 8);
    expect(transferPickup(path, north.buses, 0, north.now, true, '326', {},
      { routeStops: routes, stopCoords: coords }).selection?.boarding.source).toBe('raw-at-stop');
  });
});
