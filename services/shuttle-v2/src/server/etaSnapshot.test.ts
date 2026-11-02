import { deserialize, serialize } from 'node:v8';
import { describe, expect, it } from 'vitest';
import type { AnchorStore, ModelEntry } from '../../web/src/eta/index';
import type { Floors } from '../../web/src/eta/arrival';
import { ETA_SNAPSHOT_MAX_BYTES, SNAPSHOT_PACKING_SCHEMA, packAnchorStore, unpackAnchorStore } from './etaSnapshot';

function fixture() {
  const observation = { bus_name: '#synthetic', route_id: 4, lat: 41.31, lon: -72.93 };
  const belief = { lastObs: observation, p: new Float64Array([0.25, 0.75]), restSince: 1234 } as ModelEntry['belief'];
  const floors: Floors = { pricingLawKey: '["exact-law",0.12345678901234567]',
    map: new Map([[1, { eta: 120, standingAt: 0, since: 1234, armed: true }]]) };
  const releaseSmoothing = new Map();
  const entry: ModelEntry = { belief, floors, releaseSmoothing };
  const other: ModelEntry = { belief, floors: { ...floors }, releaseSmoothing };
  const store: AnchorStore = new Map([['first', entry], ['alias', entry], ['second', other],
    ['sharedFloor', { ...other, floors }]]);
  return { store, observation, entry, other, floors };
}

describe('exact snapshot law dictionary', () => {
  it('stores equal laws once without changing live entries and preserves graph aliases through serialization', () => {
    const f = fixture(), before = serialize({ store: f.store, observed: new Map([['first', f.observation]]) });
    const packed = packAnchorStore(f.store);
    expect(packed.snapshotPackingSchema).toBe(SNAPSHOT_PACKING_SCHEMA);
    expect(packed.pricingLaws).toEqual([f.floors.pricingLawKey]);
    expect(packed.store.get('first')!.floors).not.toHaveProperty('pricingLawKey');
    expect(packed.store.get('first')!.floors!.lawRef).toBe(0);
    const decoded = deserialize(serialize({ ...packed, observed: new Map([['first', f.observation]]) }));
    const store = unpackAnchorStore(decoded, false), first = store.get('first')!;
    expect(first).toBe(store.get('alias'));
    expect(first.belief).toBe(store.get('second')!.belief);
    expect(first.floors).toBe(store.get('sharedFloor')!.floors);
    expect(first.belief!.lastObs).toBe(decoded.observed.get('first'));
    expect(first.releaseSmoothing).toBe(store.get('second')!.releaseSmoothing);
    expect(first.floors!.map).toBe(store.get('second')!.floors!.map);
    expect(first.floors).toEqual(f.floors);
    expect(first.belief!.restSince).toBe(1234);
    expect(serialize({ store: f.store, observed: new Map([['first', f.observation]]) }).equals(before)).toBe(true);
  });

  it('distinguishes exact nearby laws and compresses repeated long laws rather than rounding them', () => {
    const f = fixture(), longLaw = 'x'.repeat(100_000);
    f.entry.floors!.pricingLawKey = longLaw;
    f.other.floors!.pricingLawKey = longLaw + '1';
    const store: AnchorStore = new Map();
    for (let i = 0; i < 20; i++) store.set(String(i), { floors: { pricingLawKey: longLaw, map: new Map() } });
    store.set('distinct', f.other);
    const packed = packAnchorStore(store);
    expect(packed.pricingLaws).toEqual([longLaw, longLaw + '1']);
    expect(serialize(packed).byteLength).toBeLessThan(serialize({ store }).byteLength);
    const restored = unpackAnchorStore(deserialize(serialize(packed)), false);
    expect(restored.get('0')!.floors!.pricingLawKey).toBe(longLaw);
    expect(restored.get('distinct')!.floors!.pricingLawKey).toBe(longLaw + '1');
  });

  it.each([-1, 0.5, 1, undefined])('refuses invalid dictionary reference %s without touching its input', ref => {
    const packed = packAnchorStore(fixture().store);
    packed.store.get('first')!.floors!.lawRef = ref as number;
    const before = serialize(packed);
    expect(() => unpackAnchorStore(packed, false)).toThrow();
    expect(serialize(packed).equals(before)).toBe(true);
  });

  it('rejects unknown schemas, duplicate/unused laws, mixed representations and over-budget dictionaries', () => {
    const f = fixture();
    expect(() => unpackAnchorStore({ store: f.store }, false)).toThrow();
    expect(() => unpackAnchorStore({ ...packAnchorStore(f.store), snapshotPackingSchema: 'future' }, true)).toThrow();
    const duplicate = packAnchorStore(f.store); duplicate.pricingLaws.push(duplicate.pricingLaws[0]!);
    expect(() => unpackAnchorStore(duplicate, false)).toThrow();
    const unused = packAnchorStore(f.store); unused.pricingLaws.push('unused');
    expect(() => unpackAnchorStore(unused, false)).toThrow();
    const mixed = packAnchorStore(f.store);
    Object.assign(mixed.store.get('first')!.floors!, { pricingLawKey: 'untrusted override' });
    expect(() => unpackAnchorStore(mixed, false)).toThrow();
    const over = packAnchorStore(f.store); over.pricingLaws[0] = 'x'.repeat(ETA_SNAPSHOT_MAX_BYTES + 1);
    expect(() => unpackAnchorStore(over, false)).toThrow();
    f.floors.pricingLawKey = over.pricingLaws[0]!;
    expect(() => packAnchorStore(f.store)).toThrow();
  });

  it('keeps lawless legacy tracking history eligible without inventing a law or admitting packed refs as legacy', () => {
    const f = fixture(); delete f.floors.pricingLawKey; delete f.other.floors!.pricingLawKey;
    const packed = packAnchorStore(f.store);
    expect(packed.pricingLaws).toEqual([]);
    const restored = unpackAnchorStore(deserialize(serialize(packed)), false);
    expect(restored.get('first')!.floors).not.toHaveProperty('pricingLawKey');
    expect(unpackAnchorStore({ store: f.store }, true)).toBe(f.store);
    Object.assign(f.floors, { lawRef: 0 });
    expect(() => unpackAnchorStore({ store: f.store }, true)).toThrow();
  });
});
