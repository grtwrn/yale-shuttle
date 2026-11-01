import { afterEach, describe, expect, it } from 'vitest';
import fixture from './__fixtures__/repeated-pickup-raw-override-20261024.json';
import { attachServerEta, serverArrivals } from './etaSource';
import { planTrip, rawAtStopBoardable, rideBoardArrivals } from './planner';
import { mergedRouteStops, ROUTE_LISTS } from './routes';
import { registerRoutePaths } from './anchor';
import { applyModelParams } from './eta/params';
import type { BusData } from './map-data';
import type { DwellTimes, SegmentTimes } from './arrivals';
import type { LatLon } from './geo';

afterEach(() => { registerRoutePaths(null); applyModelParams(undefined); });
const setup = (frame: typeof fixture.frames[number]) => {
  const p = frame.payload, buses = p.buses as BusData[], cfg = ROUTE_LISTS.find(c => c.label === frame.route)!;
  registerRoutePaths(Object.fromEntries(Object.entries(p.route_paths)
    .map(([id, points]) => [id, points.map(point => [point[0]!, point[1]!] as [number, number])])));
  applyModelParams(p.model_params);
  expect(attachServerEta(buses, p.server_eta, frame.at)).toBe(true);
  const bus = buses.find(b => b.bus_name === `#${frame.bus}`)!;
  expect(bus.at_stop_id).toBe(23);
  const stops = mergedRouteStops(cfg, p.routes);
  const visits = serverArrivals(buses, [23, 26], frame.at)!.filter(a => a.routeLabel === frame.route);
  return { p, buses, bus, stops, visits, context: { bus, routeLabel: frame.route, stops,
    stopCoords: p.stop_coords as Record<number, LatLon>, now: frame.at } };
};

describe('a short return to a repeated pickup is a different visit', () => {
  for (const frame of fixture.frames) {
    it(`${frame.route} #${frame.bus} frame ${frame.seq}: keeps the selected return visit despite a raw at-stop flag`, () => {
      const { visits, context } = setup(frame);
      const own = rideBoardArrivals(visits, 23, 26).filter(a => a.busName === frame.bus);
      expect(own[0]?.stopsAhead).toBe(2);
      expect(own[0]?.eta).toBeGreaterThan(180);
      expect(own[0]?.eta).toBeLessThan(300);
      expect(rawAtStopBoardable(frame.bus, 23, 26, visits, context)).toBe(false);
    });

    it(`${frame.route} frame ${frame.seq}: initial trip planning uses that same pickup visit`, () => {
      const { p, buses } = setup(frame);
      const coords = p.stop_coords as Record<number, LatLon>;
      const plans = planTrip(coords[23]!, coords[26]!, buses, p.routes, coords,
        p.segments as SegmentTimes, p.dwells as DwellTimes, null, frame.at);
      const trips = plans.flatMap(o => [o, ...(o.pickupAlternatives ?? [])]);
      const direct = trips.find(o => o.routeLabel === frame.route && o.boardStopId === 23 && o.alightStopId === 26);
      expect(direct).toBeDefined();
      expect(direct?.busName).toBe(frame.bus);
      expect(direct?.busEtaSec).toBeGreaterThan(180);
      expect(direct?.waitSec).toBeGreaterThan(180);
    });

    it(`${frame.route} frame ${frame.seq}: keeps boarding now for the intervening destination`, () => {
      const { buses, context } = setup(frame);
      const visits = serverArrivals(buses, [23, 22], frame.at)!.filter(a => a.routeLabel === frame.route);
      expect(rawAtStopBoardable(frame.bus, 23, 22, visits, context)).toBe(true);
    });
  }
});

describe('current-call evidence must be present and consistent', () => {
  const frame = fixture.frames[0]!;
  it('retains the existing fallback without a fresh, matching repeated current call', () => {
    const { bus, stops, visits, context } = setup(frame);
    expect(rawAtStopBoardable(frame.bus, 23, 26, visits)).toBe(true);
    for (const unknown of [
      { ...context, now: frame.at + 45_000 },
      { ...context, bus: { ...bus, bus_name: '#unknown' } },
      { ...context, routeLabel: 'Purple' },
      { ...context, bus: { ...bus, stationary: false } },
      { ...context, bus: { ...bus, at_stop_id: 22 } },
      { ...context, stops: [...new Set(stops)] },
    ]) expect(rawAtStopBoardable(frame.bus, 23, 26, visits, unknown)).toBe(true);
  });

  it('does not turn an approach or a different canonical call into a current pickup', () => {
    for (const change of ['approach', 'other-call'] as const) {
      const { p, buses, visits, context } = setup(frame);
      const wire = structuredClone(p.server_eta);
      const served = wire.buses.find(b => b[0] === frame.bus)!;
      if (change === 'approach') (served[3] as { approach: boolean }).approach = true;
      else wire.travel[wire.buses.indexOf(served)] = 12;
      expect(attachServerEta(buses, wire, frame.at)).toBe(true);
      expect(rawAtStopBoardable(frame.bus, 23, 26, visits, context)).toBe(true);
    }
  });

  it('keeps boarding when the destination or consistent visit ordering is unknown', () => {
    const { visits, context } = setup(frame);
    expect(rawAtStopBoardable(frame.bus, 23, 26, visits.filter(a => a.stopId === 23), context)).toBe(true);
    const inconsistent = visits.map(a => a.stopId === 26 ? { ...a, eta: 1 } : a);
    expect(rawAtStopBoardable(frame.bus, 23, 26, inconsistent, context)).toBe(true);
  });
});
