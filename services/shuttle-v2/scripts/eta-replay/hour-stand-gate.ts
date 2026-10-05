/**
 * HOUR-STAND GATE — the per-cell table behind `src/calibrator/hourStand.ts`.
 *
 * Runs the calibrator's own loader and cell gate against a replay database as
 * of `GATE_AT` (default: the database's last visit), for EVERY layover cell,
 * and prints which would be served and why each other one is not: too few
 * visits or days, not better than the pooled table beyond its day-to-day
 * noise, a route not on the rollout ledger, a cell that carries a lap or
 * release fit, a stop the route lists twice.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/replay-1004.db npx tsx scripts/eta-replay/hour-stand-gate.ts
 *   #   GATE_AT=ISO  GATE_OUT=path.json  (the full table as JSON beside the printout)
 */
import fs from "node:fs";
import { createRequire } from "node:module";

import { drizzle } from "drizzle-orm/better-sqlite3";

import { SPLIT_WINDOW_DAYS } from "../../src/calibrator/calibrator.js";
import {
  HOUR_STAND_ROUTE_IDS,
  computeHourStandGates,
  layoverCandidates,
  loadStandVisits,
} from "../../src/calibrator/hourStand.js";
import { LAP_SERVED_ROUTE_IDS, loadLapFits } from "../../src/calibrator/lapFit.js";
import * as schema from "../../src/db/schema.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const DB = process.env.REPLAY_DB ?? "./store/snap.db";
const sqlite = new Database(DB, { readonly: true });
const db = drizzle(sqlite, { schema });
const last = (sqlite.prepare("SELECT MAX(anchored_at) m FROM stop_visits").get() as { m: number }).m;
const AT = process.env.GATE_AT ? Date.parse(process.env.GATE_AT) : last;
if (!Number.isFinite(AT)) throw new Error(`GATE_AT=${process.env.GATE_AT} did not parse`);

const names = new Map<number, string>((sqlite.prepare("SELECT id, name FROM stops").all() as Array<{ id: number; name: string }>).map((r) => [r.id, r.name]));
const routes = new Map<number, { name: string; stops: number[] }>();
for (const r of sqlite.prepare("SELECT id, name, stops_json FROM routes").all() as Array<{ id: number; name: string; stops_json: string }>) {
  let stops: number[] = [];
  try { stops = (JSON.parse(r.stops_json) as Array<number | { id: number }>).map((x) => (typeof x === "number" ? x : Number(x.id))); } catch { /* unparseable: treated as no repeats */ }
  routes.set(r.id, { name: r.name, stops });
}

const visits = loadStandVisits(db, SPLIT_WINDOW_DAYS, AT);
const cands = layoverCandidates(visits);
const gates = computeHourStandGates(cands);
// Production attaches a lap fit only on a served route; the release fit only at 3:11.
const lapCells = new Set([...loadLapFits(sqlite, AT).keys()].filter((k) => LAP_SERVED_ROUTE_IDS.has(Number(k.split(":")[0]))));
const releaseCells = new Set(["3:11"]);

const rows = [...gates].map(([key, g]) => {
  const [rid, sid] = key.split(":").map(Number) as [number, number];
  const r = routes.get(rid);
  const repeated = r ? r.stops.filter((s) => s === sid).length > 1 : false;
  let served = g.pass, why = g.reason;
  if (served && !HOUR_STAND_ROUTE_IDS.has(rid)) { served = false; why = "gate pass; route not on the rollout ledger (no rider-sim pair yet)"; }
  if (served && (lapCells.has(key) || releaseCells.has(key))) { served = false; why = "gate pass; cell carries a served lap/release fit"; }
  if (served && repeated) { served = false; why = "gate pass; stop repeats on the route (per-pass tables)"; }
  return {
    cell: key, route: r?.name ?? "?", stop: names.get(sid) ?? "?", served: served ? "ON" : "off", why,
    n: g.n, days: g.days, med: Math.round(g.medStand),
    maePooled: Math.round(g.pooled), maeHour: Math.round(g.hour), delta: Math.round(g.hour - g.pooled), upper: Math.round(g.upper * 10) / 10,
    biasPooled: Math.round(g.biasPooled), biasHour: Math.round(g.biasHour),
    am: `${Math.round(g.morningBiasPooled)} -> ${Math.round(g.morningBiasHour)} (${g.morningN})`,
  };
}).sort((a, b) => (a.delta - b.delta) || a.cell.localeCompare(b.cell));

console.log(`hour-stand gate at ${new Date(AT).toISOString()} over ${SPLIT_WINDOW_DAYS} d of stop_visits (${DB}); ${visits.size} cells read, ${cands.size} layover candidates, ledger {${[...HOUR_STAND_ROUTE_IDS].join(",")}}`);
console.log("bias = actual - predicted (positive: the bus stood LONGER than priced); am = before 10:00 ET");
console.table(rows);
if (process.env.GATE_OUT) fs.writeFileSync(process.env.GATE_OUT, JSON.stringify({ at: new Date(AT).toISOString(), db: DB, rows }, null, 1));
