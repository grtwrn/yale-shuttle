#!/usr/bin/env node
// Staged deploy: gate -> build -> run the REAL server locally -> smoke it with
// a REAL browser -> only then deploy to Fly -> verify prod the same way.
//
// Exists because of 2026-09-01: `vite build` compiles but does not type-check,
// so a ReferenceError (state referenced from a child component without the
// prop) shipped to production and crashed the app for riders. Every stage here
// would have caught it before flyctl ran: `npm run typecheck` now covers web/,
// and the browser smoke loads the actual built bundle and fails on any page
// error or the ErrorBoundary's "App crashed" screen.
//
//   npm run deploy               # full: gates, local staging, prod, verify
//   npm run deploy -- --stage-only   # everything except the prod deploy
//
// The staging server is the production entrypoint (src/index.ts) serving the
// freshly built web/dist against a THROWAWAY database in a temp dir — which
// also proves migrations apply cleanly to an empty DB before prod boots them.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLYCTL = process.env.FLYCTL ?? path.join(os.homedir(), ".fly/bin/flyctl");
const CHROMIUM = process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium";
const STAGE_PORT = 8093;
const STAGE_URL = `http://127.0.0.1:${STAGE_PORT}`;
const PROD_URL = "https://yale-shuttle.fly.dev";
const STAGE_ONLY = process.argv.includes("--stage-only");

let stagingProc = null;
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-stage-"));

