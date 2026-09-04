/**
 * A Gaussian-sum IMM on a directed route loop.
 *
 * Progress is an unwrapped scalar x. The process can hold or increase x; it
 * cannot decrease it. Consequently last→first is ordinary forward motion and
 * a stop already passed is one lap away. Coincident out-and-back legs are
 * separate branches, each with standing/running Gaussian components. Branches
 * are never collapsed to MAP: later motion must be able to recover from an
 * ambiguous stationary fix.
 */
import {
  distanceToSegmentM,
  haversineMeters,
  progressAlongSegment,
  traceStopLegs,
} from "./geo";
import type { LatLon } from "./geo";

export const DEADBAND_M = 30;
export const TIE_M = 15;

const MAX_PERP_M = 70;
const MAX_PERP_OFFPATH_M = 400;
const GPS_VAR_M2 = 10 ** 2;
const V_PRIOR_M_S = 6.5;
const V_MAX_M_S = 22;
const STALE_MS = 120_000;
const P_RUN_TO_STAND_PER_S = 0.01612;
const P_STAND_TO_RUN_PER_S = 0.01457;
const MIN_VARIANCE = 1e-6;

export interface RouteGeometry {
  offsets: Float64Array;
  loopLength: number;
  legs: Array<{ pts: [number, number][]; cum: Float64Array; total: number }>;
}

export type Mode = "standing" | "running";

/** Gaussian over unwrapped (progress, speed), plus mode-specific rest age. */
export interface Component {
  mode: Mode;
  /** Global mixture weight; all components across all branches sum to one. */
  weight: number;
  x: number;
  v: number;
  varX: number;
  covXV: number;
  varV: number;
  restSec: number;
}

/** One geometric interpretation of the fix. It owns both IMM modes. */
export interface Branch {
  id: number;
  components: [Component, Component];
  /** Posterior progress at the last distinct raw GPS fix. */
  lastFixX: number;
}

export interface Mixture {
  loopLength: number;
  branches: Branch[];
  lastT: number;
  lastFixLat: number;
  lastFixLon: number;
  lastFixT: number;
  /** An unchanged feed hint is evidence once, not once per poll. */
  lastStopId: number | null;
  updates: number;
  /**
   * Direction has become identifiable. Latched so the caller cannot flap
   * between its cold-start fallback and this posterior near a threshold.
   */
  resolved: boolean;
}

export function geometryFromLegs(
  ptsPerLeg: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): RouteGeometry {
  const legs = ptsPerLeg.map((pts) => {
    const copied = pts.map((p) => [p[0], p[1]] as [number, number]);
    const cum = new Float64Array(copied.length);
    for (let i = 1; i < copied.length; i++) {
      cum[i] = cum[i - 1]! + haversineMeters(
        { lat: copied[i - 1]![0], lon: copied[i - 1]![1] },
        { lat: copied[i]![0], lon: copied[i]![1] },
      );
    }
    return { pts: copied, cum, total: cum[cum.length - 1] ?? 0 };
  });
  const offsets = new Float64Array(legs.length + 1);
  for (let i = 0; i < legs.length; i++) {
    offsets[i + 1] = offsets[i]! + legs[i]!.total;
  }
  return { offsets, loopLength: offsets[legs.length] ?? 0, legs };
}

export function buildGeometry(path: [number, number][], stops: LatLon[]): RouteGeometry {
  if (path.length < 2 || stops.length < 2) return geometryFromLegs([]);
  const traced = traceStopLegs(path, [...stops, stops[0]!]);
  return geometryFromLegs(traced.map((leg) => leg.slice));
}

