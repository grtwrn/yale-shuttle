/**
 * The trip card's count off the served wire, end to end (incident
 * purplestopsjump20261003): the server steps the recorded polls, `/api/buses`
 * carries `travel`, and the card counts along the canonical sequence from it
 * (`tripApproach`). The replay itself is web/src/purpleReturnLeg.test.ts.
 *
 * No database: this file must run where better-sqlite3 cannot load.
 */
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from '../../web/src/anchor.js';
import type { DwellTimes, SegmentTimes } from '../../web/src/arrivals.js';
import { applyModelParams } from '../../web/src/eta/params.js';
import { attachServerEta } from '../../web/src/etaSource.js';
import type { LatLon } from '../../web/src/geo.js';
import { observedAtStop, tripApproach } from '../../web/src/liveAnchor.js';
import type { BusData } from '../../web/src/map-data.js';
import { mergedRouteStops, ROUTE_LISTS } from '../../web/src/routes.js';
import { ServerEta, type EtaPayloadView } from './serverEta.js';

// Read rather than `import ... from`, as serverEta.test.ts does.
const read = (name: string): any =>
  JSON.parse(fs.readFileSync(new URL(`../../web/src/__fixtures__/${name}`, import.meta.url), 'utf8'));
interface Poll { runId: string; window: number; at: string; cardBus: string | null; card: number | null; cardFirst: string | null; buses: BusData[] }
interface Line {
  label: string; routes: Record<string, number[]>; stopCoords: Record<number, LatLon>;
  routePath: Record<string, [number, number][]>; segments: SegmentTimes; dwells: DwellTimes;
  model_params: unknown; rides: Record<string, { boardStopId: number }>; polls: Poll[];
}
const coordsOf = (raw: Record<string, LatLon>) => {
  const out: Record<number, LatLon> = {};
  for (const [k, v] of Object.entries(raw)) out[Number(k)] = v;
  return out;
};
const P = read('purple-return-leg.json');
const PURPLE: Line = { ...P, label: 'Purple', routes: P.routeStops, stopCoords: coordsOf(P.stopCoords) };
const G = read('green-building-800-outbound.json'), GR = read('green-wrong-bus-board.json');
const GREEN: Line = {
  ...G, label: 'Green', routes: GR.routeStops, stopCoords: coordsOf(GR.stopCoords),
  routePath: GR.routePath, segments: GR.segments, dwells: GR.dwells,
};

afterEach(() => { registerRoutePaths(null); applyModelParams(undefined); });

/** Every poll through the server, one engine per window, then through the card as /api/buses delivers it. */
function serve(line: Line) {
  const cfg = ROUTE_LISTS.find(c => c.label === line.label)!;
  const canonical = mergedRouteStops(cfg, line.routes);
  const engines = new Map<number, ServerEta>();
  return line.polls.map((p, version) => {
    const engine = engines.get(p.window) ?? new ServerEta({ routes: [line.label] });
    engines.set(p.window, engine);
    const now = Date.parse(p.at);
    const payload: EtaPayloadView = {
      buses: p.buses, routes: line.routes, stop_coords: line.stopCoords, segments: line.segments,
      dwells: line.dwells, route_paths: line.routePath, model_params: line.model_params,
    };
    const wire = engine.contribute(payload, version, now)!;
    // The page gets fresh objects off the JSON, never the server's.
    const buses = structuredClone(p.buses);
    expect(attachServerEta(buses, wire, now)).toBe(true);
    const bus = buses.find(b => b.bus_name === p.cardBus);
    if (!bus) return { ...p, away: null, stop: -1, travel: -1 };
    const board = line.rides[p.runId]!.boardStopId;
    const i = wire.buses.findIndex(b => b[0] === bus.bus_name.replace(/^#/, ''));
    // No store: the card answers from the wire alone.
    const approach = observedAtStop(bus, board, line.stopCoords)
      ? [] : tripApproach(bus, cfg, line.routes, line.stopCoords, board, now)!;
    return { ...p, away: approach.length, stop: wire.buses[i]![2], travel: wire.travel![i]!, canonical };
  });
}

describe('the trip card off the served wire (purplestopsjump20261003)', () => {
  it('counts Purple\'s return leg from where the bus is on it', () => {
    const polls = serve(PURPLE);
    const at = (runId: string, bus: string, card: number) =>
      polls.filter(p => p.runId === runId && p.cardBus === bus && p.card === card);
    // Back downtown from Building 900 (slot 13; the station's return call reads as it, #358).
    for (const p of at('1791055477789', '#317', 9)) expect({ at: p.at, travel: p.travel, away: p.away }).toEqual({ at: p.at, travel: 13, away: 5 });
    for (const p of at('1791041547579', '#317', 8)) expect({ at: p.at, travel: p.travel, away: p.away }).toEqual({ at: p.at, travel: 13, away: 4 });
    // Back up the spur toward Union Station (S): 8, 7, 6, 5 where the card read 6, 7, 8, 9.
    const climb = new Map(at('1791055477789', '#330', 6).concat(
      at('1791055477789', '#330', 7), at('1791055477789', '#330', 8), at('1791055477789', '#330', 9),
    ).map(p => [p.card, p.away]));
    expect([...climb]).toEqual([[6, 8], [7, 7], [8, 6], [9, 5]]);
  });

  it('keeps Green\'s outbound run past Building 800 at 2 while the stop index names the return pass', () => {
    const polls = serve(GREEN).filter(p => p.cardBus === '#321' && p.card === 2);
    const held = polls.filter(p => p.stop === 17);
    expect(held.length).toBeGreaterThanOrEqual(4);
    for (const p of held) expect({ at: p.at, travel: p.travel, away: p.away }).toEqual({ at: p.at, travel: 12, away: 2 });
  });
});
