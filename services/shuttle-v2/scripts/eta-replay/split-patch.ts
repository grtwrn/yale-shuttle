/**
 * Build a rider-sim PAYLOAD_PATCH from departure-tables.json (the clear clock
 * hopPricing reads). Cells below MIN_STAND_SAMPLES / MIN_DRIVE_SAMPLES are
 * omitted — the client withholds them anyway.
 *
 *   npx tsx scripts/eta-replay/split-patch.ts \
 *     [docs/data/departure-tables-2026-09-03.json] \
 *     [scripts/.eta-replay/split-patch.json]
 */
import fs from "node:fs";
import path from "node:path";

import { MIN_DRIVE_SAMPLES, MIN_STAND_SAMPLES } from "../../web/src/hopPricing.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const src = process.argv[2] ?? path.join(here, "../../../../docs/data/departure-tables-2026-09-03.json");
const dest = process.argv[3] ?? path.join(here, "../.eta-replay/split-patch.json");

interface Cell { n: number; mean: number; q: number[] }
interface StopRow { routeId: number; stopId: number; standClear: Cell | null }
interface HopRow {
  routeId: number; fromStopId: number; toStopId: number; hops: number; driveClear: Cell | null;
}

const tables = JSON.parse(fs.readFileSync(src, "utf8")) as { stops: StopRow[]; hops: HopRow[] };
const dwells: Record<string, Record<string, { q: number[]; qn: number }>> = {};
const segments: Record<string, Record<string, { drive: number; driveN: number }>> = {};
let nStand = 0, nDrive = 0;
for (const s of tables.stops) {
  if (!s.standClear || s.standClear.n < MIN_STAND_SAMPLES) continue;
  (dwells[String(s.routeId)] ??= {})[String(s.stopId)] = { q: s.standClear.q, qn: s.standClear.n };
  nStand++;
}
for (const h of tables.hops) {
  if (h.hops !== 1 || !h.driveClear || h.driveClear.n < MIN_DRIVE_SAMPLES) continue;
  (segments[String(h.routeId)] ??= {})[`${h.fromStopId}-${h.toStopId}`] = {
    drive: h.driveClear.mean, driveN: h.driveClear.n,
  };
  nDrive++;
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify({ segments, dwells }, null, 1) + "\n");
console.error(`wrote ${dest}: ${nStand} stand tables, ${nDrive} drive hops`);
