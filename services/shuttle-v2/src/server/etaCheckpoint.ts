import type Database from 'better-sqlite3';
import type { EtaCheckpointStore } from './serverEta.js';
import { ETA_SNAPSHOT_MAX_BYTES } from './etaSnapshot.js';

/** One byte-bounded row, updated at most every 30 s; no rider information.
 * Refuse before the atomic SQLite statement, preserving the last good row. */
export function etaCheckpointStore(db: Database.Database): EtaCheckpointStore {
  // SQLite checks the extent before returning/materializing the BLOB in Node.
  const read = db.prepare("SELECT value FROM eta_checkpoint WHERE id = 1 AND typeof(value) = 'blob' AND length(value) BETWEEN 1 AND ?");
  const write = db.prepare('INSERT INTO eta_checkpoint(id, value) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value');
  return {
    load: () => (read.get(ETA_SNAPSHOT_MAX_BYTES) as { value: Buffer } | undefined)?.value ?? null,
    save: value => {
      if (!value.byteLength || value.byteLength > ETA_SNAPSHOT_MAX_BYTES) throw new Error('Checkpoint exceeds byte cap');
      write.run(Buffer.from(value));
    },
  };
}
