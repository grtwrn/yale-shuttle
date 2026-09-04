/**
 * BACKFILL `stop_visits` / `legs` FROM THE POSITION ARCHIVE.
 *
 * The collector has derived departures live only since migration 0010 shipped
 * (2026-09-04 02:21 UTC). `~/shuttle-captures/positions-*.jsonl` holds every
 * route's 5 s positions from 13:51 UTC 2026-09-03 onward. Running the
 * collector's own reducer (`stepManyWithVisits`, `src/collector/departure.ts`)
 * over that archive and writing its events through the collector's own row
 * mapping (`visitRowsOf`) gives the calibrator real stand/drive tables tonight
 * instead of in a week — the replay reproduces production's own detector
 * events on 98.1% of arrivals (docs/departure-derivation.md).
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York npx tsx scripts/backfill-departures.ts --db ./store/snap.db
 *       [--capture a.jsonl,b.jsonl]   default: every ~/shuttle-captures/positions-*.jsonl
 *       [--target <path>]             the database the rows are FOR — the cutoff and the
 *                                     dedup keys come from it. Default: --db.
 *       [--before <ISO>]              override the cutoff explicitly
 *       [--out rows.json]             write the rows instead of inserting (for the
 *                                     production apply step, scripts/backfill-departures-apply.cjs)
 *       [--dry-run]                   report only
 *       [--allow-empty]               a run that keeps nothing is a pass (idempotent rerun)
 *
 * Two safety rules, both about not double counting the live collector:
 *
 *  - The CUTOFF. Every event whose grouping instant (a visit's `anchored_at`,
 *    a leg's `departed_at`) is at or after the earliest live row is skipped —
 *    the collector has been recording from that instant. The whole archive is
 *    still fed through the reducer so visits that straddle the cutoff resolve;
 *    only the insert is filtered. A visit in progress when the live collector
 *    started is therefore represented by the collector's (truncated) row, not
 *    the archive's — one sample, and the honest one for "what production saw".
 *  - EXACT-KEY DEDUP against whatever is already there, so the script is
 *    idempotent: rerunning it inserts nothing.
 *
 * Both are properties of the TARGET, which is not always `--db`. `--db` supplies
 * stops and routes (the network the reducer indexes into) and, when no `--out`
 * is given, receives the rows; when the rows are for another database (the
 * production machine's), name it with `--target` so the cutoff is that
 * database's earliest live visit and not a local scratch copy's. Getting this
 * wrong is what emptied the 2026-09-04 run: the local copy had itself been
 * backfilled from this archive, so its earliest row WAS the archive's first
 * sample and every derived event landed at or after the cutoff. `checkBackfill`
 * (scripts/backfill-guards.ts) now refuses that state, and refuses an empty
 * result generally; the script exits non-zero and writes nothing.
 *
 * Run with TZ=America/New_York: `dow`/`hour` are ET.
 */
process.env.TZ ??= "America/New_York";
if (Intl.DateTimeFormat().resolvedOptions().timeZone !== "America/New_York") {
  throw new Error("run with TZ=America/New_York (dow/hour columns are ET, like the collector's)");
}

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { checkBackfill } from "./backfill-guards.js";
import { openDb } from "../src/db/client.js";
import { legs as legsTable, stopVisits } from "../src/db/schema.js";
import { TransitNetwork } from "../src/network/TransitNetwork.js";
import type { Route, Stop } from "../src/schema/api.js";
import { planTracks, type BusObservation, type BusState } from "../src/collector/detector.js";
import { stepManyWithVisits, type VisitEvent, type VisitState } from "../src/collector/departure.js";
import { visitRowsOf, type LegRow, type StopVisitRow } from "../src/collector/visitRows.js";
import { MIN_DRIVE_SAMPLES, MIN_STAND_SAMPLES } from "../web/src/hopPricing";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