/** Directed distance on the circle, always in [0, L). */
export function forwardM(from: number, to: number, loopLength: number): number {
  if (!(loopLength > 0) || !Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const d = (to - from) % loopLength;
  return d < 0 ? d + loopLength : d;
}

/** The only process operation. Negative motion is outside its support. */
export function advance(x: number, dx: number): number {
  return x + Math.max(0, dx);
}

export function remainingForwardM(x: number, targetWrapped: number, loopLength: number): number {
  return forwardM(x, targetWrapped, loopLength);
}

export function projectOnLeg(
  geo: RouteGeometry,
  legIndex: number,
  p: LatLon,
): { wrapped: number; perp: number } | null {
  const leg = geo.legs[legIndex];
  if (!leg || leg.pts.length < 2 || leg.total <= 0) return null;
  let bestM = Infinity;
  let bestS = 0;
  for (let i = 0; i + 1 < leg.pts.length; i++) {
    const a = { lat: leg.pts[i]![0], lon: leg.pts[i]![1] };
    const b = { lat: leg.pts[i + 1]![0], lon: leg.pts[i + 1]![1] };
    const m = distanceToSegmentM(p, a, b);
    if (m < bestM) {
      bestM = m;
      const t = Math.max(0, Math.min(1, progressAlongSegment(p, a, b)));
      bestS = leg.cum[i]! + t * (leg.cum[i + 1]! - leg.cum[i]!);
    }
  }
  return { wrapped: geo.offsets[legIndex]! + bestS, perp: bestM };
}

function projections(geo: RouteGeometry, p: LatLon, maxPerp: number) {
  const out: Array<{ wrapped: number; perp: number; leg: number }> = [];
  for (let leg = 0; leg < geo.legs.length; leg++) {
    const q = projectOnLeg(geo, leg, p);
    if (q && q.perp <= maxPerp) out.push({ ...q, leg });
  }
  out.sort((a, b) => a.perp - b.perp);
  return out;
}

/** Adjacent legs share a vertex but represent one route position, not a branch. */
function distinctRoutePositions(
  geo: RouteGeometry,
  qs: Array<{ wrapped: number; perp: number; leg: number }>,
) {
  const out: typeof qs = [];
  for (const q of qs) {
    const duplicate = out.some((seen) =>
      Math.min(
        forwardM(seen.wrapped, q.wrapped, geo.loopLength),
        forwardM(q.wrapped, seen.wrapped, geo.loopLength),
      ) < 1
    );
    if (!duplicate) out.push(q);
  }
  return out;
}

function wrapped(x: number, loopLength: number): number {
  return forwardM(0, x, loopLength);
}

function legAt(geo: RouteGeometry, x: number): number {
  const s = wrapped(x, geo.loopLength);
  let leg = 0;
  while (leg + 1 < geo.legs.length && geo.offsets[leg + 1]! <= s + 1e-9) leg++;
  return Math.min(leg, Math.max(0, geo.legs.length - 1));
}

export function componentPosition(
  geo: RouteGeometry,
  component: Component,
): { leg: number; progress: number } {
  const leg = legAt(geo, component.x);
  const length = geo.legs[leg]?.total ?? 0;
  const local = wrapped(component.x, geo.loopLength) - (geo.offsets[leg] ?? 0);
  return {
    leg,
    progress: length > 0 ? Math.max(0, Math.min(1, local / length)) : 0,
  };
}

function branchWeight(branch: Branch): number {
  return branch.components[0].weight + branch.components[1].weight;
}

function branchX(branch: Branch): number {
  const w = branchWeight(branch);
  if (!(w > 0)) return branch.components[0].x;
  return branch.components.reduce((sum, c) => sum + c.weight * c.x, 0) / w;
}

export function ambiguous(mix: Mixture, floor = 0.15): boolean {
  const weights = mix.branches.map(branchWeight).sort((a, b) => b - a);
  return (weights[1] ?? 0) >= floor;
}

/** E[forward arc]. Circularly averaging x first is invalid near the seam. */
export function mixtureRemainingM(mix: Mixture, targetWrapped: number): number {
  return mix.branches.reduce(
    (sum, branch) => sum + branch.components.reduce(
      (inner, c) => inner + c.weight * remainingForwardM(c.x, targetWrapped, mix.loopLength),
      0,
    ),
    0,
  );
}

function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Abramowitz-Stegun 7.1.26; sufficient for the truncated-Gaussian update. */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * a);
  const erf = 1 - (
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
      - 0.284496736) * t + 0.254829592) * t
  ) * Math.exp(-a * a);
  return 0.5 * (1 + sign * erf);
}

