import { describe, expect, it, vi } from 'vitest';
import { TransitNetwork } from '../network/TransitNetwork.js';
import type { BusObservation } from './detector.js';
import { K10Tracker } from './k10Tracker.js';

const start = Date.parse('2026-09-21T14:00:00Z');
const stops = Array.from({ length: 29 }, (_, i) => ({ id: i + 1, name: `Stop ${i}`, lat: 41.3 + i * .0027, lon: -72.92 }));
const route = { id: 3, name: 'Red', shortName: 'R', color: '#f00', stops: stops.map(s => s.id) };
const network = TransitNetwork.build(stops, [route]);
const observations: BusObservation[] = [];
let time = start;
function point(index: number) {
  observations.push({ busId: 42, busName: '#309', routeId: 3, lat: 41.3 + index * .0027,
    lon: -72.92, heading: 0, lastStopId: null, collectedAt: time }); time += 5000;
}
for (let i = 3; i <= 16; i++) {
  for (let t = 0; t < 24; t++) point(i);
  for (let t = 1; t <= 12; t++) point(i + t / 12);
}
function replay(rows: readonly BusObservation[]) {
  const tracker = new K10Tracker();
  for (const o of rows) tracker.update(network, [o]);
  return tracker;
}
const at = observations.findIndex(o => o.lat === stops[14]!.lat);
const current = observations[at + 12]!;
const history = observations.filter(o => o.collectedAt < current.collectedAt);

describe('GPS history warmup', () => {
  it('restores the actual source clock immediately and keeps the exact live departure handoff', () => {
    const full = replay(history), restored = new K10Tracker(), query = vi.fn(() => history);
    full.update(network, [current]); restored.update(network, [current], query);
    expect(full.snapshot(current.collectedAt).get('309')?.released).toBe(false);
    expect(restored.snapshot(current.collectedAt)).toEqual(full.snapshot(current.collectedAt));
    expect(restored.stats()).toMatchObject({ attempts: 1, recovered: 1, errors: 0 });
    let released = false;
    for (const o of observations.filter(o => o.collectedAt > current.collectedAt)) {
      full.update(network, [o]); restored.update(network, [o], query);
      expect(restored.snapshot(o.collectedAt)).toEqual(full.snapshot(o.collectedAt));
      released ||= restored.snapshot(o.collectedAt).get('309')?.released === true;
    }
    expect(released).toBe(true); expect(query).toHaveBeenCalledTimes(1);
  });
  it('rejects future, unordered, wrong-name and oversized histories', () => {
    for (const rows of [[...history, current], [...history].reverse(), history.map(o => ({ ...o, busName: '#other' })), Array(1501).fill(history[0])]) {
      const tracker = new K10Tracker(); tracker.update(network, [current], () => rows);
      expect(tracker.snapshot(current.collectedAt).size).toBe(0);
      expect(tracker.stats().rejected).toBe(1);
    }
  });
  it('does not carry an origin across stale data, a route change, contention or a short history', () => {
    const cases = [history.filter(o => current.collectedAt-o.collectedAt>60_000), history.slice(-30),
      history.map((o,i) => i===history.length-40 ? { ...o, routeId: 1 } : o),
      history.flatMap((o,i) => i===history.length-40 ? [o,{ ...o,busId: 99 }] : [o]),
      history.filter((_,i) => i<history.length-60 || i>history.length-40)];
    for (const rows of cases) {
      const tracker = new K10Tracker(); tracker.update(network, [current], () => rows);
      expect(tracker.snapshot(current.collectedAt).size).toBe(0);
    }
  });
  it('follows a continuous provider-ID change, isolates other buses and expires evidence', () => {
    const tracker = new K10Tracker(); tracker.update(network, [{ ...current,busId: 99 }], () => history);
    expect(tracker.snapshot(current.collectedAt).get('309')).toBeDefined();
    tracker.update(network, [{ ...current,busName: '#310',busId: 100 }], () => history.map(o => ({ ...o,busName: '#310',busId: 100 })));
    expect(tracker.snapshot(current.collectedAt).size).toBe(2);
    expect(tracker.snapshot(current.collectedAt+15_001).size).toBe(0);
    tracker.update(network, [{ ...current,collectedAt: current.collectedAt+5000,routeId: 1 }]);
    expect(tracker.snapshot(current.collectedAt+5000).has('309')).toBe(false);
  });
  it('continues cold when the history store fails, without retrying each poll', () => {
    const tracker = new K10Tracker(), query = vi.fn(() => { throw new Error('DB unavailable'); });
    tracker.update(network, [current], query);
    tracker.update(network, [{ ...current,collectedAt: current.collectedAt+5000 }], query);
    expect(tracker.stats()).toMatchObject({ attempts: 1, errors: 1, cold: 1 });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
