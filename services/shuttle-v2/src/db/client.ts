import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import * as schema from "./schema.js";

export type DB = BetterSQLite3Database<typeof schema>;

export interface DbBundle {
  /** Typed Drizzle interface for ORM-style queries. */
  db: DB;
  /**
   * Underlying better-sqlite3 handle, exposed for the handful of operations
   * (batched retention deletes, PRAGMA tuning) where dropping to raw SQL is
   * meaningfully simpler than wrestling with the template-SQL builder.
   */
  sqlite: Database.Database;
}

export interface OpenOptions {
  readonly?: boolean;
}

export function openDb(dbPath?: string, opts: OpenOptions = {}): DbBundle {
  const resolved = dbPath ?? defaultDbPath();
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const sqlite = new Database(resolved, { readonly: opts.readonly ?? false });
  // WAL + bounded busy timeout — required for concurrent readers/writers in-process.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  // NORMAL is safe under WAL (no corruption risk; only an OS crash can lose the
  // last few committed txns) and avoids an fsync on every 5s write batch.
  sqlite.pragma("synchronous = NORMAL");
  return { db: drizzle(sqlite, { schema }), sqlite };
}

export function defaultDbPath(): string {
  return (
    process.env.SHUTTLE_V2_DB ??
    path.join(process.env.SHUTTLE_V2_DB_DIR ?? "./store", "shuttle-v2.db")
  );
}
