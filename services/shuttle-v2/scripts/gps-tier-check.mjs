// Verifies the GPS accuracy-tier fix: a rider on the default "trip" view
// (i.e. planning / walking to the pickup stop) must get a high-accuracy
// watchPosition, not the coarse maximumAge:60_000 tier that froze their dot
// (reports #36, #39, #43, #44).
//
// Serves the local web/dist build and proxies /api/* to prod so the app is
// fully functional, then instruments navigator.geolocation before any app
// code runs and reports every watchPosition registration it makes.
//
// Run: BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/gps-tier-check.mjs
import { chromium } from "playwright-core";

import { seedTestId } from "./testId.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");
const UPSTREAM = "https://yale-shuttle.fly.dev";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    try {
      const r = await fetch(UPSTREAM + req.url);
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      return res.end(body);
    } catch {
      res.writeHead(502); return res.end("{}");
    }
  }
  const rel = req.url.split("?")[0];
  const file = path.join(DIST, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file)) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(fs.readFileSync(path.join(DIST, "index.html")));
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({
  permissions: ["geolocation"],
  geolocation: { latitude: 41.3163, longitude: -72.9223 },
  viewport: { width: 390, height: 844 },
});
await seedTestId(ctx);

// Instrument BEFORE app code runs.
await ctx.addInitScript(() => {
  window.__gpsCalls = [];
  const realWatch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
  const realClear = navigator.geolocation.clearWatch.bind(navigator.geolocation);
  navigator.geolocation.watchPosition = (ok, err, opts) => {
    const id = realWatch(ok, err, opts);
    window.__gpsCalls.push({ action: "watch", id, opts: { ...opts } });
    return id;
  };
  navigator.geolocation.clearWatch = (id) => {
    window.__gpsCalls.push({ action: "clear", id });
    return realClear(id);
  };
});

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
// TARGET=prod probes the deployed build instead of the local one — handy for
// confirming a fix actually changed behaviour rather than passing vacuously.
const target = process.env.TARGET === "prod" ? UPSTREAM : `http://localhost:${port}/`;
console.log(`target: ${target}`);
await page.goto(target, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);

const calls = await page.evaluate(() => window.__gpsCalls);
const view = await page.evaluate(() => localStorage.getItem("listView"));

console.log(`listView at mount: ${view}`);
console.log(`page errors: ${errors.length}${errors.length ? " -> " + errors.join(" | ") : ""}`);
console.log("geolocation call sequence:");
for (const c of calls) {
  console.log(
    c.action === "clear"
      ? `  clear  id=${c.id}`
      : `  watch  id=${c.id}  highAccuracy=${c.opts.enableHighAccuracy} maximumAge=${c.opts.maximumAge}`,
  );
}

const watches = calls.filter((c) => c.action === "watch");
const live = watches.filter((w) => !calls.some((c) => c.action === "clear" && c.id === w.id));
console.log(`\nwatches started: ${watches.length}, still live: ${live.length}`);
const coarse = live.filter((w) => w.opts.enableHighAccuracy === false);
if (errors.length) console.log("RESULT: FAIL — page errors");
else if (live.length !== 1) console.log(`RESULT: FAIL — expected exactly 1 live watch, got ${live.length}`);
else if (coarse.length) console.log("RESULT: FAIL — live watch is the coarse tier (the bug)");
else console.log("RESULT: PASS — single live high-accuracy watch on the trip view");

await browser.close();
server.close();
