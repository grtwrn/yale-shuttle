import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDb } from '../db/client.js';
import { calibrationReader } from '../db/calibrationSnapshot.js';
import { TransitNetwork } from '../network/TransitNetwork.js';
import { CalibrationWorker } from './calibrationWorker.js';
import { calibrateNetwork } from './networkCalibration.js';
import { witnessJSON, witnessSHA } from '../collector/witnessCodec.js';

const fixtures: Array<{ directory: string; bundle: ReturnType<typeof openDb>; worker: CalibrationWorker | undefined }> = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-calibration-worker-'));
  const file = path.join(directory, 'test.db'), bundle = openDb(file);
  migrate(bundle.db, { migrationsFolder: './drizzle' });
  const when = Date.now() - 3600_000;
  const segment = bundle.sqlite.prepare('INSERT INTO segments(bus_id,bus_name,route_id,from_stop_id,to_stop_id,travel_sec,started_at,dow,hour) VALUES (1,\'#1\',1,1,2,60,?,4,17)');
  const arrival = bundle.sqlite.prepare('INSERT INTO arrivals(bus_id,bus_name,route_id,stop_id,arrived_at,departed_at,dwell_sec,dow,hour) VALUES (1,\'#1\',1,1,?,?,20,4,17)');
  bundle.sqlite.transaction(() => {
    for (let n = 0; n < 20; n++) { segment.run(when + n * 1000); arrival.run(when + n * 1000, when + n * 1000 + 20_000); }
  })();
  const network = TransitNetwork.build([
    { id: 1, name: 'A', lat: 41.31, lon: -72.92 },
    { id: 2, name: 'B', lat: 41.311, lon: -72.921 },
  ], [{ id: 1, name: 'Test', shortName: 'T', color: '#123456', stops: [1, 2] }]);
  const item = { directory, bundle, worker: undefined as CalibrationWorker | undefined };
  fixtures.push(item);
  return { ...item, file, network, item };
}
afterEach(() => {
  for (const item of fixtures.splice(0)) {
    item.worker?.close();
    if (item.bundle.sqlite.inTransaction) item.bundle.sqlite.exec('ROLLBACK');
    item.bundle.sqlite.close();
    fs.rmSync(item.directory, { recursive: true, force: true });
  }
});

