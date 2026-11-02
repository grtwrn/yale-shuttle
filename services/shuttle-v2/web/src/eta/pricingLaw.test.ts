import { deserialize, serialize } from 'node:v8';
import { afterEach, describe, expect, it } from 'vitest';
import { arrivalsForBus, type AnchorStore } from './index';
import { ceilingArmsOnStanding, pricingLawKey, type StopArrival } from './arrival';
import { fromQuantiles, point } from './dist';
import { clockOrigin } from './filter';
import { applyModelParams, COMPILED_MODEL_PARAMS, resetModelParams } from './params';
import { buildRing } from './ring';
import { buildTables, type DwellLike, type SegmentLike } from './tables';
import type { BusData } from '../map-data';
import type { LatLon } from '../geo';

const STOPS = [9101, 9102, 9103, 9104];
const COORDS: Record<number, LatLon> = {
  9101: { lat: 41.31, lon: -72.93 }, 9102: { lat: 41.31, lon: -72.928 },
  9103: { lat: 41.312, lon: -72.928 }, 9104: { lat: 41.312, lon: -72.93 },
};
const PATH = [...STOPS, STOPS[0]!].map(id => [COORDS[id]!.lat, COORDS[id]!.lon] as [number, number]);
const START = Date.parse('2026-11-02T12:00:00Z');
const KEY = 'pricing-law|synthetic';
const SMALL = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];
const HEAVY = [0, 20, 40, 80, 160, 320, 640, 1200, 2400, 4800];
const SEGMENTS: Record<string, SegmentLike> = Object.fromEntries(STOPS.map((id, i) => [
  id + '-' + STOPS[(i + 1) % STOPS.length],
  { avg: 60, sd: 5, n: 10000, dq: [50, 52, 54, 56, 58, 60, 62, 64, 66, 68], dqn: 10000 },
]));
function dwells(q: number[]): Record<string, DwellLike> {
  return Object.fromEntries(STOPS.map((id, i) => [String(id), {
    med: i === 0 ? 120 : 5, n: 10000, qn: 10000,
    q: i === 0 ? q : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  }]));
}
function observation(now: number, point = COORDS[9101]!, since: number | null = START): BusData {
  return { bus_id: 990001, bus_name: '#synthetic', route_id: 4, ...point, heading: 0,
    last_stop_id: 9101, observed_at: now, stationary: since !== null,
    last_moved_at: new Date(since ?? now).toISOString(),
    ...(since === null ? {} : { at_stop_id: 9101, at_stop_since: new Date(since).toISOString(),
      stationary_since: new Date(since).toISOString() }) };
}
function scenario() {
  return { ring: buildRing('4|pricing-law-synthetic', PATH, STOPS, COORDS)!,
    store: new Map() as AnchorStore, now: START, bus: observation(START) };
}
type Scenario = ReturnType<typeof scenario>;
function read(s: Scenario, store: AnchorStore, law: Record<string, DwellLike>,
  segments: Record<string, SegmentLike> = SEGMENTS): StopArrival {
  const row = arrivalsForBus(store, KEY, s.bus, s.ring, STOPS, COORDS, segments, law,
    new Set([9102]), s.now, .5, undefined, true)
    .find(r => r.stopId === 9102 && r.occurrence === 0);
  if (!row) throw Error('Synthetic pickup row missing');
  return row;
}
function warm(q = SMALL) {
  const s = scenario(), law = dwells(q);
  let row: StopArrival | undefined;
  for (let i = 1; i <= 20; i++) {
    s.now = START + i * 5000; s.bus = observation(s.now);
    row = read(s, s.store, law);
  }
  return { ...s, row: row!, law };
}
function withoutFloors(store: AnchorStore): AnchorStore {
  const copy = structuredClone(store);
  delete copy.get(KEY)!.floors;
  return copy;
}
afterEach(resetModelParams);

