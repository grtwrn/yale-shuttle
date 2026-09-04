/**
 * WHERE IS THE BUS, AS A BELIEF — a Gaussian-sum IMM with a Tobit update on a
 * 1-D road-constrained state. The specification is `docs/eta-estimator-design.md`;
 * the plan, the predictions and the paired result are `docs/eta-estimator-imm.md`.
 *
 * WHY A DISTRIBUTION AT ALL. `findRouteAnchor` is a point: it names one leg.
 * Where a route folds back on itself the same coordinates belong to two legs at
 * once, and on 42.8% of Purple's ambiguous polls (23.2% of Green's) the bus is
 * STATIONARY on a shared segment, so there is no direction to read and nothing
 * in the feed can decide between them. An earlier occurrence-aware anchor tied
 * at forward-distance 0 between two chords leaving the same repeated stop and
 * was settled by centimetres. That tie is the argument for a belief in one
 * line: the honest answer is not a better tie-break, it is two hypotheses with
 * weights.
 *
 * WHAT THIS IS NOT. It is not a smoother and not a slew limiter. Nothing is
 * damped in TIME: a bus that provably leaves moves the weights in the same poll
 * it moves, and the reported number moves with them. What it removes is the
 * DISCONTINUITY of a point anchor — a third of a lap in one poll on a
 * centimetre of GPS — by making the answer continuous in the belief instead.
 *
 * THE ONE STRUCTURAL PROMISE. The shipped placement (the gated anchor, the
 * production standing clock, the production proration) is always a component of
 * the mixture, and when the belief is unimodal on that same leg the mixture IS
 * that component — byte-identical to master. So this can only ever ADD
 * alternatives with the weight the evidence gives them; it can never quietly
 * substitute its own anchor for the shipped one, and a paired replay diff is
 * exactly the ambiguous population and nothing else.
 *
 * STATE lives in a WeakMap keyed on the caller's `AnchorStore`, exactly as
 * `hopPricing.ts` keys its standing memo: a hypothetical or replayed
 * computation passes its own store (or none, and then this module is not
 * consulted at all and `computeUpcomingArrivals` behaves as it always has).
 */

import { distanceToSegmentM, haversineMeters, progressAlongSegment } from "./geo";
import type { LatLon } from "./geo";
import { ANCHOR_DIRECTION_MIN_M, ANCHOR_GPS_THRESHOLD_M } from "./anchor";

// ---------------------------------------------------------------------------
// The measured priors. Every constant here is a number from the corpus, not a
// taste: `docs/eta-estimator-design.md`, "Priors, all measured".
// ---------------------------------------------------------------------------

/**
 * The feed publishes a new coordinate only once a bus has moved ~30 m
 * (p1 30.1 m, p10 30.7 m over 33,118 distinct fixes). A REPEATED fix is
 * therefore not "no observation": it is the observation `displacement < 30 m`,
 * which is what the Tobit update below consumes.
 */
export const DEADBAND_M = 30;

/** Fix noise on a fresh fix, along the leg. */
const SIGMA_FIX_M = 10;

/**
 * Perpendicular tolerance for the branch likelihood. Wider than the fix noise
 * on purpose: the residual is measured to the CHORD between two stops, and a
 * road that bends away from its chord contributes far more than the GPS does.
 * `ANCHOR_GPS_THRESHOLD_M` (150 m) is where a leg stops being a candidate at
 * all, so a 40 m scale puts the edge of the candidate set at ~7 sigma.
 */
const SIGMA_PERP_M = 40;

/**
 * Off-stop mode hazards, per second (run -> stand 0.01612, stand -> run
 * 0.01457). Over a 5 s poll that is a ~7.8% / ~7.0% chance of switching, which
 * is the measured stop-and-go of this feed.
 */
const HAZARD_RUN_TO_STAND = 0.01612;
const HAZARD_STAND_TO_RUN = 0.01457;