// -- args ------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DB_PATH = arg("--db");
if (!DB_PATH) throw new Error("--db <path> is required (a writable copy, or the live DB on the machine)");
const DRY = argv.includes("--dry-run");
const ALLOW_EMPTY = argv.includes("--allow-empty");
const OUT = arg("--out");
const TARGET_PATH = arg("--target") ?? DB_PATH;
const CAPTURE = (arg("--capture") ?? defaultCaptures().join(",")).split(",").map((s) => s.trim()).filter(Boolean);
if (CAPTURE.length === 0) throw new Error("no capture files");

function defaultCaptures(): string[] {
  const dir = path.join(process.env.HOME ?? "", "shuttle-captures");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^positions-\d{8}\.jsonl$/.test(f)).sort().map((f) => path.join(dir, f));
}

// -- network from the DB ------------------------------------------------------------
const { db, sqlite } = openDb(DB_PATH);
const stops = sqlite.prepare("SELECT id, name, lat, lon FROM stops").all() as Stop[];
const routes = (sqlite.prepare("SELECT id, name, short_name, color, stops_json, path_json FROM routes").all() as Array<{
  id: number; name: string; short_name: string; color: string; stops_json: string; path_json: string | null;
}>).map((r) => {
  let routePath: [number, number][] | undefined;
  try { routePath = r.path_json ? (JSON.parse(r.path_json) as [number, number][]) : undefined; } catch { routePath = undefined; }
  return { id: r.id, name: r.name, shortName: r.short_name, color: r.color, stops: JSON.parse(r.stops_json) as number[], ...(routePath ? { path: routePath } : {}) } as Route;
});
const network = TransitNetwork.build(stops, routes);
const routeName = new Map(routes.map((r) => [r.id, r.name]));
const stopName = new Map(stops.map((s) => [s.id, s.name]));
log(`network: ${stops.length} stops, ${routes.length} routes from ${DB_PATH}`);

// -- cutoff and existing keys, from the TARGET ---------------------------------------------
// The target is `--db` unless `--target` names another database: the cutoff and
// the dedup keys are properties of whatever will receive these rows.
const target = TARGET_PATH === DB_PATH ? sqlite : new Database(TARGET_PATH, { readonly: true });
const liveMin = (target.prepare("SELECT MIN(anchored_at) m FROM stop_visits").get() as { m: number | null }).m;
const beforeArg = arg("--before");
const CUTOFF = beforeArg ? Date.parse(beforeArg) : liveMin ?? Infinity;
if (!Number.isFinite(CUTOFF) && beforeArg) throw new Error(`--before ${beforeArg} did not parse`);
const CUTOFF_SOURCE = beforeArg
  ? `--before ${beforeArg}`
  : liveMin != null
    ? `${TARGET_PATH}, earliest stop_visits row`
    : `${TARGET_PATH}, which holds no visits yet`;
log(`cutoff: ${Number.isFinite(CUTOFF) ? new Date(CUTOFF).toISOString() : "none (no live rows yet)"} (${CUTOFF_SOURCE})`);

const existingVisits = new Set<string>();
for (const r of target.prepare("SELECT bus_name b, route_id r, stop_id s, anchored_at t FROM stop_visits").iterate() as Iterable<{ b: string; r: number; s: number; t: number }>) {
  existingVisits.add(`${r.b}|${r.r}|${r.s}|${r.t}`);
}
const existingLegs = new Set<string>();
for (const r of target.prepare("SELECT bus_name b, route_id r, from_stop_id f, to_stop_id t, departed_at d FROM legs").iterate() as Iterable<{ b: string; r: number; f: number; t: number; d: number }>) {
  existingLegs.add(`${r.b}|${r.r}|${r.f}|${r.t}|${r.d}`);
}
log(`target ${TARGET_PATH}: ${existingVisits.size} visits, ${existingLegs.size} legs already there`);

