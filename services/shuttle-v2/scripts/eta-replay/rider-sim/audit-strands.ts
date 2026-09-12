/** Re-score immutable saved transitions, retaining unattributable findings. */
import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { strandAttribution, compareRuns, type WaitResult } from "./lib.js";
import { parseBusEtaText } from "../../canary-metrics.mjs";
const [ap, bp] = process.argv.slice(2);
if (!ap || !bp) throw new Error("Usage: audit-strands.ts A.waits.jsonl B.waits.jsonl");
function read(path: string) {
  const raw = fs.readFileSync(path, "utf8");
  const rows: WaitResult[] = raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length, "Duplicate wait IDs");
  for (const row of rows) {
    assert(Number.isFinite(row.t0));
    if (row.arrivedAt !== null) assert(Number.isFinite(row.arrivedAt) && row.arrivedAt >= row.t0);
    let previous = row.t0;
    for (const t of row.transitions) {
      assert(Number.isFinite(t.atMs) && Number.isFinite(t.driftSec) && t.atMs >= previous, "Invalid transition");
      previous = t.atMs;
    }
    const old = row.transitions.some(t => {
      const a = parseBusEtaText(t.to), b = parseBusEtaText(t.from);
      return a && b && t.driftSec <= -120 && -t.driftSec > a.first[1]!
        && row.arrivedAt !== null && row.arrivedAt >= t.atMs && row.arrivedAt - t.atMs <= 120000;
    });
    assert.equal(!!old, row.strand, "Legacy score does not reproduce: " + row.id);
  }
  return { rows, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
}
const a = read(ap), b = read(bp), norm = (s: string | null) => s?.replace(/^#/, "");
const bm = new Map(b.rows.map(r => [r.id, r]));
const excluded: Record<string, number> = {}, aa: WaitResult[] = [], bb: WaitResult[] = [];
for (const x of a.rows) {
  const y = bm.get(x.id);
  const reason = !y ? "unpaired" : x.t0 !== y.t0 || x.boardStopId !== y.boardStopId ? "different_request"
    : x.outcome !== "arrived" || y.outcome !== "arrived" ? "arrival_unobserved"
    : x.neverShown || y.neverShown ? "no_reading"
    : x.busAtStopOnArrival || y.busAtStopOnArrival ? "already_at_stop"
    : x.arrivedAt !== y.arrivedAt || norm(x.arrivedBus) !== norm(y.arrivedBus) ? "different_truth" : null;
  if (reason) { excluded[reason] = (excluded[reason] ?? 0) + 1; continue; }
  aa.push(x); bb.push(y!);
}
function rescore(rows: WaitResult[]) {
  const classifications = { none: 0, secondary: 0, unmatched: 0, confirmed: 0 }, changed: string[] = [];
  const out = rows.map(w => {
    let strand = false, unattributedStrand = false;
    for (const t of w.transitions) {
      const label = strandAttribution(t, w.arrivedAt, w.arrivedBus); classifications[label]++;
      if (label === "confirmed") strand = true;
      if (label === "secondary" || label === "unmatched") unattributedStrand = true;
    }
    if (w.strand !== strand) changed.push(w.id);
    return { ...w, strand, unattributedStrand };
  });
  return { out, classifications, changed };
}
const ar = rescore(aa), br = rescore(bb);
const primary = (w: WaitResult) => w.transitions.some(t => t.leader && t.catastrophic);
const secondary = (w: WaitResult) => w.transitions.some(t => !t.leader && t.catastrophic);
console.log(JSON.stringify({ inputs: [{ path: ap, sha256: a.sha256, rows: a.rows.length }, { path: bp, sha256: b.sha256, rows: b.rows.length }],
  validPairedWaits: aa.length, excluded, legacyReproduced: true,
  legacyStrand: compareRuns(aa, bb).strand, attributableStrand: compareRuns(ar.out, br.out).strand,
  catastrophicWaits: { a: { primary: aa.filter(primary).length, secondary: aa.filter(secondary).length }, b: { primary: bb.filter(primary).length, secondary: bb.filter(secondary).length } },
  a: { classifications: ar.classifications, removedIds: ar.changed }, b: { classifications: br.classifications, removedIds: br.changed },
  limitation: "Checks saved first-arrival identity/timing, not independent GPS truth or second-slot arrivals. Unattributed drops are not passes; stability transitions remain unchanged." }, null, 2));
