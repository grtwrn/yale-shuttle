// Generalised rider-eye ETA + route-adherence check for ANY trip on ANY route.
// (eta-accuracy.mjs is the original, hard-wired to one Blue trip.)
//
// A real browser sits on the live site with geolocation at the BOARD stop and
// the DEST stop entered, and we scrape the ETA the rider is shown for the
// tested route. Independently, a 5 s poll of /api/buses watches raw positions:
//   * the instant a bus on the route first comes within ARRIVAL_M of each stop
//     (ground truth for wait and for the promised arrival time),
//   * how far each position sits from the route polyline (route adherence),
//   * whether at_stop_id, when set, is actually near the bus.
// Nothing in the ground-truth channel reads the app's own math.
//
// Run:  BOT_CHROMIUM_PATH=/usr/bin/chromium ROUTE=13 BOARD=41 DEST=98 RUN_MIN=50 \
//         node scripts/route-tester.mjs
// Env:  ROUTE (upstream route_id), BOARD / DEST (stop ids on that route),
//       RUN_MIN (default 50), BOT_BASE_URL, OUT (json path),
//       BOT_CDP_URL — connect to an already-running chromium
//       (chromium --headless --remote-debugging-port=9222 ...) so ten parallel
//       testers share one browser process instead of launching ten.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

import { seedTestId } from "./testId.mjs";

const BASE = process.env.BOT_BASE_URL ?? "https://yale-shuttle.fly.dev";
const ROUTE = Number(process.env.ROUTE);
const BOARD_ID = Number(process.env.BOARD);
const DEST_ID = Number(process.env.DEST);
const RUN_MS = (Number(process.env.RUN_MIN) || 50) * 60_000;
const OUT = process.env.OUT ?? `/tmp/route-tester-${ROUTE}-${BOARD_ID}-${DEST_ID}.json`;
const SHOTS = OUT.replace(/\.json$/, "") + "-shots";
const ARRIVAL_M = 45;
const OFF_ROUTE_M = 80;       // farther than this from the polyline = off route
const AT_STOP_SLACK_M = 90;   // at_stop_id must be within this of the bus
const POLL_MS = 5_000;
const SCRAPE_MS = 20_000;
if (![ROUTE, BOARD_ID, DEST_ID].every(Number.isInteger)) {
  console.error("usage: ROUTE=<id> BOARD=<stopId> DEST=<stopId> node scripts/route-tester.mjs");
  process.exit(2);
}

const ROUTE_LABELS = {
  3: "Red", 1: "Blue Day", 4: "Blue Weekend", 13: "Blue Night", 16: "Blue West",
  2: "Orange Day", 14: "Orange Night", 17: "Orange East", 19: "Brown", 8: "Pink",
  9: "Green", 10: "Purple", 15: "Gold", 6: "Grocery TJ", 18: "Grocery Ham",
};
const LABEL = ROUTE_LABELS[ROUTE] ?? String(ROUTE);

