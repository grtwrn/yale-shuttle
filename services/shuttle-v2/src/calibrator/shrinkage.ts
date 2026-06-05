/**
 * Empirical-Bayes shrinkage for travel-time estimates.
 *
 * The v1 collector implemented this with a cascade of six fallback SQL queries
 * (bus.dow.hr ±2 → bus.dow → bus.any → route.dow.hr ±2 → route.dow → route.any).
 * That cascade is a hand-rolled hierarchical estimator, but it has three
 * problems: it's hard to tune (each threshold is an independent constant), it
 * has discontinuities (one extra sample tips you out of "bus.any" into
 * "route.dow.hr"), and the boundary checks rot independently (the `if avg and
 * n >= MIN` bug skipped any zero-second segment).
 *
 * One shrinkage formula replaces all of it. Given observations and a prior,
 * the posterior mean is a weighted average:
 *
 *     posterior_mean = (n * sample_mean + k * prior_mean) / (n + k)
 *
 * where `k` is the "shrinkage strength" — the number of prior pseudo-samples
 * the prior is worth. Small `n` → posterior leans toward the prior. Large `n`
 * → posterior matches the sample. Tunable in exactly one place.
 *
 * The estimator output is used both for the trip planner's point estimate and
 * for its confidence interval (mean ± z * stddev / sqrt(n + k)).
 */

export interface ShrinkageEstimate {
  /** Posterior mean. */
  mean: number;
  /** Sample standard deviation, floored to a sensible minimum. */
  stddev: number;
  /** Effective sample size that fed this estimate. */
  n: number;
}

export interface ShrinkageInput {
  samples: readonly number[];
  /** Prior mean — what we'd expect with no samples (e.g. route-wide average). */
  priorMean: number;
  /** Shrinkage strength: how many pseudo-samples the prior is worth. */
  k: number;
  /**
   * Floor for stddev — variance estimates from small samples are noisy and
   * sometimes collapse to ~0, which would produce absurdly tight confidence
   * intervals. Defaults to 5 seconds.
   */
  minStddev?: number;
}

/**
 * Compute the shrinkage-pooled mean and stddev. With zero samples, returns
 * the prior with stddev set to `minStddev` and n=0 — the caller decides
 * whether to surface the result or fall back further.
 */
export function shrink(input: ShrinkageInput): ShrinkageEstimate {
  const minStddev = input.minStddev ?? 5;
  const n = input.samples.length;
  if (n === 0) {
    return { mean: input.priorMean, stddev: minStddev, n: 0 };
  }
  const sampleMean = mean(input.samples);
  const sampleVar = n > 1 ? variance(input.samples, sampleMean) : 0;
  const posterior =
    (n * sampleMean + input.k * input.priorMean) / (n + input.k);
  return {
    mean: posterior,
    stddev: Math.max(Math.sqrt(sampleVar), minStddev),
    n,
  };
}

/**
 * 90% confidence half-width around the posterior mean. The +k denominator
 * is what shrinkage buys us: even tiny samples get a sensible interval
 * because we're effectively averaging with the prior's pseudo-samples.
 */
export function confidenceHalfWidth(est: ShrinkageEstimate, k: number): number {
  // z_{0.95} ≈ 1.645 for a one-sided 90% interval.
  const Z = 1.645;
  return (Z * est.stddev) / Math.sqrt(est.n + k);
}

// Local stats helpers --------------------------------------------------------

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

export function variance(xs: readonly number[], precomputedMean?: number): number {
  if (xs.length < 2) return 0;
  const m = precomputedMean ?? mean(xs);
  let sq = 0;
  for (const x of xs) sq += (x - m) * (x - m);
  return sq / (xs.length - 1);
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  // Linear interpolation between the two nearest ranks.
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (rank - lo) * (sorted[hi]! - sorted[lo]!);
}
