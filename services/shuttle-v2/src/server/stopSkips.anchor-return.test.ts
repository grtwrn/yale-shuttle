import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TransitNetwork } from '../network/TransitNetwork.js';
import type { Route, Stop } from '../schema/api.js';
import { classifyPasses, stopSkipsOf, type Fix, type VisitRow } from './stopSkips.js';

const fx = JSON.parse(readFileSync(new URL('./__fixtures__/blue-anchor-return-20261017.json', import.meta.url), 'utf8')) as {
  route: Route; stops: Stop[]; asOf: number; fixes: Fix[];
  visits: { bus_id: number; route_id: number; stop_id: number; stop_index: number; anchored_at: number; closest_m: number; pinned_at: number | null }[];
  hypotheticalPriorSkip: { routeId: number; stopId: number; at: number; verdict: 'skipped' };
};
const blue = TransitNetwork.build(fx.stops, [fx.route]);
const original = fx.visits.map(v => ({ busId: v.bus_id, routeId: v.route_id, stopId: v.stop_id, stopIndex: v.stop_index, anchoredAt: v.anchored_at, closestM: v.closest_m }));
const blueTrack = (id: number, from: number, to: number) => id === 67825 ? fx.fixes.filter(f => f.at >= from && f.at <= Math.min(to, fx.asOf)) : [];

it('the real Blue return counts the later near visit and clears a modeled earlier skip without rewriting observations', () => {
  const before = JSON.stringify(original), passes = classifyPasses(original, blue, blueTrack, fx.asOf);
  const ghost = fx.visits.find(v => v.stop_id === 116 && v.pinned_at === null)!;
  const reached = fx.visits.find(v => v.stop_id === 116 && v.pinned_at !== null)!;
  expect(passes.find(p => p.stopId === 116)).toEqual({ routeId: 4, stopId: 116, at: reached.anchored_at, verdict: 'served' });
  expect(passes.some(p => p.at === ghost.anchored_at)).toBe(false);
  // The extra earlier skip is explicitly modeled, not an observed bus or notice.
  expect(stopSkipsOf([...passes, fx.hypotheticalPriorSkip], blue, fx.asOf)).toBeNull();
  expect(JSON.stringify(original)).toBe(before);
});

const T = Date.parse('2026-10-17T17:00:00Z'), DEG = 1 / 111_320;
const stops: Stop[] = [1, 2, 3, 4, 5].map((id) => ({ id, name: 'Stop ' + id, lat: 41.3 + (id - 1) * 400 * DEG, lon: -72.93 }));
const net = TransitNetwork.build(stops, [{ id: 50, name: 'Test', shortName: 'T', color: '000000', stops: [1, 2, 3, 4, 5] }]);
const row = (index: number, sec: number, closestM = 0): VisitRow => ({ busId: 7, routeId: 50, stopId: index + 1, stopIndex: index, anchoredAt: T + sec * 1000, closestM });
const trackOf = (fixes: Fix[]) => (bus: number, from: number, to: number) => bus === 7 ? fixes.filter(f => f.at >= from && f.at <= to) : [];
function fixesAlong(points: [number, number, number][]): Fix[] {
  const out: Fix[] = [];
  for (let sec = points[0]![0]; sec <= points.at(-1)![0]; sec += 5) {
    let i = 0; while (i + 1 < points.length - 1 && points[i + 1]![0] < sec) i++;
    const a = points[i]!, b = points[i + 1]!, f = (sec - a[0]) / (b[0] - a[0]);
    out.push({ at: T + sec * 1000, lat: a[1] + f * (b[1] - a[1]), lon: a[2] + f * (b[2] - a[2]) });
  }
  return out;
}
function approach() {
  const p = stops[1]!, target = stops[2]!, next = stops[3]!;
  return { visits: [row(1, 0), row(2, 120, 400), row(3, 125, 800), row(2, 180), row(3, 400)],
    fixes: fixesAlong([[0, p.lat, p.lon], [250, p.lat, p.lon], [340, target.lat, target.lon], [400, next.lat, next.lon]]) };
}
const targetPasses = (visits: VisitRow[], fixes: Fix[], now = T + 500_000) => classifyPasses(visits, net, trackOf(fixes), now).filter(p => p.stopId === 3);

