/** Current layover release model. Future visits retain their measured tables. */
import type { Dist } from "./dist";

export interface ReleaseFit {
  stopId: number;
  referenceLap: number;
  coefficients: number[];
  n: number;
  days: number;
}
export interface ReleasePin {
  stopId: number;
  since: number;
  lapAtPin?: number;
}
const caches = new WeakMap<ReleaseFit, Map<string, Dist>>();
let enabled = true;
/** Paired replay control. A route also requires an accepted server fit. */
export function setReleaseModelEnabled(on: boolean): void {
  enabled = on;
}
export function releaseModelEnabled(): boolean {
  return enabled;
}

/** Rollout is Winchester only: Union's full-arrival validation regressed. */
export function releaseFitOf(value: unknown): ReleaseFit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const f = value as ReleaseFit;
  if (
    f.stopId !== 11 ||
    !Number.isFinite(f.referenceLap) ||
    f.referenceLap < 900 ||
    f.referenceLap > 7200 ||
    !Number.isFinite(f.n) ||
    f.n < 60 ||
    !Number.isFinite(f.days) ||
    f.days < 3 ||
    !Array.isArray(f.coefficients) ||
    f.coefficients.length !== 9 ||
    !f.coefficients.every((v) => Number.isFinite(v) && Math.abs(v) < 100)
  )
    return undefined;
  return f;
}

export function releaseDist(
  fit: ReleaseFit,
  pinAt: number,
  lap: number | undefined,
): Dist | null {
  if (
    lap === undefined ||
    !Number.isFinite(lap) ||
    lap < 0.65 * fit.referenceLap ||
    lap > 1.65 * fit.referenceLap
  )
    return null;
  // Quantization only bounds the simulation cache; the output has no time cap.
  const phase = Math.round(((((pinAt / 1000) % 900) + 900) % 900) / 5) * 5;
  const lapSec = Math.round(lap / 5) * 5;
  let cache = caches.get(fit);
  if (!cache) {
    cache = new Map();
    caches.set(fit, cache);
  }
  const key = `${phase}|${lapSec}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const xs: number[] = [0],
    ps: number[] = [0];
  let logS = 0,
    lastHazard = 1 / 240;
  for (let end = 15; end <= 1800; end += 15) {
    const t = end - 7.5,
      angle = (2 * Math.PI * (phase + t)) / 900;
    const x = [
      1,
      Math.log1p(t / 60),
      t / 600,
      Math.max(0, t - 300) / 600,
      Math.max(0, t - 600) / 600,
      (lapSec - fit.referenceLap) / 600,
      0,
      Math.sin(angle),
      Math.cos(angle),
    ];
    const z = x.reduce((a, v, i) => a + v * fit.coefficients[i]!, 0);
    const h = Math.min(1 - 1e-9, Math.max(1e-9, 1 / (1 + Math.exp(-z))));
    lastHazard = -Math.log1p(-h) / 15;
    logS += Math.log1p(-h);
    if (logS < Math.log(1e-6)) break;
    xs.push(end);
    ps.push(-Math.expm1(logS));
  }
  const d = {
    xs: Float64Array.from(xs),
    ps: Float64Array.from(ps),
    tailHazard: Math.min(1 / 5, Math.max(1 / 1800, lastHazard)),
  };
  if (cache.size > 32768) cache.clear();
  cache.set(key, d);
  return d;
}

/** Invert conditional survival in log space. A bus that has outlasted the
 * fitted knots still gets the learned tail; CDF rounding must not promise0.
 */
export function releaseResidual(
  d: Dist,
  elapsed: number,
): (u: number) => number {
  const r = Math.max(0, elapsed),
    last = d.xs.length - 1;
  const logs = Array.from(d.ps, (p) => Math.log1p(-p));
  let atRest: number;
  if (r >= d.xs[last]!) atRest = logs[last]! - d.tailHazard * (r - d.xs[last]!);
  else {
    let lo = 0,
      hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (d.xs[mid]! <= r) lo = mid;
      else hi = mid;
    }
    atRest =
      logs[lo]! +
      ((logs[hi]! - logs[lo]!) * (r - d.xs[lo]!)) / (d.xs[hi]! - d.xs[lo]!);
  }
  return (u) => {
    if (u <= 0) return 0;
    const target = atRest + Math.log1p(-Math.min(1 - Number.EPSILON, u));
    if (target <= logs[last]!)
      return Math.max(
        0,
        d.xs[last]! + (logs[last]! - target) / d.tailHazard - r,
      );
    let lo = 0,
      hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (logs[mid]! > target) lo = mid;
      else hi = mid;
    }
    return Math.max(
      0,
      d.xs[lo]! +
        ((d.xs[hi]! - d.xs[lo]!) * (target - logs[lo]!)) /
          (logs[hi]! - logs[lo]!) -
        r,
    );
  };
}
