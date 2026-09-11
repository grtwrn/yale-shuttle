/**
 * An archive day as a replay database.
 *
 * Stage 4 of the closed loop (docs/closed-loop.md): the replays in this
 * directory read a production SNAPSHOT (`REPLAY_DB`), but the day a
 * challenger must be scored on lives in the Pi's archive
 * (`~/shuttle-archive/YYYY-MM-DD/<table>.jsonl.gz`, stage 2) — the volume has
 * swept its positions by the time the nightly job runs. This builds a
 * throwaway database in the replay's own schema (the real migrations, so
 * `model-patch.ts`'s calibrator loaders work unchanged):
 *
 *   topology         `stops`, `routes`             from the base snapshot
 *   calibration      `segments`  (30 days back)    from the base snapshot
 *   dwell history    `arrivals`  (14 days back)    base snapshot, then every
 *                                                  archived day in the window
 *   split history    `legs`, `stop_visits` (30 d)  the same two sources
 *   THE DAY          `raw_positions`, `arrivals`,  the archive only
 *                    `legs`, `stop_visits`
 *
 * Rows from the two sources carry the server's own ids, so the overlap is
 * de-duplicated by primary key (capture-sourced positions have none and take
 * fresh ids). Nothing after the day's end is copied — rows past it would be
 * the future for every rider in the replay.
 *
 *   TZ=America/New_York npx tsx scripts/eta-replay/archive-db.ts 2026-09-05 ./store/snap.db /tmp/replay-0905.db
 *
 * or `buildArchiveDb()` from another script. The output is what to pass as
 * REPLAY_DB to model-patch.ts and gps-replay.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDb } from "../../src/db/client.js";
import { etDay, etDayStartMs } from "../../src/server/actives.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

export const ARCHIVE_DIR = process.env.ARCHIVE_DIR ?? path.join(os.homedir(), "shuttle-archive");
const DAY_MS = 86_400_000;
/** calibrator.ts SEGMENT_WINDOW_DAYS / SPLIT_WINDOW_DAYS. */
const SEGMENT_DAYS = 30;
/** gps-replay.ts DWELL_WINDOW_MS. */
const DWELL_DAYS = 14;

/** The archived days present, ascending. */
export function archivedDays(dir = ARCHIVE_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(dir, d, "manifest.json"))).sort();
}

export function readManifest(day: string, dir = ARCHIVE_DIR): { ok?: boolean; tables?: Record<string, { rows: number; complete: boolean; columns?: string[]; source?: string }>; build?: string | null } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, day, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Every row of one archived table, or [] when the file is absent. */
export function readArchiveRows(day: string, table: string, dir = ARCHIVE_DIR): Record<string, unknown>[] {
  const file = path.join(dir, day, `${table}.jsonl.gz`);
  if (!fs.existsSync(file)) return [];
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    out.push(JSON.parse(line) as Record<string, unknown>);
  }
  return out;
}

export interface ArchiveDbReport {
  day: string;
  from: number;
  to: number;
  out: string;
  copied: Record<string, number>;
  archived: Record<string, number>;
  archiveDaysUsed: string[];
}

/**
 * Build the replay database for `day`. `baseDb` supplies topology and
 * history; `dir` the archive. Returns what went in.
 */
export function buildArchiveDb(day: string, baseDb: string, out: string, dir = ARCHIVE_DIR): ArchiveDbReport {
  const from = etDayStartMs(day);
  if (from === 0 || etDay(from) !== day) throw new Error(`bad day ${day}`);
  const to = etDayStartMs(etDay(from + 26 * 3_600_000));
  for (const f of [out, `${out}-wal`, `${out}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  const bundle = openDb(out);
  migrate(bundle.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  const sqlite = bundle.sqlite;
  sqlite.pragma("synchronous = OFF");
  sqlite.prepare("ATTACH DATABASE ? AS base").run(baseDb);

  const columnsOf = (schemaName: string, table: string): string[] =>
    (sqlite.prepare(`PRAGMA ${schemaName}.table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const copied: Record<string, number> = {};
  const copy = (table: string, where: string, args: unknown[]): void => {
    const mine = new Set(columnsOf("main", table));
    const cols = columnsOf("base", table).filter((c) => mine.has(c));
    const list = cols.map((c) => `"${c}"`).join(", ");
    const r = sqlite.prepare(`INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${list} FROM base.${table} ${where}`).run(...args);
    copied[table] = r.changes;
  };
  copy("stops", "", []);
  copy("routes", "", []);
  copy("segments", "WHERE started_at >= ? AND started_at < ?", [from - SEGMENT_DAYS * DAY_MS, from]);
  copy("arrivals", "WHERE arrived_at >= ? AND arrived_at < ?", [from - DWELL_DAYS * DAY_MS - 3_600_000, from]);
  copy("legs", "WHERE departed_at >= ? AND departed_at < ?", [from - SEGMENT_DAYS * DAY_MS, from]);
  copy("stop_visits", "WHERE anchored_at >= ? AND anchored_at < ?", [from - SEGMENT_DAYS * DAY_MS, from]);
  sqlite.prepare("DETACH DATABASE base").run();

  const archived: Record<string, number> = {};
  const insertRows = (table: string, rows: Record<string, unknown>[], timeCol: string, lo: number, hi: number): number => {
    if (rows.length === 0) return 0;
    const mine = new Set(columnsOf("main", table));
    const cols = Object.keys(rows[0]!).filter((c) => mine.has(c));
    const ins = sqlite.prepare(
      `INSERT OR IGNORE INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    );
    let n = 0;
    sqlite.transaction(() => {
      for (const r of rows) {
        const t = r[timeCol] as number;
        if (typeof t !== "number" || t < lo || t >= hi) continue;
        n += ins.run(...cols.map((c) => r[c] ?? null)).changes;
      }
    })();
    return n;
  };
  const days = archivedDays(dir).filter((d) => d <= day);
  const used: string[] = [];
  for (const d of days) {
    const dFrom = etDayStartMs(d);
    if (dFrom < from - SEGMENT_DAYS * DAY_MS) continue;
    used.push(d);
    const tally = (table: string, n: number) => { archived[table] = (archived[table] ?? 0) + n; };
    if (dFrom >= from - DWELL_DAYS * DAY_MS - 3_600_000) tally("arrivals", insertRows("arrivals", readArchiveRows(d, "arrivals", dir), "arrived_at", 0, to));
    tally("legs", insertRows("legs", readArchiveRows(d, "legs", dir), "departed_at", 0, to));
    tally("stop_visits", insertRows("stop_visits", readArchiveRows(d, "stop_visits", dir), "anchored_at", 0, to));
    if (d === day) tally("raw_positions", insertRows("raw_positions", readArchiveRows(d, "raw_positions", dir), "collected_at", from, to));
  }
  sqlite.close();
  return { day, from, to, out, copied, archived, archiveDaysUsed: used };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [day, base, out] = process.argv.slice(2);
  if (!day || !base || !out) {
    console.error("usage: archive-db.ts YYYY-MM-DD <base snapshot .db> <out .db>");
    process.exit(2);
  }
  console.log(JSON.stringify(buildArchiveDb(day, base, out), null, 1));
}
