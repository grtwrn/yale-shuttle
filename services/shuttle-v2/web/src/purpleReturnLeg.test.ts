/**
 * THE TRIP CARD COUNTS ALONG THE LINE, NOT ALONG A LIST WITH THE RETURN LEG CUT OUT.
 *
 * Purple, 2026-10-03 (purplestopsjump20261003), replayed off the watcher's own
 * recorded rows (`__fixtures__/purple-return-leg.json`). Purple runs out the
 * West Campus spur and back up it: 10, 9, 1, 122, 127, 26, 25, 24, 23, 22, 23,
 * 24, 25, 26, 72. The trip card counted "N stops away" on its own
 * de-duplicated copy of that list, which keeps each stop's first pass and so
 * has no return leg at all. A bus coming back was counted from the outbound
 * pass of the same stop, back before the spur:
 *
 *  - all the way downtown from Building 900 to LEPH / 60 College it read 8
 *    (pickup 100 Church Street South) or 9 (Union Station (S)), with
 *    Building 900 ... 400 listed as still ahead, and snapped to 3 / 4 at LEPH.
 *    "Board in" was right throughout;
 *  - coming back up the spur, #330 read 6, 7, 8, 9 stops from Union Station (S)
 *    at Building 600, 750, 800 and 900: further away at every stop it got
 *    closer.
 *
 * The card now counts on the canonical sequence (liveAnchor.ts `tripApproach`).
 * That exposed a second thing the de-duplicated list had been hiding. On
 * Green, the lead can sit on the RETURN pass of Building 800 while the bus runs
 * out to Building 400 (`__fixtures__/green-building-800-outbound.json`, and
 * production at 2026-10-03 21:00Z). So a count reads the pass the belief's mass
 * is on (liveAnchor.ts `travelPass`), and those rides read exactly what they
 * read before.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from './anchor';
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from './arrivals';
import type { AnchorStore } from './eta';
import { applyModelParams } from './eta/params';
import { buildStopSequencePolyline, haversineMeters, polylineMeters, type LatLon } from './geo';
import { anchorIndexOnList, observedAtStop, tripApproach } from './liveAnchor';
import type { BusData } from './map-data';
import { mergedRouteStops, ROUTE_LISTS, type RouteListConfig } from './routes';
import purpleFx from './__fixtures__/purple-return-leg.json';
import greenFx from './__fixtures__/green-building-800-outbound.json';
import greenRoute from './__fixtures__/green-wrong-bus-board.json';

interface Poll {
  runId: string; window: number; build: string; at: string;
  cardBus: string | null; card: number | null; cardFirst: string | null;
  buses: BusData[];
}
interface Line {
  cfg: RouteListConfig;
  routeStops: Record<string, number[]>;
  stopCoords: Record<number, LatLon>;
  stopNames: Record<string, string>;
  routePath: Record<string, [number, number][]>;
  segments: SegmentTimes; dwells: DwellTimes; model_params: unknown;
  rides: Record<string, { boardStopId: number }>;
  polls: Poll[];
}
const coordsOf = (raw: Record<string, LatLon>) => {
  const out: Record<number, LatLon> = {};
  for (const [k, v] of Object.entries(raw)) out[Number(k)] = v;
  return out;
};
const PF = purpleFx as unknown as Omit<Line, 'cfg' | 'stopCoords'> & { stopCoords: Record<string, LatLon> };
const PURPLE: Line = { ...PF, cfg: ROUTE_LISTS.find(c => c.label === 'Purple')!, stopCoords: coordsOf(PF.stopCoords) };
const GR = greenRoute as unknown as {
  stopNames: Record<string, string>; routeStops: Record<string, number[]>; stopCoords: Record<string, LatLon>;
  routePath: Record<string, [number, number][]>; segments: SegmentTimes; dwells: DwellTimes;
};
const GF = greenFx as unknown as Pick<Line, 'model_params' | 'rides' | 'polls'>;
const GREEN: Line = {
  ...GF, cfg: ROUTE_LISTS.find(c => c.label === 'Green')!, routeStops: GR.routeStops,
  stopCoords: coordsOf(GR.stopCoords), stopNames: GR.stopNames, routePath: GR.routePath,
  segments: GR.segments, dwells: GR.dwells,
};

afterEach(() => { registerRoutePaths(null); applyModelParams(undefined); });

/** As the card prints a stop name. */
const shown = (line: Line, sid: number | undefined) =>
  (line.stopNames[String(sid)] ?? `Stop ${sid}`).replace(/\s*\/\s*/g, '/');