// -- corpus --------------------------------------------------------------------------
type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const pos: PosRow[] = [];
{
  const seen = new Set<string>();
  let total = 0;
  for (const f of CAPTURE) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      total++;
      let r: any;
      try { r = JSON.parse(line); } catch { continue; } // a torn final line while the recorder is writing
      const k = `${r.bus_id}:${r.collected_at}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pos.push({ i: r.bus_id, b: r.bus_name, r: r.route_id, lat: r.lat, lon: r.lon, h: r.heading, l: r.last_stop_id, t: r.collected_at });
    }
  }
  pos.sort((a, b) => a.t - b.t || a.i - b.i);
  if (pos.length === 0) throw new Error("empty corpus");
  log(`corpus ${total} rows, ${pos.length} unique, ${new Date(pos[0]!.t).toISOString()} .. ${new Date(pos[pos.length - 1]!.t).toISOString()}`);
}
const polls: BusObservation[][] = [];
{
  let cur: BusObservation[] = [];
  let curAt = -1;
  for (const p of pos) {
    if (p.t !== curAt) {
      if (cur.length) polls.push(cur);
      cur = [];
      curAt = p.t;
    }
    cur.push({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t });
  }
  if (cur.length) polls.push(cur);
}

// -- replay ---------------------------------------------------------------------------
const states = new Map<string, BusState>();
const visitStates = new Map<string, VisitState>();
const events: VisitEvent[] = [];
for (const poll of polls) {
  const out = stepManyWithVisits(network, states, visitStates, poll, planTracks(poll));
  for (const v of out.visits) events.push(v);
}
// Do NOT close the still-open visits: the live collector owns anything in
// progress past the cutoff, and an `unresolved` row for a visit the archive
// simply ran out of would be a fabricated outcome.
const openAtEnd = visitStates.size;
log(`polls ${polls.length}: ${events.filter((e) => e.kind === "visit").length} visits, ${events.filter((e) => e.kind === "leg").length} legs (${openAtEnd} still open at the end of the archive, left to the live collector)`);

// -- filter: cutoff, then exact-key dedup -------------------------------------------------
const { visitRows, legRows } = visitRowsOf(events);
const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);
const keptVisits: StopVisitRow[] = [];
let visitsPastCutoff = 0, visitsDup = 0;
for (const r of visitRows) {
  const t = ms(r.anchoredAt)!;
  if (t >= CUTOFF) { visitsPastCutoff++; continue; }
  if (existingVisits.has(`${r.busName}|${r.routeId}|${r.stopId}|${t}`)) { visitsDup++; continue; }
  keptVisits.push(r);
}
const keptLegs: LegRow[] = [];
let legsPastCutoff = 0, legsDup = 0;
for (const r of legRows) {
  const t = ms(r.departedAt)!;
  if (t >= CUTOFF) { legsPastCutoff++; continue; }
  if (existingLegs.has(`${r.busName}|${r.routeId}|${r.fromStopId}|${r.toStopId}|${t}`)) { legsDup++; continue; }
  keptLegs.push(r);
}
const verdict = checkBackfill({
  cutoff: CUTOFF,
  cutoffSource: CUTOFF_SOURCE,
  corpusFirstMs: pos[0]!.t,
  visits: { kept: keptVisits.length, pastCutoff: visitsPastCutoff, dup: visitsDup },
  legs: { kept: keptLegs.length, pastCutoff: legsPastCutoff, dup: legsDup },
  allowEmpty: ALLOW_EMPTY,
});
console.log("\n" + verdict.lines.join("\n"));
if (!verdict.ok) {
  // Nothing is written on a failed run: an empty rows file is exactly the
  // artefact that got mistaken for a successful backfill.
  sqlite.close();
  if (target !== sqlite) target.close();
  process.exit(1);
}

// -- write ----------------------------------------------------------------------------
if (OUT) {
  const plain = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.getTime() : v]));
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), cutoff: Number.isFinite(CUTOFF) ? CUTOFF : null, visits: keptVisits.map(plain), legs: keptLegs.map(plain) }));
  log(`wrote ${OUT}`);
} else if (!DRY) {
  const CHUNK = 200;
  const tx = sqlite.transaction(() => {
    for (let i = 0; i < keptVisits.length; i += CHUNK) db.insert(stopVisits).values(keptVisits.slice(i, i + CHUNK)).run();
    for (let i = 0; i < keptLegs.length; i += CHUNK) db.insert(legsTable).values(keptLegs.slice(i, i + CHUNK)).run();
  });
  tx();
  log(`inserted ${keptVisits.length} visits, ${keptLegs.length} legs into ${DB_PATH}`);
} else {
  log("dry run: nothing written");
}

// -- coverage, as the calibrator and the client's gate will see it -----------------------
// Counted from the TARGET plus, when nothing was inserted (dry run / --out),
// the rows this run would have added — i.e. always "the target after this
// backfill".
{
  const stopsStand = new Map<string, number>();   // route|stop -> stopped visits with a pinned stand
  const hopsDrive = new Map<string, number>();    // route|from|to -> one-hop legs with a positive pinned drive
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of target.prepare("SELECT route_id r, stop_id s FROM stop_visits WHERE outcome = 'stopped' AND pinned_at IS NOT NULL AND departed_at IS NOT NULL").iterate() as Iterable<{ r: number; s: number }>) count(stopsStand, `${r.r}|${r.s}`);
  for (const r of target.prepare("SELECT route_id r, from_stop_id f, to_stop_id t FROM legs WHERE hops = 1 AND COALESCE(to_pinned_at, arrived_at) > departed_at").iterate() as Iterable<{ r: number; f: number; t: number }>) count(hopsDrive, `${r.r}|${r.f}|${r.t}`);
  if (OUT || DRY) {
    for (const r of keptVisits) if (r.outcome === "stopped" && r.pinnedAt && r.departedAt) count(stopsStand, `${r.routeId}|${r.stopId}`);
    for (const r of keptLegs) if (r.hops === 1 && ms(r.toPinnedAt ?? r.arrivedAt)! > ms(r.departedAt)!) count(hopsDrive, `${r.routeId}|${r.fromStopId}|${r.toStopId}`);
  }
  const rows: string[] = [];
  rows.push(`| route | stops | stand n≥1 | n≥${MIN_STAND_SAMPLES} | hops | drive n≥1 | n≥${MIN_DRIVE_SAMPLES} | first hops passing both |`);
  rows.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of [...routes].sort((a, b) => a.id - b.id)) {
    const uniq = [...new Set(r.stops)];
    const s1 = uniq.filter((s) => (stopsStand.get(`${r.id}|${s}`) ?? 0) >= 1).length;
    const s20 = uniq.filter((s) => (stopsStand.get(`${r.id}|${s}`) ?? 0) >= MIN_STAND_SAMPLES).length;
    const hops = r.stops.map((s, i) => [s, r.stops[(i + 1) % r.stops.length]!] as const);
    const h1 = hops.filter(([f, t]) => (hopsDrive.get(`${r.id}|${f}|${t}`) ?? 0) >= 1).length;
    const h10 = hops.filter(([f, t]) => (hopsDrive.get(`${r.id}|${f}|${t}`) ?? 0) >= MIN_DRIVE_SAMPLES).length;
    const both = hops.filter(([f, t]) => (hopsDrive.get(`${r.id}|${f}|${t}`) ?? 0) >= MIN_DRIVE_SAMPLES && (stopsStand.get(`${r.id}|${f}`) ?? 0) >= MIN_STAND_SAMPLES).length;
    if (s1 + h1 === 0) continue;
    rows.push(`| ${routeName.get(r.id) ?? r.id} | ${uniq.length} | ${s1} | ${s20} | ${hops.length} | ${h1} | ${h10} | ${both} |`);
  }
  console.log(`\nCoverage (${TARGET_PATH} after this backfill); the client prices a hop from the split only when its from-stop has stand n≥${MIN_STAND_SAMPLES} AND the hop has drive n≥${MIN_DRIVE_SAMPLES}:\n`);
  console.log(rows.join("\n"));
  const w = [...stopsStand.entries()].filter(([k]) => k.startsWith("3|")).map(([k, n]) => ({ stop: stopName.get(Number(k.split("|")[1])) ?? k, n })).filter((x) => x.stop.startsWith("344 Winchester"));
  if (w.length) console.log(`\nRed, 344 Winchester: stand n = ${w[0]!.n}`);
}
sqlite.close();
if (target !== sqlite) target.close();