const hav = (a, b) => {
  const R = 6371000, t = (x) => (x * Math.PI) / 180;
  const dp = t(b.lat - a.lat), dl = t(b.lon - a.lon);
  const q = Math.sin(dp / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};
// Metres from point p to the polyline (array of [lat, lon]).
function distToPolyline(p, line) {
  let best = Infinity;
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  const toXY = (lat, lon) => [(lon - p.lon) * 111320 * cosLat, (lat - p.lat) * 110540];
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = toXY(line[i][0], line[i][1]);
    const [bx, by] = toXY(line[i + 1][0], line[i + 1][1]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? (-(ax * dx + ay * dy)) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  return best;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (ms) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
const etMinutes = (ms) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const g = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (g("hour") % 24) * 60 + g("minute") + g("second") / 60;
};
// "9:41p" shown at time `atMs` -> epoch ms of that wall-clock time (same ET day, or the next if it wrapped).
function arriveTextToMs(text, atMs) {
  const m = text.match(/^(\d{1,2}):(\d{2})([ap])$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "p") h += 12;
  const target = h * 60 + Number(m[2]);
  let delta = target - etMinutes(atMs);
  if (delta < -30) delta += 1440;            // wrapped past midnight
  return atMs + delta * 60_000;
}

const log = [];
const say = (s) => { const line = `[${clock(Date.now())}] ${s}`; console.log(line); log.push(line); };

// ---- static route data ------------------------------------------------------
const first = await (await fetch(`${BASE}/api/buses`)).json();
const stopsSeq = first.routes?.[String(ROUTE)];
const pathLine = first.route_paths?.[String(ROUTE)];
if (!stopsSeq || !pathLine) { console.error(`route ${ROUTE} not in payload`); process.exit(2); }
for (const id of [BOARD_ID, DEST_ID]) if (!stopsSeq.includes(id)) { console.error(`stop ${id} is not on route ${ROUTE}`); process.exit(2); }
const stopOf = (id) => ({ id, name: first.stop_names[String(id)], ...first.stop_coords[String(id)] });
const BOARD = stopOf(BOARD_ID), DEST = stopOf(DEST_ID);
const boardIdx = stopsSeq.indexOf(BOARD_ID), destIdx = stopsSeq.indexOf(DEST_ID);
// Cumulative metres along the polyline; used to detect a stop being passed
// between two feed samples. Where the route overlaps itself (Purple's West
// Campus out-and-back) the nearest segment is ambiguous, so among candidates
// within 25 m of the best we take the one closest AHEAD of the previous fix.
const cum = [0];
for (let i = 0; i + 1 < pathLine.length; i++) cum.push(cum[i] + hav({ lat: pathLine[i][0], lon: pathLine[i][1] }, { lat: pathLine[i + 1][0], lon: pathLine[i + 1][1] }));
const LOOP_M = cum[cum.length - 1];
const fwd = (d) => ((d % LOOP_M) + LOOP_M) % LOOP_M;
function alongRoute(p, prevS) {
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  const toXY = (lat, lon) => [(lon - p.lon) * 111320 * cosLat, (lat - p.lat) * 110540];
  const cands = [];
  for (let i = 0; i + 1 < pathLine.length; i++) {
    const [ax, ay] = toXY(pathLine[i][0], pathLine[i][1]);
    const [bx, by] = toXY(pathLine[i + 1][0], pathLine[i + 1][1]);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let t = len2 ? (-(ax * dx + ay * dy)) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    cands.push({ d: Math.hypot(ax + t * dx, ay + t * dy), s: cum[i] + t * (cum[i + 1] - cum[i]) });
  }
  const best = Math.min(...cands.map((c) => c.d));
  const close = cands.filter((c) => c.d <= best + 25);
  if (prevS == null || close.length === 1) return close.sort((a, b) => a.d - b.d)[0].s;
  return close.sort((a, b) => fwd(a.s - prevS) - fwd(b.s - prevS))[0].s;
}
// A repeated stop (routes 9/10) has several along-route positions; passing any counts.
for (const st of [BOARD, DEST]) {
  st.s = [];
  const cosLat = Math.cos((st.lat * Math.PI) / 180);
  for (let i = 0; i + 1 < pathLine.length; i++) {
    const ax = (pathLine[i][1] - st.lon) * 111320 * cosLat, ay = (pathLine[i][0] - st.lat) * 110540;
    const bx = (pathLine[i + 1][1] - st.lon) * 111320 * cosLat, by = (pathLine[i + 1][0] - st.lat) * 110540;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let t = len2 ? (-(ax * dx + ay * dy)) / len2 : 0; t = Math.max(0, Math.min(1, t));
    if (Math.hypot(ax + t * dx, ay + t * dy) <= 60) st.s.push(cum[i] + t * (cum[i + 1] - cum[i]));
  }
  // Collapse neighbouring segment hits into one position each.
  st.s.sort((a, b) => a - b);
  st.s = st.s.filter((v, i, arr) => i === 0 || v - arr[i - 1] > 100);
}
const lastS = new Map(), lastArrival = new Map();
say(`${LABEL} (route ${ROUTE}): ${BOARD.name} [#${boardIdx}] -> ${DEST.name} [#${destIdx}] (${Math.round(hav(BOARD, DEST))} m apart, ${stopsSeq.length} stops on route)`);

// ---- ground truth -------------------------------------------------------------
const predictions = [];   // { at, waitSec, totalMin, arriveText, arriveMs, route, options }
const arrivals = [];      // { stopId, stopName, busName, busId, at, dist }
const trace = [];         // per poll per bus on the route
const offRoute = [];      // { at, busName, lat, lon, offM }
const atStopMismatch = []; // { at, busName, atStopId, distM }
const staleness = [];
let lastSeenBus = null;

async function pollOnce() {
  const r = await fetch(`${BASE}/api/buses`);
  const d = await r.json();
  const now = Date.now();
  if (d.poll_age_ms != null) staleness.push(d.poll_age_ms);
  const mine = (d.buses ?? []).filter((b) => b.route_id === ROUTE);
  for (const b of mine) {
    const offM = distToPolyline({ lat: b.lat, lon: b.lon }, pathLine);
    const dBoard = hav(b, BOARD), dDest = hav(b, DEST);
    trace.push({ at: now, busName: b.bus_name, busId: b.bus_id, lat: b.lat, lon: b.lon, heading: b.heading,
      stationary: b.stationary, atStopId: b.at_stop_id ?? null, lastStopId: b.last_stop_id ?? null,
      offM: Math.round(offM), dBoard: Math.round(dBoard), dDest: Math.round(dDest) });
    if (offM > OFF_ROUTE_M) {
      offRoute.push({ at: now, busName: b.bus_name, lat: b.lat, lon: b.lon, offM: Math.round(offM) });
      if (offRoute.length === 1 || offRoute[offRoute.length - 2].busName !== b.bus_name || now - offRoute[offRoute.length - 2].at > 60_000)
        say(`OFF-ROUTE ${b.bus_name} is ${Math.round(offM)} m from the ${LABEL} polyline at ${b.lat},${b.lon}`);
    }
    if (b.at_stop_id != null && first.stop_coords[String(b.at_stop_id)]) {
      const dm = hav(b, first.stop_coords[String(b.at_stop_id)]);
      if (dm > AT_STOP_SLACK_M) atStopMismatch.push({ at: now, busName: b.bus_name, atStopId: b.at_stop_id, distM: Math.round(dm) });
    }
    // Along-route progress. The feed often repeats a position for 10-15 s and
    // then jumps, so a bus can pass a stop between samples without ever being
    // seen inside ARRIVAL_M. Crossing the stop's along-route position between
    // two distinct samples counts too, at the interpolated time.
    const prev = lastS.get(b.bus_name);
    const s = alongRoute({ lat: b.lat, lon: b.lon }, prev?.s);
    const moved = !prev || prev.lat !== b.lat || prev.lon !== b.lon;
    for (const stop of [BOARD, DEST]) {
      const key = `${b.bus_name}@${stop.id}`;  // bus_name is the identity, ids reissue
      const dist = stop === BOARD ? dBoard : dDest;
      const last = lastArrival.get(key) ?? 0;
      let hit = null;
      if (dist <= ARRIVAL_M && now - last > 180_000) hit = { at: now, how: `${Math.round(dist)} m` };
      else if (prev && moved && offM < OFF_ROUTE_M && now - last > 180_000) {
        const adv = fwd(s - prev.s);
        if (adv > 0 && adv < 1500) {
          for (const sStop of stop.s) {
            const gap = fwd(sStop - prev.s);
            if (gap <= adv) { hit = { at: Math.round(prev.at + (prev.at === now ? 0 : (now - prev.at) * gap / adv)), how: `crossed between samples ${clock(prev.at)}-${clock(now)}` }; break; }
          }
        }
      }
      if (hit) {
        lastArrival.set(key, hit.at);
        arrivals.push({ stopId: stop.id, stopName: stop.name, busName: b.bus_name, busId: b.bus_id, at: hit.at, dist: Math.round(dist), how: hit.how });
        say(`ARRIVAL  ${b.bus_name} reached ${stop.name} at ${clock(hit.at)} (${hit.how})`);
        if (stop === BOARD) await shot(`board-arrival-${clock(now).replace(/:/g, "")}`);
      }
    }
    if (moved) lastS.set(b.bus_name, { s, at: now, lat: b.lat, lon: b.lon });
    lastSeenBus = b.bus_name;
  }
  return mine.length;
}

// ---- what the rider is shown ------------------------------------------------
function parsePlan(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const opts = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const m = lines[i].match(/^(\d+)\s*min$/);
    const a = lines[i + 1].match(/^arrive\s+(\d{1,2}:\d{2}[ap])$/i);
    if (!m || !a) continue;
    const block = lines.slice(i + 2, i + 14);
    const end = block.findIndex((l, j) => /^\d+\s*min$/.test(l) && /^arrive/i.test(block[j + 1] ?? ""));
    const body = (end === -1 ? block : block.slice(0, end)).join(" | ");
    // "🚌 in 7 min · next in 22 min" | "🚌 in <1 min" | "🚌 arriving now"
    const w = body.match(/🚌\s*(?:in\s*(?:(\d+):(\d{2})|<\s*1\s*min|(\d+)\s*min)|arriving now)/);
    let waitSec = null;
    if (w) waitSec = w[1] !== undefined ? Number(w[1]) * 60 + Number(w[2]) : w[3] !== undefined ? Number(w[3]) * 60 : /arriving now/.test(w[0]) ? 0 : 30;
    const nx = body.match(/next in\s*(?:(\d+)\s*min|<\s*1\s*min)/);
    const route = Object.values(ROUTE_LABELS).filter((l) => body.includes(l)).sort((x, y) => y.length - x.length)[0] ?? null;
    opts.push({ totalMin: Number(m[1]), arriveText: a[1], waitSec, nextSec: nx ? (nx[1] ? Number(nx[1]) * 60 : 30) : null,
      isWalk: waitSec === null && /🚶/.test(body), route, body: body.slice(0, 160) });
    i += 1;
  }
  const mine = opts.find((o) => o.route === LABEL && o.waitSec !== null) ?? null;
  return { options: opts, mine };
}

const cdp = process.env.BOT_CDP_URL;
const browser = cdp
  ? await chromium.connectOverCDP(cdp)
  : await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({
  permissions: ["geolocation"],
  geolocation: { latitude: BOARD.lat, longitude: BOARD.lon },
  timezoneId: "America/New_York",
  viewport: { width: 390, height: 900 },
});
await seedTestId(ctx);
const page = await ctx.newPage();
const pageErrors = [], consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push({ at: Date.now(), msg: String(e.message) }));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push({ at: Date.now(), msg: m.text().slice(0, 200) }); });
fs.mkdirSync(SHOTS, { recursive: true });
async function shot(name) {
  try { await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } catch { /* best effort */ }
}

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await sleep(5000);
const input = page.getByPlaceholder(/where do you want to go/i).first();
await input.click({ timeout: 20000 });
await input.fill("");
await input.type(`${DEST.lat},${DEST.lon}`, { delay: 20 });
await sleep(1500);
await input.press("Enter");
await sleep(4000);
await shot("plan-initial");
say("plan entered; sampling");

