import { afterEach, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrivalPlot, arrivalPlotLayout } from './ArrivalPlot';
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
const OLD_TZ = process.env.TZ;
afterEach(() => { process.env.TZ = OLD_TZ; });
it('labels the clock axis on the campus clock, whatever zone the phone is set to', () => {
  // A UTC phone used to label a 10:00 New Haven pickup "2:00 PM".
  const at = Date.parse('2026-09-18T10:00:00-04:00');
  const plot = () => renderToStaticMarkup(createElement(ArrivalPlot, {
    values: [at, at + 300_000, at + 600_000], title: 'Pickup', description: 'Forecast',
    markers: [{ value: at + 300_000, label: 'Estimate', color: '#000' }],
  }));
  process.env.TZ = 'America/New_York';
  expect(plot()).toContain('>10:00a</text>');
  expect(plot()).toContain('Estimate 10:05a</span>');
  process.env.TZ = 'UTC';
  expect(plot()).toContain('>10:00a ET</text>');
  expect(plot()).toContain('>10:10a ET</text>');
  expect(plot()).not.toMatch(/2:00/);
});
