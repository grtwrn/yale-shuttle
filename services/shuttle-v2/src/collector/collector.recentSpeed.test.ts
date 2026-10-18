import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDb, type DbBundle } from '../db/client.js';
import type { Route, Stop } from '../schema/api.js';
import { buildBusesPayload } from '../server/v1compat.js';
import { Collector } from './collector.js';
import { RecentSpeedTracker } from './recentSpeed.js';
import { UpstreamClient, type RawBus } from './upstream.js';

const BASE = Date.parse('2026-10-14T16:00:00Z');
const at = (metres: number) => ({ lat: 41.31 + metres / 111_320, lon: -72.93 });
const stops: Stop[] = [0, 500, 1000].map((m, i) => ({ id: i + 1, name: `Stop${i + 1}`, ...at(m) }));
const routes: Route[] = [{ id: 3, name: 'Red', shortName: 'R', color: '#C62828', stops: [1, 2, 3] }];
class Upstream extends UpstreamClient {
  batch: RawBus[] = [];
  constructor() { super({ baseUrl: 'http://invalid.test' }); }
  override async buses() { return this.batch; }
  override async stops() { return stops; }
  override async routes() { return routes; }
}
let bundle: DbBundle, collector: Collector, upstream: Upstream, dir: string;
let clock: ReturnType<typeof vi.spyOn>, warn: ReturnType<typeof vi.fn>;
const inner = () => collector as unknown as {
  runPoll(): Promise<void>;
  refreshStaticIfNeeded(force: boolean): Promise<void>;
};
beforeEach(async () => {
  clock = vi.spyOn(Date, 'now').mockReturnValue(BASE);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-speed-'));
  bundle = openDb(path.join(dir, 'test.db'));
  migrate(bundle.db, { migrationsFolder: './drizzle' });
  upstream = new Upstream(); warn = vi.fn();
  collector = await Collector.create(bundle, { upstream, logger: { info: vi.fn(), warn, error: vi.fn() } });
  await inner().refreshStaticIfNeeded(true);
});
afterEach(() => {
  collector?.stop(); bundle?.sqlite.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function poll(sec: number, fix = true) {
  clock.mockReturnValue(BASE + sec * 1000);
  upstream.batch = [{ id: 1, name: '#40', route: 3, ...at(sec * 10), heading: 0,
    lastStop: 1, ...(fix ? { lastUpdate: (BASE + sec * 1000) / 1000 } : {}) }];
  await inner().runPoll();
}
it('warms on collection, serves rounded display metadata, and keeps snapshots independent', async () => {
  const notified = vi.fn(); collector.setPollObserver(notified);
  for (let sec = 0; sec <= 20; sec += 5) await poll(sec);
  expect((buildBusesPayload(collector).buses as Array<{ recent_speed: unknown }>)[0]!.recent_speed).toBeNull();
  await poll(25);
  const live = collector.getLiveBuses()[0]!;
  expect(live.recentSpeed!.mph).toBeCloseTo(22.36936, 3);
  expect((buildBusesPayload(collector).buses as Array<{ recent_speed: unknown }>)[0]!.recent_speed)
    .toEqual({ mph: 20, at: BASE + 25_000, window_sec: 25, expires_at: BASE + 45_000 });
  live.lat = 0; live.recentSpeed!.mph = 999;
  expect(collector.getLiveBuses()[0]!.lat).toBe(at(250).lat);
  expect(collector.getLiveBuses()[0]!.recentSpeed!.mph).toBeCloseTo(22.36936, 3);
  expect(notified).toHaveBeenCalledTimes(6);
  expect(collector.collectorWitnessStats().captureErrors).toBe(0);
});
it('expires speed at read time even while the bus remains on the live map', async () => {
  for (let sec = 0; sec <= 30; sec += 5) await poll(sec);
  clock.mockReturnValue(BASE + 50_001);
  expect(collector.getLiveBuses()).toHaveLength(1);
  expect(collector.getLiveBuses()[0]!.recentSpeed).toBeUndefined();
  expect((buildBusesPayload(collector).buses as Array<{ recent_speed: unknown }>)[0]!.recent_speed).toBeNull();
});
it('does not infer speed from collector receipt times when provider fix times are absent', async () => {
  for (let sec = 0; sec <= 30; sec += 5) await poll(sec, false);
  expect(collector.getLiveBuses()[0]!.recentSpeed).toBeUndefined();
  expect((buildBusesPayload(collector).buses as Array<{ recent_speed: unknown }>)[0]!.recent_speed).toBeNull();
});
it('keeps collection, witnesses and the ETA observer working if the cosmetic estimator throws', async () => {
  const notified = vi.fn(); collector.setPollObserver(notified);
  vi.spyOn(RecentSpeedTracker.prototype, 'update').mockImplementation(() => { throw Error('isolated speed failure'); });
  await poll(0);
  expect(collector.getLiveBuses()).toHaveLength(1);
  expect(notified).toHaveBeenCalledTimes(1);
  expect(collector.collectorWitnessStats().captureErrors).toBe(0);
  expect(warn).toHaveBeenCalledWith('collector.recent_speed_failed', expect.any(Object));
});
