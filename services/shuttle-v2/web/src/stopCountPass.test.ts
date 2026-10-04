/**
 * THE CARD COUNTS TO THE PASS THE COUNTDOWN IS FOR.
 *
 * Green and Purple run out to West Campus and back, so some pickups are passed
 * twice: the West Campus stops, and West Haven Train Station (Green calls on
 * the way out, Purple on the way back). The countdown boards whichever pass
 * reaches the destination before the pickup comes round again (planner.ts
 * `rideBoardArrivals`); the trip card's "N stops away" counted to the stop's
 * first slot (liveAnchor.ts `tripApproach`), whatever the countdown was for
 * (stopcountpass20261003, from the review of #360).
 *
 * Replayed off the watcher's recorded rows (one store per window, the
 * countdown's arrivals stepped first, as the page steps them), for rides the
 * card has to count to the second pass:
 *  - Purple, West Haven Train Station to 300 George St, while #330 runs out
 *    the spur, lays over at Building 400 and comes back up it
 *    (`__fixtures__/purple-return-leg.json`, windows 4 and 3). The countdown
 *    is for the return call. The card read 0 leaving the station, 14 ... 9
 *    out on the spur and 9 ... 6 coming back, counted to the outbound call
 *    after the downtown loop: "10 stops away" at Building 400 with the return
 *    call five stops out.
 *  - Green, Building 800 to Orange / Pearl (N), while #321 runs out past
 *    Building 800 to Building 400 (`__fixtures__/green-building-800-outbound.json`).
 *    The countdown is for the return pass; the card read 1, then 0 all the
 *    way out, counted to the outbound pass the bus was driving through.
 * Every other pickup, and every Pink pickup, reads exactly as before.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from './anchor';
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes, type UpcomingArrival } from './arrivals';
import type { AnchorStore } from './eta';
import { applyModelParams } from './eta/params';
import type { LatLon } from './geo';
import { observedAtStop, rideApproach, tripApproach } from './liveAnchor';
import type { BusData } from './map-data';
import { boardHops, rideBoardArrivals } from './planner';
import { mergedRouteStops, ROUTE_LISTS, type RouteListConfig } from './routes';
import purpleFx from './__fixtures__/purple-return-leg.json';
import greenFx from './__fixtures__/green-building-800-outbound.json';
import greenRoute from './__fixtures__/green-wrong-bus-board.json';
import pinkFx from './__fixtures__/pink-twin-passes.json';
import pinkRoute from './__fixtures__/pink-published-order.json';

interface Line {
  cfg: RouteListConfig;
  routeStops: Record<string, number[]>;
  stopCoords: Record<number, LatLon>;
  routePath: Record<string, [number, number][]>;
  segments: SegmentTimes; dwells: DwellTimes; model_params: unknown;
  polls: { window: number; at: string; buses: BusData[] }[];
}
const coordsOf = (raw: Record<string, LatLon>) => {
  const out: Record<number, LatLon> = {};
  for (const [k, v] of Object.entries(raw)) out[Number(k)] = v;
  return out;
};
const PF = purpleFx as unknown as Omit<Line, 'cfg' | 'stopCoords'> & { stopCoords: Record<string, LatLon> };
const PURPLE: Line = { ...PF, cfg: ROUTE_LISTS.find(c => c.label === 'Purple')!, stopCoords: coordsOf(PF.stopCoords) };
const GR = greenRoute as unknown as Pick<Line, 'routeStops' | 'routePath' | 'segments' | 'dwells'> & { stopCoords: Record<string, LatLon> };
const GF = greenFx as unknown as Pick<Line, 'model_params' | 'polls'>;
const GREEN: Line = { ...GR, ...GF, cfg: ROUTE_LISTS.find(c => c.label === 'Green')!, stopCoords: coordsOf(GR.stopCoords) };
const PK = pinkFx as unknown as Pick<Line, 'segments' | 'dwells' | 'model_params' | 'polls'>;
const PR = pinkRoute as unknown as { stops: number[]; path: [number, number][]; stopCoords: Record<string, [number, number]> };
const PINK: Line = {
  ...PK, cfg: ROUTE_LISTS.find(c => c.label === 'Pink')!, routeStops: { '8': PR.stops },
  stopCoords: Object.fromEntries(Object.entries(PR.stopCoords).map(([k, [lat, lon]]) => [Number(k), { lat, lon }])),
  routePath: { '8': PR.path },
};

afterEach(() => { registerRoutePaths(null); applyModelParams(undefined); });

interface Read { at: string; window: number; bus: string; board: number; alight: number; pinned: UpcomingArrival | undefined; before: number | null; after: number | null }

/**
 * Every poll of `windows`, every ride in `rides` ([board, alight]) on every
 * bus (or `bus`): the row the countdown is pinned to (the bus's soonest
 * arrival `rideBoardArrivals` keeps), the card's count before this fix (0 at
 * the stop, else `tripApproach`) and after it (`rideApproach` with the
 * option's `busBoardHops`, as TransitMap.tsx passes them).
 */
