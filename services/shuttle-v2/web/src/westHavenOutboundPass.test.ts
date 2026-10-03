/**
 * A PASS UPSTREAM'S LIST HAS NO SLOT FOR READS AS THE LAST STOP CLEARED.
 *
 * Green, 2026-10-03 (greenstopsjump20261003), replayed off the watcher's own
 * recorded rows (`__fixtures__/green-west-haven-outbound.json`). A rider at
 * Building 400 read "🚌 #321 · 4 stops away" while #321 drove down from Orange /
 * Bradley (S). When it stood at West Haven Train Station on the way OUT, the
 * line read "18 stops away" and the approach list restarted at the station and
 * ran the whole Orange Street loop, for four minutes, until Building 900 put it
 * at "3". "Board in" held ~8 min throughout: only the index was wrong. It
 * happened on both of that morning's rides.
 *
 * Upstream names the station once, on the return. The repaired ring
 * (src/network/alignStops.ts) drives past it both ways, and both passes carry
 * that one slot. That is the right answer to "which stop is the bus at", and
 * the wrong place to count from: the card counted the outbound call from the
 * return call's slot, past the whole spur. It now counts in travel order
 * (liveAnchor.ts `travelSlot`).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from './anchor';
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from './arrivals';
import type { AnchorStore } from './eta';
import { applyModelParams } from './eta/params';
import { buildRing } from './eta/ring';
import type { LatLon } from './geo';
import { anchorIndexOnList, observedAtStop, travelSlot } from './liveAnchor';
import type { BusData } from './map-data';
import { mergedRouteStops, ROUTE_LISTS } from './routes';
import route from './__fixtures__/green-wrong-bus-board.json';
import fixture from './__fixtures__/green-west-haven-outbound.json';
import green from './__fixtures__/green-published-order.json';
import pink from './__fixtures__/pink-published-order.json';
import purple from './__fixtures__/purple-published-order.json';

const FX = fixture as unknown as {
  boardStopId: number; bus: string; model_params: unknown;
  polls: { runId: string; at: string; card: number | null; buses: BusData[] }[];
};
const ROUTE = route as unknown as {
  routeStops: Record<string, number[]>;
  stopCoords: Record<string, LatLon>;
  routePath: Record<string, [number, number][]>;
  segments: SegmentTimes; dwells: DwellTimes;
};
const stopCoords: Record<number, LatLon> = {};
for (const [k, v] of Object.entries(ROUTE.stopCoords)) stopCoords[Number(k)] = v;
const GREEN = ROUTE_LISTS.find(c => c.label === 'Green')!;
const canonical = mergedRouteStops(GREEN, ROUTE.routeStops);
// The list the trip card builds for itself (TransitMap.tsx `renderTripStops`).
const allStops = [...new Set(canonical)];
const BRADLEY_S = 81, STATION = 127, B900 = 26;

afterEach(() => { registerRoutePaths(null); applyModelParams(undefined); });

/** Every poll, through the card's own arithmetic, one store per ride. */
function replay() {
  registerRoutePaths(ROUTE.routePath);
  applyModelParams(FX.model_params);
  const stores = new Map<string, AnchorStore>();
  const bi = allStops.indexOf(FX.boardStopId);
  return FX.polls.map(p => {
    const store = stores.get(p.runId) ?? new Map();
    stores.set(p.runId, store);
    const now = Date.parse(p.at);
    // The countdown first, as the server and the page both step it.
    computeUpcomingArrivals(allStops, p.buses, ROUTE.routeStops, stopCoords, ROUTE.segments, now, ROUTE.dwells, store, true);
    const bus = p.buses.find(b => b.bus_name === FX.bus)!;
    // What the server publishes (src/server/serverEta.ts): the stop, and the travel slot ...
    const stop = anchorIndexOnList(bus, GREEN, ROUTE.routeStops, stopCoords, canonical, now, store);
    const travel = anchorIndexOnList(bus, GREEN, ROUTE.routeStops, stopCoords, canonical, now, store, true);
    // ... and the "🚌 #321 · N stops away" line (TransitMap.tsx `renderTripStops`).
    const busIdx = observedAtStop(bus, FX.boardStopId, stopCoords)
      ? bi
      : anchorIndexOnList(bus, GREEN, ROUTE.routeStops, stopCoords, allStops, now, store, true);
    return { ...p, bus, stop, travel, stopsAway: (bi - busIdx + allStops.length) % allStops.length };
  });
}

