/**
 * A BUS THAT HAS JUST LEFT YOUR STOP IS A LAP AWAY, NOT "0 STOPS AWAY".
 *
 * Purple, 2026-10-05 (purpleatstop20261005), replayed off the rider watcher's
 * own recorded polls (`__fixtures__/stop-count-just-left.json`, window 0). A
 * rider waited at 100 Church Street South for Building 400. #317 came down
 * "3, 2, 1 stop away" and drove through the stop without stopping: 42 m past
 * it at 00:39:34Z, then 195, 309, 406 m. The countdown moved to the next lap
 * (~65 min), which was right, but the card read "0 stops away": it dropped
 * "#317 · N stops away" and drew the bus at BOARD, beside ~65, for six polls,
 * until the anchor moved on to Union Station (S) ("#317 · 14 stops away").
 * 100 Church Street South is a stop the ring passes once, so `rideApproach`
 * fell through to `tripApproach`, which is empty while the anchor is still on
 * the pickup's leg.
 *
 * Green, 2026-10-03 (stopcountzerodepart20261005, windows 1 and 2): the same
 * as #321 pulled off Building 750 for West Haven Train Station, "0 stops away"
 * beside a ~56 min countdown for four and five polls.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from './anchor';
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from './arrivals';
import { applyModelParams, resetModelParams } from './eta/params';
import type { AnchorStore } from './eta';
import type { LatLon } from './geo';
import { observedAtStop, rideApproach } from './liveAnchor';
import type { BusData } from './map-data';
import { boardHops, rideBoardArrivals } from './planner';
import { mergedRouteStops, ROUTE_LISTS } from './routes';
import fx from './__fixtures__/stop-count-just-left.json';

const S = fx.static as unknown as {
  routes: Record<string, number[]>; stop_coords: Record<number, LatLon>;
  route_paths: Record<string, [number, number][]>; segments: SegmentTimes; dwells: DwellTimes; model_params: unknown;
};
/** Per window: the line, the rider's pickup and destination. */
const RIDES = [
  { label: 'Purple', board: 1, alight: 22 }, // 100 Church Street South -> Building 400
  { label: 'Green', board: 24, alight: 127 }, // Building 750 -> West Haven Train Station
  { label: 'Green', board: 24, alight: 127 },
] as const;

afterEach(() => { registerRoutePaths(null); resetModelParams(); });

interface Card { at: string; window: number; bus: string; eta: number; stopsAhead: number; approach: number[] | null; atStop: boolean;
  /** The same poll's count with the countdown for this visit, and with the ride banner's reading. */
  thisVisit: number[] | null; banner: number[] | null }

/** Every recorded poll, one store per window: the bus the countdown follows and the card's approach, as TransitMap.tsx counts it. */
function replay(): Card[] {
  registerRoutePaths(S.route_paths);
  applyModelParams(S.model_params);
  const stores = new Map<number, AnchorStore>();
  const out: Card[] = [];
  for (const f of fx.frames) {
    const ride = RIDES[f.window]!;
    const cfg = ROUTE_LISTS.find(c => c.label === ride.label)!;
    const store = stores.get(f.window) ?? new Map();
    stores.set(f.window, store);
    const now = Date.parse(f.at) - (f.feedAgeMs ?? 0);
    const buses = f.buses as BusData[];
    const rows = computeUpcomingArrivals([ride.board, ride.alight], buses, S.routes, S.stop_coords, S.segments, now, S.dwells, store, true)
      .filter(a => a.routeLabel === ride.label);
    const pick = rideBoardArrivals(rows, ride.board, ride.alight).sort((a, b) => a.eta - b.eta)[0];
    if (!pick) continue;
    const bus = buses.find(b => b.bus_name === `#${pick.busName}`)!;
    const hops = boardHops(pick, rows, ride.board, ride.alight);
    out.push({
      at: f.at, window: f.window, bus: bus.bus_name, eta: pick.eta, stopsAhead: pick.stopsAhead,
      approach: rideApproach(bus, cfg, S.routes, S.stop_coords, ride.board, hops, now, store),
      atStop: observedAtStop(bus, ride.board, S.stop_coords),
      thisVisit: rideApproach(bus, cfg, S.routes, S.stop_coords, ride.board, [[1, ride.board]], now, store),
      banner: rideApproach(bus, cfg, S.routes, S.stop_coords, ride.board, hops, now, store, false),
    });
  }
  return out;
}

