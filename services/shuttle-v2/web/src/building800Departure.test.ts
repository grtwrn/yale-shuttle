/**
 * A GREEN BUS LEAVING BUILDING 800 ON ITS WAY OUT IS STILL 2 STOPS FROM BUILDING 400.
 *
 * Green, 2026-10-04 (greenb800switch20261004), replayed off the rider watcher's
 * own recorded polls (`__fixtures__/green-building-800-departure.json`). A
 * rider waited at Building 400 for West Haven Train Station. Each time the
 * bus pulled out of its outbound stand at Building 800, the card dropped it
 * for 30-40 s and showed the other bus's next lap: "#321 · 19 stops away,
 * ~43" (#331, 10:16Z), "#321 ~31" (#331, 12:23Z), "#331 ~33" (#321, 12:52Z).
 * Out of that stand the bus drives east along the road Green's RETURN line is
 * drawn on, then loops south past Building 750's kerb before it rejoins its own
 * line. The lead jumped to Building 800's return call (or Building 750's leg
 * into it), because `last_stop_id` 25 or 23 names both calls. The rows
 * followed it a lap round (eta/filter.ts `otherCallOfStand`).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from './anchor';
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from './arrivals';
import { applyModelParams, resetModelParams } from './eta/params';
import type { AnchorStore } from './eta';
import type { LatLon } from './geo';
import { anchorIndexOnList, observedAtStop, rideApproach } from './liveAnchor';
import type { BusData } from './map-data';
import { boardHops, rideBoardArrivals } from './planner';
import { mergedRouteStops, ROUTE_LISTS } from './routes';
import fx from './__fixtures__/green-building-800-departure.json';

const S = fx.static as unknown as {
  routes: Record<string, number[]>; stop_coords: Record<number, LatLon>;
  route_paths: Record<string, [number, number][]>; segments: SegmentTimes; dwells: DwellTimes; model_params: unknown;
};
const GREEN = ROUTE_LISTS.find(c => c.label === 'Green')!;
const BOARD = 22; // Building 400
const ALIGHT = 127; // West Haven Train Station

afterEach(() => { registerRoutePaths(null); resetModelParams(); });

interface Card { at: string; window: number; bus: string; eta: number; stopsAhead: number; away: number | undefined; atStop: boolean; slot: Record<string, number> }

/** Every recorded poll, one store per window: the bus the countdown follows, the card's "N stops away"
 * (as TransitMap.tsx counts it), and each bus's slot on Green's list. */
function replay(): Card[] {
  registerRoutePaths(S.route_paths);
  applyModelParams(S.model_params);
  const canonical = mergedRouteStops(GREEN, S.routes);
  const stores = new Map<number, AnchorStore>();
  const out: Card[] = [];
  for (const f of fx.frames) {
    const store = stores.get(f.window) ?? new Map();
    stores.set(f.window, store);
    const now = Date.parse(f.at) - (f.feedAgeMs ?? 0);
    const buses = f.buses as BusData[];
    const rows = computeUpcomingArrivals([BOARD, ALIGHT], buses, S.routes, S.stop_coords, S.segments, now, S.dwells, store, true)
      .filter(a => a.routeLabel === 'Green');
    const pick = rideBoardArrivals(rows, BOARD, ALIGHT).sort((a, b) => a.eta - b.eta)[0];
    if (!pick) continue;
    const slot: Record<string, number> = {};
    for (const b of buses) slot[b.bus_name] = anchorIndexOnList(b, GREEN, S.routes, S.stop_coords, canonical, now, store);
    const bus = buses.find(b => b.bus_name === `#${pick.busName}`)!;
    const away = rideApproach(bus, GREEN, S.routes, S.stop_coords, BOARD, boardHops(pick, rows, BOARD, ALIGHT), now, store)?.length;
    out.push({ at: f.at, window: f.window, bus: `#${pick.busName}`, eta: pick.eta, stopsAhead: pick.stopsAhead, away,
      atStop: observedAtStop(bus, BOARD, S.stop_coords), slot });
  }
  return out;
}

const between = (c: Card, a: string, b: string) => c.at >= a && c.at <= b;

describe('greenb800switch20261004: the card keeps the bus pulling out of Building 800', () => {
  it('follows the bus the rider boarded, on time, from Building 800 to Building 400', () => {
    const cards = replay();
    for (const ride of fx.boarded) {
      const boarded = Date.parse(ride.at);
      // From the poll it pulled off Building 800 until the rider stepped on.
      const from = ride.window === 0 ? '2026-10-04T10:16:09' : '2026-10-04T12:52:11';
      const run = cards.filter(c => c.window === ride.window && between(c, from, ride.at));
      expect(run.length).toBeGreaterThanOrEqual(8);
      for (const c of run) {
        // Master showed the other bus's next lap here: ~44 and ~31 min.
        expect({ at: c.at, bus: c.bus }).toEqual({ at: c.at, bus: ride.bus });
        expect(c.stopsAhead).toBeLessThanOrEqual(2);
        // "N stops away" counts to the countdown's pass ("at your stop" once the bus is there).
        expect({ at: c.at, away: c.away }).toEqual({ at: c.at, away: c.atStop ? 0 : c.stopsAhead });
        expect(c.eta).toBeLessThanOrEqual((boarded - Date.parse(c.at)) / 1000 + 120);
      }
    }
  });

  it('keeps #331 two stops out after it pulls off past Building 750 (12:23Z)', () => {
    // It came within 81 m of Building 400 at 12:25:20Z, then turned back
    // without serving it. Up to then it was the bus driving at the rider.
    const run = replay().filter(c => c.window === 1 && between(c, '2026-10-04T12:23:30', '2026-10-04T12:24:50'));
    expect(run.length).toBeGreaterThanOrEqual(7);
    for (const c of run) {
      expect({ at: c.at, bus: c.bus }).toEqual({ at: c.at, bus: '#331' });
      expect(c.stopsAhead).toBeLessThanOrEqual(2);
      expect({ at: c.at, away: c.away }).toEqual({ at: c.at, away: c.atStop ? 0 : c.stopsAhead });
      expect(c.eta).toBeLessThan(300);
    }
  });

  it('never puts the departing bus on Building 800\'s return call or Building 750', () => {
    // Green's list: ... 26 (slot 11), 25, 23, 22 (slot 14), 23, 24 (slot 16), 25 (slot 17), 127, 26 ...
    const departing = [
      { window: 0, bus: '#331', from: '2026-10-04T10:15:49', to: '2026-10-04T10:17:20' },
      { window: 1, bus: '#331', from: '2026-10-04T12:23:20', to: '2026-10-04T12:24:50' },
      { window: 2, bus: '#321', from: '2026-10-04T12:52:01', to: '2026-10-04T12:53:30' },
    ];
    const cards = replay();
    for (const d of departing) {
      const run = cards.filter(c => c.window === d.window && between(c, d.from, d.to));
      expect(run.length).toBeGreaterThanOrEqual(8);
      for (const c of run) {
        const slot = c.slot[d.bus]!;
        expect({ at: c.at, slot: [11, 12, 13, 14].includes(slot) ? 'outbound' : slot }).toEqual({ at: c.at, slot: 'outbound' });
      }
    }
  });
});
