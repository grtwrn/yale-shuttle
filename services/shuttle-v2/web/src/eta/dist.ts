/**
 * Distributions on seconds, as piecewise-linear CDFs over a short knot list.
 *
 * Everything the estimator prices — a stand at a stop, a drive on a hop, the
 * rest of a stand given how long the bus has already stood — is one of these.
 * The calibrator serves quantile vectors (`q`, `dq`: ten knots at levels
 * (i + 0.5) / 10, see calibrator.ts `standQuantiles`), and a quantile vector
 * IS a CDF once the knots are joined, so no parametric family is assumed
 * anywhere: the data says what shape a stand has, and a stop where buses
 * usually roll through (pass mass at zero) keeps that mass at zero.
 *
 * Conventions:
 *  - `F(x)` is right-continuous; a run of equal knots is a jump.
 *  - `Finv(p)` is the smallest x with F(x) >= p, linear between distinct knots.
 *  - Past the last served knot the CDF closes one inter-knot gap later and then
 *    carries a small exponential tail, so a bus that has out-sat every recorded
 *    stand is never promised "leaving now" — the measured remaining past
 *    r = 600 s at 344 Winchester is still about two minutes
 *    (docs/eta-estimator-design.md, "The rest term").
 */

export interface Dist {
  /** Ascending, distinct. */
  readonly xs: Float64Array;
  /** F at each knot, ascending, last is TAIL_P; F is 0 before xs[0]. */
  readonly ps: Float64Array;
  /** Mean of the exponential tail carrying the last (1 - TAIL_P) of mass. */
  readonly tailMean: number;
}

/** The mass placed in the exponential tail beyond the last knot. */
export const TAIL_P = 0.995;

/** The floor on the tail's mean, seconds; also the floor on the closing gap. */
const MIN_GAP_SEC = 30;

function makeDist(xs: number[], ps: number[], tailMean: number): Dist {
  // Collapse equal xs into one knot carrying the LARGEST p (a jump), and
  // make ps non-decreasing.
  const outX: number[] = [], outP: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!, p = Math.min(TAIL_P, Math.max(0, ps[i]!));
    if (outX.length > 0 && outX[outX.length - 1]! >= x) {
      outP[outP.length - 1] = Math.max(outP[outP.length - 1]!, p);
      continue;
    }
    outX.push(x);
    outP.push(Math.max(p, outP.length > 0 ? outP[outP.length - 1]! : 0));
  }
  if (outX.length === 0) { outX.push(0); outP.push(TAIL_P); }
  outP[outP.length - 1] = TAIL_P;
  return { xs: Float64Array.from(outX), ps: Float64Array.from(outP), tailMean: Math.max(MIN_GAP_SEC, tailMean) };
}

/**
 * A distribution from ascending quantiles at levels (i + 0.5) / n — the
 * calibrator's convention. Mirrors `remainingStandSec`'s knot construction in
 * hopPricing.ts: a leading knot at 0 when the first quantile is positive, and a
 * closing knot one gap past the last.
 */
export function fromQuantiles(q: readonly number[]): Dist {
  const n = q.length;
  if (n === 0) return point(0);
  const last = q[n - 1]!;
  const gap = Math.max(MIN_GAP_SEC, n >= 2 ? last - q[n - 2]! : last / 2);
  const xs: number[] = [], ps: number[] = [];
  if (q[0]! > 0) { xs.push(0); ps.push(0); }
  for (let i = 0; i < n; i++) { xs.push(Math.max(0, q[i]!)); ps.push((i + 0.5) / n); }
  xs.push(last + gap); ps.push(TAIL_P);
  return makeDist(xs, ps, gap);
}

/** All mass at one value. */
export function point(x: number): Dist {
  return makeDist([x], [TAIL_P], MIN_GAP_SEC);
}

/**
 * A lognormal with the given mean and standard deviation, as 21 knots. Used
 * only where the calibrator has no quantile vector to serve (a hop with an
 * arrival-to-arrival segment average and nothing else).
 */
