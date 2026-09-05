/**
 * The bus as a distribution on the ring: an HMM forward filter over
 * (cell, mode) with the feed's deadband as the observation model.
 *
 * State per bus: mass over 2C entries — STAND at cell c, MOVE at cell c — plus
 * an OBSERVED clock and rest point: where the bus last came to rest and when
 * (the collector's `stationary_since`, seeded across restarts by #129, with
 * the client keeping its own copy under the collector's 125 m rule).
 *
 * THE OBSERVATION MODEL IS THE DEADBAND. Upstream reports a new coordinate only
 * once the vehicle has moved ~30 m (docs/eta-error-budget.md), and a cell is
 * 30 m, so:
 *
 *   repeated fix  <=>  the bus is in the same cell it was in
 *   fresh fix     <=>  the bus changed cell, and is near the new coordinate
 *
 * with the measured per-poll emissions P(repeat | standing) = 0.919 and
 * P(repeat | moving) = 0.159 (docs/eta-error-budget.md). A standing bus that
 * reports a fresh fix has departed or shuffled; the split is the collector's
 * measured departure prior, and after a layover-length stand it leans to the
 * shuffle (depot buses reposition two or three times before they leave). The
 * next polls settle it: a departure moves again, a shuffle re-freezes.
 *
 * THE STAND'S IDENTITY IS WHERE THE BUS CAME TO REST, not the cell it happens
 * to occupy: all standing mass within the rest radius of the rest point is
 * that stop's stand, priced on that stop's table with that clock, whichever
 * side of the marker the yard put the bus (the adversarial review's finding
 * 3: a bus 85 m past 344 Winchester was billed as standing at the NEXT stop
 * with the layover's clock).
 *
 * ONE OBSERVATION PER POLL. Production calls into this from every render
 * site with its own clock; stepping the filter on each of those would feed it
 * "the bus did not move" observations that never happened. A step is taken
 * only for a NEW payload object at least MIN_STEP_MS after the last; every
 * other call is a query of the stored belief.
 *
 * FORWARD-ONLY. Driving advances cells modulo C and never retreats; a
 * "backwards" proposal is a wrap of C - k, which a 5 s poll cannot do
 * (anchorGate.ts, THE RING). Mass flows along every allowed transition every
 * poll, so on a fold both branches are carried and two fresh fixes in sequence
 * separate them — the filter cannot branch-lock.
 */

import { haversineMeters, type LatLon } from "../geo";
import { hazard } from "./dist";
import { distancesTo, type Ring } from "./ring";

/** Position noise on a fresh fix, metres. Deadband-scale, deliberately not 10 m (#88's overconfidence). */
export const SIGMA_M = 20;
/** Measured per-poll emissions (docs/eta-error-budget.md, n = 39,319 / 35,576). */
export const P_REPEAT_STAND = 0.919;
export const P_REPEAT_MOVE = 0.159;
/**
 * P(repeat | moving) INSIDE a stop's zone: pulling in, pulling out, queuing
 * at the kerb. The pooled 0.159 is mostly open road; at a stop a moving bus
 * pauses a poll far more often, and calling every such pause a stand made
 * one repeat flip an arriving bus to "standing" (5.8 : 1) and a departing
 * one back. 0.5 is the collector's three-poll rule in probabilities (three
 * repeats make a shuffle); it is an estimate, not a measurement.
 */
export const P_REPEAT_MOVE_ZONE = 0.5;
/**
 * A standing bus that reports a fresh fix has moved: it has departed, or it
 * has repositioned at the kerb or in the yard. The split is the competition
 * of two rates — the stop's OWN departure hazard at the time already stood,
 * read off its stand table (dist.ts `hazard`), against a per-poll
 * reposition rate:
 *
 *     P(departure | moved) = h_j(r) dt / (h_j(r) dt + SHUFFLE_PER_POLL)
 *
 * At 344 Winchester one minute into a stand the hazard is ~0.0005/s, so a
 * move is a shuffle (P ≈ 0.08); five minutes in it is ~0.003/s (P ≈ 0.3);
 * at a kerb stop with a 30 s median it is ~0.03/s and a move is the bus
 * leaving (P ≈ 0.9) — which is the pooled 0.76 of
 * departure.ts DEPARTURE_PRIOR_BY_STEPS[1] recovered from the tables rather
 * than assumed. The rate: "nearly every 344 Winchester visit repositions two
 * or three times" over a ~5 min stand (docs/departure-derivation.md), i.e.
 * ~0.04 per 5 s poll at a depot; kerb stops shuffle less. 0.03 is the
 * estimate; P_DEPART_ON_FRESH is the fallback where a stop has no table.
 */
