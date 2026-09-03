// Measures how accurate the app's arrival prediction actually is, for a real
// trip: Prospect/Canner (stop 100) -> Chapel/Church on the New Haven Green
// (stop 30), ~2.2 km, served by Blue Day (route 1) / Blue Weekend (route 4).
//
// Two independent channels, deliberately not sharing any math:
//
//   PREDICTION  a real browser sits on the live site with geolocation at
//               Prospect/Canner and that destination entered, and we scrape the
//               ETA the rider is actually shown. This exercises the CLIENT-side
//               planner, which is what riders see -- not /api/plan.
//
//   GROUND TRUTH  a parallel 5 s poll of /api/buses watches raw bus positions
//               and records the instant a bus first comes within ARRIVAL_M of
//               each stop. Nothing here reads the app's own ETA.
//
// Error = (moment the prediction was made + predicted minutes) - actual arrival.
// Positive error = the app was PESSIMISTIC (bus came sooner than promised).
//
// Run: BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/eta-accuracy.mjs
// Env: RUN_MIN (default 35), BOT_BASE_URL
import { chromium } from "playwright-core";

import { seedTestId } from "./testId.mjs";
import fs from "node:fs";

const BASE = process.env.BOT_BASE_URL ?? "https://yale-shuttle.fly.dev";
const RUN_MS = (Number(process.env.RUN_MIN) || 35) * 60_000;
// Defaults are the daytime Blue trip; override with BOARD_ID / DEST_ID /
// ROUTES (comma-separated route ids) to score another line — e.g. Blue Night:
//   BOARD_ID=97 DEST_ID=121 ROUTES=13 node scripts/eta-accuracy.mjs
const STOPS = await (await fetch(`${BASE}/api/buses`)).json();
const stopAt = (id, fallback) => {
  const c = STOPS.stop_coords?.[id];
  return c ? { id, name: STOPS.stop_names?.[id] ?? String(id), lat: c.lat, lon: c.lon } : fallback;
};
const BOARD = stopAt(Number(process.env.BOARD_ID) || 100, { id: 100, name: "Prospect / Canner", lat: 41.32535, lon: -72.92289 });
const DEST  = stopAt(Number(process.env.DEST_ID) || 30, { id: 30,  name: "Chapel / Church",   lat: 41.30596, lon: -72.92546 });
const ROUTES = (process.env.ROUTES ?? "1,4").split(",").map(Number);
// Score only the option on this line (its rendered label, e.g. "Blue Night").
// Without it the fastest shuttle option is scored, which may board a
// different stop on a different route than the arrivals being watched.
const ROUTE_LABEL = process.env.ROUTE_LABEL ?? null;
const ARRIVAL_M = 45;      // how close counts as "at the stop"
const REARM_M = 120;       // must leave this far before a second arrival counts
const POLL_MS = 5_000;
const SCRAPE_MS = 20_000;
const OUT = process.env.OUT ?? "/tmp/eta-accuracy.json";

const hav = (a, b) => {
  const R = 6371000, t = (x) => (x * Math.PI) / 180;
  const dp = t(b.lat - a.lat), dl = t(b.lon - a.lon);
  const q = Math.sin(dp / 2) ** 2 +
    Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (ms) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });

const predictions = [];   // { at, waitMin, totalMin, arriveText, busName }
const arrivals = [];      // { stopId, busName, at }
const near = new Map();   // `${busId}@${stopId}` -> currently inside the radius
const log = [];
const say = (s) => { const line = `[${clock(Date.now())}] ${s}`; console.log(line); log.push(line); };

// ---- ground truth ---------------------------------------------------------
async function pollOnce() {
  const r = await fetch(`${BASE}/api/buses`);
  const d = await r.json();
  const now = Date.now();
  for (const b of d.buses ?? []) {
    if (!ROUTES.includes(b.route_id)) continue;
    for (const stop of [BOARD, DEST]) {
      const key = `${b.bus_id}@${stop.id}`;
      const dist = hav({ lat: b.lat, lon: b.lon }, stop);
      const wasNear = near.get(key) ?? false;
      if (!wasNear && dist <= ARRIVAL_M) {
        near.set(key, true);
        arrivals.push({ stopId: stop.id, stopName: stop.name, busName: b.bus_name, at: now, dist: Math.round(dist) });
        say(`ARRIVAL  ${b.bus_name} reached ${stop.name} (${Math.round(dist)} m)`);
      } else if (wasNear && dist > REARM_M) {
        near.set(key, false);
      }
    }
  }
  return (d.buses ?? []).filter((b) => ROUTES.includes(b.route_id)).length;
}

