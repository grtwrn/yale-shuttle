#!/usr/bin/env node
// Screenshots of the berth MAP — and the one measurement a screenshot cannot
// make: that the page still scrolls when a finger lands on it.
//
//   BASE=http://127.0.0.1:8098 OUT=pr-preview/berth-map \
//     BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/berth-map-capture.mjs
//
// It drives `?review=berth&cell=<stopId>-<routeId>`, which renders the card's
// OWN component off the real `/api/buses` payload — reaching a berth through the
// app means planning a trip that happens to board at that stop on that line,
// which is ten different trips and a live fleet. Three shots per cell, because
// the operator asked for three different things (2026-09-11: "a real map area so
// I can see the street name and zoom out if needed"):
//
//   <cell>-initial.png     the opening view, capped at the static inset's scale
//   <cell>-zoomout.png     one step out, where the street names arrive
//   <cell>-fullscreen.png  the app's own expanded map, opened with ⤢
//
// And then the part that is a TEST, not a picture. A pannable map inside a
// scrolling card is a known phone trap: with `dragging` on, Leaflet's
// `leaflet-touch-drag` class sets `touch-action: none` and a rider dragging the
// page upward over the inset pans the map instead — the page stops dead. So this
// dispatches real CDP touch sequences and measures `window.scrollY`:
//
//   inert  → a swipe that starts ON the map must SCROLL THE PAGE and must not
//            move the map's centre
//   armed  → the same swipe must move the map's centre and must not scroll
//
// A failure of either is a non-zero exit, and the numbers go in `capture.json`
// beside the PNGs so the PR quotes a measurement rather than a claim.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

import { seedTestId } from "./testId.mjs";

const BASE = (process.env.BASE ?? "http://127.0.0.1:8098").replace(/\/$/, "");
const OUT = process.env.OUT ?? "/tmp/berth-map";
/** Default pair: the operator's two — Blue Night at Wall/York, Red at Division/Prospect. */
const CELLS = (process.env.CELLS ?? "67-13,48-3").split(",").map((s) => s.trim()).filter(Boolean);
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
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));

/**
 * A real touch drag, through CDP. Playwright's touchscreen only taps, and the
 * whole question here is what a DRAG does — so the sequence is dispatched by
 * hand, with enough intermediate moves that the browser treats it as a scroll
 * gesture rather than a jump.
 */
async function swipe(cdp, x, y, dy, steps = 10) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / steps }] });
    await sleep(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(400);
}

/** Where the map is on screen, and where its centre currently points. */
const mapState = () => page.evaluate(() => {
  const el = document.querySelector(".berth-map-wrap .leaflet-container");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const tp = el.querySelector(".leaflet-map-pane");
  return {
    box: { x: r.x, y: r.y, w: r.width, h: r.height },
    // The map pane's own transform IS the pan: reading it needs no Leaflet
    // handle, and it moves if and only if the map moved.
    pane: tp ? getComputedStyle(tp).transform : "",
    touchAction: getComputedStyle(el).touchAction,
    classes: el.className,
    scrollY: window.scrollY,
    pageH: document.documentElement.scrollHeight,
  };
});

const shot = async (name) => {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
};

const report = { base: BASE, cells: [], scroll: null, errors: [] };
let bad = [];

for (const cell of CELLS) {
  await page.goto(`${BASE}/?review=berth&cell=${cell}`, { waitUntil: "domcontentloaded" });
  // Tiles come off openstreetmap.org; give them time or the shot is grey.
  await page.locator(".berth-map-wrap .leaflet-container").waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelectorAll(".leaflet-tile-loaded").length >= 2,
    null, { timeout: 30_000 },
  ).catch(() => {});
  await sleep(2500);

  const files = { initial: await shot(`${cell}-initial`) };
  const before = await mapState();

  // One step out — the operator's "zoom out if needed", and the step at which
  // OSM starts naming the cross streets.
  await page.locator(".berth-map-wrap .leaflet-control-zoom-out").click({ timeout: 10_000 });
  await sleep(3000);
  files.zoomout = await shot(`${cell}-zoomout`);

  await page.locator(".berth-map-wrap .leaflet-control-zoom-in").click({ timeout: 10_000 });
  await sleep(2000);

  // The app's own expanded map, opened with ⤢ and closed with Escape.
  await page.getByRole("button", { name: "Full map" }).click({ timeout: 10_000 });
  await sleep(3000);
  files.fullscreen = await shot(`${cell}-fullscreen`);
  const fs2 = await mapState();
  const wentFullscreen = !!fs2 && fs2.box.h > 700;
  const hasBack = await page.getByRole("button", { name: "Back" }).isVisible().catch(() => false);
  await page.keyboard.press("Escape");
  await sleep(1500);
  const closed = !(await page.getByRole("button", { name: "Back" }).isVisible().catch(() => false));

  if (!wentFullscreen) bad.push(`${cell}: ⤢ did not fill the viewport (h=${fs2?.box.h})`);
  if (!hasBack) bad.push(`${cell}: no Back button in fullscreen`);
  if (!closed) bad.push(`${cell}: Escape did not close fullscreen`);

  // The canary reads the expanded card as TEXT, and a Leaflet tooltip lands in
  // `innerText` exactly as an SVG <text> did. So the capture is dumped here and
  // spliced into the fixture in `scripts/canary-metrics.test.mjs` — #111
  // "needed no change" too, and blinded the canary for twelve minutes.
  fs.writeFileSync(path.join(OUT, `${cell}-innertext.txt`),
    await page.evaluate(() => document.body.innerText));

  report.cells.push({
    cell, files,
    inertTouchAction: before?.touchAction,
    inertClasses: before?.classes,
    fullscreenHeight: fs2?.box.h,
    back: hasBack,
    escapeClosed: closed,
  });
  // eslint-disable-next-line no-console
  console.log(`${cell}: initial + zoomout + fullscreen captured (touch-action inert: ${before?.touchAction})`);
}