export const SHUFFLE_PER_POLL = 0.03;
export const P_DEPART_ON_FRESH = 0.76;
/** Off-stop run -> stand hazard per second (a light, a queue). docs/eta-error-budget.md. */
export const HOLD_ENTER_PER_S = 0.01612;
/** Off-stop stand -> run hazard per second. */
export const HOLD_LEAVE_PER_S = 0.01457;
/** Leak from a stop stand on a repeat poll, per second — a pooled 4 min stand. Pricing uses the real table. */
export const STOP_LEAVE_PER_S = 1 / 240;
/**
 * The mixture weight of the OFF-ROUTE component in the emission, relative to
 * a fix on the cell: a detour, a yard, a street the published line does not
 * draw (Red #316 on 2026-09-03 ran from College / Wall straight up to
 * Trumbull / Hillhouse, 100+ m off the line for three polls). Without it the
 * belief teleported to the nearest cells on the line — the inbound branch —
 * direction unread. With it, a bus off the line keeps the branch it had
 * until the evidence for another branch has accumulated over polls through
 * TELEPORT below. Estimate: ~3% of fixes are > 500 m off every route
 * (gps-replay `offRoute`), more are a street away.
 */
export const P_OFF_ROUTE = 0.02;
/**
 * Mass moved to every cell each poll, uniformly: how a bus that really has
 * relocated (an id reissue, a feed gap, a genuine branch error) is found
 * again. 1e-4 spread over ~300 cells is 3e-7 per cell per poll; against a
 * held branch whose cells score P_OFF_ROUTE it takes several consistent
 * polls to win, and a single stray fix cannot.
 */
export const TELEPORT = 1e-4;
/** Cells below this mass are not propagated through the kernel (they are re-seeded by TELEPORT). */
const PROPAGATE_MIN = 1e-6;
/**
 * A fresh fix within this distance of the rest point is a shuffle, not a
 * move, and all standing mass within it is the rest stop's stand
 * (detector.ts STATIONARY_RADIUS_M, the rule the served clock follows).
 */
export const REST_RADIUS_M = 125;
/** A belief older than this is re-initialised from the fix. Long: a stale prior costs nothing, the emission re-anchors. */
export const BELIEF_STALE_MS = 600_000;
/** Two calls closer than this are the same poll: the second is a query, not an observation. */
export const MIN_STEP_MS = 2_500;
/** The lead leg switches only when another leg holds this much mass. */
export const LEAD_SWITCH_MASS = 0.8;
/** A candidate this many legs ahead of the lead is the bus driving on, not an alternative. */
export const LEAD_FOLLOW_LEGS = 2;
/** A lead held against a posterior behind it for this long is released (anchorGate.ts ANCHOR_MAX_HOLD_MS). */
export const LEAD_MAX_HOLD_MS = 300_000;
/** A bus is called standing on init when the server clock is at least this old. */
const STANDING_MIN_S = 15;
/** Shape of the gamma over cells advanced per poll (CV 0.58). */
const KERNEL_SHAPE = 3;

