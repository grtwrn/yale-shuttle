// The route schedule (ROUTE_HOURS) is published Eastern Time, but the client
// used to read it with getDay()/getHours() — the DEVICE's timezone. A phone on
// UTC (or a visitor still on their home zone) mapped ET afternoon into the
// overnight window, so every weekday route was judged out of service and the
// app claimed "No shuttles running right now" while shuttles were running.
//
// Loads the LOCAL build under several device timezones and asserts the running
// shuttle count agrees with America/New_York. Serves web/dist and proxies
// /api/* to prod so the bus data is real.
//
// Run: BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/timezone-check.mjs
import { chromium } from "playwright-core";

import { seedTestId } from "./testId.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");
const UPSTREAM = process.env.BOT_BASE_URL ?? "https://yale-shuttle.fly.dev";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const ZONES = ["America/New_York", "UTC", "Europe/London", "Asia/Tokyo", "America/Los_Angeles"];

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    try {
      const r = await fetch(UPSTREAM + req.url);
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      return res.end(body);
    } catch { res.writeHead(502); return res.end("{}"); }
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

const results = [];
for (const tz of ZONES) {
  const ctx = await browser.newContext({
    timezoneId: tz,
    permissions: ["geolocation"],
    geolocation: { latitude: 41.3163, longitude: -72.9223 },
    viewport: { width: 390, height: 844 },
  });
await seedTestId(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 5000));
  const text = await page.evaluate(() => document.body.innerText);
  // The app renders "N shuttles running" (or the asleep state) on the All tab.
  const m = text.match(/(\d+)\s+shuttles?\s+running/i);
  const asleep = /No shuttles running right now/i.test(text) || /😴/.test(text);
  results.push({ tz, running: m ? Number(m[1]) : null, asleep, errors: errors.length });
  await ctx.close();
}
await browser.close();
server.close();

const base = results[0];
console.log(`baseline ${base.tz}: running=${base.running} asleep=${base.asleep}`);
let ok = true;
for (const r of results) {
  const agree = r.asleep === base.asleep && r.running === base.running;
  if (!agree || r.errors) ok = false;
  console.log(`  ${r.tz.padEnd(20)} running=${String(r.running).padEnd(5)} asleep=${String(r.asleep).padEnd(5)} errors=${r.errors} ${agree ? "✓" : "✗ DISAGREES"}`);
}
console.log(ok
  ? "RESULT: PASS — service state is identical across device timezones"
  : "RESULT: FAIL — device timezone still changes what riders see");
