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
import { createHash } from "node:crypto";
import { runBrowserCheck } from "./browser-stage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLYCTL = process.env.FLYCTL ?? path.join(os.homedir(), ".fly/bin/flyctl");
const CHROMIUM = process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium";
const STAGE_PORT = 8093;
const STAGE_URL = `http://127.0.0.1:${STAGE_PORT}`;
const PROD_URL = "https://yale-shuttle.fly.dev";
const STAGE_ONLY = process.argv.includes("--stage-only");
const DEPLOY_IMAGE = process.env.SHUTTLE_DEPLOY_IMAGE;
if (DEPLOY_IMAGE && !/^registry\.fly\.io\/yale-shuttle@sha256:[a-f0-9]{64}(?![\s\S])/.test(DEPLOY_IMAGE)) {
  throw new Error("SHUTTLE_DEPLOY_IMAGE must be registry.fly.io/yale-shuttle@sha256:<64 lowercase hex digits>");
}

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
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

function run(label, cmd, args, opts = {}) {
  log(label);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${label} failed (exit ${r.status})`);
}

async function browserRegression(label, script, opts = {}) {
  log(`${label} (120 s deadline)`);
  try { await runBrowserCheck(script, { cwd: ROOT, ...opts }); }
  catch (error) { fail(`${label}: ${error.message}`); }
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
      const response = await fetch(`${base}/api/buses`), bytes = await response.text(), j = JSON.parse(bytes);
      for (const k of ["buses", "route_paths", "stop_names", "stop_coords", "announcements"]) {
        if (!(k in j)) throw new Error(`payload missing ${k}`);
      }
      if (!Array.isArray(j.buses)) throw new Error("buses not an array");
      if (Object.keys(j.route_paths).length < 10) throw new Error("route_paths suspiciously empty");
      const source = JSON.parse(response.headers.get('X-Shuttle-Snapshot') ?? 'null');
      if (source?.v !== 1 || !/^[a-f0-9]{64}$/.test(source.snapshotId)
        || source.sha256 !== createHash('sha256').update(bytes).digest('hex') || source.bytes !== Buffer.byteLength(bytes)) {
        throw new Error('public response source receipt missing or mismatched');
      }
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
      if (!html.includes("Yale Shuttle Tracker")) throw new Error("index.html lacks the app title");
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
    for (const tab of ["Map", "Trip"]) {
      const btn = page.getByRole("button", { name: tab, exact: true }).first();
      if (await btn.count()) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(2500);
        const t = await page.evaluate(() => document.body.innerText);
        if (t.includes("App crashed")) fail(`browser smoke: crash on ${tab} tab\n${t.slice(0, 500)}`);
      }
    }

    // There is one rider experience. Old comparison URLs must also request
    // the current forecast, without exposing estimator implementation choices.
    const defaultPoll = page.waitForRequest(r => new URL(r.url()).pathname === '/api/buses'
      && !new URL(r.url()).searchParams.has('eta_model'));
    await page.goto(new URL('/?eta_model=usual', base).href, { waitUntil: 'domcontentloaded' });
    await defaultPoll;
    if (await page.getByText(/^(Updated estimates|Previous estimates|Use previous estimates|Use updated estimates)$/).count())
      fail('browser smoke: estimator chooser is visible to riders');

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

// predictions_log.client_build is read from shownLog's OWN module URL
// (web/src/shownLog.ts `buildFromModuleUrl`), which only names a build when
// that code lands in the rider entry chunk. It silently read "dev" for two
// days (2026-09-09..11) after the entry was renamed; if a refactor ever hoists
// shownLog into a shared chunk (`geo-`), it would go blind the same way while
// every unit test still passed. So the built bundle is checked here.
{
  const assets = path.join(ROOT, "web", "dist", "assets");
  const holders = fs.readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => fs.readFileSync(path.join(assets, f), "utf8").includes("/api/shown"));
  // Must accept exactly what web/src/shownLog.ts `buildFromModuleUrl` accepts
  // (rider- or index-), or a correct build would be refused.
  if (holders.length !== 1 || !/^(?:rider|index)-[A-Za-z0-9_-]{4,24}\.js$/.test(holders[0])) {
    fail(`the /api/shown client must live in the entry chunk (rider-/index-) so client_build names the bundle; found: ${holders.join(", ") || "none"}`);
  }
  log(`build identity: /api/shown lives in ${holders[0]}`);
}

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
await browserRegression("stop-count notification browser regression", "scripts/stop-alert-controls-check.mjs", { env: { ...process.env, OUT: path.join(stageDir, "stop-alert-controls") } });
await browserRegression("pickup reminder timing browser regression", "scripts/pickup-reminder-check.mjs", { env: { ...process.env, BOT_BASE_URL: STAGE_URL, BOT_OUT: path.join(stageDir, "pickup-reminder") } });
await browserRegression("departure picker keyboard focus browser regression", "scripts/departure-focus-check.mjs", { env: { ...process.env, BOT_BASE_URL: STAGE_URL, BOT_OUT: path.join(stageDir, "departure-focus") } });
await browserRegression("on-demand pickup service browser regression", "scripts/pickup-service-check.mjs", { env: { ...process.env, PICKUP_SERVICE_OUT: path.join(stageDir, "pickup-service"), PICKUP_SERVICE_PRODUCTION_ASSETS: "0" } });
await browserRegression("pickup service observer browser regression", "scripts/service-disclosure-watch-check.mjs", { env: { ...process.env, SERVICE_DISCLOSURE_OUT: path.join(stageDir, "service-disclosure-watch") } });
await browserRegression("map pause wording browser regression", "scripts/map-pause-label-check.mjs", { env: { ...process.env, OUT: path.join(stageDir, "map-pause-labels") } });
await browserRegression("route label readability browser regression", "scripts/route-readability-check.mjs", { env: { ...process.env, ROUTE_READABILITY_OUT: path.join(stageDir, "route-readability"), ROUTE_READABILITY_PRODUCTION_ASSETS: "0" } });
await browserRegression("Blue pickup transition browser regression", "scripts/blue-pickup-fallback-check.mjs");
await browserRegression("new live route admission browser regression", "scripts/new-route-admission-check.mjs", { env: { ...process.env, BOT_BASE_URL: STAGE_URL, BOT_OUT: path.join(stageDir, "new-route-admission") } });
await browserRegression("missing pickup evidence browser regression", "scripts/pickup-evidence-check.mjs", { env: { ...process.env, PICKUP_EVIDENCE_OUT: path.join(stageDir, "pickup-evidence") } });
await browserRegression("approaching pickup time browser regression", "scripts/early-pickup-check.mjs", { env: { ...process.env, EARLY_PICKUP_OUT: path.join(stageDir, "early-pickup"), EARLY_PICKUP_PRODUCTION_ASSETS: "0" } });
await browserRegression("following pickup visit browser regression", "scripts/following-pickup-check.mjs", { env: { ...process.env, FOLLOWING_PICKUP_OUT: path.join(stageDir, "following-pickup"), FOLLOWING_PICKUP_PRODUCTION_ASSETS: "0" } });
await browserRegression("alighting comparison browser regression", "scripts/alighting-comparison-check.mjs", { env: { ...process.env, ALIGHTING_OUT: path.join(stageDir, "alighting-comparison"), ALIGHTING_PRODUCTION_ASSETS: "0" } });
await browserRegression("nearby loop overview browser regression", "scripts/nearby-loop-check.mjs", { env: { ...process.env, NEARBY_LOOP_OUT: path.join(stageDir, "nearby-loop"), NEARBY_LOOP_PRODUCTION_ASSETS: "0" } });
await browserRegression("recent GPS speed browser regression", "scripts/recent-speed-check.mjs", { env: { ...process.env, RECENT_SPEED_OUT: path.join(stageDir, "recent-speed"), RECENT_SPEED_PRODUCTION_ASSETS: "0" } });
await browserRegression("transfer options removal browser regression", "scripts/transfer-trip-check.mjs", { env: { ...process.env, TRANSFER_TRIP_OUT: path.join(stageDir, "transfer-trip"), TRANSFER_TRIP_PRODUCTION_ASSETS: "0" } });
await browserRegression("ordinary rider fallback browser regression", "scripts/rider-transfer-check.mjs", { env: { ...process.env, RIDER_TRANSFER_OUT: path.join(stageDir, "rider-transfer"), RIDER_TRANSFER_PRODUCTION_ASSETS: "0" } });
await browserRegression("feedback attachment browser regression", "scripts/feedback-accessibility-check.mjs");
await browserRegression("independent report action browser regression", "scripts/report-action-concurrency-check.mjs", { env: { ...process.env, REPORT_ACTIONS_PRODUCTION_ASSETS: "0", OUT: path.join(stageDir, "report-actions") } });
await browserRegression("destination arrival availability browser regression", "scripts/destination-availability-check.mjs", { env: { ...process.env, DESTINATION_AVAILABILITY_PRODUCTION_ASSETS: "0", DESTINATION_AVAILABILITY_OUT: path.join(stageDir, "destination-availability") } });
await browserRegression("feedback screen evidence browser regression", "scripts/feedback-screen-check.mjs", { env: { ...process.env, FEEDBACK_SCREEN_OUT: path.join(stageDir, "feedback-screen"), FEEDBACK_SCREEN_PRODUCTION_ASSETS: "0" } });
await browserRegression("individual bus reporting browser regression", "scripts/bus-reporting-check.mjs", { env: { ...process.env, BOT_OUT: path.join(stageDir, "bus-reporting") } });
await browserRegression("arrival estimate availability browser regression", "scripts/forecast-reporting-check.mjs", { env: { ...process.env, FORECAST_REPORTING_OUT: path.join(stageDir, "forecast-reporting"), FORECAST_REPORTING_PRODUCTION_ASSETS: "0" } });
await browserRegression("Winchester standing stop browser regression", "scripts/winchester-stand-check.mjs", { env: { ...process.env, BOT_OUT: path.join(stageDir, "winchester-stand") } });
await browserRegression("folded-line standing position browser regression", "scripts/folded-standing-check.mjs", { env: { ...process.env, BOT_OUT: path.join(stageDir, "folded-standing") } });
await browserRegression("ride arrival and recovery browser regression", "scripts/ride-recovery-check.mjs", { env: { ...process.env, OUT: path.join(stageDir, "ride-recovery") } });
await browserRegression("virtual rider completion browser regression", "scripts/rider-completion-check.mjs", { env: { ...process.env, BOT_OUT: path.join(stageDir, "rider-completion") } });
killStaging();

if (STAGE_ONLY) {
  log("stage-only run: all local stages green, skipping prod. ✓");
  cleanup();
  process.exit(0);
}

// A prebuilt release uses its exact digest after the same gates. Otherwise
// stamp the image with the commit it was built from, so /healthz and the
// scorecard (docs/closed-loop.md) can name the build. Deploys come from
// committed history, so HEAD is the truth here; "dev" is the Dockerfile's
// default when this is not passed.
let flyArgs;
if (DEPLOY_IMAGE) {
  flyArgs = ["deploy", "--image", DEPLOY_IMAGE];
} else {
  const buildSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const buildArgs = buildSha.status === 0 && /^[0-9a-f]{40}\s*$/.test(buildSha.stdout)
    ? ["--build-arg", `SHUTTLE_BUILD_SHA=${buildSha.stdout.trim()}`]
    : [];
  flyArgs = ["deploy", "--remote-only", ...buildArgs];
}
run("stage 5/6: deploy to Fly", FLYCTL, flyArgs);

log("stage 6/6: verify production");
await waitForHealthy(PROD_URL, 120_000);
await apiSmoke(PROD_URL);
await browserSmoke(PROD_URL, { markAsTest: true });
log("production verified. ✓");
cleanup();
