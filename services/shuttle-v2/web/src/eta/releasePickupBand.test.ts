import { afterEach, describe, expect, it } from 'vitest';
import { priceRoute } from './arrival';
import { stepBelief } from './filter';
import { MP, resetModelParams } from './params';
import { buildRing } from './ring';
import { buildTables } from './tables';
import type { ReleaseFit } from './release';

const stops = [11, 146, 48, 4];
const coords = {
  11: { lat: 41.31, lon: -72.93 },
  146: { lat: 41.31, lon: -72.92 },
  48: { lat: 41.314, lon: -72.92 },
  4: { lat: 41.314, lon: -72.93 },
};
const path: [number, number][] = [...stops, 11].map(id => {
  const p = coords[id as keyof typeof coords];
  return [p.lat, p.lon];
});
const fit: ReleaseFit = {
  stopId: 11, referenceLap: 3030, n: 102, days: 4,
  coefficients: [-4.8431815541, 1.1137968594, .24887738, .031191458,
    .061437861, 1.394109687, .030911025, 1.280917789, -.185989364],
};
const pin = Date.parse('2026-09-17T14:50:00Z');
function setup(route = '3') {
  const ring = buildRing(route, path, stops, coords)!;
  const segments = Object.fromEntries(stops.map((id, i) => [
    `${id}-${stops[(i + 1) % stops.length]}`,
    { avg: 90, n: 100, drive: 90, driveN: 100,
      dq: [50, 60, 70, 80, 85, 90, 100, 110, 130, 160], dqn: 100 },
  ]));
  const dwells = Object.fromEntries(stops.map(id => [id, {
    med: id === 11 ? 400 : 30, n: 100, qn: 100,
    q: id === 11 ? [83, 129, 145, 191, 288, 333, 437, 473, 543, 674]
      : [0, 12, 15, 18, 22, 26, 31, 40, 55, 90],
    ...(id === 11 ? { release: fit } : {}),
  }]));
  const tables = buildTables(stops, coords, segments, dwells, ring);
  const belief = stepBelief(undefined, ring, {
    ...coords[11], stationary_since: new Date(pin).toISOString(),
  }, pin + 180_000, stops);
  // Isolate the pricing policy from tracking uncertainty in this fixture.
  belief.p.fill(0); belief.p[ring.stopCell[0]!] = 1;
  belief.lead = 0; belief.rested = true; belief.restStop = 0;
  belief.restSince = pin;
  const read = (lap: number | undefined = 3000) => priceRoute(
    belief, ring, tables, stops, new Set(stops), pin + 180_000, .5,
    undefined, lap === undefined ? undefined : { 11: lap + 180 }, true,
    { stopId: 11, since: pin, ...(lap === undefined ? {} : { lapAtPin: lap }) },
  );
  return { read, belief, ring };
}
function widening(factor: number) {
  MP.CONFORMAL = { '0-2': factor, '2-5': factor, '5-10': factor, '10-30': factor };
}
afterEach(resetModelParams);

describe('supported Winchester hold to the next Division pickup', () => {
  it('keeps the modeled lower tail and dots while retaining margins on other stops and the following lap', () => {
    const { read, belief } = setup(), before = structuredClone(belief);
    widening(1); const raw = read();
    widening(1.6); const widened = read();
    expect(widened).toHaveLength(raw.length);
    const pickup = widened.find(r => r.stopId === 48 && r.occurrence === 0)!;
    expect(pickup).toEqual(raw.find(r => r.stopId === 48 && r.occurrence === 0));
    expect(pickup.low).toBeGreaterThan(0);
    for (const row of widened) {
      const original = raw.find(r => r.stopId === row.stopId && r.occurrence === row.occurrence)!;
      expect(row.eta).toBe(original.eta);
      expect(row.high).toBe(original.high);
      expect(row.distribution).toEqual([...row.distribution!].sort((a, b) => a - b));
      if (row.stopsAhead > 0 && row !== pickup) expect(row.low).toBeLessThan(original.low);
    }
    expect(widened.find(r => r.stopId === 11 && r.occurrence === 0)?.low).toBe(0);
    expect(belief).toEqual(before);
  });

  it.each([['1', 3000], ['3', 100]] as const)('retains the existing margins on route %s with lap %s', (route, lap) => {
    const { read } = setup(route);
    // A supported lap on another route and an unsupported Red lap must each
    // retain the existing policy for their own reason.
    widening(1); const raw = read(lap);
    widening(1.6); const widened = read(lap);
    const before = raw.find(r => r.stopId === 48 && r.occurrence === 0)!;
    const after = widened.find(r => r.stopId === 48 && r.occurrence === 0)!;
    expect(after.low).toBeLessThan(before.low);
    expect(after.high).toBeGreaterThan(before.high);
    expect(after.eta).toBe(before.eta);
  });

  it('keeps the legacy margin when the leading position has already passed Division', () => {
    const { read, belief, ring } = setup();
    belief.p.fill(0); belief.p[ring.C + ring.stopCell[3]!] = 1;
    belief.lead = 3;
    // A lagging Winchester rest clock must not make this next-lap pickup
    // eligible merely because it is the first emitted occurrence.
    widening(1); const raw = read().find(r => r.stopId === 48 && r.occurrence === 0)!;
    widening(1.6); const widened = read().find(r => r.stopId === 48 && r.occurrence === 0)!;
    expect(widened.stopsAhead).toBe(3);
    expect(widened.low).toBeLessThan(raw.low);
    expect(widened.eta).toBe(raw.eta);
    expect(widened.high).toBe(raw.high);
  });
});