export interface Belief {
  ringKey: string;
  /** [0, C) STAND, [C, 2C) MOVE. Sums to 1. */
  p: Float64Array;
  seenAt: number;
  /** The payload object last observed (identity only): a second call with the same object is a query. */
  lastObs: object | null;
  lastFix: LatLon | null;
  /** Client-side clock: when `lastFix` was first reported (ms). */
  fixAt: number;
  /** Where the bus came to rest and when (the collector's rule); the server clock overrides `restSince` when served. */
  restPoint: LatLon;
  restSince: number;
  /**
   * True once a repeated fix (or the server clock) has shown the bus at rest
   * at `restPoint`; until then the point is just where a moving bus last was,
   * and no stand is attributed to it.
   */
  rested: boolean;
  /**
   * The stop this stand belongs to: the zone holding most of the standing
   * mass when the rest was established (nearStop, else approachOf), or -1.
   * Chosen from the BELIEF, not from geometry alone, so a rest beside two
   * twin stops (130 Prospect (N)/(S), 28 m apart) lands on the branch the bus
   * is on.
   */
  restStop: number;
  /** True when `restStop` came from the approach zone rather than the stop's own. */
  restApproach: boolean;
  /** Cells within REST_RADIUS_M of the rest point (1) — the stand's extent. */
  restMask: Uint8Array;
  /** Server clock origin (ms) when served, else null. */
  serverSince: number | null;
  lastStopId: number | null;
  /** The leg the screen shows the bus on (hysteresis, see `leadLeg`). -1 before the first step. */
  lead: number;
  /** When the mass first left `lead` for a leg BEHIND it, else null (see `leadLeg`). */
  leadDisagreeSince: number | null;
  /** True when this step saw a fresh fix. */
  fresh: boolean;
  /** Per cell: the anchor leg of standing mass (`anchorLeg(.., true)`), cached once per step. */
  standLeg: Int32Array;
  /** Per cell: the standing zone key (stop, 1000 + stop for its approach, -1), cached once per step. */
  zoneKey: Int32Array;
}

export interface FilterBus {
  lat: number;
  lon: number;
  last_stop_id?: number | null | undefined;
  at_stop_since?: string | null | undefined;
  stationary_since?: string | null | undefined;
}

function serverClockMs(bus: FilterBus): number | null {
  const s = bus.stationary_since ?? bus.at_stop_since;
  if (!s) return null;
  const t = new Date(s.endsWith("Z") ? s : s + "Z").getTime();
  return Number.isFinite(t) ? t : null;
}

/** Seconds the bus has been standing, on the clock the stand tables were measured with. */
export function standingSec(b: Belief, now: number): number {
  return Math.max(0, (now - clockOrigin(b)) / 1000);
}

/** The origin of that clock, for callers that key on it. */
export function clockOrigin(b: Belief): number {
  return b.serverSince ?? b.restSince;
}

// -- the move kernel -------------------------------------------------------------

const kernelCache = new Map<number, Float64Array>();

/**
 * P(advance = k cells | moving), k = 1..K: a discretised gamma (shape 3)
 * with the given mean in cells, K = its far tail. Cached per 0.1 cell of mean.
 */
export function moveKernel(meanCells: number): Float64Array {
  const mean = Math.max(0.5, Math.min(40, meanCells));
  const key = Math.round(mean * 10);
  const hit = kernelCache.get(key);
  if (hit) return hit;
  const K = Math.min(60, Math.ceil(mean * 3 + 3));
  const scale = mean / KERNEL_SHAPE;
  const k = new Float64Array(K + 1);
  let sum = 0;
  for (let j = 1; j <= K; j++) {
    const pdf = Math.pow(j, KERNEL_SHAPE - 1) * Math.exp(-j / scale);
    k[j] = pdf;
    sum += pdf;
  }
  for (let j = 1; j <= K; j++) k[j] = k[j]! / sum;
  kernelCache.set(key, k);
  return k;
}

/** A departure's first step: one cell mostly, two sometimes (forward). */
const DEPART_KERNEL = [0, 0.7, 0.3];
/**
 * A shuffle's displacement, in cells, EITHER WAY: a bus repositioning in a
 * yard is not travelling the route, and at 344 Winchester it backs up as
 * often as it creeps forward (departure-derivation.md: two or three shuffles
 * per visit). Reach: up to four cells (120 m), the rest radius.
 */
const SHUFFLE_KERNEL: ReadonlyArray<readonly [number, number]> = [
  [-4, 0.05], [-3, 0.08], [-2, 0.12], [-1, 0.25], [1, 0.25], [2, 0.12], [3, 0.08], [4, 0.05],
];

// -- last_stop_id as a likelihood -----------------------------------------------

