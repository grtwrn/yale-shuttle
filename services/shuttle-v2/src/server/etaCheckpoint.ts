import type Database from 'better-sqlite3';
import type { EtaCheckpointStore } from './serverEta.js';

/** One bounded row, updated at most every 30 s; no rider information. */
export function etaCheckpointStore(db: Database.Database): EtaCheckpointStore {
  const read = db.prepare('SELECT value FROM eta_checkpoint WHERE id = 1');
  const write = db.prepare('INSERT INTO eta_checkpoint(id, value) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value');
  return {
    load: () => (read.get() as { value: Buffer } | undefined)?.value ?? null,
    save: value => { write.run(Buffer.from(value)); },
  };
}
