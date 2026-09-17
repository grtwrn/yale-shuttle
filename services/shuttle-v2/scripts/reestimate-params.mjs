#!/usr/bin/env node
/**
 * Chronological parameter research. The live champion remains in force unless
 * an untouched, independently sampled test passes every gate. Legacy replay
 * pairs lack bus/target-visit identity and exact outcome-availability provenance,
 * so automatic promotion is currently BLOCKED; diagnostics can still be run.
 *
 * Order: earlier training -> correction fit -> correction selection -> final
 * candidate interval calibration -> untouched test. No final-test tuning.
 * Cached artifacts include code, inputs, parameters and completion receipts.
 *
 * --dry-run: no POSTs; --days N: earlier training window (default14,min7).
 * --replay-days N: later evaluation days (default8,min8); --no-replay: no publish.
 * --base PATH, --archive DIR, --base-url URL, --work DIR, --allow-drift as before.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import {
  COMPILED, HORIZONS, assembleCandidate, distanceMeters, estimateEmissions,
  estimateVisitRates,
  sameParams, scoreRows, tracksByName, zoneTester,
} from "./reestimate-lib.mjs";
import { cachedArtifact, chronologicalPlan, fileHash, fileIdentity, identityHash,
  researchCandidate, validationCells, validationDecision, visitAvailableBy } from './reestimate-validation.mjs';

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
const WINDOW_DAYS = Math.max(7, Number(opt("--days", 14)));
const REPLAY_DAYS = Math.max(8, Number(opt("--replay-days", 8)));
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
  return fs.readdirSync(ARCHIVE).filter(day => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(ARCHIVE, day, 'manifest.json'), 'utf8'));
      return manifest.ok === true && ['raw_positions', 'arrivals', 'stop_visits', 'legs'].every(table =>
        manifest.tables?.[table]?.complete === true && fs.existsSync(path.join(ARCHIVE, day, `${table}.jsonl.gz`)));
    } catch { return false; }
  }).sort();
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
    throw new Error(`${label} failed:\n${tail}`);
  }
  log(`  ${label} ${(Date.now() - t0) / 1000}s`);
}

/** Hash actual source bytes, including uncommitted edits, and dependencies. */
function sourceIdentity() {
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (/\.(?:[cm]?js|tsx?|json|sql)$/.test(e.name)) files.push(file);
    }
  };
  for (const dir of ['src', 'web/src', 'scripts/eta-replay', 'drizzle']) walk(path.join(ROOT, dir));
  for (const name of ['reestimate-params.mjs', 'reestimate-lib.mjs', 'reestimate-validation.mjs']) files.push(path.join(HERE, name));
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) if (fs.existsSync(path.join(ROOT, name))) files.push(path.join(ROOT, name));
  return identityHash(fileIdentity(files));
}
let sourceKey;
function prepareDay(day) {
  const cutoff = Date.parse(etMidnightIso(day));
  const inputs = [BASE_DB, `${BASE_DB}-wal`];
  for (const d of fs.readdirSync(ARCHIVE).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(ARCHIVE, d, 'manifest.json'))).sort()) {
    if (d > day || Date.parse(etMidnightIso(d)) < cutoff - 92 * 86_400_000) continue;
    for (const f of fs.readdirSync(path.join(ARCHIVE, d))) if (f === 'manifest.json' || f.endsWith('.jsonl.gz')) inputs.push(path.join(ARCHIVE, d, f));
  }
  const identity = { v: 3, day, sourceKey, inputs: fileIdentity(inputs), timezone: 'America/New_York', node: process.version };
  const key = identityHash(identity).slice(0, 20);
  const db = path.join(WORK, `replay-${day}-${key}.db`);
  const patch = path.join(WORK, `patch-${day}-${key}.json`);
  cachedArtifact(db, { ...identity, kind: 'database' }, temp => {
    run('npx', ['tsx', 'scripts/eta-replay/archive-db.ts', day, BASE_DB, temp], { TZ: 'America/New_York', ARCHIVE_DIR: ARCHIVE }, `archive-db ${day}`);
  }, temp => {
    const Database = require('better-sqlite3');
    const check = new Database(temp, { readonly: true });
    try { if (check.pragma('quick_check', { simple: true }) !== 'ok') throw new Error(`Corrupt replay database ${temp}`); }
    finally { check.close(); }
  });
  cachedArtifact(patch, { ...identity, kind: 'tables', database: fileHash(db), cutoff }, temp => {
    run('npx', ['tsx', 'scripts/eta-replay/model-patch.ts'], {
      TZ: 'America/New_York', REPLAY_DB: db, MODEL_OUT: temp, MODEL_NOW: etMidnightIso(day), MODEL_ROUTES: 'all',
    }, `model-patch ${day}`);
  }, temp => { const p = JSON.parse(fs.readFileSync(temp, 'utf8')); if (!p.segments || !p.dwells) throw new Error('Incomplete calibration patch'); });
  return { db, patch };
}

