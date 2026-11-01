import { createHash } from 'node:crypto';
import type { RawObservation } from './types.js';

/** Versioned canonical JSON: sorted object keys, exact finite JSON values. */
export function canonicalJSON(value: unknown): string {
  const seen = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Canonical JSON requires finite numbers');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object' || !item) throw new Error('Canonical JSON requires explicit JSON values');
    if (seen.has(item)) throw new Error('Canonical JSON cannot contain cycles');
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length
        || !Array.from({ length: item.length }, (_, i) => Object.hasOwn(item, i)).every(Boolean))
        throw new Error('Canonical JSON requires dense arrays');
      result = '[' + item.map(encode).join(',') + ']';
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new Error('Canonical JSON requires plain objects');
      result = '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + encode((item as Record<string, unknown>)[key])).join(',') + '}';
    }
    seen.delete(item);
    return result;
  };
  return encode(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function observationCore(o: Omit<RawObservation, 'observationHash' | 'evidence'>) {
  return { v: 1, sourceEpoch: o.sourceEpoch, routeId: o.routeId, busId: o.busId, busName: o.busName,
    observedAt: o.observedAt, lat: o.lat, lon: o.lon, stationary: o.stationary, atStopId: o.atStopId };
}
export function observationHash(o: Omit<RawObservation, 'observationHash' | 'evidence'>): string {
  return sha256(canonicalJSON(observationCore(o)));
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
