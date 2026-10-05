/**
 * PULLING OUT OF 300 GEORGE ST, THE BUS IS STILL 1 STOP FROM 100 CHURCH STREET SOUTH.
 *
 * Purple (purpleholdflash20261004). After 300 George St the bus drives down
 * College St, which is Purple's return line, and #361 keeps the held lead's
 * number while only the stray model disproves it, if the bus has closed 25 m
 * on the lead's next stop. Measured only from where the lead's leg last
 * carried mass, that was one poll's closing. The bus pulls out heading
 * south-west and closes 20-25 m on 100 Church Street South in a 5 s poll, so
 * the poll the lead's leg fell under the floor priced the College St
 * alternative, 72 -> the 13-minute layover at 10 -> 9 -> 1: "~13 (6-22)",
 * 4 stops. The rider watcher saw it at 09:36Z on 2026-10-04 (#330: "~1",
 * "~12 (6-23)", "<1"). Its 10 s polls cannot replay prod's 5 s state, so both
 * fixtures are the archive's raw_positions run through the server's detector,
 * as the server serves them.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from '../anchor';
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from '../arrivals';
import type { LatLon } from '../geo';
import { anchorKeyFor } from '../liveAnchor';
import type { BusData } from '../map-data';
import { mergedRouteStops, ROUTE_LISTS } from '../routes';
import pullout from '../__fixtures__/purple-george-st-pullout.json';
import light from '../__fixtures__/purple-college-st-light.json';
import { ringForBus, type AnchorStore } from './index';
import { situations, type Belief } from './filter';
import { applyModelParams, resetModelParams } from './params';

type Fx = { static: unknown; arrivals: { stopId: number; at: string }[]; frames: { at: string; bus: unknown }[] };
type Static = {
  routes: Record<string, number[]>; stop_coords: Record<number, LatLon>;
  route_paths: Record<string, [number, number][]>; segments: SegmentTimes; dwells: DwellTimes; model_params: unknown;
};
const PURPLE = ROUTE_LISTS.find(c => c.label === 'Purple')!;
const PICKUP = 1; // 100 Church Street South

afterEach(() => { registerRoutePaths(null); resetModelParams(); });

/** Step every recorded poll; return the bus's soonest row at the pickup, and its belief, per poll. */
function replay(f: Fx, busName: string) {
  const st = f.static as Static;
  registerRoutePaths(st.route_paths);
  applyModelParams(st.model_params);
  const store: AnchorStore = new Map();
  const rows: { at: string; eta: number; stopsAhead: number }[] = [];
  const beliefs = new Map<string, Belief>();
  for (const fr of f.frames) {
    const bus = fr.bus as unknown as BusData;
    const all = computeUpcomingArrivals([PICKUP], [bus], st.routes, st.stop_coords, st.segments, Date.parse(fr.at), st.dwells, store, true);
    const r = all.filter(a => a.busName === busName && a.stopId === PICKUP).sort((a, b) => a.eta - b.eta)[0];
    if (r) rows.push({ at: fr.at, eta: r.eta, stopsAhead: r.stopsAhead });
    beliefs.set(fr.at, store.get(anchorKeyFor('Purple', bus.bus_name))!.belief!);
  }
  return { rows, beliefs, st };
}

const between = (r: { at: string }, a: string, b: string) => r.at >= a && r.at <= b;
const arrival = (f: Fx, stop: number, after: string) => Date.parse(f.arrivals.find(a => a.stopId === stop && a.at >= after)!.at);

describe('purpleholdflash20261004: pulling out of 300 George St down College St', () => {
  it('#317, 2026-10-03: the poll the lead\'s leg falls under the floor still reads 1 stop', () => {
    const { rows } = replay(pullout, '317');
    // From the hold at 300 George St until the bus is 290 m from the pole.
    // Master read "4 stops, 771 s" at 11:53:03 and "1 stop, 157 s" 5 s later.
    const run = rows.filter(r => between(r, '2026-10-03T11:52:40', '2026-10-03T11:53:35'));
    expect(run.length).toBeGreaterThanOrEqual(10);
    for (const r of run) {
      expect(r.stopsAhead).toBe(1);
      expect(r.eta).toBeLessThan(240);
    }
  });

  it('#332, 2026-09-30: standing at a light on College St, the row stays on the lead', () => {
    // Master read "4 stops, ~13 min" for the whole wait at the light.
    const at1 = arrival(light, PICKUP, '2026-09-30T20:44');
    const { rows } = replay(light, '332');
    const run = rows.filter(r => between(r, '2026-09-30T20:43:30', '2026-09-30T20:46:00'));
    expect(run.length).toBeGreaterThanOrEqual(25);
    for (const r of run) {
      expect(r.stopsAhead).toBe(1);
      expect(r.eta).toBeLessThanOrEqual((at1 - Date.parse(r.at)) / 1000 + 120);
    }
  });

  it('counts the closing from where the lead was last the top leg, or last carried mass', () => {
    const { beliefs, st } = replay(pullout, '317');
    const at = pullout.frames.find(f => f.at.startsWith('2026-10-03T11:53:03'))!.at;
    const b = beliefs.get(at)!;
    const ring = ringForBus({ route_id: 10 }, mergedRouteStops(PURPLE, st.routes), st.stop_coords)!;
    const onLead = (x: Belief) => situations(x, ring).some(s => s.leg === x.lead);
    expect(ring.stops[b.lead]).toBe(9);
    expect(onLead(b)).toBe(true);

    // The lead's leg last carried mass one poll ago, under 25 m back.
    // Without the top reference (a checkpoint written before it existed)
    // that alone decides, and the lead's leg is dropped.
    const older: Partial<Belief> = { ...b };
    delete older.leadTopFix;
    expect(onLead(older as Belief)).toBe(false);
    // Either reference passing is enough; neither, and it is dropped.
    expect(onLead({ ...b, leadMassFix: b.leadTopFix })).toBe(true);
    expect(onLead({ ...b, leadTopFix: b.lastFix })).toBe(false);
  });
});