// ---- what the rider is shown ----------------------------------------------
function parsePlan(text) {
  // The plan renders one block per option, e.g.
  //     20 min
  //     arrive 1:01p
  //     › 🚶 1 min › Blue Day › 🚶 5 min
  //     🚌 in 0:52 · next in 5 min
  // Parsing the page as one soup mixes numbers ACROSS options (the first
  // "in N min" can belong to a different route than the "arrive" you read),
  // and the wait switches to M:SS under two minutes — "in 0:52" — which a
  // /(\d+) min/ pattern silently misses. So split into blocks and read each.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const opts = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const m = lines[i].match(/^(\d+)\s*min$/);
    const a = lines[i + 1].match(/^arrive\s+(\d{1,2}:\d{2}[ap])$/i);
    if (!m || !a) continue;
    const block = lines.slice(i + 2, i + 12);
    // Stop the block at the next option header.
    const end = block.findIndex((l, j) => /^\d+\s*min$/.test(l) && /^arrive/i.test(block[j + 1] ?? ""));
    const body = (end === -1 ? block : block.slice(0, end)).join(" | ");
    // "🚌 in 0:52 · next in 5 min"  or  "🚌 in 7 min · next in 22 min"
    const w = body.match(/🚌\s*in\s*(?:(\d+):(\d{2})|(\d+)\s*min)/);
    const waitSec = w ? (w[1] !== undefined ? Number(w[1]) * 60 + Number(w[2]) : Number(w[3]) * 60) : null;
    const label = body.match(/\|\s*([A-Z][A-Za-z ]+?)\s*\|/);
    opts.push({
      totalMin: Number(m[1]),
      arriveText: a[1],
      waitSec,
      isWalk: /🚶/.test(body) && waitSec === null,
      route: label ? label[1].trim() : null,
    });
    i += 1;
  }
  // Score the fastest option that actually rides a shuttle.
  const shuttle = opts.filter((o) => o.waitSec !== null && (!ROUTE_LABEL || o.route === ROUTE_LABEL)).sort((a, b) => a.totalMin - b.totalMin)[0];
  return shuttle
    ? { waitMin: shuttle.waitSec / 60, totalMin: shuttle.totalMin, arriveText: shuttle.arriveText, busName: shuttle.route, options: opts.length, seen: opts.map((o) => o.route) }
    : { waitMin: null, totalMin: null, arriveText: null, busName: null, options: opts.length, seen: opts.map((o) => o.route) };
}

const browser = await chromium.launch({
  executablePath: process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({
  permissions: ["geolocation"],
  geolocation: { latitude: BOARD.lat, longitude: BOARD.lon },
  timezoneId: "America/New_York",
  viewport: { width: 390, height: 900 },
});
await seedTestId(ctx);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));

say(`origin ${BOARD.name} -> destination ${DEST.name} (${Math.round(hav(BOARD, DEST))} m apart)`);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await sleep(5000);
const input = page.getByPlaceholder(/where do you want to go/i).first();
await input.click({ timeout: 20000 });
await input.fill("");
await input.type(`${DEST.lat},${DEST.lon}`, { delay: 20 });
await sleep(1500);
await input.press("Enter");
await sleep(4000);
say("plan entered; sampling");

// The picker collapses to the top options; the line under test may sit
// behind "Show N more routes" when its bus has just passed the stop (a full
// lap away). Expand it so every scrape sees every option.
async function expandOptions() {
  const more = page.getByText(/Show \d+ more route/i).first();
  if (await more.isVisible().catch(() => false)) await more.click({ timeout: 5000 }).catch(() => {});
}
await expandOptions();
const started = Date.now();
let lastScrape = 0;
while (Date.now() - started < RUN_MS) {
  try {
    const n = await pollOnce();
    if (Date.now() - lastScrape >= SCRAPE_MS) {
      lastScrape = Date.now();
      await expandOptions();
      const text = await page.evaluate(() => document.body.innerText);
      const p = parsePlan(text);
      if (p.waitMin != null) {
        predictions.push({ at: Date.now(), ...p });
        say(`predict  next bus in ${p.waitMin.toFixed(1)} min` +
            (p.totalMin != null ? `, trip ${p.totalMin} min` : "") +
            (p.arriveText ? `, arrive ${p.arriveText}` : "") +
            (p.busName ? ` (#${p.busName})` : "") + `  [${n} buses live]`);
      } else {
        say(`predict  no shuttle option shown  [${n} buses live]  options seen: ${JSON.stringify(p.seen)}`);
      }
    }
  } catch (e) {
    say(`poll error: ${String(e.message ?? e).slice(0, 90)}`);
  }
  await sleep(POLL_MS);
}