const started = Date.now();
let lastScrape = 0, sameWaitRun = 0, lastWait = null;
const stuck = [];
let sawMineEver = false, noMineStreak = 0;
while (Date.now() - started < RUN_MS) {
  try {
    const n = await pollOnce();
    if (Date.now() - lastScrape >= SCRAPE_MS) {
      lastScrape = Date.now();
      // Checkpoint the raw record every scrape: a 50-min watch that dies
      // (the Pi rebooted mid-run once) still leaves its evidence behind.
      try {
        fs.writeFileSync(OUT, JSON.stringify({ partial: true, route: LABEL, origin: BOARD.name, destination: DEST.name, startedAt: clock(started), predictions, arrivals, offRoute: offRoute.slice(0, 200), atStopMismatch: atStopMismatch.slice(0, 50), stuck, pageErrors, consoleErrors, tracePolls: trace.length, log }, null, 1));
      } catch { /* best effort */ }
      const text = await page.evaluate(() => document.body.innerText);
      const p = parsePlan(text);
      if (p.mine) {
        sawMineEver = true; noMineStreak = 0;
        const arriveMs = arriveTextToMs(p.mine.arriveText, lastScrape);
        predictions.push({ at: lastScrape, waitSec: p.mine.waitSec, nextSec: p.mine.nextSec, totalMin: p.mine.totalMin, arriveText: p.mine.arriveText, arriveMs, route: p.mine.route, options: p.options.map((o) => ({ route: o.route, totalMin: o.totalMin, waitSec: o.waitSec, isWalk: o.isWalk })) });
        // A wait that does not move for 3+ scrapes (60 s) while a bus is live is the #48 symptom.
        if (p.mine.waitSec === lastWait && p.mine.waitSec > 60) sameWaitRun++; else sameWaitRun = 0;
        lastWait = p.mine.waitSec;
        if (sameWaitRun >= 4) { stuck.push({ at: lastScrape, waitSec: p.mine.waitSec, scrapes: sameWaitRun + 1 }); say(`STUCK?  wait has read ${p.mine.waitSec}s for ${(sameWaitRun + 1) * SCRAPE_MS / 1000}s`); }
        say(`predict  ${LABEL}: bus in ${Math.round(p.mine.waitSec / 60)} min, trip ${p.mine.totalMin} min, arrive ${p.mine.arriveText}` + (p.mine.nextSec != null ? `, next ${Math.round(p.mine.nextSec / 60)} min` : "") + `  [${p.options.length} options; ${n} ${LABEL} buses live]`);
      } else {
        noMineStreak++;
        const others = p.options.map((o) => `${o.route ?? (o.isWalk ? "walk" : "?")} ${o.totalMin}m`).join(", ");
        say(`predict  no ${LABEL} option shown (${p.options.length} options: ${others || "none"}) [${n} live]`);
        if (noMineStreak === 3) await shot("no-option");
      }
    }
  } catch (e) {
    say(`poll error: ${String(e.message ?? e).slice(0, 120)}`);
  }
  await sleep(POLL_MS);
}
await shot("plan-final");

