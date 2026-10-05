/**
 * A BUS DRIVING THE RETURN LINE BACK TO THE CURB IS STILL ON ITS WAY OUT.
 *
 * Pink, pinktwincurb20261005, replayed off the archive's own polls
 * (`__fixtures__/pink-front-twin-curb.json`). Pink runs out from Congress /
 * Howard to Front / Rt 1 (S) and comes back from Front / Rt 1 (N), the other
 * curb of the same corner. On some laps #307 drove out along the RETURN leg's
 * line, so the filter's mass sat on the leg out of the (N) curb, a lap on.
 * The lead held (a wrap behind), but the lead's leg fell under the
 * propagation floor and the countdown was priced from the return leg:
 * Front / Rt 1 (S) "6 stops, ~17 min" for a bus 2-3 min from it. Since #373
 * the card's count followed it there too. The feed's last stop did not help:
 * 59, the (N) curb, stuck for 28 minutes on 2026-09-29, and 109, a stop the
 * ring calls twice, on 2026-10-01.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from '../anchor';
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from '../arrivals';
import type { LatLon } from '../geo';
import { anchorIndexOnList, anchorKeyFor } from '../liveAnchor';
import type { BusData } from '../map-data';
import { mergedRouteStops, ROUTE_LISTS } from '../routes';
import fx from '../__fixtures__/pink-front-twin-curb.json';
import { ringForBus, type AnchorStore } from './index';
import { lastStopReading, legMass, situations, type Belief } from './filter';
import { applyModelParams, resetModelParams } from './params';

const S = fx.static as unknown as {
  routes: Record<string, number[]>; stop_coords: Record<number, LatLon>;
  route_paths: Record<string, [number, number][]>; segments: SegmentTimes; dwells: DwellTimes; model_params: unknown;
};
const PINK = ROUTE_LISTS.find(c => c.label === 'Pink')!;
const SEQ = mergedRouteStops(PINK, S.routes);
const CONGRESS_HOWARD = 44, FRONT_S = 60;

afterEach(() => { registerRoutePaths(null); resetModelParams(); });

interface Poll { at: string; left: number; stopsAhead: number; eta: number; card: number | undefined; belief: Belief }

/** Every recorded poll of `window`, one store: #307's soonest row at Front / Rt 1 (S), and the card's anchor. */
function replay(window: number): Poll[] {
  registerRoutePaths(S.route_paths);
  applyModelParams(S.model_params);
  const store: AnchorStore = new Map();
  const arrived = Date.parse(fx.arrivals.find(a => a.window === window && a.stopId === FRONT_S)!.at);
  const out: Poll[] = [];
  for (const f of fx.frames.filter(x => x.window === window)) {
    const now = Date.parse(f.at);
    const bus = f.bus as unknown as BusData;
    const r = computeUpcomingArrivals([FRONT_S], [bus], S.routes, S.stop_coords, S.segments, now, S.dwells, store, true)
      .filter(a => a.busName === '307' && a.stopId === FRONT_S).sort((a, b) => a.eta - b.eta)[0]!;
    const idx = anchorIndexOnList(bus, PINK, S.routes, S.stop_coords, SEQ, now, store);
    const belief = store.get(anchorKeyFor('Pink', '#307'))!.belief!;
    out.push({ at: f.at.slice(0, 19), left: (arrived - now) / 1000, stopsAhead: r.stopsAhead, eta: r.eta, card: SEQ[idx], belief });
  }
  return out;
}

describe.each([
  [0, '2026-09-29', 59],
  [1, '2026-10-01', 109],
] as const)('Pink #307 out to Front / Rt 1 (S) along the return line, window %i (%s, feed last stop %i)', (window, _day, feedLast) => {
  it('prices Front / Rt 1 (S) as the next stop, not a lap away, until the bus is there', () => {
    const approach = replay(window).filter(p => p.left > 0 && p.left <= 240);
    expect(approach.length).toBeGreaterThanOrEqual(40);
    for (const p of approach) {
      expect({ at: p.at, stopsAhead: p.stopsAhead, onTime: p.eta <= p.left + 120 })
        .toEqual({ at: p.at, stopsAhead: 1, onTime: true });
    }
  });

  it('counts the card from Congress / Howard, with the countdown', () => {
    for (const p of replay(window).filter(x => x.left > 0 && x.left <= 240)) {
      expect({ at: p.at, card: p.card }).toEqual({ at: p.at, card: CONGRESS_HOWARD });
    }
  });

  it('keeps the lead on the twin-curb evidence, where the feed does not vouch for it', () => {
    const polls = replay(window);
    const ring = ringForBus({ route_id: 8 }, SEQ, S.stop_coords)!;
    const onLead = (b: Belief) => situations(b, ring).some(s => s.leg === b.lead);
    // The polls master priced a lap off: the lead's leg is under the
    // propagation floor, and only the stray model put it there.
    const held = polls.filter(p => p.left > 0 && p.left <= 240 && legMass(p.belief, ring)[p.belief.lead]! < 1e-6);
    expect(held.length).toBeGreaterThanOrEqual(1);
    for (const { belief: b } of held) {
      expect(ring.stops[b.lead]).toBe(CONGRESS_HOWARD);
      expect(b.lastStopId).toBe(feedLast);
      expect(lastStopReading(b, ring, b.lead)).toBe('contradicts');
      expect(onLead(b)).toBe(true);
      // Only while the bus closes on the curb: no nearer than where the lead
      // last had mass, nor than where it was last the top leg, is not it.
      expect(onLead({ ...b, leadMassFix: b.lastFix, leadTopFix: b.lastFix })).toBe(false);
    }
  });
});
