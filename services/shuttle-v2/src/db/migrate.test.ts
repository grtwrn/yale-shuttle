import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import observed from "./__fixtures__/standing-schema-2026-09-09.json";

// Captured schema and migration ledger only. Every data row below is synthetic.
// An older master release followed an uncommitted release containing migration
// 0017. Keeping its ledger entry is essential when the same migration returns.
const migrationFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(join(migrationFolder, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const observedStanding = observed.ledger.at(-1)!;
const opened: Database.Database[] = [];
let legacyFolder: string;

beforeAll(() => {
  legacyFolder = mkdtempSync(join(tmpdir(), "standing-migrations-0016-"));
  mkdirSync(join(legacyFolder, "meta"));
  const entries = journal.entries.filter(entry => entry.when < observedStanding.created_at);
  writeFileSync(join(legacyFolder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) copyFileSync(join(migrationFolder, `${entry.tag}.sql`), join(legacyFolder, `${entry.tag}.sql`));
});
afterEach(() => { for (const sqlite of opened.splice(0)) sqlite.close(); });
afterAll(() => { rmSync(legacyFolder, { recursive: true, force: true }); });

function before0017(): Database.Database {
  const sqlite = new Database(":memory:"); opened.push(sqlite);
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: legacyFolder });
  return sqlite;
}

function applyCurrent(sqlite: Database.Database): void {
  migrate(drizzle(sqlite), { migrationsFolder: migrationFolder });
}

function expectExistingObjectCollision(sqlite: Database.Database, name: string): void {
  let failure: unknown;
  try { applyCurrent(sqlite); } catch (error) { failure = error; }
  // Drizzle wraps the SQLite message as the query error's cause.
  expect(failure).toMatchObject({ cause: { message: expect.stringMatching(new RegExp(`${name}.*already exists`)) } });
}

function ledger(sqlite: Database.Database): unknown[] {
  return sqlite.prepare("SELECT id,hash,created_at FROM __drizzle_migrations ORDER BY created_at").all();
}

function standingObjects(sqlite: Database.Database): unknown[] {
  const names = observed.objects.map(object => object.name);
  return sqlite.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY name`).all(...names);
}

function restoreObservedObjects(sqlite: Database.Database, withLedger = true): void {
  for (const object of observed.objects) sqlite.exec(object.sql);
  if (withLedger) sqlite.prepare("INSERT INTO __drizzle_migrations(id,hash,created_at) VALUES (?,?,?)")
    .run(observedStanding.id, observedStanding.hash, observedStanding.created_at);
}

function seedForecastRows(sqlite: Database.Database): void {
  const inserted = sqlite.prepare(`INSERT INTO stop_visits
    (bus_id,bus_name,anchor_bus_id,route_id,stop_id,stop_index,anchored_at,pinned_at,departed_at,
     outcome,steps,rest_polls,shuffles,closest_m,dow,hour)
    VALUES (1,'synthetic-bus',1,99,101,0,1000,1000,2000,'stopped',0,0,0,0,0,0)`).run();
  sqlite.prepare("INSERT INTO standing_forecast_patterns VALUES (?,?,?)").run("synthetic-pattern", 99, "[101,102]");
  sqlite.prepare("INSERT INTO standing_forecast_observations VALUES (?,?,?,?)")
    .run(Number(inserted.lastInsertRowid), 3000, "synthetic-pattern", 0);
  sqlite.prepare("INSERT INTO standing_forecast_models VALUES (?,?,?,?,?,?)")
    .run(1, "synthetic-algorithm", 4000, 5000, '{"synthetic":true}', '{"origin":"migration-test"}');
}

function forecastRows(sqlite: Database.Database): unknown[] {
  return ["standing_forecast_patterns", "standing_forecast_observations", "standing_forecast_models"]
    .map(table => sqlite.prepare(`SELECT * FROM ${table}`).all());
}

describe("standing forecast migration reconciliation", () => {
  it("retains the exact SQL checksum and journal timestamp observed in production", () => {
    const entry = journal.entries.find(row => row.tag === "0017_standing_forecasts");
    expect(entry?.idx).toBe(17);
    expect(entry?.when).toBe(observedStanding.created_at);
    const migration = readMigrationFiles({ migrationsFolder: migrationFolder })
      .find(row => row.folderMillis === observedStanding.created_at);
    expect(migration?.hash).toBe(observedStanding.hash);
    expect(observed.databaseOpenedReadOnly && observed.queryOnly).toBe(true);
  });

  it("upgrades a fresh 0016 database to the exact observed tables and index", () => {
    const sqlite = before0017();
    expect(ledger(sqlite)).toEqual(observed.ledger.slice(0, -1));
    expect(standingObjects(sqlite)).toEqual([]);
    applyCurrent(sqlite);
    expect(standingObjects(sqlite)).toEqual(observed.objects);
    expect(ledger(sqlite)).toEqual(observed.ledger);
  });

  it("preserves the observed schema, ledger and data across an older release and the current migration set", () => {
    const sqlite = before0017(); restoreObservedObjects(sqlite); seedForecastRows(sqlite);
    const rows = forecastRows(sqlite);
    // Running an older release does not remove migrations it does not know.
    migrate(drizzle(sqlite), { migrationsFolder: legacyFolder });
    expect(ledger(sqlite)).toEqual(observed.ledger);
    applyCurrent(sqlite);
    expect(standingObjects(sqlite)).toEqual(observed.objects);
    expect(ledger(sqlite)).toEqual(observed.ledger);
    expect(forecastRows(sqlite)).toEqual(rows);
  });

  it("fails without altering existing forecast data if objects are orphaned by removing the ledger entry", () => {
    const sqlite = before0017(); restoreObservedObjects(sqlite, false); seedForecastRows(sqlite);
    const rows = forecastRows(sqlite);
    expectExistingObjectCollision(sqlite, "standing_forecast_patterns");
    expect(sqlite.inTransaction).toBe(false);
    expect(standingObjects(sqlite)).toEqual(observed.objects);
    expect(forecastRows(sqlite)).toEqual(rows);
    expect(ledger(sqlite)).toEqual(observed.ledger.slice(0, -1));
  });

  it("rolls back new tables if an index remains on stop_visits after the forecast tables were removed", () => {
    const sqlite = before0017();
    const index = observed.objects.find(object => object.type === "index")!;
    sqlite.exec(index.sql);
    expectExistingObjectCollision(sqlite, "stop_visits_route_bus_time_idx");
    expect(sqlite.inTransaction).toBe(false);
    expect(standingObjects(sqlite)).toEqual([index]);
    expect(ledger(sqlite)).toEqual(observed.ledger.slice(0, -1));
  });

  it("documents that this Drizzle version skips by timestamp rather than validating stored checksums", () => {
    const sqlite = before0017(); restoreObservedObjects(sqlite); seedForecastRows(sqlite);
    const rows = forecastRows(sqlite);
    sqlite.prepare("UPDATE __drizzle_migrations SET hash=? WHERE created_at=?")
      .run("deliberately-wrong-synthetic-checksum", observedStanding.created_at);
    // The explicit checksum assertion above is necessary: migrate() alone
    // would silently accept a changed migration at this same timestamp.
    expect(() => applyCurrent(sqlite)).not.toThrow();
    expect(forecastRows(sqlite)).toEqual(rows);
    expect(sqlite.prepare("SELECT hash FROM __drizzle_migrations WHERE created_at=?").get(observedStanding.created_at))
      .toEqual({ hash: "deliberately-wrong-synthetic-checksum" });
  });
});