describe('resolved pricing-law ceilings at the production caller', () => {
  it('prices a new law from the same current belief instead of an earlier-law ceiling', () => {
    const s = warm(), entry = s.store.get(KEY)!, belief = entry.belief!, oldFloors = entry.floors;
    const origin = clockOrigin(belief), releasePin = structuredClone(entry.releasePin);
    const smoothing = entry.releaseSmoothing = new Map();
    const law = dwells(HEAVY), raw = read(s, withoutFloors(s.store), law);
    const changed = read(s, s.store, law);
    expect(changed).toEqual(raw);
    expect(changed.eta).toBeGreaterThan(s.row.eta);
    expect(changed.distribution).not.toEqual(s.row.distribution);
    expect(entry.floors).not.toBe(oldFloors);
    expect(entry.belief).toBe(belief);
    expect(clockOrigin(entry.belief!)).toBe(origin);
    expect(entry.releasePin).toEqual(releasePin);
    expect(entry.releaseSmoothing).toBe(smoothing);
    expect(ceilingArmsOnStanding()).toBe(false);
  });

  it('keeps same-law floor identity and contents across reparsed payload objects', () => {
    const s = warm(), floors = s.store.get(KEY)!.floors!;
    const before = structuredClone(floors);
    expect(read(s, s.store, structuredClone(s.law), structuredClone(SEGMENTS))).toEqual(s.row);
    expect(s.store.get(KEY)!.floors).toBe(floors);
    expect(floors).toEqual(before);
  });

  it('does not reset on raw counts that do not change the resolved stand law', () => {
    const s = warm(), floors = s.store.get(KEY)!.floors!;
    const sameLaw = structuredClone(s.law);
    sameLaw['9101'] = { ...sameLaw['9101']!, n: 2, med: 999, qhn: 17 };
    expect(read(s, s.store, sameLaw, structuredClone(SEGMENTS))).toEqual(s.row);
    expect(s.store.get(KEY)!.floors).toBe(floors);
  });

  it('retains the existing minimum-remaining policy as a stand ages under one law', () => {
    const s = warm(HEAVY), floors = s.store.get(KEY)!.floors!;
    let previous = s.row.eta;
    for (let i = 0; i < 3; i++) {
      s.now += 5000; s.bus = observation(s.now);
      const row = read(s, s.store, s.law);
      const current = read(s, withoutFloors(s.store), s.law);
      expect(row.eta).toBeLessThanOrEqual(previous);
      expect(row.eta).toBeLessThanOrEqual(current.eta);
      expect(s.store.get(KEY)!.floors).toBe(floors);
      previous = row.eta;
    }
  });

  it('preserves actual departure and a later rest at the same curb', () => {
    const s = warm(HEAVY), oldOrigin = clockOrigin(s.store.get(KEY)!.belief!);
    const movement = [
      [41.31, -72.9295], [41.31, -72.929], [41.31, -72.9285], [41.31, -72.928],
      [41.3105, -72.928], [41.311, -72.928], [41.3115, -72.928], [41.312, -72.928],
      [41.312, -72.9285], [41.312, -72.929], [41.312, -72.9295], [41.312, -72.93],
      [41.3115, -72.93], [41.311, -72.93], [41.3105, -72.93], [41.31, -72.93],
    ];
    let departed = false;
    for (const [lat, lon] of movement) {
      s.now += 5000; s.bus = observation(s.now, { lat: lat!, lon: lon! }, null);
      const row = read(s, s.store, s.law), belief = s.store.get(KEY)!.belief!;
      if (!belief.rested && row.standingAt < 0) departed = true;
    }
    expect(departed).toBe(true);
    const restStart = s.now;
    let observedNewRest = false;
    for (let i = 0; i < 10; i++) {
      s.now += 5000; s.bus = observation(s.now, COORDS[9101]!, restStart);
      const row = read(s, s.store, s.law), belief = s.store.get(KEY)!.belief!;
      if (belief.rested && belief.restStop === 0 && clockOrigin(belief) > oldOrigin) {
        expect(row).toEqual(read(s, withoutFloors(s.store), s.law));
        observedNewRest = true; break;
      }
    }
    expect(observedNewRest).toBe(true);
  });

  it('keeps a current-law checkpoint floor and clears only a legacy lawless floor', () => {
    const s = warm(), saved = serialize(s.store);
    const current = deserialize(saved) as AnchorStore, retained = current.get(KEY)!.floors!;
    expect(read(s, current, s.law)).toEqual(s.row);
    expect(current.get(KEY)!.floors).toBe(retained);

    const legacy = deserialize(saved) as AnchorStore, entry = legacy.get(KEY)!;
    delete entry.floors!.pricingLawKey;
    const belief = entry.belief!, origin = clockOrigin(belief), oldFloor = entry.floors;
    const law = dwells(HEAVY), expected = read(s, withoutFloors(legacy), law);
    expect(read(s, legacy, law)).toEqual(expected);
    expect(entry.floors).not.toBe(oldFloor);
    expect(entry.belief).toBe(belief);
    expect(clockOrigin(belief)).toBe(origin);
  });

  it('keeps the uncorrected floor while current downstream maps change', () => {
    const s = warm(), floors = s.store.get(KEY)!.floors!, before = structuredClone(floors);
    expect(applyModelParams({ version: 'synthetic-post-maps', publishedAt: 1, params: {
      ...COMPILED_MODEL_PARAMS,
      CONFORMAL: { '0-2': 2, '2-5': 2, '5-10': 2, '10-30': 2 },
      ROUTE_SCALE: { '4': 1.2 },
      HORIZON_BIAS: {
        '0-2': { b: 30, n: 1000 }, '2-5': { b: 30, n: 1000 },
        '5-10': { b: 30, n: 1000 }, '10-30': { b: 30, n: 1000 },
      },
    } })).toBe(true);
    expect(read(s, s.store, s.law).eta).not.toBe(s.row.eta);
    expect(s.store.get(KEY)!.floors).toBe(floors);
    expect(floors).toEqual(before);
  });
});