const log = (msg) => console.log(`[deploy] ${msg}`);
const fail = (msg) => {
  console.error(`\n[deploy] ✗ ${msg}`);
  cleanup();
  process.exit(1);
};
const killStaging = () => {
  if (stagingProc && !stagingProc.killed) {
    try { process.kill(-stagingProc.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  stagingProc = null;
};

const cleanup = () => {
  // The server is spawned detached in its own process group so this negative-
  // pid kill reaches the actual tsx process, not just the npx wrapper. Killing
  // only the wrapper orphaned a server still bound to :8093 once, and the NEXT
  // deploy's smoke checks silently ran against the leftover build.
  // SIGKILL, immediately and unconditionally. The staging server holds only a
  // throwaway DB, so graceful shutdown buys nothing — and it actively broke
  // this script twice: src/index.ts drains in-flight responses on SIGTERM, the
  // browser smoke leaves a stream open, so the drain never finishes, and the
  // polite unref()'d SIGKILL timer died with this process. Orphan every time.
  killStaging();
  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* temp dir */ }
};
process.on("SIGINT", () => { cleanup(); process.exit(130); });

function run(label, cmd, args, opts = {}) {
  log(label);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${label} failed (exit ${r.status})`);
}

async function waitForHealthy(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no response yet";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      if (res.ok && body.ok) return body;
      lastErr = `${res.status} ${JSON.stringify(body)}`;
    } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`${base}/healthz never became healthy: ${lastErr}`);
}

async function apiSmoke(base) {
  const checks = [
    ["GET /api/buses shape", async () => {
      const j = await (await fetch(`${base}/api/buses`)).json();
      for (const k of ["buses", "route_paths", "stop_names", "stop_coords", "announcements"]) {
        if (!(k in j)) throw new Error(`payload missing ${k}`);
      }
      if (!Array.isArray(j.buses)) throw new Error("buses not an array");
      if (Object.keys(j.route_paths).length < 10) throw new Error("route_paths suspiciously empty");
    }],
    ["geocode handles a missing apostrophe", async () => {
      const j = await (await fetch(`${base}/api/geocode?q=trader%20joes`)).json();
      // v1-compat field names: hits carry display_name, not label.
      if (!j.results?.some((r) => (r.display_name ?? r.label ?? "").toLowerCase().includes("trader joe"))) {
        throw new Error("'trader joes' found nothing");
      }
    }],
    ["PWA assets", async () => {
      for (const p of ["/manifest.webmanifest", "/sw.js", "/icons/icon-192.png"]) {
        const res = await fetch(`${base}${p}`);
        if (!res.ok) throw new Error(`${p} -> ${res.status}`);
      }
    }],
    ["SPA shell serves", async () => {
      const html = await (await fetch(`${base}/`)).text();
      if (!html.includes("Yale Shuttle")) throw new Error("index.html lacks the app title");
    }],
  ];
  for (const [label, f] of checks) {
    try { await f(); log(`  ✓ ${label}`); }
    catch (e) { fail(`API smoke: ${label}: ${e.message}`); }
  }
}

async function browserSmoke(base, { markAsTest }) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 430, height: 880 } });
    if (markAsTest) {
      // Against PROD the browser must not count as a rider.
      const { seedTestId } = await import("./testId.mjs");
      await seedTestId(ctx);
    }
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(6000);

    const body = await page.evaluate(() => document.body.innerText);
    if (body.includes("App crashed")) fail(`browser smoke: ErrorBoundary tripped on load\n${body.slice(0, 500)}`);
    if (!body.includes("Trip")) fail("browser smoke: tab bar never rendered");

    // Walk every tab — today's crash only fired once a specific card rendered,
    // so touching each surface matters more than staring at the home screen.
    for (const tab of ["All", "Map", "Trip"]) {
      const btn = page.getByRole("button", { name: tab, exact: true }).first();
      if (await btn.count()) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(2500);
        const t = await page.evaluate(() => document.body.innerText);
        if (t.includes("App crashed")) fail(`browser smoke: crash on ${tab} tab\n${t.slice(0, 500)}`);
      }
    }

    const fatal = errors.filter((e) => !e.startsWith("console:"));
    if (fatal.length) fail(`browser smoke: page errors:\n  ${fatal.join("\n  ")}`);
    if (errors.length) log(`  (non-fatal console errors: ${errors.length})`);
    log("  ✓ loaded, tabs walked, no page errors, no crash screen");
  } finally {
    await browser.close();
  }
}

// ── stages ────────────────────────────────────────────────────────────────
run("stage 1/6: typecheck (backend + web)", "npm", ["run", "typecheck"]);
run("stage 2/6: unit tests", "npx", ["vitest", "run"]);
run("stage 3/6: frontend build", "npx", ["vite", "build"], { cwd: path.join(ROOT, "web") });

log(`stage 4/6: staging server on :${STAGE_PORT} (throwaway DB in ${stageDir})`);
// Refuse to stage against a squatter: if anything already holds the port, the
// smoke checks would test THAT build and bless this one on false evidence.
try {
  await fetch(`${STAGE_URL}/healthz`, { signal: AbortSignal.timeout(1500) });
  fail(`something is already listening on :${STAGE_PORT} — kill it first`);
} catch { /* connection refused = port free, which is what we want */ }

stagingProc = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: ROOT,
  detached: true,
  env: {
    ...process.env,
    PORT: String(STAGE_PORT),
    SHUTTLE_V2_DB: path.join(stageDir, "stage.db"),
    SHUTTLE_ADMIN_TOKEN: "staging-only-token",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
stagingProc.on("exit", (code) => {
  if (code !== null && code !== 0 && !STAGE_ONLY) fail(`staging server exited early (${code})`);
});
await waitForHealthy(STAGE_URL, 90_000);
log("  ✓ healthy (migrations applied to an empty DB, collector polling)");
await apiSmoke(STAGE_URL);
await browserSmoke(STAGE_URL, { markAsTest: false });
killStaging();

if (STAGE_ONLY) {
  log("stage-only run: all local stages green, skipping prod. ✓");
  cleanup();
  process.exit(0);
}

run("stage 5/6: deploy to Fly", FLYCTL, ["deploy", "--remote-only"]);

log("stage 6/6: verify production");
await waitForHealthy(PROD_URL, 120_000);
await apiSmoke(PROD_URL);
await browserSmoke(PROD_URL, { markAsTest: true });
log("production verified. ✓");
cleanup();