// ---- score ----------------------------------------------------------------
// Each prediction promised a bus at BOARD at (at + waitMin*60). Score it
// against the first actual arrival at BOARD at or after the prediction.
const boardArrivals = arrivals.filter((a) => a.stopId === BOARD.id).sort((a, b) => a.at - b.at);
const scored = [];
for (const p of predictions) {
  const actual = boardArrivals.find((a) => a.at >= p.at - 60_000);
  if (!actual) continue;
  const promised = p.at + p.waitMin * 60_000;
  scored.push({
    predictedAt: clock(p.at),
    waitMin: p.waitMin,
    leadMin: +((actual.at - p.at) / 60_000).toFixed(1),
    errorMin: +((promised - actual.at) / 60_000).toFixed(1),
    bus: actual.busName,
  });
}

const errs = scored.map((s) => s.errorMin);
const abs = errs.map(Math.abs).sort((a, b) => a - b);
const mean = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : NaN);
const pct = (x, p) => (x.length ? x[Math.min(x.length - 1, Math.floor((p / 100) * x.length))] : NaN);

// End-to-end: a bus seen at BOARD then later at DEST gives a real ride time.
const rides = [];
for (const b of boardArrivals) {
  const d = arrivals.find((a) => a.stopId === DEST.id && a.busName === b.busName && a.at > b.at);
  if (d) rides.push({ bus: b.busName, rideMin: +((d.at - b.at) / 60_000).toFixed(1) });
}

const summary = {
  origin: BOARD.name, destination: DEST.name,
  ranMin: +((Date.now() - started) / 60_000).toFixed(1),
  predictions: predictions.length,
  actualArrivalsAtBoard: boardArrivals.length,
  scoredPairs: scored.length,
  meanErrorMin: +mean(errs).toFixed(2),
  meanAbsErrorMin: +mean(abs).toFixed(2),
  medianAbsErrorMin: +pct(abs, 50)?.toFixed?.(2),
  p90AbsErrorMin: +pct(abs, 90)?.toFixed?.(2),
  worstAbsErrorMin: abs.length ? abs[abs.length - 1] : null,
  withinOneMin: errs.filter((e) => Math.abs(e) <= 1).length,
  withinTwoMin: errs.filter((e) => Math.abs(e) <= 2).length,
  observedRides: rides,
  pageErrors: pageErrors.length,
  scored,
};
fs.writeFileSync(OUT, JSON.stringify({ summary, predictions, arrivals, log }, null, 2));

console.log("\n================ ETA ACCURACY ================");
console.log(`${BOARD.name} -> ${DEST.name}`);
console.log(`ran ${summary.ranMin} min · ${summary.predictions} predictions · ${summary.actualArrivalsAtBoard} real arrivals at the board stop`);
if (scored.length) {
  console.log(`\nscored pairs: ${scored.length}`);
  console.log(`  mean error      ${summary.meanErrorMin > 0 ? "+" : ""}${summary.meanErrorMin} min   (+ = bus came sooner than promised)`);
  console.log(`  mean |error|    ${summary.meanAbsErrorMin} min`);
  console.log(`  median |error|  ${summary.medianAbsErrorMin} min`);
  console.log(`  p90 |error|     ${summary.p90AbsErrorMin} min`);
  console.log(`  worst           ${summary.worstAbsErrorMin} min`);
  console.log(`  within 1 min    ${summary.withinOneMin}/${scored.length}`);
  console.log(`  within 2 min    ${summary.withinTwoMin}/${scored.length}`);
  console.log("\n  lead-time breakdown (how the estimate behaved as the bus closed in):");
  for (const s of scored) {
    console.log(`    ${s.predictedAt}  said ${String(s.waitMin).padStart(2)} min, actually ${String(s.leadMin).padStart(4)} min out  -> error ${s.errorMin > 0 ? "+" : ""}${s.errorMin} min  (#${s.bus})`);
  }
} else {
  console.log("\nno prediction could be paired with a real arrival in this window.");
}
if (rides.length) {
  console.log(`\nobserved ride time board->Green: ${rides.map((r) => `#${r.bus} ${r.rideMin} min`).join(", ")}`);
}
console.log(`\npage errors: ${summary.pageErrors}`);
console.log(`full record: ${OUT}`);

await browser.close();
