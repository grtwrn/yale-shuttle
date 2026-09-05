/**
 * MODEL-PATCH — the `PAYLOAD_PATCH` file that gives the rider simulator every
 * calibration field production serves beyond v1's `{avg, sd, n}` / `{med, sd,
 * n, low}`: the stand/drive split (`drive`/`driveN`, `q`/`qn`) AND the
 * probabilistic estimator's inputs (`dq`/`dqn`, `pstop`, the route `pace`).
 *
 * `rider-sim/run.ts` rebuilds `/api/buses` from a snapshot by time-travelling
 * the calibrator (`../common.ts`: `makeCalibCache` / `makeDwellCache`), and
 * those replicas emit the v1 fields only. Everything else reaches the replayed
 * client through `PAYLOAD_PATCH`, which `run.ts` merges once into each hour
 * bucket's tables. Nothing on master wrote that file (a `split-patch.ts`
 * exists on the `ring-index-anchor` branch only), so this is the writer.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap.db npx tsx scripts/eta-replay/model-patch.ts
 *   TZ=America/New_York REPLAY_DB=./store/snap.db PAYLOAD_PATCH=./scripts/.eta-replay/model-patch.json \
 *     npx tsx scripts/eta-replay/rider-sim/run.ts --rider Red@48@2026-09-03T21:21:25Z
 *
 * Env: REPLAY_DB (the snapshot, as everywhere else in this directory),
 *      REPLAY_OUT (output directory), MODEL_OUT (full output path),
 *      MODEL_NOW (ISO; the instant the calibration is taken at),
 *      MODEL_ROUTES=served|all (see below; the default is production).
 *
 * NOTHING HERE RE-DERIVES A NUMBER. `calibrate()` runs against the snapshot
 * with the calibrator's own loaders and attachers, and the emission is
 * `v1compat.ts`'s own `segmentSplitFields` / `dwellSplitFields` / `paceEntry`
 * — so the (i + 0.5)/10 quantile levels, the median drive, the whole-second /
 * 3-decimal / 4-decimal rounding and the TRUE sample counts (the client gates
 * on them; a floor here would drift from its) are all the server's.
 *
 * PRODUCTION WITHHOLDS NOTHING (since 2026-09-05): every route carries its
 * tables wherever it has data, and `MODEL_ROUTES=all` (the default) is that.
 * `MODEL_ROUTES=served` rebuilds the OLD production payload — the split on
 * `SPLIT_SERVED_ROUTE_IDS` only and never on a `foldRoutes` line, both still
 * read out of the calibrator — for a paired before/after rider-sim run.
 *
 * Two fields beyond the split ride along, both from this branch's server:
 * `segments[r]["A-B"].legM` (road metres of every hop along the published
 * line, the length the pace is per — `legMetersField`, on hops the replay
 * already serves from its prior) and `dwells[r]["<stop>#<index>"]` (a stand
 * table per PASS of a stop the route lists twice, a FULL `{med, sd, n, q, qn,
 * pstop}` entry since the replay's dwell tables have no such row to merge
 * into — `attachOccurrenceStandTables`).
 *
 * ONE STATIC TABLE, AND THE LEAKAGE THAT IMPLIES. `run.ts` merges the patch
 * once (`applyPatch`, guarded by a WeakSet); it takes a single object, not a
 * per-hour series. So unlike the time-travelled replicas the tables here are
 * built once from the WHOLE snapshot (bounded by MODEL_NOW) and shown to every
 * rider in the run, including riders earlier in the day than most of the rows
 * behind them. Defensible because the split is pooled over SPLIT_WINDOW_DAYS
 * (30) by design; not free while the tables are young. Read a run with this
 * patch as "the model, as calibrated at MODEL_NOW".
 *
 * The patch only ever ADDS fields. `segments`/`dwells` merge into rows the
 * replay already holds; `pace` is folded by `run.ts` into the reserved
 * `segments[route][PACE_KEY]` carrier row, which is how the live server hands
 * it to the client too (see `paceCarrier` in `src/server/v1compat.ts`).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { drizzle } from "drizzle-orm/better-sqlite3";

import { OUT_DIR, SNAP_DB, loadNet } from "./common.js";
import {
  SPLIT_WINDOW_DAYS,
  attachDrives,
  attachLegQuantiles,
  attachOccurrenceStandTables,
  attachStandTables,
  calibrate,
  computePace,
  loadDriveGroups,
  loadLegGroups,
  loadStandGroups,
  loadStandOccurrenceGroups,
  loadStopOccurrenceShares,
  loadStopShares,
  splitWithheldRoutes,
} from "../../src/calibrator/calibrator.js";
import { TransitNetwork, type DwellStats, type PaceStats, type SegmentStats } from "../../src/network/TransitNetwork.js";
import {
  dwellSplitFields,
  legMetersField,
  paceEntry,
  segmentSplitFields,
  type DwellEntry,
  type PaceEntry,
  type SegmentEntry,
} from "../../src/server/v1compat.js";
import * as schema from "../../src/db/schema.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const OUT = process.env.MODEL_OUT ?? path.join(OUT_DIR, "model-patch.json");
const MODEL_ROUTES = process.env.MODEL_ROUTES ?? "all";
if (MODEL_ROUTES !== "served" && MODEL_ROUTES !== "all") {
  throw new Error(`MODEL_ROUTES=${MODEL_ROUTES}: expected "all" (production) or "served" (the pre-2026-09-05 allowlist)`);
}

/** The file's shape — what `rider-sim/run.ts` reads as `PayloadPatch`. */
interface Patch {
  segments: Record<string, Record<string, Pick<SegmentEntry, "drive" | "driveN" | "dq" | "dqn" | "legM">>>;
  /** Pooled keys carry the split only; `"<stop>#<index>"` keys are whole entries. */
  dwells: Record<string, Record<string, Pick<DwellEntry, "q" | "qn" | "pstop"> & Partial<Pick<DwellEntry, "med" | "sd" | "n">>>>;
  pace: Record<string, PaceEntry>;
}

