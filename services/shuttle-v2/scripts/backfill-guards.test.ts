import { describe, expect, it } from "vitest";

import { checkBackfill, type BackfillSummary } from "./backfill-guards";

const CORPUS_FIRST = 1788443472343; // the archive's own first sample, 2026-09-03T13:51:12.343Z
const LIVE_FIRST = 1788488498506; // production's earliest live visit, 2026-09-04T02:21:38.506Z

const summary = (over: Partial<BackfillSummary> = {}): BackfillSummary => ({
  cutoff: LIVE_FIRST,
  cutoffSource: "--db store/snap.db, earliest stop_visits row",
  corpusFirstMs: CORPUS_FIRST,
  visits: { kept: 4364, pastCutoff: 792, dup: 0 },
  legs: { kept: 4028, pastCutoff: 705, dup: 0 },
  ...over,
});

describe("checkBackfill", () => {
  it("passes a run that kept rows", () => {
    const v = checkBackfill(summary());
    expect(v.ok).toBe(true);
    expect(v.lines.join("\n")).toContain("PASS: 8392 rows to write");
  });

  it("always reports the cutoff, its source, and both kept/skipped counts", () => {
    const text = checkBackfill(summary()).lines.join("\n");
    expect(text).toContain("2026-09-04T02:21:38.506Z");
    expect(text).toContain("earliest stop_visits row");
    expect(text).toContain("4364 kept, 792 at/after cutoff, 0 already present");
    expect(text).toContain("4028 kept, 705 at/after cutoff, 0 already present");
  });

  // The 2026-09-04 failure: the cutoff came from a database already backfilled
  // from this same archive, so it equalled the archive's first sample and every
  // derived event was skipped. It must not read as success.
  it("fails when the cutoff is at or before the corpus's first sample", () => {
    const v = checkBackfill(
      summary({ cutoff: CORPUS_FIRST, visits: { kept: 0, pastCutoff: 5156, dup: 0 }, legs: { kept: 0, pastCutoff: 4733, dup: 0 } }),
    );
    expect(v.ok).toBe(false);
    expect(v.lines.join("\n")).toContain("cutoff is at or before the corpus's first sample");
  });

  it("fails on a cutoff before the corpus even when --allow-empty is set", () => {
    // --allow-empty forgives an empty result, not a mis-sourced cutoff.
    const v = checkBackfill(
      summary({ cutoff: CORPUS_FIRST - 1, allowEmpty: true, visits: { kept: 0, pastCutoff: 5156, dup: 0 }, legs: { kept: 0, pastCutoff: 4733, dup: 0 } }),
    );
    expect(v.ok).toBe(false);
  });

  it("fails on zero kept rows", () => {
    const v = checkBackfill(summary({ visits: { kept: 0, pastCutoff: 0, dup: 5156 }, legs: { kept: 0, pastCutoff: 0, dup: 4733 } }));
    expect(v.ok).toBe(false);
    expect(v.lines.join("\n")).toContain("zero rows to insert");
  });

  it("accepts zero kept rows only when asked", () => {
    const v = checkBackfill(
      summary({ allowEmpty: true, visits: { kept: 0, pastCutoff: 0, dup: 5156 }, legs: { kept: 0, pastCutoff: 0, dup: 4733 } }),
    );
    expect(v.ok).toBe(true);
    expect(v.lines.join("\n")).toContain("--allow-empty");
  });

  it("passes with no cutoff at all (a target with no rows yet)", () => {
    const v = checkBackfill(summary({ cutoff: Infinity, cutoffSource: "none (target has no visits)", visits: { kept: 5156, pastCutoff: 0, dup: 0 }, legs: { kept: 4733, pastCutoff: 0, dup: 0 } }));
    expect(v.ok).toBe(true);
    expect(v.lines.join("\n")).toContain("cutoff         none");
  });
});
