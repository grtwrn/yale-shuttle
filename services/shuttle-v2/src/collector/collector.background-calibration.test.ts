import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDb, type DbBundle } from '../db/client.js';
import { calibrationReader } from '../db/calibrationSnapshot.js';
import { calibrateNetwork } from '../calibrator/networkCalibration.js';
import type { CalibrationRequest, CalibrationResult } from '../calibrator/calibrationWorker.js';
import { validCalibrationSource } from '../calibrator/provenance.js';
import { TransitNetwork } from '../network/TransitNetwork.js';
import { witnessJSON, witnessSHA } from './witnessCodec.js';
import { Collector } from './collector.js';
import { UpstreamClient, type RawBus } from './upstream.js';

const stops = [{ id: 1, name: 'A', lat: 41.31, lon: -72.92 }, { id: 2, name: 'B', lat: 41.311, lon: -72.921 }];
const routes = [{ id: 1, name: 'Test', shortName: 'T', color: '#123456', stops: [1, 2] }];
class Stub extends UpstreamClient {
  busCalls = 0;
  constructor() { super({ baseUrl: 'http://invalid.test' }); }
  override async stops() { return stops; }
  override async routes() { return routes; }
  override async announcements() { return []; }
  override async buses(): Promise<RawBus[]> { this.busCalls++; return []; }
}
let directory: string, bundle: DbBundle, collector: Collector, upstream: Stub;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
type Inner = {
  calibrationWorker: unknown;
  runCalibrate(): void | Promise<void>;
  refreshStaticIfNeeded(force: boolean): Promise<void>;
  runPoll(): Promise<void>;
  lapFitsCache: unknown;
};
const inner = () => collector as unknown as Inner;

/** Controlled completion order, with tables/receipts computed by the real
 * unchanged calculator on this local fixture. This is not a latency profile. */