/**
 * How hard the direction of travel argues for a branch. The likelihood is
 * exp(kappa * cos) between the step and the leg, so two anti-parallel legs
 * differ by exp(2 * kappa * cos) — at the +-0.6 cosine PR #86 measured as the
 * right threshold that is a ~20:1 ratio on ONE fresh fix and ~400:1 on two,
 * which is the "settled within two fresh fixes" the design asks for. It is
 * deliberately not infinite: a filter that cannot be talked out of a branch is
 * the branch lock that disqualified every earlier arm.
 */
const DIRECTION_KAPPA = 2.5;

/**
 * A branch may never be argued below this weight while it is still a geometric
 * candidate. THIS IS THE ANTI-LOCK FLOOR and it is the difference between this
 * and every filter that came before: 7.5% of departures were a full lap wrong
 * because a forward-only filter committed and no later fix could move it. A
 * hypothesis held at 2% recovers in two fresh fixes when the evidence turns.
 */
const WEIGHT_FLOOR = 0.02;

/** A hypothesis that is no longer within `ANCHOR_GPS_THRESHOLD_M` decays this fast, then dies. */
const OFF_CANDIDATE_DECAY = 0.3;
const WEIGHT_DEATH = 0.005;

/** A newly plausible leg enters with this share before its own likelihood. */
const BIRTH_WEIGHT = 0.05;

/** At most this many branches. On this network at most two legs share a coordinate. */
const MAX_BRANCHES = 2;

/** A bus unseen for this long has no usable belief; start fresh. (Mirrors ANCHOR_STALE_MS.) */
const STALE_MS = 120_000;

/** Speed prior when a branch is born, m/s, and the process noise on it. */
const V0_M_S = 7;
const SIGMA_V0 = 4;
const Q_V = 1.0; // m/s per sqrt(s) — the acceleration this feed cannot resolve anyway

/**
 * `last_stop_id` against the leg the bus is on, from the measured table
 * (fresh fix: nearest-1 35.0%, = 26.2%, -2 6.6%, -3 4.2%, +1 3.7%). Read ONLY
 * on the poll the reading CHANGES: a stale value held across a 5 km run is one
 * observation, and applying it every poll would multiply one wrong reading a
 * hundred times.
 */
const LAST_STOP_LIKELIHOOD = [0.30, 0.35, 0.10, 0.05];
const LAST_STOP_FLOOR = 0.02;

// ---------------------------------------------------------------------------

/** One mode-conditioned Gaussian over (progress s in metres, speed v in m/s). */
interface Gauss {
  s: number;
  v: number;
  /** Covariance [ss, sv, vv]. */
  p: [number, number, number];
}

interface Branch {
  /** Leg index: the bus is between stops[leg] and stops[leg + 1]. */
  leg: number;
  /** Branch weight, normalised across branches. */
  w: number;
  /** Mode-conditioned states and the mode probability of STANDING. */
  stand: Gauss;
  run: Gauss;
  pStand: number;
  /** Progress at the last fresh fix — the origin the censored displacement is measured from. */
  sFresh: number;
  tFresh: number;
}

interface BusBelief {
  branches: Branch[];
  seenAt: number;
  fix: LatLon;
  lastStopId: number | null;
}

const beliefs = new WeakMap<object, Map<string, BusBelief>>();

/** A placement the ETA can be priced from: one leg, one mode, one weight. */
export interface Placement {
  /** Anchor index — the leg's start stop, exactly what `computeUpcomingArrivals` walks from. */
  idx: number;
  /** Seconds standing at the anchor stop, or null when this component is en route. */
  standingSec: number | null;
  /** Elapsed dwell credit for the pre-split pricing path, seconds. */
  stallCredit: number;
  /** Fraction of the first chord still ahead (1 = at the stop). */
  progressFactor: number;
  /** Mixture weight, summing to 1 across the returned placements. */
  weight: number;
}