// ── The scroll measurement ───────────────────────────────────────────────────
// Done on the app itself, not the review page: the trap only exists inside a
// page tall enough to scroll, and the card is where the rider meets it. The
// review page is one cell tall, so a spacer is added to give the document
// somewhere to go — the map's own behaviour is what is under test, not the
// page's height.
await page.goto(`${BASE}/?review=berth&cell=${CELLS[0]}`, { waitUntil: "domcontentloaded" });
await page.locator(".berth-map-wrap .leaflet-container").waitFor({ timeout: 30_000 });
await sleep(3000);
await page.evaluate(() => {
  const pad = document.createElement("div");
  pad.style.height = "1600px";
  document.body.appendChild(pad);
});
const cdp = await ctx.newCDPSession(page);
const scroll = {};

{
  const s = await mapState();
  const cx = Math.round(s.box.x + s.box.w / 2), cy = Math.round(s.box.y + s.box.h / 2);
  // Inert: a swipe up from the middle of the map must take the PAGE with it.
  await swipe(cdp, cx, cy, -220);
  const after = await mapState();
  scroll.inert = {
    touchAction: s.touchAction,
    classes: s.classes,
    scrollY: [s.scrollY, after.scrollY],
    panMoved: s.pane !== after.pane,
  };
  if (!(after.scrollY > s.scrollY + 40)) bad.push(`inert swipe did not scroll the page (${s.scrollY} -> ${after.scrollY})`);
  if (s.pane !== after.pane) bad.push("inert swipe panned the map");
  if (s.touchAction === "none") bad.push(`inert map has touch-action: none (${s.classes})`);
}

{
  // Armed: one tap, then the same swipe must pan the map and leave the page put.
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  const s0 = await mapState();
  await page.getByRole("button", { name: /Tap the map to zoom and pan/ }).click({ timeout: 10_000 });
  await sleep(800);
  const s = await mapState();
  const cx = Math.round(s.box.x + s.box.w / 2), cy = Math.round(s.box.y + s.box.h / 2);
  await swipe(cdp, cx, cy, -220);
  const after = await mapState();
  scroll.armed = {
    touchAction: s.touchAction,
    classes: s.classes,
    scrollY: [s.scrollY, after.scrollY],
    panMoved: s.pane !== after.pane,
    inertTouchActionBefore: s0.touchAction,
  };
  if (s.pane === after.pane) bad.push("armed swipe did not pan the map");
  if (after.scrollY > s.scrollY + 10) bad.push(`armed swipe scrolled the page (${s.scrollY} -> ${after.scrollY})`);

  // And the way back: a tap outside must make it inert again.
  await page.mouse.click(10, 10);
  await sleep(600);
  const off = await mapState();
  scroll.disarmedByOutsideTap = off.touchAction !== "none" && !/leaflet-touch-drag/.test(off.classes);
  if (!scroll.disarmedByOutsideTap) bad.push(`a tap outside did not disarm the map (${off.classes} / ${off.touchAction})`);
}

report.scroll = scroll;
report.errors = errors;
if (errors.length) bad.push(`page errors: ${errors.slice(0, 3).join(" | ")}`);
report.ok = bad.length === 0;
report.failures = bad;
fs.writeFileSync(path.join(OUT, "capture.json"), JSON.stringify(report, null, 2));
// eslint-disable-next-line no-console
console.log(JSON.stringify({ ok: report.ok, failures: bad, scroll }, null, 2));

await ctx.close();
await browser.close();
process.exit(bad.length ? 1 : 0);
