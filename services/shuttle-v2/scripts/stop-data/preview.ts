/** Isolated localhost preview of the operator page against a saved SQLite snapshot. */
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Collector } from "../../src/collector/collector.js";
import type { UpstreamClient } from "../../src/collector/upstream.js";
import { openDb, type DbBundle } from "../../src/db/client.js";
import { buildApp } from "../../src/server/app.js";

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PREVIEW_TOKEN = "preview-only-token";
const { values } = parseArgs({ options: {
  db: { type: "string" }, port: { type: "string", default: "8098" },
  staticDir: { type: "string", default: path.join(serviceDir, "web/dist") },
  now: { type: "string" }, help: { type: "boolean", short: "h" },
} });

if (values.help || !values.db) {
  console.log("Usage: npx tsx scripts/stop-data/preview.ts --db /path/snapshot.db [--port 8098] [--staticDir web/dist] [--now ISO-or-epoch-ms]");
  console.log("Open http://127.0.0.1:8098/stats/stops and sign in with preview-only-token. Ctrl-C removes the disposable database.");
  process.exit(values.help ? 0 : 1);
}

const port = Number(values.port);
if (!/^\d+$/.test(values.port!) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");
const sourcePath = fs.realpathSync(path.resolve(values.db));
if (!fs.statSync(sourcePath).isFile()) throw new Error("--db must name a saved SQLite file");
const staticDir = path.resolve(values.staticDir!);
if (!fs.existsSync(path.join(staticDir, "stop-data.html"))) {
  throw new Error(`Missing ${path.join(staticDir, "stop-data.html")}; build the web app first.`);
}
const explicitNow = values.now === undefined ? undefined
  : /^\d+$/.test(values.now) ? Number(values.now) : Date.parse(values.now);
if (explicitNow !== undefined && (!Number.isSafeInteger(explicitNow) || explicitNow <= 0)) throw new Error("--now must be an ISO timestamp or positive epoch milliseconds");

let tempDir: string | undefined;
let bundle: DbBundle | undefined;
let collector: Collector | undefined;
let shuttingDown = false;

function cleanup(): void {
  collector?.stop();
  if (bundle?.sqlite.open) bundle.sqlite.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}

try {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yale-stop-data-preview-"));
  const copyPath = path.join(tempDir, "snapshot.db");
  // Opening the source through openDb would set journal PRAGMAs. Open it
  // directly read-only, and use SQLite backup to include committed WAL data.
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    source.pragma("query_only = ON");
    await source.backup(copyPath);
  } finally { source.close(); }

  bundle = openDb(copyPath);
  migrate(bundle.db, { migrationsFolder: path.join(serviceDir, "drizzle") });
  const latestPosition = bundle.sqlite.prepare("SELECT collected_at AS at FROM raw_positions ORDER BY collected_at DESC LIMIT 1").get() as { at: number } | undefined;
  const latestVisit = bundle.sqlite.prepare("SELECT anchored_at AS at FROM stop_visits ORDER BY anchored_at DESC LIMIT 1").get() as { at: number } | undefined;
  const fixedNow = explicitNow ?? (Math.max(latestPosition?.at ?? 0, latestVisit?.at ?? 0) || Date.now());

  // This is a process-level backstop as well as injected fake dependencies.
  // No route in this preview can make a live HTTP request.
  globalThis.fetch = async () => { throw new Error("External fetch is disabled in the stop-data preview"); };
  const upstream = {
    buses: async () => [], stops: async () => [], routes: async () => [],
    announcements: async () => [],
  } as unknown as UpstreamClient;
  collector = await Collector.create(bundle, {
    upstream, upstreamEta: false, etaSampler: false,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  // Deliberately never call collector.start(): no polling, calibration,
  // retention, derived paths, upstream refresh, or scorecard jobs.
  const app = buildApp({
    bundle, collector, staticDir, now: () => fixedNow, adminToken: PREVIEW_TOKEN,
    operatorAnonIds: "", statsSinceDay: "2000-01-01", predictionSampleRate: 0,
    geocoder: { lookup: async () => [] }, weather: { get: async () => ({ available: false }) },
  });
  const server = serve({
    port, hostname: "127.0.0.1",
    fetch: (request) => {
      const pathname = new URL(request.url).pathname;
      const allowed = pathname === "/stats/stops" || pathname === "/stats/stops/"
        || pathname === "/stop-data.html" || pathname.startsWith("/assets/")
        || pathname === "/api/stats/session" || pathname.startsWith("/api/stats/stops/");
      return allowed ? app.fetch(request) : new Response("This local preview serves only the stop-data operator page.", { status: 404 });
    },
  }, () => {
    console.log(JSON.stringify({
      event: "stop-data-preview.listening", url: `http://127.0.0.1:${port}/stats/stops`,
      token: PREVIEW_TOKEN, fixedNow: new Date(fixedNow).toISOString(),
      source: sourcePath, disposableDatabase: copyPath,
    }));
  });
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const finish = () => { cleanup(); process.exit(exitCode); };
    const timeout = setTimeout(finish, 3000);
    timeout.unref();
    server.close(() => { clearTimeout(timeout); finish(); });
  };
  server.on("error", (error) => { console.error(error.message); shutdown(1); });
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
} catch (error) {
  cleanup();
  throw error;
}
