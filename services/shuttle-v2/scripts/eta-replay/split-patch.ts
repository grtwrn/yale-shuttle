/**
 * SPLIT-PATCH — the `PAYLOAD_PATCH` file the rider simulator needs to score
 * what production actually serves.
 *
 * `rider-sim/run.ts` rebuilds `/api/buses` from a snapshot by time-travelling
 * the calibrator (`../common.ts`), and those replicas emit the v1 fields only:
 * `{avg, sd, n}` per segment, `{med, sd, n, low}` per dwell. Production (PR
 * #85, `src/server/v1compat.ts`) also serves the stand/drive split that
 * `web/src/hopPricing.ts` prices the first hop from — `segments[route][
 * "A-B"].drive`/`.driveN` and `dwells[route][stop].q`/`.qn`. Without them
 * every hop in a replay takes the pre-#85 fallback path, silently: the run
 * looks healthy and measures the wrong client. `run.ts` has always documented
 * a `PAYLOAD_PATCH=file.json` escape hatch for exactly this; nothing wrote the
 * file. That gap already misled one measurement run.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap3-split.db npx tsx scripts/eta-replay/split-patch.ts
 *   TZ=America/New_York REPLAY_DB=... PAYLOAD_PATCH=./scripts/.eta-replay/split-patch.json \
 *     npx tsx scripts/eta-replay/rider-sim/run.ts --rider Red@48@2026-09-03T21:21:25Z@41.325351,-72.922891
 *
 * Env: REPLAY_DB (the snapshot, as everywhere else in this directory),
 *      REPLAY_OUT (output directory), SPLIT_OUT (full output path),
 *      SPLIT_NOW (ISO; the instant the calibration is taken at),
 *      SPLIT_ROUTES=served|all (see below; the default is production).
 *
 * NOTHING HERE RE-DERIVES THE SPLIT. It runs the calibrator's own
 * `calibrate()`, `loadStandGroups` / `loadDriveGroups` and `attachStandTables`
 * / `attachDrives` against the snapshot, then emits with the same two loops and
 * the same whole-second rounding `v1compat.ts` uses. So the (i + 0.5)/10
 * quantile levels (`STAND_Q_COUNT` is part of the wire contract), the median
 * drive, the TRUE sample counts — the client gates on `MIN_STAND_SAMPLES` /
 * `MIN_DRIVE_SAMPLES` itself and a floor here would drift from its — and the
 * rule that a drive rides only on a hop that already has a calibrated segment
 * all come from the one place that defines them.
 *
 * WHAT PRODUCTION SERVES IS NOT EVERYTHING THE CALIBRATOR CAN COMPUTE. The
 * split goes out on `SPLIT_SERVED_ROUTE_IDS` only (Red and Blue Day as of PR
 * #85) and never on a `foldRoutes` line (Green 9, Purple 10 — one stop id
 * cannot carry two passes' tables). Both are read out of the calibrator, not
 * repeated here, so this patch tracks the server when the list changes.
 * `SPLIT_ROUTES=all` withholds nothing; that is deliberately NOT production's
 * behaviour, and it exists for one job — the paired before/after rider-sim run
 * that CLAUDE.md requires before a route joins the allowlist (Pink cleared the
 * client's sample gate and went 280 -> 431 strands).
 *
 * VALIDATED against `docs/data/departure-tables-2026-09-03.json`, on Red's
 * 344 Winchester. Drive on 11 -> 146: 15 s over n = 25, against the reference's
 * `drivePinned` median 15.1 over n = 25. Stand `q`: 598 s at level 0.95 against
 * the reference's 598.1, and every level in between falls where the reference
 * brackets it. The low end reads 111 s against the reference's 118.1 because
 * `qn` is 25 where the reference's `standPinned` n is 24: the calibrator counts
 * the one pinned pass-through as a 0 s stand, deliberately and by measurement
 * (see `loadStandGroups`), and the reference table excludes it.
 *
 * THE SNAPSHOT MUST CARRY `stop_visits` AND `legs`. The split is derived from
 * those two tables (docs/departure-derivation.md); migration 0010 created them
 * on 2026-09-04, so every snapshot taken before that has neither. Backfill a
 * writable copy from the position archive first — that is what production
 * itself did:
 *
 *   sqlite3 copy.db < drizzle/0010_minor_jackal.sql   # or apply the migration
 *   TZ=America/New_York npx tsx scripts/backfill-departures.ts --db copy.db \
 *     --before <the snapshot's last data instant, ISO>
 *
 * The `--before` matters: the archive runs past the snapshot, and rows after
 * it are days the replay has not reached.
 *
 * ONE STATIC TABLE, AND THE LEAKAGE THAT IMPLIES. `run.ts` merges the patch
 * once into each hour bucket's tables (`applyPatch`, guarded by a WeakSet) —
 * it takes a single object, not a per-hour series, and this script does not
 * change that file. So unlike `makeCalibCache` / `makeDwellCache`, which
 * rebuild from rows that had completed by each ET hour, the split table here
 * is built once from the WHOLE snapshot and shown to every rider in the run,
 * including riders earlier in the day than most of the rows behind it.
 *
 * That is defensible but it is not free, and the two halves differ:
 *
 *  - It is defensible because the split is pooled over `SPLIT_WINDOW_DAYS`
 *    (30) by design and NOT sliced by (dow, hour) — a (stop, hour) cell has a
 *    median of two samples, so an hourly table has nothing to stand on. A
 *    day's rows are a small share of a 30-day pool, so the table a rider sees
 *    is close to the one production would have served them.
 *  - It is not free because these snapshots only have ~1 day of `stop_visits`
 *    (the tables are new), so "a small share of 30 days" is currently "most of
 *    the pool". A rider replayed at 09:00 is priced with the evening's stands.
 *    Read a rider-sim run with this patch as "the split, as calibrated at the
 *    end of the captured day" — good enough to answer "does the split help
 *    this line", not a claim about what a rider was told at 09:00.
 *
 * Bounding the split rows above (`--before` on the backfill) keeps the leak
 * inside the snapshot; nothing keeps it inside the hour.
 *
 * The patch only ever ADDS fields. `run.ts` merges it with `Object.assign`, so
 * a key the replay does not already hold would arrive with `q` and no `med` —
 * checked on the 2026-09-03 snapshot: all 60 stops carrying a stand table also
 * carry an arrival-derived dwell entry, which is expected (a stop with visits
 * has arrivals) but worth re-checking if this ever prints a route the replay's
 * dwell cache is thin on.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { drizzle } from "drizzle-orm/better-sqlite3";

import { OUT_DIR, SNAP_DB, loadNet } from "./common.js";
import {
  SPLIT_WINDOW_DAYS,
  attachDrives,
  attachStandTables,
  calibrate,
  loadDriveGroups,
  loadStandGroups,
  splitWithheldRoutes,
} from "../../src/calibrator/calibrator.js";
import { TransitNetwork, type DwellStats, type SegmentStats } from "../../src/network/TransitNetwork.js";
import * as schema from "../../src/db/schema.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const OUT = process.env.SPLIT_OUT ?? path.join(OUT_DIR, "split-patch.json");
/**
 * Which routes the patch carries. The default is production's own answer —
 * `SPLIT_SERVED_ROUTE_IDS` minus `foldRoutes`, read out of the calibrator so
 * this tracks the server when that list changes. `SPLIT_ROUTES=all` withholds
 * nothing; it is NOT what production serves, and its only use is the paired
 * before/after run CLAUDE.md requires before a route is added to the allowlist.
 */
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

