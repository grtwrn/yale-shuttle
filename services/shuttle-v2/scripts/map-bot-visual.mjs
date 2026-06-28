#!/usr/bin/env node
// map-bot-visual.mjs — the VISUAL half of the end-to-end map test.
//
// Drives the real live site in a real browser like a rider would: enters a
// random origin/destination, lets the planner run, screenshots the map + plan,
// then watches the recommended bus physically approach its board stop by
// re-screenshotting over a few minutes. The screenshots are meant to be read
// back by a human or by the scheduled Claude agent (whose Read tool renders
// PNGs) to judge whether the map actually "looks good".
//
// It gets its random trip + ground-truth plan + which-bus-to-watch by running
// scripts/map-bot.mjs as a child, so the two halves can never disagree.
//
// Runs anywhere with a Playwright-drivable chromium:
//   - On this arm64 Pi:  npm i playwright-core  then run with
//     BOT_CHROMIUM_PATH=/usr/bin/chromium (system chromium; Playwright ships no
//     bundled browser for arm64). Note: the legacy `chromium --dump-dom/--screenshot`
//     one-shot CLI hangs here, but CDP automation (what Playwright uses) works.
//   - In the cloud (x86):  npm i playwright && npx playwright install chromium
//     (leave BOT_CHROMIUM_PATH unset to use the bundled browser).
//
// Env: BOT_BASE_URL (default prod), BOT_SEED, BOT_PREFER_SHUTTLE (passed through
//      to map-bot.mjs), BOT_WATCH_CYCLES (default 3), BOT_WATCH_INTERVAL_MS
//      (default 60000), BOT_OUT (artifact dir; default scripts/.bot-artifacts).
//
// Output: a directory of PNGs + meta.json, and a <BOT_VISUAL> JSON line on
// stdout pointing at them. Exit 1 if the page crashed or no screenshot was
// captured (i.e. the map is visibly broken).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pick the chromium binary: explicit override wins, else the system chromium on
// this arm64 Pi (Playwright ships no bundled browser here), else undefined so
// Playwright uses its bundled chromium (the x86 cloud case). Zero-config in both.
const CHROMIUM = process.env.BOT_CHROMIUM_PATH
  || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BASE = (process.env.BOT_BASE_URL || "https://yale-shuttle.fly.dev").replace(/\/$/, "");
const CYCLES = parseInt(process.env.BOT_WATCH_CYCLES || "3", 10);
const INTERVAL = parseInt(process.env.BOT_WATCH_INTERVAL_MS || "60000", 10);

const haversineM = (a, b) => {
  const R = 6371000, r = (d) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Get the trip + ground truth by running the deterministic half.
function runMapBot() {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [join(HERE, "map-bot.mjs")], {
      env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      const m = out.match(/<BOT_RESULT>(.*)<\/BOT_RESULT>/);
      if (!m) return rej(new Error("map-bot produced no BOT_RESULT"));
      res(JSON.parse(m[1]));
    });
    p.on("error", rej);
  });
}

// Type the destination coord into the "where do you want to go" box and accept
// the top geocode suggestion. The ORIGIN is not typed — the app starts from
// "current location", which we set via the browser's geolocation (see context).
async function enterDestination(page, text) {
  const input = page.getByPlaceholder(/where do you want to go/i).first();
  await input.click({ timeout: 8000 });
  await input.fill("");
  await input.type(text, { delay: 20 });
  // Wait for the debounced #to-suggestions list, but don't hard-fail: pressing
  // Enter also kicks the geocode + picks the top hit.
  await page.locator('#to-suggestions li, #to-suggestions [role="option"]')
    .first().waitFor({ timeout: 5000 }).catch(() => {});
  await sleep(500);
  await input.press("Enter");
  await sleep(1000);
}

