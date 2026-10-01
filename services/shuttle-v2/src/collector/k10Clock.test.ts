import { expect, it } from 'vitest';
import { K10Clock } from './k10Clock.js';
import { planTracks, type BusObservation, type BusState } from './detector.js';
import type { VisitEvent, VisitState } from './departure.js';

const start = Date.parse('2026-09-21T14:00:00Z');
function harness() {
  const clock = new K10Clock();
  let now = start, index = 8, phase = 'hold', routeId = 3;
  const tick = (events: VisitEvent[] = [], step = 5000, busId = 42) => {
    now += step;
    const obs = { busId, busName: '309', routeId, lat: 41.31, lon: -72.92, heading: 0, lastStopId: null, collectedAt: now } as BusObservation;
    const state = { busId, busName: '309', routeId, lastObservedAt: now } as BusState;
    const visit = { pass: phase === 'hold' ? { stopIndex: index, arrivedAt: now } : null,
      transit: phase === 'drive' ? { fromIndex: index, departedAt: now } : null } as VisitState;
    clock.update([obs], events, new Map([['309',state]]), new Map([['309',visit]]), planTracks([obs]));
    return clock.snapshot(now).get('309');
  };
  const departure = (i: number, how = 'far') => ({ kind: 'visit', busName: '309', routeId: 3,
    stopIndex: i, departedAt: now, arrivedAt: now - 5000, outcome: 'stopped', how } as VisitEvent);
  const warm = () => { for (let i = 0; i < 121; i++) tick(); };
  return { clock, tick, departure, warm, now: () => now,
    move: (i: number, p = 'hold') => { index = i; phase = p; }, route: (id: number) => { routeId = id; } };
}

it('requires a live confirmed checkpoint and warm observations, then releases on observed exit', () => {
  const h = harness(); h.tick();
  expect(h.tick([h.departure(4)])).toBeUndefined(); h.warm();
  expect(h.tick()?.released).toBe(false);
  h.move(14); expect(h.tick()?.released).toBe(false); // waiting at Winchester
  h.move(14, 'drive'); expect(h.tick()?.released).toBe(true);
  h.move(15); expect(h.tick()?.released).toBe(true); // pass-through without finalized visit
});
it('uses known-at, not backdated departure time, and does not release on an unresolved shuffle', () => {
  const h = harness(); h.tick(); h.tick([h.departure(4)]); h.warm(); h.move(14);
  expect(h.tick([h.departure(14, 'gap')])?.released).toBe(false);
  const event = h.departure(14); expect(h.clock.snapshot(h.now()).get('309')?.released).toBe(false);
  expect(h.tick([event])?.released).toBe(true);
});
it('drops old clocks on gaps, route changes, restart and a new lap', () => {
  for (const cause of ['gap','route','lap'] as const) {
    const h = harness(); h.tick(); h.tick([h.departure(4)]); h.warm(); expect(h.tick()).toBeDefined();
    if (cause === 'gap') h.tick([], 60_001);
    if (cause === 'route') { h.route(1); h.tick(); h.route(3); }
    if (cause === 'lap') { h.move(0); h.tick(); h.move(8); }
    h.warm(); expect(h.tick()).toBeUndefined();
  }
  expect(new K10Clock().snapshot(start).size).toBe(0);
});
it('expires unobserved evidence and follows a continuous provider-ID change by bus name', () => {
  const h = harness(); h.tick(); h.tick([h.departure(4)]); h.warm();
  expect(h.tick([], 5000, 99)).toBeDefined();
  expect(h.clock.snapshot(h.now() + 15_001).size).toBe(0);
});
