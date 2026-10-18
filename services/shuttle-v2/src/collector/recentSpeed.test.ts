import { describe, expect, it } from 'vitest';
import { planTracks, type BusObservation } from './detector.js';
import { RecentSpeedTracker } from './recentSpeed.js';

const BASE = 1_780_000_000_000;
// Synthetic north/south coordinates use the network geometry's local metre scale.
const observation = (sec: number, metres: number, patch: Partial<BusObservation> = {}): BusObservation => ({
  busId: 1, busName: '#40', routeId: 3, lat: 41.31 + metres / 111_320, lon: -72.93,
  heading: 0, lastStopId: null, collectedAt: BASE + sec * 1000, ...patch,
});
function tick(tracker: RecentSpeedTracker, observations: BusObservation[],
  fix: (o: BusObservation) => number | null | undefined = o => o.collectedAt / 1000,
  now = observations[0]!.collectedAt) {
  tracker.update(observations, planTracks(observations), new Map(observations.map(o => [o.busId, fix(o)])), now);
}
const warm = (tracker: RecentSpeedTracker, speed = 10) => {
  for (let sec = 0; sec <= 30; sec += 5) tick(tracker, [observation(sec, sec * speed)]);
};

describe('recent GPS speed for display', () => {
  it('waits for a substantial history and estimates a known physical trajectory', () => {
    const tracker = new RecentSpeedTracker();
    for (let sec = 0; sec <= 20; sec += 5) tick(tracker, [observation(sec, sec * 10)]);
    expect(tracker.get('#40', BASE + 20_000)).toBeNull();
    tick(tracker, [observation(25, 250)]);
    expect(tracker.get('#40', BASE + 25_000)).toMatchObject({ windowSec: 25, at: BASE + 25_000 });
    expect(tracker.get('#40', BASE + 25_000)!.mph).toBeCloseTo(22.36936, 3);
  });

  it('uses a path, so a turn does not turn a moving bus into zero speed', () => {
    const tracker = new RecentSpeedTracker();
    for (let sec = 0; sec <= 30; sec += 5) tick(tracker, [observation(sec, sec <= 15 ? sec * 10 : (30 - sec) * 10)]);
    expect(tracker.get('#40', BASE + 30_000)!.mph).toBeCloseTo(22.36936, 3);
  });

  it('splits a segment at the thirty-second boundary instead of keeping an older fast leg', () => {
    const tracker = new RecentSpeedTracker();
    tick(tracker, [observation(0, 0)]);
    tick(tracker, [observation(10, 200)]);
    tick(tracker, [observation(20, 300)]);
    tick(tracker, [observation(35, 450)]);
    const speed = tracker.get('#40', BASE + 35_000)!;
    expect(speed.windowSec).toBe(30);
    expect(speed.mph).toBeCloseTo((350 / 30) * 2.2369362920544, 3);
  });

  it('does not call a frozen GPS window stopped, even with fresh provider timestamps', () => {
    const tracker = new RecentSpeedTracker();
    for (let sec = 0; sec <= 60; sec += 5) tick(tracker, [observation(sec, 0)]);
    expect(tracker.get('#40', BASE + 60_000)).toBeNull();
  });

  it('tolerates the observed repeated-fix pattern without an instantaneous speed spike', () => {
    const tracker = new RecentSpeedTracker();
    for (let sec = 0; sec <= 30; sec += 5) tick(tracker, [observation(sec, Math.floor(sec / 15) * 150)]);
    expect(tracker.get('#40', BASE + 30_000)!.mph).toBeCloseTo(22.36936, 3);
  });

  it('starts a new window after a reporting gap and expires a previously good estimate', () => {
    const tracker = new RecentSpeedTracker(); warm(tracker);
    expect(tracker.get('#40', BASE + 50_001)).toBeNull();
    tick(tracker, [observation(55, 550)]);
    expect(tracker.get('#40', BASE + 55_000)).toBeNull();
    for (let sec = 60; sec <= 80; sec += 5) tick(tracker, [observation(sec, sec * 10)]);
    expect(tracker.get('#40', BASE + 80_000)!.mph).toBeCloseTo(22.36936, 3);
  });

  it.each([undefined, null, NaN, Infinity, 0, (BASE - 60_000) / 1000, (BASE + 60_000) / 1000])
    ('does not manufacture speed from an unavailable, stale or future fix time (%s)', raw => {
      const tracker = new RecentSpeedTracker();
      for (let sec = 0; sec <= 30; sec += 5) tick(tracker, [observation(sec, sec * 10)], () => raw);
      expect(tracker.get('#40', BASE + 30_000)).toBeNull();
    });

  it('accepts millisecond fix times and publishes their earlier expiry', () => {
    const tracker = new RecentSpeedTracker();
    for (let sec = 0; sec <= 30; sec += 5) tick(tracker, [observation(sec, sec * 10)], o => o.collectedAt - 10_000);
    expect(tracker.get('#40', BASE + 30_000)!.expiresAt).toBe(BASE + 40_000);
    expect(tracker.get('#40', BASE + 40_001)).toBeNull();
  });

  it('keeps a continuous name across an ordinary provider-id reissue', () => {
    const tracker = new RecentSpeedTracker(); warm(tracker);
    tick(tracker, [observation(35, 350, { busId: 2 })]);
    expect(tracker.get('#40', BASE + 35_000)!.mph).toBeCloseTo(22.36936, 3);
  });

  it('separates simultaneously shared names and keeps the surviving stream on collapse', () => {
    const tracker = new RecentSpeedTracker();
    for (let sec = 0; sec <= 30; sec += 5) tick(tracker, [observation(sec, sec * 10),
      observation(sec, 1000 + sec * 5, { busId: 2 })]);
    expect(tracker.get('#40#1', BASE + 30_000)!.mph).toBeCloseTo(22.36936, 3);
    expect(tracker.get('#40#2', BASE + 30_000)!.mph).toBeCloseTo(11.18468, 3);
    tick(tracker, [observation(35, 1175, { busId: 2 })]);
    expect(tracker.get('#40#1', BASE + 35_000)).toBeNull();
    expect(tracker.get('#40', BASE + 35_000)!.mph).toBeCloseTo(11.18468, 3);
  });

  it('resets on a name or route reassignment and a physically implausible jump', () => {
    for (const patch of [{ busName: '#54' }, { routeId: 9 }, { lat: 42 }]) {
      const tracker = new RecentSpeedTracker(); warm(tracker);
      tick(tracker, [observation(35, 350, patch)]);
      expect(tracker.get(patch.busName ?? '#40', BASE + 35_000)).toBeNull();
    }
  });

  it('does not let an older observation change a valid current window', () => {
    const tracker = new RecentSpeedTracker(); warm(tracker);
    const before = tracker.get('#40', BASE + 30_000);
    tick(tracker, [observation(25, 500)], undefined, BASE + 30_000);
    expect(tracker.get('#40', BASE + 30_000)).toEqual(before);
  });

  it('keeps highway travel rather than clipping it to campus speeds', () => {
    const tracker = new RecentSpeedTracker(); warm(tracker, 30);
    expect(tracker.get('#40', BASE + 30_000)!.mph).toBeCloseTo(67.10809, 3);
  });

  it('drops a warmed estimate immediately when the GPS metadata becomes invalid', () => {
    const tracker = new RecentSpeedTracker(); warm(tracker);
    tick(tracker, [observation(35, 350)], () => NaN);
    expect(tracker.get('#40', BASE + 35_000)).toBeNull();
    for (let sec = 40; sec <= 60; sec += 5) tick(tracker, [observation(sec, sec * 10)]);
    expect(tracker.get('#40', BASE + 60_000)).toBeNull();
    tick(tracker, [observation(65, 650)]);
    expect(tracker.get('#40', BASE + 65_000)!.mph).toBeCloseTo(22.36936, 3);
  });

  it('rejects a backwards fix clock or different coordinates for the same fix time', () => {
    for (const fixAt of [BASE + 29_000, BASE + 30_000]) {
      const tracker = new RecentSpeedTracker(); warm(tracker);
      tick(tracker, [observation(35, 350)], () => fixAt);
      expect(tracker.get('#40', BASE + 35_000)).toBeNull();
    }
  });

  it('bounds inactive and excessive per-vehicle state', () => {
    const tracker = new RecentSpeedTracker();
    const rows = Array.from({ length: 300 }, (_, i) => observation(0, i, { busId: i, busName: `#${i}` }));
    tick(tracker, rows);
    expect(tracker.trackedCount).toBeLessThanOrEqual(256);
    tracker.update([], planTracks([]), new Map(), BASE + 60_001);
    expect(tracker.trackedCount).toBe(0);
  });
});
