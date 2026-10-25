import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { confirmConflict, pickupCountConflict, rideCountConflict, rideTrackingConflict } from './screen-consistency.mjs';
import { verifyFeedResponseRecord } from './feed-evidence.mjs';
const capture = JSON.parse(fs.readFileSync(new URL('../../web/src/__fixtures__/red-winchester-report-142.json', import.meta.url), 'utf8'));
const text = '🚌 #317 · 11 stops away\nBOARDDivision/Prospect\nGET OFF130 Prospect Street (S)';
const conflict = () => pickupCountConflict(text, structuredClone(capture.feed), [3], capture.receivedAt);
const positionFixture = JSON.parse(fs.readFileSync(new URL('../../web/src/__fixtures__/ride-position-without-eta-20261025.json', import.meta.url), 'utf8'));
function positionInput(index = 0) {
  const s = positionFixture.snapshots[index], ride = positionFixture.ride;
  return { text: s.text, now: Date.parse(s.sampledAt), feed: JSON.parse(verifyFeedResponseRecord(s.response)),
    run: { id: positionFixture.runId, phase: 'riding', line: structuredClone(positionFixture.line), busName: ride.busName,
      boardStopId: ride.boardStopId, exitStopId: ride.alightStopId, boardedStorage: structuredClone(positionFixture.boardedStorage) } };
}
describe('independent ride tracking status', () => {
  it('detects the two original GPS-present screens without relying on a forecast or route filter', () => {
    for (const index of [0, 1]) {
      const p = positionInput(index);
      expect(rideTrackingConflict(p.text, p.feed, p.run, p.now)).toMatchObject({ bus: '#44', expected: 'bus-position-available', actual: 'looking-for-bus' });
      const corrected = p.text.replace('Looking for your bus…', 'Bus location available · arrival estimate unavailable');
      expect(rideTrackingConflict(corrected, p.feed, p.run, p.now)).toBeNull();
    }
  });
  it.each(['waiting', 'wrong storage', 'wrong caption', 'old GPS', 'future GPS', 'wrong bus', 'wrong route', 'duplicate GPS', 'invalid GPS'])(
    'declines %s evidence', reason => {
      const p = positionInput(), bus = p.feed.buses.find(b => b.bus_name === '#44');
      if (reason === 'waiting') p.run.phase = 'waiting';
      if (reason === 'wrong storage') p.run.boardedStorage['shuttle-boarded-ride'] = '{}';
      if (reason === 'wrong caption') p.text = p.text.replace('#44 →', '#54 →');
      if (reason === 'old GPS') bus.observed_at = p.now - 30000;
      if (reason === 'future GPS') bus.observed_at = p.now + 5001;
      if (reason === 'wrong bus') bus.bus_name = '#55';
      if (reason === 'wrong route') bus.route_id = 3;
      if (reason === 'duplicate GPS') p.feed.buses.push({ ...bus });
      if (reason === 'invalid GPS') bus.lat = NaN;
      expect(rideTrackingConflict(p.text, p.feed, p.run, p.now)).toBeNull();
    });
  it('confirms distinct original observations, and clears a corrected or raced screen', () => {
    const a = positionInput(), b = positionInput(1);
    const first = confirmConflict(null, rideTrackingConflict(a.text, a.feed, a.run, a.now), a.now);
    expect(first.alert).toBeNull();
    expect(confirmConflict(first.state, rideTrackingConflict(a.text, a.feed, a.run, a.now), b.now).alert).toBeNull();
    const second = confirmConflict(first.state, rideTrackingConflict(b.text, b.feed, b.run, b.now), b.now);
    expect(second.alert).toMatchObject({ bus: '#44' });
    expect(confirmConflict(second.state, null, b.now).state).toBeNull();
  });
});
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