const legLengthM = (
  leg: number,
  stops: number[],
  stopCoords: Record<number, LatLon>,
): number => {
  const a = stopCoords[stops[leg]!];
  const b = stopCoords[stops[(leg + 1) % stops.length]!];
  return a && b ? Math.max(1, haversineMeters(a, b)) : 1;
};

const perpM = (
  bus: LatLon,
  leg: number,
  stops: number[],
  stopCoords: Record<number, LatLon>,
): number => {
  const a = stopCoords[stops[leg]!];
  const b = stopCoords[stops[(leg + 1) % stops.length]!];
  return a && b ? distanceToSegmentM(bus, a, b) : Infinity;
};

const alongM = (
  bus: LatLon,
  leg: number,
  stops: number[],
  stopCoords: Record<number, LatLon>,
): number => {
  const a = stopCoords[stops[leg]!];
  const b = stopCoords[stops[(leg + 1) % stops.length]!];
  if (!a || !b) return 0;
  return progressAlongSegment(bus, a, b) * legLengthM(leg, stops, stopCoords);
};

/** cos between the bus's step and the leg's chord, or null when either has no length. */
function headingCos(prev: LatLon, now: LatLon, a: LatLon, b: LatLon): number | null {
  const scale = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const lx = (b.lon - a.lon) * scale;
  const ly = b.lat - a.lat;
  const dx = (now.lon - prev.lon) * scale;
  const dy = now.lat - prev.lat;
  const ln = Math.hypot(lx, ly);
  const dn = Math.hypot(dx, dy);
  if (ln < 1e-12 || dn < 1e-12) return null;
  return (lx * dx + ly * dy) / (ln * dn);
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 on erf). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}
const normalPdf = (z: number): number => 0.3989422804014327 * Math.exp((-z * z) / 2);

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

function predict(g: Gauss, dt: number, moving: boolean): Gauss {
  if (!moving) {
    // Standing: s holds, v decays to zero, a metre of fix wander per poll.
    return { s: g.s, v: 0, p: [g.p[0] + 4 * dt, 0, 1] };
  }
  const s = g.s + g.v * dt;
  const [ss, sv, vv] = g.p;
  // Constant-velocity propagation with white-acceleration process noise.
  const q = Q_V * Q_V;
  return {
    s,
    v: g.v,
    p: [
      ss + 2 * sv * dt + vv * dt * dt + (q * dt * dt * dt) / 3,
      sv + vv * dt + (q * dt * dt) / 2,
      vv + q * dt,
    ],
  };
}

/** Linear Kalman update of s from a fresh fix. Returns the posterior and the likelihood. */
function updateFresh(g: Gauss, z: number): { g: Gauss; like: number } {
  const r = SIGMA_FIX_M * SIGMA_FIX_M;
  const sInn = g.p[0] + r;
  const y = z - g.s;
  const k0 = g.p[0] / sInn;
  const k1 = g.p[1] / sInn;
  const like = normalPdf(y / Math.sqrt(sInn)) / Math.sqrt(sInn);
  return {
    g: {
      s: g.s + k0 * y,
      v: g.v + k1 * y,
      p: [
        g.p[0] * (1 - k0),
        g.p[1] * (1 - k0),
        Math.max(0.01, g.p[2] - k1 * g.p[1]),
      ],
    },
    like,
  };
}

/**
 * TYPE I CENSORED (TOBIT) UPDATE — the load-bearing piece.
 *
 * A repeated fix says the bus has moved less than the deadband SINCE THE LAST
 * FRESH FIX. That is a real observation and a running hypothesis is bad at
 * explaining it: predict 140 m of travel, observe "under 30 m", and the
 * likelihood collapses. This is the exact inverse of an EMA, which keeps
 * converging on polls that carry no observation and so manufactures motion —
 * measured at 3-7x worse eventless jumps and rejected (PR #77).
 *
 * The update is Allik, Miller, Piovoso & Zurakowski (IEEE TCST 2016): replace
 * the censored observation by its truncated-normal conditional expectation and
 * scale the gain by the censoring probability.
 */
