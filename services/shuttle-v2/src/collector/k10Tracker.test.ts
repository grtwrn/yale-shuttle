import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDb } from '../db/client.js';
import { Collector } from './collector.js';
import { UpstreamClient, type RawBus } from './upstream.js';
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

it('restores through the real collector query without inserting historical events', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'k10-warmup-'));
  const bundle = openDb(path.join(dir, 'test.db'));
  migrate(bundle.db, { migrationsFolder: './drizzle' });
  class Stub extends UpstreamClient {
    constructor() { super({ baseUrl: 'http://invalid.test' }); }
    override async stops() { return stops; }
    override async routes() { return [route]; }
    override async buses(): Promise<RawBus[]> {
      return [{ id: current.busId, name: current.busName, route: current.routeId,
        lat: current.lat, lon: current.lon, heading: current.heading, lastStop: current.lastStopId } as RawBus];
    }
  }
  const insert = bundle.sqlite.prepare('INSERT INTO raw_positions (bus_id,bus_name,route_id,lat,lon,heading,last_stop_id,collected_at) VALUES (@busId,@busName,@routeId,@lat,@lon,@heading,@lastStopId,@collectedAt)');
  bundle.sqlite.transaction(() => { for (const o of history) insert.run(o); })();
  let collector: Collector | undefined;
  type Inner = { runPoll(): Promise<void>; refreshStaticIfNeeded(force: boolean): Promise<void> };
  vi.useFakeTimers(); vi.setSystemTime(current.collectedAt);
  try {
    collector = await Collector.create(bundle, { upstream: new Stub() });
    await (collector as unknown as Inner).refreshStaticIfNeeded(true);
    await (collector as unknown as Inner).runPoll();
    const expected = replay([...history,current]).snapshot(current.collectedAt);
    expect(expected.size).toBe(1);
    expect(collector.k10Evidence(current.collectedAt)).toEqual(expected);
    expect(collector.pollStats().k10History).toMatchObject({ recovered: 1, errors: 0 });
    expect(bundle.sqlite.prepare('SELECT COUNT(*) AS n FROM arrivals WHERE arrived_at < ?').get(current.collectedAt)).toEqual({ n: 0 });
    expect(bundle.sqlite.prepare('SELECT COUNT(*) AS n FROM stop_visits').get()).toEqual({ n: 0 });
    expect(bundle.sqlite.prepare('SELECT COUNT(*) AS n FROM raw_positions').get()).toEqual({ n: history.length + 1 });
  } finally {
    collector?.stop(); vi.useRealTimers(); bundle.sqlite.close(); rmSync(dir, { recursive: true, force: true });
  }
});
