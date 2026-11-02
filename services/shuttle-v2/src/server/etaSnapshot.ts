import { Buffer } from 'node:buffer';
import type { AnchorStore, ModelEntry } from '../../web/src/eta/index.js';
import type { Floors } from '../../web/src/eta/arrival.js';

/** Storage format only; the live exact pricing-law key and arithmetic do not change. */
export const SNAPSHOT_PACKING_SCHEMA = 'exact-law-dictionary-v1';
export const ETA_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 200;
type PackedFloors = Omit<Floors, 'pricingLawKey'> & { lawRef?: number };
type PackedEntry = Omit<ModelEntry, 'floors'> & { floors?: PackedFloors };

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Copy only entry/floor wrappers. Beliefs, lastObs/observed, floor maps and
 * release state remain in one shared graph for the caller's single serialization. */
export function packAnchorStore(store: AnchorStore): {
  snapshotPackingSchema: typeof SNAPSHOT_PACKING_SCHEMA;
  pricingLaws: string[];
  store: Map<string, PackedEntry>;
} {
  if (!(store instanceof Map) || store.size > MAX_ENTRIES) throw new Error('Invalid snapshot store');
  const pricingLaws: string[] = [], ids = new Map<string, number>();
  const entries = new Map<ModelEntry, PackedEntry>(), floors = new Map<Floors, PackedFloors>();
  const packed = new Map<string, PackedEntry>();
  let lawBytes = 0;
  for (const [key, entry] of store) {
    if (typeof key !== 'string' || !object(entry)) throw new Error('Invalid snapshot entry');
    let copy = entries.get(entry);
    if (!copy) {
      const { floors: source, ...rest } = entry;
      copy = rest;
      if (source !== undefined) {
        if (!object(source) || !(source.map instanceof Map)) throw new Error('Invalid snapshot floors');
        let floor = floors.get(source);
        if (!floor) {
          const { pricingLawKey: law, ...values } = source;
          floor = values;
          if (law !== undefined) {
            if (typeof law !== 'string' || !law.length) throw new Error('Invalid pricing law');
            let id = ids.get(law);
            if (id === undefined) {
              lawBytes += Buffer.byteLength(law);
              if (lawBytes > ETA_SNAPSHOT_MAX_BYTES) throw new Error('Snapshot laws exceed byte cap');
              id = pricingLaws.length; ids.set(law, id); pricingLaws.push(law);
            }
            floor.lawRef = id;
          }
          floors.set(source, floor);
        }
        copy.floors = floor;
      }
      entries.set(entry, copy);
    }
    packed.set(key, copy);
  }
  return { snapshotPackingSchema: SNAPSHOT_PACKING_SCHEMA, pricingLaws, store: packed };
}

/** Decode into detached wrappers before any live memory replacement. Legacy
 * tracking history may be unpacked; a legacy runtime cache is never admitted here. */
export function unpackAnchorStore(snapshot: {
  store: unknown; snapshotPackingSchema?: unknown; pricingLaws?: unknown;
}, allowLegacy: boolean): AnchorStore {
  if (!(snapshot.store instanceof Map) || snapshot.store.size > MAX_ENTRIES) throw new Error('Invalid snapshot store');
  if (snapshot.snapshotPackingSchema !== SNAPSHOT_PACKING_SCHEMA) {
    if (!allowLegacy || snapshot.snapshotPackingSchema !== undefined || snapshot.pricingLaws !== undefined)
      throw new Error('Incompatible snapshot packing');
    for (const entry of snapshot.store.values()) {
      if (!object(entry) || (entry.floors !== undefined && (!object(entry.floors)
        || !(entry.floors.map instanceof Map) || Object.prototype.hasOwnProperty.call(entry.floors, 'lawRef'))))
        throw new Error('Invalid legacy snapshot floors');
    }
    return snapshot.store;
  }
  const laws = snapshot.pricingLaws;
  if (!Array.isArray(laws) || laws.length > MAX_ENTRIES) throw new Error('Invalid law dictionary');
  const unique = new Set<string>();
  let lawBytes = 0;
  for (const law of laws) {
    if (typeof law !== 'string' || !law.length || unique.has(law)) throw new Error('Invalid law dictionary');
    unique.add(law); lawBytes += Buffer.byteLength(law);
    if (lawBytes > ETA_SNAPSHOT_MAX_BYTES) throw new Error('Snapshot laws exceed byte cap');
  }
  const entries = new Map<object, ModelEntry>(), floors = new Map<object, Floors>();
  const store: AnchorStore = new Map(), used = new Set<number>();
  for (const [key, entry] of snapshot.store) {
    if (typeof key !== 'string' || !object(entry)) throw new Error('Invalid snapshot entry');
    let copy = entries.get(entry);
    if (!copy) {
      const { floors: source, ...rest } = entry;
      copy = rest;
      if (source !== undefined) {
        if (!object(source) || !(source.map instanceof Map) || Object.prototype.hasOwnProperty.call(source, 'pricingLawKey'))
          throw new Error('Invalid packed floors');
        let floor = floors.get(source);
        if (!floor) {
          const { lawRef, ...values } = source;
          floor = values as Floors;
          if (Object.prototype.hasOwnProperty.call(source, 'lawRef')) {
            if (!Number.isSafeInteger(lawRef) || lawRef < 0 || lawRef >= laws.length) throw new Error('Invalid law reference');
            floor.pricingLawKey = laws[lawRef]!; used.add(lawRef);
          }
          floors.set(source, floor);
        }
        copy.floors = floor;
      }
      entries.set(entry, copy);
    }
    store.set(key, copy);
  }
  if (used.size !== laws.length) throw new Error('Unused snapshot law');
  return store;
}