// A second handle on the same file: the calibrator speaks Drizzle, the rest of
// this directory speaks raw better-sqlite3. Read-only — `calibrate` only reads,
// and pushes its result into the in-memory network.
const sqlite = new Database(SNAP_DB, { readonly: true });
const db = drizzle(sqlite, { schema });

for (const table of ["stop_visits", "legs"] as const) {
  const present = sqlite
    .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { c: number };
  if (present.c === 0) {
    throw new Error(
      `${SNAP_DB} has no \`${table}\` table — the split cannot be derived from it. ` +
        "Backfill a writable copy first; see the header of this file.",
    );
  }
}
const visitCount = (sqlite.prepare("SELECT COUNT(*) c FROM stop_visits").get() as { c: number }).c;
const legCount = (sqlite.prepare("SELECT COUNT(*) c FROM legs").get() as { c: number }).c;
if (visitCount === 0 || legCount === 0) {
  throw new Error(`${SNAP_DB}: stop_visits ${visitCount} rows, legs ${legCount} rows — nothing to derive a split from.`);
}

// The instant the calibration is taken at. The default is the snapshot's last
// segment sample, i.e. the end of the data: the 30-day split window then covers
// the whole snapshot, and the (dow, hour) window underneath it is the replayed
// day's. Only the base segment/dwell tables move with this instant, and of
// those only PRESENCE matters here — a hop carries a drive when it has a
// calibrated segment, and that is decided by the 30-day sample pool, not by the
// hour (`computeSegmentStats` omits a group only when 30 days hold no plausible
// sample). So the choice of hour does not silently change coverage.
const segMax = (sqlite.prepare("SELECT MAX(started_at) m FROM segments").get() as { m: number | null }).m;
const NOW = process.env.SPLIT_NOW ? Date.parse(process.env.SPLIT_NOW) : (segMax ?? Date.now());
if (!Number.isFinite(NOW)) throw new Error(`SPLIT_NOW=${process.env.SPLIT_NOW} did not parse`);

