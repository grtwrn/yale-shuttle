/**
 * HOUR-STAND SERIES — the `PAYLOAD_SERIES` file that gives `rider-sim/run.ts`
 * the time-of-day stand tables (`qh`, src/calibrator/hourStand.ts) production
 * serves at gated layover cells.
 *
 * `model-patch.ts` writes ONE static table for a whole run, which is right for
 * the pooled 30-day `q` and wrong for `qh`: production recalibrates every five
 * minutes and the window slides with the clock. So this writes a table per
 * STEP (default 5 min) over [FROM, TO], each computed from the visits whose
 * evidence was in by that step (the calibrator's own loader and bounds), and
 * `run.ts` overlays the latest step at or before each poll on top of the
 * model patch.
 *
 * NOTHING HERE RE-DERIVES A NUMBER: the cell gate is `computeHourStandGates`
 * as of GATE_AT (default FROM — production refreshes it every six hours), the
 * table is `attachHourStandTables` onto the pooled table the calibrator would
 * serve at that step, and the emission is `v1compat.ts`'s `dwellHourFields`,
 * so the rounding is the wire's. Lap fits (served routes only) and the 3:11
 * release fit are put on the entries first, so the attacher steps aside for
 * them exactly as it does live.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/replay-1004.db FROM=2026-10-04T04:00:00Z TO=2026-10-05T04:00:00Z \
 *     SERIES_OUT=./scripts/.eta-replay/hour-series-1004.json npx tsx scripts/eta-replay/hour-stand-patch.ts
 *
 * Env: REPLAY_DB, FROM/TO (ISO), SERIES_OUT, GATE_AT (ISO), STEP_MIN (5),
 *      ROUTES (comma route ids: measure routes NOT on the ledger yet — that is
 *      how a route earns its place; default the ledger).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { drizzle } from "drizzle-orm/better-sqlite3";

import { OUT_DIR, SNAP_DB, loadNet } from "./common.js";
import { SPLIT_WINDOW_DAYS } from "../../src/calibrator/calibrator.js";
import {
  HOUR_STAND_ROUTE_IDS,
  attachHourStandTables,
  computeHourStandGates,
  layoverCandidates,
  loadStandVisits,
  servedHourStandCells,
  tenQuantiles,
} from "../../src/calibrator/hourStand.js";
import { LAP_SERVED_ROUTE_IDS, loadLapFits } from "../../src/calibrator/lapFit.js";
import type { DwellStats } from "../../src/network/TransitNetwork.js";
import { dwellHourFields, type DwellEntry } from "../../src/server/v1compat.js";
import * as schema from "../../src/db/schema.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const FROM = Date.parse(process.env.FROM ?? "");
const TO = Date.parse(process.env.TO ?? "");
if (!Number.isFinite(FROM) || !Number.isFinite(TO) || !(TO > FROM)) throw new Error("FROM and TO (ISO) are required, FROM < TO");
const GATE_AT = process.env.GATE_AT ? Date.parse(process.env.GATE_AT) : FROM;
const STEP_MS = (Number(process.env.STEP_MIN) || 5) * 60_000;
const ROUTES: ReadonlySet<number> = process.env.ROUTES
  ? new Set(process.env.ROUTES.split(",").map((x) => Number(x.trim())).filter(Number.isInteger))
  : HOUR_STAND_ROUTE_IDS;
const OUT = process.env.SERIES_OUT ?? path.join(OUT_DIR, "hour-series.json");

const net = loadNet();
const sqlite = new Database(SNAP_DB, { readonly: true });
const db = drizzle(sqlite, { schema });

const gates = computeHourStandGates(layoverCandidates(loadStandVisits(db, SPLIT_WINDOW_DAYS, GATE_AT, { routes: ROUTES })));
const cells = servedHourStandCells(gates, ROUTES);
const lapFits = loadLapFits(sqlite, GATE_AT);
console.error(`gate at ${new Date(GATE_AT).toISOString()} over routes {${[...ROUTES].join(",")}}: ${[...gates].map(([k, g]) => `${k} ${g.pass ? "pass" : "off"} (${Math.round(g.pooled)} -> ${Math.round(g.hour)} s, upper ${g.upper.toFixed(1)})`).join("; ")}`);
console.error(`served cells: ${[...cells].join(", ") || "(none)"}`);

const steps: Record<string, { dwells: Record<string, Record<string, Pick<DwellEntry, "qh" | "qhn">>> }> = {};
let withTable = 0;
const first = Math.floor(FROM / STEP_MS) * STEP_MS;
for (let t = first; t < TO; t += STEP_MS) {
  const visits = loadStandVisits(db, SPLIT_WINDOW_DAYS, t, { cells });
  // The pooled entry the calibrator would hold at t for each served cell —
  // the same rows, so `tenQuantiles` is `standQuantiles(g.all)` — with the
  // fits it would carry, so the attacher's exclusions are the live ones.
  const dwells = new Map<string, DwellStats>();
  for (const [key, vs] of visits) {
    const d: DwellStats = { mean: 0, stddev: 0, n: 0, q: tenQuantiles(vs.map((v) => v.stand)), qn: vs.length };
    const fit = lapFits.get(key);
    if (fit && LAP_SERVED_ROUTE_IDS.has(Number(key.split(":")[0]))) Object.assign(d, { lapB: fit.b, lapM: fit.m, lapN: fit.n });
    if (key === "3:11") Object.assign(d, { release: { stopId: 11 } });
    dwells.set(key, d);
  }
  attachHourStandTables(dwells, net.network, visits, t);
  const out: Record<string, Record<string, Pick<DwellEntry, "qh" | "qhn">>> = {};
  for (const [key, d] of dwells) {
    const f = dwellHourFields(d);
    if (!f.qh) continue;
    const [rid, sid] = key.split(":");
    (out[rid!] ??= {})[sid!] = f;
    withTable++;
  }
  steps[String(t)] = { dwells: out };
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  stepMs: STEP_MS, from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(), gateAt: new Date(GATE_AT).toISOString(),
  routes: [...ROUTES], cells: [...cells], gates: Object.fromEntries(gates), steps,
}));
console.error(`wrote ${OUT}: ${Object.keys(steps).length} steps, ${withTable} cell-steps carrying qh`);
