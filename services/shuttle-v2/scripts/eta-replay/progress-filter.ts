/**
 * A 1-D route-progress filter with an explicit standing/running mode, and the
 * censored-observation likelihood the feed's 30 m deadband demands.
 *
 * WHY THIS SHAPE. Three measured facts drive every choice here:
 *
 *  1. The feed reports a new coordinate only after the bus has moved ~30 m.
 *     Zero of 33,118 distinct fixes moved less than 28 m; the floor is 30.0 m
 *     at dt = 5 s, 6-10 s AND 11-20 s, i.e. constant in METRES, not in speed.
 *     So a repeated fix is not noise and not missing data -- it is a CENSORED
 *     observation, |dx| < 30 m, which is an upper bound on speed and the
 *     single most informative signal for "is this bus standing".
 *
 *  2. A constant-velocity filter cannot use that. Its predict step does not
 *     revise velocity, so skipping the update (the 2026-09-02 experiment)
 *     makes it coast at its last speed through exactly the interval that
 *     proves the bus stopped. Hence a MODE, not just a velocity.
 *
 *  3. Acceleration is unobservable. The smallest measurable displacement is
 *     30 m, so at 5 s polling the velocity quantum is 6 m/s = 13 mph. A bus
 *     reaching 20 mph from rest takes ~45 m -- one or two fixes. There is no
 *     inertia to estimate, which is why the state is (progress, speed, mode)
 *     and not (position, velocity, acceleration, mass).
 *
 * WHAT IT IS FOR. Not accuracy -- a perfect motion model is worth 1.9 s of
 * 41.4 s (docs/eta-error-budget.md). STABILITY. 60% of the estimator's
 * catastrophic ETA jumps are anchor flips: `findRouteAnchor` re-decides from
 * scratch every poll, and where a route passes near itself it swaps branches
 * and teleports the bus. Progress that can only advance cannot teleport.
 */
import { distanceMeters } from "../../src/network/geo.js";
import { distanceToSegmentM, haversineMeters, progressAlongSegment, traceStopLegs } from "../../web/src/geo";

export interface RouteGeometry {
  /** Cumulative distance to the START of each leg, plus total at the end. */
  offsets: Float64Array;
  loopLength: number;
  /** Flattened polyline points per leg. */
  legs: Array<{ pts: [number, number][]; cum: Float64Array; total: number }>;
}

/** Build leg-wise geometry for a route from its published polyline + stops. */
export function buildGeometry(path: [number, number][], stopsLL: Array<{ lat: number; lon: number }>): RouteGeometry {
  // traceStopLegs takes LatLon OBJECTS, not [lat, lon] tuples.
  const traced = traceStopLegs(path, [...stopsLL, stopsLL[0]!]);
  const legs = traced.map((tl) => {
    const cum = new Float64Array(tl.slice.length);
    for (let i = 1; i < tl.slice.length; i++) {
      cum[i] = cum[i - 1]! + haversineMeters(
        { lat: tl.slice[i - 1]![0], lon: tl.slice[i - 1]![1] },
        { lat: tl.slice[i]![0], lon: tl.slice[i]![1] },
      );
    }
    return { pts: tl.slice, cum, total: cum[cum.length - 1] ?? 0 };
  });
  const offsets = new Float64Array(legs.length + 1);
  for (let i = 0; i < legs.length; i++) offsets[i + 1] = offsets[i]! + legs[i]!.total;
  return { offsets, loopLength: offsets[legs.length]!, legs };
}

/** Every place on the loop this fix could be, cheapest first. */
function candidates(geo: RouteGeometry, p: { lat: number; lon: number }, maxPerpM: number) {
  const out: Array<{ progress: number; perp: number; leg: number }> = [];
  for (let li = 0; li < geo.legs.length; li++) {
    const leg = geo.legs[li]!;
    if (leg.pts.length < 2 || leg.total <= 0) continue;
    let bestM = Infinity;
    let bestS = 0;
    for (let i = 0; i + 1 < leg.pts.length; i++) {
      const a = { lat: leg.pts[i]![0], lon: leg.pts[i]![1] };
      const b = { lat: leg.pts[i + 1]![0], lon: leg.pts[i + 1]![1] };
      const m = distanceToSegmentM(p, a, b);
      if (m < bestM) {
        bestM = m;
        const tt = Math.max(0, Math.min(1, progressAlongSegment(p, a, b)));
        bestS = leg.cum[i]! + tt * (leg.cum[i + 1]! - leg.cum[i]!);
      }
    }
    if (bestM <= maxPerpM) out.push({ progress: geo.offsets[li]! + bestS, perp: bestM, leg: li });
  }
  return out;
}

