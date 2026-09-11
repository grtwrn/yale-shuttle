#!/usr/bin/env node
/**
 * What riders were told, beside what the bus then did.
 *
 *   npm run predictions                       # last 24 h, summary
 *   npm run predictions -- --hours=6 --route=3
 *   npm run predictions -- --out=/tmp/red.jsonl --limit=5000
 *
 * Reads the operator-only `/api/predictions` (admin HEADER; the stats cookie
 * deliberately does not unlock it). Same token as the triage queue:
 * $SHUTTLE_ADMIN_TOKEN, else ~/.yale-shuttle-admin-token.
 *
 * ── Checking the rider simulator against reality ───────────────────────────
 *
 * `scripts/eta-replay/rider-sim/run.ts` replays the real client over a day of
 * captured positions and reports what a rider would have read. Until now there
 * was no way to tell whether it was right — a lying harness and a healthy one
 * look identical. Now there is:
 *
 *   1. Pick a day the fleet was reporting, and note the build:
 *        npm run predictions -- --hours=24 | head          # `builds` names it
 *   2. Dump the observed readings:
 *        npm run predictions -- --hours=24 --route=3 --limit=5000 \
 *          --out=/tmp/observed.jsonl
 *   3. Run the simulator over the SAME day, from a tree checked out at that
 *      build, with a DB snapshot taken after it:
 *        CLIENT_ROOT=/path/to/that/tree \
 *        npx tsx scripts/eta-replay/rider-sim/run.ts --routes=Red
 *   4. Join on (busName, stopId, predictedAt bucket). A logged row and a
 *      replayed reading for the same 15 s bucket should agree to within a
 *      display bucket; the simulator's own approximations (calibration phase,
 *      detector age — see docs/rider-sim.md) are worth about a minute of
 *      level, so systematic disagreement beyond that is the harness, not the
 *      world.
 *
 * If they disagree, the logged row wins: it is what the screen said.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BOT_BASE_URL ?? "https://yale-shuttle.fly.dev";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

function token() {
  if (process.env.SHUTTLE_ADMIN_TOKEN) return process.env.SHUTTLE_ADMIN_TOKEN.trim();
  const file = path.join(os.homedir(), ".yale-shuttle-admin-token");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    console.error(`No admin token. Set $SHUTTLE_ADMIN_TOKEN or put it in ${file}.`);
    process.exit(1);
  }
}

const params = new URLSearchParams();
for (const name of ["hours", "route", "stop", "bus", "build", "limit"]) {
  const v = arg(name);
  if (v !== undefined) params.set(name, v);
}
if (!params.has("hours")) params.set("hours", "24");

const url = `${BASE}/api/predictions?${params}`;
const res = await fetch(url, { headers: { "x-admin-token": token() } });
if (res.status === 401) {
  console.error("Rejected: the token is wrong. Check ~/.yale-shuttle-admin-token.");
  process.exit(1);
}
if (res.status === 503) {
  console.error("The server has no SHUTTLE_ADMIN_TOKEN configured.");
  process.exit(1);
}
if (!res.ok) {
  console.error(`Unexpected ${res.status} from ${url}`);
  process.exit(1);
}

const { summary, rows } = await res.json();

const out = arg("out");
if (out) {
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.error(`${rows.length} rows -> ${out}`);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ summary, rows }));
  process.exit(0);
}

const row = (label, v) => `  ${label.padEnd(26)}${String(v).padStart(8)}`;
console.log(`\nwhat riders were told — last ${params.get("hours")} h\n`);
console.log(row("readings logged", summary.n));
console.log(row("...paired with an arrival", summary.paired));
if (summary.paired > 0) {
  console.log(row("median |error|", `${summary.medianAbsErrorSec}s`));
  console.log(row("p90 |error|", `${summary.p90AbsErrorSec}s`));
  console.log(
    row("median signed error", `${summary.medianSignedErrorSec}s`) +
      (summary.medianSignedErrorSec < 0 ? "   (bus beat the promise)" : "   (bus was later)"),
  );
}
console.log("\nbundles that produced them\n");
for (const b of summary.builds) console.log(row(b.build ?? "(unknown)", b.n));

if (summary.n === 0) {
  console.log(
    "\n  Nothing logged. Either no sampled rider had a countdown on screen in\n" +
      "  this window, or SHUTTLE_PREDICTION_SAMPLE is 0.\n",
  );
} else {
  console.log(
    "\n  A row is a statement about a BUS: one per (vehicle, stop, 15 s), no\n" +
      "  matter how many browsers reported it, and no viewer is stored.\n" +
      "  Retention is 30 days. See docs/prediction-log.md.\n",
  );
}
