import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * CLAIMS THE PROMISED ARRIVAL CLOCK CANNOT KEEP — banned wherever its prose
 * lives, not just in the string a rider sees.
 *
 * The tooltip for "by 2:23p" was wrong twice in two days, the same way each
 * time: it named something the number is not. Once a percentile (`high` has
 * been through `widenBand`, so it sits above the chain's q90), and once the
 * countdown's range (that range is the BOARD stop's band; this number is the
 * ALIGHT stop's `high` plus the walk).
 *
 * The first guard against this lived in `etaBand.test.ts` and checked the
 * TOOLTIP STRING alone. Two gaps, and both are the reason this file exists:
 *
 *   1. It asserted the tooltip CONTAINED a phrase. A presence assertion makes
 *      the current sentence the requirement, so when that sentence turned out
 *      to be false, the test defended it — correcting the error would have
 *      looked like a regression. Every assertion here is an ABSENCE, which a
 *      truthful rewording passes unchanged.
 *   2. It covered one string. The same claim is explained in five prose
 *      passages across four files, and any of them could quietly reacquire it
 *      while the tooltip stayed clean. A reader who hits the comment believes
 *      the comment.
 *
 * So the ban is checked at the SOURCE, across every file that carries the
 * explanation. Retired wordings are paraphrased in those files rather than
 * quoted, precisely so this stays a simple, absolute pattern match.
 *
 * This is an established shape in this repo, not a new invention. Three
 * precedents, each reading source and asserting on what it finds:
 *
 *   * `src/server/serverEta.closure.test.ts` walks the real import graph out
 *     of `serverEta.ts` and fails if the Dockerfile has stopped copying a
 *     `web/` file it reaches — the failure that would otherwise pass every
 *     gate and crash on boot;
 *   * `walk.test.ts` parses `WALK_M_PER_S` out of the SERVER's own source, so
 *     the client's mirror cannot drift from it;
 *   * `mapFilter.test.ts` asserts at the source that both consumers read the
 *     one shared set.
 *
 * Same idea here — a fact that lives in prose across several files, held by a
 * test that reads them.
 */
const ROOT = new URL("./", import.meta.url);
const FILES = [
  "web/src/etaBand.ts",
  "web/src/planner.ts",
  "web/src/TransitMap.tsx",
  "web/src/etaBand.test.ts",
  "docs/eta-band.md",
];
const PATH_OF: Record<string, URL> = {
  "web/src/etaBand.ts": new URL("etaBand.ts", ROOT),
  "web/src/planner.ts": new URL("planner.ts", ROOT),
  "web/src/TransitMap.tsx": new URL("TransitMap.tsx", ROOT),
  "web/src/etaBand.test.ts": new URL("etaBand.test.ts", ROOT),
  "docs/eta-band.md": new URL("../../../../docs/eta-band.md", ROOT),
};

/** Each retired claim, and what is actually true instead. */
const RETIRED_CLAIMS: { pattern: RegExp; why: string }[] = [
  {
    pattern: /90th percentile of (?:this|the) bus/i,
    why: "`high` is widened by CONFORMAL after the quantile is taken, so it is not the bus's 90th percentile (first wrong tooltip, 2026-09-12)",
  },
  {
    pattern: /top of the range the countdown shows/i,
    why: "the countdown's range is the BOARD stop's band; this number is the ALIGHT stop's high plus the walk (second wrong tooltip, 2026-09-12)",
  },
  {
    pattern: /\bis a q90\b/i,
    why: "identifies the promised number with a quantile it sits above",
  },
  {
    pattern: /q90 of the whole chain/i,
    why: "the chain's q90 is widened before it is shown",
  },
];

describe("no file re-acquires a claim the promised clock cannot keep", () => {
  for (const rel of FILES) {
    it(`${rel} makes none of the retired claims`, () => {
      const text = readFileSync(PATH_OF[rel], "utf8");
      const lines = text.split("\n");
      const hits: string[] = [];
      for (const { pattern, why } of RETIRED_CLAIMS) {
        lines.forEach((line, i) => {
          if (pattern.test(line)) hits.push(`${rel}:${i + 1} matches ${pattern} — ${why}\n    ${line.trim()}`);
        });
      }
      expect(hits, hits.join("\n")).toEqual([]);
    });
  }

  it("is actually reading the files — a guard that reads nothing proves nothing", () => {
    // The failure this whole family keeps repeating is a check that finds
    // nothing looking exactly like a check that passed (#111, #123,
    // eta-accuracy.mjs blind for eight days). So: every file exists, is
    // non-trivial, and really does discuss this clock.
    for (const rel of FILES) {
      const text = readFileSync(PATH_OF[rel], "utf8");
      expect(text.length, `${rel} is empty`).toBeGreaterThan(500);
      expect(text, `${rel} no longer mentions the promised clock`).toMatch(/arriveByClock|by 2:23p|arrival clock/i);
    }
  });

  /**
   * POSITIVE CONTROL — DO NOT DELETE AS REDUNDANT.
   *
   * Every other assertion in this file is an ABSENCE, and absence assertions
   * are all trivially satisfied by patterns that match NOTHING. A typo in a
   * regex, an over-eager tidy-up, or a rename that empties `RETIRED_CLAIMS`
   * would leave this suite bright green while checking precisely nothing —
   * "no file makes the claim" and "this test no longer looks for the claim"
   * are indistinguishable from the outside.
   *
   * That is the exact failure this project keeps paying for: #111 and #123
   * (a canary parser that silently stopped recognising cards), and
   * `eta-accuracy.mjs`, which matched nothing for eight days and exited 0
   * throughout. So the patterns are fed the two sentences that REALLY shipped
   * and must still catch them.
   *
   * The strings are assembled from pieces on purpose: this file is not in
   * `FILES` today, but if a future reader adds it, a verbatim copy of a banned
   * claim would make the guard fail on itself. Do not "simplify" them into one
   * literal.
   */
  it("positive control: the patterns still match the two sentences that really shipped", () => {
    const first = "the 90th percentile of this bus" + "'s own forecast at your stop";
    const second = "the " + "top of the range the countdown shows";
    expect(RETIRED_CLAIMS.some((c) => c.pattern.test(first))).toBe(true);
    expect(RETIRED_CLAIMS.some((c) => c.pattern.test(second))).toBe(true);
    // And a truthful sentence is not caught.
    expect(RETIRED_CLAIMS.some((c) => c.pattern.test(
      "The latest this trip is likely to get you there. About 2:19p is typical.",
    ))).toBe(false);
  });
});