/**
 * P(last_stop_id offset | the bus is on leg `leg`), offset = leg - idx(last_stop_id)
 * mod N. From priors.ts: `last_stop_id` is the last stop PASSED, with 60-75% of
 * its mass on {nearest - 1, nearest} and a long tail both ways. Applied
 * tempered (square root), only on the poll the reading changes, never obeyed.
 * A stop that occurs twice in the sequence (routes 9 and 10) gets the best of
 * its occurrences.
 */
function lastStopLikelihood(offset: number, N: number): number {
  if (offset === 0) return 0.5;
  if (offset === 1) return 0.14;
  if (offset === N - 1) return 0.12;
  if (offset === 2) return 0.06;
  if (offset === 3) return 0.04;
  return 0.14 / Math.max(1, N - 5);
}

// -- the step --------------------------------------------------------------------

function restMaskFor(ring: Ring, point: LatLon): Uint8Array {
  const d = distancesTo(ring, point);
  const mask = new Uint8Array(ring.C);
  for (let c = 0; c < ring.C; c++) if (d[c]! <= REST_RADIUS_M) mask[c] = 1;
  return mask;
}

/** The zone (stop, approach) holding most of the standing mass inside the rest mask. */
function restStopFromBelief(ring: Ring, p: Float64Array, mask: Uint8Array): { restStop: number; restApproach: boolean } {
  const byZone = new Map<number, number>();
  for (let c = 0; c < ring.C; c++) {
    if (mask[c] !== 1 || p[c]! <= 0) continue;
    const zk = ring.nearStop[c]! >= 0 ? ring.nearStop[c]! : ring.approachOf[c]! >= 0 ? 1000 + ring.approachOf[c]! : -1;
    if (zk < 0) continue;
    byZone.set(zk, (byZone.get(zk) ?? 0) + p[c]!);
  }
  let best = -1, bestMass = 0;
  for (const [zk, m] of byZone) if (m > bestMass) { bestMass = m; best = zk; }
  if (best < 0) return { restStop: -1, restApproach: false };
  return best >= 1000 ? { restStop: best - 1000, restApproach: true } : { restStop: best, restApproach: false };
}

function initBelief(ring: Ring, bus: FilterBus, now: number, stops: readonly number[]): Belief {
  const C = ring.C;
  const p = new Float64Array(2 * C);
  const d = distancesTo(ring, bus);
  const since = serverClockMs(bus);
  const age = since === null ? 0 : (now - since) / 1000;
  const standing = since !== null && age >= STANDING_MIN_S;
  const pStand = standing ? 0.9 : 0.3;
  // No off-route floor on a cold start: there is no prior for it to protect,
  // and a flat weight over three hundred cells would outweigh the fix itself.
  for (let c = 0; c < C; c++) {
    const e = Math.exp(-(d[c]! * d[c]!) / (2 * SIGMA_M * SIGMA_M)) + 1e-9;
    p[c] = e * pStand;
    p[C + c] = e * (1 - pStand);
  }
  const restMask = restMaskFor(ring, bus);
  const b: Belief = {
    ringKey: ring.key, p, seenAt: now, lastObs: bus, lastFix: { lat: bus.lat, lon: bus.lon },
    fixAt: now, restPoint: { lat: bus.lat, lon: bus.lon }, restSince: now,
    rested: standing, restStop: -1, restApproach: false, restMask,
    serverSince: since, lastStopId: null, lead: -1, leadDisagreeSince: null, fresh: true,
    standLeg: new Int32Array(C), zoneKey: new Int32Array(C),
  };
  applyLastStop(b, ring, bus, stops);
  normalise(b.p);
  if (standing) Object.assign(b, restStopFromBelief(ring, b.p, restMask));
  cacheZones(b, ring);
  b.lead = leadLeg(b, ring, -1, now, b);
  return b;
}

function applyLastStop(b: Belief, ring: Ring, bus: FilterBus, stops: readonly number[]): void {
  const lsid = bus.last_stop_id ?? null;
  if (lsid === null || lsid === b.lastStopId) return;
  b.lastStopId = lsid;
  const N = ring.N, C = ring.C;
  const occurrences: number[] = [];
  for (let i = 0; i < N; i++) if (stops[i] === lsid) occurrences.push(i);
  if (occurrences.length === 0) return;
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let best = 0;
    for (const lastIdx of occurrences) best = Math.max(best, lastStopLikelihood(((i - lastIdx) % N + N) % N, N));
    w[i] = Math.sqrt(best);
  }
  for (let c = 0; c < C; c++) {
    const f = w[ring.leg[c]!]!;
    b.p[c] = b.p[c]! * f;
    b.p[C + c] = b.p[C + c]! * f;
  }
}