/**
 * Condition a bivariate Gaussian on lo <= x <= hi.
 * The returned likelihood is P(lo <= x <= hi): the Tobit/interval evidence
 * used to reweight standing and running IMM modes on a repeated feed fix.
 */
function truncateX(
  c: Component,
  lo: number,
  hi: number,
): { component: Component; likelihood: number } {
  const variance = Math.max(MIN_VARIANCE, c.varX);
  const sd = Math.sqrt(variance);
  const alpha = (lo - c.x) / sd;
  const beta = hi === Infinity ? Infinity : (hi - c.x) / sd;
  const cdfA = normalCdf(alpha);
  const cdfB = beta === Infinity ? 1 : normalCdf(beta);
  const likelihood = Math.max(1e-12, cdfB - cdfA);
  const phiA = normalPdf(alpha);
  const phiB = beta === Infinity ? 0 : normalPdf(beta);
  const lambda = (phiA - phiB) / likelihood;
  const betaPhi = beta === Infinity ? 0 : beta * phiB;
  const factor = Math.max(
    MIN_VARIANCE,
    1 + (alpha * phiA - betaPhi) / likelihood - lambda * lambda,
  );
  const meanX = c.x + sd * lambda;
  const gainV = c.covXV / variance;
  return {
    likelihood,
    component: {
      ...c,
      x: meanX,
      v: c.v + gainV * (meanX - c.x),
      varX: variance * factor,
      covXV: c.covXV * factor,
      varV: Math.max(
        MIN_VARIANCE,
        c.varV - (c.covXV * c.covXV / variance) * (1 - factor),
      ),
    },
  };
}

function updatePosition(
  c: Component,
  z: number,
): { component: Component; likelihood: number } {
  const innovationVariance = Math.max(MIN_VARIANCE, c.varX + GPS_VAR_M2);
  const innovation = z - c.x;
  const kx = c.varX / innovationVariance;
  const kv = c.covXV / innovationVariance;
  const updated: Component = {
    ...c,
    x: c.x + kx * innovation,
    v: c.v + kv * innovation,
    varX: Math.max(MIN_VARIANCE, (1 - kx) * c.varX),
    covXV: (1 - kx) * c.covXV,
    varV: Math.max(MIN_VARIANCE, c.varV - kv * c.covXV),
  };
  return {
    component: updated,
    likelihood: Math.max(
      1e-300,
      normalPdf(innovation / Math.sqrt(innovationVariance))
        / Math.sqrt(innovationVariance),
    ),
  };
}

function gaussianMix(parts: Array<{ c: Component; weight: number }>, mode: Mode): Component {
  const total = parts.reduce((sum, p) => sum + p.weight, 0);
  const norm = total > 0 ? total : 1;
  const x = parts.reduce((sum, p) => sum + p.weight * p.c.x, 0) / norm;
  const v = parts.reduce((sum, p) => sum + p.weight * p.c.v, 0) / norm;
  const varX = parts.reduce(
    (sum, p) => sum + p.weight * (p.c.varX + (p.c.x - x) ** 2),
    0,
  ) / norm;
  const covXV = parts.reduce(
    (sum, p) => sum + p.weight * (
      p.c.covXV + (p.c.x - x) * (p.c.v - v)
    ),
    0,
  ) / norm;
  const varV = parts.reduce(
    (sum, p) => sum + p.weight * (p.c.varV + (p.c.v - v) ** 2),
    0,
  ) / norm;
  const restSec = mode === "standing"
    ? parts.reduce((sum, p) => sum + p.weight * p.c.restSec, 0) / norm
    : 0;
  return {
    mode,
    weight: total,
    x,
    v,
    varX: Math.max(MIN_VARIANCE, varX),
    covXV,
    varV: Math.max(MIN_VARIANCE, varV),
    restSec,
  };
}

