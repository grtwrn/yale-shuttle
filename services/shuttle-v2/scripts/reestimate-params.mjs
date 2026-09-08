#!/usr/bin/env node
/**
 * RE-ESTIMATE — stages 3 and 4 of the closed loop (docs/closed-loop.md).
 *
 * Once a day, on the Pi:
 *
 *   1. COUNT the ring estimator's re-estimable constants on the last N
 *      archived days (default 14) — the deadband emissions, the two hold
 *      hazards, the shuffle rate, the departure prior — exactly as
 *      docs/eta-error-budget.md defined them. `scripts/reestimate-lib.mjs`
 *      holds the counters; this file is the I/O around them.
 *   2. REPLAY the last few archived days through the real client
 *      (`gps-replay.ts`, which imports web/src/arrivals.ts and therefore the
 *      ring estimator itself), once with the CHAMPION's parameters and once
 *      with the CHALLENGER's, and score both under the scorecard's rules.
 *   3. FIT the conformal widening of the 10-90 band per horizon bucket on all
 *      but the last replay day, and CHECK it on the last.
 *   4. DECIDE. Publish only if the challenger is no worse than the champion by
 *      more than a noise bound measured from the champion's own day-to-day
 *      spread; otherwise keep the champion. Either way the comparison is
 *      written to `scorecard_days` as `replay:champion` / `replay:challenger`,
 *      so the dashboard shows what was tried and what happened.
 *
 * WHY THE ARCHIVE AND NOT THE VOLUME. `raw_positions` is swept after 6 h in
 * production; the day a fit needs is only ever on the Pi (stage 2).
 *
 * WHY DAILY AND NOT HOURLY. Every quantity here is stationary over days — a
 * stop's departure hazard and the emission probability of a repeated fix do
 * not change hour to hour — so an hourly re-fit on a sliding window would add
 * noise, and a 03:00 fit on two hours of night-route data would be actively
 * wrong. The scorecard is the hourly half of the loop.
 *
 * NOTHING IS PUBLISHED THAT CANNOT BE DEFENDED. A key whose sample is under
 * its floor keeps the champion's value; so does one outside its accepted range
 * or further from the compiled constant than the drift bound, and the reason
 * is printed and stored. Refusing is the normal outcome for a quiet key, not
 * an error.
 *
 * Usage:
 *   TZ=America/New_York node scripts/reestimate-params.mjs --dry-run
 *   TZ=America/New_York node scripts/reestimate-params.mjs           # publishes
 *
 * Options:
 *   --dry-run          fit, replay, decide, print — POST nothing
 *   --days N           counting window, default 14 archived days
 *   --replay-days N    days to replay for the promotion, default 3
 *   --no-replay        skip stage 4 entirely; then nothing is ever published
 *                      (a decision without a measurement is not a decision)
 *   --allow-drift      publish a value further from the compiled constant than
 *                      its drift bound. For a deliberate re-measurement only.
 *   --base PATH        the snapshot supplying topology and prior calibration
 *                      (default ./store/snap-0906-1230.db, or SNAPSHOT_DB)
 *   --archive DIR      default ~/shuttle-archive (ARCHIVE_DIR)
 *   --base-url URL     default https://yale-shuttle.fly.dev (SHUTTLE_BASE)
 *   --work DIR         scratch for the replay databases, default scripts/.reestimate
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import {
  COMPILED, HORIZONS, SCALAR_KEYS, assembleCandidate, conformalFit, distanceMeters, estimateEmissions,
  estimateVisitRates, fitRouteScales, pooled, promotionDecision, sameParams, scaleEffect, scoreRows,
  tracksByName, zoneTester,
} from "./reestimate-lib.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");

// -- arguments ------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const DRY = flag("--dry-run");
const ALLOW_DRIFT = flag("--allow-drift");
const NO_REPLAY = flag("--no-replay");
const WINDOW_DAYS = Math.max(1, Number(opt("--days", 14)));
const REPLAY_DAYS = Math.max(2, Number(opt("--replay-days", 3)));
const ARCHIVE = opt("--archive", process.env.ARCHIVE_DIR ?? path.join(os.homedir(), "shuttle-archive"));
const BASE_DB = path.resolve(ROOT, opt("--base", process.env.SNAPSHOT_DB ?? "store/snap-0906-1230.db"));
const BASE_URL = opt("--base-url", process.env.SHUTTLE_BASE ?? "https://yale-shuttle.fly.dev");
const WORK = path.resolve(ROOT, opt("--work", "scripts/.reestimate"));
const TOKEN_FILE = process.env.SHUTTLE_ADMIN_TOKEN_FILE ?? path.join(os.homedir(), ".yale-shuttle-admin-token");

const log = (...a) => console.log(...a);
const die = (msg) => { console.error(msg); process.exit(1); };

// -- the archive ----------------------------------------------------------------

function archivedDays() {
  if (!fs.existsSync(ARCHIVE)) return [];
  return fs.readdirSync(ARCHIVE)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(ARCHIVE, d, "manifest.json")))
    .sort();
}

/** One archived table as rows. Absent file = no rows, which is a legitimate day. */
function readRows(day, table) {
  const file = path.join(ARCHIVE, day, `${table}.jsonl.gz`);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of zlib.gunzipSync(fs.readFileSync(file)).toString("utf8").split("\n")) {
    if (line) out.push(JSON.parse(line));
  }
  return out;
}

