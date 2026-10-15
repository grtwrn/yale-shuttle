import { afterEach, describe, expect, it } from 'vitest';
import { registerRoutePaths } from './anchor';
import { attachServerEta, serverArrivals, serverTrack, type ServerEtaWire } from './etaSource';
import { anchorIndexOnList } from './liveAnchor';
import { ROUTE_LISTS, mergedRouteStops } from './routes';
import fixture from './__fixtures__/folded-standing-display.json';
import type { BusData } from './map-data';
import { nextRouteStop } from './nextRouteStop';

afterEach(() => registerRoutePaths(null));
describe.each(fixture)('confirmed folded-line stand at $receivedAt', capture => {
  const setup = () => {
    const now = capture.receivedAt;
    const feed = structuredClone(capture.feed) as unknown as {
      buses: BusData[]; routes: Record<string, number[]>; route_paths: Record<string, [number, number][]>;
      stop_coords: Record<number, { lat: number; lon: number }>; server_eta: ServerEtaWire;
    };
    registerRoutePaths(feed.route_paths);
    const bus = feed.buses[0] as BusData;
    attachServerEta(feed.buses as BusData[], feed.server_eta, now);
    const cfg = ROUTE_LISTS.find(c => c.busRouteIds.includes(bus.route_id))!;
    const canonical = mergedRouteStops(cfg, feed.routes);
    const display = [...new Set(canonical)];
    return { feed, bus, cfg, canonical, display, now };
  };
  it('puts the overview badge on the physically confirmed stop, preserving the ETA visit', () => {
    const { feed, bus, cfg, canonical, display, now } = setup();
    const track = serverTrack(bus, cfg.label, now)!;
    const oldIndex = track.index;
    expect(canonical[oldIndex]).not.toBe(bus.at_stop_id); // reproduces the actual contradiction
    expect(display[anchorIndexOnList(bus, cfg, feed.routes, feed.stop_coords, display, now)]).toBe(bus.at_stop_id);
    expect(anchorIndexOnList(bus, cfg, feed.routes, feed.stop_coords, canonical, now)).toBe(oldIndex);
    expect(anchorIndexOnList(bus, cfg, feed.routes, feed.stop_coords, canonical, now, undefined, true)).toBe(track.travel);
    expect(serverTrack(bus, cfg.label, now)).toEqual(track);
  });
  it('marks the next actual call rather than the next de-duplicated row', () => {
    const { feed, bus, cfg, display, canonical, now } = setup();
    const arrivals = serverArrivals(feed.buses, display, now)!;
    // Green is outbound from 800 to 600; Purple returns from 600 to 750.
    const next = bus.route_id === 9 ? 23 : 24;
    expect(nextRouteStop(arrivals, cfg.label, bus.bus_name, bus.at_stop_id!, canonical)).toBe(next);
    expect(nextRouteStop(arrivals, cfg.label, '#other', bus.at_stop_id!, canonical)).toBeNull();
    expect(nextRouteStop(arrivals, 'Other line', bus.bus_name, bus.at_stop_id!, canonical)).toBeNull();
  });
  it.each(['moving', 'distant', 'approach', 'expired'])('does not override an unconfirmed %s stand', reason => {
    const { feed, bus, cfg, canonical, display, now } = setup();
    const oldStop = canonical[serverTrack(bus, cfg.label, now)!.index];
    if (reason === 'moving') bus.stationary = false;
    if (reason === 'distant') bus.lat = 42;
    if (reason === 'approach') {
      (feed.server_eta.buses[0]![3] as { approach: boolean }).approach = true;
      attachServerEta(feed.buses as BusData[], feed.server_eta, now);
    }
    const index = anchorIndexOnList(bus, cfg, feed.routes, feed.stop_coords, display, now + (reason === 'expired' ? 45_000 : 0));
    expect(reason === 'expired' ? index : display[index]).toBe(reason === 'expired' ? -1 : oldStop);
  });
});