/**
 * Every poll, one store per window, the countdown stepped first as the page
 * steps it. `before` is the card's arithmetic up to this fix, on its
 * de-duplicated list (28d055b counted from the stop index, 37ea5f8 in travel
 * order, #358). `after` is `tripApproach`, what the card counts now (left out
 * when `count` is false).
 */
function replay(line: Line, count = true) {
  registerRoutePaths(line.routePath);
  applyModelParams(line.model_params);
  const canonical = mergedRouteStops(line.cfg, line.routeStops);
  const allStops = [...new Set(canonical)];
  const stores = new Map<number, AnchorStore>();
  return line.polls.map(p => {
    const store = stores.get(p.window) ?? new Map();
    stores.set(p.window, store);
    const now = Date.parse(p.at);
    computeUpcomingArrivals(allStops, p.buses, line.routeStops, line.stopCoords, line.segments, now, line.dwells, store, true);
    const board = line.rides[p.runId]!.boardStopId;
    const bus = p.buses.find(b => b.bus_name === p.cardBus);
    if (!bus) return { ...p, bus, before: null, after: null, stop: -1 };
    const atBoard = observedAtStop(bus, board, line.stopCoords);
    const bi = allStops.indexOf(board);
    const idx = atBoard ? bi : anchorIndexOnList(
      bus, line.cfg, line.routeStops, line.stopCoords, allStops, now, store, p.build !== '28d055bbd5d3',
    );
    const approach = atBoard || !count ? [] : tripApproach(bus, line.cfg, line.routeStops, line.stopCoords, board, now, store)!;
    return {
      ...p, bus,
      before: { away: (bi - idx + allStops.length) % allStops.length, first: shown(line, allStops[idx]) },
      after: count ? { away: approach.length, approach: approach.map(s => shown(line, s)) } : null,
      // The stop index everything else reads (route cards, ride page), on the canonical list.
      stop: anchorIndexOnList(bus, line.cfg, line.routeStops, line.stopCoords, canonical, now, store),
    };
  });
}

describe('Purple on the West Campus return leg (2026-10-03)', () => {
  it('is the recorded pathology, and the card\'s old arithmetic reproduces every poll of it', () => {
    const polls = replay(PURPLE, false).filter(p => p.before);
    expect(polls.length).toBeGreaterThan(100);
    for (const p of polls) {
      expect({ at: p.at, away: p.before!.away, first: p.before!.first })
        .toEqual({ at: p.at, away: p.card, first: p.cardFirst });
    }
    const read = (runId: string, bus: string) =>
      polls.filter(p => p.runId === runId && p.cardBus === bus).map(p => `${p.card} ${p.cardFirst}`);
    // Back downtown from Building 900: 8 / 9 with the spur ahead, until LEPH / 60 College.
    expect(new Set(read('1791041547579', '#317'))).toEqual(new Set([
      '8 Building 900', '3 LEPH/60 College', '2 333 Cedar']));
    expect(read('1791041547579', '#317').filter(r => r === '8 Building 900')).toHaveLength(16);
    expect(read('1791055477789', '#317').filter(r => r === '9 Building 900')).toHaveLength(20);
    // The first ride, on 28d055b, before #358: 7, from West Haven Train Station.
    expect(new Set(read('1791033193952', '#330'))).toEqual(new Set(['7 West Haven Train Station']));
    // Back up the spur toward a rider at Union Station (S): further away at every stop.
    const climb = [...new Set(read('1791055477789', '#330').filter(r => /Building/.test(r)))];
    expect(climb).toEqual(['6 Building 600', '7 Building 750', '8 Building 800', '9 Building 900']);
  });

  it('counts what the bus still has to drive', () => {
    const fixed: Record<string, number> = {
      '1791033193952 #330 7 West Haven Train Station': 2,
      '1791041547579 #317 8 Building 900': 4,
      '1791055477789 #317 9 Building 900': 5,
      '1791055477789 #330 6 Building 600': 8,
      '1791055477789 #330 7 Building 750': 7,
      '1791055477789 #330 8 Building 800': 6,
      '1791055477789 #330 9 Building 900': 5,
    };
    for (const p of replay(PURPLE)) {
      if (!p.after) continue;
      const key = `${p.runId} ${p.cardBus} ${p.card} ${p.cardFirst}`;
      expect({ key, at: p.at, away: p.after.away }).toEqual({ key, at: p.at, away: fixed[key] ?? p.card });
    }
  });

  it('lists the stops ahead, not the spur behind', () => {
    const polls = replay(PURPLE);
    const at = (runId: string, bus: string, card: number) =>
      polls.filter(p => p.runId === runId && p.cardBus === bus && p.card === card);
    for (const p of at('1791055477789', '#317', 9)) {
      expect(p.after!.approach).toEqual(['Building 900', 'LEPH/60 College', '333 Cedar', '300 George St', '100 Church Street South']);
    }
    for (const p of at('1791041547579', '#317', 8)) {
      expect(p.after!.approach).toEqual(['Building 900', 'LEPH/60 College', '333 Cedar', '300 George St']);
    }
    for (const p of at('1791055477789', '#330', 6)) {
      expect(p.after!.approach).toEqual([
        'Building 600', 'Building 750', 'Building 800', 'Building 900',
        'LEPH/60 College', '333 Cedar', '300 George St', '100 Church Street South']);
    }
  });

  it('never reads a bus further away as it comes closer', () => {
    const polls = replay(PURPLE).filter(p => p.after);
    for (const w of new Set(polls.map(p => p.window))) {
      for (const bus of new Set(polls.filter(p => p.window === w).map(p => p.cardBus))) {
        const seq = polls.filter(p => p.window === w && p.cardBus === bus).map(p => p.after!.away);
        for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeLessThanOrEqual(seq[i - 1]!);
      }
    }
  });

  it('draws the map\'s dashed approach down the return leg, not through West Campus', () => {
    // TransitMap.tsx's trip map: the approach plus the pickup, traced against the canonical sequence.
    registerRoutePaths(PURPLE.routePath);
    const canonical = mergedRouteStops(PURPLE.cfg, PURPLE.routeStops);
    const c = (ids: number[]) => ids.map(s => PURPLE.stopCoords[s]!);
    const path = PURPLE.routePath['10']!;
    const B400 = PURPLE.stopCoords[22]!;
    const closest = (pl: [number, number][]) => Math.min(...pl.map(([lat, lon]) => haversineMeters({ lat, lon }, B400)));
    // #317 at Building 900 on the way back, rider at Union Station (S).
    const now = buildStopSequencePolyline(path, c([26, 72, 10, 9, 1, 122]), c(canonical))!;
    const was = buildStopSequencePolyline(path, c([26, 25, 24, 23, 22, 72, 10, 9, 1, 122]), c([...new Set(canonical)]))!;
    expect(closest(was)).toBeLessThan(50);
    expect(closest(now)).toBeGreaterThan(500);
    expect(polylineMeters(now)).toBeLessThan(polylineMeters(was) - 2_000);
  });
});

