/** Atom-preserving total-duration law, matching learned_distribution.py. */
export function atomRemainingQuantiles(values: readonly number[], elapsed: number,
  levels: readonly number[] = Array.from({ length: 19 }, (_, i) => (i + .5) / 19)): number[] {
  const q = values.map(x => Math.max(0, x)).sort((a, b) => a - b);
  if (!q.length || q.some(x => !Number.isFinite(x))) throw new Error("Finite nonempty quantiles required");
  const xs: number[] = [], left: number[] = [], right: number[] = [];
  if (q[0]! > 0) { xs.push(0); left.push(0); right.push(0); }
  for (let i = 0; i < q.length; i++) {
    const x = q[i]!, p = (i + .5) / q.length;
    if (xs.length && x === xs[xs.length - 1]) right[right.length - 1] = p;
    else { xs.push(x); left.push(p); right.push(p); }
  }
  const width = q.length > 1 ? q[q.length - 1]! - q[q.length - 2]! : 0;
  const hazard = Math.min(1 / 5, Math.max(1 / 1800, width > 0 ? Math.log(3) / width : 1 / 5));
  const logLeft = left.map(x => Math.log1p(-x)), logRight = right.map(x => Math.log1p(-x));
  const rest = Math.max(0, elapsed), last = xs.length - 1;
  if (rest >= xs[last]!) return levels.map(p => -Math.log1p(-p) / hazard);
  let index = 0;
  while (index < last && xs[index + 1]! <= rest) index++;
  const logSurvival = rest === xs[index] ? logRight[index]! : logRight[index]! +
    (rest - xs[index]!) / (xs[index + 1]! - xs[index]!) * (logLeft[index + 1]! - logRight[index]!);
  return levels.map(p => {
    const target = logSurvival + Math.log1p(-p);
    for (let i = 0; i <= last; i++) {
      if (target >= logLeft[i]!) {
        const total = i === 0 ? xs[0]! : logLeft[i] === logRight[i - 1] ? xs[i]! : xs[i - 1]! +
          (target - logRight[i - 1]!) / (logLeft[i]! - logRight[i - 1]!) * (xs[i]! - xs[i - 1]!);
        return Math.max(0, total - rest);
      }
      if (target >= logRight[i]!) return Math.max(0, xs[i]! - rest);
    }
    return Math.max(0, xs[last]! + (logRight[last]! - target) / hazard - rest);
  });
}
