/**
 * SPLIT-PATCH — the `PAYLOAD_PATCH` file the rider simulator needs to score
 * what production actually serves (PR #85's stand/drive split).
 *
 * `rider-sim/run.ts` rebuilds `/api/buses` from a snapshot by time-travelling
 * the calibrator (`../common.ts`); those replicas emit the v1 fields only
 * (`{avg, sd, n}` per segment, `{med, sd, n, low}` per dwell). Production also
 * serves `segments[route]["A-B"].drive`/`.driveN` and `dwells[route][stop].q`
 * /`.qn`, which `web/src/hopPricing.ts` prices the first hop from. Without
 * them a replay silently scores the pre-#85 client.
 *
 *   TZ=America/New_York REPLAY_DB=./store/snap.db \
 *     SPLIT_NOW=2026-09-04T00:00:08Z SPLIT_OUT=./scripts/.eta-replay/split-patch-0903.json \
 *     npx tsx scripts/eta-replay/split-patch.ts
 *
 * Env: REPLAY_DB, REPLAY_OUT, SPLIT_OUT, SPLIT_NOW (ISO; the calibration
 *      instant — rows AFTER it are excluded, so a patch for an earlier day
 *      cannot see the later day's stands), SPLIT_ROUTES=served|all.
 *
 * This is the script recovered from commit 13e386a (branch ring-index-anchor)
 * with two differences: master does not export `loadStandGroups` /
 * `loadDriveGroups` / `SPLIT_WINDOW_DAYS`, so the two loaders are transcribed
 * here VERBATIM (same SQL, same value expressions) over raw better-sqlite3;
 * and both loaders take an upper bound at SPLIT_NOW. `attachStandTables` /
 * `attachDrives` / `splitWithheldRoutes` / `calibrate` are the calibrator's own,
 * so the (i + 0.5)/10 quantile levels, the median drive, the true sample
 * counts and the served-route allowlist all come from the one place that
 * defines them. Emission is v1compat's two loops with whole-second rounding.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { drizzle } from "drizzle-orm/better-sqlite3";

import { OUT_DIR, SNAP_DB, loadNet } from "./common.js";
import {
  attachDrives,
  attachStandTables,
  calibrate,
  splitWithheldRoutes,
  type ValueGroup,
} from "../../src/calibrator/calibrator.js";
import { TransitNetwork, type DwellStats, type SegmentStats } from "../../src/network/TransitNetwork.js";
import * as schema from "../../src/db/schema.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

/** Mirrors calibrator.ts (not exported there). */
const SPLIT_WINDOW_DAYS = 30;

const OUT = process.env.SPLIT_OUT ?? path.join(OUT_DIR, "split-patch.json");
const SPLIT_ROUTES = process.env.SPLIT_ROUTES ?? "served";
if (SPLIT_ROUTES !== "served" && SPLIT_ROUTES !== "all") {
  throw new Error(`SPLIT_ROUTES=${SPLIT_ROUTES}: expected "served" (production) or "all"`);
}

interface SegmentPatch { drive: number; driveN: number }
interface DwellPatch { q: number[]; qn: number }
interface Patch {
  segments: Record<string, Record<string, SegmentPatch>>;
  dwells: Record<string, Record<string, DwellPatch>>;
}

const net = loadNet();
const sqlite = new Database(SNAP_DB, { readonly: true });
const db = drizzle(sqlite, { schema });

for (const table of ["stop_visits", "legs"] as const) {
  const present = sqlite.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { c: number };
  if (present.c === 0) throw new Error(`${SNAP_DB} has no \`${table}\` table — the split cannot be derived from it.`);
}

const segMax = (sqlite.prepare("SELECT MAX(started_at) m FROM segments").get() as { m: number | null }).m;
const NOW = process.env.SPLIT_NOW ? Date.parse(process.env.SPLIT_NOW) : (segMax ?? Date.now());
if (!Number.isFinite(NOW)) throw new Error(`SPLIT_NOW=${process.env.SPLIT_NOW} did not parse`);

const parseValueList = (s: string | null): number[] => (s ? s.split(",").map(Number).filter((x) => Number.isFinite(x)) : []);

/** calibrator.ts `loadStandGroups`, plus `anchored_at <= NOW`. */
function loadStandGroups(windowDays: number, nowMs: number): ValueGroup[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const rows = sqlite.prepare(`
    SELECT route_id AS routeId, stop_id AS stopId, COUNT(*) AS n,
      group_concat(CASE WHEN outcome = 'passed' THEN 0 ELSE (departed_at - pinned_at) / 1000.0 END) AS allValues
    FROM stop_visits
    WHERE anchored_at >= ? AND anchored_at <= ?
      AND pinned_at IS NOT NULL
      AND ((outcome = 'stopped' AND departed_at IS NOT NULL AND departed_at >= pinned_at) OR outcome = 'passed')
    GROUP BY route_id, stop_id`).all(cutoff, nowMs) as Array<{ routeId: number; stopId: number; n: number; allValues: string | null }>;
  return rows.map((r) => ({ key: TransitNetwork.dwellKey(r.routeId, r.stopId), n: r.n, all: parseValueList(r.allValues), windowed: [] }));
}