/** Fill the per-cell caches from the rest state; call after the rest fields are final. */
function cacheZones(b: Belief, ring: Ring): void {
  for (let c = 0; c < ring.C; c++) {
    const z = standZone(b, ring, c);
    b.zoneKey[c] = z.stop < 0 ? -1 : z.approach ? 1000 + z.stop : z.stop;
    b.standLeg[c] = z.stop >= 0 && !z.approach ? z.stop : ring.leg[c]!;
  }
}

function normalise(p: Float64Array): void {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += p[i]!;
  if (s <= 0) { p.fill(1 / p.length); return; }
  for (let i = 0; i < p.length; i++) p[i] = p[i]! / s;
}

/**
 * The stop a standing cell belongs to: the rest stop for every cell within
 * the rest radius, else the cell's own zone, else -1.
 */
export function standZone(b: Belief, ring: Ring, c: number): { stop: number; approach: boolean } {
  const near = ring.nearStop[c]!;
  const inRest = b.rested && b.restStop >= 0 && b.restMask[c] === 1;
  // A cell at another stop's kerb is that stop's, even inside the rest
  // radius: a bus that has left 344 Winchester and reached Winchester /
  // Division (112 m on) is at Winchester / Division.
  if (near >= 0 && !(inRest && near === b.restStop)) return { stop: near, approach: false };
  if (inRest) return { stop: b.restStop, approach: b.restApproach };
  if (near >= 0) return { stop: near, approach: false };
  if (ring.approachOf[c]! >= 0) return { stop: ring.approachOf[c]!, approach: true };
  return { stop: -1, approach: false };
}

/**
 * The leg an ETA walks from, per cell and mode: a bus STANDING in a stop's
 * zone is at that stop, whichever side of the marker its cell is on; a
 * moving bus is on its cell's leg.
 */
export function anchorLeg(b: Belief, ring: Ring, c: number, standing: boolean): number {
  return standing ? b.standLeg[c]! : ring.leg[c]!;
}

/** Mass per anchor leg, for the lead and for the fold hysteresis. */
export function legMass(b: Belief, ring: Ring): Float64Array {
  const m = new Float64Array(ring.N);
  const C = ring.C;
  const p = b.p, sl = b.standLeg, lg = ring.leg;
  for (let c = 0; c < C; c++) {
    m[sl[c]!] = m[sl[c]!]! + p[c]!;
    m[lg[c]!] = m[lg[c]!]! + p[C + c]!;
  }
  return m;
}

/**
 * The leg the screen shows the bus on.
 *
 * Argmax of leg mass, with hysteresis only where it is needed:
 *
 *  - a candidate a leg or two AHEAD of the lead is the bus driving on, and the
 *    lead follows it one leg at a time once the mass has clearly crossed the
 *    stop (LEAD_SWITCH_MASS beyond it): a row for that stop flips to "next
 *    lap" on this switch, a 25-minute jump, so a bus a cell short of the
 *    marker must not trigger it;
 *  - a candidate far ahead (a fold's other branch, a lap) must carry
 *    LEAD_SWITCH_MASS first — what stops the number racing across the gap as
 *    a branch weight passes 0.5 (#88);
 *  - a candidate BEHIND is a wrap of N - k legs, which a bus cannot do
 *    (anchorGate.ts, THE RING), so the lead holds; released only after
 *    LEAD_MAX_HOLD_MS of sustained disagreement, the gate's own rule for a
 *    lead that was simply wrong. A yard reverse never lands here: standing
 *    mass within the rest radius belongs to the rest stop's leg.
 */
