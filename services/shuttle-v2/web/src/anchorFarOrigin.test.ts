/**
 * THE CARD COUNTS FROM WHERE THE COUNTDOWN HAS THE BUS.
 *
 * Green, early mornings (anchorfarorigin20261004, from the review of #364),
 * replayed off the rider watcher's own recorded polls
 * (`__fixtures__/green-cold-start-lead.json`). #331 came into service at
 * 10:15Z on 2026-10-02 with no last stop in the feed. The belief's first lead
 * was Orange / Bradley (S), the stop before West Haven Train Station, and the
 * bus then drove the Orange St loop from Orange / Bishop. The lead held: a
 * wrap behind is released after LEAD_MAX_HOLD_MS of disagreement, and that
 * clock restarts whenever the top leg dips under LEAD_SWITCH_MASS, which it
 * did at every stop the bus passed. Once the lead's leg had no mass left the
 * countdown was priced from where the mass was, 10, 9, 8 ... stops from the
 * station, and the card, counted from the lead, read "1 stop away" all the
 * way round. The bus reached the station after 10:29Z. #321 the same on
 * 2026-10-03 (window 1); #302 and #303 too.
 *
 * Purple #330 laid over at Building 400 on 2026-10-03 with the lead on
 * Building 600's return leg, a stop ahead, and the countdown priced from
 * Building 400 (`__fixtures__/purple-return-leg.json`, window 4).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from './anchor';
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from './arrivals';
import type { AnchorStore } from './eta';
import { applyModelParams, resetModelParams } from './eta/params';
import type { LatLon } from './geo';
import { anchorIndexOnList, rideApproach } from './liveAnchor';
import type { BusData } from './map-data';
import { boardHops, rideBoardArrivals } from './planner';
import { mergedRouteStops, ROUTE_LISTS, type RouteListConfig } from './routes';
import fx from './__fixtures__/green-cold-start-lead.json';
import purpleFx from './__fixtures__/purple-return-leg.json';

interface Line {
  cfg: RouteListConfig; routes: Record<string, number[]>; coords: Record<number, LatLon>;
  paths: Record<string, [number, number][]>; segments: SegmentTimes; dwells: DwellTimes; model_params: unknown;
}
const GS = fx.static as unknown as {
  routes: Record<string, number[]>; stop_coords: Record<number, LatLon>;
  route_paths: Record<string, [number, number][]>; segments: SegmentTimes; dwells: DwellTimes; model_params: unknown;
};
const GREEN: Line = {
  cfg: ROUTE_LISTS.find(c => c.label === 'Green')!, routes: GS.routes, coords: GS.stop_coords,
  paths: GS.route_paths, segments: GS.segments, dwells: GS.dwells, model_params: GS.model_params,
};
const PF = purpleFx as unknown as {
  routeStops: Record<string, number[]>; stopCoords: Record<string, LatLon>; routePath: Record<string, [number, number][]>;
  segments: SegmentTimes; dwells: DwellTimes; model_params: unknown; polls: { window: number; at: string; buses: BusData[] }[];
};
const PURPLE: Line = {
  cfg: ROUTE_LISTS.find(c => c.label === 'Purple')!, routes: PF.routeStops,
  coords: Object.fromEntries(Object.entries(PF.stopCoords).map(([k, v]) => [Number(k), v])),
  paths: PF.routePath, segments: PF.segments, dwells: PF.dwells, model_params: PF.model_params,
};

afterEach(() => { registerRoutePaths(null); resetModelParams(); });

interface Card { at: string; last: number; stopsAhead: number; count: number | null; drawnAt: number | undefined }

/**
 * Every recorded poll of `bus` in `window`, one store, as the page steps it:
 * the countdown's pinned arrival for `board` -> `alight`, the trip card's
 * count (`rideApproach` with the option's hops, as TransitMap.tsx passes them)
 * and the stop the route card draws the bus at (`anchorIndexOnList` on its
 * de-duplicated list).
 */
