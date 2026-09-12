#!/usr/bin/env node
// Does the berth map actually GO when the card collapses?
//
//   BASE=http://127.0.0.1:8098 OUT=pr-preview/berth-map \
//     BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/berth-teardown-check.mjs
//
// The whole licence for putting a Leaflet instance inside a card is that there
// is only ever one and that it is destroyed on collapse (`routeThumb.ts`
// refuses fifteen for exactly the costs a leaked one would keep paying: its
// DOM panes, its tile requests, its listeners). That claim is not observable
// from a screenshot and it is not observable from the source either — React
// calling the cleanup is one thing, `map.remove()` having actually finished is
// another. So it is measured, over TWO full cycles, on `?review=berth`, whose
// Collapse/Expand button drives the same mount and unmount `expandedKey` does
// in the card and where the page holds no other map to confuse the count:
//
//   after each collapse   `.leaflet-container` count           expect 0
//                         tile.openstreetmap.org requests in   expect 0
//                         the next 5 s
//                         new console errors                   expect 0
//   after each expand     `.leaflet-container` count           expect 1
//   after the SECOND      total `.leaflet-container` count     expect 1, not 2
//   expand                                                     — i.e. no leak
//
// The exact sequence the two cycles produce is
//   mount -> collapse (measure) -> expand (measure)
//         -> collapse (measure) -> expand (measure) -> total
// so both collapses and both re-expands are recorded, and the run ends
// EXPANDED, which is the state a leak would show in: two containers, not one.
//
// Writes `teardown.json` and exits non-zero if any expectation misses.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

import { seedTestId } from "./testId.mjs";

const BASE = (process.env.BASE ?? "http://127.0.0.1:8098").replace(/\/$/, "");
const OUT = process.env.OUT ?? "/tmp/berth-map";
const CELL = process.env.CELL ?? "48-3";
/** How long to keep watching for a tile request a dead map might still make. */
const QUIET_MS = Number(process.env.QUIET_MS ?? 5000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  timezoneId: "America/New_York",
  hasTouch: true,
  isMobile: true,
});
await seedTestId(ctx);
const page = await ctx.newPage();

/** Every tile request, with the instant it was made, so a window can be counted. */
const tiles = [];
page.on("request", (r) => {
  if (r.url().includes("tile.openstreetmap.org")) tiles.push(Date.now());
});
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 200)}`));

const containers = () => page.evaluate(() => document.querySelectorAll(".leaflet-container").length);
const tilesSince = (t) => tiles.filter((x) => x >= t).length;
const toggle = async () => {
  await page.locator('[data-toggle="card"]').click({ timeout: 10_000 });
};

/**
 * Since 2026-09-11 the map lives one fold deeper: the card expands to a folded
 * row, and the ⚠ toggle is what mounts it. So the sequence is card-expand ->
 * fold-open, and there is a new thing to check on the way — an expanded card
 * whose fold is SHUT must carry no map either.
 */
const openFold = async () => {
  await page.locator("button[aria-expanded]").click({ timeout: 10_000 });
  await page.locator(".berth-map-wrap .leaflet-container").waitFor({ timeout: 30_000 });
  await sleep(3000);
};

await page.goto(`${BASE}/?review=berth&cell=${CELL}`, { waitUntil: "domcontentloaded" });
await page.locator("button[aria-expanded]").waitFor({ timeout: 30_000 });
await sleep(800);
const foldedContainers = await containers();
if (foldedContainers !== 0) bad.push(`${foldedContainers} .leaflet-container with the fold shut, expected 0`);
await openFold();

const cycles = [];
const bad = [];
for (const n of [1, 2]) {
  // ── collapse ──────────────────────────────────────────────────────────────
  const errsBefore = consoleErrors.length;
  const t0 = Date.now();
  await toggle();
  await sleep(500);
  const afterCollapse = await containers();
  // Watch for QUIET_MS: a map that was removed but kept a running _update (a
  // pending tile load, a retained pane) would ask for tiles in this window.
  await sleep(QUIET_MS);
  const tilesAfterCollapse = tilesSince(t0 + 500);
  const errsAfterCollapse = consoleErrors.length - errsBefore;

  // ── expand again ──────────────────────────────────────────────────────────
  await toggle();
  await openFold();
  const afterExpand = await containers();

  cycles.push({
    cycle: n,
    afterCollapse: { leafletContainers: afterCollapse, tileRequestsInNext5s: tilesAfterCollapse, consoleErrors: errsAfterCollapse },
    afterExpand: { leafletContainers: afterExpand },
  });
  if (afterCollapse !== 0) bad.push(`cycle ${n}: ${afterCollapse} .leaflet-container left after collapse`);
  if (tilesAfterCollapse !== 0) bad.push(`cycle ${n}: ${tilesAfterCollapse} tile requests in the ${QUIET_MS} ms after collapse`);
  if (errsAfterCollapse !== 0) bad.push(`cycle ${n}: ${errsAfterCollapse} console errors around the collapse`);
  if (afterExpand !== 1) bad.push(`cycle ${n}: ${afterExpand} .leaflet-container after expand, expected 1`);
  // eslint-disable-next-line no-console
  console.log(`cycle ${n}: collapse -> ${afterCollapse} containers, ${tilesAfterCollapse} tiles/${QUIET_MS}ms, ${errsAfterCollapse} errors; expand -> ${afterExpand}`);
}

const finalContainers = await containers();
if (finalContainers !== 1) bad.push(`after the second expand there are ${finalContainers} .leaflet-container, expected 1`);

const report = {
  base: BASE, cell: CELL, quietMs: QUIET_MS,
  foldedContainers,
  cycles,
  afterSecondExpand: { leafletContainers: finalContainers },
  totalTileRequests: tiles.length,
  consoleErrors,
  ok: bad.length === 0,
  failures: bad,
};
fs.writeFileSync(path.join(OUT, "teardown.json"), JSON.stringify(report, null, 2));
// eslint-disable-next-line no-console
console.log(JSON.stringify({ ok: report.ok, failures: bad, afterSecondExpand: finalContainers, consoleErrors }, null, 2));

await ctx.close();
await browser.close();
process.exit(bad.length ? 1 : 0);