/** Where on ONE leg this fix projects, and how far off that leg it is. */
export function projectOnLeg(geo: RouteGeometry, li: number, p: { lat: number; lon: number }): { progress: number; perp: number } | null {
  const leg = geo.legs[li];
  if (!leg || leg.pts.length < 2 || leg.total <= 0) return null;
  let bestM = Infinity;
  let bestS = 0;
  for (let i = 0; i + 1 < leg.pts.length; i++) {
    const a = { lat: leg.pts[i]![0], lon: leg.pts[i]![1] };
    const b = { lat: leg.pts[i + 1]![0], lon: leg.pts[i + 1]![1] };
    const m = distanceToSegmentM(p, a, b);
    if (m < bestM) {
      bestM = m;
      const tt = Math.max(0, Math.min(1, progressAlongSegment(p, a, b)));
      bestS = leg.cum[i]! + tt * (leg.cum[i + 1]! - leg.cum[i]!);
    }
  }
  return { progress: geo.offsets[li]! + bestS, perp: bestM };
}

/** Point on the loop at a given progress. */
export function pointAt(geo: RouteGeometry, progress: number): { lat: number; lon: number; leg: number } {
  let s = ((progress % geo.loopLength) + geo.loopLength) % geo.loopLength;
  let li = 0;
  while (li + 1 < geo.legs.length && geo.offsets[li + 1]! <= s) li++;
  const leg = geo.legs[li]!;
  const local = s - geo.offsets[li]!;
  if (leg.pts.length < 2) return { lat: leg.pts[0]?.[0] ?? 0, lon: leg.pts[0]?.[1] ?? 0, leg: li };
  let i = 0;
  while (i + 2 < leg.pts.length && leg.cum[i + 1]! < local) i++;
  const seg = Math.max(1e-9, leg.cum[i + 1]! - leg.cum[i]!);
  const f = Math.max(0, Math.min(1, (local - leg.cum[i]!) / seg));
  return {
    lat: leg.pts[i]![0] + f * (leg.pts[i + 1]![0] - leg.pts[i]![0]),
    lon: leg.pts[i]![1] + f * (leg.pts[i + 1]![1] - leg.pts[i]![1]),
    leg: li,
  };
}

// -- Tuning, all measured rather than chosen ----------------------------------
/** The feed's position deadband (docs/eta-error-budget.md). */
export const DEADBAND_M = 30;
/**
 * Emission and transition parameters, all measured on the 2026-09-03 window
 * (75,003 positions, 21 buses) with the run-based stillness classifier:
 *
 *   P(frozen | standing)   0.9191   n = 39,319 pairs
 *   P(frozen | running)    0.1585   n = 35,576 pairs
 *   P(run -> stand)/s      0.01612  2,886 transitions over 178,999 running s
 *   P(stand -> run)/s      0.01457  2,884 transitions over 197,986 standing s
 *
 * Mean standing spell 68.6 s, mean running spell 62.0 s -- a bus on this
 * network spends about half its time not moving, which is why the mode is the
 * payload and the speed is the detail.
 */
const P_FROZEN_GIVEN_STAND = 0.9191;
const P_FROZEN_GIVEN_RUN = 0.1585;
const P_RUN_TO_STAND_PER_S = 0.01612;
const P_STAND_TO_RUN_PER_S = 0.01457;
/** Perpendicular distance beyond which a leg is not a candidate at all. */
const MAX_PERP_M = 70;
/** Cost per metre of disagreement with the predicted progress. */
const LAMBDA = 0.55;
/** Speed floor/ceiling for the running mode (m/s). */
const V_MIN = 1.5;
const V_MAX = 22;
/** Exponential smoothing on speed once a fresh displacement is available. */
const V_ALPHA = 0.35;

export interface FilterState {
  progress: number;
  v: number;
  pStand: number;
  /** When pStand last rose above 0.5 -- "how long has it been standing". */
  standingSince: number | null;
  lastT: number;
  /** Last DISTINCT fix, for the censoring bound. */
  lastFixLat: number;
  lastFixLon: number;
  lastFixT: number;
  lastFixProgress: number;
}

export interface FilterOut {
  progress: number;
  leg: number;
  lat: number;
  lon: number;
  pStand: number;
  standingSince: number | null;
  v: number;
  /** True when this poll's fix repeated the previous one. */
  censored: boolean;
}

/**
 * One filter step.
 *
 * The mode update is a two-state HMM forward step. Its emission is the whole
 * point: a repeated fix is evidence FOR standing in proportion to how long it
 * has been repeating, because the censoring bound |dx| < 30 m gets harder and
 * harder for a running bus to satisfy as time passes. That is the information
 * both previously-tested Kalman variants threw away -- one by dropping the
 * sample, the other by coasting through it.
 */