/** Consecutive repeats collapsed: what a rider watching the card saw change. */
const steps = (xs: (number | undefined)[]) => xs.filter((x, i) => i === 0 || x !== xs[i - 1]);

describe('purpleatstop20261005: the card counts a lap for a bus that has just left the pickup', () => {
  it('Purple #317 through 100 Church Street South: 3, 2, 1, then 15 and 14, never 0', () => {
    // Purple's list from 100 Church Street South round to 300 George St: Union Station (S), West Haven,
    // West Campus out and back, LEPH / 60 College, 333 Cedar. (The station's added return call is not listed.)
    const lap = [1, 122, 127, 26, 25, 24, 23, 22, 23, 24, 25, 26, 72, 10, 9];
    expect(lap.length).toBe(mergedRouteStops(ROUTE_LISTS.find(c => c.label === 'Purple')!, S.routes).length);
    const cards = replay().filter(c => c.window === 0 && c.at >= '2026-10-05T00:38:30');
    expect(cards.length).toBe(15);
    expect(cards.every(c => c.bus === '#317' && !c.atStop)).toBe(true);
    expect(steps(cards.map(c => c.approach?.length))).toEqual([3, 2, 1, 15, 14]);
    // The six polls the card read "0 stops away" beside ~65 min (00:39:34-00:40:24Z).
    const gone = cards.filter(c => c.at >= '2026-10-05T00:39:34' && c.at <= '2026-10-05T00:40:25');
    expect(gone.length).toBe(6);
    for (const c of gone) {
      expect({ at: c.at, stopsAhead: c.stopsAhead, min: Math.round(c.eta / 60) }).toEqual({ at: c.at, stopsAhead: 16, min: 65 });
      // The whole loop, from the stop it has just left (where the bus is drawn) round to the pickup.
      expect({ at: c.at, approach: c.approach }).toEqual({ at: c.at, approach: lap });
    }
    // Then from Union Station (S), as the page printed (00:40:34Z on).
    for (const c of cards.filter(x => x.at > '2026-10-05T00:40:30')) expect(c.approach?.slice(0, 2)).toEqual([122, 127]);
  });

  it('Green #321 off Building 750: 1, then 23 and 22, never 0', () => {
    for (const [w, from] of [[1, '2026-10-03T17:09:00'], [2, '2026-10-03T21:04:30']] as const) {
      const cards = replay().filter(c => c.window === w && c.at >= from);
      expect(cards.length).toBeGreaterThanOrEqual(8);
      expect(cards.every(c => c.bus === '#321' && !c.atStop)).toBe(true);
      expect(steps(cards.map(c => c.approach?.length))).toEqual([1, 23, 22]);
      for (const c of cards.filter(x => x.stopsAhead > 1)) {
        // A lap on (~56 min), counted from Building 750 while the anchor is on its leg, then from Building 800.
        expect({ at: c.at, min: Math.round(c.eta / 60) >= 55, first: c.approach?.[0] }).toEqual({ at: c.at, min: true, first: c.approach?.length === 23 ? 24 : 25 });
      }
    }
  });

  it('reads as before with the countdown for this visit, and for the ride banner', () => {
    const cards = replay().filter(c => c.stopsAhead > 1 && c.approach?.length && c.approach[0] === RIDES[c.window]!.board);
    expect(cards.length).toBe(6 + 4 + 5);
    for (const c of cards) expect({ at: c.at, thisVisit: c.thisVisit, banner: c.banner }).toEqual({ at: c.at, thisVisit: [], banner: [] });
  });
});
