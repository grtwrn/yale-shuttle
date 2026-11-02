import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { etaCheckpointStore } from './etaCheckpoint';
import { ETA_SNAPSHOT_MAX_BYTES } from './etaSnapshot';

describe('bounded local ETA checkpoint storage', () => {
  it('keeps the exact last good row when an oversized or empty replacement is refused', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE eta_checkpoint (id INTEGER PRIMARY KEY, value BLOB NOT NULL)');
      const store = etaCheckpointStore(db), good = Buffer.from('last good checkpoint');
      store.save(good);
      expect(() => store.save(new Uint8Array(ETA_SNAPSHOT_MAX_BYTES + 1))).toThrow();
      expect(() => store.save(new Uint8Array())).toThrow();
      expect(Buffer.from(store.load()!).equals(good)).toBe(true);
      const boundary = new Uint8Array(ETA_SNAPSHOT_MAX_BYTES); boundary[0] = 17;
      store.save(boundary);
      expect(Buffer.from(store.load()!).equals(Buffer.from(boundary))).toBe(true);
      expect(db.prepare('SELECT count(*) AS n FROM eta_checkpoint').get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });

  it('preserves the old row if the atomic SQLite replacement fails', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE eta_checkpoint (id INTEGER PRIMARY KEY, value BLOB NOT NULL)');
      const store = etaCheckpointStore(db), good = Buffer.from('old'); store.save(good);
      db.exec("CREATE TRIGGER refuse_checkpoint BEFORE UPDATE ON eta_checkpoint BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
      expect(() => store.save(Buffer.from('new'))).toThrow('injected failure');
      expect(Buffer.from(store.load()!).equals(good)).toBe(true);
    } finally { db.close(); }
  });

  it('does not materialize or erase a legacy oversized row on load', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE eta_checkpoint (id INTEGER PRIMARY KEY, value BLOB NOT NULL)');
      db.prepare('INSERT INTO eta_checkpoint VALUES (1, zeroblob(?))').run(ETA_SNAPSHOT_MAX_BYTES + 1);
      const store = etaCheckpointStore(db);
      expect(store.load()).toBeNull();
      expect(db.prepare('SELECT length(value) AS bytes FROM eta_checkpoint WHERE id = 1').get())
        .toEqual({ bytes: ETA_SNAPSHOT_MAX_BYTES + 1 });
    } finally { db.close(); }
  });
});