const net = loadNet();

// A second handle on the same file: the calibrator speaks Drizzle, the rest of
// this directory speaks raw better-sqlite3. Read-only — `calibrate` only reads.
const sqlite = new Database(SNAP_DB, { readonly: true });
const db = drizzle(sqlite, { schema });

for (const table of ["stop_visits", "legs"] as const) {
  const present = sqlite.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { c: number };
  if (present.c === 0) throw new Error(`${SNAP_DB} has no \`${table}\` table — nothing to derive from. Backfill a writable copy first (scripts/backfill-departures.ts).`);
}
const visitCount = (sqlite.prepare("SELECT COUNT(*) c FROM stop_visits").get() as { c: number }).c;
const legCount = (sqlite.prepare("SELECT COUNT(*) c FROM legs").get() as { c: number }).c;
if (visitCount === 0 || legCount === 0) throw new Error(`${SNAP_DB}: stop_visits ${visitCount} rows, legs ${legCount} rows — nothing to derive from.`);

// The instant the calibration is taken at: the snapshot's last segment sample
// by default, so the 30-day window covers the whole snapshot. Only PRESENCE of
// the base segment table depends on the hour (a hop carries the split only
// where it has a calibrated segment), and that is decided by the 30-day pool.
const segMax = (sqlite.prepare("SELECT MAX(started_at) m FROM segments").get() as { m: number | null }).m;
const NOW = process.env.MODEL_NOW ? Date.parse(process.env.MODEL_NOW) : (segMax ?? Date.now());
if (!Number.isFinite(NOW)) throw new Error(`MODEL_NOW=${process.env.MODEL_NOW} did not parse`);

// Rows past the snapshot's own last observation are future data for every
// rider in the replay (a backfill from the archive runs past the snapshot).
const visitMax = (sqlite.prepare("SELECT MAX(anchored_at) m FROM stop_visits").get() as { m: number }).m;
const legMax = (sqlite.prepare("SELECT MAX(departed_at) m FROM legs").get() as { m: number }).m;
const dataEnd = Math.max(
  segMax ?? 0,
  (sqlite.prepare("SELECT MAX(arrived_at) m FROM arrivals").get() as { m: number | null }).m ?? 0,
  (sqlite.prepare("SELECT MAX(collected_at) m FROM raw_positions").get() as { m: number | null }).m ?? 0,
);
const splitMax = Math.max(visitMax, legMax);
if (dataEnd > 0 && splitMax > dataEnd + 300_000) {
  console.error(`WARNING: stop_visits/legs run to ${new Date(splitMax).toISOString()}, ${((splitMax - dataEnd) / 3_600_000).toFixed(1)} h past the snapshot's last observation (${new Date(dataEnd).toISOString()}). Re-run the backfill with --before the snapshot's data end.`);
}

const stats = calibrate(db, net.network, new Date(NOW));
console.error(
  `calibrated at ${new Date(NOW).toISOString()}: ${stats.segmentCount} segments, ${stats.dwellCount} dwells, ` +
    `${stats.standCount} stand tables (+${stats.occurrenceStandCount} per-pass), ${stats.driveCount} drives, ${stats.legQuantileCount} hop quantile tables, ` +
    `${stats.paceRouteCount} route paces, from ${stats.splitSampleCount} visits/legs`,
);

