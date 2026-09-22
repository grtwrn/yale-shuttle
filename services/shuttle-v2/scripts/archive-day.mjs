#!/usr/bin/env node
/**
 * Archive one ET day of production data on the Pi.
 *
 * Stage 2 of the closed loop (docs/closed-loop.md). The production volume is
 * 1 GB with bounded storage and retention sweeps `raw_positions` after 36 h, the
 * census after ~4 weekdays and `predictions_log`'s upstream rows after 7 days,
 * so the rows a replay needs do not survive where they are written. This pulls
 * them, one table at a time, through `GET /api/archive/day` (admin header
 * only, JSON lines with a header and an `{"end":true}` trailer) and keeps them
 * as `~/shuttle-archive/YYYY-MM-DD/<table>.jsonl.gz` beside a `manifest.json`.
 *
 * The 36-hour retention covers the normal 03:40 export. When present, the
 * Pi's own capture (`~/shuttle-captures/positions-YYYYMMDD.jsonl`, UTC-named,
 * so an ET day spans two files) is merged in, filtered to the ET day and
 * de-duplicated on (bus_id, collected_at); the manifest says how many rows
 * came from each source.
 *
 *   node scripts/archive-day.mjs                # yesterday, ET
 *   node scripts/archive-day.mjs 2026-09-05     # one day
 *   node scripts/archive-day.mjs 2026-09-01 2026-09-05   # a range, inclusive
 *
 * Env: BASE (https://yale-shuttle.fly.dev), ARCHIVE_DIR (~/shuttle-archive),
 * CAPTURES_DIR (~/shuttle-captures), ARCHIVE_RETAIN_DAYS (180),
 * SHUTTLE_ADMIN_TOKEN (else ~/.yale-shuttle-admin-token).
 *
 * Every attempt writes immutable files under the day's snapshots directory.
 * The manifest atomically selects non-regressing, complete table downloads;
 * older files and rejected attempts remain available. Exit non-zero on any
 * failed download or rejected replacement. Transport completion is not proof
 * of full service coverage or settled outcomes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { archiveTableFile, readArchiveTable } from "./archive-files.mjs";

const BASE = process.env.BASE ?? "https://yale-shuttle.fly.dev";
const ARCHIVE_DIR = process.env.ARCHIVE_DIR ?? path.join(os.homedir(), "shuttle-archive");
const CAPTURES_DIR = process.env.CAPTURES_DIR ?? path.join(os.homedir(), "shuttle-captures");
const RETAIN_DAYS = Number(process.env.ARCHIVE_RETAIN_DAYS ?? 180);

/** Every table the feed serves; positions get the capture merge. */
export const TABLES = [
  "raw_positions",
  "arrivals",
  "stop_visits",
  "legs",
  "predictions_log",
  "upstream_etas",
  "scorecard_days",
];
/** The capture's own columns; server rows are trimmed to these so both sources match. */
const POSITION_COLUMNS = ["bus_id", "bus_name", "route_id", "lat", "lon", "heading", "last_stop_id", "collected_at"];

const ET = "America/New_York";

export function etDay(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** ET midnight of a YYYY-MM-DD, DST-aware (the same trick as src/server/actives.ts). */
export function etDayStartMs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return 0;
  const est = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + 5 * 3_600_000;
  const edt = est - 3_600_000;
  return etDay(edt) === day ? edt : est;
}

export function nextDay(day) {
  return etDay(etDayStartMs(day) + 26 * 3_600_000);
}

function token() {
  if (process.env.SHUTTLE_ADMIN_TOKEN) return process.env.SHUTTLE_ADMIN_TOKEN.trim();
  const file = path.join(os.homedir(), ".yale-shuttle-admin-token");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    console.error(`No admin token. Set $SHUTTLE_ADMIN_TOKEN or put it in ${file}.`);
    process.exit(1);
  }
}

/**
 * Pull one table for one day. Returns { header, rows, complete } where rows
 * are the parsed JSON objects and `complete` says the trailer arrived with the
 * count it claimed — a stream that was cut off is data we must not trust.
 */
