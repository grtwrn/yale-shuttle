import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { isAbsolute } from 'node:path';
import * as schema from '../db/schema.js';
import { calibrationReader } from '../db/calibrationSnapshot.js';
import { TransitNetwork } from '../network/TransitNetwork.js';
import { calibrateNetwork, type CalibrationCaches } from './networkCalibration.js';
import type { CalibrationRequest } from './calibrationWorker.js';
import { witnessJSON, witnessSHA } from '../collector/witnessCodec.js';

if (!parentPort || !isAbsolute(workerData?.database ?? '')) throw new Error('Calibration worker requires a local database');
// Never use openDb(): it configures a writable connection and WAL. This
// connection can only read the existing producer database and its receipts.
const sqlite = new Database(workerData.database, { readonly: true, fileMustExist: true });
sqlite.pragma('query_only=ON');
sqlite.pragma('busy_timeout=5000');
const db = drizzle(sqlite, { schema }), read = calibrationReader(sqlite);
const caches: CalibrationCaches = { lapFitsCache: null, releaseFitsCache: null, hourStandGateCache: null };
parentPort.on('message', (request: CalibrationRequest) => {
  const started = performance.now();
  try {
    const network = TransitNetwork.fromObservationTopology(request.topology);
    const topologySHA256 = witnessSHA(witnessJSON(network.observationTopology()));
    if (topologySHA256 !== request.topologySHA256) throw new Error('Calibration topology differs from its request');
    const stats = calibrateNetwork(db, sqlite, network, caches, read);
    parentPort!.postMessage({ kind: 'result', id: request.id, stats, tables: network.calibrationTables(),
      workerElapsedMs: performance.now() - started, topologySHA256 });
  } catch (error) {
    parentPort!.postMessage({ kind: 'failure', id: request.id,
      error: error instanceof Error ? error.message : 'Calibration failed' });
  }
});
parentPort.postMessage({ kind: 'ready' });
