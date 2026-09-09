#!/usr/bin/env node
/** Preserve existing server tracking before its six-hour raw-position retention. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { etDay } from "../../archive-day.mjs";

const base = process.env.BASE ?? "https://yale-shuttle.fly.dev";
const captureDir = process.env.CAPTURES_DIR ?? path.join(os.homedir(), "shuttle-captures");
const outDir = process.env.PROSPECTIVE_DIR ?? new URL("../../.eta-replay/overnight-2026-09-08/prospective/", import.meta.url).pathname;
const adminToken = (process.env.SHUTTLE_ADMIN_TOKEN ?? fs.readFileSync(path.join(os.homedir(), ".yale-shuttle-admin-token"), "utf8")).trim();
const intervalMs = Number(process.env.CAPTURE_INTERVAL_MS ?? 15 * 60_000);
const until = process.env.CAPTURE_UNTIL ? Date.parse(process.env.CAPTURE_UNTIL) : Infinity;
const once = process.argv.includes("--once");
fs.mkdirSync(captureDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const lock = path.join(outDir, "capture.lock");
try { fs.mkdirSync(lock); } catch { throw new Error(`Capture lock exists: ${lock}; verify its owner before removing it.`); }
fs.writeFileSync(path.join(lock, "pid"), `${process.pid}\n`);
function unlock() { fs.rmSync(lock, { recursive: true, force: true }); }
process.on("exit", unlock);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

async function pull(day, table) {
  const response = await fetch(`${base}/api/archive/day?day=${day}&table=${table}`, {
    headers: { "x-admin-token": adminToken }, signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${table}: HTTP ${response.status}`);
  const text = await response.text();
  const rows = text.trim().split("\n").map(line => JSON.parse(line));
  const header = rows.shift(), trailer = rows.pop();
  if (header?.day !== day || header?.table !== table || trailer?.end !== true || trailer?.rows !== rows.length) {
    throw new Error(`${table}: incomplete or mismatched archive stream`);
  }
  return { header, rows };
}

/** Partition by each row's UTC date, not the date on which it was downloaded. */
function appendPositions(rows) {
  const groups = new Map();
  for (const row of rows) {
    const day = new Date(row.collected_at).toISOString().slice(0, 10).replaceAll("-", "");
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(row);
  }
  let added = 0;
  for (const [day, group] of groups) {
    const file = path.join(captureDir, `positions-${day}.jsonl`);
    const keys = new Set();
    if (fs.existsSync(file)) for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try { const r = JSON.parse(line); keys.add(`${r.bus_id}:${r.collected_at}`); } catch { /* old SSH output can contain non-JSON diagnostics */ }
    }
    const fresh = group.filter(r => {
      const key = `${r.bus_id}:${r.collected_at}`;
      if (keys.has(key)) return false;
      keys.add(key); return true;
    }).sort((a, b) => a.collected_at - b.collected_at || a.bus_id - b.bus_id);
    if (fresh.length) fs.appendFileSync(file, fresh.map(r => JSON.stringify(r)).join("\n") + "\n");
    added += fresh.length;
  }
  return added;
}

async function capture() {
  const now = Date.now();
  const dir = path.join(outDir, new Date(now).toISOString().replaceAll(":", "-"));
  fs.mkdirSync(dir, { recursive: true });
  const days = [...new Set([etDay(now), etDay(now - 6 * 3_600_000)])];
  const manifest = { observedAt: new Date(now).toISOString(), base, files: [], addedPositions: 0, errors: [] };
  for (const day of days) for (const table of ["raw_positions", "stop_visits", "legs", "arrivals"]) {
    try {
      const result = await pull(day, table);
      const bytes = zlib.gzipSync(result.rows.map(r => JSON.stringify(r)).join("\n") + "\n");
      const file = `${day}-${table}.jsonl.gz`;
      fs.writeFileSync(path.join(dir, file), bytes);
      manifest.files.push({ file, rows: result.rows.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), build: result.header.build, observedBy: Date.now() });
      if (table === "raw_positions") manifest.addedPositions += appendPositions(result.rows);
    } catch (error) { manifest.errors.push({ day, table, error: String(error) }); }
  }
  try {
    const response = await fetch(`${base}/api/buses`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    fs.writeFileSync(path.join(dir, "buses.json.gz"), zlib.gzipSync(JSON.stringify(payload)));
  } catch (error) { manifest.errors.push({ table: "buses", error: String(error) }); }
  manifest.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "status.json"), JSON.stringify({ pid: process.pid, dir, ...manifest }, null, 2) + "\n");
  console.log(JSON.stringify({ at: manifest.completedAt, dir, addedPositions: manifest.addedPositions, errors: manifest.errors }));
}

do {
  await capture();
  if (once || Date.now() >= until) break;
  await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, until - Date.now()))));
} while (Date.now() < until);
