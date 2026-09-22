/** Checkpoints qualified against each frozen route topology. The serving
 * overlay separately requires the full published stop sequence to match. */
export const K10_SCOPES: Readonly<Record<number, { sourceIndex: number; waitIndex: number; stopCount: number }>> = {
  3: { sourceIndex: 4, waitIndex: 14, stopCount: 29 },
  1: { sourceIndex: 14, waitIndex: 24, stopCount: 31 },
  16: { sourceIndex: 1, waitIndex: 0, stopCount: 11 },
  14: { sourceIndex: 16, waitIndex: 0, stopCount: 26 },
};
export const forwardStops = (from: number, to: number, count: number) => (to - from + count) % count;
