/**
 * The served anchor in TRAVEL order, end to end: the server steps the recorded
 * polls, the wire carries `travel` beside each bus's stop index, and the trip
 * card counts from it (incident greenstopsjump20261003, Green #321 standing at
 * West Haven Train Station on the way out; the replay itself is
 * web/src/westHavenOutboundPass.test.ts).
 *
 * No database: this file must run where better-sqlite3 cannot load.
 */
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from '../../web/src/anchor.js';
import type { DwellTimes, SegmentTimes } from '../../web/src/arrivals.js';
import { applyModelParams } from '../../web/src/eta/params.js';
import { attachServerEta, type ServerEtaWire } from '../../web/src/etaSource.js';
import type { LatLon } from '../../web/src/geo.js';
import { anchorIndexOnList, observedAtStop } from '../../web/src/liveAnchor.js';
import type { BusData } from '../../web/src/map-data.js';
import { mergedRouteStops, ROUTE_LISTS } from '../../web/src/routes.js';
import { ServerEta, type EtaPayloadView } from './serverEta.js';

// Read rather than `import ... from`, as serverEta.test.ts does.
const read = (name: string): unknown =>
  JSON.parse(fs.readFileSync(new URL(`../../web/src/__fixtures__/${name}`, import.meta.url), 'utf8'));
const ROUTE = read('green-wrong-bus-board.json') as {
  routeStops: Record<string, number[]>; stopCoords: Record<string, LatLon>;
  routePath: Record<string, [number, number][]>; segments: SegmentTimes; dwells: DwellTimes;
};
const FX = read('green-west-haven-outbound.json') as {
  boardStopId: number; bus: string; model_params: unknown;
  polls: { runId: string; at: string; card: number | null; buses: BusData[] }[];
};
const stopCoords: Record<number, LatLon> = {};
for (const [k, v] of Object.entries(ROUTE.stopCoords)) stopCoords[Number(k)] = v;
const GREEN = ROUTE_LISTS.find(c => c.label === 'Green')!;
const canonical = mergedRouteStops(GREEN, ROUTE.routeStops);
const allStops = [...new Set(canonical)];
const bi = allStops.indexOf(FX.boardStopId);

const payload = (buses: BusData[]): EtaPayloadView => ({
  buses, routes: ROUTE.routeStops, stop_coords: stopCoords, segments: ROUTE.segments,
  dwells: ROUTE.dwells, route_paths: ROUTE.routePath, model_params: FX.model_params,
});

afterEach(() => { registerRoutePaths(null); applyModelParams(undefined); });

/** Every poll through the server, then through the client as /api/buses delivers it. */
function serve(edit: (wire: ServerEtaWire) => unknown = w => w) {
  const engines = new Map<string, ServerEta>();
  return FX.polls.map((p, version) => {
    const engine = engines.get(p.runId) ?? new ServerEta({ routes: ['Green'] });
    engines.set(p.runId, engine);
    const now = Date.parse(p.at);
    const wire = engine.contribute(payload(p.buses), version, now)!;
    // The page gets fresh objects off the JSON, never the server's.
    const buses = structuredClone(p.buses);
    expect(attachServerEta(buses, edit(wire), now)).toBe(true);
    const bus = buses.find(b => b.bus_name === FX.bus)!;
    const busIdx = observedAtStop(bus, FX.boardStopId, stopCoords)
      ? bi
      : anchorIndexOnList(bus, GREEN, ROUTE.routeStops, stopCoords, allStops, now, undefined, true);
    const i = wire.buses.findIndex(b => b[0] === FX.bus.replace(/^#/, ''));
    return { ...p, stop: wire.buses[i]![2], travel: wire.travel?.[i], stopsAway: (bi - busIdx + allStops.length) % allStops.length };
  });
}

describe('the travel slot on the wire (greenstopsjump20261003)', () => {
  it('is published beside the stop index, and the card counts from it', () => {
    const polls = serve();
    const wrong = polls.filter(p => p.card === 18);
    expect(wrong).toHaveLength(46);
    for (const p of wrong) {
      expect(p.stop).toBe(canonical.indexOf(127));
      expect(p.travel).toBe(canonical.indexOf(81));
    }
    for (const p of polls) {
      if (p.card === null) continue;
      expect({ at: p.at, stopsAway: p.stopsAway }).toEqual({ at: p.at, stopsAway: p.card === 18 ? 4 : p.card });
    }
  });

  it('is optional: a wire without it, or with a malformed one, still serves the stop index', () => {
    for (const travel of [undefined, [1.5], 'x']) {
      const polls = serve(w => ({ ...w, travel }));
      // Counted from the stop index, as every client did before the field.
      for (const p of polls.filter(p => p.card === 18)) expect(p.stopsAway).toBe(18);
    }
  });

  it('stays aligned with `buses` when a bus ages off the live list', () => {
    const p = FX.polls.find(q => q.card === 18)!;
    const now = Date.parse(p.at);
    const other: BusData = { ...p.buses[0]!, bus_name: '#999', bus_id: 1, ...stopCoords[78]!,
      at_stop_id: 78, last_stop_id: 78 };
    const engine = new ServerEta({ routes: ['Green'] });
    const full = engine.contribute(payload([other, ...p.buses]), 1, now)!;
    expect(full.travel).toHaveLength(full.buses.length);
    const thinned = engine.contribute(payload(p.buses), 1, now + 1000)!;
    expect(thinned.buses.map(b => b[0])).toEqual(['321']);
    expect(thinned.travel).toEqual([full.travel![full.buses.findIndex(b => b[0] === '321')]]);
  });
});