const pink = JSON.parse(fs.readFileSync(new URL('../../web/src/__fixtures__/pink-standing-travel-20261023.json', import.meta.url), 'utf8'));
const rideText = '🔔\nYour stop is 10 stops away\nPink #324 → VA Entrance Inbound\nGot it\n10 stops · holding at VA Entrance Outbound\n🚌 Pink #324 → VA Entrance Inbound';
function pinkInput(index = 1) {
  const capture = structuredClone(pink.snapshots[index]);
  return {now: Date.parse(capture.sampleAt), feed: {buses: [capture.bus], routes: capture.routeStops,
    stop_names: capture.stopNames, server_eta: capture.wire}, run: {id: pink.runId, phase: 'riding',
    line: {label: 'Pink', busRouteIds: [8]}, busName: '#324', boardStopId: 149, exitStopId: 123,
    boardedStorage: structuredClone(pink.boardedStorage)}};
}
describe('independent on-bus added-pass count', () => {
  it('also keeps the pickup check on the added pass (source-derived waiting-screen control)', () => {
    const {now, feed} = pinkInput();
    feed.stop_coords = structuredClone(pink.snapshots[1].stopCoords);
    const screen = '🚌 #324 · 1 stop away\nBOARDVA Entrance Inbound\nGET OFFVA Hospital';
    expect(pickupCountConflict(screen, feed, [8], now)).toBeNull();
    expect(pickupCountConflict(screen.replace('1 stop', '10 stops'), feed, [8], now))
      .toMatchObject({expected: 1, actual: 10, boardStop: 123, standingStop: 124});
  });
  it.each([1, 2, 3])('catches actual Pink snapshot %s and accepts the next-stop screen', index => {
    const {now, feed, run} = pinkInput(index);
    expect(rideCountConflict(rideText, feed, run, now)).toMatchObject({expected: 1, actual: 10, travelIndex: 5, exitStopId: 123});
    const fixed = rideText.replace('Your stop is 10 stops away', 'Get off at the next stop').replace('10 stops ·', 'Get off NEXT stop! ·');
    expect(rideCountConflict(fixed, feed, run, now)).toBeNull();
  });
  it.each(['waiting', 'old GPS', 'future GPS', 'missing wire', 'missing travel', 'same pass', 'repeated list',
    'duplicate bus', 'wrong ride storage', 'wrong caption', 'ambiguous counts'])('declines %s evidence', reason => {
    const {now, feed, run} = pinkInput(); let screen = rideText;
    if (reason === 'waiting') run.phase = 'waiting';
    if (reason === 'old GPS') feed.buses[0].observed_at = now - 30_000;
    if (reason === 'future GPS') feed.buses[0].observed_at = now + 5001;
    if (reason === 'missing wire') delete feed.server_eta;
    if (reason === 'missing travel') delete feed.server_eta.travel;
    if (reason === 'same pass') feed.server_eta.travel[0] = feed.server_eta.buses[0][2];
    if (reason === 'repeated list') feed.routes['8'].push(124);
    if (reason === 'duplicate bus') feed.buses.push(structuredClone(feed.buses[0]));
    if (reason === 'wrong ride storage') run.boardedStorage['shuttle-boarded-ride'] = '{}';
    if (reason === 'wrong caption') screen = screen.replaceAll('#324', '#325');
    if (reason === 'ambiguous counts') screen += '\nYour stop is 3 stops away';
    expect(rideCountConflict(screen, feed, run, now)).toBeNull();
  });
  it('requires two fresh observed snapshots and deduplicates the resulting source-consistency lead', () => {
    const a = pinkInput(1), b = pinkInput(2);
    const first = confirmConflict(null, rideCountConflict(rideText, a.feed, a.run, a.now), a.now);
    expect(first.alert).toBeNull();
    expect(confirmConflict(first.state, rideCountConflict(rideText, a.feed, a.run, a.now), b.now).alert).toBeNull();
    const second = confirmConflict(first.state, rideCountConflict(rideText, b.feed, b.run, b.now), b.now);
    expect(second.alert).toMatchObject({expected: 1, actual: 10});
    expect(confirmConflict(second.state, second.alert, b.now + 1000).alert).toBeNull();
    expect(confirmConflict(second.state, null, b.now + 1000).state).toBeNull();
  });
});