export function tobitUpdate(
  g: Gauss,
  /** Progress at the last fresh fix — displacement is measured from here. */
  sFresh: number,
  limitM = DEADBAND_M,
): { g: Gauss; like: number } {
  const d = g.s - sFresh; // predicted displacement since the last fresh fix
  const sd = Math.sqrt(Math.max(1, g.p[0] + SIGMA_FIX_M * SIGMA_FIX_M));
  const beta = (limitM - d) / sd;
  const alpha = Math.max(1e-9, normalCdf(beta)); // P(the fix would repeat | this state)
  // E[d | d < limit] for a normal, and the variance of that truncated law.
  const lambda = normalPdf(beta) / alpha;
  const eTrunc = d - sd * lambda;
  const vTrunc = sd * sd * Math.max(0.05, 1 - lambda * (lambda - beta));
  const z = sFresh + eTrunc;
  const sInn = g.p[0] + vTrunc;
  const y = z - g.s;
  // The gain is scaled by alpha: an observation that this state finds
  // impossible must not be allowed to drag it there, only to kill its weight.
  const k0 = (alpha * g.p[0]) / sInn;
  const k1 = (alpha * g.p[1]) / sInn;
  return {
    g: {
      s: g.s + k0 * y,
      v: g.v + k1 * y,
      p: [
        Math.max(1, g.p[0] * (1 - k0)),
        g.p[1] * (1 - k0),
        Math.max(0.01, g.p[2] - k1 * g.p[1]),
      ],
    },
    like: alpha,
  };
}

/** IMM: mix, predict each mode, and return the mixed pair with its mode prior. */
function immPredict(b: Branch, dt: number, onStopHazard: number | null): void {
  const pRun = 1 - b.pStand;
  const hStandToRun = onStopHazard ?? HAZARD_STAND_TO_RUN;
  const pSR = 1 - Math.exp(-hStandToRun * dt); // standing -> running
  const pRS = 1 - Math.exp(-HAZARD_RUN_TO_STAND * dt); // running -> standing
  const nStand = b.pStand * (1 - pSR) + pRun * pRS;
  const nRun = b.pStand * pSR + pRun * (1 - pRS);
  const tot = Math.max(1e-9, nStand + nRun);
  // Mixed initial conditions: each mode starts from a blend of both, weighted
  // by where the mass came from.
  const wSS = (b.pStand * (1 - pSR)) / Math.max(1e-9, nStand);
  const wRS = (pRun * pRS) / Math.max(1e-9, nStand);
  const wSR = (b.pStand * pSR) / Math.max(1e-9, nRun);
  const wRR = (pRun * (1 - pRS)) / Math.max(1e-9, nRun);
  const blend = (a: Gauss, bb: Gauss, wa: number, wb: number): Gauss => {
    const s = wa * a.s + wb * bb.s;
    const v = wa * a.v + wb * bb.v;
    const da = a.s - s;
    const db = bb.s - s;
    const dav = a.v - v;
    const dbv = bb.v - v;
    return {
      s,
      v,
      p: [
        wa * (a.p[0] + da * da) + wb * (bb.p[0] + db * db),
        wa * (a.p[1] + da * dav) + wb * (bb.p[1] + db * dbv),
        wa * (a.p[2] + dav * dav) + wb * (bb.p[2] + dbv * dbv),
      ],
    };
  };
  const mixStand = blend(b.stand, b.run, wSS, wRS);
  const mixRun = blend(b.stand, b.run, wSR, wRR);
  b.stand = predict(mixStand, dt, false);
  b.run = predict(mixRun, dt, true);
  b.pStand = nStand / tot;
}

/**
 * One poll of the belief. Returns the placements the ETA should be priced from,
 * with the SHIPPED placement always present (see the file header).
 */
