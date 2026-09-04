/**
 * The guards that stand between `scripts/backfill-departures.ts` and a green
 * run that produced nothing.
 *
 * On 2026-09-04 the generator was run, printed a correct-looking per-route
 * coverage table (`Red, 344 Winchester: stand n = 24`) and wrote
 * `{"visits":[],"legs":[],"cutoff":1788443472343}` — zero rows, exit 0. The
 * coverage table is "the DB after this backfill", so it reads the same whether
 * the rows came from this run or were already there; and 1788443472343 is the
 * archive's OWN first sample, which the cutoff can only equal when the
 * database supplying it already holds archive-derived rows. Every derived
 * event then falls at or after the cutoff and is correctly skipped. The run
 * was idempotent, not successful, and nothing said so.
 *
 * Two facts make that state detectable without heuristics:
 *
 *  - **A cutoff at or before the corpus's first sample can keep nothing.**
 *    Every event the reducer emits is anchored at or after the first position
 *    it read, so the filter `event < cutoff` is empty by construction. That is
 *    never what the operator meant; it means the cutoff came from the wrong
 *    database.
 *  - **Zero kept rows is a failure unless it was asked for.** `--allow-empty`
 *    is the deliberate idempotent rerun.
 *
 * Pure and separately tested (`backfill-guards.test.ts`) so the check cannot
 * rot behind the script's I/O.
 */

export interface BackfillCounts {
  /** Rows that would be written. */
  kept: number;
  /** Rows dropped because they fall at or after the cutoff (the live collector's). */
  pastCutoff: number;
  /** Rows dropped because their exact key is already in the target. */
  dup: number;
}

export interface BackfillSummary {
  /** Cutoff in ms, or `Infinity` when the target holds no rows to defer to. */
  cutoff: number;
  /** Where the cutoff came from, printed verbatim so a wrong source is visible. */
  cutoffSource: string;
  /** `collected_at` of the corpus's first position. */
  corpusFirstMs: number;
  visits: BackfillCounts;
  legs: BackfillCounts;
  /** Set by `--allow-empty`: an empty result is then a pass. */
  allowEmpty?: boolean;
}

export interface BackfillVerdict {
  ok: boolean;
  /** The summary block, one line per element, printed as-is. */
  lines: string[];
}

const iso = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString() : "none");

/**
 * Grade a completed run. `ok === false` means the caller must write nothing and
 * exit non-zero.
 */
export function checkBackfill(s: BackfillSummary): BackfillVerdict {
  const kept = s.visits.kept + s.legs.kept;
  const lines: string[] = [];
  lines.push("=== BACKFILL SUMMARY ===");
  lines.push(`corpus starts  ${iso(s.corpusFirstMs)}`);
  lines.push(`cutoff         ${iso(s.cutoff)}  (${s.cutoffSource})`);
  lines.push(
    `visits         ${s.visits.kept} kept, ${s.visits.pastCutoff} at/after cutoff, ${s.visits.dup} already present`,
  );
  lines.push(
    `legs           ${s.legs.kept} kept, ${s.legs.pastCutoff} at/after cutoff, ${s.legs.dup} already present`,
  );

  const cutoffTooEarly = Number.isFinite(s.cutoff) && s.cutoff <= s.corpusFirstMs;
  if (cutoffTooEarly) {
    lines.push("");
    lines.push("FAILED: the cutoff is at or before the corpus's first sample, so no derived row");
    lines.push("can ever precede it and this run could only ever keep zero rows.");
    lines.push(`The cutoff came from ${s.cutoffSource}. Either that database has ALREADY been`);
    lines.push("backfilled from this same archive (an idempotent rerun — pass --allow-empty if");
    lines.push("that is what you meant), or it is not the database these rows are for. Point");
    lines.push("--target at the database that will receive them, or pass --before <ISO of the");
    lines.push("live collector's first visit there>.");
    return { ok: false, lines };
  }

  if (kept === 0 && !s.allowEmpty) {
    lines.push("");
    lines.push("FAILED: zero rows to insert. An empty backfill is not a successful one — nothing");
    lines.push("was written. If the target really is already complete, rerun with --allow-empty.");
    return { ok: false, lines };
  }

  lines.push("");
  lines.push(kept === 0 ? "PASS (empty, as asked with --allow-empty)" : `PASS: ${kept} rows to write`);
  return { ok: true, lines };
}
