import { describe, expect, it } from "vitest";

import { clusterChips, CHIP_LINE_H, type ChipBox } from "./chipCluster";

/**
 * The arrangement the operator hit on 2026-09-10 ("this is an eye sore"):
 * a five-route overview whose four time boxes sat ~25 px apart vertically and
 * overlapped horizontally, each rendering two lines. Six live trips were driven
 * looking for it and none reproduced it, which is why it is written down here
 * rather than left to a browser to find again.
 */
const EYESORE: ChipBox[] = [
  { x: 290, y: 180, w: 96 },  // (B) 3:13p
  { x: 292, y: 182, w: 96 },  // (R) 3:23p        — pairs with the one above
  { x: 350, y: 205, w: 96 },  // (B) 3:42p
  { x: 352, y: 207, w: 96 },  // (G) 3:13p        — pairs with the one above
];

describe("chip clustering", () => {
  it("merges stacks that a one-line band judged apart", () => {
    // The two pairs are 25 px apart — more than the old fixed 18 px band, less
    // than the ~34 px each pair actually renders once it holds two lines.
    const groups = clusterChips(EYESORE);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(4);
  });

  it("still leaves genuinely separate chips alone", () => {
    const apart: ChipBox[] = [
      { x: 60, y: 60, w: 80 },
      { x: 300, y: 60, w: 80 },   // far to the right
      { x: 60, y: 220, w: 80 },   // far below
    ];
    expect(clusterChips(apart)).toHaveLength(3);
  });

  it("grows the band as a cluster grows, which is the whole point", () => {
    // Four chips in a vertical column, each 20 px below the last. Pairwise
    // they are outside one line's height; as a stack they are one box.
    const column: ChipBox[] = [0, 20, 40, 60].map((dy) => ({ x: 100, y: 100 + dy, w: 90 }));
    expect(clusterChips(column)).toHaveLength(1);
    // and a fifth, far enough below the four-line stack, stays out
    const withOutlier = [...column, { x: 100, y: 100 + 60 + 5 * CHIP_LINE_H + 40, w: 90 }];
    expect(clusterChips(withOutlier)).toHaveLength(2);
  });

  it("terminates and covers every chip exactly once", () => {
    const many: ChipBox[] = Array.from({ length: 40 }, (_, i) => ({
      x: 50 + (i % 7) * 22, y: 40 + Math.floor(i / 7) * 15, w: 70 + (i % 3) * 20,
    }));
    const groups = clusterChips(many);
    const seen = groups.flat().sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("is stable: the same input gives the same grouping", () => {
    expect(clusterChips(EYESORE)).toEqual(clusterChips(EYESORE));
  });
});
