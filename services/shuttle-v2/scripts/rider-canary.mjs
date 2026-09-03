#!/usr/bin/env node
/**
 * rider-canary.mjs — a synthetic rider that never stops riding.
 *
 * One simulated rider at a time picks a line that is actually running, plans
 * Prospect/Canner -> the School of Public Health in the REAL UI, and then
 * watches the countdown until the shuttle physically reaches the stop the app
 * told it to walk to. The operator's ask, verbatim: "always spawns a simulated
 * rider that picks a line and a start and stop dest and watches till the
 * shuttle arrives ... so we can keep health good."
 *
 * WHAT IT MEASURES THAT NOTHING ELSE DOES. `eta-accuracy.mjs` and
 * `eta-replay/` score predictions against truth in aggregate. This one scores
 * the SEQUENCE — every number the rider is shown, in order — because that is
 * the actual complaint: "i'm not worried about a few seconds. i'm worried
 * about saying a bus is 10min away and then a few seconds later dropping to 1
 * second." The arithmetic lives in canary-metrics.mjs and is unit-tested; see
 * the note there about why everything is done on display INTERVALS.
 *
 * ONE BROWSER AT A TIME, ALWAYS. This Pi rebooted under memory pressure on
 * 2026-09-01 with ten testers running. --loop launches and closes a single
 * chromium per rider, sequentially, and sleeps when no line is up.
 *
 * SILENT WHEN HEALTHY. A clean run writes its record and exits 0 with no
 * output. A run that finds something prints it to stderr and exits 1.
 *
 *   node scripts/rider-canary.mjs                  one rider, then exit
 *   node scripts/rider-canary.mjs --loop           keep a rider going
 *   node scripts/rider-canary.mjs --summary        health digest from the log
 *   node scripts/rider-canary.mjs --verbose        narrate the watch
 *
 * Env: BOT_BASE_URL, BOT_CHROMIUM_PATH, CANARY_DIR, CANARY_LINE (force one),
 *      CANARY_TICK_MS, CANARY_WATCH_MAX_MIN, CANARY_CATASTROPHIC_SEC,
 *      CANARY_FIRST_SIGHT_MISS_SEC, CANARY_IDLE_SLEEP_MIN, CANARY_REST_MIN.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CANARY_LINES, haversineM, parseOptions, scoreSequence, THRESHOLDS, tripForLine,
} from "./canary-metrics.mjs";
import { seedTestId } from "./testId.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BASE = (process.env.BOT_BASE_URL || "https://yale-shuttle.fly.dev").replace(/\/$/, "");
const CHROMIUM = process.env.BOT_CHROMIUM_PATH
  || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const DIR = process.env.CANARY_DIR || join(HERE, ".canary");
const RUNS = join(DIR, "runs.jsonl");
const STATE = join(DIR, "state.json");

/** Ground truth poll, matching the collector's own 5 s cadence. */
const TICK_MS = Number(process.env.CANARY_TICK_MS) || 5_000;
/** How often the UI is read. 15 s resolves a one-minute display step four
 *  times over, which is as fine as a minute-bucketed countdown can be read,
 *  and costs one innerText per tick rather than three. */
const SCRAPE_EVERY = 3;
/** How close counts as "the shuttle arrived", same as eta-accuracy.mjs. */
const ARRIVAL_M = 45;
const IDLE_SLEEP_MS = (Number(process.env.CANARY_IDLE_SLEEP_MIN) || 10) * 60_000;
/**
 * Hard ceiling on one rider's watch, minutes. 25 by default — see the deadline
 * note below. Lowering it is how a derived trip gets probed ("does this line
 * even appear?") without spending a full headway on the answer.
 */
const WATCH_MAX_MIN = Number(process.env.CANARY_WATCH_MAX_MIN) || 25;
/**
 * Pause between riders in --loop. Zero by design — "we should always have a
 * rider going when a line is up" — but one browser costs ~0.95 GB of process
 * tree on this Pi (measured 2026-09-03, 10 processes), and this Pi rebooted
 * under memory pressure once, so it is a knob rather than a constant.
 */
const REST_MS = (Number(process.env.CANARY_REST_MIN) || 0) * 60_000;

const THRESH = {
  ...THRESHOLDS,
  catastrophicSec: Number(process.env.CANARY_CATASTROPHIC_SEC) || THRESHOLDS.catastrophicSec,
  firstSightMissSec: Number(process.env.CANARY_FIRST_SIGHT_MISS_SEC) || THRESHOLDS.firstSightMissSec,
};

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const VERBOSE = has("--verbose");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (ms) => new Date(ms).toLocaleTimeString("en-US",
  { timeZone: "America/New_York", hour12: false });