// ---- score --------------------------------------------------------------------
const boardArrivals = arrivals.filter((a) => a.stopId === BOARD.id).sort((a, b) => a.at - b.at);
const destArrivals = arrivals.filter((a) => a.stopId === DEST.id).sort((a, b) => a.at - b.at);
const scored = [];
for (const p of predictions) {
  const actual = boardArrivals.find((a) => a.at >= p.at - 60_000);
  if (!actual) continue;
  const promised = p.at + p.waitSec * 1000;
  scored.push({ predictedAt: clock(p.at), waitMin: +(p.waitSec / 60).toFixed(1), leadMin: +((actual.at - p.at) / 60_000).toFixed(1),
    errorMin: +((promised - actual.at) / 60_000).toFixed(1), bus: actual.busName });
}
// Promised arrival at DEST vs the same bus's real arrival there.
const arriveScored = [];
for (const b of boardArrivals) {
  const d = destArrivals.find((a) => a.busName === b.busName && a.at > b.at);
  if (!d) continue;
  for (const p of predictions.filter((p) => p.at <= b.at && p.at >= b.at - 20 * 60_000 && p.arriveMs)) {
    arriveScored.push({ predictedAt: clock(p.at), promisedArrive: p.arriveText, actualArrive: clock(d.at), errorMin: +((p.arriveMs - d.at) / 60_000).toFixed(1), bus: b.busName, rideMin: +((d.at - b.at) / 60_000).toFixed(1) });
  }
}
const errs = scored.map((s) => s.errorMin);
const abs = errs.map(Math.abs).sort((a, b) => a - b);
const mean = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : null);
const pct = (x, p) => (x.length ? x[Math.min(x.length - 1, Math.floor((p / 100) * x.length))] : null);
const offMax = trace.reduce((m, t) => Math.max(m, t.offM), 0);