// -- topology -------------------------------------------------------------------

/** Stop coordinates and each route's stop list, for the in-a-stop's-zone split. */
function topology() {
  const Database = require("better-sqlite3");
  const db = new Database(BASE_DB, { readonly: true });
  const stopCoords = {};
  for (const s of db.prepare("SELECT id, lat, lon FROM stops").all()) stopCoords[s.id] = { lat: s.lat, lon: s.lon };
  const routes = db.prepare("SELECT id, stops_json FROM routes").all()
    .map((r) => ({ id: r.id, stops: JSON.parse(r.stops_json) }));
  db.close();
  return { stopCoords, routes };
}

/**
 * Per route, the share of the published lap's ROAD METRES whose hop has no
 * served drive quantiles — the part of the lap priced from the network's
 * pooled pace rather than from anything the collector timed. It is the guard
 * on the per-route scale: a route in that state is not biased, it is
 * incomplete, and its shortfall closes on its own as the collector fills the
 * hops (docs/route-bias.md, "Green").
 *
 * `legM` where the patch carries it, the chord between the two stops where it
 * does not — a hop with no row at all has no length of its own to report, and
 * the chord is a lower bound on it, which makes the guard conservative in the
 * direction that matters (it never understates a big missing hop by more than
 * the road's bow).
 */