describe('background calibration', () => {
  it('runs the real Node worker with exact tables and coherent read-only source receipts', async () => {
    const f = fixture();
    const worker = f.item.worker = new CalibrationWorker(f.file);
    const before = f.bundle.sqlite.prepare('SELECT * FROM calibration_input_revision WHERE id=1').get() as { epoch: string; revision: number };
    const result = await worker.run(f.network.observationTopology());
    const inline = calibrateNetwork(f.bundle.db, f.bundle.sqlite, f.network,
      { lapFitsCache: null, releaseFitsCache: null, hourStandGateCache: null }, calibrationReader(f.bundle.sqlite));
    expect(result.tables).toEqual(f.network.calibrationTables());
    expect(result.stats.segmentCount).toBe(inline.segmentCount);
    expect(result.stats.dwellCount).toBe(inline.dwellCount);
    expect(result.stats.sampleCount).toBe(40);
    expect(result.stats.calibrationSource.main.watermark).toMatchObject({ status: 'recorded', epoch: before.epoch, revision: before.revision });
    expect(result.stats.calibrationSource.topologySha256).toBe(inline.calibrationSource.topologySha256);
    expect(f.bundle.sqlite.prepare('SELECT * FROM calibration_input_revision WHERE id=1').get()).toEqual(before);
    expect(worker.busy).toBe(false);
    const again = await worker.run(f.network.observationTopology());
    expect(again.stats.calibrationSource.main.id).not.toBe(result.stats.calibrationSource.main.id);
    for (const key of ['lap', 'release', 'hourStand'] as const) {
      expect(again.stats.calibrationSource[key]?.generation?.id).toBe(result.stats.calibrationSource[key]?.generation?.id);
    }
    expect(again.tables).toEqual(result.tables);
  }, 15_000);

  it('bounds the queue while permitting one static refresh behind the active calculation', async () => {
    const f = fixture();
    const worker = f.item.worker = new CalibrationWorker(f.file);
    const originalTopology = witnessSHA(witnessJSON(f.network.observationTopology()));
    const a = worker.run(f.network.observationTopology()), b = worker.run(f.network.observationTopology());
    f.network.routes.get(1)!.name = 'Changed after dispatch';
    await expect(worker.run(f.network.observationTopology())).rejects.toThrow('queue is full');
    const [first, second] = await Promise.all([a, b]);
    expect(first.id).toBeLessThan(second.id);
    expect(first.tables).toEqual(second.tables);
    expect(first.topologySHA256).toBe(originalTopology);
    expect(second.topologySHA256).toBe(originalTopology);
    expect(worker.busy).toBe(false);
  }, 15_000);

  it('reads committed WAL state during a producer write and sees the next committed revision', async () => {
    const f = fixture(), sqlite = f.bundle.sqlite;
    const worker = f.item.worker = new CalibrationWorker(f.file);
    const before = sqlite.prepare('SELECT * FROM calibration_input_revision WHERE id=1').get() as { epoch: string; revision: number };
    // A completed historical trip: the unchanged as-of gate correctly omits
    // a 120-second trip whose start is only one second before calibration.
    const add = () => sqlite.prepare("INSERT INTO segments(bus_id,bus_name,route_id,from_stop_id,to_stop_id,travel_sec,started_at,dow,hour) VALUES (1,'#1',1,1,2,120,?,4,17)").run(Date.now() - 3600_000);
    sqlite.exec('BEGIN IMMEDIATE');
    add();
    const during = await worker.run(f.network.observationTopology());
    expect(during.stats.sampleCount).toBe(40);
    expect(during.stats.calibrationSource.main.watermark).toMatchObject({ status: 'recorded', epoch: before.epoch, revision: before.revision });
    expect(sqlite.inTransaction).toBe(true);
    sqlite.exec('ROLLBACK');
    expect(sqlite.prepare('SELECT * FROM calibration_input_revision WHERE id=1').get()).toEqual(before);
    add();
    const committed = await worker.run(f.network.observationTopology());
    expect(committed.stats.sampleCount).toBe(41);
    expect(committed.stats.calibrationSource.main.watermark).toMatchObject({ status: 'recorded', epoch: before.epoch, revision: before.revision + 1 });
    for (const key of ['lap', 'release', 'hourStand'] as const) {
      expect(committed.stats.calibrationSource[key]?.generation).toEqual(during.stats.calibrationSource[key]?.generation);
    }
  }, 15_000);

  it('rejects the active and queued jobs on a real worker exit and can retry', async () => {
    const f = fixture();
    const worker = f.item.worker = new CalibrationWorker(f.file);
    const a = worker.run(f.network.observationTopology()), b = worker.run(f.network.observationTopology());
    const settled = Promise.allSettled([a, b]);
    const thread = (worker as unknown as { worker: Worker }).worker;
    await thread.terminate();
    const rejected = await settled;
    expect(rejected).toHaveLength(2);
    expect(rejected.every(r => r.status === 'rejected' && String(r.reason).includes('exited'))).toBe(true);
    expect(worker.busy).toBe(false);
    expect((await worker.run(f.network.observationTopology())).stats.sampleCount).toBe(40);
    expect(worker.busy).toBe(false);
  }, 15_000);

  it('rejects all pending work on close and never starts another worker', async () => {
    const f = fixture();
    const worker = f.item.worker = new CalibrationWorker(f.file);
    const a = worker.run(f.network.observationTopology()), b = worker.run(f.network.observationTopology());
    worker.close();
    await expect(a).rejects.toThrow('closed');
    await expect(b).rejects.toThrow('closed');
    await expect(worker.run(f.network.observationTopology())).rejects.toThrow('closed');
    expect(worker.busy).toBe(false);
  });

  it('fails a missing source rather than creating a database', async () => {
    const f = fixture(), missing = path.join(f.directory, 'does-not-exist.db');
    const worker = f.item.worker = new CalibrationWorker(missing);
    await expect(worker.run(f.network.observationTopology())).rejects.toThrow();
    expect(fs.existsSync(missing)).toBe(false);
    expect(worker.busy).toBe(false);
  }, 15_000);

  it('enforces the deadline and clears every queued promise', async () => {
    const f = fixture();
    const worker = f.item.worker = new CalibrationWorker(f.file, 1);
    const a = worker.run(f.network.observationTopology()), b = worker.run(f.network.observationTopology());
    const settled = await Promise.allSettled([a, b]);
    expect(settled.every(r => r.status === 'rejected' && String(r.reason).includes('deadline'))).toBe(true);
    expect(worker.busy).toBe(false);
  });

  it('refuses an in-memory database and invalid deadlines', () => {
    expect(() => new CalibrationWorker(':memory:')).toThrow('file database');
    for (const deadline of [0, -1, NaN, Infinity]) expect(() => new CalibrationWorker('/unused', deadline)).toThrow('deadline');
  });
});