const summary = {
  route: LABEL, routeId: ROUTE, origin: BOARD.name, destination: DEST.name,
  ranMin: +((Date.now() - started) / 60_000).toFixed(1),
  predictions: predictions.length, scrapesWithoutRouteOption: predictions.length ? null : "never", sawMineEver,
  actualArrivalsAtBoard: boardArrivals.map((a) => ({ bus: a.busName, at: clock(a.at) })),
  actualArrivalsAtDest: destArrivals.map((a) => ({ bus: a.busName, at: clock(a.at) })),
  wait: { scoredPairs: scored.length, meanErrorMin: mean(errs) != null ? +mean(errs).toFixed(2) : null, medianAbsErrorMin: pct(abs, 50), p90AbsErrorMin: pct(abs, 90), worstAbsErrorMin: abs.at(-1) ?? null,
    withinOneMin: errs.filter((e) => Math.abs(e) <= 1).length, withinTwoMin: errs.filter((e) => Math.abs(e) <= 2).length },
  arrive: { scoredPairs: arriveScored.length, meanErrorMin: mean(arriveScored.map((a) => a.errorMin)) != null ? +mean(arriveScored.map((a) => a.errorMin)).toFixed(2) : null,
    worstAbsErrorMin: arriveScored.length ? Math.max(...arriveScored.map((a) => Math.abs(a.errorMin))) : null },
  routeAdherence: { polls: trace.length, maxOffRouteM: offMax, offRoutePolls: offRoute.length, offRouteShare: trace.length ? +(offRoute.length / trace.length).toFixed(3) : null, atStopMismatches: atStopMismatch.length },
  stuckReadings: stuck.length, pageErrors: pageErrors.length, consoleErrors: consoleErrors.length,
  screenshots: SHOTS,
};
fs.writeFileSync(OUT, JSON.stringify({ summary, scored, arriveScored, predictions, arrivals, offRoute: offRoute.slice(0, 200), atStopMismatch: atStopMismatch.slice(0, 50), stuck, pageErrors, consoleErrors, trace, log }, null, 2));

