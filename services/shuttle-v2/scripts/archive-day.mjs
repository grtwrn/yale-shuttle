#!/usr/bin/env node
/**
 * Archive one ET day of production data on the Pi.
 *
 * Stage 2 of the closed loop (docs/closed-loop.md). The production volume is
 * 1 GB with ~430 MB free and retention sweeps `raw_positions` after 6 h, the
 * census after ~4 weekdays and `predictions_log`'s upstream rows after 7 days,
 * so the rows a replay needs do not survive where they are written. This pulls
 * them, one table at a time, through `GET /api/archive/day` (admin header
 * only, JSON lines with a header and an `{"end":true}` trailer) and keeps them
 * as `~/shuttle-archive/YYYY-MM-DD/<table>.jsonl.gz` beside a `manifest.json`.
 *
 * Positions are the one table retention has usually beaten by 03:40, so the
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
 * Re-running a day overwrites it. Exit code is non-zero when any table of any
 * requested day failed, after every other table was still written.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

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
    if (obj && obj.end === true) { trailer = obj; break; }
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
  fs.writeFileSync(file, gz);
  return { bytes: gz.length, rawBytes: Buffer.byteLength(text), sha256: crypto.createHash("sha256").update(gz).digest("hex") };
}

/** Archive one day. Returns the manifest; throws nothing, records failures. */
export async function archiveDay(day, opts = {}) {
  const base = opts.base ?? BASE;
  const adminToken = opts.token ?? token();
  const dir = path.join(opts.archiveDir ?? ARCHIVE_DIR, day);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    day,
    from: etDayStartMs(day),
    to: etDayStartMs(nextDay(day)),
    generatedAt: new Date().toISOString(),
    base,
    build: null,
    tables: {},
    positions: null,
    ok: true,
  };
  for (const table of TABLES) {
    const entry = { file: `${table}.jsonl.gz`, rows: 0, complete: false, source: "server" };
    try {
      const got = await fetchTable(base, adminToken, day, table);
      manifest.build = manifest.build ?? got.header.build ?? null;
      entry.columns = got.header.columns;
      let rows = got.rows;
      entry.complete = got.complete;
      if (!got.complete) entry.error = "stream ended without its trailer";
      if (table === "raw_positions") {
        // Merge the Pi's capture: the server's 6 h window has usually swept
        // most of the day by the time this runs.
        const cap = captureRows(day, opts.capturesDir);
        const merged = new Map();
        for (const r of cap.rows) merged.set(`${r.bus_id}:${r.collected_at}`, r);
        let fromServer = 0;
        for (const r of rows) {
          const key = `${r.bus_id}:${r.collected_at}`;
          if (!merged.has(key)) fromServer += 1;
          const trimmed = {};
          for (const c of POSITION_COLUMNS) trimmed[c] = r[c] ?? null;
          merged.set(key, trimmed);
        }
        rows = [...merged.values()].sort((a, b) => a.collected_at - b.collected_at || a.bus_id - b.bus_id);
        manifest.positions = {
          server: got.rows.length,
          capture: cap.rows.length,
          onlyServer: fromServer,
          merged: rows.length,
          captureFiles: cap.files.map((f) => path.basename(f)),
        };
        entry.columns = POSITION_COLUMNS;
        entry.source = cap.rows.length ? (got.rows.length ? "server+capture" : "capture") : "server";
        // The capture is complete for the day even when the server's part was cut off.
        if (!got.complete && cap.rows.length) { entry.complete = true; delete entry.error; entry.note = "server stream incomplete; capture used"; }
      }
      entry.rows = rows.length;
      Object.assign(entry, writeGz(path.join(dir, entry.file), rows));
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      entry.complete = false;
    }
    if (!entry.complete) manifest.ok = false;
    manifest.tables[table] = entry;
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
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
    for (const t of TABLES) if (m.tables[t].error) console.error(`  ${day} ${t}: ${m.tables[t].error}`);
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