export async function fetchTable(base, adminToken, day, table) {
  const url = `${base}/api/archive/day?day=${encodeURIComponent(day)}&table=${encodeURIComponent(table)}`;
  const res = await fetch(url, { headers: { "x-admin-token": adminToken } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${table}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error(`empty response for ${table}`);
  const header = JSON.parse(lines[0]);
  if (header.table !== table || header.day !== day) throw new Error(`header mismatch for ${table}: ${lines[0].slice(0, 120)}`);
  let trailer = null;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const obj = JSON.parse(lines[i]);
    if (trailer !== null) throw new Error(`data after trailer for ${table}`);
    if (obj && obj.end === true) { trailer = obj; continue; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`invalid row for ${table}`);
    rows.push(obj);
  }
  const complete = trailer !== null && trailer.rows === rows.length;
  return { header, rows, complete };
}

/** Capture rows for an ET day: the two UTC-named files it can span, filtered and de-duplicated. */
export function captureRows(day, capturesDir = CAPTURES_DIR) {
  const from = etDayStartMs(day);
  const to = etDayStartMs(nextDay(day));
  const utcNames = new Set();
  for (const t of [from, to - 1]) {
    const d = new Date(t);
    utcNames.add(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`);
  }
  const out = new Map();
  const files = [];
  for (const name of utcNames) {
    const file = path.join(capturesDir, `positions-${name}.jsonl`);
    if (!fs.existsSync(file)) continue;
    files.push(file);
    // Files are tens of MB; line by line, not JSON.parse of the whole thing.
    const text = fs.readFileSync(file, "utf8");
    let start = 0;
    while (start < text.length) {
      let end = text.indexOf("\n", start);
      if (end === -1) end = text.length;
      const line = text.slice(start, end);
      start = end + 1;
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (typeof r.collected_at !== "number" || r.collected_at < from || r.collected_at >= to) continue;
      out.set(`${r.bus_id}:${r.collected_at}`, r);
    }
  }
  return { rows: [...out.values()].sort((a, b) => a.collected_at - b.collected_at || a.bus_id - b.bus_id), files };
}

function writeGz(file, rows) {
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  const gz = zlib.gzipSync(Buffer.from(text, "utf8"), { level: 6 });
  fs.writeFileSync(file, gz, { flag: "wx" });
  return { bytes: gz.length, rawBytes: Buffer.byteLength(text), sha256: crypto.createHash("sha256").update(gz).digest("hex") };
}

/** Row identity includes the event clock: a reused database id is not the same event. */
const TIME_KEYS = {
  arrivals: "arrived_at", stop_visits: "anchored_at", legs: "departed_at",
  predictions_log: "predicted_at", upstream_etas: "sampled_at",
};
function rowKey(table, row) {
  const fields = table === "raw_positions" ? ["bus_id", "collected_at"]
    : table === "scorecard_days" ? ["day", "route_id", "horizon", "surface"]
    : ["id", TIME_KEYS[table]];
  if (fields.some(key => row[key] === undefined || row[key] === null)) throw new Error(`missing row identity for ${table}`);
  return JSON.stringify(fields.map(key => row[key]));
}
function indexRows(table, rows) {
  const index = new Map();
  for (const row of rows) {
    const key = rowKey(table, row);
    if (index.has(key)) throw new Error(`duplicate row identity for ${table}`);
    index.set(key, row);
  }
  return index;
}

/** Only ordinary arrival completion and advancing scorecard snapshots may change old values. */
function preservesRow(table, prior, next) {
  if (table === "scorecard_days") {
    return next.scored_through >= prior.scored_through && next.scored_at >= prior.scored_at
      && next.final >= prior.final && (prior.final !== 1 || JSON.stringify(next) === JSON.stringify(prior));
  }
  return Object.entries(prior).every(([key, value]) =>
    JSON.stringify(next[key]) === JSON.stringify(value)
    || (table === "arrivals" && ["departed_at", "dwell_sec"].includes(key) && value === null && Number.isFinite(next[key])));
}

/** A retry must contain every previous observation, not just as many rows. */
export function replacementError(table, priorRows, nextRows) {
  const before = indexRows(table, priorRows), after = indexRows(table, nextRows);
  for (const [key, row] of before) {
    const next = after.get(key);
    if (!next) return `retry omits previously archived rows in ${table}`;
    if (!preservesRow(table, row, next)) return `retry changes previously archived values in ${table}`;
  }
  return null;
}

function atomicJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Verify the older file before treating it as evidence for a replacement. */
function previousRows(dir, table, manifest) {
  const entry = manifest.tables[table];
  const data = fs.readFileSync(archiveTableFile(dir, table, manifest));
  if (data.length !== entry.bytes || crypto.createHash("sha256").update(data).digest("hex") !== entry.sha256) {
    throw new Error(`previous archive integrity check failed for ${table}`);
  }
  const rows = readArchiveTable(dir, table, manifest);
  if (rows.length !== entry.rows) throw new Error(`previous archive row count differs for ${table}`);
  return rows;
}

/**
 * Preserve every attempt, then publish one atomic manifest selecting safe files.
 * `ok` describes THIS attempt; `archiveOk` describes the selected archive.
 */
export async function archiveDay(day, opts = {}) {
  const base = opts.base ?? BASE;
  const adminToken = opts.token ?? token();
  const dir = path.join(opts.archiveDir ?? ARCHIVE_DIR, day);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".archive-lock");
  // Fail before touching any archive if another writer (or an interrupted writer) owns it.
  fs.mkdirSync(lock);
  try {
    return await archiveLocked(day, opts, base, adminToken, dir);
  } finally {
    fs.rmdirSync(lock);
  }
}

async function archiveLocked(day, opts, base, adminToken, dir) {
  const manifestFile = path.join(dir, "manifest.json");
  const previousText = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, "utf8") : null;
  const previous = previousText === null ? null : JSON.parse(previousText);
  if (previous && previous.day !== day) throw new Error("previous manifest day mismatch");
  const attemptId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const relativeDir = path.join("snapshots", attemptId);
  const snapshotDir = path.join(dir, relativeDir);
  fs.mkdirSync(snapshotDir, { recursive: true });
  if (previousText !== null) fs.writeFileSync(path.join(snapshotDir, "previous-manifest.json"), previousText, { flag: "wx" });
  const attempt = {
    version: 2, day, from: etDayStartMs(day), to: etDayStartMs(nextDay(day)),
    generatedAt: new Date().toISOString(), base, build: null, tables: {}, positions: null,
    completeness: "transport only; service coverage and outcome finality are not established", ok: true,
  };
  const selected = { ...attempt, tables: { ...previous?.tables }, positions: previous?.positions ?? null };
  for (const table of TABLES) {
    const entry = { file: path.join(relativeDir, `${table}.jsonl.gz`), rows: 0, complete: false, source: "server" };
    let positions = null;
    try {
      const got = await fetchTable(base, adminToken, day, table);
      attempt.build = attempt.build ?? got.header.build ?? null;
      entry.build = got.header.build ?? null;
      entry.capturedAt = new Date().toISOString();
      entry.columns = got.header.columns;
      let rows = got.rows;
      entry.complete = got.complete;
      if (!got.complete) entry.error = "missing trailer or trailer row-count mismatch";
      // Catch duplicate server identities before a capture merge could conceal them.
      indexRows(table, rows);
      if (table === "raw_positions") {
        const cap = captureRows(day, opts.capturesDir);
        const merged = new Map();
        for (const r of cap.rows) {
          const trimmed = {};
          for (const c of POSITION_COLUMNS) trimmed[c] = r[c] ?? null;
          merged.set(rowKey(table, r), trimmed);
        }
        let fromServer = 0;
        for (const r of rows) {
          const key = rowKey(table, r);
          if (!merged.has(key)) fromServer += 1;
          const trimmed = {};
          for (const c of POSITION_COLUMNS) trimmed[c] = r[c] ?? null;
          merged.set(key, trimmed);
        }
        rows = [...merged.values()].sort((a, b) => a.collected_at - b.collected_at || a.bus_id - b.bus_id);
        positions = {
          server: got.rows.length, capture: cap.rows.length, onlyServer: fromServer,
          merged: rows.length, captureFiles: cap.files.map(f => path.basename(f)),
        };
        attempt.positions = positions;
        entry.columns = POSITION_COLUMNS;
        entry.source = cap.rows.length ? (got.rows.length ? "server+capture" : "capture") : "server";
        // A partial capture cannot certify a failed server transport, nor full-day coverage.
      }
      entry.rows = rows.length;
      Object.assign(entry, writeGz(path.join(dir, entry.file), rows));
      const prior = previous?.tables?.[table];
      if (prior?.sha256) {
        const reason = replacementError(table, previousRows(dir, table, previous), rows);
        if (reason) entry.replacementError = reason;
      } else if (prior && (prior.rows > 0 || prior.complete)) {
        entry.replacementError = `previous ${table} has no verifiable hash`;
      }
      if (entry.complete && !entry.replacementError) {
        selected.tables[table] = { ...entry };
        if (positions) selected.positions = positions;
      } else if (!prior) {
        // First partial export is retained and explicitly marked incomplete.
        selected.tables[table] = { ...entry };
        if (positions) selected.positions = positions;
      }
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      entry.complete = false;
      if (!previous?.tables?.[table]) selected.tables[table] = { ...entry };
    }
    if (!entry.complete || entry.replacementError) attempt.ok = false;
    attempt.tables[table] = entry;
  }
  selected.ok = TABLES.every(table => selected.tables[table]?.complete === true && !selected.tables[table]?.replacementError);
  // Each selected table carries its own build/time; retained tables may be older.
  selected.build = attempt.build;
  selected.lastAttempt = { file: path.join(relativeDir, "manifest.json"), ok: attempt.ok };
  attempt.archiveOk = selected.ok;
  attempt.manifestFile = path.join(relativeDir, "manifest.json");
  atomicJson(path.join(snapshotDir, "manifest.json"), attempt);
  atomicJson(manifestFile, selected);
  return attempt;
}

/** Remove day directories older than the retention. Returns what was removed. */
export function prune(archiveDir = ARCHIVE_DIR, retainDays = RETAIN_DAYS, now = Date.now()) {
  const cutoff = etDay(now - retainDays * 86_400_000);
  const removed = [];
  if (!fs.existsSync(archiveDir)) return removed;
  for (const name of fs.readdirSync(archiveDir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || name >= cutoff) continue;
    fs.rmSync(path.join(archiveDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const yesterday = etDay(Date.now() - 86_400_000);
  let days;
  if (args.length === 0) days = [yesterday];
  else if (args.length === 1) days = [args[0]];
  else {
    days = [];
    for (let d = args[0]; d <= args[1]; d = nextDay(d)) days.push(d);
  }
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || etDay(etDayStartMs(d)) !== d) {
      console.error(`not a day: ${d}`);
      process.exit(2);
    }
  }
  let failed = false;
  for (const day of days) {
    const t0 = Date.now();
    const m = await archiveDay(day);
    const parts = TABLES.map((t) => {
      const e = m.tables[t];
      return `${t}=${e.rows}${e.complete ? "" : "!"}`;
    });
    const pos = m.positions ? ` positions(server ${m.positions.server}, capture ${m.positions.capture}, merged ${m.positions.merged})` : "";
    console.log(`${new Date().toISOString()} ${day} ${m.ok ? "ok" : "INCOMPLETE"} ${parts.join(" ")}${pos} build=${m.build ?? "?"} ${Date.now() - t0} ms`);
    console.log(`  attempt=${m.manifestFile} selected archive=${m.archiveOk ? "transport complete" : "INCOMPLETE"}`);
    for (const t of TABLES) {
      const error = m.tables[t].error ?? m.tables[t].replacementError;
      if (error) console.error(`  ${day} ${t}: ${error}; previous data preserved when available`);
    }
    if (!m.ok) failed = true;
  }
  const removed = prune();
  if (removed.length) console.log(`pruned ${removed.length} day(s) older than ${RETAIN_DAYS} d: ${removed.join(" ")}`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
