import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DB } from '../db/client.js';
import type { TransitNetwork } from '../network/TransitNetwork.js';
import type { CalibrationReader, CalibrationSource } from './provenance.js';
import { calibrate, SPLIT_WINDOW_DAYS } from './calibrator.js';
import { LapFitCache } from './lapFit.js';
import { ReleaseFitCache } from './releaseFit.js';
import { HourStandGateCache } from './hourStand.js';

export interface CalibrationCaches {
  lapFitsCache: LapFitCache | null;
  releaseFitsCache: ReleaseFitCache | null;
  hourStandGateCache: HourStandGateCache | null;
}

/** The existing synchronous calculation, shared by the inline harness and
 * background executor. Cache generations and actual read receipts travel
 * with the fitted tables; no production identity is reconstructed here. */
export function calibrateNetwork(
  db: DB, sqlite: Database.Database, network: TransitNetwork,
  caches: CalibrationCaches, read: CalibrationReader,
) {
  if (!caches.lapFitsCache) caches.lapFitsCache = new LapFitCache(sqlite, read);
  const fitAt = Date.now();
  const lapFits = caches.lapFitsCache.get();
  const lapFitMs = Date.now() - fitAt;
  if (!caches.releaseFitsCache) caches.releaseFitsCache = new ReleaseFitCache(sqlite, read);
  const releaseAt = Date.now();
  const releaseFits = caches.releaseFitsCache.get();
  const releaseFitMs = Date.now() - releaseAt;
  if (!caches.hourStandGateCache) caches.hourStandGateCache = new HourStandGateCache(db, SPLIT_WINDOW_DAYS, undefined, read);
  const hourGateAt = Date.now();
  const hourStandCells = caches.hourStandGateCache.get();
  const hourGateMs = Date.now() - hourGateAt;
  const stats = calibrate(db, network, new Date(), lapFits, releaseFits, hourStandCells, read);
  const provenanceAt = Date.now();
  const calibrationSource: CalibrationSource = {
    v: 1, main: stats.input!,
    topologySha256: createHash('sha256').update(JSON.stringify({
      stops: [...network.stops], routes: [...network.routes],
      legMeters: [...network.routes.values()].map(r => [r.id, r.stops.map((from, i) =>
        network.getLegMeters(r.id, from, r.stops[(i + 1) % r.stops.length]!) ?? null)]),
    })).digest('hex'),
    lap: caches.lapFitsCache.source?.() ?? null,
    release: caches.releaseFitsCache.source?.() ?? null,
    hourStand: caches.hourStandGateCache.source?.() ?? null,
  };
  const provenanceMs = Date.now() - provenanceAt;
  return {
    ...stats, calibrationSource, lapFitCells: [...lapFits.keys()], provenanceMs, lapFitMs, releaseFitMs,
    releaseFitCount: releaseFits.size, hourGateMs,
    loopHeldMs: stats.durationMs + lapFitMs + releaseFitMs + hourGateMs + provenanceMs,
  };
}

export type NetworkCalibrationStats = ReturnType<typeof calibrateNetwork>;
