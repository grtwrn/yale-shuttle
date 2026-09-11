/**
 * Which time chips on the overview map merge into one box.
 *
 * Pure geometry, extracted from `TransitMap.tsx` on 2026-09-10 so the failing
 * case can be written down. The operator hit it on a five-route overview —
 * "this is an eye sore" — with four boxes of two to four lines piled on one
 * another over downtown, and it could not be reproduced by driving the live
 * site: it needs a particular arrangement of board and alight stops, and the
 * six trips tried produced no overlap at all. A unit test can state the
 * arrangement directly.
 *
 * THE BUG. A merged chip renders ONE LINE PER MEMBER, so a box that absorbs
 * three neighbours is about four lines tall. The collision test compared chip
 * against chip in a fixed 18 px band, which is roughly one line — so two
 * clusters 25 px apart, each rendering 34 px tall, were judged not to collide
 * and drew straight over each other.
 *
 * THE FIX is to test what the clustering would RENDER, and iterate: cluster,
 * measure the boxes, re-test, repeat. Merging only ever reduces the count, so
 * it terminates; in practice it settles in two or three passes.
 *
 * It got worse the same morning because the standing range widened the labels
 * — "(R) 20-28 min" against "(R) 23 min" — and wider labels merge more chips,
 * which makes taller stacks, which is the very thing the test was blind to.
 */
export interface ChipBox {
  /** Container-pixel centre of the chip's would-be label. */
  x: number;
  y: number;
  /** Estimated label width in pixels. */
  w: number;
}

/** One rendered line per member, plus the tooltip's own padding. */
export const CHIP_LINE_H = 13;
export const CHIP_PAD_Y = 8;
/** Horizontal slack, so labels that just touch are still merged. */
export const CHIP_GAP_X = 4;

/**
 * Group indices whose rendered boxes would overlap. Returns one array of
 * member indices per cluster, in stable input order.
 */
export function clusterChips(chips: readonly ChipBox[], maxPasses = 8): number[][] {
  const parent = chips.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));

  for (let pass = 0; pass < maxPasses; pass++) {
    const groups = new Map<number, number[]>();
    chips.forEach((_, i) => {
      const r = find(i);
      const g = groups.get(r);
      if (g) g.push(i); else groups.set(r, [i]);
    });
    const boxes = [...groups.entries()].map(([root, idx]) => ({
      root,
      x: idx.reduce((t, i) => t + chips[i].x, 0) / idx.length,
      y: idx.reduce((t, i) => t + chips[i].y, 0) / idx.length,
      w: Math.max(...idx.map((i) => chips[i].w)),
      h: idx.length * CHIP_LINE_H + CHIP_PAD_Y,
    }));
    let merged = false;
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        if (find(boxes[a].root) === find(boxes[b].root)) continue;
        if (
          Math.abs(boxes[a].x - boxes[b].x) < (boxes[a].w + boxes[b].w) / 2 + CHIP_GAP_X &&
          Math.abs(boxes[a].y - boxes[b].y) < (boxes[a].h + boxes[b].h) / 2
        ) {
          parent[find(boxes[a].root)] = find(boxes[b].root);
          merged = true;
        }
      }
    }
    if (!merged) break;
  }

  const out = new Map<number, number[]>();
  chips.forEach((_, i) => {
    const r = find(i);
    const g = out.get(r);
    if (g) g.push(i); else out.set(r, [i]);
  });
  return [...out.values()];
}