export function updateBelief(
  store: object,
  key: string,
  bus: { lat?: number | undefined; lon?: number | undefined; last_stop_id?: number | null | undefined; at_stop_id?: number | null | undefined },
  stops: number[],
  stopCoords: Record<number, LatLon>,
  now: number,
  shipped: Placement,
  /** Hazard of this stop's own rest distribution, per second, when standing at one. */
  onStopHazard: number | null,
): Placement[] {
  const N = stops.length;
  const lat = bus.lat;
  const lon = bus.lon;
  if (!lat || !lon || N === 0) return [shipped];
  const here: LatLon = { lat, lon };
  let byBus = beliefs.get(store);
  if (!byBus) beliefs.set(store, (byBus = new Map()));
  const prev = byBus.get(key);
  const lastStopId = bus.last_stop_id ?? null;

  // Which legs could hold this fix at all? The same candidate rule the point
  // anchor uses, so the belief never considers a leg the anchor would not —
  // and then one restriction, which is the whole scope of this module.
  //
  // A leg ADJACENT to the shipped one in sequence is not a branch. Every bus
  // standing at a stop is within 150 m of the chord in and the chord out, and
  // which of those it is on is PROGRESS: the point anchor plus its proration
  // already answer it continuously, and the answers differ by one hop rather
  // than by a lap. The ambiguity this exists for is legs that are metres apart
  // in space and far apart in SEQUENCE — the two chords of a fold, the (N)/(S)
  // twins 9 stops apart — where choosing wrong is a third of a loop. So an
  // alternative must be at least two positions away, and everything else is
  // left exactly as production has it.
  const seqDist = (a: number, b: number): number => {
    const f = ((a - b) % N + N) % N;
    return Math.min(f, N - f);
  };
  const admissible = (leg: number): boolean => leg === shipped.idx || seqDist(leg, shipped.idx) >= 2;
  const candidates: Array<{ leg: number; perp: number }> = [];
  for (let i = 0; i < N; i++) {
    if (!admissible(i)) continue;
    const d = perpM(here, i, stops, stopCoords);
    if (d < ANCHOR_GPS_THRESHOLD_M) candidates.push({ leg: i, perp: d });
  }
  if (!candidates.some((c) => c.leg === shipped.idx)) {
    candidates.push({ leg: shipped.idx, perp: perpM(here, shipped.idx, stops, stopCoords) });
  }

  const born = (leg: number, w: number): Branch => {
    const s = alongM(here, leg, stops, stopCoords);
    const g: Gauss = { s, v: 0, p: [SIGMA_FIX_M * SIGMA_FIX_M, 0, SIGMA_V0 * SIGMA_V0] };
    return {
      leg,
      w,
      stand: { ...g, p: [...g.p] as [number, number, number] },
      run: { ...g, v: V0_M_S, p: [...g.p] as [number, number, number] },
      // A cold client has no history: half standing, half running is the honest
      // prior, and one poll of evidence settles it.
      pStand: 0.5,
      sFresh: s,
      tFresh: now,
    };
  };

  // --- cold start: no history, or away long enough to have none.
  if (!prev || now - prev.seenAt > STALE_MS) {
    const branches = candidates
      .map((c) => born(c.leg, Math.exp(-(c.perp * c.perp) / (2 * SIGMA_PERP_M * SIGMA_PERP_M))))
      .sort((a, b) => b.w - a.w)
      .slice(0, MAX_BRANCHES);
    // The shipped leg must survive the cut, or the promise in the header fails.
    if (!branches.some((b) => b.leg === shipped.idx)) {
      branches[branches.length - 1] = born(shipped.idx, branches[branches.length - 1]?.w ?? 1);
    }
    normalise(branches);
    byBus.set(key, { branches, seenAt: now, fix: here, lastStopId });
    return place(branches, shipped, stops, stopCoords);
  }

  const dt = Math.max(0.001, Math.min(60, (now - prev.seenAt) / 1000));
  const moved = haversineMeters(here, prev.fix);
  const fresh = moved > 0;
  const branches = prev.branches;

  for (const b of branches) {
    // --- predict, and advance the leg if the belief has run off its end.
    immPredict(b, dt, onStopHazard);
    for (let guard = 0; guard < 4; guard++) {
      const len = legLengthM(b.leg, stops, stopCoords);
      if (b.run.s <= len) break;
      b.leg = (b.leg + 1) % N;
      b.run.s -= len;
      b.stand.s = Math.max(0, b.stand.s - len);
      b.sFresh = Math.max(0, b.sFresh - len);
    }

    // --- update
    let like: number;
    if (fresh) {
      const z = alongM(here, b.leg, stops, stopCoords);
      const us = updateFresh(b.stand, z);
      const ur = updateFresh(b.run, z);
      b.stand = us.g;
      b.run = ur.g;
      const tot = Math.max(1e-12, b.pStand * us.like + (1 - b.pStand) * ur.like);
      b.pStand = (b.pStand * us.like) / tot;
      b.sFresh = z;
      b.tFresh = now;
      // The perpendicular residual is the branch's own likelihood: how well
      // this leg explains where the bus actually is.
      const perp = perpM(here, b.leg, stops, stopCoords);
      like = tot * Math.exp(-(perp * perp) / (2 * SIGMA_PERP_M * SIGMA_PERP_M));
      // A step long enough to be a step says which way the bus is going, and
      // two anti-parallel legs disagree about that by construction.
      if (moved >= ANCHOR_DIRECTION_MIN_M) {
        const a = stopCoords[stops[b.leg]!];
        const bb = stopCoords[stops[(b.leg + 1) % N]!];
        const c = a && bb ? headingCos(prev.fix, here, a, bb) : null;
        if (c !== null) like *= Math.exp(DIRECTION_KAPPA * c);
      }
    } else {
      // The fix repeated: the censored observation.
      const us = tobitUpdate(b.stand, b.sFresh);
      const ur = tobitUpdate(b.run, b.sFresh);
      b.stand = us.g;
      b.run = ur.g;
      const tot = Math.max(1e-12, b.pStand * us.like + (1 - b.pStand) * ur.like);
      b.pStand = (b.pStand * us.like) / tot;
      like = tot;
    }
    b.w *= like;
  }

  // `last_stop_id`, and ONLY on the poll its reading changes.
  if (lastStopId !== null && lastStopId !== prev.lastStopId) {
    const li = stops.indexOf(lastStopId);
    if (li >= 0) {
      for (const b of branches) {
        const off = ((b.leg - li) % N + N) % N;
        b.w *= LAST_STOP_LIKELIHOOD[off] ?? LAST_STOP_FLOOR;
      }
    }
  }

  // Hypotheses the geometry no longer supports — or that the shipped anchor has
  // caught up with, so they are no longer a branch at all — fade rather than
  // vanishing.
  const isCandidate = new Set(candidates.map((c) => c.leg));
  for (const b of branches) if (!isCandidate.has(b.leg)) b.w *= OFF_CANDIDATE_DECAY;

  // Births: a leg that has become plausible and is not yet believed in.
  normalise(branches);
  for (const c of candidates) {
    if (branches.some((b) => b.leg === c.leg)) continue;
    const w = BIRTH_WEIGHT * Math.exp(-(c.perp * c.perp) / (2 * SIGMA_PERP_M * SIGMA_PERP_M));
    if (w > WEIGHT_DEATH) branches.push(born(c.leg, w));
  }

  // Prune to the two the design allows, but never drop the shipped leg.
  branches.sort((a, b) => b.w - a.w);
  let kept = branches.filter((b, i) => i < MAX_BRANCHES && b.w > WEIGHT_DEATH);
  if (kept.length === 0) kept = [branches[0]!];
  if (!kept.some((b) => b.leg === shipped.idx)) {
    const ship = branches.find((b) => b.leg === shipped.idx) ?? born(shipped.idx, WEIGHT_FLOOR);
    kept = kept.slice(0, MAX_BRANCHES - 1).concat(ship);
  }
  normalise(kept);
  // THE ANTI-LOCK FLOOR: while a branch is still geometrically possible it keeps
  // a voice. Every filter that lost to this problem lost by committing.
  for (const b of kept) if (isCandidate.has(b.leg) && b.w < WEIGHT_FLOOR) b.w = WEIGHT_FLOOR;
  normalise(kept);

  byBus.set(key, { branches: kept, seenAt: now, fix: here, lastStopId });
  return place(kept, shipped, stops, stopCoords);
}