export function lognormalMeanSd(mean: number, sd: number): Dist {
  const m = Math.max(1, mean);
  const s = Math.max(1, sd);
  const s2 = Math.log(1 + (s * s) / (m * m));
  const mu = Math.log(m) - s2 / 2;
  const sigma = Math.sqrt(s2);
  const xs: number[] = [], ps: number[] = [];
  for (let i = 0; i <= 20; i++) {
    const p = (i + 0.5) / 21;
    xs.push(Math.exp(mu + sigma * probit(p)));
    ps.push(p);
  }
  return makeDist(xs, ps, xs[xs.length - 1]! - xs[xs.length - 2]!);
}

/** Inverse standard normal CDF (Acklam's rational approximation, |err| < 1.2e-9). */
function probit(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425, ph = 1 - pl;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= ph) {
    q = p - 0.5; r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

/** F(x). */
export function cdf(d: Dist, x: number): number {
  const { xs, ps } = d;
  const n = xs.length;
  if (x < xs[0]!) return 0;
  if (x >= xs[n - 1]!) {
    return TAIL_P + (1 - TAIL_P) * (1 - Math.exp(-(x - xs[n - 1]!) / d.tailMean));
  }
  // Binary search for the last knot <= x.
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid; else hi = mid;
  }
  const w = xs[hi]! - xs[lo]!;
  if (w <= 0) return ps[lo]!;
  return ps[lo]! + (ps[hi]! - ps[lo]!) * (x - xs[lo]!) / w;
}

/** Finv(p): the smallest x with F(x) >= p. */
export function quantile(d: Dist, p: number): number {
  const { xs, ps } = d;
  const n = xs.length;
  if (p <= 0) return xs[0]!;
  if (p >= TAIL_P) {
    const u = Math.min(1 - 1e-9, (p - TAIL_P) / (1 - TAIL_P));
    return xs[n - 1]! - d.tailMean * Math.log(1 - u);
  }
  if (p <= ps[0]!) return xs[0]!;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ps[mid]! < p) lo = mid; else hi = mid;
  }
  const dp = ps[hi]! - ps[lo]!;
  if (dp <= 0) return xs[hi]!;
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (p - ps[lo]!) / dp;
}

/**
 * The remaining time given that `r` seconds have already elapsed:
 * Finv_r(u) = Finv(F(r) + u (1 - F(r))) - r. Returns a sampler in u ∈ (0, 1).
 * At u = 0.5 this is the conditional median `remainingStandSec` bills.
 */
export function residual(d: Dist, r: number): (u: number) => number {
  const rr = Math.max(0, r);
  const Fr = cdf(d, rr);
  const rest = 1 - Fr;
  if (rest <= 1e-9) return () => 0;
  return (u) => Math.max(0, quantile(d, Fr + u * rest) - rr);
}

/** The conditional median of the remainder — the number the chip shows. */
export function residualMedian(d: Dist, r: number): number {
  return residual(d, r)(0.5);
}

/**
 * Empirical-Bayes shrinkage of a distribution toward a prior: the mixture
 * CDF with weight n / (n + k) on the data. The same rule as `shrinkage.ts`,
 * applied to the whole shape rather than the mean.
 */
export function shrinkToward(emp: Dist, prior: Dist, n: number, k: number): Dist {
  const w = n / (n + k);
  if (w >= 0.999) return emp;
  if (w <= 0.001) return prior;
  const xsSet = new Set<number>();
  for (const x of emp.xs) xsSet.add(x);
  for (const x of prior.xs) xsSet.add(x);
  const xs = [...xsSet].sort((a, b) => a - b);
  const ps = xs.map((x) => w * cdf(emp, x) + (1 - w) * cdf(prior, x));
  return makeDist(xs, ps, w * emp.tailMean + (1 - w) * prior.tailMean);
}

/** The distribution of a × X for a >= 0 (a drive with a fraction of the leg left). */
export function scaled(d: Dist, a: number): Dist {
  const f = Math.max(0, a);
  if (f === 0) return point(0);
  return makeDist(Array.from(d.xs, (x) => x * f), Array.from(d.ps), d.tailMean * f);
}

/** X + c. */
export function shifted(d: Dist, c: number): Dist {
  return makeDist(Array.from(d.xs, (x) => x + c), Array.from(d.ps), d.tailMean);
}

/** Median, for diagnostics and the layover test. */
export function median(d: Dist): number { return quantile(d, 0.5); }
