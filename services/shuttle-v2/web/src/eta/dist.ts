/**
 * Distributions on seconds, from a short list of quantile knots.
 *
 * Everything the estimator prices — a stand at a stop, a drive on a hop, the
 * rest of a stand given how long the bus has already stood — is one of these.
 * The calibrator serves quantile vectors (`q`, `dq`: ten knots at levels
 * (i + 0.5) / 10, calibrator.ts `standQuantiles`), and a quantile vector IS a
 * distribution once the knots are joined, so no parametric family is assumed
 * anywhere: the data says what shape a stand has, and a stop where buses
 * usually roll through (pass mass at zero) keeps that mass at zero.
 *
 * HOW THE KNOTS ARE JOINED MATTERS, because the residual of a stand given the
 * time already stood is read off the survival function's local hazard. A
 * piecewise-LINEAR CDF has a hazard that rises inside every segment and drops
 * at every knot — a saw-tooth — and a closing knot forced one gap past the
 * last quantile made the hazard explode there: on 344 Winchester's table the
 * residual median by elapsed time read 79 s at 420 s, 120 at 480, 33 at 800
 * and 87 at 840 (the adversarial review's E2). So here the SURVIVAL function
 * is interpolated log-linearly between knots — a constant hazard on each
 * segment, the standard reading of a survival curve between observed
 * quantiles — and past the last knot it continues at the last segment's
 * hazard: a bus that has out-sat every recorded stand is promised the mean
 * excess the tail of its own table shows, not zero and not a saw-tooth.
 *
 * Conventions: `F(x)` is right-continuous; a run of equal knots is a jump;
 * `Finv(p)` is the smallest x with F(x) >= p.
 */

export interface Dist {
  /** Ascending, distinct. */
  readonly xs: Float64Array;
  /** F at each knot, ascending, < 1; F is 0 before xs[0]. */
  readonly ps: Float64Array;
  /** Hazard per second past the last knot. */
  readonly tailHazard: number;
}

/** F at a knot is capped here so every segment has a finite hazard. */
const MAX_P = 1 - 1e-6;
/** The tail hazard is floored here (a mean excess of at most 30 min) and capped (at least 5 s). */
const MIN_HAZARD = 1 / 1800;
const MAX_HAZARD = 1 / 5;

function makeDist(xs: number[], ps: number[]): Dist {
  const outX: number[] = [], outP: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!, p = Math.min(MAX_P, Math.max(0, ps[i]!));
    if (outX.length > 0 && outX[outX.length - 1]! >= x) {
      outP[outP.length - 1] = Math.max(outP[outP.length - 1]!, p);
      continue;
    }
    outX.push(x);
    outP.push(Math.max(p, outP.length > 0 ? outP[outP.length - 1]! : 0));
  }
  if (outX.length === 0) { outX.push(0); outP.push(MAX_P); }
  // The last segment's hazard, continued; a single knot gets the cap.
  let h = MAX_HAZARD;
  const n = outX.length;
  if (n >= 2) {
    const s0 = 1 - outP[n - 2]!, s1 = 1 - outP[n - 1]!;
    const w = outX[n - 1]! - outX[n - 2]!;
    h = w > 0 && s0 > s1 ? Math.log(s0 / s1) / w : MAX_HAZARD;
  }
  h = Math.min(MAX_HAZARD, Math.max(MIN_HAZARD, h));
  return { xs: Float64Array.from(outX), ps: Float64Array.from(outP), tailHazard: h };
}

/**
 * A distribution from ascending quantiles at levels (i + 0.5) / n — the
 * calibrator's convention. A leading knot at 0 carries no mass when the first
 * quantile is positive; nothing is added past the last quantile (see the
 * header for why).
 */
export function fromQuantiles(q: readonly number[]): Dist {
  const n = q.length;
  if (n === 0) return point(0);
  const xs: number[] = [], ps: number[] = [];
  if (q[0]! > 0) { xs.push(0); ps.push(0); }
  for (let i = 0; i < n; i++) { xs.push(Math.max(0, q[i]!)); ps.push((i + 0.5) / n); }
  return makeDist(xs, ps);
}

/** All mass at one value. */
export function point(x: number): Dist {
  return makeDist([x], [MAX_P]);
}