function replay(line: Line, rides: readonly (readonly [number, number])[], windows?: number[], bus?: string): Read[] {
  registerRoutePaths(line.routePath);
  applyModelParams(line.model_params);
  const stops = [...new Set(mergedRouteStops(line.cfg, line.routeStops))];
  const stores = new Map<number, AnchorStore>();
  const out: Read[] = [];
  for (const p of line.polls) {
    if (windows && !windows.includes(p.window)) continue;
    const store = stores.get(p.window) ?? new Map();
    stores.set(p.window, store);
    const now = Date.parse(p.at);
    const visits = computeUpcomingArrivals(stops, p.buses, line.routeStops, line.stopCoords, line.segments, now, line.dwells, store);
    for (const b of p.buses) {
      if (bus && b.bus_name !== bus) continue;
      const name = b.bus_name.replace(/^#/, '');
      for (const [board, alight] of rides) {
        const pinned = rideBoardArrivals(visits, board, alight).filter(a => a.busName === name).sort((x, y) => x.eta - y.eta)[0];
        const was = observedAtStop(b, board, line.stopCoords) ? [] : tripApproach(b, line.cfg, line.routeStops, line.stopCoords, board, now, store);
        const is = rideApproach(b, line.cfg, line.routeStops, line.stopCoords, board, pinned && boardHops(pinned, visits, board), now, store);
        out.push({ at: p.at, window: p.window, bus: b.bus_name, board, alight, pinned, before: was?.length ?? null, after: is?.length ?? null });
      }
    }
  }
  return out;
}
const ride = (line: Line, board: number, alight: number, windows: number[], bus?: string) => replay(line, [[board, alight]], windows, bus);

/** Consecutive repeats collapsed: what a rider watching the card saw change. */
const steps = (xs: (number | null)[]) => xs.filter((x, i) => i === 0 || x !== xs[i - 1]);

describe('Purple, West Haven Train Station to downtown (2026-10-03, #330)', () => {
  it('out on the spur and laid over at Building 400: counted to the return call', () => {
    const reads = ride(PURPLE, 127, 9, [4], '#330').filter(r => r.pinned);
    expect(reads.length).toBeGreaterThan(60);
    // Leaving the station on its outbound call the card read "0 stops away"
    // beside a 16 min countdown; then five too many all the way out, the
    // downtown loop it does not drive before the return call.
    expect(steps(reads.map(r => r.before))).toEqual([0, 14, 13, 12, 11, 10, 9, 10]);
    expect(steps(reads.map(r => r.after))).toEqual([10, 9, 8, 7, 6, 5, 4, 5]);
    for (const r of reads.filter(x => x.before! > 0)) expect({ at: r.at, d: r.before! - r.after! }).toEqual({ at: r.at, d: 5 });
    for (const r of reads) {
      // The countdown's own hop count, give or take the turnaround, where the
      // anchor runs a stop ahead of a bus standing at Building 400.
      expect(Math.abs(r.after! - r.pinned!.stopsAhead)).toBeLessThanOrEqual(1);
    }
    // The review's example: at Building 400 the card read 10, five stops out.
    const last = reads.at(-1)!;
    expect({ pinned: last.pinned!.stopsAhead, before: last.before, after: last.after }).toEqual({ pinned: 5, before: 10, after: 5 });
  });

  it('back up the spur: the stops it still has to the station, not the downtown loop', () => {
    const reads = ride(PURPLE, 127, 9, [3], '#330').filter(r => r.pinned);
    expect(reads.length).toBeGreaterThan(40);
    expect(steps(reads.map(r => r.before))).toEqual([9, 8, 7, 6, 0, 6]);
    expect(steps(reads.map(r => r.after))).toEqual([4, 3, 2, 1, 0, 6]);
    for (const r of reads.filter(x => x.pinned!.stopsAhead < 6)) {
      // Moving on the return leg with the countdown on the return call.
      expect({ at: r.at, after: r.after }).toEqual({ at: r.at, after: r.pinned!.stopsAhead === 1 && r.before === 0 ? 0 : r.pinned!.stopsAhead });
    }
    // Standing at the station on the return call with the countdown passed on
    // to the outbound one (a rider out of reach of the bus that is there):
    // counted to that call, not "0 stops away".
    const passedOver = reads.filter(r => r.before === 0 && r.pinned!.stopsAhead === 6);
    expect(passedOver.length).toBeGreaterThanOrEqual(1);
    for (const r of passedOver) expect(r.after).toBe(6);
  });
});

describe('Green, Building 800 to Orange / Pearl (N) (2026-10-03, #321)', () => {
  it('running out past Building 800: counted to the return pass the countdown is for', () => {
    const reads = ride(GREEN, 25, 91, [0], '#321').filter(r => r.pinned);
    expect(reads.length).toBeGreaterThanOrEqual(18);
    const head = reads.filter(r => r.at < '2026-10-03T10:00:40Z');
    expect(steps(head.map(r => r.before))).toEqual([1, 0]);
    expect(steps(head.map(r => r.after))).toEqual([6, 5]);
    // The countdown's hops, but standing at Building 800 on the way out, counted from there.
    for (const r of head) expect(r.after).toBe(r.pinned!.stopsAhead === 6 && r.before === 0 ? 5 : r.pinned!.stopsAhead);
    // Two polls where the lead itself holds the return pass (purpleReturnLeg.test.ts):
    // the countdown prices that pass a lap out, and the card counts the lap with it.
    const held = reads.filter(r => r.at > '2026-10-03T10:00:40Z' && r.at < '2026-10-03T10:01:00Z');
    expect(held.map(r => [r.pinned!.stopsAhead, r.before, r.after])).toEqual([[24, 18, 23], [24, 18, 23]]);
    // Through Building 600 on the way out, with the anchor a stop behind on
    // Building 800: five stops to the return pass, never "0 stops away".
    const tail = reads.filter(r => r.at > '2026-10-03T10:01:00Z');
    expect(tail.length).toBe(9);
    for (const r of tail) expect({ at: r.at, before: r.before, after: r.after }).toEqual({ at: r.at, before: 0, after: 5 });
  });
});

describe('reads as before', () => {
  const stopsOf = (line: Line) => [...new Set(mergedRouteStops(line.cfg, line.routeStops))];
  const pairs = (boards: number[], alights: number[]) =>
    boards.flatMap(b => alights.filter(a => a !== b).map(a => [b, a] as const));

  it('every Pink pickup, the repair\'s twins included, to every destination', () => {
    const reads = replay(PINK, pairs(stopsOf(PINK), stopsOf(PINK))).filter(r => r.pinned);
    expect(reads.length).toBeGreaterThan(5000);
    for (const r of reads) {
      expect({ at: r.at, board: r.board, alight: r.alight, after: r.after })
        .toEqual({ at: r.at, board: r.board, alight: r.alight, after: r.before });
    }
  });

  it('every Green and Purple pickup the line passes once, to every destination', () => {
    for (const line of [GREEN, PURPLE]) {
      const seq = mergedRouteStops(line.cfg, line.routeStops);
      const once = stopsOf(line).filter(s => seq.indexOf(s) === seq.lastIndexOf(s) && s !== 127);
      const reads = replay(line, pairs(once, stopsOf(line))).filter(r => r.pinned);
      expect(reads.length).toBeGreaterThan(5000);
      for (const r of reads) {
        expect({ at: r.at, board: r.board, alight: r.alight, after: r.after })
          .toEqual({ at: r.at, board: r.board, alight: r.alight, after: r.before });
      }
    }
  });

  it('with no pinned arrival', () => {
    for (const r of ride(PURPLE, 127, 9, [3, 4])) {
      const b = PURPLE.polls.find(p => p.at === r.at)!.buses.find(x => x.bus_name === r.bus)!;
      const now = Date.parse(r.at);
      const was = observedAtStop(b, 127, PURPLE.stopCoords) ? [] : tripApproach(b, PURPLE.cfg, PURPLE.routeStops, PURPLE.stopCoords, 127, now);
      expect(rideApproach(b, PURPLE.cfg, PURPLE.routeStops, PURPLE.stopCoords, 127, undefined, now)).toEqual(was);
    }
  });
});
