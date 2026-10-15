import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { confirmConflict, pickupCountConflict } from './screen-consistency.mjs';
const capture = JSON.parse(fs.readFileSync(new URL('../../web/src/__fixtures__/red-winchester-report-142.json', import.meta.url), 'utf8'));
const text = '🚌 #317 · 11 stops away\nBOARDDivision/Prospect\nGET OFF130 Prospect Street (S)';
const conflict = () => pickupCountConflict(text, structuredClone(capture.feed), [3], capture.receivedAt);
describe('independent rider screen count', () => {
  it('detects the reported 11-versus-3 contradiction and accepts the fixed screen', () => {
    expect(conflict()).toMatchObject({ bus: '#317', standingStop: 11, boardStop: 48, actual: 11, expected: 3 });
    expect(pickupCountConflict(text.replace('11 stops', '3 stops'), capture.feed, [3], capture.receivedAt)).toBeNull();
  });
  it.each(['moving', 'old', 'distant', 'folded', 'wrong line', 'unknown stop', 'ambiguous screen', 'approach', 'missing model'])('declines %s evidence', reason => {
    const feed = structuredClone(capture.feed), bus = feed.buses.find(b => b.bus_name === '#317');
    let screen = text, routes = [3];
    if (reason === 'moving') bus.stationary = false;
    if (reason === 'old') bus.observed_at = capture.receivedAt - 30_000;
    if (reason === 'distant') bus.lat = 42;
    if (reason === 'folded') feed.routes['3'].push(11);
    if (reason === 'wrong line') routes = [19];
    if (reason === 'unknown stop') screen = text.replace('Division/Prospect', 'Unknown');
    if (reason === 'ambiguous screen') screen += '\n🚌 #126 · 2 stops away';
    if (reason === 'approach') feed.server_eta.buses[0][3].approach = true;
    if (reason === 'missing model') delete feed.server_eta;
    expect(pickupCountConflict(screen, feed, routes, capture.receivedAt)).toBeNull();
  });
  it('confirms two distinct observations, deduplicates, and resets on recovery', () => {
    const c = conflict(), now = capture.receivedAt;
    const first = confirmConflict(null, c, now);
    expect(first.alert).toBeNull();
    expect(confirmConflict(first.state, c, now + 10_000).alert).toBeNull(); // cached poll
    const next = { ...c, observedAt: c.observedAt + 10_000 };
    const second = confirmConflict(first.state, next, now + 10_000);
    expect(second.alert).toEqual(next);
    expect(confirmConflict(second.state, { ...next, observedAt: next.observedAt + 10_000 }, now + 20_000).alert).toBeNull();
    expect(confirmConflict(second.state, null, now + 20_000)).toEqual({ state: null, alert: null });
    expect(confirmConflict(first.state, next, now + 60_000).alert).toBeNull(); // interrupted observation
  });
});
