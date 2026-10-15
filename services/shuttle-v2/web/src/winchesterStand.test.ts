import { afterEach, describe, expect, it } from 'vitest';
import { attachServerEta, serverArrivals, serverTrack, type ServerEtaWire } from './etaSource';
import { anchorIndexOnList, observedAtStop, rideApproach } from './liveAnchor';
import type { BusData } from './map-data';
import { boardHops } from './planner';
import { mergedRouteStops, ROUTE_LISTS } from './routes';
import { registerRoutePaths } from './anchor';
import fixture from './__fixtures__/red-winchester-report-142.json';

const cfg = ROUTE_LISTS.find(c => c.label === 'Red')!;
const now = fixture.receivedAt;
const snapshot = () => {
  const feed = structuredClone(fixture.feed) as unknown as Omit<typeof fixture.feed, 'server_eta' | 'route_paths'>
    & { server_eta: ServerEtaWire; route_paths: Record<string, [number, number][]> };
  registerRoutePaths(feed.route_paths);
  const buses = feed.buses as BusData[];
  expect(attachServerEta(buses, feed.server_eta, now)).toBe(true);
  const bus = buses.find(b => b.bus_name === '#317')!;
  const seq = mergedRouteStops(cfg, feed.routes);
  return { feed, buses, bus, seq };
};
afterEach(() => registerRoutePaths(null));

describe('report 142: Red standing at Winchester with a held College/Wall lead', () => {
  it('shows three approach stops from the confirmed stand, matching the existing pickup forecast', () => {
    const { feed, buses, bus, seq } = snapshot();
    expect(serverTrack(bus, 'Red', now)?.index).toBe(6); // held lead at College / Wall (N)
    expect(observedAtStop(bus, 11, feed.stop_coords)).toBe(true);
    const arrivals = serverArrivals(buses, [48, 4], now)!;
    const board = arrivals.find(a => a.busName === '317' && a.stopId === 48)!;
    expect(board.stopsAhead).toBe(3);
    const before = structuredClone(feed.server_eta);
    expect(rideApproach(bus, cfg, feed.routes, feed.stop_coords, 48, boardHops(board, arrivals, 48, 4), now))
      .toEqual([11, 146, 49]);
    expect(seq[anchorIndexOnList(bus, cfg, feed.routes, feed.stop_coords, seq, now)]).toBe(11);
    expect(feed.server_eta).toEqual(before); // the forecast stays authoritative
  });

  it.each([
    ['moving', { stationary: false }],
    ['left the curb', { lat: 41.31, lon: -72.92 }],
    ['different stop', { at_stop_id: 41 }],
  ] as const)('does not use a stale stop flag when %s', (_, change) => {
    const { feed, bus, seq } = snapshot(); Object.assign(bus, change);
    expect(anchorIndexOnList(bus, cfg, feed.routes, feed.stop_coords, seq, now)).toBe(6);
  });

  it('requires a confirmed stand, rather than the model approaching a stop', () => {
    const { feed, bus, seq } = snapshot();
    feed.server_eta.buses[0]![3]!.approach = true;
    attachServerEta(feed.buses as BusData[], feed.server_eta, now);
    expect(anchorIndexOnList(bus, cfg, feed.routes, feed.stop_coords, seq, now)).toBe(6);
  });

  it('does not revive an expired server track', () => {
    const { feed, bus, seq } = snapshot();
    expect(anchorIndexOnList(bus, cfg, feed.routes, feed.stop_coords, seq, now + 45000)).toBe(-1);
  });

  it('preserves the server pass when a line calls at the standing stop twice', () => {
    const { feed, bus } = snapshot(); feed.routes['3'].push(11);
    const seq = mergedRouteStops(cfg, feed.routes);
    expect(anchorIndexOnList(bus, cfg, feed.routes, feed.stop_coords, seq, now)).toBe(6);
  });
});