/** Replay exactly this parameter set; only interval widening is applied later. */
function replayFile(day, prepared, arm, params) {
  const raw = { ...params, CONFORMAL: Object.fromEntries(HORIZONS.map(h => [h, 1])) };
  const identity = { v: 3, day, sourceKey, params: raw, database: fileHash(prepared.db),
    patch: fileHash(prepared.patch), timezone: 'America/New_York', node: process.version, pollStride: 1, kerbShuffle: false };
  const key = identityHash(identity).slice(0, 20);
  const out = path.join(WORK, `pairs-${day}-${key}.jsonl`);
  const paramsFile = path.join(WORK, `params-${key}.json`);
  fs.writeFileSync(paramsFile, JSON.stringify({ version: arm, publishedAt: 0, params: raw }));
  cachedArtifact(out, identity, temp => {
    run('npx', ['tsx', 'scripts/eta-replay/gps-replay.ts'], {
      TZ: 'America/New_York', REPLAY_DB: prepared.db, PAYLOAD_PATCH: prepared.patch,
      PAIRS_OUT: temp, REPLAY_OUT: WORK, MODEL_PARAMS: paramsFile, POLL_STRIDE: '1', KERB_SHUFFLE: '0',
    }, `gps-replay ${day} ${arm}`);
  }, temp => { for (const p of readPairs(temp)) if (![p.r, p.eta, p.low, p.high].every(Number.isFinite)) throw new Error('Malformed replay pairs'); });
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

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  if (![WINDOW_DAYS, REPLAY_DAYS].every(Number.isInteger)) die('Day counts must be finite integers.');
  const days = archivedDays();
  const plan = chronologicalPlan(days, { trainDays: WINDOW_DAYS, evaluationDays: REPLAY_DAYS });
  if (!plan.ready) {
    const result = { accepted: false, plan, reasons: plan.reasons };
    fs.writeFileSync(path.join(WORK, 'latest-validation.json'), JSON.stringify(result, null, 2));
    log(`NOT promoted: ${plan.reasons.join('; ')} Existing champion retained.`);
    return;
  }
  sourceKey = sourceIdentity();
  const window = plan.training;
  const trainingEnd = Date.parse(etMidnightIso(plan.correctionFit[0]));
  log(`chronological blocks ${JSON.stringify(plan)}`);
  const { stopCoords, routes } = topology();
  const positions = [], visits = [];
  for (const d of window) {
    for (const r of readRows(d, 'raw_positions')) if (r.collected_at < trainingEnd) positions.push(r);
    for (const r of readRows(d, 'stop_visits')) if (visitAvailableBy(r, trainingEnd)) visits.push(r);
  }
  const fits = { ...estimateEmissions(tracksByName(positions), zoneTester(routes, stopCoords)), ...estimateVisitRates(visits) };
  const champ = (await champion()) ?? { ...COMPILED, CONFORMAL: { ...COMPILED.CONFORMAL } };
  let candidate = assembleCandidate(fits, null, COMPILED, { allowDrift: ALLOW_DRIFT });
  let conformal = null, routeScaleFit = null, horizonBiasFit = null;
  let decision = { promote: false, reasons: ['No replay requested; existing champion retained.'] };
  const perDay = [];
  if (!NO_REPLAY) {
    const prepared = {};
    const prepare = day => prepared[day] ??= prepareDay(day);
    ({ candidate, conformal, routeScaleFit, horizonBiasFit } = researchCandidate(plan, {
      fits, allowDrift: ALLOW_DRIFT,
      replay: (day, phase, params) => replayFile(day, prepare(day), phase, params),
      read: readPairs,
      pooledShares: dates => pooledShares(dates.map(day => prepared[day].patch), routes, stopCoords),
    }));
    for (const day of plan.test) {
      const championFile = replayFile(day, prepare(day), 'champion-test', champ);
      const challengerFile = replayFile(day, prepare(day), 'challenger-test', candidate.params);
      perDay.push({ day, champion: validationCells(readPairs(championFile), champ.CONFORMAL),
        challenger: validationCells(readPairs(challengerFile), candidate.params.CONFORMAL) });
      // Scorecard records remain descriptive per-poll metrics, never evidence
      // of independent trips. They do not authorize model publication.
      if (!DRY) for (const [name, file, table] of [['champion', championFile, champ.CONFORMAL], ['challenger', challengerFile, candidate.params.CONFORMAL]]) {
        await api('POST', '/api/scorecard/replay', { day, name, estimatorVersion: `chronological-${day}`,
          rows: scoreRows(readPairs(file), table).map(r => ({ routeId: r.routeId, horizon: r.horizon, metrics: r.metrics })) });
      }
    }
    // The exporter currently omits bus/arrival identity and exact outcome
    // availability. No flag or --allow-drift bypasses these evidence gates.
    decision = validationDecision(perDay, { groupingVerified: false, availabilityVerified: false, baselineVintageVerified: false });
  }
  const changed = !sameParams(candidate.params, champ);
  const promote = changed && decision.promote;
  const result = { accepted: promote, sourceKey, plan, candidate, champion: champ, conformal, routeScaleFit, horizonBiasFit, decision, perDay };
  fs.writeFileSync(path.join(WORK, 'latest-validation.json'), JSON.stringify(result, null, 2));
  log(`${promote ? 'PROMOTED' : 'NOT promoted'}: ${decision.reasons.join('; ')}`);
  // A refused research run leaves the live model-params endpoint untouched.
  // Full evidence remains local even when a diagnostic scorecard is posted.
  if (!promote || DRY) { log('Existing champion retained; no model parameters posted.'); return; }
  const submission = { params: candidate.params, n: candidate.n,
    window: { from: window[0], to: window[window.length - 1], days: window.length },
    version: `chronological-${plan.test.at(-1)}`, accepted: true, note: 'Passed independent chronological evaluation',
    decision: { sourceKey, plan, promotion: { promote: true, reasons: [], testDays: decision.testDays } } };
  const posted = await api('POST', '/api/model-params', submission);
  log(`posted: id ${posted.id}, accepted ${posted.accepted}`);
}

main().catch(e => die(String(e?.stack ?? e)));
