#!/usr/bin/env node
/**
 * What the operator's own ETA endpoint said, beside what the buses then did.
 *
 *   node scripts/upstream-eta-report.mjs [db-path] [--days=7] [--match-min=45]
 *
 * Read-only over `upstream_etas` (the verbatim census the collector keeps —
 * see src/collector/upstreamEtaSampler.ts) joined to `arrivals` (our observed
 * truth). Prints:
 *
 *   - rows per day, split into predictions / empty markers / idle-route probes,
 *     with distinct stops and buses;
 *   - the signed error of each prediction — (sampled_at + eta) − actual
 *     arrival, so POSITIVE means upstream promised the bus LATER than it came
 *     (pessimistic) and negative means it promised it earlier (optimistic) —
 *     as median and p90 by horizon bucket (0–2, 2–5, 5–10, >10 min), where the
 *     actual is the FIRST `arrivals` row for the same bus_name at the same
 *     stop after the sample, within --match-min (45 by default);
 *   - the share of predictions with NO such arrival in the window — the
 *     phantom rate, which is the first thing to look at for a bus that
 *     upstream kept promising while it was going out of service.
 *
 * Upstream's `avg` is whole minutes, so every error below carries ±30 s of
 * THEIR rounding before any real disagreement; a 20 s median is noise.
 *
 * It runs cleanly on an empty table — until the sampler has been live for a
 * few days there is simply nothing to report.
 *
 * ── Against production ─────────────────────────────────────────────────────
 *
 * The DB lives on the Fly volume and this script needs only better-sqlite3,
 * which /app/node_modules has. Pipe the script itself to node on the machine
 * (flyctl mangles quotes in -C, so the code goes over stdin, never inline):
 *
 *   cat scripts/upstream-eta-report.mjs | ~/.fly/bin/flyctl ssh console \
 *     -a yale-shuttle -C "node --input-type=module - /data/shuttle-v2.db --days=3"
 *
 * The database is opened `readonly`; nothing here writes.
 */
import { createRequire } from "node:module";
import path from "node:path";

// Resolves from the script's directory locally and from the cwd (/app) when
// piped over stdin on the Fly machine.
const require = createRequire(import.meta.url ?? `file://${process.cwd()}/`);
let Database;
try {
  Database = require("better-sqlite3");
} catch {
  Database = require(path.join(process.cwd(), "node_modules/better-sqlite3"));
}

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const dbPath =
  args.find((a) => !a.startsWith("--")) ??
  process.env.SHUTTLE_V2_DB ??
  path.join(process.env.SHUTTLE_V2_DB_DIR ?? "./store", "shuttle-v2.db");
const days = Math.max(1, Number(flag("days", 7)) || 7);
const matchMin = Math.max(1, Number(flag("match-min", 45)) || 45);

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const since = Date.now() - days * 24 * 60 * 60_000;

const hasTable = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'upstream_etas'")
  .get();
if (!hasTable) {
  console.log(`${dbPath}: no upstream_etas table yet (migration 0014 not applied).`);
  process.exit(0);
}

// ── Volume ──────────────────────────────────────────────────────────────────

const perDay = db
  .prepare(
    `SELECT date(sampled_at / 1000, 'unixepoch', 'localtime') AS day,
            COUNT(*) AS rows_,
            SUM(bus_id IS NOT NULL) AS predictions,
            SUM(bus_id IS NULL) AS empty,
            SUM(probe) AS probes,
            COUNT(DISTINCT stop_id) AS stops,
            COUNT(DISTINCT bus_name) AS buses,
            SUM(raw IS NOT NULL) AS with_raw
     FROM upstream_etas
     WHERE sampled_at >= ?
     GROUP BY day ORDER BY day`,
  )
  .all(since);

const total = db
  .prepare("SELECT COUNT(*) AS n, MIN(sampled_at) AS lo, MAX(sampled_at) AS hi FROM upstream_etas")
  .get();

