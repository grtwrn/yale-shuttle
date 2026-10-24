import { afterEach, describe, expect, it } from 'vitest';

import { registerRoutePaths } from '../anchor';
import type { LatLon } from '../geo';
import green from '../__fixtures__/green-fold-stale-lead.json';
import { ringForBus } from './index';
import { pricedLeg, situations, stepBelief, type Belief } from './filter';
import { resetModelParams } from './params';
import type { Ring } from './ring';

afterEach(() => { registerRoutePaths(null); resetModelParams(); });

function approach() {
  const st = green.static as unknown as {
    routes: Record<string, number[]>; stop_coords: Record<number, LatLon>;
    route_paths: Record<string, [number, number][]>;
  };
  registerRoutePaths(st.route_paths);
  const ring = ringForBus({ route_id: 9 }, st.routes['9']!, st.stop_coords)!;
  const outbound = ring.stops.indexOf(25), inbound = ring.stops.lastIndexOf(25);
  expect(outbound).not.toBe(inbound);
  const lead = outbound - 1;
  const b = stepBelief(undefined, ring, { lat: 41.258, lon: -72.988 }, 1_000_000, ring.stops);
  // The 2026-10-24 #308 replay held the outbound approach while the rest
  // landed on the return call at the same curb. Its tiny positive outbound
  // branch was pruned only in pricing, briefly quoting Building 400 a lap
  // away, then returning to three minutes five seconds later.
  b.p.fill(0);
  b.p[ring.C + ring.stopCell[lead]!] = 1e-10;
  b.p[ring.stopCell[inbound]!] = 1 - 1e-10;
  b.standLeg = new Int32Array(ring.leg);
  b.zoneKey = new Int32Array(ring.leg);
  Object.assign(b, { lead, restStop: inbound, rested: true, lastFix: null, leadMassAt: 0, lastStopId: 143 });
  return { b, ring, outbound, inbound };
}

const priced = (b: Belief, ring: Ring) => pricedLeg(b, situations(b, ring));

describe('Green approach at a curb served on both legs', () => {
  it('keeps the held approach and the return alternative without changing probability mass', () => {
    const { b, ring, inbound } = approach();
    const original = b.p.slice();
    const sits = situations(b, ring);
    expect(pricedLeg(b, sits)).toBe(b.lead);
    expect(sits.some(s => s.leg === b.lead && s.mass > 0)).toBe(true);
    expect(sits.some(s => s.leg === inbound && s.mass > .99)).toBe(true);
    expect(b.p).toEqual(original);
  });

  it('does not invent support for an approach with no remaining mass', () => {
    const { b, ring, inbound } = approach();
    b.p[ring.C + ring.stopCell[b.lead]!] = 0;
    expect(priced(b, ring)).toBe(inbound);
  });

  it('does not retain an approach when the bus has no established rest', () => {
    const { b, ring, inbound } = approach();
    expect(priced({ ...b, rested: false }, ring)).toBe(inbound);
  });

  it('does not retain an approach at a different physical curb', () => {
    const { b, ring, inbound } = approach();
    expect(priced({ ...b, restStop: inbound + 1 }, ring)).toBe(inbound);
  });

  it('releases the outbound approach when tracking advances onto the return call', () => {
    const { b, ring, inbound } = approach();
    expect(priced({ ...b, lead: inbound }, ring)).toBe(inbound);
  });

  it('does not apply the Green occurrence rule to Purple', () => {
    const { b, ring, inbound } = approach();
    expect(priced(b, { ...ring, key: ring.key.replace(/^9\|/, '10|'), routeId: '10' })).toBe(inbound);
  });

  it('does not treat a repaired duplicate as two published calls', () => {
    const { b, ring, outbound, inbound } = approach();
    const order = [...ring.order];
    order[inbound] = order[outbound]!;
    expect(priced(b, { ...ring, order })).toBe(inbound);
  });
});
