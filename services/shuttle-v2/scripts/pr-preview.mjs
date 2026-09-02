#!/usr/bin/env node
// pr-preview: screenshot a feature so a PR can be judged by eye before merge.
//
// Runs against an already-staged build (deploy.mjs-style: the PR's server on a
// spare port with a throwaway DB) and drives the real bundle in headless
// chromium, exactly as a rider would see it on a phone. Features that depend
// on the world (rain in the forecast, an announcement, a bus at a stop) are
// made visible by MOCKING the API responses the feature reads — the recipe
// says which.
//
//   BASE=http://127.0.0.1:8096 RECIPE=pr-preview.json OUT=/tmp/shots \
//     BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/pr-preview.mjs
//
// Recipe (all optional; a missing recipe screenshots a live trip + the map):
//   {
//     "caption": "Rain line under the trip options",
//     "mock":  { "/api/weather": { "available": true, "hourly": [{ "timeMs": "${now}", "probability": 80 }] } },
//     "trip":  { "board": 118, "dest": 38 },          // stop ids; default = two stops of a live route
//     "views": ["trip", "map"],                       // any of trip | map | favorites | issues
//     "focus": "Rain likely"                          // text to scroll into view before the shot
//   }
// Screenshots are full-page (the trip view is taller than a phone), so a line
// under the options list is captured even when it sits below the fold.
// Mock values may use "${now}" / "${now+3600000}" (epoch ms) so forecasts and
// timestamps land in the present regardless of when the preview runs.
//
// Output: <OUT>/<view>.png plus <OUT>/preview.json (caption, views, page errors).
// Exit 1 on a page error or a crashed shell — a preview of a crash is a finding.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { seedTestId } from "./testId.mjs";

const BASE = (process.env.BASE ?? process.env.BOT_BASE_URL ?? "http://127.0.0.1:8093").replace(/\/$/, "");
const OUT = process.env.OUT ?? "/tmp/pr-preview";
const recipe = process.env.RECIPE && fs.existsSync(process.env.RECIPE)
  ? JSON.parse(fs.readFileSync(process.env.RECIPE, "utf8"))
  : {};
const views = Array.isArray(recipe.views) && recipe.views.length ? recipe.views : ["trip", "map"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "${now+60000}" -> epoch ms; applied recursively through the mock payloads.
const NOW = Date.now();
function materialise(v) {
  if (typeof v === "string") {
    const m = v.match(/^\$\{now([+-]\d+)?\}$/);
    if (m) return NOW + (m[1] ? Number(m[1]) : 0);
    return v;
  }
  if (Array.isArray(v)) return v.map(materialise);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, materialise(x)]));
  return v;
}
const mocks = materialise(recipe.mock ?? {});

// Pick the trip: the recipe's stops, else two stops of a route with a live bus.
const payload = await (await fetch(`${BASE}/api/buses`)).json();
const coords = payload.stop_coords;
let trip = recipe.trip;
if (!trip || !coords[trip.board] || !coords[trip.dest]) {
  const live = payload.buses[0];
  const rid = live ? String(live.route_id) : Object.keys(payload.routes)[0];
  const stops = payload.routes[rid].filter((s) => coords[s]);
  trip = { board: stops[Math.floor(stops.length * 0.3)], dest: stops[Math.floor(stops.length * 0.7)] };
}
const board = coords[trip.board], dest = coords[trip.dest];

const browser = process.env.BOT_CDP_URL
  ? await chromium.connectOverCDP(process.env.BOT_CDP_URL)
  : await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({
  permissions: ["geolocation"],
  geolocation: { latitude: board.lat, longitude: board.lon },
  timezoneId: "America/New_York",
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
await seedTestId(ctx);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
for (const [pathname, body] of Object.entries(mocks)) {
  await page.route((u) => u.pathname === pathname, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

fs.mkdirSync(OUT, { recursive: true });
const taken = [];
const failedViews = [];
async function shot(name) {
  const file = path.join(OUT, `${name}.png`);
  if (typeof recipe.focus === "string" && recipe.focus) {
    await page.getByText(recipe.focus, { exact: false }).first()
      .scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  }
  await page.screenshot({ path: file, fullPage: true });
  taken.push(file);
}
async function openTab(label) {
  const tab = page.getByRole("button", { name: new RegExp(`^\\s*(\\S+\\s+)?${label}\\s*$`, "i") }).first();
  await tab.click({ timeout: 10_000 });
  await sleep(1500);
}

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await sleep(4000);
for (const view of views) {
  try {
    if (view === "trip") {
      await openTab("Trip").catch(() => {});
      const input = page.getByPlaceholder(/where do you want to go/i).first();
      await input.click({ timeout: 20_000 });
      await input.fill("");
      await input.type(`${dest.lat},${dest.lon}`, { delay: 20 });
      await sleep(1500);
      await input.press("Enter");
      await sleep(4000);
    } else {
      await openTab(view[0].toUpperCase() + view.slice(1));
      await sleep(view === "map" ? 3000 : 500);
    }
    await shot(view);
  } catch (e) {
    // A view that never opened is a FAILED preview, not a preview of a
    // failure: PR #7 shipped a `trip-failed.png` embedded as if it were the
    // feature, and the operator had to catch it. Recorded and, below, made
    // fatal — a screenshot nobody can trust is worse than none.
    console.error(`view ${view}: ${e.message}`);
    failedViews.push({ view, error: String(e.message).slice(0, 300) });
    await shot(`${view}-failed`).catch(() => {});
  }
}
const body = await page.evaluate(() => document.body.innerText).catch(() => "");
const crashed = body.includes("App crashed");
fs.writeFileSync(path.join(OUT, "preview.json"), JSON.stringify({
  caption: recipe.caption ?? null, base: BASE, trip, views, mocked: Object.keys(mocks),
  shots: taken, failedViews, pageErrors, crashed,
}, null, 2));
console.log(`preview: ${taken.length} screenshot(s) in ${OUT}` + (recipe.caption ? ` — ${recipe.caption}` : ""));
if (pageErrors.length || crashed) { console.error(`PAGE ERRORS: ${pageErrors.join(" | ")}${crashed ? " (App crashed)" : ""}`); }
if (failedViews.length) {
  console.error(`VIEWS THAT NEVER OPENED: ${failedViews.map((f) => `${f.view} (${f.error})`).join(" | ")}`);
}
await ctx.close();
await browser.close();
process.exit(pageErrors.length || crashed || failedViews.length ? 1 : 0);