export function leadLeg(b: Belief, ring: Ring, prev: number, now: number, state?: { leadDisagreeSince: number | null }): number {
  const m = legMass(b, ring);
  const N = ring.N;
  let best = 0;
  for (let i = 1; i < N; i++) if (m[i]! > m[best]!) best = i;
  if (prev < 0 || prev >= N) return best;
  if (best === prev) { if (state) state.leadDisagreeSince = null; return prev; }
  const ahead = ((best - prev) % N + N) % N;
  if (ahead >= 1 && ahead <= LEAD_FOLLOW_LEGS) {
    if (state) state.leadDisagreeSince = null;
    const next = (prev + 1) % N;
    return 1 - m[prev]! >= LEAD_SWITCH_MASS ? next : prev;
  }
  if (ahead <= N / 2) {
    if (state) state.leadDisagreeSince = null;
    return m[best]! >= LEAD_SWITCH_MASS ? best : prev;
  }
  if (m[best]! < LEAD_SWITCH_MASS) { if (state) state.leadDisagreeSince = null; return prev; }
  if (!state) return prev;
  if (state.leadDisagreeSince === null) { state.leadDisagreeSince = now; return prev; }
  if (now - state.leadDisagreeSince >= LEAD_MAX_HOLD_MS) { state.leadDisagreeSince = null; return best; }
  return prev;
}

/**
 * One observation. A call with the payload object already observed, or
 * within MIN_STEP_MS of the last step, or with a clock behind the last step,
 * is a QUERY: the stored belief is returned untouched.
 */
