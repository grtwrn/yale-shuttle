import { afterEach, describe, expect, it } from 'vitest';
import pink from '../__fixtures__/pink-published-order.json';
import { fromQuantiles, point } from './dist';
import { priceRoute, type StopArrival } from './arrival';
import { stepBelief } from './filter';
import { buildRing, type Ring } from './ring';
import { buildTables } from './tables';
import { resetModelParams } from './params';
import type { LatLon } from '../geo';

afterEach(resetModelParams);

function pinkFixture(slot = 0, standing = false) {
  const coords: Record<number, LatLon> = {};
  for (const [id, c] of Object.entries(pink.stopCoords)) coords[Number(id)] = { lat: c[0]!, lon: c[1]! };
  const ring = buildRing('8|service-call-regression', pink.path as [number, number][], pink.stops, coords)!;
  const tables = buildTables(ring.stops, coords, {}, {}, ring);
  for (const stop of tables.stops) { stop.stand = point(0); stop.layover = false; }
  for (const hop of tables.hops) {
    hop.drive = fromQuantiles([80, 85, 90, 95, 100, 105, 110, 115, 120, 125]);
    hop.includesStand = false;
  }
  const cell = standing ? ring.stopCell[slot]! : ring.stopCell[slot]! + 1;
  const now = 600_000;
  const belief = stepBelief(undefined, ring, { lat: ring.lat[cell]!, lon: ring.lon[cell]! }, now, ring.stops);
  belief.p.fill(0);
  belief.p[(standing ? 0 : ring.C) + cell] = 1;
  belief.lead = slot;
  belief.rested = standing;
  belief.restStop = standing ? slot : -1;
  if (standing) {
    belief.standLeg[cell] = slot;
    belief.zoneKey[cell] = slot;
    belief.restSince = now - 1000;
    belief.restApproach = false;
  }
  const read = (targets: readonly number[] = ring.stops, selectedRing: Ring = ring) =>
    priceRoute(belief, selectedRing, tables, ring.stops, new Set(targets), now, .5, undefined, undefined, true);
  return { ring, belief, read };
}

function withoutServiceCount(row: StopArrival) {
  const { serviceStopsAhead: _count, ...forecast } = row;
  return forecast;
}

describe('service calls on a route that also passes opposite curbs', () => {
  it('offers Quigley Outbound after the VA return, preserving its drive path and raw occurrence identity', () => {
    const { ring, belief, read } = pinkFixture();
    const before = structuredClone(belief);
    expect(ring.N).toBe(16);
    expect(ring.stops[6]).toBe(110);
    expect(ring.stops[12]).toBe(110);
    const rows = read([110]);
    expect(rows.map(row => row.stopsAhead)).toEqual([12, 28]);
    expect(rows.map(row => row.serviceStopsAhead)).toEqual([9, 21]);
    expect(rows.map(row => row.occurrence)).toEqual([0, 1]);
    expect(rows.every(row => row.eta > 1000 && row.distribution?.length === 50)).toBe(true);
    expect(belief).toEqual(before);
  });

  it('removes only traversal-only target rows, leaving every retained forecast and quantile unchanged', () => {
    const { ring, read } = pinkFixture();
    const allPasses = read(ring.stops, { ...ring, serviceEligible: Array(ring.N).fill(true) });
    const serviceCalls = read();
    const expected = allPasses.filter(row => ring.serviceEligible[row.stopsAhead % ring.N]);
    expect(serviceCalls).toHaveLength(24);
    expect(serviceCalls.every(row => row.distribution![0]! < row.distribution![49]!)).toBe(true);
    expect(serviceCalls.map(withoutServiceCount)).toEqual(expected.map(withoutServiceCount));
    expect(serviceCalls.find(row => row.stopsAhead === 16)?.serviceStopsAhead).toBe(12);
    expect(serviceCalls.find(row => row.stopsAhead === 32)?.serviceStopsAhead).toBe(24);
  });

  it('counts intervening service calls even when the query asks only for the destination', () => {
    const { read } = pinkFixture();
    const all = read();
    expect(read([110])).toEqual(all.filter(row => row.stopId === 110));
    expect(read([123]).map(row => [row.stopsAhead, row.serviceStopsAhead])).toEqual([[8, 6], [24, 18]]);
  });

  it('does not reopen an arrival at a traversal-only pass, including on its next lap', () => {
    const { read } = pinkFixture(6, true);
    const rows = read([110]);
    expect(rows.map(row => row.stopsAhead)).toEqual([6, 22]);
    expect(rows.map(row => row.serviceStopsAhead)).toEqual([4, 16]);
    expect(rows.every(row => row.eta > 0)).toBe(true);
  });

  it('retains the current arrival and next full circuit at the actual service occurrence', () => {
    const { read } = pinkFixture(12, true);
    const rows = read([110]);
    expect(rows.map(row => row.stopsAhead)).toEqual([0, 16]);
    expect(rows.map(row => row.serviceStopsAhead)).toEqual([0, 12]);
    expect(rows[0]).toMatchObject({ eta: 0, low: 0, high: 0 });
    expect(rows[1]!.eta).toBeGreaterThan(0);
  });

  it('counts service calls across the ring seam without renumbering raw hops', () => {
    const { read } = pinkFixture(14);
    expect(read([110]).map(row => [row.stopsAhead, row.serviceStopsAhead])).toEqual([[14, 11], [30, 23]]);
  });

  it('closes a departed primary curb even when geometry passes the same marker in the other direction', () => {
    const { ring, belief, read } = pinkFixture(5, true);
    const curb = ring.stopCoords![5]!;
    const departed = { lat: curb.lat - .001, lon: curb.lon, last_stop_id: 109 };
    // The held rest still bills Quigley Inbound, but the fresh fix and
    // provider last-stop have already shown its departure beyond 75 m.
    belief.restPoint = { ...curb };
    belief.lastFix = { lat: departed.lat, lon: departed.lon };
    belief.lastObs = departed;
    belief.fixAt = 600_000;
    expect(read([109], { ...ring, serviceEligible: Array(ring.N).fill(true) })[0]!.stopsAhead).toBe(0);
    const arrivals = read([109]);
    expect(arrivals.map(row => row.stopsAhead)).toEqual([16, 32]);
    expect(arrivals.map(row => row.serviceStopsAhead)).toEqual([12, 24]);
    expect(arrivals.every(row => row.eta > 0)).toBe(true);
  });

  it('withholds boarding offers if service provenance is incomplete', () => {
    const { ring, read } = pinkFixture();
    expect(read([110], { ...ring, serviceEligible: [] })).toEqual([]);
  });
});