/** Mix old modes into each destination mode, as a two-mode IMM requires. */
function interact(branch: Branch, dt: number): [Component, Component] {
  const stand = branch.components.find((c) => c.mode === "standing")!;
  const run = branch.components.find((c) => c.mode === "running")!;
  const sToR = 1 - Math.exp(-P_STAND_TO_RUN_PER_S * dt);
  const rToS = 1 - Math.exp(-P_RUN_TO_STAND_PER_S * dt);
  const nextStand = gaussianMix([
    { c: stand, weight: stand.weight * (1 - sToR) },
    { c: run, weight: run.weight * rToS },
  ], "standing");
  const nextRun = gaussianMix([
    { c: stand, weight: stand.weight * sToR },
    { c: run, weight: run.weight * (1 - rToS) },
  ], "running");
  return [nextStand, nextRun];
}

function predict(c: Component, dt: number, lowerX: number): Component {
  if (c.mode === "standing") {
    const predicted = {
      ...c,
      v: 0,
      // The standing process fixes progress. Measurement uncertainty remains,
      // but the process does not manufacture positional diffusion while a bus
      // is parked.
      varX: c.varX,
      covXV: 0,
      varV: 0.25,
      restSec: c.restSec + dt,
    };
    return truncateX(predicted, lowerX, Infinity).component;
  }
  const v = Math.max(0, Math.min(V_MAX_M_S, c.v));
  const predicted: Component = {
    ...c,
    x: advance(c.x, v * dt),
    v,
    varX: c.varX + 2 * dt * c.covXV + dt * dt * c.varV + dt,
    covXV: c.covXV + dt * c.varV,
    varV: c.varV + 0.25 * dt,
    restSec: 0,
  };
  return truncateX(predicted, lowerX, Infinity).component;
}

/**
 * Lift a wrapped projection to the only nearby lap compatible with forward
 * motion. A point behind may be GPS noise; it is allowed into the likelihood
 * but the posterior is subsequently truncated at lowerX, so it cannot rewind.
 */
function associate(
  geo: RouteGeometry,
  p: LatLon,
  predictedX: number,
  lowerX: number,
  dt: number,
): { hit: { z: number; perp: number; leg: number } | null; onPath: boolean } {
  let qs = projections(geo, p, MAX_PERP_M);
  if (qs.length === 0) qs = projections(geo, p, MAX_PERP_OFFPATH_M);
  const onPath = qs.length > 0;
  const maxAdvance = V_MAX_M_S * dt + DEADBAND_M * 2;
  let best: { z: number; perp: number; leg: number; cost: number } | null = null;
  for (const q of qs) {
    const baseLap = Math.floor(predictedX / geo.loopLength);
    for (let dk = -1; dk <= 1; dk++) {
      const z = q.wrapped + (baseLap + dk) * geo.loopLength;
      if (z < lowerX - DEADBAND_M || z > lowerX + maxAdvance) continue;
      const cost = Math.abs(z - predictedX) + q.perp;
      if (!best || cost < best.cost) best = { z, perp: q.perp, leg: q.leg, cost };
    }
  }
  return {
    hit: best && { z: best.z, perp: best.perp, leg: best.leg },
    onPath,
  };
}

/**
 * Likelihood of last_stop_id for a sequence position. Duplicate stop IDs are
 * intentional on West Campus routes, so every matching occurrence contributes;
 * indexOf would silently collapse the two directions.
 */
export function lastStopLike(
  lastStopId: number | null | undefined,
  branchLeg: number,
  stops: readonly number[],
): number {
  if (lastStopId == null) return 1;
  const n = stops.length;
  if (n === 0) return 1;
  let likelihood = 0;
  for (let i = 0; i < n; i++) {
    if (stops[i] !== lastStopId) continue;
    const behind = ((branchLeg - i) % n + n) % n;
    if (behind === 1) likelihood += 0.35;
    else if (behind === 0) likelihood += 0.262;
    else if (behind === 2) likelihood += 0.066;
    else if (behind === 3) likelihood += 0.042;
    else if (behind === n - 1) likelihood += 0.037;
    else likelihood += 0.01;
  }
  return Math.max(0.01, likelihood);
}