async function main() {
  const trip = await runMapBot();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(process.env.BOT_OUT || join(HERE, ".bot-artifacts"), `run-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const shots = [];
  const consoleErrors = [];
  let pageCrashed = false;

  // Prefer playwright-core (driver only) and the system chromium when present —
  // this Pi is arm64, where Playwright ships no bundled chromium, but
  // /usr/bin/chromium drives fine over CDP. In the cloud (x86) leave
  // BOT_CHROMIUM_PATH unset and install the full `playwright` package instead.
  const { chromium } = await import("playwright-core").catch(() => import("playwright"));
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  // Put the rider AT trip.from: the app uses the browser's geolocation as the
  // trip origin ("current location"), so we grant it and only type a destination.
  const context = await browser.newContext({
    viewport: { width: 430, height: 880 }, // iPhone-ish
    geolocation: { latitude: trip.trip.from.lat, longitude: trip.trip.from.lon },
    permissions: ["geolocation"],
  });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => { pageCrashed = true; consoleErrors.push(`PAGEERROR: ${e.message}`); });

  const shot = async (name) => {
    const file = join(outDir, name);
    await page.screenshot({ path: file, fullPage: true }).catch((e) => consoleErrors.push(`shot ${name}: ${e.message}`));
    shots.push(file);
    return file;
  };

  try {
    // The SPA polls /api/buses and holds an SSE stream open, so networkidle
    // never fires — use domcontentloaded + a fixed hydrate wait.
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(3000);
    // Default view is "trip"; click the tab defensively in case state persisted.
    await page.getByRole("button", { name: /^trip$/i }).click({ timeout: 3000 }).catch(() => {});
    await shot("00-loaded.png");

    await enterDestination(page, trip.uiSearch.to);
    await sleep(3500); // let the planner compute the options
    await shot("01-plan.png");

    // Switch to the geographic Map tab so the bus markers + route are visible.
    await page.getByRole("button", { name: /^map$/i }).click({ timeout: 3000 }).catch(() => {});
    await sleep(2500);
    await shot("01b-map.png");

    // 2. Watch the recommended bus approach its board stop.
    const approach = [];
    if (trip.watch && trip.watch.busSeenLive) {
      const board = trip.watch.boardCoord;
      for (let i = 0; i < CYCLES; i++) {
        await sleep(INTERVAL);
        let dist = null;
        try {
          const buses = await (await fetch(`${BASE}/api/buses`)).json();
          const b = (buses.buses || []).find((x) => x.bus_name === trip.watch.busName);
          if (b && board) dist = Math.round(haversineM(b, board));
        } catch { /* keep going */ }
        approach.push({ cycle: i + 1, busDistToBoardM: dist });
        await shot(`02-watch-${i + 1}.png`);
      }
    }

    const meta = {
      base: BASE, capturedAt: stamp, status: trip.status,
      trip: trip.trip, uiSearch: trip.uiSearch, recommended: trip.recommended,
      watch: trip.watch, approach,
      pageCrashed, consoleErrors, shots,
      // For the agent: distance should shrink across cycles if the bus is
      // genuinely approaching. Flat/growing distance is worth a look, not
      // necessarily a bug (bus may be mid-loop or heading away first).
    };
    writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
    process.stdout.write(`<BOT_VISUAL>${JSON.stringify({ outDir, shots, status: trip.status, pageCrashed, consoleErrors: consoleErrors.length, approach })}</BOT_VISUAL>\n`);

    const ok = shots.length > 0 && !pageCrashed;
    process.stderr.write(`\n🖼  visual run ${ok ? "OK" : "PROBLEM"} — ${shots.length} shots in ${outDir}\n`);
    if (approach.length) process.stderr.write(`    bus “${trip.watch.busName}” dist: ${approach.map((a) => a.busDistToBoardM).join(" → ")} m\n`);
    if (consoleErrors.length) process.stderr.write(`    ⚠️ ${consoleErrors.length} console/page error(s)\n`);
    await browser.close();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    await shot("99-error.png").catch(() => {});
    writeFileSync(join(outDir, "meta.json"), JSON.stringify({ base: BASE, fatal: String(e), shots, consoleErrors }, null, 2));
    process.stdout.write(`<BOT_VISUAL>${JSON.stringify({ outDir, shots, fatal: String(e) })}</BOT_VISUAL>\n`);
    process.stderr.write(`map-bot-visual fatal: ${e.stack || e}\n`);
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

main().catch((e) => { process.stderr.write(`fatal: ${e.stack || e}\n`); process.exit(2); });