describe('Green #321 at West Haven Train Station on the way out (2026-10-03)', () => {
  it('is the recorded pathology: "18 stops away" from the station call to Building 900, on both rides', () => {
    for (const runId of new Set(FX.polls.map(p => p.runId))) {
      const ride = FX.polls.filter(p => p.runId === runId);
      const bus = (i: number) => ride[i]!.buses[0]!;
      const atStation = ride.findIndex(p => p.buses[0]!.at_stop_id === STATION);
      const atB900 = ride.findIndex(p => p.buses[0]!.at_stop_id === B900);
      // Down from Bradley (S), the outbound station call, then Building 900.
      expect(bus(0).at_stop_id).toBe(BRADLEY_S);
      expect(atStation).toBeGreaterThan(0);
      expect(atB900).toBeGreaterThan(atStation);
      const wrong = ride.flatMap((p, i) => p.card === 18 ? [i] : []);
      expect(wrong.length).toBeGreaterThan(20);
      for (const i of wrong) {
        expect(i).toBeGreaterThanOrEqual(atStation);
        expect(i).toBeLessThan(atB900);
      }
      expect(ride[atStation - 1]!.card).toBe(4);
      expect(ride[atB900]!.card).toBe(3);
    }
    // Upstream's list has the station once, on the return: after Building 800,
    // eight slots past Bradley (S).
    expect(canonical.filter(s => s === STATION)).toHaveLength(1);
    expect(canonical.indexOf(STATION)).toBe(canonical.indexOf(BRADLEY_S) + 8);
  });

  it('reads what the card read on every poll, and 4 where it read 18', () => {
    const polls = replay();
    for (const p of polls) {
      if (p.card === null) continue;
      expect({ at: p.at, stopsAway: p.stopsAway }).toEqual({ at: p.at, stopsAway: p.card === 18 ? 4 : p.card });
    }
  });

  it('still names the station as the stop, and counts from Bradley (S), the last stop it cleared', () => {
    const polls = replay();
    const wrong = polls.filter(p => p.card === 18);
    expect(wrong).toHaveLength(46);
    for (const p of wrong) {
      expect(p.stop).toBe(canonical.indexOf(STATION));
      expect(p.travel).toBe(canonical.indexOf(BRADLEY_S));
    }
    // Everywhere else on the ride the two are the same number.
    for (const p of polls.filter(p => p.card !== 18 && p.card !== null)) expect(p.travel).toBe(p.stop);
  });
});

describe('travelSlot: an added pass counts from the last slot the bus cleared', () => {
  const coordsOf = (fx: { stopCoords: Record<string, number[]> }) => {
    const out: Record<number, LatLon> = {};
    for (const [id, c] of Object.entries(fx.stopCoords)) out[Number(id)] = { lat: c[0]!, lon: c[1]! };
    return out;
  };
  const ringOf = (fx: typeof green | typeof pink | typeof purple) =>
    buildRing(String(fx.routeId), fx.path as [number, number][], fx.stops as number[], coordsOf(fx as never))!;
  const slots = (order: number[]) => order.map((_, p) => travelSlot(order, p));

  it('Green: the outbound station call is Bradley (S)\'s slot; the return call keeps the station\'s', () => {
    const order = ringOf(green).order;
    expect(order).toEqual(green.repairedOrder);
    // ring 11 is the outbound call (Bradley (S) -> station -> Building 900).
    expect(slots(order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 12, 13, 14, 15, 16, 17, 19, 18, 20, 21, 22]);
  });

  it('Purple: the return station call is Building 900\'s return slot, not the outbound one', () => {
    const order = ringOf(purple).order;
    expect(order).toEqual(purple.repairedOrder);
    expect(slots(order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 13, 14]);
  });

  it('Pink: a twin passed on the way in or out reads as the stop before it', () => {
    const order = ringOf(pink).order;
    expect(order).toEqual(pink.repairedOrder);
    // 149 72 43 44 60 109 [110] [124] 123 125 [123] 124 110 [109] 59 46
    expect(slots(order)).toEqual([0, 1, 2, 3, 4, 5, 5, 5, 6, 7, 7, 8, 9, 9, 10, 11]);
  });

  it('an order with nothing added is answered as is', () => {
    const order = [0, 1, 2, 3, 4];
    expect(slots(order)).toEqual(order);
  });
});