// The split tables must not run past the snapshot itself: a backfill fed from
// the position archive will happily derive visits for days the replay never
// reaches, and every one of them would be future data for every rider in it.
// Measured against the snapshot's own last observation of any kind, with a
// few minutes of slack — the three tables stop writing at slightly different
// instants when a snapshot is taken from a running machine.
const visitMax = (sqlite.prepare("SELECT MAX(anchored_at) m FROM stop_visits").get() as { m: number }).m;
const legMax = (sqlite.prepare("SELECT MAX(departed_at) m FROM legs").get() as { m: number }).m;
const splitMax = Math.max(visitMax, legMax);
const dataEnd = Math.max(
  segMax ?? 0,
  (sqlite.prepare("SELECT MAX(arrived_at) m FROM arrivals").get() as { m: number | null }).m ?? 0,
  (sqlite.prepare("SELECT MAX(collected_at) m FROM raw_positions").get() as { m: number | null }).m ?? 0,
);
if (dataEnd > 0 && splitMax > dataEnd + 300_000) {
  console.error(
    `WARNING: the split tables run to ${new Date(splitMax).toISOString()}, ` +
      `${((splitMax - dataEnd) / 3_600_000).toFixed(1)} h past the snapshot's last observation ` +
      `(${new Date(dataEnd).toISOString()}). Those rows are future data for every rider in the replay. ` +
      "Re-run the backfill with --before the snapshot's data end.",
  );
}

const stats = calibrate(db, net.network, new Date(NOW));
console.error(
  `calibrated at ${new Date(NOW).toISOString()}: ${stats.segmentCount} segments, ${stats.dwellCount} dwells, ` +
    `${stats.standCount} stand tables, ${stats.driveCount} drives, from ${stats.splitSampleCount} visits/legs`,
);

// The attach step, run again onto tables this script owns, so `SPLIT_ROUTES`
// can widen the served set for an experiment. `attachStandTables` and
// `attachDrives` are the calibrator's own — the quantile levels, the median
// drive and the true sample counts are not restated here — and the seeding
// below reproduces the two maps they expect:
//
//  - a segment entry only where the hop HAS a calibrated segment, since
//    `attachDrives` skips a hop that does not (a distance prior has nowhere to
//    carry a drive). `source: "prior"` is exactly that absence.
//  - a dwell entry per (route, stop), which is what `getDwellStats` answers
//    with including its warm-up default — the same `?? { mean: 15, ... }`
//    `attachStandTables` falls back to.
//
// Any split `calibrate` already attached is stripped on the way in, so the
// re-attach is the only thing that can put one back.
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
const standCount = attachStandTables(dwTable, loadStandGroups(db, SPLIT_WINDOW_DAYS, NOW), withheld);
const driveCount = attachDrives(segTable, loadDriveGroups(db, SPLIT_WINDOW_DAYS, NOW), withheld);
console.error(
  `SPLIT_ROUTES=${SPLIT_ROUTES}: withheld ${withheld.size} routes, ${standCount} stand tables, ${driveCount} drives`,
);

// The same two loops `v1compat.ts` runs when it builds the payload, carrying
// only the fields the replay cannot serve. Whole seconds, exactly as on the
// wire: the feed's poll quantum is 5 s and the client reads integers.
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
  rows.push({
    route: r.name,
    hops: new Set(r.stops.map((_, i) => `${r.stops[i]}-${r.stops[(i + 1) % n]}`)).size,
    drives: Object.keys(segMap).length,
    stops: uniqueStops.size,
    stands: Object.keys(dwMap).length,
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(patch));

const totalDrives = rows.reduce((a, b) => a + b.drives, 0);
const totalStands = rows.reduce((a, b) => a + b.stands, 0);
console.log(`\n${OUT}  (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
console.log(`\n| route | hops | with drive | stops | with q |`);
console.log(`|---|---|---|---|---|`);
for (const r of rows) console.log(`| ${r.route} | ${r.hops} | ${r.drives} | ${r.stops} | ${r.stands} |`);
console.log(`| **total** | | **${totalDrives}** | | **${totalStands}** |`);
console.log(
  `\nRoutes carrying anything: ${rows.filter((r) => r.drives || r.stands).map((r) => r.route).join(", ") || "none"}` +
    (SPLIT_ROUTES === "all"
      ? " — SPLIT_ROUTES=all, so nothing is withheld. This is NOT what production serves."
      : " — the split is withheld everywhere else (SPLIT_SERVED_ROUTE_IDS, foldRoutes)."),
);

sqlite.close();
net.db.close();
