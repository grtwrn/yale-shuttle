import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbBundle } from './client.js';
import { calibrationReader } from './calibrationSnapshot.js';
import { calibrate, loadStopShares } from '../calibrator/calibrator.js';
import { TransitNetwork } from '../network/TransitNetwork.js';
import { LapFitCache, LAP_FIT_INTERVAL_MS } from '../calibrator/lapFit.js';
import { ReleaseFitCache } from '../calibrator/releaseFit.js';
import { HourStandGateCache } from '../calibrator/hourStand.js';
import type { CalibrationReader } from '../calibrator/provenance.js';
import recorded from '../calibrator/__fixtures__/blue-weekend-impossible-leg-20261017.json';

const now = Date.parse('2026-10-17T22:00:00Z');
let dir: string, bundle: DbBundle;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-snapshot-'));
  bundle = openDb(path.join(dir, 'test.db'));
  migrate(bundle.db, { migrationsFolder: 'drizzle' });
});
afterEach(() => { bundle.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const revision = () => calibrationReader(bundle.sqlite)(now, () => null).receipt.watermark;
const visitSql = `INSERT INTO stop_visits
 (bus_id,bus_name,anchor_bus_id,route_id,stop_id,stop_index,anchored_at,pinned_at,arrived_at,departed_at,
 stand_sec,outcome,how,steps,rest_polls,shuffles,closest_m,dow,hour)
 VALUES (1,'#test',1,4,116,0,?,?,?,?,?,'stopped','far',4,6,0,5,6,17)`;
function visit(sqlite = bundle.sqlite) { return sqlite.prepare(visitSql).run(now - 60000, now - 60000, now - 60000, now - 30000, 30); }

describe('committed calibration input revisions', () => {
  it('tracks inserts, arrival patches and retention deletes without guessing availability from event clocks', () => {
    const initial = revision(); expect(initial).toMatchObject({ status: 'recorded', revision: 0 });
    visit();
    bundle.sqlite.prepare(`INSERT INTO arrivals(bus_id,bus_name,route_id,stop_id,arrived_at,dow,hour) VALUES(1,'#test',4,116,?,6,17)`).run(now - 60000);
    bundle.sqlite.prepare('UPDATE arrivals SET departed_at=?,dwell_sec=30').run(now - 30000);
    bundle.sqlite.prepare(`INSERT INTO segments(bus_id,bus_name,route_id,from_stop_id,to_stop_id,travel_sec,started_at,dow,hour)
      VALUES(1,'#test',4,116,53,60,?,6,17)`).run(now - 60000);
    const cols = Object.keys(recorded.valid);
    bundle.sqlite.prepare(`INSERT INTO legs(${cols.join(',')}) VALUES(${cols.map(() => '?')})`)
      .run(...cols.map(c => recorded.valid[c as keyof typeof recorded.valid]));
    bundle.sqlite.exec('DELETE FROM segments');
    expect(revision()).toEqual({ ...initial, revision: 6, tables: { arrivals: 2, segments: 2, stopVisits: 1, legs: 1 } });
    const before = revision();
    expect(() => bundle.sqlite.transaction(() => { visit(); throw Error('rollback'); })()).toThrow('rollback');
    expect(revision()).toEqual(before);
    expect(bundle.sqlite.prepare('SELECT COUNT(*) n FROM stop_visits').get()).toEqual({ n: 1 });
  });

  it('keeps the actual fit and revision on the same WAL snapshot while a real second connection commits', () => {
    visit(); const writer = new Database(bundle.sqlite.name);
    try {
      const before = revision();
      const { receipt, value } = calibrationReader(bundle.sqlite)(now, () => {
        expect(loadStopShares(bundle.db, 30, now).get('4:116')).toBe(1);
        writer.prepare(`INSERT INTO stop_visits
          (bus_id,bus_name,anchor_bus_id,route_id,stop_id,stop_index,anchored_at,outcome,steps,rest_polls,shuffles,closest_m,dow,hour)
          VALUES(1,'#test',1,4,116,0,?,'passed',0,0,0,300,6,17)`).run(now - 1000);
        const net = TransitNetwork.build(recorded.stops, [{ id: 4, name: 'Blue Weekend', shortName: 'BW', color: '#00f', stops: [116, 53] }]);
        calibrate(bundle.db, net, new Date(now));
        return net.getDwellStats(4, 116).pstop;
      });
      expect(value).toBe(1); expect(receipt.asOf).toBe(now); expect(receipt.watermark).toEqual(before);
      expect(loadStopShares(bundle.db, 30, now).get('4:116')).toBe(.5);
      expect(revision()).toMatchObject({ revision: 2, tables: { stopVisits: 2 } });
    } finally { writer.close(); }
  });

  it('preserves the revision epoch across restart and a complete SQLite backup', async () => {
    visit(); const before = revision(), backup = path.join(dir, 'backup.db');
    await bundle.sqlite.backup(backup); bundle.sqlite.close();
    bundle = openDb(path.join(dir, 'test.db'));
    expect(revision()).toEqual(before);
    const restored = new Database(backup);
    try {
      expect(calibrationReader(restored)(now, () => null).receipt.watermark).toEqual(before);
      visit(restored);
      expect(calibrationReader(restored)(now, () => null).receipt.watermark).toMatchObject({ revision: 2 });
      expect(revision()).toEqual(before);
    } finally { restored.close(); }
  });

  it('marks legacy, incomplete archive schemas and uncommitted outer writes explicitly unknown', () => {
    const legacy = new Database(':memory:');
    try { expect(calibrationReader(legacy)(now, () => 4)).toMatchObject({ value: 4, receipt: { watermark: { status: 'unavailable', reason: 'legacy-database' } } }); }
    finally { legacy.close(); }
    bundle.sqlite.transaction(() => {
      visit();
      expect(revision()).toEqual({ status: 'unavailable', reason: 'outer-transaction' });
    })();
    bundle.sqlite.exec('DROP TRIGGER calibration_revision_stop_visits_update');
    expect(revision()).toEqual({ status: 'unavailable', reason: 'revision-schema-incomplete' });
  });

  it('refuses writes and failed reads, restores connection flags, and publishes no failed calibration', () => {
    const read = calibrationReader(bundle.sqlite);
    expect(() => read(now, () => visit())).toThrow(/readonly/i);
    expect(() => read(now, () => { throw Error('failed read'); })).toThrow('failed read');
    expect(bundle.sqlite.pragma('query_only', { simple: true })).toBe(0);
    const net = TransitNetwork.build([], []);
    net.setCalibration(new Map(), new Map([['4:116', { mean: 123, stddev: 5, n: 7 }]]));
    const failed: CalibrationReader = (at, query) => { read(at, query); throw Error('receipt failed'); };
    expect(() => calibrate(bundle.db, net, new Date(now), undefined, undefined, undefined, failed)).toThrow('receipt failed');
    expect(net.getDwellStats(4, 116)).toMatchObject({ mean: 123, n: 7 });
    bundle.sqlite.pragma('query_only=ON');
    expect(read(now, () => 2).value).toBe(2);
    expect(bundle.sqlite.pragma('query_only', { simple: true })).toBe(1);
    bundle.sqlite.pragma('query_only=OFF'); visit();
  });
});

describe('independent cached fit generations', () => {
  it('keeps each successful read identity on cache hits and failure fallbacks', () => {
    let fail = false;
    const real = calibrationReader(bundle.sqlite);
    const read: CalibrationReader = (at, load) => { if (fail) throw Error('read failure'); return real(at, load); };
    const lap = new LapFitCache(bundle.sqlite, read), release = new ReleaseFitCache(bundle.sqlite, read);
    const hour = new HourStandGateCache(bundle.db, 30, undefined, read);
    lap.get(now); release.get(now + 1); hour.get(now + 2);
    const originals = [lap.source(), release.source(), hour.source()];
    expect(new Set(originals.map(s => s.generation!.id)).size).toBe(3);
    expect(originals.map(s => s.generation!.asOf)).toEqual([now, now + 1, now + 2]);
    visit();
    lap.get(now + 300000); release.get(now + 300000); hour.get(now + 300000);
    expect([lap.source(), release.source(), hour.source()]).toEqual(originals);
    fail = true; const later = now + LAP_FIT_INTERVAL_MS + 10;
    lap.get(later); release.get(later); hour.get(later);
    expect(lap.source()).toMatchObject({ attemptedAt: later, readFailed: true, generation: originals[0]!.generation });
    expect(release.source()).toMatchObject({ attemptedAt: later, readFailed: true, generation: originals[1]!.generation });
    expect(hour.source()).toEqual({ attemptedAt: later, readFailed: true, generation: null });
    release.get(now + 2 * 86400000);
    expect(release.source().generation).toBeNull();
    fail = false; lap.get(now + 3 * 86400000);
    expect(lap.source().generation!.id).not.toBe(originals[0]!.generation!.id);
    expect(lap.source().generation!.watermark).toMatchObject({ revision: 1 });
    const mutated = lap.source(); mutated.generation!.asOf = 0;
    expect(lap.source().generation!.asOf).toBe(now + 3 * 86400000);
  });
});
