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
 * TWO RIDERS, TWO BROWSERS, NEVER MORE (operator, 2026-09-06: "one red line
 * rider always when its running and also another always that round Robin
 * through running lines"). In --loop:
 *
 *   [red]       rides CANARY_LINE (default Red) on the operator's own trip
 *               whenever that line has a rideable bus; idles otherwise, and
 *               says so once rather than every cycle.
 *   [rotation]  rides every OTHER running line in turn — CANARY_LINES order,
 *               advancing after each ride, skipping lines with nothing
 *               rideable (scripts/canary-rotation.mjs) — on a random trip
 *               with a bus approaching the board stop. It never rides the
 *               dedicated line; with only that line up, it idles.
 *
 * Before this it was one browser riding Red only, which on a weekend meant
 * "nothing rideable" every ten minutes from dawn to dusk while four lines ran.
 * This Pi rebooted under memory pressure on 2026-09-01 with ten testers
 * running, so two is the cap: one chromium per rider, closed after each
 * watch, and the second launch is staggered so they never spike together.
 * Both riders honour the keepalive's restart flag between watches; the
 * process exits once BOTH have finished their current one.
 *
 * SILENT WHEN HEALTHY. A clean run writes its record and exits 0 with no
 * output. A run that finds something prints it to stderr and exits 1.
 *
 *   node scripts/rider-canary.mjs                  one rider, then exit
 *   node scripts/rider-canary.mjs --loop           keep both riders going
 *   node scripts/rider-canary.mjs --summary        health digest from the log
 *   node scripts/rider-canary.mjs --verbose        narrate the watch
 *
 * Env: BOT_BASE_URL, BOT_CHROMIUM_PATH, CANARY_DIR,
 *      CANARY_LINE (the dedicated rider's line, default Red; without --loop
 *      it forces the one rider onto that line), CANARY_RIDERS (2, or 1 for
 *      the dedicated rider alone), CANARY_DRY_RUN=1 (records go to
 *      runs.dry.jsonl, which nothing ships, and the rotation's place is not
 *      saved), CANARY_TICK_MS, CANARY_WATCH_MAX_MIN, CANARY_CATASTROPHIC_SEC,
 *      CANARY_FIRST_SIGHT_MISS_SEC, CANARY_IDLE_SLEEP_MIN, CANARY_REST_MIN.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as METRICS from "./canary-metrics.mjs";
import {
  ARRIVAL_CLOCK_RE, brokenPromise, CANARY_LINES, deadlineForPromise, fleetOffAir, haversineM,
  isAtBoardStop, isTransportNoise, liveBusesOf, parseOptions, runVerdict, scoreSequence,
  scraperMissedTheCountdown, THRESHOLDS, tripForLine, unexplainedJumps,
} from "./canary-metrics.mjs";
import { DEDICATED_LINE, nextInRotation, randomTripForLine } from "./canary-rotation.mjs";
import { seedTestId } from "./testId.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BASE = (process.env.BOT_BASE_URL || "https://yale-shuttle.fly.dev").replace(/\/$/, "");
const CHROMIUM = process.env.BOT_CHROMIUM_PATH
  || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const DIR = process.env.CANARY_DIR || join(HERE, ".canary");
/**
 * A dry run rides and scores exactly as a real one, but its records go to a
 * file the shipper (canary-ship.mjs reads runs.jsonl) never opens, and the
 * rotation's place is kept in memory only. For test runs beside the live
 * canary: nothing they see reaches /stats or an alert.
 */
const DRY = process.env.CANARY_DRY_RUN === "1";
const RUNS = join(DIR, DRY ? "runs.dry.jsonl" : "runs.jsonl");
const STATE = join(DIR, "state.json");
/** The dedicated rider's line. The keepalive passes CANARY_LINE=Red. */
const DEDICATED = process.env.CANARY_LINE || DEDICATED_LINE;
/** 2 = the dedicated rider plus the rotation; 1 = the dedicated rider alone. */
const RIDERS = Number(process.env.CANARY_RIDERS) === 1 ? 1 : 2;

/** Ground truth poll, matching the collector's own 5 s cadence. */
const TICK_MS = Number(process.env.CANARY_TICK_MS) || 5_000;
/** How often the UI is read. 15 s resolves a one-minute display step four
 *  times over, which is as fine as a minute-bucketed countdown can be read,
 *  and costs one innerText per tick rather than three. */
const SCRAPE_EVERY = 3;
/**
 * How close counts as "the shuttle arrived". 60 m, derived in
 * canary-metrics.mjs from the archive; it used to be 45 m and shared a number
 * with eta-accuracy.mjs, which still keeps its own.
 */
const { ARRIVAL_M } = METRICS;
const IDLE_SLEEP_MS = (Number(process.env.CANARY_IDLE_SLEEP_MIN) || 10) * 60_000;
/**
 * Hard ceiling on one rider's watch, minutes. 25 by default — see the deadline
 * note below. Lowering it is how a derived trip gets probed ("does this line
 * even appear?") without spending a full headway on the answer.
 */
const WATCH_MAX_MIN = Number(process.env.CANARY_WATCH_MAX_MIN) || 25;
/** How often to visit the details view for the pin + anchor column. */
const PIN_SAMPLE_MS = (Number(process.env.CANARY_PIN_SAMPLE_MIN) || 2) * 60_000;
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
// Every line names its rider ("[red]" / "[rotation]"): two riders share one
// log, and a watch narrated without its author is two interleaved stories.
const say = (s, at = Date.now(), tag = "") => {
  if (VERBOSE) process.stderr.write(`[${clock(at)}]${tag ? ` [${tag}]` : ""} ${s}\n`);
};
const tagged = (tag) => (s, at) => say(s, at, tag);

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
 *
 * "Live" is a bus ON the line's route (`liveBusesOf`), which is the app's own
 * test. A bus that merely carries the route id — deadheading in from Hamden
 * before its evening start, parked in the yard with the transponder left on —
 * is a bus the app is right to leave out of every plan, and counting it here
 * turned that into `line-missing` (Blue Night, 2026-09-06 17:42).
 */
export function rideableLines(payload) {
  return CANARY_LINES.map((line) => {
    const trip = tripForLine(payload, line);
    const live = liveBusesOf(payload, line);
    return {
      ...line, trip,
      liveBuses: live.length,
      rideable: !!trip && live.length > 0,
    };
  });
}

// The rotation's place. Only the rotation rider writes it, so two riders in
// one process never race on the file; a dry run keeps it in memory.
let memState = null;
function readState() {
  if (memState) return memState;
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return { cursor: 0 }; }
}
function writeState(s) {
  memState = s;
  if (DRY) return;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

// ── the browser rider ───────────────────────────────────────────────────────

/** Click the collapsed card for `label`. The cards carry no test id and every
 *  style is inline, so the handle is `cursor: pointer` — which only the
 *  collapsed, tappable rows set — plus the card's own arrival clock.
 *
 *  THE CLOCK PATTERN COMES FROM canary-metrics.mjs, never from a copy here.
 *  This function had its own `/arrive \d{1,2}:\d{2}[ap]/`, and when #123
 *  dropped the word "arrive" from the card it matched nothing: no card was
 *  ever tapped, `readPin` returned null, and the whole 12:30 run on
 *  2026-09-04 recorded `board: null`, `pins: []` and a null `distM` on every
 *  bus for 25 minutes — then filed `no-arrival` off ground truth it did not
 *  have. #123 taught `parseOptions` both spellings and could not know this
 *  second reader existed. Now there is one pattern and it is passed in. */
async function openCard(page, label) {
  return page.evaluate(({ l, src, flags }) => {
    const re = new RegExp(src, flags);
    const hasClock = (t) => String(t || "").split("\n").some((x) => re.test(x.trim()));
    const cards = [...document.querySelectorAll("div")].filter((d) =>
      d.style.cursor === "pointer" &&
      hasClock(d.innerText) &&
      (d.innerText || "").includes(l));
    cards.sort((a, b) => a.innerText.length - b.innerText.length);
    if (!cards[0]) return false;
    cards[0].click();
    return true;
  }, { l: label, src: ARRIVAL_CLOCK_RE.source, flags: ARRIVAL_CLOCK_RE.flags });
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
    // "🚌 #316 · 3 stops away" heads the approach list in the details view.
    // It is fed by the findRouteAnchor call at TransitMap.tsx:4079, which
    // bypasses the live anchor store — so this is the column that would
    // reveal an anchor flapping while the countdown itself holds still. The
    // ride pill ("🚌 #316 · 12 min") sits earlier in the DOM, which is why
    // `bus` above matches it and this needs its own, stricter pattern.
    const away = txt.match(/🚌\s*#(\S+)\s*·\s*(\d+)\s*stops?\s*away/);
    return {
      busName: bus ? bus[1] : null,
      board: m ? { lat: Number(m[1]), lon: Number(m[2]) } : null,
      stopsAway: away ? Number(away[2]) : null,
      stopsAwayBus: away ? away[1] : null,
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
  // Intercept the lookup, for DETERMINISM. What this harness measures is the
  // countdown, and every run would otherwise open with a live Photon call
  // behind a shared 1.1 s throttle and a 2.5 s budget — a network flake in the
  // first four seconds would be logged as a canary finding about the planner.
  // Lookup has its own harness (`lookup-sweep.mjs`).
  //
  // It was ALSO the only thing keeping a continuously-running rider out of
  // `search_terms`, which had no anon-id filter. That is no longer this
  // harness's job: as of #61 the server drops a search from an excluded id
  // (`actives.isExcluded` in src/server/app.ts), and `seedTestId` covers us.
  // Kept anyway for the reason above; the shape is the geocoder's own.
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
async function runOnce(line, rider) {
  const say = tagged(rider.tag);
  const startedAt = Date.now();
  const record = {
    startedAt, startedAtEt: clock(startedAt), base: BASE, line: line.label,
    rider: rider.tag, dryRun: DRY || undefined,
    busRouteIds: line.busRouteIds, thresholds: THRESH,
    trip: {
      from: line.trip.origin.label, to: line.trip.destination.display_name, kind: line.trip.kind,
      approaching: line.trip.approaching ?? undefined,
    },
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
    else if (!opts.some((o) => o.routeLabel === line.label) && line.liveBuses > 0) {
      // Guarded on live buses as well as on the pool above: the fleet can go
      // home between the poll that chose this line and the page loading, and
      // "running" must mean vehicles on the road, never a schedule.
      fail("line-missing", `${line.label} is running (${line.liveBuses} live buses) but the plan never offered it; offered: ${opts.map((o) => o.routeLabel).join(", ")}`);
    }
    record.offeredAtStart = opts.map((o) => o.routeLabel);

    // The app's own answer to "which stop am I walking to" and "which bus is
    // this". Everything downstream keys off it.
    const pin0 = await readPin(page, line.label);
    if (pin0) record.pins.push({ atMs: Date.now(), ...pin0, why: "start" });
    const board = pin0?.board ?? null;
    // Only a defect when there was a card to open at all: a line the plan is
    // not offering has no row to tap, and blaming the details view for that
    // is how one off-air evening produced three findings instead of none.
    if (!board && opts.some((o) => o.routeLabel === line.label)) {
      fail("no-board-stop", "could not read the board stop from the details view");
    }
    if (pin0?.stuckInDetails) fail("stuck-in-details", "could not return to the option list after reading the pin; the readings below are the harness's fault, not the app's");
    record.board = board;

    // Timeout: twice what the app promised at first sight, plus six minutes of
    // slack, bounded to [8, 25] min. A bus that has not arrived by twice its
    // own promise is either broken down or badly mispredicted — both worth
    // saying — and 25 min bounds the browser's life on this Pi.
    let deadline = startedAt + Math.min(12, WATCH_MAX_MIN) * 60_000;
    let firstSight = null;
    let arrived = null;
    // The arrival the canary WATCHED happen, as opposed to one it walked up
    // to. Only this one ends the run: a bus already at the stop at first sight
    // is credited (see below) but leaves the interesting question — the next
    // bus — still open.
    let watchedArrival = null;
    let lastScrape = 0;
    let tick = 0;
    // The page's own words on either side of a jump. Without them every claim
    // about what the rider SAW ("and no warning line was shown") rests on the
    // parser rather than on the page, which is not good enough to hand an
    // operator.
    let prevText = null;
    let lastPinSample = 0;
    let boardStopId;
    // Every ground-truth poll, and how many of them the feed refused.
    let feedPolls = 0;
    let feedFails = 0;
    const nearFlags = new Map();

    while (Date.now() < deadline) {
      const now = Date.now();
      // ── ground truth: nothing here reads the app's own numbers ──
      let payload = null;
      feedPolls++;
      try { payload = await fetchBuses(); }
      catch (e) {
        // NOT A FINDING (operator, 2026-09-04). This is the canary's OWN
        // ground-truth fetch timing out — the same class of thing as a blind
        // parser — and no rider saw it. It used to push a failure and so
        // fail the run: `feed-error` appeared on 31 of 59 archived runs and
        // was the sole reason two of them were not `ok`, all of them about
        // this Pi's network rather than about the app. Counted, reported,
        // and harmless. The one case that is NOT harmless is total loss,
        // handled at the end: with no feed at all there is no ground truth,
        // so the run is `unreachable` rather than either verdict.
        feedFails++;
        (record.feedErrors ??= []).push({ detail: String(e.message), atMs: now });
      }
      const routeBuses = (payload?.buses ?? []).filter((b) => line.busRouteIds.includes(b.route_id));
      // The board stop's ID, resolved once from the payload's own coordinates.
      // `readPin` gives a lat/lon (out of the Directions link) and nothing
      // else, but the feed states arrival directly as `at_stop_id`, and that
      // is the operator's own reckoning rather than our metres. The link
      // carries the stop's exact coordinate, so the nearest stop is it — the
      // 5 m guard is only there so a future link format cannot silently bind
      // the wrong stop.
      if (board && boardStopId === undefined && payload?.stop_coords) {
        let best = null;
        for (const [id, c] of Object.entries(payload.stop_coords)) {
          const d = haversineM(board, c);
          if (!best || d < best.d) best = { id: Number(id), d };
        }
        boardStopId = best && best.d <= 5 ? best.id : null;
        record.boardStopId = boardStopId;
      }
      if (board) {
        for (const b of routeBuses) {
          const key = `${b.bus_id}`;
          const d = haversineM(b, board);
          const here = isAtBoardStop(d, b.at_stop_id ?? null, boardStopId);
          const was = nearFlags.get(key) ?? false;
          // A bus ALREADY at the stop on the first poll is an arrival, and it
          // used to be silently armed away as "not an arrival this run watched
          // for". That reasoning was half right and cost seven of the ten
          // `no-arrival` findings in the log: the rider is being shown "now,
          // then 72 min" precisely BECAUSE a bus is at the stop, it pulls away
          // seconds later, and the run then failed for never seeing an
          // arrival it had been looking straight at (2026-09-04, #310 at 38 m
          // with `at_stop_id` naming this stop; #316 at 12 m; #304 at 13 m).
          //
          // So credit it — and keep watching. What was right about the old
          // note is that this arrival must not END the run: nothing has been
          // read yet, and the interesting question is now the NEXT bus. Hence
          // `watchedArrival`, which is what breaks the loop, stays null here.
          //
          // BE PRECISE ABOUT WHAT THIS CREDITS. It says "a bus of this line
          // was at the board stop when the rider walked up", not "the bus the
          // card is pinned to arrived" — this runs before the scrape, so the
          // card has not been read yet. In all seven archived cases they were
          // the same vehicle (the card read "now" BECAUSE of it), but a bus
          // laying over at the stop while the card counts down to a different
          // one would also be credited and would suppress `no-arrival`. That
          // is a deliberate trade: the rider standing there could board it,
          // and a pinned bus that then vanishes is caught by `bus-vanished`
          // rather than by this. `atStart` marks these so the two are never
          // summed by accident.
          if (tick === 0) {
            nearFlags.set(key, here);
            if (here) {
              record.arrivals.push({ atMs: now, busName: b.bus_name, distM: Math.round(d), atStart: true });
              say(`AT THE STOP ALREADY ${b.bus_name} (${Math.round(d)} m) — credited, now watching for the next bus`, now);
              arrived ??= { atMs: now, busName: b.bus_name, atStart: true };
            }
            continue;
          }
          if (!was && here) {
            nearFlags.set(key, true);
            record.arrivals.push({ atMs: now, busName: b.bus_name, distM: Math.round(d) });
            say(`ARRIVAL ${b.bus_name} at the board stop (${Math.round(d)} m)`, now);
            arrived ??= { atMs: now, busName: b.bus_name };
            watchedArrival ??= { atMs: now, busName: b.bus_name };
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
          // Only when nothing parsed — that is the case worth the bytes, and
          // it is the one the archive had no record of.
          ...(mine && !mine.eta && mine.busLines?.length ? { etaUnparsed: mine.busLines } : {}),
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
        }
        // Re-derive the deadline from whatever is on screen NOW, and only ever
        // extend it. A watch that opened on a bus already at the stop was
        // given the 8 minute floor and kept it after the card re-pinned to one
        // 19 min out, so it expired mid-approach and blamed the app. Bounded
        // by WATCH_MAX_MIN from the START of the watch, so a countdown that
        // keeps re-promising cannot hold a browser open for ever.
        if (mine?.eta) {
          const want = deadlineForPromise(now, mine.eta.first[1], WATCH_MAX_MIN, startedAt);
          if (want > deadline) {
            deadline = want;
            say(`watching "${mine.eta.raw}" for up to ${Math.round((deadline - now) / 60000)} more min`, now);
          }
        }
        say(`${line.label}: ${mine ? (mine.eta?.raw ?? (mine.departed ? "Departed" : "no countdown")) : "OPTION GONE"}`, now);

        // A jump is only interesting if we can say what moved. Sampling the
        // pin costs a tap in and out, so it happens on the transitions that
        // matter rather than every tick.
        // A slow heartbeat sample, so the anchor column can be compared with a
        // countdown that is NOT jumping — the question is whether "stops away"
        // moves while the number holds still. Every two minutes: often enough
        // to catch a flap, rare enough that the two-second visit to the
        // details view costs at most one countdown reading in eight.
        if (now - lastPinSample >= PIN_SAMPLE_MS) {
          lastPinSample = now;
          const beat = await readPin(page, line.label).catch(() => null);
          if (beat) record.pins.push({ atMs: Date.now(), ...beat, why: "heartbeat" });
        }

        const seq = scoreSequence(record.samples, THRESH, { pins: record.pins });
        const last = seq.transitions[seq.transitions.length - 1];
        if (last && last.atMs === now && Math.abs(last.driftSec) >= THRESH.pinSampleSec) {
          (record.rawAtJump ??= []).push({
            atMs: now, driftSec: last.driftSec,
            before: prevText ? prevText.slice(0, 3000) : null,
            after: text.slice(0, 3000),
          });
          const pin = await readPin(page, line.label).catch(() => null);
          if (pin) record.pins.push({ atMs: Date.now(), ...pin, why: "jump" });
          if (pin?.stuckInDetails) {
            record.failures.push({ kind: "stuck-in-details", detail: "could not return to the option list after reading the pin; later readings are the harness's fault, not the app's", atMs: Date.now() });
            break;
          }
        }
        prevText = text;
      }

      if (watchedArrival) break;
      await sleep(TICK_MS);
      tick++;
    }

    record.endedAt = Date.now();
    record.watchedMin = +((record.endedAt - startedAt) / 60_000).toFixed(1);
    record.arrived = arrived;
    record.feedPolls = feedPolls;
    record.feedErrorCount = feedFails;
    // Every poll refused: there is no ground truth for this watch at all, so
    // neither "the bus came" nor "it did not" can be said. That is the one
    // feed failure that changes the verdict, and it changes it to a THIRD
    // one — `unreachable`, which the --loop already knows how to sleep on.
    record.feedUnreachable = runVerdict(record) === "unreachable";
    record.sequence = scoreSequence(record.samples, THRESH, { pins: record.pins });

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
    // A jump with a DEPARTURE behind it is the app being honest: the bus
    // reached the stop, pulled away, and the card moved to the next one.
    // #71 measured that at 92.4 % of catastrophic drops, and reporting them
    // as defects is what made every finding need triaging by hand. They are
    // still counted (`catastrophicEventful`) — they just do not fail a run.
    for (const t of unexplainedJumps(record.sequence)) {
      // Which bus moved is now knowable — pairing tells drift apart from a
      // change of cast — so the finding says it. A lurch in the bus-after-the
      // -pinned-one is a real thing riders see, but it is not the countdown
      // they are acting on, and reading one as the other is what this
      // sentence exists to prevent.
      const who = t.leader ? "the bus it is counting down" : "the bus after the pinned one";
      fail("eta-jump", `${who}: "${t.from}" → "${t.to}" in ${t.dtSec} s — ${t.driftSec > 0 ? "+" : ""}${(t.driftSec / 60).toFixed(1)} min beyond what the clock explains${t.pinAnnouncedChange ? " (the app announced a vehicle swap)" : ""}`);
    }
    // FLAPPING is its own defect and this loop is the only thing that sees it.
    // The jump loop above inspects consecutive pairs, so a countdown swinging
    // between two states 72 s apart — 4:36, 1:57, 3:09, 3:09, 1:57, 2:46 on Red
    // on the morning of 2026-09-09 — passes it clean while a rider standing
    // there cannot tell whether to run. Events are already excluded from a flap
    // chain, so what is left is the number arguing with itself.
    for (const f of record.sequence.flaps ?? []) {
      const who = f.leader ? "the bus it is counting down" : "the bus after the pinned one";
      fail("eta-flap", `${who}: ${f.shown.join(" → ")} — ${f.moves} alternating moves in ${f.spanSec} s, swinging ${(f.swingSec / 60).toFixed(1)} min, none of them an event`);
    }
    // A bus the rider was about to board leaving the list is its OWN defect,
    // not a drift, and the positional metric used to bill it as one. Only the
    // severe case fails a run: a trailing bus dropping out of the second slot
    // is `nextArrivalAfterPinned` finding nothing later, which is routine.
    for (const d of record.sequence.drops ?? []) {
      if (!d.severe || d.eventful) continue;
      fail("bus-vanished", `"${d.from}" → "${d.to}" in ${d.dtSec} s — the bus shown ${d.lastShownEtaSec < 60 ? "as arriving" : `${Math.round(d.lastShownEtaSec / 60)} min out`} left the list without arriving${d.pinAnnouncedChange ? " (the app announced a vehicle swap)" : ""}`);
    }
    // With no feed at all, "no bus reached the stop" is a statement about our
    // own network, not about the app — the arrival detector never got a
    // single position to judge.
    if (!arrived && !record.feedUnreachable && board && record.samples.some((s) => s.present)) {
      const lastSeen = [...record.samples].reverse().find((s) => s.present);
      // "No bus came" is two different things wearing one face, and calling
      // them both a failure made the canary cry wolf through every long Red
      // headway. A promise that ELAPSED with us still watching is the app's
      // fault. A watch the 25-minute ceiling cut short before the bus was
      // ever due is ours, and is not a finding.
      const broken = brokenPromise(record.samples, record.endedAt);
      record.brokenPromise = broken;
      if (broken) {
        fail("no-arrival", `watched ${record.watchedMin} min; no ${line.label} bus reached the board stop. The app said "${broken.raw}" and that came due ${Math.round(broken.overdueSec / 60)} min before the watch ended. Last shown: ${lastSeen?.etaRaw ?? "(no countdown)"}`);
      } else {
        record.unfinished = `watched ${record.watchedMin} min and stopped before any promise came due; last shown "${lastSeen?.etaRaw ?? "(no countdown)"}"`;
        say(`unfinished: ${record.unfinished}`);
      }
    }
    if (record.samples.length > 2 && !record.samples.some((s) => s.present)) {
      // An option vanishing is a defect ONLY while the line still has buses.
      // Once the last one goes off-air the app is right to drop the route,
      // and the watch simply has nothing left to watch.
      if (fleetOffAir(record.samples)) {
        record.unfinished = `${line.label} went off-air during the watch (no live buses on the line); nothing left to watch after ${record.watchedMin} min`;
        say(`unfinished: ${record.unfinished}`);
      } else {
        fail("option-vanished", `${line.label} disappeared from the plan and never came back`);
      }
    }
    // A run that read no countdown is a BROKEN CANARY, not a healthy line, and
    // it must never pass. The neighbouring watch at ~/eta-live filed
    // "Purple kept its promises" off a ride with zero recorded promises on
    // 2026-09-03 16:00 — a silent scraper failure that reads exactly like
    // success. Two readings is the minimum that can show a transition at all.
    // ...unless the bus was already there when the watch opened; see
    // `scraperMissedTheCountdown` for the four archived findings that was.
    if (scraperMissedTheCountdown({
      readings: record.sequence.readings,
      anyPresent: record.samples.some((s) => s.present),
      arrived: !!arrived,
    })) {
      fail("no-countdown", `${line.label} was on the plan but only ${record.sequence.readings} countdown reading(s) could be parsed in ${record.watchedMin} min — the scraper, not the app, is the likely fault`);
    }
    // A browser network log is not a page error. See `isTransportNoise`: the
    // canary's own link drops requests, no rider saw it, and the operator made
    // this exact ruling for `feed-error`. Counted on the record, never failed.
    const realErrors = record.pageErrors.filter((e) => !isTransportNoise(e));
    record.transportNoiseCount = record.pageErrors.length - realErrors.length;
    if (realErrors.length) fail("page-error", realErrors.slice(0, 3).join(" | "));
    // One decision point, shared with the loop's status. An unreachable run is
    // NOT ok — there was nothing to judge — but it is not a finding either.
    record.ok = runVerdict(record) === "ok";
    return record;
  } catch (e) {
    record.endedAt = Date.now();
    record.ok = false;
    record.failures.push({ kind: "fatal", detail: String(e?.stack ?? e), atMs: Date.now() });
    record.pageAtFailure = page
      ? await page.evaluate(() => document.body.innerText).catch((x) => `unreadable: ${x.message}`)
      : "no page";
    record.sequence = scoreSequence(record.samples, THRESH, { pins: record.pins });
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
  const who = record.rider ? `rider-canary [${record.rider}]` : "rider-canary";
  const out = [`🐤 ${who}: ${record.line}, ${record.trip.from} → ${record.trip.to} (${record.startedAtEt} ET)${record.dryRun ? " [dry run]" : ""}`];
  for (const f of record.failures) out.push(`   ✗ ${f.kind}: ${f.detail}`);
  const s = record.sequence;
  if (s) out.push(`   sequence: ${s.readings} readings (${s.spreadReadings ?? 0} standing), ${s.reversals} reversal(s), ${s.catastrophic} catastrophic (${s.leaderCatastrophic ?? 0} on the pinned bus), ${s.flapping ?? 0} flap(s), worst drift ${(s.worstDriftSec / 60).toFixed(1)} min`);
  if (s?.dropped) out.push(`   vehicles: ${s.dropped} dropped out of the list (${s.droppedSevere} within ${THRESH.droppedSevereSec / 60} min, ${s.droppedSevereEventful ?? 0} of those explained by the bus pulling away), ${s.appeared} took over the head of it`);
  if (record.feedErrorCount) out.push(`   the canary's own feed refused ${record.feedErrorCount} of ${record.feedPolls} polls (not counted against the app)`);
  if (s?.catastrophicEventful) out.push(`   not counted against the app: ${s.catastrophicEventful} catastrophic jump(s) had the bus visibly leaving the stop`);
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
    const e = byLine.get(r.line) ?? { runs: 0, ok: 0, arrived: 0, readings: 0, standing: 0, flaps: 0, rev: 0, cat: 0, drop: 0, sev: 0, unfin: 0, feed: 0, drifts: [], miss: [] };
    e.runs++; if (r.ok) e.ok++; if (r.arrived) e.arrived++;
    e.readings += r.sequence?.readings ?? 0;
    // Standing-bus polls were unparsed before 2026-09-09 and simply skipped;
    // `standing` is how many of `readings` are that kind, so a before/after
    // over the archive can split on it instead of comparing across it.
    e.standing += r.sequence?.spreadReadings ?? 0;
    e.flaps += r.sequence?.flapping ?? 0;
    e.rev += r.sequence?.reversals ?? 0;
    // Re-graded against the CURRENT bar rather than the one each run was
    // written with, so moving the threshold re-reads the whole history
    // instead of leaving old runs judged by a rule nobody remembers.
    for (const t of r.sequence?.transitions ?? []) {
      e.drifts.push(Math.abs(t.driftSec));
      if (Math.abs(t.driftSec) >= THRESH.catastrophicSec) e.cat++;
    }
    // Runs recorded before 2026-09-04 have no `drops` — they were scored
    // positionally, so a vanishing bus is inside their drift column instead.
    // Absent is counted as zero rather than back-filled, because the samples
    // are on the record and a re-score is the honest way to restate them.
    for (const d of r.sequence?.drops ?? []) {
      e.drop++;
      if (d.lastShownEtaSec <= THRESH.droppedSevereSec) e.sev++;
    }
    // A watch the 25-minute ceiling cut short before any promise came due.
    // Not a finding, but invisible otherwise, and the operator needs to know
    // how much of the rotation is spending its browser on nothing.
    if (r.unfinished) e.unfin++;
    // Counted from BOTH places: runs before 2026-09-04 carry feed errors
    // inside `failures`, where they also failed the run; later ones carry
    // them in `feedErrors`, where they fail nothing.
    e.feed += (r.feedErrorCount ?? (r.failures ?? []).filter((f) => f.kind === "feed-error").length);
    if (r.firstSightMissSec != null) e.miss.push(r.firstSightMissSec);
    byLine.set(r.line, e);
  }
  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
  console.log(`\n🐤 RIDER CANARY — last ${days} d, ${runs.length} run(s)\n`);
  console.log(`(catastrophic = |drift| >= ${THRESH.catastrophicSec}s; a drop is severe within ${THRESH.droppedSevereSec}s; first-sight miss > ${THRESH.firstSightMissSec}s)\n`);
  console.log("line           runs    ok  arrived  unfin  feed  readings  standing  flaps  reversals  catastr  dropped  severe  p90 drift  worst  1st-sight med");
  for (const [line, e] of byLine) {
    console.log(
      `${line.padEnd(13)} ${String(e.runs).padStart(5)} ${String(e.ok).padStart(5)} ${String(e.arrived).padStart(8)} ` +
      `${String(e.unfin).padStart(6)} ${String(e.feed).padStart(5)} ${String(e.readings).padStart(9)} ${String(e.standing).padStart(9)} ${String(e.flaps).padStart(6)} ${String(e.rev).padStart(10)} ${String(e.cat).padStart(8)} ` +
      `${String(e.drop).padStart(8)} ${String(e.sev).padStart(7)} ` +
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

// ── the two riders ──────────────────────────────────────────────────────────
//
// A rider is a tag plus a `pick`: given every line's rideability and the
// payload it came from, the line to ride now (with its trip attached) or null
// to idle. Everything else — the browser, the scoring, the record — is shared.

/**
 * The dedicated rider: one line, the operator's own trip, whenever that line
 * has a rideable bus. `tripForLine` gives Red the canonical trip (boards at
 * Division / Prospect, stop 48, as the app chooses it).
 *
 * The pick never skips the rideable test. It used to, so the keepalive's
 * CANARY_LINE=Red kept riding Red after the last bus went home: a twelve
 * minute watch of an empty line on 2026-09-04, filing `line-missing` ("Red
 * is running (0 live buses)") against an app that was right to stop offering
 * it. Zero live buses is `idle` — the loop sleeps and asks again.
 */
const dedicatedRider = (label) => ({
  tag: label.toLowerCase().replace(/\s+/g, "-"),
  pick(lines) {
    const line = lines.find((l) => l.label === label);
    if (!line) return { idle: `${label} is not a line this canary knows` };
    if (line.rideable) return line;
    return { idle: line.liveBuses > 0
      ? `${label} has ${line.liveBuses} live bus(es) but no trip can be built on it`
      : `${label} has no live buses` };
  },
});

/**
 * The rotation rider: every other running line in turn, on a random trip
 * with a bus approaching (canary-rotation.mjs). `excluded` is the dedicated
 * rider's line, or null when this is the only rider (no --loop, no
 * CANARY_LINE) and every line takes its turn.
 *
 * The place is kept as the LABEL last ridden, not a counter: forcing one
 * line for an investigation must not park the rotation there, and a line
 * dropping out of service must not shift every other line's turn.
 */
const rotationRider = (excluded) => ({
  tag: "rotation",
  pick(lines, payload) {
    const st = readState();
    let last = st.lastLine ?? null;
    const skipped = [];
    // A line with no ride the planner would offer is SKIPPED this cycle — it
    // still takes its turn, so the rotation moves on — and never ridden on a
    // fallback trip: on 2026-09-06 Grocery Ham's fixed pair was the long way
    // round a 6-stop loop and the canary filed two findings against a
    // healthy app. Bounded by the number of lines, so it cannot spin.
    for (let tries = 0; tries < lines.length; tries++) {
      const line = nextInRotation(lines, last, excluded);
      if (!line) break;
      writeState({ ...st, lastLine: line.label, ridden: (st.ridden ?? 0) + 1 });
      last = line.label;
      const { trip, reason } = randomTripForLine(payload, line);
      if (trip) return { ...line, trip, skipped };
      skipped.push(`${line.label}: ${reason}`);
    }
    const up = lines.filter((l) => l.liveBuses > 0).map((l) => l.label);
    const why = skipped.length
      ? `every rideable line was skipped this cycle (${skipped.join("; ")})`
      : excluded && up.length && up.every((l) => l === excluded)
        ? `only ${excluded} is running, and it has its own rider`
        : `no line${excluded ? ` other than ${excluded}` : ""} is rideable`;
    return { idle: why };
  },
});

async function oneRider(rider) {
  const say = tagged(rider.tag);
  let payload;
  try { payload = await fetchBuses(); }
  catch (e) {
    process.stderr.write(`🐤 rider-canary [${rider.tag}]: cannot reach ${BASE}/api/buses — ${e.message}\n`);
    return { status: "unreachable" };
  }
  const lines = rideableLines(payload);
  const line = rider.pick(lines, payload);
  if (!line || line.idle) {
    return {
      status: "idle", lines,
      why: `${line?.idle ?? "nothing to ride"}: ${lines.map((l) => `${l.label}=${l.liveBuses}`).join(" ")}`,
      // Idle is logged when the REASON changes, not every cycle; the bus
      // counts wobble and are printed only alongside a new reason.
      key: line?.idle ?? "",
    };
  }
  for (const sk of line.skipped ?? []) say(`skipping ${sk}`);
  const t = line.trip;
  const est = t.estimate ? `, ${t.estimate.hops} hop(s) ~${Math.round(t.estimate.rideSec / 60)} min ride vs ${Math.round(t.estimate.walkSec / 60)} min walk` : "";
  const via = t.approaching ? ` with ${t.approaching.busName} ${t.approaching.stopsAway} stop(s) out${est}` : "";
  say(`riding ${line.label} (${line.liveBuses} live buses) — ${t.origin.label} → ${t.destination.display_name} [${t.kind}]${via}`);
  const record = await runOnce(line, rider);
  append(record);
  if (runVerdict(record) === "unreachable") {
    // Neither `ok` nor a finding: the watch happened, the app may have been
    // perfect, and we cannot say. Said out loud so a network outage is not
    // mistaken for a quiet healthy night.
    process.stderr.write(`🐤 rider-canary [${rider.tag}]: ${line.label} watched ${record.watchedMin} min but ${BASE}/api/buses refused all ${record.feedPolls} polls — no ground truth, nothing judged\n`);
    return { status: "unreachable", record };
  }
  if (!record.ok) process.stderr.write(`${describeFailure(record)}\n`);
  else say(`${line.label}: clean run, ${record.sequence.readings} readings, watched ${record.watchedMin} min`);
  return { status: record.ok ? "ok" : "finding", record };
}

// ── the loop ────────────────────────────────────────────────────────────────

const FLAG = join(DIR, "restart-requested");
/** Set once any rider sees the flag; every loop drains on it. */
let stopping = false;

/** Sleep, but glance at the flag every 15 s and wake early once a restart is
 *  pending, so an idle rider never holds the process open for its whole
 *  ten-minute nap. */
async function rest(ms) {
  const until = Date.now() + ms;
  while (!stopping && Date.now() < until) {
    await sleep(Math.min(15_000, until - Date.now()));
    if (existsSync(FLAG)) stopping = true;
  }
}

/**
 * One rider's life. Each turn: honour a pending restart, else ride or idle.
 * The keepalive asks for a restart by touching FLAG rather than killing the
 * process: a kill mid-watch aborts the run, files "page-unreadable" +
 * "no-arrival" against a healthy app, and on a day master moves every twenty
 * minutes that is most runs. Honoured only between watches, so the current
 * one always completes — and with two riders, the process waits for both.
 */
async function riderLoop(rider, { delayMs = 0 } = {}) {
  const say = tagged(rider.tag);
  await rest(delayMs);
  let idleKey = null;
  while (!stopping) {
    if (existsSync(FLAG)) {
      stopping = true;
      console.log(`[canary] restart requested; [${rider.tag}] stopping between watches`);
      break;
    }
    const r = await oneRider(rider);
    if (r.status === "idle") {
      if (r.key !== idleKey) { say(`idle — ${r.why}`); idleKey = r.key; }
      await rest(IDLE_SLEEP_MS);
    } else if (r.status === "unreachable") {
      idleKey = null;
      await rest(IDLE_SLEEP_MS);
    } else {
      idleKey = null;
      await rest(Math.max(5_000, REST_MS));
    }
  }
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
  // "We should always have a rider going when a line is up." Two riders, one
  // browser each, for ever; when nothing is running they sleep rather than
  // spinning up a chromium to look at an empty map.
  //
  // A flag older than this process is stale: the keepalive only asks a
  // RUNNING canary to restart, and a fresh one that exited on a leftover
  // flag (a kill -9 leaves one) would cost five minutes for nothing.
  if (existsSync(FLAG)) {
    try { unlinkSync(FLAG); } catch {}
    console.log("[canary] cleared a restart flag left from before this start");
  }
  if (DRY) console.log(`[canary] DRY RUN — records go to ${RUNS}, nothing is shipped`);
  console.log(`[canary] ${RIDERS === 1 ? `one rider: [${DEDICATED.toLowerCase()}]` : `two riders: [${DEDICATED.toLowerCase()}] and [rotation] over every other line`}`);
  const riders = [riderLoop(dedicatedRider(DEDICATED))];
  // Staggered: two chromiums starting in the same second is the spike that
  // hurts this Pi, not two running (fleet.sh learned the same thing).
  if (RIDERS === 2) riders.push(riderLoop(rotationRider(DEDICATED), { delayMs: 20_000 }));
  await Promise.all(riders);
  try { unlinkSync(FLAG); } catch {}
  console.log("[canary] restart requested; exiting — every rider is between watches");
  process.exit(0);
} else {
  // One rider, then exit: CANARY_LINE forces the line, else the rotation
  // takes the next turn across EVERY line, the dedicated one included.
  const rider = process.env.CANARY_LINE ? dedicatedRider(DEDICATED) : rotationRider(null);
  const r = await oneRider(rider);
  if (r.status === "idle") say(`idle — ${r.why}`, Date.now(), rider.tag);
  process.exit(r.status === "finding" || r.status === "unreachable" ? 1 : 0);
}