/** calibrator.ts `loadDriveGroups`, plus `departed_at <= NOW`. */
function loadDriveGroups(windowDays: number, nowMs: number): ValueGroup[] {
  const cutoff = nowMs - windowDays * 86_400_000;
  const rows = sqlite.prepare(`
    SELECT route_id AS routeId, from_stop_id AS fromStopId, to_stop_id AS toStopId, COUNT(*) AS n,
      group_concat((COALESCE(to_pinned_at, arrived_at) - departed_at) / 1000.0) AS allValues
    FROM legs
    WHERE departed_at >= ? AND departed_at <= ?
      AND hops = 1
      AND COALESCE(to_pinned_at, arrived_at) > departed_at
    GROUP BY route_id, from_stop_id, to_stop_id`).all(cutoff, nowMs) as Array<{ routeId: number; fromStopId: number; toStopId: number; n: number; allValues: string | null }>;
  return rows.map((r) => ({ key: TransitNetwork.segmentKey(r.routeId, r.fromStopId, r.toStopId), n: r.n, all: parseValueList(r.allValues), windowed: [] }));
}

// Base tables (presence decides which hops may carry a drive).
const stats = calibrate(db, net.network, new Date(NOW));
console.error(`calibrated at ${new Date(NOW).toISOString()}: ${stats.segmentCount} segments, ${stats.dwellCount} dwells, ${stats.standCount} stand tables, ${stats.driveCount} drives (calibrator's own, unbounded above)`);

const segTable = new Map<string, SegmentStats>();
const dwTable = new Map<string, DwellStats>();
for (const r of net.routes) {
  const n = r.stops.length;
  for (let i = 0; i < n; i++) {
    const from = r.stops[i]!;
    const to = r.stops[(i + 1) % n]!;
    const { drive: _d, driveN: _dn, ...s } = net.network.getSegmentStats(r.id, from, to);
    if (s.source !== "prior") segTable.set(TransitNetwork.segmentKey(r.id, from, to), s);
  }
  for (const sid of new Set(r.stops)) {
    const { q: _q, qn: _qn, ...d } = net.network.getDwellStats(r.id, sid);
    dwTable.set(TransitNetwork.dwellKey(r.id, sid), d);
  }
}
const withheld = SPLIT_ROUTES === "all" ? new Set<number>() : splitWithheldRoutes(net.network);
const standCount = attachStandTables(dwTable, loadStandGroups(SPLIT_WINDOW_DAYS, NOW), withheld);
const driveCount = attachDrives(segTable, loadDriveGroups(SPLIT_WINDOW_DAYS, NOW), withheld);
console.error(`SPLIT_ROUTES=${SPLIT_ROUTES}: withheld ${withheld.size} routes, ${standCount} stand tables, ${driveCount} drives (rows bounded to <= SPLIT_NOW)`);

const patch: Patch = { segments: {}, dwells: {} };
const rows: Array<{ route: string; hops: number; drives: number; stops: number; stands: number }> = [];
for (const r of net.routes) {
  const rid = String(r.id);
  const n = r.stops.length;
  const segMap: Record<string, SegmentPatch> = {};
  for (let i = 0; i < n; i++) {
    const from = r.stops[i]!;
    const to = r.stops[(i + 1) % n]!;
    const s = segTable.get(TransitNetwork.segmentKey(r.id, from, to));
    if (s?.drive === undefined || s.driveN === undefined) continue;
    segMap[`${from}-${to}`] = { drive: Math.round(s.drive), driveN: s.driveN };
  }
  const uniqueStops = new Set(r.stops);
  const dwMap: Record<string, DwellPatch> = {};
  for (const sid of uniqueStops) {
    const d = dwTable.get(TransitNetwork.dwellKey(r.id, sid));
    if (d?.q === undefined || d.qn === undefined) continue;
    dwMap[String(sid)] = { q: d.q.map((x) => Math.round(x)), qn: d.qn };
  }
  if (Object.keys(segMap).length) patch.segments[rid] = segMap;
  if (Object.keys(dwMap).length) patch.dwells[rid] = dwMap;
  rows.push({ route: r.name, hops: new Set(r.stops.map((_, i) => `${r.stops[i]}-${r.stops[(i + 1) % n]}`)).size, drives: Object.keys(segMap).length, stops: uniqueStops.size, stands: Object.keys(dwMap).length });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(patch));
console.log(`\n${OUT}  (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)\n`);
console.log(`| route | hops | with drive | stops | with q |\n|---|---|---|---|---|`);
for (const r of rows) if (r.drives || r.stands) console.log(`| ${r.route} | ${r.hops} | ${r.drives} | ${r.stops} | ${r.stands} |`);
sqlite.close();
net.db.close();
