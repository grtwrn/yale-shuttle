/**
 * FREEZE AUDIT: how often the countdown a rider is watching does not move,
 * split by whether the bus's raw GPS fix moved between those two polls.
 *
 * WHY THIS AND NOT `--compare`. The rider sim's comparison scores JUMPS —
 * strands, reversals, catastrophic steps. It says nothing about a number that
 * sits still, and a number that sits still is exactly what the operator caught
 * on 2026-09-04: Red #310 parked at 344 Winchester, the pause chip counting up
 * and the board stuck on "5 min". Any change that clamps the estimate — the
 * standing ceiling in `hopPricing.flooredStandSec`, or the slew limiter the
 * operator rejected — buys its stability by freezing, so the freeze share is
 * the price and it has to be quoted.
 *
 * THE SPLIT IS THE WHOLE POINT. A frozen countdown is honest when the bus is
 * standing still: nothing happened, so nothing should change. It is a defect
 * when the bus MOVED and the number did not — that is a stale number pinned in
 * front of a rider. So every frozen poll-pair is classified by the pinned
 * bus's own coordinates:
 *
 *   fix identical    the feed repeated the position (53.6% of samples do;
 *                    the feed has a ~30 m deadband). Freezing here is right.
 *   fix moved        the bus covered reportable ground and the board did not
 *                    react. THIS is the number to watch.
 *
 * WHAT IS RECONSTRUCTED. `run.ts` does not serialise per-poll ticks, only the
 * transitions (a change in the DISPLAYED bucket, one entry per poll where the
 * text moved) and the wait's window. Polls are every ~5 s and the ticks are
 * subsampled at SAMPLE_MS, so "a poll with no transition" is "a poll where the
 * display did not move". To keep that inference sound, only waits that ran a
 * single uninterrupted countdown on ONE pinned vehicle are scored — no pin
 * change, no vanished countdown — and pairs further apart than a feed gap are
 * dropped.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York CAPTURE=a.jsonl,b.jsonl npx tsx \
 *     scripts/eta-replay/rider-sim/freeze-audit.ts a.waits.jsonl b.waits.jsonl
 */
import fs from "node:fs";

import { dedupeAndSort, groupPolls, parseCaptureLine, type PosRow, type WaitResult } from "./lib.js";

const MAX_POLL_GAP_MS = 20_000;

const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (files.length === 0) {
  console.error("usage: freeze-audit.ts <run.waits.jsonl> [run2.waits.jsonl ...]");
  process.exit(2);
}

const captureFiles = (process.env.CAPTURE
  ? process.env.CAPTURE.split(",")
  : fs.readdirSync(`${process.env.HOME}/shuttle-captures`)
      .filter((f) => /^positions-\d{8}\.jsonl$/.test(f)).sort()
      .map((f) => `${process.env.HOME}/shuttle-captures/${f}`)
).map((f) => f.trim()).filter(Boolean);

const rows: PosRow[] = [];
for (const f of captureFiles) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const r = parseCaptureLine(line);
    if (r) rows.push(r);
  }
}
const polls = groupPolls(dedupeAndSort(rows));
const pollAt = polls.map((p) => p[0]!.t);
/** poll index -> bus_name -> "lat,lon", so an identical fix is a string compare. */
const fixAt = polls.map((p) => {
  const m = new Map<string, string>();
  for (const r of p) m.set(r.b, `${r.lat},${r.lon}`);
  return m;
});
console.error(`captures: ${rows.length} rows, ${polls.length} polls`);

/** Poll indices covering [from, to]. */
function pollRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < pollAt.length; i++) {
    if (pollAt[i]! < from) continue;
    if (pollAt[i]! > to) break;
    out.push(i);
  }
  return out;
}

interface Tally { pairs: number; frozen: number }
const zero = (): Tally => ({ pairs: 0, frozen: 0 });
const pct = (a: number, b: number) => (b === 0 ? "  n/a" : `${((100 * a) / b).toFixed(1)}%`);

for (const file of files) {
  const waits = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as WaitResult);
  const byRoute = new Map<string, { still: Tally; moved: Tally }>();
  const all = { still: zero(), moved: zero() };
  let scored = 0;

  for (const w of waits) {
    if (w.outcome !== "arrived" || w.arrivedAt === null) continue;
    if (w.neverShown || w.vanished > 0 || w.pinChanged) continue;
    if (!w.firstSight || w.pins.length !== 1) continue;
    const bus = w.pins[0]!;
    const idx = pollRange(w.firstSight.atMs, w.arrivedAt);
    if (idx.length < 3) continue;
    const changedAt = new Set(w.transitions.map((t) => t.atMs));
    const r = byRoute.get(w.label) ?? { still: zero(), moved: zero() };
    byRoute.set(w.label, r);
    scored++;
    for (let k = 1; k < idx.length; k++) {
      const prev = idx[k - 1]!, cur = idx[k]!;
      if (pollAt[cur]! - pollAt[prev]! > MAX_POLL_GAP_MS) continue;
      const a = fixAt[prev]!.get(bus), b = fixAt[cur]!.get(bus);
      if (a === undefined || b === undefined) continue;  // bus off the feed this poll
      const bucket = a === b ? "still" : "moved";
      const frozen = !changedAt.has(pollAt[cur]!);
      r[bucket].pairs++; all[bucket].pairs++;
      if (frozen) { r[bucket].frozen++; all[bucket].frozen++; }
    }
  }

  const tot = { pairs: all.still.pairs + all.moved.pairs, frozen: all.still.frozen + all.moved.frozen };
  console.log(`\n=== ${file}`);
  console.log(`  waits scored ${scored}, poll pairs ${tot.pairs}`);
  console.log(`  frozen overall            ${pct(tot.frozen, tot.pairs)}  (${tot.frozen}/${tot.pairs})`);
  console.log(`  ...with the fix IDENTICAL ${pct(all.still.frozen, all.still.pairs)}  (${all.still.frozen}/${all.still.pairs})   <- honest: nothing happened`);
  console.log(`  ...with the fix MOVED     ${pct(all.moved.frozen, all.moved.pairs)}  (${all.moved.frozen}/${all.moved.pairs})   <- the failure mode`);
  for (const [label, r] of [...byRoute].sort()) {
    const t = { pairs: r.still.pairs + r.moved.pairs, frozen: r.still.frozen + r.moved.frozen };
    console.log(`    ${label.padEnd(14)} all ${pct(t.frozen, t.pairs)}  still ${pct(r.still.frozen, r.still.pairs)}  moved ${pct(r.moved.frozen, r.moved.pairs)}  (${t.pairs} pairs)`);
  }
}
