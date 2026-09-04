/**
 * Build the rider simulator's PAYLOAD_PATCH from the checked-in departure
 * tables, so a replay serves the SAME stand/drive split production serves.
 *
 * Production (PR #85) reads `stop_visits`/`legs` in the calibrator and puts
 *   dwells[route][stop].q / .qn      ten stand quantiles at (i+0.5)/10,
 *                                    departed_at - pinned_at  (the `pinned` clock)
 *   segments[route]["A-B"].drive / .driveN   the MEDIAN one-hop leg on the same clock
 * on every route in SPLIT_SERVED_ROUTE_IDS (Red 3, Blue Day 1) and withholds
 * the rest — the folds because one stop id carries two different passes.
 * The offline calibration in scripts/eta-replay/common.ts predates all of
 * that, so a replay without this patch scores the pre-#85 client.
 *
 *   node scripts/eta-replay/split-patch.mjs > /path/split-patch.json
 *
 * Env: ROUTES (default "3,1"), CLOCK (pinned|clear|rest, default pinned),
 *      TABLES (the departure-tables JSON).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.TABLES ?? path.resolve(HERE, "../../../../docs/data/departure-tables-2026-09-03.json");
const ROUTES = new Set((process.env.ROUTES ?? "3,1").split(",").map((s) => Number(s.trim())));
const CLOCK = process.env.CLOCK ?? "pinned";
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const STAND_Q_COUNT = 10;

const tables = JSON.parse(fs.readFileSync(SRC, "utf8"));

/** Read the 11-point quantile grid as a piecewise-linear inverse CDF. */
const at = (levels, q, p) => {
  if (p <= levels[0]) return q[0];
  for (let i = 1; i < levels.length; i++) {
    if (p <= levels[i]) {
      const w = levels[i] - levels[i - 1];
      return w <= 0 ? q[i] : q[i - 1] + ((q[i] - q[i - 1]) * (p - levels[i - 1])) / w;
    }
  }
  return q[q.length - 1];
};

const out = { segments: {}, dwells: {} };
let stops = 0;
let hops = 0;
for (const s of tables.stops) {
  if (!ROUTES.has(s.routeId)) continue;
  const t = s[`stand${cap(CLOCK)}`];
  if (!t || !t.n) continue;
  const q = [];
  for (let i = 0; i < STAND_Q_COUNT; i++) q.push(Math.round(at(s.quantiles, t.q, (i + 0.5) / STAND_Q_COUNT)));
  (out.dwells[String(s.routeId)] ??= {})[String(s.stopId)] = { q, qn: t.n };
  stops++;
}
for (const h of tables.hops) {
  if (!ROUTES.has(h.routeId) || h.hops !== 1) continue;
  const t = h[`drive${cap(CLOCK)}`];
  if (!t || !t.n) continue;
  const med = at(h.quantiles, t.q, 0.5);
  (out.segments[String(h.routeId)] ??= {})[`${h.fromStopId}-${h.toStopId}`] = { drive: Math.round(med), driveN: t.n };
  hops++;
}
console.error(`split-patch: clock=${CLOCK} routes=${[...ROUTES].join(",")} stops=${stops} hops=${hops}`);
process.stdout.write(JSON.stringify(out));
