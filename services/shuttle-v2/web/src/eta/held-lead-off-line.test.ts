/**
 * THE NUMBER FOLLOWS THE HELD LEAD WHILE ONLY THE STRAY MODEL DISPROVES IT.
 *
 * Purple, 2026-10-03 (purplehold20261003), replayed off the rider watcher's
 * own recorded polls (`__fixtures__/purple-college-st-hold.json`). #330 served
 * 300 George St and drove down College St toward 100 Church Street South.
 * College St is Purple's RETURN line (127 -> 72), not the published George St
 * line; 206 of 220 runs over 7 archived days go that way. Two fixes there put
 * the mass on a stand at 72. The lead held at 300 George St ("1 stop away"),
 * but the lead's leg fell under the propagation floor, `situations` dropped
 * it, and the rider was shown the stand at 72 plus the 13-minute layover at
 * 10: "Board in ~12 (6-23)". #330 passed the pole at 15:34:53Z.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from '../anchor';
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from '../arrivals';
import type { LatLon } from '../geo';
import { anchorKeyFor } from '../liveAnchor';
import type { BusData } from '../map-data';
import { mergedRouteStops, ROUTE_LISTS } from '../routes';
import fx from '../__fixtures__/purple-college-st-hold.json';
import { ringForBus, type AnchorStore } from './index';
import { situations, type Belief } from './filter';
import { distancesTo } from './ring';
import { applyModelParams, resetModelParams } from './params';

const S = fx.static as unknown as {
  routes: Record<string, number[]>; stop_coords: Record<number, LatLon>;
  route_paths: Record<string, [number, number][]>; segments: SegmentTimes; dwells: DwellTimes; model_params: unknown;
};
const PURPLE = ROUTE_LISTS.find(c => c.label === 'Purple')!;
const PICKUP = 1; // 100 Church Street South
const passed = Date.parse(fx.passedPickupAt);

afterEach(() => { registerRoutePaths(null); resetModelParams(); });

/** Step every recorded poll; return #330's soonest row at the pickup, per poll, and the store. */
function replay(edit?: (bus: BusData, at: string) => BusData) {
  registerRoutePaths(S.route_paths);
  applyModelParams(S.model_params);
  const store: AnchorStore = new Map();
  const rows: { at: string; eta: number; low: number; high: number; stopsAhead: number }[] = [];
  const beliefs = new Map<string, Belief>();
  for (const f of fx.frames) {
    const now = Date.parse(f.at);
    const bus = edit ? edit(f.bus as BusData, f.at) : f.bus as BusData;
    const all = computeUpcomingArrivals([PICKUP], [bus], S.routes, S.stop_coords, S.segments, now, S.dwells, store, true);
    const r = all.filter(a => a.busName === '330' && a.stopId === PICKUP).sort((a, b) => a.eta - b.eta)[0];
    if (r) rows.push({ at: f.at, eta: r.eta, low: r.low, high: r.high, stopsAhead: r.stopsAhead });
    beliefs.set(f.at, store.get(anchorKeyFor('Purple', '#330'))!.belief!);
  }
  return { rows, beliefs };
}

const between = (r: { at: string }, a: string, b: string) => r.at >= a && r.at <= b;

describe('purplehold20261003: #330 down College St, 300 George St -> 100 Church Street South', () => {
  it('prices the pickup from the held lead, not from the return line\'s layover', () => {
    const { rows } = replay();
    // From the first card the rider saw until the bus was at the pole.
    const run = rows.filter(r => between(r, '2026-10-03T15:32:30', '2026-10-03T15:34:45'));
    expect(run.length).toBeGreaterThanOrEqual(13);
    for (const r of run) {
      expect(r.stopsAhead).toBe(1);
      // The bus passed the pole at 15:34:53; master quoted 12.6 min here.
      expect(r.eta).toBeLessThanOrEqual((passed - Date.parse(r.at)) / 1000 + 120);
    }
  });

  it('keeps the return-line alternative in the band while the mass sits there', () => {
    const { rows } = replay();
    const onReturnLine = rows.filter(r => between(r, '2026-10-03T15:33:40', '2026-10-03T15:34:05'));
    expect(onReturnLine.length).toBe(3);
    for (const r of onReturnLine) {
      expect(r.eta).toBeLessThan(180);
      expect(r.high).toBeGreaterThan(600);
    }
  });

  it('keeps the lead only off its line, inside the stray band, with the feed agreeing', () => {
    const { beliefs } = replay();
    const b = beliefs.get(fx.frames.find(f => f.at.startsWith('2026-10-03T15:33:43'))!.at)!;
    const ring = ringForBus({ route_id: 10 }, mergedRouteStops(PURPLE, S.routes), S.stop_coords)!;
    const onLead = (x: Belief) => situations(x, ring).some(s => s.leg === x.lead);
    expect(ring.stops[b.lead]).toBe(9);
    expect(onLead(b)).toBe(true);

    // The fix ON the lead's line: the mass left for another reason (a stand,
    // a loop back to the terminal) and the posterior keeps the number.
    const leadCells = [...ring.leg.keys()].filter(c => ring.leg[c] === b.lead);
    const on = { lat: ring.lat[leadCells[10]!]!, lon: ring.lon[leadCells[10]!]! };
    expect(onLead({ ...b, lastFix: on })).toBe(false);

    // Far beyond the stray band: the bus has left the route.
    const far = { lat: b.lastFix!.lat - 0.006, lon: b.lastFix!.lon };
    const d = distancesTo(ring, far);
    expect(Math.min(...leadCells.map(c => d[c]!))).toBeGreaterThan(300);
    expect(onLead({ ...b, lastFix: far })).toBe(false);

    // A feed that cannot place the bus (TransLoc's 0), or that places it
    // where the mass is, does not vouch for the lead.
    expect(onLead({ ...b, lastStopId: 0 })).toBe(false);
    expect(onLead({ ...b, lastStopId: 72 })).toBe(false);

    // No longer than the lead's own hold, and not on a belief restored from a
    // checkpoint that predates the clock.
    expect(onLead({ ...b, leadMassAt: b.seenAt - 300_000 })).toBe(true);
    expect(onLead({ ...b, leadMassAt: b.seenAt - 301_000 })).toBe(false);
    const restored: Partial<Belief> = { ...b };
    delete restored.leadMassAt;
    expect(onLead(restored as Belief)).toBe(false);
  });

  it('a feed that cannot place the bus keeps the posterior\'s answer', () => {
    const { rows } = replay((bus, at) => at >= '2026-10-03T15:32:20' ? { ...bus, last_stop_id: 0 } : bus);
    const r = rows.find(x => x.at.startsWith('2026-10-03T15:33:43'))!;
    expect(r.eta).toBeGreaterThan(600);
  });
});