function normalise(branches: Branch[]): void {
  const tot = branches.reduce((n, b) => n + b.w, 0);
  if (!(tot > 0)) {
    for (const b of branches) b.w = 1 / Math.max(1, branches.length);
    return;
  }
  for (const b of branches) b.w /= tot;
}

/**
 * Turn the belief into placements the existing pricing can consume.
 *
 * The shipped placement carries its own leg at its own mode — production's
 * standing clock and proration, untouched. Every OTHER branch is priced from
 * the belief: standing at that leg's start stop with the shipped clock (the
 * stop-pinned `at_stop_since` is a property of the bus, not of the leg), or en
 * route at the believed progress.
 */
function place(
  branches: Branch[],
  shipped: Placement,
  stops: number[],
  stopCoords: Record<number, LatLon>,
): Placement[] {
  const out: Placement[] = [];
  for (const b of branches) {
    if (b.leg === shipped.idx) {
      out.push({ ...shipped, weight: b.w });
      continue;
    }
    const len = legLengthM(b.leg, stops, stopCoords);
    const t = Math.max(0, Math.min(1, b.run.s / len));
    // An alternative branch is priced en route at its own progress. It is NOT
    // given the standing clock: `at_stop_since` names the stop the collector
    // pinned the bus at, which is the shipped branch's stop, and handing that
    // rest to a different leg would credit a layover the bus never took there.
    out.push({ idx: b.leg, standingSec: null, stallCredit: 0, progressFactor: 1 - t, weight: b.w });
  }
  const tot = out.reduce((n, p) => n + p.weight, 0);
  if (tot > 0) for (const p of out) p.weight /= tot;
  return out.length ? out : [shipped];
}

