import { expect, it } from 'vitest';
import { arrivalPlotLayout } from './ArrivalPlot';
it('keeps late outcomes, class deadline and walk estimate on the clock axis', () => {
  const now = 1_000_000;
  const markers = [{ value: now + 600_000, label: 'Class', color: '#000' }, { value: now + 900_000, label: 'Walk', color: '#999' }];
  const p = arrivalPlotLayout([now, now + 300_000, now + 1_200_000], markers, true);
  for (const n of [now, now + 1_200_000, ...markers.map(m => m.value)]) {
    expect(p.x(n)).toBeGreaterThanOrEqual(26); expect(p.x(n)).toBeLessThanOrEqual(314);
  }
  expect(p.dots).toHaveLength(3);
});
it('stacks concentrated outcomes without hiding points or breaking a degenerate axis', () => {
  const p = arrivalPlotLayout(Array(50).fill(60), [], false);
  expect(p.dots).toHaveLength(50);
  expect(new Set(p.dots.map(d => d.stack)).size).toBe(50);
  expect(p.baseline - p.dots[49]!.stack * 7).toBeGreaterThan(0);
  expect(p.max).toBeGreaterThan(p.min);
});
