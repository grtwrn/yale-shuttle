#!/usr/bin/env node
/**
 * Which archived days are complete.
 *
 * Reads every `~/shuttle-archive/YYYY-MM-DD/manifest.json` written by
 * archive-day.mjs and prints one line per day — rows per table, gzipped size,
 * and whether every table arrived whole — then the gaps: days in the last
 * `--days N` (30) with no directory at all. Exits 1 when yesterday is missing
 * or incomplete, so a cron line can alert on it.
 *
 *   node scripts/archive-check.mjs            # last 30 days
 *   node scripts/archive-check.mjs --days 90
 *   node scripts/archive-check.mjs --json
 *
 * Env: ARCHIVE_DIR (~/shuttle-archive).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ARCHIVE_DIR = process.env.ARCHIVE_DIR ?? path.join(os.homedir(), "shuttle-archive");
const ET = "America/New_York";
const REQUIRED = ["raw_positions", "arrivals", "stop_visits", "legs", "predictions_log", "upstream_etas", "scorecard_days"];

function etDay(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** One day's status from its directory. */
export function checkDay(dir) {
  const day = path.basename(dir);
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return { day, complete: false, missing: REQUIRED, reason: "no manifest", bytes: 0, tables: {} };
  let m;
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { day, complete: false, missing: REQUIRED, reason: "manifest unreadable", bytes: 0, tables: {} };
  }
  const missing = [];
  let bytes = 0;
  const tables = {};
  for (const t of REQUIRED) {
    const e = m.tables && m.tables[t];
    const file = e && path.join(dir, e.file);
    const present = e && e.complete && file && fs.existsSync(file) && fs.statSync(file).size === e.bytes;
    if (!present) missing.push(t);
    else bytes += e.bytes;
    tables[t] = e ? { rows: e.rows, complete: !!present, source: e.source } : null;
  }
  // A day of service with no positions at all is not archived, whatever the manifest says.
  const positions = m.tables && m.tables.raw_positions;
  if (positions && positions.complete && positions.rows === 0 && !missing.includes("raw_positions")) missing.push("raw_positions (0 rows)");
  return {
    day,
    complete: missing.length === 0,
    missing,
    bytes,
    build: m.build ?? null,
    generatedAt: m.generatedAt ?? null,
    positions: m.positions ?? null,
    tables,
  };
}

export function checkAll(archiveDir = ARCHIVE_DIR, days = 30, now = Date.now()) {
  const present = new Map();
  if (fs.existsSync(archiveDir)) {
    for (const name of fs.readdirSync(archiveDir).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
      present.set(name, checkDay(path.join(archiveDir, name)));
    }
  }
  const yesterday = etDay(now - 86_400_000);
  const gaps = [];
  for (let i = days; i >= 1; i--) {
    const d = etDay(now - i * 86_400_000);
    if (!present.has(d)) gaps.push(d);
  }
  return {
    archiveDir,
    days: [...present.values()],
    gaps,
    yesterday,
    yesterdayOk: present.has(yesterday) && present.get(yesterday).complete,
  };
}

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
  if (b >= 1e3) return (b / 1e3).toFixed(0) + " kB";
  return b + " B";
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const di = argv.indexOf("--days");
  const days = di >= 0 ? Math.max(1, parseInt(argv[di + 1] ?? "30", 10) || 30) : 30;
  const r = checkAll(ARCHIVE_DIR, days);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`archive: ${r.archiveDir}\n`);
    const head = ["day", "status", "positions", "arrivals", "visits", "legs", "predictions", "census", "scorecard", "size", "build"];
    const rows = r.days.map((d) => {
      const t = (n) => (d.tables[n] ? String(d.tables[n].rows) + (d.tables[n].complete ? "" : "!") : "-");
      return [
        d.day,
        d.complete ? "ok" : "INCOMPLETE",
        t("raw_positions") + (d.positions ? ` (${d.positions.source ?? d.tables.raw_positions?.source ?? ""})`.replace(" ()", "") : ""),
        t("arrivals"), t("stop_visits"), t("legs"), t("predictions_log"), t("upstream_etas"), t("scorecard_days"),
        fmtBytes(d.bytes), d.build ? String(d.build).slice(0, 12) : "-",
      ];
    });
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
    console.log(line(head));
    for (const row of rows) console.log(line(row));
    const total = r.days.reduce((s, d) => s + d.bytes, 0);
    const complete = r.days.filter((d) => d.complete).length;
    console.log(`\n${complete} of ${r.days.length} day(s) complete, ${fmtBytes(total)} on disk`);
    for (const d of r.days.filter((x) => !x.complete)) console.log(`  ${d.day} missing: ${d.missing.join(", ")}${d.reason ? ` (${d.reason})` : ""}`);
    if (r.gaps.length) console.log(`no archive for ${r.gaps.length} of the last ${days} days: ${r.gaps.join(" ")}`);
    console.log(`yesterday (${r.yesterday}): ${r.yesterdayOk ? "ok" : "MISSING OR INCOMPLETE"}`);
  }
  process.exit(r.yesterdayOk ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