export function stepBelief(
  prev: Belief | undefined,
  ring: Ring,
  bus: FilterBus,
  now: number,
  stops: readonly number[],
): Belief {
  if (!bus.lat || !bus.lon) return prev && prev.ringKey === ring.key ? prev : initBelief(ring, bus, now, stops);
  if (!prev || prev.ringKey !== ring.key || now - prev.seenAt > BELIEF_STALE_MS) {
    return initBelief(ring, bus, now, stops);
  }
  if (prev.lastObs === bus || now - prev.seenAt < MIN_STEP_MS) return prev;

  const C = ring.C;
  const dt = Math.max(1, Math.min(60, (now - prev.seenAt) / 1000));
  const fresh = prev.lastFix === null || prev.lastFix.lat !== bus.lat || prev.lastFix.lon !== bus.lon;
  const q = new Float64Array(2 * C);
  const p = prev.p;
  const hIn = Math.min(0.5, HOLD_ENTER_PER_S * dt);
  const cellM = ring.loopM / ring.C;

  if (fresh) {
    // The joint of transition and the mode's own likelihood for "the fix
    // changed": P(fresh | standing) = 1 - P_REPEAT_STAND, P(fresh | moving)
    // = 1 - P_REPEAT_MOVE. Without the first factor a single crawl repeat
    // left a standing ghost that fresh fixes never cancelled (review, 9).
    const stood = prev.rested ? standingSec(prev, prev.seenAt) : 0;
    const shufflePoll = SHUFFLE_PER_POLL * (dt / 5);
    const fromStand = 1 - P_REPEAT_STAND;
    const departKern = Float64Array.from(DEPART_KERNEL);
    for (let c = 0; c < C; c++) {
      const inZone = ring.nearStop[c]! >= 0 || ring.approachOf[c]! >= 0 || (prev.rested && prev.restMask[c] === 1);
      const fromMove = 1 - (inZone ? P_REPEAT_MOVE_ZONE : P_REPEAT_MOVE);
      const mStand = p[c]! * fromStand, mMove = p[C + c]! * fromMove;
      if (mStand + mMove < PROPAGATE_MIN) continue;
      if (mStand > 1e-12) {
        // The first step off a stand is 30-35 m whether it is a departure or
        // a shuffle (departure-derivation.md: "first step 30-35 m in both");
        // only the MODE differs, and the split is the measured prior.
        // Shuffles happen where the bus rests — within the rest radius, or at
        // a kerb — and nowhere else: allowed mid-leg, a "standing bus
        // shuffling backwards" tracked an off-route bus creeping the wrong way
        // along the inbound branch of a shared road (Red #316, 9/3).
        const canShuffle = (prev.rested && prev.restMask[c] === 1) || ring.nearStop[c]! >= 0 || ring.approachOf[c]! >= 0;
        let pDepart = 1;
        if (canShuffle) {
          const z = standZone(prev, ring, c);
          const table = z.stop >= 0 ? ring.stand[z.stop] : null;
          if (table) {
            const hd = hazard(table, stood) * dt;
            pDepart = hd / (hd + shufflePoll);
          } else {
            pDepart = P_DEPART_ON_FRESH;
          }
        }
        // Through `advance`, so a first step that lands ON a stop cell is
        // captured as an arrival there (an arriving bus that paused 40 m
        // short of the marker read as departing when this landed directly).
        advance(q, ring, c, mStand * pDepart, departKern, hIn);
        if (canShuffle) {
          for (const [dj, w] of SHUFFLE_KERNEL) {
            const x = ((c + dj) % C + C) % C;
            q[x] = q[x]! + mStand * (1 - pDepart) * w;
          }
        }
      }
      if (mMove > 1e-12) {
        const kern = moveKernel((ring.legSpeed[ring.leg[c]!]! * dt) / cellM);
        advance(q, ring, c, mMove, kern, hIn);
      }
    }
    // Teleport, then the position emission as a mixture of "on this cell"
    // and "off the line".
    const tp = TELEPORT / (2 * C);
    for (let i = 0; i < 2 * C; i++) q[i] = q[i]! * (1 - TELEPORT) + tp;
    const d = distancesTo(ring, bus);
    for (let c = 0; c < C; c++) {
      const e = Math.exp(-(d[c]! * d[c]!) / (2 * SIGMA_M * SIGMA_M)) + P_OFF_ROUTE;
      q[c] = q[c]! * e;
      q[C + c] = q[C + c]! * e;
    }
  } else {
    // Same cell. A standing bus stays (P_REPEAT_STAND); a moving bus crawled
    // or came to a hold (P_REPEAT_MOVE, split between the two). Mass that
    // "would have moved on" is inconsistent with the observation and drops.
    for (let c = 0; c < C; c++) {
      const mStand = p[c]!, mMove = p[C + c]!;
      const atStop = ring.nearStop[c]! >= 0 || ring.approachOf[c]! >= 0 || (prev.rested && prev.restMask[c] === 1);
      const hLeave = Math.min(0.5, (atStop ? STOP_LEAVE_PER_S : HOLD_LEAVE_PER_S) * dt);
      const stay = mStand * P_REPEAT_STAND;
      const leak = stay * hLeave;
      const movedRepeat = mMove * (atStop ? P_REPEAT_MOVE_ZONE : P_REPEAT_MOVE);
      q[c] = q[c]! + stay - leak + movedRepeat * hIn;
      q[C + c] = q[C + c]! + leak + movedRepeat * (1 - hIn);
    }
  }

  const moved = fresh && haversineMeters(prev.restPoint, bus) > REST_RADIUS_M;
  const since = serverClockMs(bus);
  const b: Belief = {
    ringKey: ring.key, p: q, seenAt: now, lastObs: bus,
    lastFix: fresh ? { lat: bus.lat, lon: bus.lon } : prev.lastFix,
    fixAt: fresh ? now : prev.fixAt,
    restPoint: moved ? { lat: bus.lat, lon: bus.lon } : prev.restPoint,
    restSince: moved ? now : prev.restSince,
    rested: moved ? false : prev.rested,
    restStop: moved ? -1 : prev.restStop,
    restApproach: moved ? false : prev.restApproach,
    restMask: moved ? restMaskFor(ring, bus) : prev.restMask,
    serverSince: since,
    lastStopId: prev.lastStopId, lead: prev.lead, leadDisagreeSince: prev.leadDisagreeSince, fresh,
    standLeg: moved ? new Int32Array(C) : prev.standLeg, zoneKey: moved ? new Int32Array(C) : prev.zoneKey,
  };
  applyLastStop(b, ring, bus, stops);
  normalise(b.p);
  // The rest is established by a repeated fix (or a server clock already
  // running), and its stop is read off the belief at that moment.
  let restChanged = moved;
  if (!b.rested && (!fresh || (since !== null && (now - since) / 1000 >= STANDING_MIN_S))) {
    b.rested = true;
    Object.assign(b, restStopFromBelief(ring, b.p, b.restMask));
    restChanged = true;
  }
  if (restChanged) {
    if (b.standLeg === prev.standLeg) { b.standLeg = new Int32Array(C); b.zoneKey = new Int32Array(C); }
    cacheZones(b, ring);
  }
  b.lead = leadLeg(b, ring, prev.lead, now, b);
  return b;
}