/**
 * The quantile of a Gaussian mixture, by bisection on its CDF.
 *
 * This is how a bimodal belief becomes one number without pretending to be
 * unimodal. With one component it is that component's own quantile (so the
 * shipped answer is returned exactly). With two well-separated components at
 * weight w it moves CONTINUOUSLY in w: at 50/50 it sits above the near
 * branch's upper tail rather than on either mode, and it returns to the near
 * branch as w -> 1. A belief that shifts over three polls therefore produces a
 * number that shifts over three polls, where a point anchor moves a third of a
 * lap in one.
 */
export function mixtureQuantile(
  components: ReadonlyArray<{ mu: number; sigma: number; w: number }>,
  p: number,
): number {
  const cs = components.filter((c) => c.w > 0);
  if (cs.length === 0) return 0;
  if (cs.length === 1) return cs[0]!.mu + cs[0]!.sigma * inverseNormal(p);
  const tot = cs.reduce((n, c) => n + c.w, 0);
  const F = (x: number): number =>
    cs.reduce((n, c) => n + (c.w / tot) * normalCdf((x - c.mu) / Math.max(1e-6, c.sigma)), 0);
  let lo = Math.min(...cs.map((c) => c.mu - 5 * c.sigma));
  let hi = Math.max(...cs.map((c) => c.mu + 5 * c.sigma));
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (F(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Acklam-style inverse normal, enough digits for a displayed countdown. */
function inverseNormal(p: number): number {
  if (p <= 0) return -6;
  if (p >= 1) return 6;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Diagnostics for the replays: the belief as the caller last left it. */
export function peekBelief(store: object, key: string): ReadonlyArray<{ leg: number; w: number; pStand: number; s: number }> | null {
  const b = beliefs.get(store)?.get(key);
  return b ? b.branches.map((x) => ({ leg: x.leg, w: x.w, pStand: x.pStand, s: x.run.s })) : null;
}
