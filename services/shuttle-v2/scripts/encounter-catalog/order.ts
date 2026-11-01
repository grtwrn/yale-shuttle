import type { ArcInterval } from '../encounter-proxy/types.js';

/** Exact dyadic representation of a finite binary64 input, including -0. */
function dyadic(value: number): { significand: bigint; exponent: number } {
  if (!Number.isFinite(value)) throw new Error('Nonfinite order endpoint');
  const bytes = new DataView(new ArrayBuffer(8)); bytes.setFloat64(0, value);
  const bits = bytes.getBigUint64(0), sign = bits >> 63n ? -1n : 1n;
  const exponent = Number((bits >> 52n) & 2047n), mantissa = bits & ((1n << 52n) - 1n);
  return { significand: sign * (exponent ? (1n << 52n) + mantissa : mantissa),
    exponent: exponent ? exponent - 1023 - 52 : -1074 };
}

export interface OrderProof {
  feasible: boolean;
  reason: 'empty' | 'feasible' | 'empty-interval' | 'strict-order' | 'strict-cycle';
  /** Positions identify a pair of incompatible interval bounds. */
  witness: number[];
}

/** Existence of x0<...<xn<x0+L, xi in its closed input interval.
 * Exact integer bounds avoid introducing a minimum epsilon or nearest point.
 * After prior interval lower bounds are checked against each later upper,
 * x0 must lie in I0, below every later upper, and above every later lower-L.
 */
export function strictCycleOrder(intervals: readonly ArcInterval[], loopM: number): OrderProof {
  if (!intervals.length) return { feasible: true, reason: 'empty', witness: [] };
  if (!Number.isFinite(loopM) || loopM <= 0) throw new Error('Invalid raw loop length');
  const values = [...intervals.flatMap(i => [i.lo, i.hi]), loopM].map(dyadic);
  const exponent = Math.min(...values.map(v => v.exponent));
  const integers = values.map(v => v.significand << BigInt(v.exponent - exponent));
  const loop = integers.at(-1)!;
  let lower = integers[0]!, upper = integers[1]!, lowerOpen = false, upperOpen = false;
  let lowerIndex = 0, upperIndex = 0, earlierLower = lower, earlierIndex = 0;
  for (let i = 0; i < intervals.length; i++) {
    const lo = integers[2 * i]!, hi = integers[2 * i + 1]!;
    if (lo > hi) return { feasible: false, reason: 'empty-interval', witness: [i] };
    if (!i) continue;
    if (earlierLower >= hi) return { feasible: false, reason: 'strict-order', witness: [earlierIndex, i] };
    if (lo > earlierLower) { earlierLower = lo; earlierIndex = i; }
    const cycleLower = lo - loop;
    if (cycleLower >= lower) { lower = cycleLower; lowerOpen = true; lowerIndex = i; }
    if (hi <= upper) { upper = hi; upperOpen = true; upperIndex = i; }
  }
  if (lower > upper || (lower === upper && (lowerOpen || upperOpen)))
    return { feasible: false, reason: 'strict-cycle', witness: [lowerIndex, upperIndex] };
  return { feasible: true, reason: 'feasible', witness: [] };
}