// `at` defaults to now, but a scrape passes the tick's own timestamp: under
// load a page.evaluate can take seconds, and a log line stamped at print time
// reads as two samples 5 s apart when the record correctly holds 15.
const say = (s, at = Date.now()) => { if (VERBOSE) process.stderr.write(`[${clock(at)}] ${s}\n`); };

// ── which line to ride ──────────────────────────────────────────────────────

/**
 * A line is rideable when the server is showing live buses on it AND a trip
 * can be built that reaches both ends. The second half matters: Blue Weekend
 * serves Prospect/Canner but never LEPH, so on a Saturday the app is RIGHT to
 * offer no Blue option there and a canary that demanded one would cry wolf
 * every weekend — `tripForLine` gives that line its own trip instead.
 *
 * Live buses, not a schedule table, are the service-hours gate. The server
 * already drops out-of-service ghosts (report #30), so a line with no buses is
 * a line with nothing to watch, whatever the timetable says.
 */
export function rideableLines(payload) {
  return CANARY_LINES.map((line) => {
    const trip = tripForLine(payload, line);
    const live = (payload.buses ?? []).filter((b) => line.busRouteIds.includes(b.route_id));
    return {
      ...line, trip,
      liveBuses: live.length,
      rideable: !!trip && live.length > 0,
    };
  });
}

function readState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return { cursor: 0 }; }
}
function writeState(s) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

// ── the browser rider ───────────────────────────────────────────────────────

/** Click the collapsed card for `label`. The cards carry no test id and every
 *  style is inline, so the handle is `cursor: pointer` — which only the
 *  collapsed, tappable rows set — plus the card's own arrival clock. */
async function openCard(page, label) {
  return page.evaluate((l) => {
    const cards = [...document.querySelectorAll("div")].filter((d) =>
      d.style.cursor === "pointer" &&
      /arrive \d{1,2}:\d{2}[ap]/.test(d.innerText || "") &&
      (d.innerText || "").includes(l));
    cards.sort((a, b) => a.innerText.length - b.innerText.length);
    if (!cards[0]) return false;
    cards[0].click();
    return true;
  }, label);
}

/**
 * Read the two things only the details view knows: the vehicle the option is
 * pinned to (the ride pill, "🚌 #40 · 12 min") and the board stop (the
 * Directions link's coordinate — the app's own answer, so the canary never
 * has to guess which stop the planner chose).
 */
async function readPin(page, label) {
  if (!await openCard(page, label)) return null;
  await sleep(900);
  const pin = await page.evaluate(() => {
    const txt = document.body.innerText || "";
    const bus = txt.match(/🚌\s*#(\S+)\s*·/);
    const a = [...document.querySelectorAll('a[href*="maps/dir"]')][0];
    const m = a?.getAttribute("href")?.match(/destination=(-?[\d.]+),(-?[\d.]+)/);
    return {
      busName: bus ? bus[1] : null,
      board: m ? { lat: Number(m[1]), lon: Number(m[2]) } : null,
    };
  });
  // Back to the list, and CONFIRM it. The countdown is rendered only on
  // collapsed rows, so a details view left open would make every remaining
  // scrape read "no countdown" — the canary reporting its own stuck tap as an
  // app fault. Two attempts, then give up and say so.
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => (x.innerText || "").includes("All routes"));
      b?.click();
    });
    await sleep(600);
    const back = await page.evaluate(() => !/←\s*All routes/.test(document.body.innerText || ""));
    if (back) return pin;
  }
  return { ...pin, stuckInDetails: true };
}

async function plan(page, ctx, trip) {
  // Intercept the lookup. `searchTerms.record` in src/server/app.ts has no
  // anon-id filter — excluding the canary from the RIDER counts does not
  // exclude it from `search_terms` — so a canary that typed a real query
  // would, running continuously, become the most-searched destination in New
  // Haven. The trip planner is what this harness is testing; lookup has its
  // own. The shape is the v1 contract, class "yale" so the app auto-picks it.
  await ctx.route("**/api/geocode*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ results: [trip.destination] }),
  }));
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await sleep(5_000);
  await page.getByRole("button", { name: /^trip$/i }).click({ timeout: 3_000 }).catch(() => {});
  const input = page.getByPlaceholder(/where do you want to go/i).first();
  await input.click({ timeout: 20_000 });
  await input.fill("");
  await input.type(trip.destination.display_name, { delay: 15 });
  await sleep(1_200);
  await input.press("Enter");
  await sleep(4_500);
  // The line under test can sit behind the fold when its bus has just left.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .find((x) => /^Show \d+ more route/.test(x.innerText || ""));
    b?.click();
  });
  await sleep(800);
}