// Production's answer is what `calibrate` just pushed into the network. For
// MODEL_ROUTES=all the attach step is run again onto tables this script owns
// with nothing withheld — the attachers are the calibrator's own, and the
// seeding reproduces the two maps they expect (a segment entry only where the
// hop HAS a calibrated segment, since a distance prior has nowhere to carry a
// drive; a dwell entry per (route, stop) with the warm-up default).
const segTable = new Map<string, SegmentStats>();
const dwTable = new Map<string, DwellStats>();
let paceTable = new Map<number, PaceStats>();
for (const r of net.routes) {
  const n = r.stops.length;
  for (let i = 0; i < n; i++) {
    const from = r.stops[i]!;
    const to = r.stops[(i + 1) % n]!;
    const { drive: _d, driveN: _dn, dq: _dq, dqn: _dqn, ...s } = net.network.getSegmentStats(r.id, from, to);
    if (s.source !== "prior") segTable.set(TransitNetwork.segmentKey(r.id, from, to), s);
  }
  for (const sid of new Set(r.stops)) {
    const { q: _q, qn: _qn, pstop: _p, ...d } = net.network.getDwellStats(r.id, sid);
    dwTable.set(TransitNetwork.dwellKey(r.id, sid), d);
  }
  const p = net.network.getPace(r.id);
  if (p) paceTable.set(r.id, p);
}
const withheld = MODEL_ROUTES === "all" ? new Set<number>() : splitWithheldRoutes(net.network);
{
  const legGroups = loadLegGroups(db, SPLIT_WINDOW_DAYS, NOW);
  const standCount = attachStandTables(dwTable, loadStandGroups(db, SPLIT_WINDOW_DAYS, NOW), withheld, loadStopShares(db, SPLIT_WINDOW_DAYS, NOW));
  // Per-pass tables are structural (a fold's two passes), not part of the old
  // allowlist arm: the "served" payload never had them.
  const occCount = MODEL_ROUTES === "all"
    ? attachOccurrenceStandTables(dwTable, net.network, loadStandOccurrenceGroups(db, SPLIT_WINDOW_DAYS, NOW), loadStopOccurrenceShares(db, SPLIT_WINDOW_DAYS, NOW))
    : 0;
  const driveCount = attachDrives(segTable, loadDriveGroups(db, SPLIT_WINDOW_DAYS, NOW), withheld);
  const dqCount = attachLegQuantiles(segTable, legGroups, withheld);
  paceTable = computePace(legGroups, net.network, withheld);
  console.error(`MODEL_ROUTES=${MODEL_ROUTES}: withheld ${withheld.size} routes, ${standCount} stand tables (+${occCount} per-pass), ${driveCount} drives, ${dqCount} hop quantile tables, ${paceTable.size} route paces`);
}

// The same loops `v1compat.ts` runs, through its own emitters, carrying only
// the fields the replay cannot serve.
const patch: Patch = { segments: {}, dwells: {}, pace: {} };
const rows: Array<{ route: string; hops: number; drives: number; dqs: number; stops: number; stands: number; passes: number; legMs: number; pace: string }> = [];
for (const r of net.routes) {
  const rid = String(r.id);
  const n = r.stops.length;
  const segMap: Patch["segments"][string] = {};
  for (let i = 0; i < n; i++) {
    const from = r.stops[i]!;
    const to = r.stops[(i + 1) % n]!;
    const s = segTable.get(TransitNetwork.segmentKey(r.id, from, to));
    // legM is geometry, so it goes on every hop; the replay serves a row for
    // each (the prior where uncalibrated), so there is always one to merge into.
    const fields = { ...(s ? segmentSplitFields(s) : {}), ...legMetersField(net.network, r.id, from, to) };
    if (Object.keys(fields).length > 0) segMap[`${from}-${to}`] = fields;
  }
  const dwMap: Patch["dwells"][string] = {};
  for (const sid of new Set(r.stops)) {
    const d = dwTable.get(TransitNetwork.dwellKey(r.id, sid));
    if (!d) continue;
    const fields = dwellSplitFields(d);
    if (Object.keys(fields).length > 0) dwMap[String(sid)] = fields;
  }
  for (let i = 0; i < n; i++) {
    const sid = r.stops[i]!;
    if (net.network.positionsOnRoute(r.id, sid).length < 2) continue;
    const d = dwTable.get(TransitNetwork.occurrenceDwellKey(r.id, sid, i));
    if (!d) continue;
    dwMap[`${sid}#${i}`] = { med: Math.round(d.mean * 10) / 10, sd: Math.round(d.stddev * 10) / 10, n: d.n, ...dwellSplitFields(d) };
  }
  const p = paceTable.get(r.id);
  if (Object.keys(segMap).length > 0) patch.segments[rid] = segMap;
  if (Object.keys(dwMap).length > 0) patch.dwells[rid] = dwMap;
  if (p) patch.pace[rid] = paceEntry(p);
  if (Object.keys(segMap).length + Object.keys(dwMap).length > 0 || p) {
    rows.push({
      route: `${r.name} (${rid})`, hops: n,
      drives: Object.values(segMap).filter((x) => x.drive !== undefined).length,
      dqs: Object.values(segMap).filter((x) => x.dq !== undefined).length,
      stops: new Set(r.stops).size, stands: Object.keys(dwMap).filter((k) => !k.includes("#")).length,
      passes: Object.keys(dwMap).filter((k) => k.includes("#")).length,
      legMs: Object.values(segMap).filter((x) => x.legM !== undefined).length,
      pace: p ? `${paceEntry(p).spm[4]}–${paceEntry(p).spm[5]} s/m over ${p.n}` : "-",
    });
  }
}
console.table(rows);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(patch));
console.error(`wrote ${OUT}: segments ${Object.values(patch.segments).reduce((a, r) => a + Object.keys(r).length, 0)} hops, dwells ${Object.values(patch.dwells).reduce((a, r) => a + Object.keys(r).length, 0)} stops, pace ${Object.keys(patch.pace).length} routes`);
