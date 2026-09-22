import { expect, it } from 'vitest';
import { K10Clock } from './k10Clock.js';
import { K10_SCOPES } from './k10Scopes.js';
import { planTracks, type BusObservation, type BusState } from './detector.js';
import type { VisitEvent, VisitState } from './departure.js';

function harness(id: number) {
  const clock = new K10Clock(id), scope = K10_SCOPES[id]!;
  let now = Date.parse('2026-09-21T14:00:00Z'), index = scope.waitIndex, phase = 'hold', route = id;
  function tick(events: VisitEvent[] = [], step = 5000, contended = false) {
    now += step;
    const o = { busId: 42, busName: '#309', routeId: route, lat: 41.31, lon: -72.92,
      heading: 0, lastStopId: null, collectedAt: now } as BusObservation;
    const obs = contended ? [o, { ...o, busId: 43, routeId: 3 }] : [o];
    const state = { busId: 42, busName: '#309', routeId: route, lastObservedAt: now,
      nearestIndex: (index + 1) % scope.stopCount } as BusState;
    const visit = { pass: phase === 'hold' ? { stopIndex: index, arrivedAt: now } : null,
      transit: phase === 'drive' ? { fromIndex: index, departedAt: now } : null } as VisitState;
    clock.update(obs, events, new Map([['#309', state]]), new Map([['#309', visit]]), planTracks(obs));
    return clock.snapshot(now).get('309');
  }
  const departure = (i: number, how = 'far') => ({ kind: 'visit', busName: '#309', routeId: id,
    stopIndex: i, departedAt: now, arrivedAt: now - 5000, outcome: 'stopped', how } as VisitEvent);
  const warm = () => { for (let i = 0; i < 121; i++) tick(); };
  return { clock, tick, departure, warm, scope, now: () => now,
    move: (i: number, p = 'hold') => { index = i; phase = p; }, route: (r: number) => { route = r; } };
}

for (const route of [1, 16, 14, 15]) {
  it(`keeps route ${route}'s wait clock across route wraparound until observed departure`, () => {
    const h = harness(route); h.tick();
    expect(h.tick([h.departure(h.scope.sourceIndex)])).toBeUndefined(); h.warm();
    expect(h.tick()).toMatchObject({ routeId: route, index: h.scope.waitIndex, released: false });
    // Nearest GPS label is already downstream, but the visit is still holding.
    expect(h.tick([h.departure(h.scope.waitIndex, 'gap')])?.released).toBe(false);
    h.move(h.scope.waitIndex, 'drive'); expect(h.tick()?.released).toBe(true);
    // Even without a finalized wait visit, returning to the source cannot
    // reactivate the preceding lap's origin on the short West loop.
    h.move(h.scope.sourceIndex); expect(h.tick()?.released).toBe(true);
    h.move(h.scope.sourceIndex, 'drive');
    expect(h.tick([h.departure(h.scope.sourceIndex)])?.released).toBe(false);
  });
  it(`releases route ${route} on confirmed exit and discards broken identity/continuity`, () => {
    for (const cause of ['gap', 'route', 'contended'] as const) {
      const h = harness(route); h.tick(); h.tick([h.departure(h.scope.sourceIndex)]); h.warm();
      expect(h.tick([h.departure(h.scope.waitIndex)])?.released).toBe(true);
      if (cause === 'gap') h.tick([], 60_001);
      if (cause === 'route') { h.route(13); h.tick(); h.route(route); }
      if (cause === 'contended') h.tick([], 5000, true);
      h.warm(); expect(h.tick()).toBeUndefined();
    }
  });
  it(`expires route ${route}'s observation and never accepts a future checkpoint`, () => {
    const h = harness(route); h.tick(); h.warm();
    const future = { ...h.departure(h.scope.sourceIndex), departedAt: h.now() + 60_000 };
    expect(h.tick([future])).toBeUndefined();
    expect(h.tick([h.departure(h.scope.sourceIndex)])).toBeDefined();
    expect(h.clock.snapshot(h.now() - 1).size).toBe(0);
    expect(h.clock.snapshot(h.now() + 15_001).size).toBe(0);
  });
}
