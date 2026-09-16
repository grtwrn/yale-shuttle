import { describe, expect, it } from 'vitest';
import { arrivalSummary, estimatedGap, predictionWindow } from './arrivalDetails';

describe('arrival detail window', () => {
  it('keeps a point visible across wide windows and reserves at-stop language for observed presence', () => {
    expect(arrivalSummary(390, 120, 1200, 0, 0).token).toBe('About 6 min\nLikely 2–20 min');
    expect(arrivalSummary(0).point).toBe('About <1 min');
    expect(arrivalSummary(0, 0, 600, 0, 0, true).token).toBe('At your stop');
  });
  it('preserves wide uncertainty and rounds the interval outwards', () => {
    expect(predictionWindow(3 * 60 + 45, 19 * 60 + 5, undefined, 0)?.text).toBe('3–20 min');
    expect(predictionWindow(-30, 8 * 60 + 5, undefined, 0)?.text).toBe('<1–9 min');
  });
  it('ages both bounds and handles arrival, absent and invalid data', () => {
    expect(predictionWindow(120, 480, 1000, 31000)?.text).toBe('1–8 min');
    expect(predictionWindow(0, 0)).toBeNull();
    expect(predictionWindow(undefined, 300)).toBeNull();
    expect(predictionWindow(300, 120)).toBeNull();
    expect(predictionWindow(NaN, 300)).toBeNull();
  });
});

it('reports a gap only for an available later arrival', () => {
  expect(estimatedGap(300, 780)).toBe(480);
  expect(estimatedGap(300, 300)).toBe(0);
  expect(estimatedGap(300, 200)).toBeNull();
  expect(estimatedGap(300, null)).toBeNull();
  expect(estimatedGap(300, Infinity)).toBeNull();
});