async function fetchBuses() {
  const r = await fetch(`${BASE}/api/buses`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`/api/buses ${r.status}`);
  return r.json();
}

/** One rider, start to finish. Resolves to the run record. */
async function runOnce(line) {
  const startedAt = Date.now();
  const record = {
    startedAt, startedAtEt: clock(startedAt), base: BASE, line: line.label,
    busRouteIds: line.busRouteIds, thresholds: THRESH,
    trip: { from: line.trip.origin.label, to: line.trip.destination.display_name, kind: line.trip.kind },
    samples: [], pins: [], arrivals: [], pageErrors: [], failures: [],
  };
  const fail = (kind, detail) => record.failures.push({ kind, detail, atMs: Date.now() });

  const { chromium } = await import("playwright-core").catch(() => import("playwright"));
  // Hoisted so a fatal can say what the page LOOKED like. A stack trace with
  // no page state is nearly unactionable when the failure is "the app was not
  // where the harness expected it".
  let page = null;
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      geolocation: { latitude: line.trip.origin.lat, longitude: line.trip.origin.lon },
      permissions: ["geolocation"], timezoneId: "America/New_York",
    });
    // Before the first goto, always: the server pre-excludes this id, so a
    // canary running around the clock never shows up as a rider who visited
    // once and never came back.
    await seedTestId(ctx);
    page = await ctx.newPage();
    page.on("pageerror", (e) => record.pageErrors.push(String(e.message)));
    page.on("console", (m) => { if (m.type() === "error") record.pageErrors.push(`console: ${m.text()}`); });

    await plan(page, ctx, line.trip);

    let opts = parseOptions(await page.evaluate(() => document.body.innerText));
    if (!opts.some((o) => o.routeLabel === line.label)) {
      // Give the planner one more poll cycle; the option can be a beat late.
      await sleep(6_000);
      opts = parseOptions(await page.evaluate(() => document.body.innerText));
    }
    if (!opts.length) fail("no-options", "the plan offered nothing at all");
    else if (!opts.some((o) => o.routeLabel === line.label)) {
      fail("line-missing", `${line.label} is running (${line.liveBuses} live buses) but the plan never offered it; offered: ${opts.map((o) => o.routeLabel).join(", ")}`);
    }
    record.offeredAtStart = opts.map((o) => o.routeLabel);

    // The app's own answer to "which stop am I walking to" and "which bus is
    // this". Everything downstream keys off it.
    const pin0 = await readPin(page, line.label);
    if (pin0) record.pins.push({ atMs: Date.now(), ...pin0, why: "start" });
    const board = pin0?.board ?? null;
    if (!board) fail("no-board-stop", "could not read the board stop from the details view");
    if (pin0?.stuckInDetails) fail("stuck-in-details", "could not return to the option list after reading the pin; the readings below are the harness's fault, not the app's");
    record.board = board;

    // Timeout: twice what the app promised at first sight, plus six minutes of
    // slack, bounded to [8, 25] min. A bus that has not arrived by twice its
    // own promise is either broken down or badly mispredicted — both worth
    // saying — and 25 min bounds the browser's life on this Pi.
    let deadline = startedAt + Math.min(12, WATCH_MAX_MIN) * 60_000;
    let firstSight = null;
    let arrived = null;
    let lastScrape = 0;
    let tick = 0;
    const nearFlags = new Map();

    while (Date.now() < deadline) {
      const now = Date.now();
      // ── ground truth: nothing here reads the app's own numbers ──
      let payload = null;
      try { payload = await fetchBuses(); }
      catch (e) { record.failures.push({ kind: "feed-error", detail: String(e.message), atMs: now }); }
      const routeBuses = (payload?.buses ?? []).filter((b) => line.busRouteIds.includes(b.route_id));
      if (board) {
        for (const b of routeBuses) {
          const key = `${b.bus_id}`;
          const d = haversineM(b, board);
          const was = nearFlags.get(key) ?? false;
          // Arm on the first poll: a bus already standing at the stop when the
          // rider arrives is not an arrival this run watched for, and counting
          // it would end the run before a single countdown had been read.
          if (tick === 0) { nearFlags.set(key, d <= ARRIVAL_M); continue; }
          if (!was && d <= ARRIVAL_M) {
            nearFlags.set(key, true);
            record.arrivals.push({ atMs: now, busName: b.bus_name, distM: Math.round(d) });
            say(`ARRIVAL ${b.bus_name} at the board stop (${Math.round(d)} m)`, now);
            arrived ??= { atMs: now, busName: b.bus_name };
          } else if (was && d > 120) nearFlags.set(key, false);
        }
      }

      // ── what the rider is shown ──
      if (now - lastScrape >= TICK_MS * SCRAPE_EVERY) {
        lastScrape = now;
        let text = "";
        try { text = await page.evaluate(() => document.body.innerText); }
        catch (e) { record.failures.push({ kind: "page-unreadable", detail: String(e.message), atMs: now }); break; }
        const cards = parseOptions(text);
        const mine = cards.find((o) => o.routeLabel === line.label) ?? null;
        const busSnapshot = routeBuses.map((b) => ({
          name: b.bus_name, id: b.bus_id,
          distM: board ? Math.round(haversineM(b, board)) : null,
          atStop: b.at_stop_id ?? null,
        })).sort((a, b) => (a.distM ?? 1e9) - (b.distM ?? 1e9));
        record.samples.push({
          atMs: now, present: !!mine, eta: mine?.eta ?? null,
          etaRaw: mine?.eta?.raw ?? null, totalMin: mine?.totalMin ?? null,
          arriveText: mine?.arriveText ?? null, departed: mine?.departed ?? false,
          missedBus: mine?.missedBus ?? null, walkToMin: mine?.walkToMin ?? null,
          waitFallback: mine?.waitFallback ?? null,
          others: cards.filter((o) => o.routeLabel !== line.label)
            .map((o) => ({ route: o.routeLabel, eta: o.eta?.raw ?? null, departed: o.departed })),
          buses: busSnapshot,
        });
        if (mine?.eta && !firstSight) {
          firstSight = { atMs: now, first: mine.eta.first, raw: mine.eta.raw };
          record.firstSight = firstSight;
          const promisedMin = firstSight.first[1] / 60;
          deadline = now + Math.min(WATCH_MAX_MIN, Math.max(1, Math.min(8, WATCH_MAX_MIN), promisedMin * 2 + 6)) * 60_000;
          say(`first sight: ${firstSight.raw} — watching for up to ${Math.round((deadline - now) / 60000)} min`, now);
        }
        say(`${line.label}: ${mine ? (mine.eta?.raw ?? (mine.departed ? "Departed" : "no countdown")) : "OPTION GONE"}`, now);

        // A jump is only interesting if we can say what moved. Sampling the
        // pin costs a tap in and out, so it happens on the transitions that
        // matter rather than every tick.
        const seq = scoreSequence(record.samples, THRESH);
        const last = seq.transitions[seq.transitions.length - 1];
        if (last && last.atMs === now && Math.abs(last.driftSec) >= THRESH.pinSampleSec) {
          const pin = await readPin(page, line.label).catch(() => null);
          if (pin) record.pins.push({ atMs: Date.now(), ...pin, why: "jump" });
          if (pin?.stuckInDetails) {
            record.failures.push({ kind: "stuck-in-details", detail: "could not return to the option list after reading the pin; later readings are the harness's fault, not the app's", atMs: Date.now() });
            break;
          }
        }
      }

      if (arrived) break;
      await sleep(TICK_MS);
      tick++;
    }

    record.endedAt = Date.now();
    record.watchedMin = +((record.endedAt - startedAt) / 60_000).toFixed(1);
    record.arrived = arrived;
    record.sequence = scoreSequence(record.samples, THRESH);

    // ── did the first thing the rider was told survive contact with reality?
    if (firstSight && arrived) {
      const lo = firstSight.atMs + firstSight.first[0] * 1000;
      const hi = firstSight.atMs + firstSight.first[1] * 1000;
      const miss = arrived.atMs < lo ? (lo - arrived.atMs) / 1000
        : arrived.atMs > hi ? (arrived.atMs - hi) / 1000 : 0;
      record.firstSightMissSec = Math.round(miss);
      if (miss > THRESH.firstSightMissSec) {
        fail("first-sight-miss", `at first sight the app said "${firstSight.raw}"; the bus took ${((arrived.atMs - firstSight.atMs) / 60_000).toFixed(1)} min (${Math.round(miss / 60)} min outside the window it promised)`);
      }
    }
    // ── the failures the operator named ──
    for (const t of record.sequence.transitions.filter((x) => x.catastrophic)) {
      fail("eta-jump", `"${t.from}" → "${t.to}" in ${t.dtSec} s — ${t.driftSec > 0 ? "+" : ""}${(t.driftSec / 60).toFixed(1)} min beyond what the clock explains${t.pinAnnouncedChange ? " (the app announced a vehicle swap)" : ""}`);
    }
    if (!arrived && record.samples.some((s) => s.present)) {
      const lastSeen = [...record.samples].reverse().find((s) => s.present);
      fail("no-arrival", `watched ${record.watchedMin} min; no ${line.label} bus reached the board stop. Last shown: ${lastSeen?.etaRaw ?? "(no countdown)"}`);
    }
    if (record.samples.length > 2 && !record.samples.some((s) => s.present)) {
      fail("option-vanished", `${line.label} disappeared from the plan and never came back`);
    }
    // A run that read no countdown is a BROKEN CANARY, not a healthy line, and
    // it must never pass. The neighbouring watch at ~/eta-live filed
    // "Purple kept its promises" off a ride with zero recorded promises on
    // 2026-09-03 16:00 — a silent scraper failure that reads exactly like
    // success. Two readings is the minimum that can show a transition at all.
    if (record.sequence.readings < 2 && record.samples.some((s) => s.present)) {
      fail("no-countdown", `${line.label} was on the plan but only ${record.sequence.readings} countdown reading(s) could be parsed in ${record.watchedMin} min — the scraper, not the app, is the likely fault`);
    }
    if (record.pageErrors.length) fail("page-error", record.pageErrors.slice(0, 3).join(" | "));
    record.ok = record.failures.length === 0;
    return record;
  } catch (e) {
    record.endedAt = Date.now();
    record.ok = false;
    record.failures.push({ kind: "fatal", detail: String(e?.stack ?? e), atMs: Date.now() });
    record.pageAtFailure = page
      ? await page.evaluate(() => document.body.innerText).catch((x) => `unreadable: ${x.message}`)
      : "no page";
    record.sequence = scoreSequence(record.samples, THRESH);
    return record;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── log + report ────────────────────────────────────────────────────────────

function append(record) {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(RUNS, `${JSON.stringify(record)}\n`);
  // Keep the log bounded without a cron sweep: a run is ~40 KB, so 400 runs is
  // a fortnight of continuous riding and ~16 MB.
  try {
    const lines = readFileSync(RUNS, "utf8").split("\n").filter(Boolean);
    if (lines.length > 400) writeFileSync(RUNS, `${lines.slice(-400).join("\n")}\n`);
  } catch { /* the log is a convenience, never a reason to fail a run */ }
}

function describeFailure(record) {
  const out = [`🐤 rider-canary: ${record.line}, ${record.trip.from} → ${record.trip.to} (${record.startedAtEt} ET)`];
  for (const f of record.failures) out.push(`   ✗ ${f.kind}: ${f.detail}`);
  const s = record.sequence;
  if (s) out.push(`   sequence: ${s.readings} readings, ${s.reversals} reversal(s), ${s.catastrophic} catastrophic, worst drift ${(s.worstDriftSec / 60).toFixed(1)} min`);
  if (record.pins?.length > 1) {
    const names = [...new Set(record.pins.map((p) => p.busName))];
    out.push(`   pinned bus: ${names.join(" → ")}`);
  }
  out.push(`   full record: ${RUNS} (last line)`);
  return out.join("\n");
}

function summary(days = 7) {
  let lines = [];
  try { lines = readFileSync(RUNS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { console.log("no canary runs recorded yet"); return; }
  const since = Date.now() - days * 86_400_000;
  const runs = lines.filter((r) => r.startedAt >= since);
  if (!runs.length) { console.log(`no canary runs in the last ${days} d`); return; }
  const byLine = new Map();
  for (const r of runs) {
    const e = byLine.get(r.line) ?? { runs: 0, ok: 0, arrived: 0, readings: 0, rev: 0, cat: 0, drifts: [], miss: [] };
    e.runs++; if (r.ok) e.ok++; if (r.arrived) e.arrived++;
    e.readings += r.sequence?.readings ?? 0;
    e.rev += r.sequence?.reversals ?? 0;
    // Re-graded against the CURRENT bar rather than the one each run was
    // written with, so moving the threshold re-reads the whole history
    // instead of leaving old runs judged by a rule nobody remembers.
    for (const t of r.sequence?.transitions ?? []) {
      e.drifts.push(Math.abs(t.driftSec));
      if (Math.abs(t.driftSec) >= THRESH.catastrophicSec) e.cat++;
    }
    if (r.firstSightMissSec != null) e.miss.push(r.firstSightMissSec);
    byLine.set(r.line, e);
  }
  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
  console.log(`\n🐤 RIDER CANARY — last ${days} d, ${runs.length} run(s)\n`);
  console.log(`(catastrophic = |drift| >= ${THRESH.catastrophicSec}s; first-sight miss > ${THRESH.firstSightMissSec}s)\n`);
  console.log("line           runs    ok  arrived  readings  reversals  catastr  p90 drift  worst  1st-sight med");
  for (const [line, e] of byLine) {
    console.log(
      `${line.padEnd(13)} ${String(e.runs).padStart(5)} ${String(e.ok).padStart(5)} ${String(e.arrived).padStart(8)} ` +
      `${String(e.readings).padStart(9)} ${String(e.rev).padStart(10)} ${String(e.cat).padStart(8)} ` +
      `${String(pct(e.drifts, 90) ?? "-").padStart(9)}s ${String(pct(e.drifts, 100) ?? "-").padStart(5)}s ` +
      `${String(pct(e.miss, 50) ?? "-").padStart(12)}s`);
  }
  const bad = runs.filter((r) => !r.ok);
  if (bad.length) {
    console.log(`\n${bad.length} run(s) with findings:`);
    for (const r of bad.slice(-10)) {
      console.log(`  ${new Date(r.startedAt).toISOString().slice(0, 16)}Z  ${r.line.padEnd(12)} ${r.failures.map((f) => f.kind).join(", ")}`);
    }
  }
  console.log();
}

// ── main ────────────────────────────────────────────────────────────────────

async function oneRider() {
  let payload;
  try { payload = await fetchBuses(); }
  catch (e) {
    process.stderr.write(`🐤 rider-canary: cannot reach ${BASE}/api/buses — ${e.message}\n`);
    return { status: "unreachable" };
  }
  const lines = rideableLines(payload);
  const forced = process.env.CANARY_LINE;
  const pool = forced ? lines.filter((l) => l.label === forced) : lines.filter((l) => l.rideable);
  if (!pool.length) {
    say(`nothing rideable: ${lines.map((l) => `${l.label}=${l.liveBuses}`).join(" ")}`);
    return { status: "idle", lines };
  }
  // A monotonic counter, indexed modulo the pool — so the rotation keeps its
  // place when a line drops out of service mid-evening and the pool shrinks.
  // CANARY_LINE does not advance it: forcing one line for an investigation
  // must not leave the rotation parked there afterwards.
  const st = readState();
  const line = pool[st.cursor % pool.length];
  if (!forced) writeState({ ...st, cursor: (st.cursor + 1) % 1e6, lastLine: line.label });
  say(`riding ${line.label} (${line.liveBuses} live buses) — ${line.trip.origin.label} → ${line.trip.destination.display_name} [${line.trip.kind}]`);
  const record = await runOnce(line);
  append(record);
  if (!record.ok) process.stderr.write(`${describeFailure(record)}\n`);
  return { status: record.ok ? "ok" : "finding", record };
}

// Importing this file must never put a browser on the road. Two exploratory
// `import()`s during development each launched a real rider — one of them
// while another was already running, which is the one thing this harness
// promises not to do.
const RUN_AS_SCRIPT = !!process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (!RUN_AS_SCRIPT) {
  // exported for tests and for inspection; nothing runs
} else if (has("--summary")) {
  const i = argv.indexOf("--days");
  summary(i >= 0 ? Number(argv[i + 1]) : 7);
} else if (has("--loop")) {
  // "We should always have a rider going when a line is up." One browser,
  // sequentially, for ever; when nothing is running it sleeps rather than
  // spinning up a chromium to look at an empty map.
  for (;;) {
    const r = await oneRider();
    if (r.status === "idle" || r.status === "unreachable") await sleep(IDLE_SLEEP_MS);
    else await sleep(Math.max(5_000, REST_MS));
  }
} else {
  const r = await oneRider();
  process.exit(r.status === "finding" || r.status === "unreachable" ? 1 : 0);
}