/**
 * A lognormal with the given mean and standard deviation, as 21 knots. Used
 * only where the calibrator has no quantile vector to serve.
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
  return makeDist(xs, ps);
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

/** S(x) = 1 - F(x). */
export function survival(d: Dist, x: number): number {
  const { xs, ps } = d;
  const n = xs.length;
  if (x < xs[0]!) return 1;
  if (x >= xs[n - 1]!) return (1 - ps[n - 1]!) * Math.exp(-d.tailHazard * (x - xs[n - 1]!));
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid; else hi = mid;
  }
  const s0 = 1 - ps[lo]!, s1 = 1 - ps[hi]!;
  const w = xs[hi]! - xs[lo]!;
  if (w <= 0) return s0;
  return s0 * Math.exp(Math.log(s1 / s0) * ((x - xs[lo]!) / w));
}

/** F(x). */
export function cdf(d: Dist, x: number): number {
  return 1 - survival(d, x);
}

/** Finv(p): the smallest x with F(p) >= p, i.e. S(x) <= 1 - p. */
export function quantile(d: Dist, p: number): number {
  const { xs, ps } = d;
  const n = xs.length;
  if (p <= 0) return xs[0]!;
  const target = Math.max(1e-9, 1 - Math.min(p, MAX_P)); // S(x) = target
  if (p <= ps[0]!) return xs[0]!;
  const sLast = 1 - ps[n - 1]!;
  if (target <= sLast) return xs[n - 1]! + Math.log(sLast / target) / d.tailHazard;
  // The segment whose survival brackets the target: S(lo) >= target > S(hi).
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (1 - ps[mid]! > target) lo = mid; else hi = mid;
  }
  const s0 = 1 - ps[lo]!, s1 = 1 - ps[hi]!;
  if (s0 <= s1) return xs[hi]!;
  if (target >= s0) return xs[lo]!;
  return xs[lo]! + (xs[hi]! - xs[lo]!) * Math.log(s0 / target) / Math.log(s0 / s1);
}

/**
 * The remaining time given that `r` seconds have already elapsed:
 * Finv_r(u) = Finv(F(r) + u (1 - F(r))) - r. Returns a sampler in u ∈ (0, 1).
 * At u = 0.5 this is the conditional median.
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

/** The hazard at x: the probability per second of ending, given it has lasted x. */
export function hazard(d: Dist, x: number): number {
  const { xs, ps } = d;
  const n = xs.length;
  if (x < xs[0]!) return 0;
  if (x >= xs[n - 1]!) return d.tailHazard;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid; else hi = mid;
  }
  const s0 = 1 - ps[lo]!, s1 = 1 - ps[hi]!;
  const w = xs[hi]! - xs[lo]!;
  if (w <= 0 || s1 >= s0) return 0;
  return Math.log(s0 / s1) / w;
}

/**
 * Empirical-Bayes shrinkage of a distribution toward a prior: the mixture
 * with weight n / (n + k) on the data, evaluated on the union of both knot
 * sets.
 */
export function shrinkToward(emp: Dist, prior: Dist, n: number, k: number): Dist {
  const w = n / (n + k);
  if (w >= 0.999) return emp;
  if (w <= 0.001) return prior;
  return mixture([[emp, w], [prior, 1 - w]]);
}

/** A weighted mixture of distributions, on the union of their knots. */
export function mixture(parts: ReadonlyArray<readonly [Dist, number]>): Dist {
  const xsSet = new Set<number>();
  let total = 0;
  for (const [d, w] of parts) { if (w > 0) { for (const x of d.xs) xsSet.add(x); total += w; } }
  if (total <= 0 || xsSet.size === 0) return point(0);
  const xs = [...xsSet].sort((a, b) => a - b);
  const ps = xs.map((x) => {
    let f = 0;
    for (const [d, w] of parts) if (w > 0) f += (w / total) * cdf(d, x);
    return f;
  });
  return makeDist(xs, ps);
}

/** The distribution of a × X for a >= 0 (a drive with a fraction of the leg left). */
export function scaled(d: Dist, a: number): Dist {
  const f = Math.max(0, a);
  if (f === 0) return point(0);
  return makeDist(Array.from(d.xs, (x) => x * f), Array.from(d.ps));
}

/** X + c. */
export function shifted(d: Dist, c: number): Dist {
  return makeDist(Array.from(d.xs, (x) => x + c), Array.from(d.ps));
}

/** Median, for diagnostics and the layover test. */
export function median(d: Dist): number { return quantile(d, 0.5); }
