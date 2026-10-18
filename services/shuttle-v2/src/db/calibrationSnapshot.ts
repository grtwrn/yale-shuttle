import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { CalibrationReader, CalibrationWatermark } from '../calibrator/provenance.js';
import { validCalibrationRead } from '../calibrator/provenance.js';

const tables = ['arrivals', 'segments', 'stop_visits', 'legs'] as const;
const operations = ['INSERT', 'UPDATE', 'DELETE'] as const;
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
export function completeRevisionSchema(sqlite: Database.Database): boolean {
  const triggers = new Map((sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as { name: string; sql: string }[])
    .map(r => [r.name, normalize(r.sql)]));
  return tables.every(table => operations.every(operation => {
    const name = `calibration_revision_${table}_${operation.toLowerCase()}`;
    const expected = `CREATE TRIGGER \`${name}\` AFTER ${operation} ON \`${table}\`
BEGIN
  UPDATE \`calibration_input_revision\` SET \`revision\` = \`revision\` + 1, \`${table}\` = \`${table}\` + 1 WHERE \`id\` = 1;
END`;
    return triggers.get(name) === normalize(expected);
  }));
}

/** Establish a WAL read snapshot with the revision query BEFORE any fitted
 * input is read. Revision triggers commit/roll back with their source writes.
 * No max-id inference, wall-clock commit guess, or writes on this read path. */
export function calibrationReader(sqlite: Database.Database): CalibrationReader {
  return (asOf, read) => {
    const outer = sqlite.inTransaction;
    const startedAt = Date.now();
    const queryOnly = sqlite.pragma('query_only', { simple: true });
    sqlite.pragma('query_only=ON');
    try {
      const result = sqlite.transaction(() => {
        // This first read also establishes a snapshot on pre-migration archives.
        const exists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calibration_input_revision'").get();
        let watermark: CalibrationWatermark;
        if (outer) watermark = { status: 'unavailable', reason: 'outer-transaction' };
        else if (!exists) watermark = { status: 'unavailable', reason: 'legacy-database' };
        else if (!completeRevisionSchema(sqlite)) watermark = { status: 'unavailable', reason: 'revision-schema-incomplete' };
        else {
          const row = sqlite.prepare('SELECT epoch,revision,arrivals,segments,stop_visits,legs FROM calibration_input_revision WHERE id=1').get() as {
            epoch: string; revision: number; arrivals: number; segments: number; stop_visits: number; legs: number;
          } | undefined;
          if (!row) throw Error('Calibration input revision is missing');
          watermark = { status: 'recorded', epoch: row.epoch, revision: row.revision,
            tables: { arrivals: row.arrivals, segments: row.segments, stopVisits: row.stop_visits, legs: row.legs } };
        }
        const value = read();
        if (value instanceof Promise) throw Error('Calibration snapshot reads must be synchronous');
        return { value, watermark };
      })();
      const receipt = { v: 1 as const, id: randomUUID(), asOf, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        startedAt, completedAt: Date.now(), watermark: result.watermark };
      if (!validCalibrationRead(receipt)) throw Error('Invalid calibration input revision');
      return { value: result.value, receipt };
    } finally {
      sqlite.pragma(`query_only=${queryOnly ? 'ON' : 'OFF'}`);
    }
  };
}
