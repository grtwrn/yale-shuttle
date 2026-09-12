import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * "Walking wins right now" MUST BE ON THE DETAIL PAGE (reports #103 and #106,
 * "walk time about same as just walking", and the card in #108).
 *
 * The sentence is the only thing on screen that explains why a shuttle slower
 * than walking is being offered at all. It was gated on `!_detailOpen`, so it
 * showed on the list and vanished the moment a rider tapped a card — and they
 * tap the card BECAUSE the numbers look wrong. Two riders then filed the
 * question the sentence answers.
 *
 * A source-level test because `TransitMap.tsx` cannot be rendered by this
 * repo's harness (no jsdom/testing-library): same approach as
 * `mapFilter.test.ts` and `Banners.test.tsx`. The canary's own reading of the
 * page with the sentence present is fixtured in `canary-metrics.test.mjs`.
 */
const src = readFileSync(new URL("./TransitMap.tsx", import.meta.url), "utf8");

describe("the walking-wins sentence", () => {
  it("still exists, in the wording riders have been shown", () => {
    expect(src).toContain("Walking wins right now — every shuttle is slower");
  });

  it("is NOT hidden on the detail page", () => {
    expect(src).toContain("{_allShuttlesSlower && (");
    expect(src).not.toContain("{_allShuttlesSlower && !_detailOpen && (");
  });

  it("still renders only when every shuttle really is slower", () => {
    // Dropping the gate must not drop the condition the sentence is true of.
    expect(src).toContain("const _allShuttlesSlower =");
    expect(src).toContain("_sorted.every((o) => o.mode === \"walk\" || _tier(o) > 0)");
  });
});
