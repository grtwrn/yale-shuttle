import { describe, expect, it } from 'vitest';
import { mixedQuantiles } from './arrival';
import captured from '../__fixtures__/green-330-quarter-boundary-2026-10-17.json';

describe('weighted empirical quantile boundaries', () => {
  it('keeps the single-array percentile convention when identical data is partitioned', () => {
    const a = Float64Array.from([10, 30, 50, 70]), b = Float64Array.from([20, 40, 60, 80]);
    const ps = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
    expect(mixedQuantiles([{ s: a, w: 0.5 }, { s: b, w: 0.5 }], ps)).toEqual(
      mixedQuantiles([{ s: Float64Array.from([10, 20, 30, 40, 50, 60, 70, 80]), w: 1 }], ps));
  });
  it('does not move the recorded exact quarter boundary when weights vary by a few ULPs', () => {
    for (let ulps = -16; ulps <= 16; ulps++) {
      const w = captured.weights[0]! + ulps * Number.EPSILON / 2;
      const parts = captured.samples.map((s, i) => ({ s: Float64Array.from(s), w: i === 0 ? w : 1 - w }));
      expect(mixedQuantiles(parts, [captured.p])).toEqual([captured.upperQuantile]);
      expect(mixedQuantiles(parts.slice().reverse(), [captured.p])).toEqual([captured.upperQuantile]);
    }
  });
  it('distinguishes a real one-ULP CDF difference instead of accepting a probability tolerance', () => {
    const first = new Float64Array([10]), second = new Float64Array([20]);
    for (const [weight, expected] of [[0.5 - Number.EPSILON / 2, 20], [0.5, 20], [0.5 + Number.EPSILON / 2, 10]]) {
      expect(mixedQuantiles([{ s: first, w: weight! }, { s: second, w: 1 - weight! }], [0.5])).toEqual([expected]);
    }
  });
  it('preserves the CDF when all weights share a tiny or large scale', () => {
    const a = Float64Array.from({ length: 256 }, (_, i) => i), b = Float64Array.from({ length: 256 }, (_, i) => i + 256);
    for (const scale of [1, 2 ** 1000, 4 * Number.MIN_VALUE]) {
      expect(mixedQuantiles([{ s: a, w: scale }, { s: b, w: scale }], [0.25, 0.5, 0.75])).toEqual([128, 256, 384]);
    }
  });
  it('zero-weight support cannot change the minimum, maximum or quantiles', () => {
    const data = [{ s: new Float64Array([-1000000, 1000000]), w: 0 }, { s: new Float64Array([10, 20]), w: 1 }];
    expect(mixedQuantiles(data, [0, 0.5, 1])).toEqual([10, 20, 20]);
  });
});

it('agrees with expanded integer-weight samples across different partitions and orders', () => {
  let seed = 173;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const ps = [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1];
  for (let trial = 0; trial < 64; trial++) {
    const parts = Array.from({ length: 2 + random() % 3 }, () => ({
      s: Float64Array.from(Array.from({ length: 8 }, () => random() % 100).sort((a, b) => a - b)), w: 1 + random() % 4,
    }));
    const expanded: number[] = [];
    for (const part of parts) for (const value of part.s) for (let copy = 0; copy < part.w; copy++) expanded.push(value);
    expanded.sort((a, b) => a - b);
    const expected = ps.map(p => expanded[Math.min(expanded.length - 1, Math.floor(p * expanded.length))]);
    expect(mixedQuantiles(parts, ps)).toEqual(expected);
    expect(mixedQuantiles(parts.slice().reverse(), ps)).toEqual(expected);
  }
});
it('weights arrays of different sizes by their sample mass', () => {
  const ps = [0, 0.25, 0.5, 0.75, 1];
  const parts = [{ s: new Float64Array([10, 30]), w: 2 }, { s: new Float64Array([20, 40, 50, 60]), w: 4 }];
  expect(mixedQuantiles(parts, ps)).toEqual([10, 20, 40, 50, 60]);
});