console.log(`\n================ ${LABEL}: ${BOARD.name} -> ${DEST.name} ================`);
console.log(`ran ${summary.ranMin} min · ${predictions.length} predictions · board arrivals: ${summary.actualArrivalsAtBoard.map((a) => `${a.bus}@${a.at}`).join(", ") || "none"} · dest arrivals: ${summary.actualArrivalsAtDest.map((a) => `${a.bus}@${a.at}`).join(", ") || "none"}`);
if (scored.length) {
  console.log(`\nWAIT accuracy (${scored.length} pairs): mean ${summary.wait.meanErrorMin > 0 ? "+" : ""}${summary.wait.meanErrorMin} min (+ = bus came sooner than promised), median |err| ${summary.wait.medianAbsErrorMin}, p90 ${summary.wait.p90AbsErrorMin}, worst ${summary.wait.worstAbsErrorMin}, within 1 min ${summary.wait.withinOneMin}/${scored.length}, within 2 min ${summary.wait.withinTwoMin}/${scored.length}`);
  for (const s of scored) console.log(`    ${s.predictedAt}  said ${String(s.waitMin).padStart(4)} min, actually ${String(s.leadMin).padStart(4)} min out  -> error ${s.errorMin > 0 ? "+" : ""}${s.errorMin} min  (${s.bus})`);
} else console.log("\nno wait prediction could be paired with a real arrival in this window.");
if (arriveScored.length) {
  console.log(`\nARRIVE-TIME accuracy (${arriveScored.length} pairs): mean ${summary.arrive.meanErrorMin} min (+ = arrived sooner than promised), worst |err| ${summary.arrive.worstAbsErrorMin}`);
  for (const a of arriveScored.slice(-8)) console.log(`    ${a.predictedAt}  promised ${a.promisedArrive}, actual ${a.actualArrive} -> error ${a.errorMin > 0 ? "+" : ""}${a.errorMin} min (${a.bus}, ride ${a.rideMin} min)`);
}
console.log(`\nROUTE ADHERENCE: ${trace.length} bus polls, max ${offMax} m from polyline, ${offRoute.length} polls > ${OFF_ROUTE_M} m (${Math.round((summary.routeAdherence.offRouteShare ?? 0) * 100)}%), at_stop_id mismatches ${atStopMismatch.length}`);
console.log(`stuck readings: ${stuck.length} · page errors: ${pageErrors.length} · console errors: ${consoleErrors.length}`);
console.log(`screenshots: ${SHOTS}\nfull record: ${OUT}`);

await ctx.close();
if (!cdp) await browser.close(); else await browser.close().catch(() => {});