function seed(
  geo: RouteGeometry,
  obs: BeliefObservation,
): Mixture {
  let qs = projections(geo, obs, MAX_PERP_M);
  if (qs.length === 0) qs = projections(geo, obs, MAX_PERP_OFFPATH_M);
  qs = distinctRoutePositions(geo, qs);
  const first = qs[0];
  const second = qs[1];
  const selected = first
    ? [first, ...(second && Math.abs(second.perp - first.perp) <= TIE_M ? [second] : [])]
    : [];
  const logWeights = selected.map((q) => {
    const hint = obs.stops && obs.stops.length === geo.legs.length
      ? lastStopLike(obs.lastStopId, q.leg, obs.stops)
      : 1;
    return -0.5 * q.perp * q.perp / GPS_VAR_M2 + Math.log(hint);
  });
  // Work in log space: fallback candidates may be hundreds of metres off the
  // line, where exp(-d²/2σ²) underflows for every branch. Their relative
  // likelihood is still well-defined and must not produce an all-zero mix.
  const maxLogWeight = logWeights.length > 0 ? Math.max(...logWeights) : 0;
  const rawWeights = logWeights.map((w) => Math.exp(w - maxLogWeight));
  const total = rawWeights.reduce((sum, w) => sum + w, 0) || 1;
  const standingSec = Math.max(0, obs.standingSec ?? 0);
  const branches = selected.map((q, id): Branch => {
    const branchW = rawWeights[id]! / total;
    return {
      id,
      lastFixX: q.wrapped,
      components: [
        {
          mode: "standing",
          weight: branchW * 0.5,
          x: q.wrapped,
          v: 0,
          varX: GPS_VAR_M2,
          covXV: 0,
          varV: 0.25,
          restSec: standingSec,
        },
        {
          mode: "running",
          weight: branchW * 0.5,
          x: q.wrapped,
          v: V_PRIOR_M_S,
          varX: GPS_VAR_M2,
          covXV: 0,
          varV: 9,
          restSec: 0,
        },
      ],
    };
  });
  return {
    loopLength: geo.loopLength,
    branches,
    lastT: obs.t,
    lastFixLat: obs.lat,
    lastFixLon: obs.lon,
    lastFixT: obs.t,
    lastStopId: obs.lastStopId ?? null,
    updates: 0,
    resolved: false,
  };
}

export interface BeliefObservation extends LatLon {
  t: number;
  lastStopId?: number | null;
  stops?: readonly number[];
  /** Server stop-pinned clock, used only on a cold page. */
  standingSec?: number | null;
}