console.log(`upstream_etas in ${dbPath}`);
if (!total.n) {
  console.log("  (empty — the sampler has written nothing yet)");
  process.exit(0);
}
console.log(
  `  ${total.n.toLocaleString()} rows, ${iso(total.lo)} → ${iso(total.hi)}` +
    ` (last ${days} d shown, TZ=${process.env.TZ ?? "local"})`,
);
console.log("");
console.log(pad("day", 11) + pad("rows", 9) + pad("preds", 9) + pad("empty", 7) + pad("probes", 7) + pad("stops", 6) + pad("buses", 6) + "raw");
for (const d of perDay) {
  console.log(
    pad(d.day, 11) + pad(d.rows_, 9) + pad(d.predictions, 9) + pad(d.empty, 7) +
      pad(d.probes, 7) + pad(d.stops, 6) + pad(d.buses, 6) + d.with_raw,
  );
}

// ── Error by horizon ────────────────────────────────────────────────────────
//
// One correlated MIN() per prediction; `arrivals_route_stop_time_idx` serves
// it (route_id is upstream's own and matches ours — same provider). Two kinds
// of row are left out rather than counted against upstream: a horizon beyond
// the match window cannot pair by construction, and a prediction younger than
// the window — measured against the NEWEST arrival we have, not the clock —
// has not had its chance to come true yet.

const matchMs = matchMin * 60_000;
const newestArrival = db.prepare("SELECT MAX(arrived_at) AS at FROM arrivals").get().at ?? 0;
const rows = db
  .prepare(
    `SELECT u.eta_sec AS eta,
            (SELECT MIN(a.arrived_at) FROM arrivals a
              WHERE a.route_id = u.route_id AND a.stop_id = u.stop_id
                AND a.bus_name = u.bus_name
                AND a.arrived_at > u.sampled_at AND a.arrived_at <= u.sampled_at + ?) - u.sampled_at
              AS actual_ms
     FROM upstream_etas u
     WHERE u.sampled_at >= ? AND u.sampled_at + ? <= ?
       AND u.bus_id IS NOT NULL AND u.eta_sec IS NOT NULL AND u.eta_sec <= ?`,
  )
  .all(matchMs, since, matchMs, newestArrival, matchMin * 60);

const buckets = [
  ["0–2 min", 0, 120],
  ["2–5 min", 120, 300],
  ["5–10 min", 300, 600],
  [">10 min", 600, Infinity],
];

console.log("");
console.log(
  `Signed error, predicted − actual, s (positive = upstream promised it later than it came).` +
    ` Match: first arrival of the same bus at the stop within ${matchMin} min.`,
);
console.log(`Upstream rounds to whole minutes: ±30 s of the error is theirs.`);
console.log("");
console.log(pad("horizon", 11) + pad("n", 8) + pad("paired", 8) + pad("phantom", 9) + pad("median", 9) + pad("p90", 9) + "|err| p50");
for (const [label, lo, hi] of buckets) {
  const inBucket = rows.filter((r) => r.eta >= lo && r.eta < hi);
  const paired = inBucket.filter((r) => r.actual_ms !== null);
  const errs = paired.map((r) => r.eta - r.actual_ms / 1000).sort((a, b) => a - b);
  const abs = paired.map((r) => Math.abs(r.eta - r.actual_ms / 1000)).sort((a, b) => a - b);
  const phantom = inBucket.length ? (inBucket.length - paired.length) / inBucket.length : null;
  console.log(
    pad(label, 11) + pad(inBucket.length, 8) + pad(paired.length, 8) +
      pad(phantom === null ? "–" : `${(phantom * 100).toFixed(0)}%`, 9) +
      pad(fmt(quantile(errs, 0.5)), 9) + pad(fmt(quantile(errs, 0.9)), 9) + fmt(quantile(abs, 0.5)),
  );
}
if (rows.length === 0) {
  console.log(`  (no predictions old enough to judge yet — each needs ${matchMin} min of arrivals after it)`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}
function fmt(v) {
  return v === null ? "–" : (v > 0 ? "+" : "") + v.toFixed(0);
}
function pad(v, n) {
  return String(v ?? "").padEnd(n);
}
function iso(ms) {
  // Same clock as the per-day table above (`date(..., 'localtime')`).
  return ms ? new Date(ms).toLocaleString("sv-SE").slice(0, 16) : "?";
}
