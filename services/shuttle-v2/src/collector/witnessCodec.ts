import { createHash } from 'node:crypto';

/** Exact binary64 values, map order and aliases matter to a reducer replay.
 * This private format is deliberately distinct from rider-facing JSON. */
export function witnessJSON(value: unknown): string {
  const references = new Map<object, number>();
  const encode = (item: unknown): unknown => {
    if (item === null) return ['null'];
    if (item === undefined) return ['undefined'];
    if (typeof item === 'string' || typeof item === 'boolean') return [typeof item, item];
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Nonfinite witness value');
      const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(item);
      return ['f64', bytes.toString('hex')];
    }
    if (typeof item !== 'object') throw new Error('Unsupported witness value');
    const prior = references.get(item);
    if (prior !== undefined) return ['ref', prior];
    const id = references.size; references.set(item, id);
    if (item instanceof Map) return ['map', id, [...item].map(([key, value]) => [encode(key), encode(value)])];
    if (item instanceof Set) return ['set', id, [...item].map(encode)];
    if (item instanceof Date) return ['date', id, encode(item.getTime())];
    if (Array.isArray(item)) return ['array', id, item.map(encode)];
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
      throw new Error('Unsupported witness object');
    const record = item as Record<string, unknown>;
    return ['object', id, Object.keys(record).sort().map(key => [key, encode(record[key])])];
  };
  return JSON.stringify(encode(value));
}

export function witnessSHA(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
