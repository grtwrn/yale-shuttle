import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Collector } from "../../services/shuttle-v2/src/collector/collector.ts";
import { openDb } from "../../services/shuttle-v2/src/db/client.ts";
import { buildApp } from "../../services/shuttle-v2/src/server/app.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const service = path.resolve(here, "../../services/shuttle-v2");
const require = createRequire(path.join(service, "package.json"));
const { serve } = require("@hono/node-server");
const { migrate } = require("drizzle-orm/better-sqlite3/migrator");
if (!process.env.SHUTTLE_V2_DB?.startsWith("/tmp/")) throw Error("Preview requires a throwaway /tmp database");
if (process.env.SHUTTLE_STANDING_FORECAST !== "0") throw Error("Preview fitting must be disabled");
globalThis.fetch = async () => { throw Error("This isolated preview server has no upstream access"); };
const bundle = openDb();
migrate(bundle.db, { migrationsFolder: path.join(service, "drizzle") });
// Construct the real app and database, without starting collector/network timers.
const collector = await Collector.create(bundle, { upstream: {} as any, upstreamEta: false, etaSampler: false, standingForecast: false });
const app = buildApp({ collector, bundle, staticDir: path.join(service, "web/dist") });
const server = serve({ fetch: app.fetch, port: 8097, hostname: "127.0.0.1" });
console.log(JSON.stringify({ preview: true, port: 8097, database: process.env.SHUTTLE_V2_DB, upstream: false }));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  collector.stop();
  server.close(() => { bundle.sqlite.close(); process.exit(0); });
  server.closeIdleConnections?.();
});