describe('continuous and directional evidence for an anchor return', () => {
  it('uses only raw observations available at the decision clock', () => {
    const a = approach();
    expect(targetPasses(a.visits, a.fixes, T + 300_000).some(p => p.verdict === 'served')).toBe(false);
    expect(targetPasses(a.visits, a.fixes, T + 340_000).map(p => p.verdict)).toEqual(['served']);
  });
  it.each([{ gapMs: 60_000, recovered: true }, { gapMs: 60_001, recovered: false }])(
    'requires uninterrupted evidence at the existing gap boundary: $gapMs ms', ({ gapMs, recovered }) => {
      const a = approach();
      const fixes = a.fixes.filter(f => f.at <= T + 275_000 || f.at >= T + 335_000)
        .map(f => f.at === T + 335_000 ? { ...f, at: T + 275_000 + gapMs } : f);
      expect(targetPasses(a.visits, fixes).some(p => p.verdict === 'served')).toBe(recovered);
    });
  it('does not manufacture a near visit from the row alone when GPS disagrees', () => {
    const a = approach(), offset = 100 / (111_320 * Math.cos(41.3 * Math.PI / 180));
    expect(targetPasses(a.visits, a.fixes.map(f => ({ ...f, lon: f.lon + offset }))).some(p => p.verdict === 'served')).toBe(false);
  });
  it('preserves the direction guard when the previous near stop is on another leg', () => {
    const a = approach();
    expect(targetPasses([row(4, 0), ...a.visits.slice(1)], a.fixes)).toEqual([]);
  });
  it('does not collapse a completed forward lap into a short return', () => {
    const order = [0, 1, 2, 3, 4, 0, 1, 2], offset = 175 / (111_320 * Math.cos(41.3 * Math.PI / 180));
    const visits = order.map((index, i) => row(index, i * 120, i === 0 || i === order.length - 1 ? 0 : 175));
    const points: [number, number, number][] = order.map((index, i) => [i * 120, stops[index]!.lat,
      stops[index]!.lon + (i === 0 || i === order.length - 1 ? 0 : offset)]);
    const result = targetPasses(visits, fixesAlong(points), T + 900_000);
    expect(result).toContainEqual({ routeId: 50, stopId: 3, at: T + 240_000, verdict: 'skipped' });
    expect(result).toContainEqual({ routeId: 50, stopId: 3, at: T + 840_000, verdict: 'served' });
  });
  it('retains a genuine intermediate skip while resolving the next stop return', () => {
    const offset = 175 / (111_320 * Math.cos(41.3 * Math.PI / 180)), p = stops[0]!, middle = stops[1]!, target = stops[2]!, next = stops[3]!;
    const visits = [row(0, 0), row(1, 120, 175), row(2, 240, 260), row(3, 245, 600), row(2, 300), row(3, 600)];
    const fixes = fixesAlong([[0, p.lat, p.lon], [120, middle.lat, middle.lon + offset],
      [240, target.lat - 200 * DEG, target.lon + offset], [450, target.lat, target.lon], [600, next.lat, next.lon]]);
    const passes = classifyPasses(visits, net, trackOf(fixes), T + 700_000);
    expect(passes).toContainEqual({ routeId: 50, stopId: 2, at: T + 120_000, verdict: 'skipped' });
    expect(passes.find(p => p.stopId === 3)).toEqual({ routeId: 50, stopId: 3, at: T + 300_000, verdict: 'served' });
  });
  it('does not join approaches beyond the existing twenty minute context', () => {
    const a = approach(), visits = a.visits.map((v, i) => i >= 3 ? { ...v, anchoredAt: v.anchoredAt + 1_200_000 } : v);
    expect(targetPasses(visits, a.fixes, T + 2_000_000).some(p => p.verdict === 'served')).toBe(false);
  });
});