describe('pricing-law descriptor semantics', () => {
  const setup = () => {
    const s = scenario();
    return { ring: s.ring, tables: buildTables(STOPS, COORDS, SEGMENTS, dwells(SMALL), s.ring) };
  };
  it('uses values, independent of table allocation or observational clocks', () => {
    const { ring, tables } = setup();
    expect(pricingLawKey(structuredClone(ring), structuredClone(tables), [...STOPS], .5))
      .toBe(pricingLawKey(ring, tables, STOPS, .5));
  });

  it.each(['stand', 'drive', 'hidden', 'free', 'includesStand', 'lap', 'release', 'tail'] as const)
    ('distinguishes the consumed %s law', field => {
      const { ring, tables } = setup(), changed = structuredClone(tables);
      if (field === 'stand') changed.stops[0]!.stand = fromQuantiles(HEAVY);
      if (field === 'drive') changed.hops[0]!.drive = point(200);
      if (field === 'hidden') changed.hops[0]!.hidden = point(300);
      if (field === 'free') changed.hops[0]!.free = point(20);
      if (field === 'includesStand') changed.hops[0]!.includesStand = !changed.hops[0]!.includesStand;
      if (field === 'lap') changed.stops[0]!.lap = { b: -.001, m: 3000, n: 60 };
      if (field === 'release') changed.stops[0]!.release = { stopId: 11, referenceLap: 3000,
        coefficients: [0, 1, 0, 0, 0, 0, 0, 0, 0], n: 60, days: 3 };
      if (field === 'tail') changed.stops[0]!.stand = { ...changed.stops[0]!.stand,
        tailHazard: changed.stops[0]!.stand.tailHazard / 2 };
      expect(pricingLawKey(ring, changed, STOPS, .5)).not.toBe(pricingLawKey(ring, tables, STOPS, .5));
    });

  it('keeps inert release support counts out but includes lap shrinkage support', () => {
    const { ring, tables } = setup();
    tables.stops[0]!.release = { stopId: 11, referenceLap: 3000,
      coefficients: [0, 1, 0, 0, 0, 0, 0, 0, 0], n: 60, days: 3 };
    const moreReleaseSupport = structuredClone(tables);
    moreReleaseSupport.stops[0]!.release!.n = 100;
    moreReleaseSupport.stops[0]!.release!.days = 10;
    expect(pricingLawKey(ring, moreReleaseSupport, STOPS, .5)).toBe(pricingLawKey(ring, tables, STOPS, .5));
    tables.stops[0]!.lap = { b: -.001, m: 3000, n: 60 };
    const moreLapSupport = structuredClone(tables);
    moreLapSupport.stops[0]!.lap!.n = 100;
    expect(pricingLawKey(ring, moreLapSupport, STOPS, .5)).not.toBe(pricingLawKey(ring, tables, STOPS, .5));
  });

  it('does not alias topology changes below a rounded path fingerprint or a different occurrence order', () => {
    const { ring, tables } = setup(), changed = structuredClone(ring);
    changed.lat[0] = changed.lat[0]! + 1e-8;
    expect(changed.key).toBe(ring.key);
    expect(pricingLawKey(changed, tables, STOPS, .5)).not.toBe(pricingLawKey(ring, tables, STOPS, .5));
    expect(pricingLawKey(ring, tables, [...STOPS].reverse(), .5)).not.toBe(pricingLawKey(ring, tables, STOPS, .5));
    expect(pricingLawKey(ring, tables, STOPS, .6)).not.toBe(pricingLawKey(ring, tables, STOPS, .5));
  });
});
