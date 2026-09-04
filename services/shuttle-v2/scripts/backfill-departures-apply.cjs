#!/usr/bin/env node
/**
 * Apply a `scripts/backfill-departures.ts --out rows.json` file to a database.
 *
 * Plain CommonJS with no dependencies beyond better-sqlite3, so it runs on the
 * production machine as-is:
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York npx tsx scripts/backfill-departures.ts --db ./store/snap.db --out /tmp/rows.json
 *   ~/.fly/bin/flyctl ssh sftp shell -a yale-shuttle            # put /tmp/rows.json /tmp/rows.json
 *   ~/.fly/bin/flyctl ssh sftp shell -a yale-shuttle            # put scripts/backfill-departures-apply.cjs /tmp/apply.cjs
 *   ~/.fly/bin/flyctl ssh console -a yale-shuttle -C "node /tmp/apply.cjs /tmp/rows.json /data/shuttle-v2.db"
 *
 * The same two safety rules as the generator, re-applied here against the
 * target's CURRENT contents (the live collector has kept writing since the
 * file was made): a row at or after the target's earliest live visit is
 * skipped, and a row whose exact key is already present is skipped. One
 * transaction; the process holding the DB open is fine with it (WAL, 5 s busy
 * timeout). Prints what it did; `--dry-run` prints without writing.
 */
const fs = require("node:fs");
const path = require("node:path");

const [rowsPath, dbPath, ...rest] = process.argv.slice(2);
if (!rowsPath || !dbPath) {
  console.error("usage: node backfill-departures-apply.cjs <rows.json> <db path> [--dry-run]");
  process.exit(2);
}
const DRY = rest.includes("--dry-run");

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  Database = require(path.join("/app/node_modules", "better-sqlite3"));
}
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const file = JSON.parse(fs.readFileSync(rowsPath, "utf8"));
const visits = file.visits || [];
const legs = file.legs || [];
console.log(`file: ${visits.length} visits, ${legs.length} legs, generated ${file.generatedAt}, cutoff ${file.cutoff ? new Date(file.cutoff).toISOString() : "none"}`);

const liveMin = db.prepare("SELECT MIN(anchored_at) m FROM stop_visits").get().m;
const cutoff = liveMin ?? Infinity;
console.log(`target: ${db.prepare("SELECT COUNT(*) c FROM stop_visits").get().c} visits, ${db.prepare("SELECT COUNT(*) c FROM legs").get().c} legs; cutoff ${Number.isFinite(cutoff) ? new Date(cutoff).toISOString() : "none"}`);

const haveVisit = new Set(db.prepare("SELECT bus_name b, route_id r, stop_id s, anchored_at t FROM stop_visits").all().map((r) => `${r.b}|${r.r}|${r.s}|${r.t}`));
const haveLeg = new Set(db.prepare("SELECT bus_name b, route_id r, from_stop_id f, to_stop_id t, departed_at d FROM legs").all().map((r) => `${r.b}|${r.r}|${r.f}|${r.t}|${r.d}`));

const keepVisits = visits.filter((v) => v.anchoredAt < cutoff && !haveVisit.has(`${v.busName}|${v.routeId}|${v.stopId}|${v.anchoredAt}`));
const keepLegs = legs.filter((l) => l.departedAt < cutoff && !haveLeg.has(`${l.busName}|${l.routeId}|${l.fromStopId}|${l.toStopId}|${l.departedAt}`));
console.log(`to insert: ${keepVisits.length} visits (${visits.length - keepVisits.length} skipped), ${keepLegs.length} legs (${legs.length - keepLegs.length} skipped)`);

const insVisit = db.prepare(`INSERT INTO stop_visits (bus_id, bus_name, anchor_bus_id, route_id, stop_id, stop_index,
  anchored_at, pinned_at, arrived_at, departed_at, stand_sec, inside_sec, outcome, how, confidence, first_step_m, steps,
  far_m, confirm_sec, rest_polls, shuffles, first_moved_at, last_at_rest_at, closest_m, dow, hour)
  VALUES (@busId, @busName, @anchorBusId, @routeId, @stopId, @stopIndex, @anchoredAt, @pinnedAt, @arrivedAt, @departedAt,
  @standSec, @insideSec, @outcome, @how, @confidence, @firstStepM, @steps, @farM, @confirmSec, @restPolls, @shuffles,
  @firstMovedAt, @lastAtRestAt, @closestM, @dow, @hour)`);
const insLeg = db.prepare(`INSERT INTO legs (bus_id, bus_name, route_id, from_stop_id, from_index, to_stop_id, to_index, hops,
  departed_at, arrived_at, to_pinned_at, leg_sec, hold_sec, drive_sec, holds, reached, dow, hour)
  VALUES (@busId, @busName, @routeId, @fromStopId, @fromIndex, @toStopId, @toIndex, @hops, @departedAt, @arrivedAt,
  @toPinnedAt, @legSec, @holdSec, @driveSec, @holds, @reached, @dow, @hour)`);

const nul = (v) => (v === undefined ? null : v);
const visitParams = (v) => ({
  busId: v.busId, busName: v.busName, anchorBusId: v.anchorBusId, routeId: v.routeId, stopId: v.stopId, stopIndex: v.stopIndex,
  anchoredAt: v.anchoredAt, pinnedAt: nul(v.pinnedAt), arrivedAt: nul(v.arrivedAt), departedAt: nul(v.departedAt),
  standSec: nul(v.standSec), insideSec: nul(v.insideSec), outcome: v.outcome, how: nul(v.how), confidence: nul(v.confidence),
  firstStepM: nul(v.firstStepM), steps: v.steps, farM: nul(v.farM), confirmSec: nul(v.confirmSec), restPolls: v.restPolls,
  shuffles: v.shuffles, firstMovedAt: nul(v.firstMovedAt), lastAtRestAt: nul(v.lastAtRestAt), closestM: v.closestM, dow: v.dow, hour: v.hour,
});
const legParams = (l) => ({
  busId: l.busId, busName: l.busName, routeId: l.routeId, fromStopId: l.fromStopId, fromIndex: l.fromIndex, toStopId: l.toStopId,
  toIndex: l.toIndex, hops: l.hops, departedAt: l.departedAt, arrivedAt: l.arrivedAt, toPinnedAt: nul(l.toPinnedAt), legSec: l.legSec,
  holdSec: l.holdSec, driveSec: l.driveSec, holds: l.holds, reached: l.reached ? 1 : 0, dow: l.dow, hour: l.hour,
});

if (DRY) {
  console.log("dry run: nothing written");
} else {
  db.transaction(() => {
    for (const v of keepVisits) insVisit.run(visitParams(v));
    for (const l of keepLegs) insLeg.run(legParams(l));
  })();
  console.log(`inserted ${keepVisits.length} visits, ${keepLegs.length} legs`);
  console.log(`target now: ${db.prepare("SELECT COUNT(*) c FROM stop_visits").get().c} visits, ${db.prepare("SELECT COUNT(*) c FROM legs").get().c} legs`);
}
db.close();