export function step(
  geo: RouteGeometry,
  prev: FilterState | null,
  obs: { lat: number; lon: number; t: number },
): { state: FilterState; out: FilterOut } {
  const cands = candidates(geo, obs, MAX_PERP_M);
  // Cold start, or the bus is nowhere near the modelled path: trust geometry.
  if (!prev || cands.length === 0 || obs.t - prev.lastT > 120_000) {
    const best = cands.length
      ? cands.reduce((a, b) => (a.perp <= b.perp ? a : b))
      : { progress: 0, perp: Infinity, leg: 0 };
    const pt = pointAt(geo, best.progress);
    const state: FilterState = {
      progress: best.progress, v: 6, pStand: 0.5, standingSince: null, lastT: obs.t,
      lastFixLat: obs.lat, lastFixLon: obs.lon, lastFixT: obs.t, lastFixProgress: best.progress,
    };
    return { state, out: { progress: best.progress, leg: pt.leg, lat: pt.lat, lon: pt.lon, pStand: 0.5, standingSince: null, v: state.v, censored: false } };
  }

  const dt = Math.max(0.001, (obs.t - prev.lastT) / 1000);
  const moved = distanceMeters({ lat: prev.lastFixLat, lon: prev.lastFixLon }, obs);
  const censored = moved < 1e-9;

  // ---- mode: Markov prior, then the censoring likelihood
  const pStayStand = Math.exp(-P_STAND_TO_RUN_PER_S * dt);
  const pStayRun = Math.exp(-P_RUN_TO_STAND_PER_S * dt);
  let priorStand = prev.pStand * pStayStand + (1 - prev.pStand) * (1 - pStayRun);
  priorStand = Math.min(1 - 1e-6, Math.max(1e-6, priorStand));

  let likeStand: number;
  let likeRun: number;
  if (censored) {
    // The bound is |dx| < DEADBAND_M since the last DISTINCT fix. For a
    // running bus that gets less and less plausible as the freeze lengthens,
    // which is what makes a long freeze read as standing.
    const frozenFor = Math.max(dt, (obs.t - prev.lastFixT) / 1000);
    likeStand = P_FROZEN_GIVEN_STAND;
    const needed = DEADBAND_M / Math.max(1e-6, frozenFor); // m/s a runner must be under
    const feasible = Math.min(1, Math.max(0, needed / Math.max(V_MIN, prev.v)));
    likeRun = P_FROZEN_GIVEN_RUN * feasible;
  } else {
    // A fresh fix that moved: a standing bus essentially cannot produce one.
    likeStand = 1 - P_FROZEN_GIVEN_STAND;
    likeRun = 1 - P_FROZEN_GIVEN_RUN;
  }
  const num = priorStand * likeStand;
  const pStand = Math.min(1 - 1e-6, Math.max(1e-6, num / (num + (1 - priorStand) * likeRun)));

  // ---- progress: predict, then pick the candidate consistent with history
  const running = 1 - pStand;
  const predicted = prev.progress + prev.v * running * dt;
  let best = cands[0]!;
  let bestCost = Infinity;
  for (const c of cands) {
    // Forward-wrapped gap: going backwards is expensive, which is exactly the
    // anti-teleport rule. A genuine wrap round the loop stays cheap because it
    // is forward.
    let d = c.progress - predicted;
    while (d < -geo.loopLength / 2) d += geo.loopLength;
    while (d > geo.loopLength / 2) d -= geo.loopLength;
    const backwards = d < 0 ? 3 : 1; // going back costs triple
    const cost = c.perp + LAMBDA * backwards * Math.abs(d);
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  let progress = best.progress;
  // A censored poll cannot have advanced past the deadband; clamp so a frozen
  // bus stops creeping forward on the motion model alone.
  if (censored) {
    let adv = progress - prev.lastFixProgress;
    while (adv < -geo.loopLength / 2) adv += geo.loopLength;
    if (adv > DEADBAND_M) progress = prev.lastFixProgress + DEADBAND_M;
    if (adv < 0) progress = prev.lastFixProgress;
  }

  // ---- speed, only from genuine displacement
  let v = prev.v;
  if (!censored) {
    const elapsed = Math.max(0.001, (obs.t - prev.lastFixT) / 1000);
    let adv = progress - prev.lastFixProgress;
    while (adv < -geo.loopLength / 2) adv += geo.loopLength;
    const inst = Math.max(0, adv) / elapsed;
    v = V_ALPHA * Math.min(V_MAX, inst) + (1 - V_ALPHA) * prev.v;
  } else if (pStand > 0.5) {
    v = Math.min(prev.v, DEADBAND_M / Math.max(1, (obs.t - prev.lastFixT) / 1000));
  }
  v = Math.min(V_MAX, Math.max(0, v));

  const wasStanding = prev.standingSince !== null;
  const isStanding = pStand > 0.5;
  const standingSince = isStanding ? (wasStanding ? prev.standingSince : obs.t) : null;

  const pt = pointAt(geo, progress);
  const state: FilterState = {
    progress, v, pStand, standingSince, lastT: obs.t,
    lastFixLat: censored ? prev.lastFixLat : obs.lat,
    lastFixLon: censored ? prev.lastFixLon : obs.lon,
    lastFixT: censored ? prev.lastFixT : obs.t,
    lastFixProgress: censored ? prev.lastFixProgress : progress,
  };
  return { state, out: { progress, leg: pt.leg, lat: pt.lat, lon: pt.lon, pStand, standingSince, v, censored } };
}
