import { cdf as currentCdf, quantile as currentQuantile, type Dist } from "./dist.js";

/** CDF/quantile boundary shared by the unchanged prior and the conditional expert. */
export interface AnalyticDistribution {
  cdf(x: number): number;
  quantile(p: number): number;
}

export function currentDistribution(d: Dist): AnalyticDistribution {
  return { cdf: x => currentCdf(d, x), quantile: p => currentQuantile(d, p) };
}

/**
 * Log-survival interpolation with explicit left/right CDF values at a knot.
 * Equal positive quantiles are an atom, not a steep continuous segment from
 * zero. This matters for nearly deterministic service and release times.
 */
export function atomQuantiles(values: readonly number[]): AnalyticDistribution {
  if (!values.length) return atomQuantiles([0]);
  const xs: number[] = [], left: number[] = [], right: number[] = [];
  if (values[0]! > 0) { xs.push(0); left.push(0); right.push(0); }
  for (let i = 0; i < values.length; i++) {
    const x = Math.max(0, values[i]!);
    const p = (i + 0.5) / values.length;
    if (xs.length && x === xs[xs.length - 1]) right[right.length - 1] = p;
    else { xs.push(x); left.push(p); right.push(p); }
  }
  const last = xs.length - 1;
  let h = 1 / 5;
  if (values.length > 1) {
    const width = values[values.length - 1]! - values[values.length - 2]!;
    // Continue the last observed quantile interval, not the gap from zero to
    // an isolated positive atom. Equal last quantiles use the existing cap.
    if (width > 0) h = Math.log(3) / width;
  }
  h = Math.max(1 / 1800, Math.min(1 / 5, h));
  return {
    cdf(x) {
      if (x < xs[0]!) return 0;
      if (x >= xs[last]!) return 1 - (1 - right[last]!) * Math.exp(-h * (x - xs[last]!));
      let i = 0;
      while (i < last && xs[i + 1]! <= x) i++;
      if (x === xs[i]) return right[i]!;
      const a = 1 - right[i]!, b = 1 - left[i + 1]!;
      return 1 - a * Math.exp(Math.log(b / a) * (x - xs[i]!) / (xs[i + 1]! - xs[i]!));
    },
    quantile(p) {
      p = Math.max(0, Math.min(1 - 1e-9, p));
      for (let i = 0; i <= last; i++) {
        if (p <= left[i]!) {
          if (i === 0) return xs[0]!;
          const a = 1 - right[i - 1]!, b = 1 - left[i]!;
          if (a === b) return xs[i]!;
          return xs[i - 1]! + (xs[i]! - xs[i - 1]!) * Math.log((1 - p) / a) / Math.log(b / a);
        }
        if (p <= right[i]!) return xs[i]!;
      }
      return xs[last]! + Math.log((1 - right[last]!) / (1 - p)) / h;
    },
  };
}

/** Exact CDF mixture. Numerical inversion preserves atoms and the survival update. */
export function analyticMixture(a: AnalyticDistribution, b: AnalyticDistribution, weight: number): AnalyticDistribution {
  if (weight <= 0) return a;
  if (weight >= 1) return b;
  const cdf = (x: number): number => (1 - weight) * a.cdf(x) + weight * b.cdf(x);
  return { cdf, quantile(p) {
    const qa = a.quantile(p), qb = b.quantile(p);
    let lo = Math.min(qa, qb), hi = Math.max(qa, qb);
    if (cdf(lo) >= p) return lo;
    for (let i = 0; i < 42; i++) {
      const mid = (lo + hi) / 2;
      if (cdf(mid) >= p) hi = mid; else lo = mid;
    }
    return hi;
  } };
}

export function analyticResidual(d: AnalyticDistribution, elapsed: number): (p: number) => number {
  const r = Math.max(0, elapsed), F = d.cdf(r), S = 1 - F;
  if (S <= 1e-9) return () => 0;
  return p => Math.max(0, d.quantile(F + p * S) - r);
}