function replay(line: Line, polls: { window: number; at: string; feedAgeMs?: number | null; buses: BusData[] }[],
  window: number, bus: string, board: number, alight: number): Card[] {
  registerRoutePaths(line.paths);
  applyModelParams(line.model_params);
  const list = [...new Set(mergedRouteStops(line.cfg, line.routes))];
  const store: AnchorStore = new Map();
  const out: Card[] = [];
  for (const p of polls) {
    if (p.window !== window) continue;
    const now = Date.parse(p.at) - (p.feedAgeMs ?? 0);
    const visits = computeUpcomingArrivals([board, alight], p.buses, line.routes, line.coords, line.segments, now, line.dwells, store, true)
      .filter(a => a.routeLabel === line.cfg.label);
    const b = p.buses.find(x => x.bus_name === bus);
    const pinned = rideBoardArrivals(visits, board, alight).filter(a => `#${a.busName}` === bus).sort((x, y) => x.eta - y.eta)[0];
    if (!b || !pinned) continue;
    const approach = rideApproach(b, line.cfg, line.routes, line.coords, board, boardHops(pinned, visits, board, alight), now, store);
    const i = anchorIndexOnList(b, line.cfg, line.routes, line.coords, list, now, store);
    out.push({ at: p.at, last: b.last_stop_id ?? 0, stopsAhead: pinned.stopsAhead, count: approach?.length ?? null, drawnAt: list[i] });
  }
  return out;
}

/** Consecutive repeats collapsed: what a rider watching the card saw change. */
const steps = (xs: (number | null)[]) => xs.filter((x, i) => i === 0 || x !== xs[i - 1]);

const STATION = 127, BUILDING_900 = 26, BRADLEY_S = 81;

describe.each([
  ['#331', 0, '2026-10-02T10:18:39', [10, 9, 8, 7, 6, 5, 4]],
  ['#321', 1, '2026-10-03T09:41:16', [9, 8, 7, 6, 5, 4, 3]],
] as const)('Green %s coming into service, West Haven Train Station for Building 900', (bus, window, named, counts) => {
  const cards = () => replay(GREEN, fx.frames as never, window, bus, STATION, BUILDING_900);

  it('counts the countdown\'s stops once the feed names one', () => {
    const all = cards();
    const after = all.filter(c => c.at >= named);
    expect(after.length).toBeGreaterThan(30);
    expect(all.find(c => c.at >= named)!.last).not.toBe(0);
    // Every stop on the way is one the line names once, so the card's count is
    // the countdown's hops exactly.
    for (const c of after) expect({ at: c.at, count: c.count }).toEqual({ at: c.at, count: c.stopsAhead });
    expect(steps(after.map(c => c.count))).toEqual(counts);
    // And the route card draws the bus on the loop, not at the stop before the station.
    for (const c of after) expect({ at: c.at, drawnAt: c.drawnAt === BRADLEY_S }).toEqual({ at: c.at, drawnAt: false });
  });

  it('holds the lead while the feed names no stop', () => {
    // The cold start's own guess, as before: the feed cannot confirm where the
    // mass is, as on the 2026-09-25 road race (anchor-detour-lap.test.ts).
    const before = cards().filter(c => c.at < named);
    expect(before.length).toBeGreaterThan(0);
    for (const c of before) expect({ at: c.at, last: c.last, drawnAt: c.drawnAt }).toEqual({ at: c.at, last: 0, drawnAt: BRADLEY_S });
  });
});

describe('Purple #330 laid over at Building 400 (2026-10-03, window 4)', () => {
  it('counts the station\'s return call from Building 400, where the countdown has it', () => {
    const cards = replay(PURPLE, PF.polls, 4, '#330', STATION, 9);
    expect(cards.length).toBeGreaterThan(60);
    // The station's return call is a call the repair adds and the card does not
    // list; the countdown's hops reach it from Building 400 without passing it.
    for (const c of cards) expect({ at: c.at, count: c.count }).toEqual({ at: c.at, count: c.stopsAhead });
    const layover = cards.filter(c => c.at >= '2026-10-03T15:57:53');
    expect(layover.length).toBe(30);
    for (const c of layover) expect({ at: c.at, count: c.count, drawnAt: c.drawnAt }).toEqual({ at: c.at, count: 5, drawnAt: 22 });
  });
});
