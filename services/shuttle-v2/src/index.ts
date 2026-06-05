import { serve } from "@hono/node-server";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";

import { Collector } from "./collector/collector.js";
import { openDb } from "./db/client.js";
import { buildApp } from "./server/app.js";

const PORT = parseInt(process.env.PORT ?? "8092", 10);

function resolveStaticDir(): string | undefined {
  if (process.env.SHUTTLE_V2_STATIC_DIR) {
    return process.env.SHUTTLE_V2_STATIC_DIR;
  }
  // Default: the sibling `web/dist` from a vite build. Skip silently if
  // it doesn't exist (dev mode runs Vite separately on 8090 with a proxy).
  const guess = path.resolve(process.cwd(), "web/dist");
  if (fs.existsSync(path.join(guess, "index.html"))) return guess;
  return undefined;
}

async function main(): Promise<void> {
  const bundle = openDb();
  // Apply any pending migrations before anything reads/writes the DB.
  // In dev this is a no-op; on a fresh prod volume it builds the schema.
  migrate(bundle.db, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });

  const collector = await Collector.create(bundle);
  await collector.start();

  const staticDir = resolveStaticDir();
  const appOptions: Parameters<typeof buildApp>[0] = { collector, bundle };
  if (staticDir) appOptions.staticDir = staticDir;
  const app = buildApp(appOptions);
  const server = serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" });
  console.log(
    JSON.stringify({
      level: "info",
      msg: "server.listening",
      port: PORT,
      staticDir: staticDir ?? null,
    }),
  );

  const shutdown = (signal: NodeJS.Signals) => {
    console.log(JSON.stringify({ level: "info", msg: "shutting_down", signal }));
    server.close();
    collector.stop();
    bundle.sqlite.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Process-level backstops. The poll/retention loops and HTTP handlers contain
// their own failures, so these should rarely fire — but a single-machine
// always-on service must not be one stray error away from dying silently.
process.on("unhandledRejection", (reason) => {
  // Log and keep running: a stray background rejection shouldn't kill a
  // process that's otherwise serving traffic and polling fine.
  console.error(
    JSON.stringify({
      level: "error",
      msg: "unhandled_rejection",
      error: reason instanceof Error ? reason.message : String(reason),
    }),
  );
});

process.on("uncaughtException", (err) => {
  // An uncaught exception leaves the runtime in an undefined state — log and
  // exit so Fly restarts a clean machine (min_machines_running=1 brings it
  // straight back) rather than limping along corrupted.
  console.error(
    JSON.stringify({
      level: "fatal",
      msg: "uncaught_exception",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});

main().catch((err) => {
  console.error(
    JSON.stringify({ level: "fatal", msg: "main_failed", error: (err as Error).message }),
  );
  process.exit(1);
});