/**
 * Move mass `m` from cell c forward by the kernel. Passing a stop cell, a
 * fraction pStop of the mass reaching it stops there (STAND at the stop);
 * mass landing anywhere comes to a hold with probability hIn.
 */
function advance(q: Float64Array, ring: Ring, c: number, m: number, kern: Float64Array, hIn: number): void {
  const C = ring.C;
  const K = kern.length - 1;
  let S = 1; // P(advance >= j)
  let flow = m;
  for (let j = 1; j <= K; j++) {
    if (flow <= 1e-12) break;
    const x = (c + j) % C;
    if (ring.frac[x] === 0) { // the cell ON a stop
      const ps = ring.pStop[ring.leg[x]!]!;
      q[x] = q[x]! + flow * ps;
      flow *= 1 - ps;
    }
    const endHere = S > 0 ? Math.min(1, kern[j]! / S) : 1;
    const landed = flow * endHere;
    q[x] = q[x]! + landed * hIn;
    q[C + x] = q[C + x]! + landed * (1 - hIn);
    flow -= landed;
    S -= kern[j]!;
  }
  if (flow > 1e-12) {
    const x = (c + K) % C;
    q[C + x] = q[C + x]! + flow;
  }
}

/**
 * Situations: the posterior collapsed to (anchor leg, mode) with the
 * mass-weighted mean position within the leg, dropping anything under
 * `minMass`.
 */
export interface Situation {
  leg: number;
  standing: boolean;
  mass: number;
  /** Mass-weighted mean leg fraction (of the CELL's leg, for the drive left). */
  frac: number;
  /** For a standing situation: the stop whose stand this is, else -1. */
  zoneStop: number;
  /** True when that zone is the approach zone SHORT of `zoneStop`, not the stop itself. */
  approach: boolean;
  /** Mass-weighted mean cell, for diagnostics. */
  cell: number;
}

export function situations(b: Belief, ring: Ring, minMass = 0.01): Situation[] {
  const C = ring.C, N = ring.N;
  // Accumulators indexed by (anchor leg * 2 + mode); zone tallies per key.
  const mass = new Float64Array(2 * N), frac = new Float64Array(2 * N), cell = new Float64Array(2 * N);
  const zoneMass = new Map<number, number>();
  const p = b.p;
  for (let c = 0; c < C; c++) {
    const ms = p[c]!, mm = p[C + c]!;
    if (ms > 0) {
      const k = b.standLeg[c]! * 2;
      mass[k] = mass[k]! + ms; frac[k] = frac[k]! + ms * ring.frac[c]!; cell[k] = cell[k]! + ms * c;
      const zk = k * 4096 + (b.zoneKey[c]! + 1);
      zoneMass.set(zk, (zoneMass.get(zk) ?? 0) + ms);
    }
    if (mm > 0) {
      const k = ring.leg[c]! * 2 + 1;
      mass[k] = mass[k]! + mm; frac[k] = frac[k]! + mm * ring.frac[c]!; cell[k] = cell[k]! + mm * c;
    }
  }
  const out: Situation[] = [];
  let total = 0;
  for (let k = 0; k < 2 * N; k++) {
    const m = mass[k]!;
    if (m < minMass) continue;
    let zoneKey = -1, best = 0;
    if (k % 2 === 0) {
      for (const [zk, zm] of zoneMass) {
        if (Math.floor(zk / 4096) !== k) continue;
        if (zm > best) { best = zm; zoneKey = (zk % 4096) - 1; }
      }
    }
    out.push({
      leg: k >> 1, standing: k % 2 === 0, mass: m,
      frac: frac[k]! / m,
      zoneStop: zoneKey >= 1000 ? zoneKey - 1000 : zoneKey,
      approach: zoneKey >= 1000,
      cell: cell[k]! / m,
    });
    total += m;
  }
  for (const s of out) s.mass /= total || 1;
  out.sort((x, y) => y.mass - x.mass);
  return out;
}
