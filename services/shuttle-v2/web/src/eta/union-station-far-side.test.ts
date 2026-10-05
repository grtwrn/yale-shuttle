/**
 * A BUS COMING AT A STOP FROM THE FAR SIDE HAS NOT PASSED IT.
 *
 * Purple, evenings (unionlapearly20261005), replayed off the rider watcher's
 * own recorded polls (`__fixtures__/purple-union-station-ne.json`). From 333
 * Cedar the bus runs north-east, misses 300 George St and 100 Church Street
 * South, and comes down to Union Station (S) from the north-east, across the
 * road the station's own leg leaves on. The filter only drives forward, so to
 * the ring that bus was already past the station: the mass crossed it, the
 * lead followed, and the station's row read the next lap, "~64", while the
 * bus closed on the stop. A rider waiting there read the bus as an hour away
 * with it two minutes out (#317, 2026-10-05, 01:56:15-01:56:55Z: 473 m to
 * 126 m; at the stop 01:57:05Z). #126 the same on 2026-10-03.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from '../anchor';
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from '../arrivals';
import type { LatLon } from '../geo';
import { rideApproach } from '../liveAnchor';
import type { BusData } from '../map-data';
import { boardHops, rideBoardArrivals } from '../planner';
import { ROUTE_LISTS } from '../routes';
import fx from '../__fixtures__/purple-union-station-ne.json';
import type { AnchorStore } from './index';
import { applyModelParams, resetModelParams } from './params';

const ST = fx.static as unknown as {
  routes: Record<string, number[]>; stop_coords: Record<number, LatLon>;
  route_paths: Record<string, [number, number][]>; segments: SegmentTimes; dwells: DwellTimes; model_params: unknown;
};
const PURPLE = ROUTE_LISTS.find(c => c.label === 'Purple')!;
const UNION_STATION_S = 122, BUILDING_400 = 22;

afterEach(() => { registerRoutePaths(null); resetModelParams(); });

interface Card { at: string; stopsAhead: number; eta: number; count: number | null }

/** Every recorded poll of `window`, one store, as the page steps it: the pinned arrival and the trip card's count. */
function replay(window: number, bus: string): Card[] {
  registerRoutePaths(ST.route_paths);
  applyModelParams(ST.model_params);
  const store: AnchorStore = new Map();
  const out: Card[] = [];
  for (const p of fx.frames as unknown as { window: number; at: string; feedAgeMs?: number | null; buses: BusData[] }[]) {
    if (p.window !== window) continue;
    const now = Date.parse(p.at) - (p.feedAgeMs ?? 0);
    const visits = computeUpcomingArrivals([UNION_STATION_S, BUILDING_400], p.buses, ST.routes, ST.stop_coords, ST.segments, now, ST.dwells, store, true)
      .filter(a => a.routeLabel === 'Purple');
    const b = p.buses.find(x => x.bus_name === bus);
    const pinned = rideBoardArrivals(visits, UNION_STATION_S, BUILDING_400).filter(a => `#${a.busName}` === bus).sort((x, y) => x.eta - y.eta)[0];
    if (!b || !pinned) continue;
    const approach = rideApproach(b, PURPLE, ST.routes, ST.stop_coords, UNION_STATION_S, boardHops(pinned, visits, UNION_STATION_S, BUILDING_400), now, store);
    out.push({ at: p.at.slice(0, 19), stopsAhead: pinned.stopsAhead, eta: pinned.eta, count: approach?.length ?? null });
  }
  return out;
}

describe.each([
  ['#126', 0, '2026-10-03T02:55:21', '2026-10-03T02:55:41', 3],
  ['#317', 1, '2026-10-05T01:56:15', '2026-10-05T01:56:55', 5],
] as const)('Purple %s coming down to Union Station (S) from the north-east', (bus, window, from, to, polls) => {
  it('stays one stop out, not a lap, until the bus is at the stop', () => {
    const closing = replay(window, bus).filter(c => c.at >= from && c.at <= to);
    expect(closing.length).toBe(polls);
    for (const c of closing) {
      expect({ at: c.at, stopsAhead: c.stopsAhead, count: c.count, soon: c.eta < 180 })
        .toEqual({ at: c.at, stopsAhead: 1, count: 1, soon: true });
    }
  });
});