function pooledShares(patchFiles, routes, stopCoords) {
  const worst = {};
  for (const file of patchFiles) {
    let patch;
    try { patch = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    for (const r of routes) {
      const seg = patch.segments?.[String(r.id)] ?? {};
      let total = 0, pooled = 0;
      for (let i = 0; i < r.stops.length; i++) {
        const a = r.stops[i], b = r.stops[(i + 1) % r.stops.length];
        const row = seg[`${a}-${b}`];
        const ca = stopCoords[a], cb = stopCoords[b];
        const m = row?.legM ?? (ca && cb ? distanceMeters(ca, cb) : 0);
        total += m;
        if (!row?.dq) pooled += m;
      }
      const share = total > 0 ? pooled / total : 1;
      const key = String(r.id);
      if (worst[key] === undefined || share > worst[key]) worst[key] = share;
    }
  }
  return worst;
}

// -- the replay -----------------------------------------------------------------

/** ET midnight of an ET day, as an ISO instant — the calibration is taken there. */
function etMidnightIso(day) {
  // The offset that makes 00:00 ET on `day`: try both, keep the one that reads back.
  for (const offset of [4, 5]) {
    const guess = new Date(`${day}T0${offset}:00:00.000Z`);
    const back = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(guess);
    const get = (t) => back.find((p) => p.type === t)?.value;
    if (`${get("year")}-${get("month")}-${get("day")}` === day && Number(get("hour")) % 24 === 0) return guess.toISOString();
  }
  return `${day}T04:00:00.000Z`;
}

function run(cmd, args, env, label) {
  const t0 = Date.now();
  try {
    execFileSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const tail = String(e.stderr ?? "").split("\n").slice(-12).join("\n");
    die(`${label} failed:\n${tail}`);
  }
  log(`  ${label} ${(Date.now() - t0) / 1000}s`);
}

/**
 * One archived day as a replay database plus its time-travelled calibration.
 * Both are cached on disk: rebuilding them is the slow half and they do not
 * depend on the parameters under test.
 */
function prepareDay(day) {
  const db = path.join(WORK, `replay-${day}.db`);
  const patch = path.join(WORK, `patch-${day}.json`);
  if (!fs.existsSync(db)) {
    run("npx", ["tsx", "scripts/eta-replay/archive-db.ts", day, BASE_DB, db], { TZ: "America/New_York", ARCHIVE_DIR: ARCHIVE }, `archive-db ${day}`);
  }
  if (!fs.existsSync(patch)) {
    run("npx", ["tsx", "scripts/eta-replay/model-patch.ts"], {
      TZ: "America/New_York", REPLAY_DB: db, MODEL_OUT: patch,
      MODEL_NOW: etMidnightIso(day), MODEL_ROUTES: "all",
    }, `model-patch ${day}`);
  }
  return { db, patch };
}

/**
 * Replay one day through the real client under one parameter set and return
 * the PATH of its pairs file. `params` is null for the compiled constants.
 * The CONFORMAL table is deliberately NOT applied here — the bands come out
 * raw and both arms are widened afterwards by `scoreRows`, so the champion's
 * widening and the challenger's are compared by the same code on the same
 * bands.
 *
 * A path, not an array: a weekday is ~820,000 pairs (~63 MB of JSON lines) and
 * holding three days times two arms as objects is ~2.5 GB, which this Pi does
 * not have. Everything downstream streams the file instead (`readPairs`), and
 * an existing file is reused — so an interrupted run resumes at the replay it
 * had reached rather than starting over.
 */
function replayFile(day, prepared, arm, params) {
  const out = path.join(WORK, `pairs-${day}-${arm}.jsonl`);
  // MODEL_ROUTES is deliberately NOT set: unset means gps-replay uses the
  // tree's own allowlist (web/src/eta/index.ts MODEL_ROUTE_IDS), which is
  // production. Setting it to "all" would build the set {"all"}, match no
  // route id, and quietly score the LEGACY arithmetic on every line —
  // measuring an estimator no rider is running. (model-patch.ts below reads
  // the same variable with a different meaning, which is why it is passed
  // there and not here.)
  const env = {
    TZ: "America/New_York", REPLAY_DB: prepared.db, PAYLOAD_PATCH: prepared.patch,
    PAIRS_OUT: out, REPLAY_OUT: WORK,
  };
  if (params) {
    const file = path.join(WORK, `params-${arm}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: arm, publishedAt: 0, params: { ...params, CONFORMAL: { "0-2": 1, "2-5": 1, "5-10": 1, "10-30": 1 } } }));
    env.MODEL_PARAMS = file;
  }
  if (!fs.existsSync(out)) run("npx", ["tsx", "scripts/eta-replay/gps-replay.ts"], env, `gps-replay ${day} ${arm}`);
  return out;
}

/**
 * One pair at a time from a pairs file. The whole file is read as one string —
 * 63 MB, fine — but never split into an array of 820,000 strings, which is
 * where the memory went.
 */
function* readPairs(file) {
  const text = fs.readFileSync(file, "utf8");
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf("\n", i);
    const end = j === -1 ? text.length : j;
    if (end > i) yield JSON.parse(text.slice(i, end));
    i = end + 1;
  }
}

/** The pairs of several files in sequence, still one at a time. */
function* readAllPairs(files) {
  for (const f of files) yield* readPairs(f);
}

// -- the server -----------------------------------------------------------------

function adminToken() {
  const env = process.env.SHUTTLE_ADMIN_TOKEN;
  if (env) return env.trim();
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  return "";
}

async function api(method, route, body, { soft404 = false } = {}) {
  const token = adminToken();
  if (!token) die(`no admin token (${TOKEN_FILE} or SHUTTLE_ADMIN_TOKEN)`);
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: { "x-admin-token": token, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (res.status === 404 && soft404) return null;
  if (!res.ok) die(`${method} ${route} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * The set in force. Null = the client's compiled constants — which is also
 * what a server too old to know the route is serving, so a 404 here is a fact
 * about the champion, not an error.
 */
async function champion() {
  if (!adminToken()) {
    if (!DRY) die(`no admin token (${TOKEN_FILE} or SHUTTLE_ADMIN_TOKEN)`);
    return null;
  }
  const r = await api("GET", "/api/stats/model-params", null, { soft404: true });
  if (r === null) log(`${BASE_URL} has no /api/stats/model-params — the champion is the compiled constants`);
  return r?.current?.params ?? null;
}

// -- main -----------------------------------------------------------------------

const round5 = (x) => Math.round(x * 1e5) / 1e5;

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  const days = archivedDays();
  if (days.length === 0) die(`no archived days under ${ARCHIVE}`);
  const window = days.slice(-WINDOW_DAYS);
  log(`archive ${ARCHIVE}: ${days.length} days, counting on ${window.length} (${window[0]} .. ${window[window.length - 1]})`);

  // -- stage 3a: count ---------------------------------------------------------
  const { stopCoords, routes } = topology();
  const positions = [];
  const visits = [];
  for (const d of window) {
    for (const r of readRows(d, "raw_positions")) positions.push(r);
    for (const r of readRows(d, "stop_visits")) visits.push(r);
  }
  log(`positions ${positions.length}, stop visits ${visits.length}`);
  const fits = { ...estimateEmissions(tracksByName(positions), zoneTester(routes, stopCoords)), ...estimateVisitRates(visits) };

  const champ = (await champion()) ?? { ...COMPILED, CONFORMAL: { ...COMPILED.CONFORMAL } };
  const servedIsCompiled = sameParams(champ, COMPILED);
  log(`champion: ${servedIsCompiled ? "the compiled constants" : "a published set"}`);
  log("");
  log("key                    fitted    compiled   champion          n");
  for (const k of SCALAR_KEYS) {
    const f = fits[k];
    log(`${k.padEnd(20)} ${(f.value === null ? "-" : round5(f.value).toFixed(5)).padStart(9)} ${String(COMPILED[k]).padStart(10)} ${String(champ[k]).padStart(10)} ${String(f.n).padStart(10)}`);
  }

  // -- stage 4: replay ---------------------------------------------------------
  const replayDays = days.slice(-REPLAY_DAYS);
  let conformal = null;
  let decision = null;
  let routeScaleFit = null;
  let routeScaleHeldOut = null;
  let candidate = assembleCandidate(fits, null, champ, { allowDrift: ALLOW_DRIFT });

  if (!NO_REPLAY) {
    if (replayDays.length < 2) die(`need at least 2 archived days to fit and hold one out; have ${replayDays.length}`);
    const heldOut = replayDays[replayDays.length - 1];
    log("");
    log(`replaying ${replayDays.join(", ")} (conformal fitted on ${replayDays.slice(0, -1).join(", ")}, held out ${heldOut})`);
    const prepared = {};
    const champFile = {};
    for (const d of replayDays) {
      prepared[d] = prepareDay(d);
      champFile[d] = replayFile(d, prepared[d], "champion", servedIsCompiled ? null : champ);
      log(`  ${d}: ${(fs.statSync(champFile[d]).size / 1e6).toFixed(1)} MB of pairs`);
    }
    // The widening is fitted on the champion's own raw bands, on every replay
    // day but the last, and the last is the honest check of it.
    conformal = conformalFit(readAllPairs(replayDays.slice(0, -1).map((d) => champFile[d])));
    log("");
    log("conformal (band x, to reach 80% coverage):");
    for (const h of HORIZONS) log(`  ${h.padEnd(6)} ${conformal[h].w === null ? "-" : conformal[h].w} (n ${conformal[h].n}${conformal[h].infinite ? `, ${conformal[h].infinite} needed an infinite factor` : ""})`);

    // The per-route scale, fitted on the same days as the widening and held
    // out on the same last one. It needs no replay of its own: the correction
    // is the last step of pricing and feeds nothing back, so a scaled pair is
    // exactly `eta * s` and the held-out check is arithmetic on the
    // champion's own pairs. (The challenger replay below still runs, and the
    // fidelity line after it is what says the arithmetic and the client agree.)
    const shares = pooledShares(replayDays.map((d) => prepared[d].patch), routes, stopCoords);
    const rawScales = routeScaleFit = fitRouteScales(readAllPairs(replayDays.slice(0, -1).map((d) => champFile[d])), { coverage: shares });
    const heldOutEffect = routeScaleHeldOut = { day: heldOut, ...scaleEffect(readPairs(champFile[heldOut]), Object.fromEntries(Object.entries(rawScales).map(([r, f]) => [r, f.value]))) };
    log("");
    log("route scale (median truth/promise, shrunk):");
    log("  route      fitted    raw       n   pooled%   held-out |err| before -> after");
    for (const [r, f] of Object.entries(rawScales).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const h = heldOutEffect[r];
      log(`  ${r.padStart(5)} ${String(f.value).padStart(9)} ${String(f.raw).padStart(6)} ${String(f.n).padStart(8)} ${String(Math.round(f.pooledShare * 100)).padStart(8)}   ${h ? `${h.before.medianAbsSec} -> ${h.after.medianAbsSec} s (bias ${h.before.medianSignedSec} -> ${h.after.medianSignedSec})` : "-"}`);
    }

    candidate = assembleCandidate(fits, conformal, champ, { allowDrift: ALLOW_DRIFT, routeScales: rawScales, heldOut: heldOutEffect });
    const scalarsMoved = SCALAR_KEYS.some((k) => candidate.params[k] !== champ[k])
      || Object.keys({ ...(champ.ROUTE_SCALE ?? {}), ...candidate.params.ROUTE_SCALE })
        .some((r) => (champ.ROUTE_SCALE?.[r] ?? 1) !== (candidate.params.ROUTE_SCALE[r] ?? 1));
    const challFile = {};
    for (const d of replayDays) {
      challFile[d] = scalarsMoved ? replayFile(d, prepared[d], "challenger", candidate.params) : champFile[d];
    }
    if (!scalarsMoved) log("\nthe challenger's scalars are the champion's — only the band moved, so the same replay serves both arms");

    // A day the replay could not score at all (an archive day with no
    // positions, a route table the snapshot predates) is DROPPED, not counted
    // as a tie: a comparison over an empty day is not evidence either way.
    const perDay = [];
    for (const d of replayDays) {
      const champion = pooled(scoreRows(readPairs(champFile[d]), champ.CONFORMAL));
      const challenger = pooled(scoreRows(readPairs(challFile[d]), candidate.params.CONFORMAL));
      if (!champion || !challenger || champion.paired === 0 || challenger.paired === 0) {
        log(`  ${d}: no scored pairs — dropped from the comparison`);
        continue;
      }
      perDay.push({ day: d, champion, challenger });
    }
    decision = promotionDecision(perDay, heldOut);
    log("");
    log("day         champion p50/cov      challenger p50/cov");
    for (const p of decision.perDay) {
      log(`  ${p.day}  ${String(p.champion.medianAbsSec).padStart(7)} s / ${String(p.champion.intervalCoveragePct).padStart(5)}%  ${String(p.challenger.medianAbsSec).padStart(7)} s / ${String(p.challenger.intervalCoveragePct).padStart(5)}%`);
    }
    log(`bounds: median ${decision.bounds.medianSec} s, coverage ${decision.bounds.coveragePct} points (the champion's own day-to-day sd, floored)`);
    log(`median |err| difference ${decision.medianDiffSec} s; held-out coverage difference ${decision.coverageDiffPct} points`);

    // Both arms into the scorecard, whatever the decision: "we tried this and
    // it was worse" is the half a dashboard has no other way to show.
    if (!DRY) {
      for (const d of replayDays) {
        for (const [name, file, table] of [["champion", champFile[d], champ.CONFORMAL], ["challenger", challFile[d], candidate.params.CONFORMAL]]) {
          await api("POST", "/api/scorecard/replay", {
            day: d, name, estimatorVersion: `fit-${replayDays[replayDays.length - 1]}`,
            rows: scoreRows(readPairs(file), table).map((r) => ({ routeId: r.routeId, horizon: r.horizon, metrics: r.metrics })),
          });
        }
      }
      log(`wrote replay:champion / replay:challenger rows for ${replayDays.length} days`);
    }
  }

  // -- the decision ------------------------------------------------------------
  log("");
  for (const i of candidate.issues) log(`held back ${i.key}: ${i.reason} (keeping ${i.kept})`);
  const changed = !sameParams(candidate.params, champ);
  const promote = Boolean(decision?.promote) && changed;
  if (!changed) log("the candidate is the champion — nothing to publish");
  else if (!decision) log("no replay: refusing to publish a change nothing measured (drop --no-replay)");
  else if (!promote) log(`NOT promoted: ${decision.reasons.join("; ")}`);
  else log("PROMOTED");
  log(JSON.stringify(candidate.params, null, 1));

  const submission = {
    params: candidate.params,
    n: candidate.n,
    window: { from: window[0], to: window[window.length - 1], days: window.length },
    version: `fit-${window[window.length - 1]}`,
    accepted: promote,
    note: promote ? "promoted" : (changed ? `kept the champion: ${decision ? decision.reasons.join("; ") : "no replay"}` : "no change"),
    decision: {
      compiled: COMPILED,
      champion: champ,
      fits: Object.fromEntries(SCALAR_KEYS.map((k) => [k, { value: fits[k]?.value === null || fits[k]?.value === undefined ? null : round5(fits[k].value), n: fits[k]?.n ?? 0 }])),
      conformal,
      routeScales: routeScaleFit,
      routeScaleHeldOut,
      issues: candidate.issues,
      promotion: decision,
    },
  };
  if (DRY) {
    log("");
    log("--dry-run: nothing posted. The submission would be:");
    log(JSON.stringify(submission, null, 1).slice(0, 4000));
    return;
  }
  const r = await api("POST", "/api/model-params", submission);
  log(`posted: id ${r.id}, accepted ${r.accepted}`);
}

main().catch((e) => die(String(e?.stack ?? e)));