export function stepBelief(
  geo: RouteGeometry,
  prev: Mixture | null,
  obs: BeliefObservation,
): Mixture {
  if (
    !(geo.loopLength > 0)
    || !prev
    || prev.branches.length === 0
    || obs.t - prev.lastT > STALE_MS
  ) {
    return seed(geo, obs);
  }

  // Several live views ask for arrivals during one React render. They share a
  // store and call with millisecond-different Date.now() values, but carry the
  // same feed fix. Applying the censored update on each call would count one
  // observation repeatedly and make the answer depend on render order.
  if (
    obs.t - prev.lastT < 1_000
    && haversineMeters(
      { lat: prev.lastFixLat, lon: prev.lastFixLon },
      obs,
    ) < 1e-6
  ) {
    return prev;
  }

  const dt = Math.max(0.001, (obs.t - prev.lastT) / 1000);
  const censored = haversineMeters(
    { lat: prev.lastFixLat, lon: prev.lastFixLon },
    obs,
  ) < 1e-6;
  const stopChanged = obs.lastStopId != null && obs.lastStopId !== prev.lastStopId;

  const branches: Branch[] = prev.branches.map((branch) => {
    const lowerX = Math.min(...branch.components.map((c) => c.x));
    const mixed = interact(branch, dt);
    const updated = mixed.map((component) => {
      let c = predict(component, dt, lowerX);
      let likelihood = 1;

      if (censored) {
        const conditioned = truncateX(
          c,
          branch.lastFixX,
          branch.lastFixX + DEADBAND_M,
        );
        c = conditioned.component;
        likelihood = conditioned.likelihood;
      } else {
        const association = associate(geo, obs, c.x, lowerX, dt);
        const hit = association.hit;
        if (hit) {
          const position = updatePosition(c, hit.z);
          c = truncateX(position.component, lowerX, Infinity).component;
          likelihood = position.likelihood
            * Math.exp(-0.5 * hit.perp * hit.perp / GPS_VAR_M2);
        } else {
          // Detour/off-path: prediction is information; resetting to zero is not.
          // A fix that IS on the route but is unreachable in the forward
          // process is evidence against this branch. Treating both cases as
          // likelihood 1 made the wrong-direction branch beat the right one,
          // whose Gaussian observation density is necessarily below 1.
          likelihood = association.onPath ? 1e-12 : 1;
        }
      }

      if (stopChanged && obs.stops && obs.stops.length === geo.legs.length) {
        likelihood *= lastStopLike(obs.lastStopId, legAt(geo, c.x), obs.stops);
      }
      return {
        ...c,
        v: Math.max(0, Math.min(V_MAX_M_S, c.v)),
        weight: c.weight * Math.max(1e-300, likelihood),
      };
    }) as [Component, Component];

    return {
      id: branch.id,
      components: updated,
      lastFixX: censored
        ? branch.lastFixX
        : updated.reduce((sum, c) => sum + c.weight * c.x, 0)
          / Math.max(1e-300, updated[0].weight + updated[1].weight),
    };
  });

  // Keep every geometric hypothesis numerically recoverable. This is not a
  // display threshold and not MAP: 1e-12 has no visible effect, but prevents
  // repeated incompatible fixes from underflowing a branch to exact zero,
  // after which later direction evidence could never revive it.
  const maxBranchWeight = Math.max(...branches.map(branchWeight));
  const branchFloor = maxBranchWeight * 1e-12;
  for (const branch of branches) {
    const weight = branchWeight(branch);
    if (weight > 0 && weight < branchFloor) {
      const scale = branchFloor / weight;
      for (const c of branch.components) c.weight *= scale;
    }
  }

  const total = branches.reduce((sum, b) => sum + branchWeight(b), 0);
  if (!(total > 0) || !Number.isFinite(total)) return seed(geo, obs);
  for (const branch of branches) {
    for (const c of branch.components) c.weight /= total;
  }
  const branchWeights = branches.map(branchWeight).sort((a, b) => b - a);
  const resolved = prev.resolved || (branchWeights[1] ?? 0) < 0.15;

  return {
    loopLength: geo.loopLength,
    branches,
    lastT: obs.t,
    lastFixLat: censored ? prev.lastFixLat : obs.lat,
    lastFixLon: censored ? prev.lastFixLon : obs.lon,
    lastFixT: censored ? prev.lastFixT : obs.t,
    lastStopId: obs.lastStopId ?? prev.lastStopId,
    updates: prev.updates + 1,
    resolved,
  };
}

export type BeliefStore = Map<string, Mixture>;

const storesByOwner = new WeakMap<object, BeliefStore>();

/**
 * Attach posterior memory to the same caller-owned lifetime as AnchorStore.
 * Live views share one owner; each replay cohort supplies its own. This keeps
 * hypothetical pure calls memoryless without another global singleton.
 */
export function beliefStoreFor(owner: object): BeliefStore {
  let store = storesByOwner.get(owner);
  if (!store) {
    store = new Map();
    storesByOwner.set(owner, store);
  }
  return store;
}

export function stepStore(
  store: BeliefStore,
  key: string,
  geo: RouteGeometry,
  obs: BeliefObservation,
): Mixture {
  const next = stepBelief(geo, store.get(key) ?? null, obs);
  store.set(key, next);
  return next;
}