describe('Green running out past Building 800 to Building 400 (2026-10-03)', () => {
  it('reads what the card read, though the lead names Building 800\'s return pass', () => {
    const polls = replay(GREEN).filter(p => p.after);
    const canonical = mergedRouteStops(GREEN.cfg, GREEN.routeStops);
    expect(polls.length).toBeGreaterThan(50);
    // The replay is the ride: every poll reads what the card printed but one,
    // where the replay reaches Building 800 a poll before the card did.
    expect(polls.filter(p => p.before!.away !== p.card).map(p => p.at)).toEqual(['2026-10-03T10:00:26.880Z']);
    for (const p of polls) {
      // Unchanged, except the outbound call at West Haven Train Station: 18 on
      // 28d055b, 4 since #358 (westHavenOutboundPass.test.ts).
      expect({ at: p.at, after: p.after!.away }).toEqual({ at: p.at, after: p.before!.away === 18 ? 4 : p.before!.away });
    }
    // The lead's pathology, left as it is for "which stop is the bus at": it
    // holds the RETURN pass of Building 800 (slot 17) while #321 calls at
    // Building 600 on the way out. Counted from there it would be a lap.
    const held = polls.filter(p => p.cardBus === '#321' && p.stop === 17 && p.bus!.at_stop_id === 23);
    expect(held.length).toBeGreaterThanOrEqual(4);
    const bi = canonical.indexOf(22);
    for (const p of held) {
      expect((bi - p.stop + canonical.length) % canonical.length).toBe(20);
      expect(p.after!.away).toBe(2);
    }
  });
});

describe('the trip card counts with tripApproach', () => {
  it('at all three of its counting sites, and nothing counts on the de-duplicated list in travel order', () => {
    const src = readFileSync(new URL('./TransitMap.tsx', import.meta.url), 'utf8');
    expect(src.match(/\btripApproach\(/g)).toHaveLength(3);
    expect(src).not.toMatch(/anchorIndexOnList\((?:[^()]|\(\))*\btrue,?\s*\)/);
    // The map traces that approach against the sequence it was counted on.
    expect(src).toMatch(/buildStopSequencePolyline\([^;]*upCoords, seqCoords\)/);
  });
});