class DeferredWorker {
  close = vi.fn();
  busy = false;
  readonly jobs: Array<{ result: CalibrationResult; resolve(value: CalibrationResult): void; reject(error: Error): void }> = [];
  private requestResolvers: Array<{ count: number; resolve(): void }> = [];
  run(topology: CalibrationRequest['topology']) {
    const network = TransitNetwork.fromObservationTopology(structuredClone(topology));
    const stats = calibrateNetwork(bundle.db, bundle.sqlite, network,
      { lapFitsCache: null, releaseFitsCache: null, hourStandGateCache: null }, calibrationReader(bundle.sqlite));
    const result: CalibrationResult = { kind: 'result', id: this.jobs.length + 1, stats,
      tables: network.calibrationTables(), workerElapsedMs: 1, topologySHA256: witnessSHA(witnessJSON(topology)) };
    return new Promise<CalibrationResult>((resolve, reject) => {
      this.jobs.push({ result, resolve, reject });
      for (const waiter of this.requestResolvers) if (this.jobs.length >= waiter.count) waiter.resolve();
    });
  }
  requested(count: number) {
    return this.jobs.length >= count ? Promise.resolve() : new Promise<void>(resolve => this.requestResolvers.push({ count, resolve }));
  }
}
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-collector-background-'));
  bundle = openDb(path.join(directory, 'test.db')); migrate(bundle.db, { migrationsFolder: './drizzle' });
  for (const stop of stops) bundle.sqlite.prepare('INSERT INTO stops(id,name,lat,lon,updated_at) VALUES (?,?,?,?,?)').run(stop.id, stop.name, stop.lat, stop.lon, Date.now());
  bundle.sqlite.prepare('INSERT INTO routes(id,name,short_name,color,stops_json,updated_at) VALUES (?,?,?,?,?,?)').run(1, 'Test', 'T', '#123456', '[1,2]', Date.now());
  const segment = bundle.sqlite.prepare("INSERT INTO segments(bus_id,bus_name,route_id,from_stop_id,to_stop_id,travel_sec,started_at,dow,hour) VALUES (1,'#1',1,1,2,60,?,4,17)");
  const arrival = bundle.sqlite.prepare("INSERT INTO arrivals(bus_id,bus_name,route_id,stop_id,arrived_at,departed_at,dwell_sec,dow,hour) VALUES (1,'#1',1,1,?,?,20,4,17)");
  bundle.sqlite.transaction(() => {
    for (let n = 0; n < 20; n++) {
      const at = Date.now() - 3600_000 + n * 1000;
      segment.run(at); arrival.run(at, at + 20_000);
    }
  })();
  upstream = new Stub(); vi.clearAllMocks();
  collector = await Collector.create(bundle, { upstream, logger });
});
afterEach(() => { collector.stop(); if (bundle.sqlite.open) bundle.sqlite.close(); fs.rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('collector background publication', () => {
  it('publishes tables, source and cache version in the same microtask', async () => {
    const worker = new DeferredWorker(); inner().calibrationWorker = worker;
    const network = collector.ref.get(), before = collector.dataVersion();
    const original = network.setCalibration.bind(network), observed: Array<{ source: unknown; version: number }> = [];
    vi.spyOn(network, 'setCalibration').mockImplementation((...args) => {
      original(...args);
      queueMicrotask(() => observed.push({ source: collector.calibrationSource(), version: collector.dataVersion() }));
    });
    const pending = inner().runCalibrate();
    expect(collector.calibrationSource()).toBeNull();
    expect(network.calibrationTables()).not.toEqual(worker.jobs[0]!.result.tables);
    expect(collector.dataVersion()).toBe(before);
    worker.jobs[0]!.resolve(worker.jobs[0]!.result);
    await pending;
    expect(network.calibrationTables()).toEqual(worker.jobs[0]!.result.tables);
    expect(observed).toEqual([{ source: worker.jobs[0]!.result.stats.calibrationSource, version: before + 1 }]);
  });

  it('continues collecting while a periodic result is pending', async () => {
    const worker = new DeferredWorker(); inner().calibrationWorker = worker;
    const pending = inner().runCalibrate();
    await inner().runPoll();
    expect(upstream.busCalls).toBe(1);
    expect(collector.collectorWitnessReference()).not.toBeNull();
    expect(collector.calibrationSource()).toBeNull();
    worker.jobs[0]!.resolve(worker.jobs[0]!.result); await pending;
    expect(validCalibrationSource(collector.calibrationSource())).toBe(true);
  });

  it('keeps the last published generation after failure and accepts a later successful job', async () => {
    const worker = new DeferredWorker(); inner().calibrationWorker = worker;
    const first = inner().runCalibrate(); worker.jobs[0]!.resolve(worker.jobs[0]!.result); await first;
    const source = collector.calibrationSource(), tables = collector.ref.get().calibrationTables(), version = collector.dataVersion();
    const failing = inner().runCalibrate(); worker.jobs[1]!.reject(new Error('Read failed')); await failing;
    expect(collector.calibrationSource()).toEqual(source);
    expect(collector.ref.get().calibrationTables()).toEqual(tables);
    expect(collector.dataVersion()).toBe(version);
    expect(logger.error).toHaveBeenCalledWith('collector.calibrate_failed', { error: 'Read failed' });
    const retry = inner().runCalibrate(); worker.jobs[2]!.resolve(worker.jobs[2]!.result); await retry;
    expect(collector.calibrationSource()!.main.id).not.toBe(source!.main.id);
    expect(collector.dataVersion()).toBe(version + 1);
  });

  it('keeps the current network after a failed static calibration and publishes a calibrated retry', async () => {
    const worker = new DeferredWorker(); inner().calibrationWorker = worker;
    const first = inner().runCalibrate(); worker.jobs[0]!.resolve(worker.jobs[0]!.result); await first;
    const network = collector.ref.get(), source = collector.calibrationSource();
    const refresh = inner().refreshStaticIfNeeded(true); await worker.requested(2);
    worker.jobs[1]!.reject(new Error('Replacement calibration failed')); await refresh;
    expect(collector.ref.get()).toBe(network);
    expect(collector.calibrationSource()).toEqual(source);
    const retry = inner().refreshStaticIfNeeded(true); await worker.requested(3);
    worker.jobs[2]!.resolve(worker.jobs[2]!.result); await retry;
    expect(collector.ref.get()).not.toBe(network);
    expect(collector.calibrationSource()).toEqual(worker.jobs[2]!.result.stats.calibrationSource);
    expect(collector.ref.get().calibrationTables()).toEqual(worker.jobs[2]!.result.tables);
  });

  it('discards an old periodic result after a replacement network publishes', async () => {
    const worker = new DeferredWorker(); inner().calibrationWorker = worker;
    const periodic = inner().runCalibrate();
    const refreshing = inner().refreshStaticIfNeeded(true); await worker.requested(2);
    worker.jobs[1]!.resolve(worker.jobs[1]!.result); await refreshing;
    const source = collector.calibrationSource(), version = collector.dataVersion(), network = collector.ref.get();
    worker.jobs[0]!.resolve(worker.jobs[0]!.result); await periodic;
    expect(collector.ref.get()).toBe(network);
    expect(collector.calibrationSource()).toEqual(source);
    expect(collector.dataVersion()).toBe(version);
    expect(logger.info).toHaveBeenCalledWith('collector.calibration_discarded', expect.anything());
  });

  it('refuses an in-place topology change and a different database epoch', async () => {
    const worker = new DeferredWorker(); inner().calibrationWorker = worker;
    const first = inner().runCalibrate();
    collector.ref.get().routes.get(1)!.name = 'Changed';
    worker.jobs[0]!.resolve(worker.jobs[0]!.result); await first;
    expect(collector.calibrationSource()).toBeNull();
    const second = inner().runCalibrate(), result = worker.jobs[1]!.result;
    if (result.stats.calibrationSource.main.watermark.status !== 'recorded') throw Error('Fixture must have source revision');
    result.stats.calibrationSource.main.watermark.epoch = 'f'.repeat(32);
    worker.jobs[1]!.resolve(result); await second;
    expect(collector.calibrationSource()).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('collector.calibrate_failed', { error: 'Calibration came from a different source database' });
  });

  it('does not publish or start polling after stop during startup', async () => {
    const worker = new DeferredWorker(); inner().calibrationWorker = worker;
    const cached = collector.ref.get(), starting = collector.start(); await worker.requested(1);
    collector.stop(); bundle.sqlite.close();
    worker.jobs[0]!.resolve(worker.jobs[0]!.result); await starting;
    expect(collector.ref.get()).toBe(cached);
    expect(collector.calibrationSource()).toBeNull();
    expect(upstream.busCalls).toBe(0);
    expect(logger.info).not.toHaveBeenCalledWith('collector.started');
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('uses the real background worker by default for a file database and awaits startup readiness', async () => {
    await collector.start();
    expect(validCalibrationSource(collector.calibrationSource())).toBe(true);
    expect(inner().lapFitsCache).toBeNull();
    const log = logger.info.mock.calls.find(args => args[0] === 'collector.calibrated');
    expect(log?.[1]).toMatchObject({ execution: 'worker' });
    expect(log?.[1]).toHaveProperty('workerElapsedMs');
    expect(log?.[1]).toHaveProperty('workerLoopHeldMs');
    expect(upstream.busCalls).toBeGreaterThan(0);
  }, 15_000);

  it('skips periodic work while the real worker is occupied', async () => {
    const spy = vi.spyOn(collector as unknown as { calibrateNetwork(network: TransitNetwork): unknown }, 'calibrateNetwork');
    const first = inner().runCalibrate();
    expect(inner().runCalibrate()).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    await first;
    expect(validCalibrationSource(collector.calibrationSource())).toBe(true);
  }, 15_000);

  it('seeds real lap clocks from the worker generation without fitting again on the main thread', async () => {
    // A small synthetic history with the same accepted cell and varying lap
    // lengths as the historical warm-start fixture; this proves wiring only.
    const insert = bundle.sqlite.prepare('INSERT INTO arrivals(bus_id,bus_name,route_id,stop_id,arrived_at,departed_at,dwell_sec,dow,hour) VALUES (1,?,3,11,?,?,?,?,?)');
    // A lap coefficient can only scale an existing measured stand table.
    const visit = bundle.sqlite.prepare("INSERT INTO stop_visits(bus_id,bus_name,anchor_bus_id,route_id,stop_id,stop_index,anchored_at,pinned_at,arrived_at,departed_at,stand_sec,outcome,how,steps,rest_polls,shuffles,closest_m,dow,hour) VALUES(1,?,1,3,11,0,?,?,?,?,?,'stopped','far',4,6,0,5,?,?)");
    const now = Date.now();
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    bundle.sqlite.transaction(() => {
      for (let day = 20; day >= 1; day--) for (const bus of ['#304', '#310', '#316']) {
        let at = now - day * 86400_000 + Number(bus.slice(1)) * 1000;
        for (let lap = 0; lap < 10; lap++) {
          const length = 3600_000 + (random() - .5) * 1200_000;
          const stand = Math.max(30_000, 600_000 - .5 * (length - 3600_000) + (random() - .5) * 120_000);
          const arrived = at + length, date = new Date(arrived);
          insert.run(bus, arrived, arrived + stand, stand / 1000, date.getDay(), date.getHours());
          visit.run(bus, arrived, arrived, arrived, arrived + stand, stand / 1000, date.getDay(), date.getHours());
          at = arrived + stand;
        }
      }
      for (const [bus, ago] of [['#304', 2400_000], ['#310', 720_000]] as const) {
        const arrived = now - ago - 300_000, date = new Date(arrived);
        insert.run(bus, arrived, now - ago, 300, date.getDay(), date.getHours());
        visit.run(bus, arrived, arrived, arrived, now - ago, 300, date.getDay(), date.getHours());
      }
    })();
    class FittedRoute extends Stub {
      override async stops() { return stops.map((stop, i) => ({ ...stop, id: 11 + i })); }
      override async routes() { return [{ ...routes[0]!, id: 3, stops: [11, 12] }]; }
    }
    collector.stop(); upstream = new FittedRoute();
    collector = await Collector.create(bundle, { upstream, logger });
    await collector.start();
    expect(collector.ref.get().getDwellStats(3, 11).lapB).toBeTypeOf('number');
    const age = collector.lapAges('#304', now)?.['11'];
    expect(age).toBe(2400);
    expect(collector.lapAges('#310', now)?.['11']).toBe(720);
    expect(collector.lapAges('#999', now)).toBeUndefined();
    expect(inner().lapFitsCache).toBeNull();
    expect(validCalibrationSource(collector.calibrationSource())).toBe(true);
    expect(collector.calibrationSource()!.lap!.generation!.id).not.toBe(collector.calibrationSource()!.main.id);
  }, 15_000);
});
