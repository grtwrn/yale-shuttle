import { afterEach, describe, expect, it } from 'vitest';
import { point } from './dist';
import { priceRoute } from './arrival';
import { situations, stepBelief } from './filter';
import { buildRing } from './ring';
import { buildTables } from './tables';
import { applyModelParams, COMPILED_MODEL_PARAMS, resetModelParams } from './params';

const stops = [1, 2, 3, 4];
const coords = {
  1: { lat: 41.31, lon: -72.93 },
  2: { lat: 41.31, lon: -72.92 },
  3: { lat: 41.32, lon: -72.92 },
  4: { lat: 41.32, lon: -72.93 },
};
const path: [number, number][] = [...stops, 1].map(id => {
  const c = coords[id as keyof typeof coords]; return [c.lat, c.lon];
});

afterEach(resetModelParams);

function fixture(atTargetStanding: boolean, incomingIsLead = true, options: {
  sequence?: number[]; targetSlot?: number; alternativeSlot?: number; incomingMass?: number;
} = {}) {
  const sequence = options.sequence ?? stops, targetSlot = options.targetSlot ?? 1;
  const alternativeSlot = options.alternativeSlot ?? targetSlot;
  const routePath: [number, number][] = options.sequence ? [...sequence, sequence[0]!].map(id => {
    const c = coords[id as keyof typeof coords]; return [c.lat, c.lon];
  }) : path;
  const ring = buildRing('occurrence-test', routePath, sequence, coords)!;
  expect(ring.stops).toEqual(sequence);
  const tables = buildTables(sequence, coords, {}, {}, ring);
  for (const stop of tables.stops) { stop.stand = point(0); stop.layover = false; }
  for (const hop of tables.hops) { hop.drive = point(100); hop.includesStand = false; }
  const incoming = (ring.stopCell[targetSlot]! - 1 + ring.C) % ring.C, target = ring.stopCell[alternativeSlot]!;
  const belief = stepBelief(undefined, ring, { lat: ring.lat[incoming]!, lon: ring.lon[incoming]! }, 600000, sequence);
  const incomingMass = options.incomingMass ?? (incomingIsLead ? .75 : .25);
  belief.p.fill(0); belief.p[ring.C + incoming] = incomingMass;
  belief.p[(atTargetStanding ? 0 : ring.C) + target] = 1 - incomingMass;
  // These are explicit conditional states, including distinct visits to a
  // shared physical curb, independently of the synthetic GPS prior.
  if (atTargetStanding) { belief.standLeg[target] = alternativeSlot; belief.zoneKey[target] = alternativeSlot; }
  belief.lead = incomingIsLead ? (targetSlot + ring.N - 1) % ring.N : alternativeSlot;
  belief.rested = false; belief.restStop = -1;
  const before = structuredClone(belief);
  const states = situations(belief, ring);
  expect(states.some(s => s.leg === alternativeSlot && s.standing === atTargetStanding)).toBe(true);
  const rows = priceRoute(belief, ring, tables, sequence, new Set([sequence[targetSlot]!]), 600000, .5, undefined, undefined, true);
  expect(belief).toEqual(before);
  if (sequence.indexOf(sequence[targetSlot]!) === sequence.lastIndexOf(sequence[targetSlot]!)) {
    expect(rows.map(r => r.occurrence)).toEqual([0, 1]);
    for (let i = 0; i < rows[0]!.distribution!.length; i++) expect(rows[1]!.distribution![i]!).toBeGreaterThanOrEqual(rows[0]!.distribution![i]!);
  }
  for (const row of rows) {
    expect(row.low).toBeLessThanOrEqual(row.eta); expect(row.eta).toBeLessThanOrEqual(row.high);
    expect(row.distribution).toEqual([...row.distribution!].sort((a, b) => a - b));
    expect([row.low, row.eta, row.high, row.departNow, row.lowFloor, ...row.distribution!].every(Number.isFinite)).toBe(true);
  }
  return { first: rows[0]!, following: rows[1]!, rows, incomingWait: (1 - ring.frac[incoming]!) * 100 };
}

describe('arrival occurrence alignment across conditional bus states', () => {
  it('counts an alternative already standing at the target as the current arrival', () => {
    const { first, following, incomingWait } = fixture(true);
    // Both conditional current arrivals are within one hop: now or the
    // incoming remainder. A four-hop circuit belongs to the following visit.
    expect(first.low).toBe(0);
    expect(first.high).toBeCloseTo(incomingWait, 8);
    expect(Math.max(...first.distribution!)).toBeLessThan(100);
    expect(following.low).toBeGreaterThanOrEqual(400);
    expect(following.high).toBeLessThan(500);
  });
  it('includes the still-incoming alternative when the lead is already at the target', () => {
    const { first, following, incomingWait } = fixture(true, false);
    expect(first.eta).toBe(0);
    expect(first.low).toBe(0);
    expect(first.high).toBeCloseTo(incomingWait, 8);
    expect(Math.max(...first.distribution!)).toBeGreaterThan(0);
    expect(following.low).toBeGreaterThanOrEqual(400);
  });
  it('retains a full-lap possibility when the alternative has departed the target', () => {
    const { first, following } = fixture(false);
    expect(first.high).toBeGreaterThanOrEqual(400);
    expect(Math.max(...first.distribution!)).toBeGreaterThanOrEqual(400);
    expect(following.high).toBeGreaterThanOrEqual(800);
  });
  it('keeps current and following arrivals aligned across the end of the ring', () => {
    const { first, following, incomingWait } = fixture(true, true, { targetSlot: 0 });
    expect(first.low).toBe(0); expect(first.high).toBeCloseTo(incomingWait, 8);
    expect(following.low).toBeGreaterThanOrEqual(400); expect(following.high).toBeLessThan(500);
  });
  it('preserves an exact parameter-independent zero when every state is at the target', () => {
    const params = structuredClone(COMPILED_MODEL_PARAMS);
    params.CONFORMAL['0-2'] = 3; params.HORIZON_BIAS['0-2'] = { b: 30, n: 10000 };
    expect(applyModelParams({ version: 'test', publishedAt: 1, params })).toBe(true);
    const { first } = fixture(true, false, { incomingMass: 0 });
    expect(first).toMatchObject({ eta: 0, low: 0, high: 0, departNow: 0, lowFloor: 0, stopsAhead: 0,
      intervalConformal: { low: false, high: false } });
    expect(first.distribution).toEqual(Array(50).fill(0));
  });
  it('separates repeated visits to the same physical stop by their ring slots', () => {
    const { rows } = fixture(true, true, { sequence: [1, 2, 3, 2, 4], alternativeSlot: 3 });
    const earlierSlot = rows.find(row => row.stopsAhead === 1)!;
    const laterSlot = rows.find(row => row.stopsAhead === 3)!;
    expect(earlierSlot.low).toBeGreaterThan(0); expect(earlierSlot.high).toBeGreaterThan(200);
    expect(laterSlot.low).toBe(0);
    expect(rows.map(row => row.stopsAhead)).toEqual([1, 3, 6, 8]);
  });
  it('places the following visit after one lap when a physical stop is repeated elsewhere', () => {
    const { rows } = fixture(true, true, { sequence: [1, 2, 3, 2, 4] });
    const current = rows.find(row => row.stopsAhead === 1)!;
    const following = rows.find(row => row.stopsAhead === 6)!;
    expect(current.low).toBe(0); expect(current.high).toBeLessThan(100);
    expect(following.low).toBeGreaterThanOrEqual(500); expect(following.high).toBeLessThan(600);
  });
});
