/**
 * The bus as a distribution on the ring: an HMM forward filter over
 * (cell, mode) with the feed's deadband as the observation model.
 *
 * State per bus: mass over 2C entries — STAND at cell c, MOVE at cell c — plus
 * an OBSERVED clock: seconds since the fix last changed (the collector's
 * `stationary_since`, seeded across restarts by #129; the client keeps its own
 * copy for buses the server has not clocked).
 *
 * THE OBSERVATION MODEL IS THE DEADBAND. Upstream reports a new coordinate only
 * once the vehicle has moved ~30 m (docs/eta-error-budget.md), and a cell is
 * 30 m, so:
 *
 *   repeated fix  <=>  the bus is in the same cell it was in
 *   fresh fix     <=>  the bus changed cell, and is near the new coordinate
 *
 * That is exact on the grid, and it is the whole reason a filter works on this
 * feed where EMA and a constant-velocity Kalman were measured to fail: on a
 * repeated fix nothing here moves the bus, because nothing was observed; on a
 * fresh fix the mass MUST move, because the bus did. A standing bus that
 * reports a fresh fix has either departed or shuffled, and the split between
 * those two — 0.76 : 0.24 — is the collector's own measured departure prior
 * (`DEPARTURE_PRIOR_BY_STEPS[1]`, departure.ts). The next poll settles it: a
 * shuffle re-freezes (STAND wins the repeat), a departure moves again.
 *
 * TABLE-FREE ON PURPOSE. The filter reads geometry and the feed, never the
 * calibration tables, so `resolveAnchorIndex` (liveAnchor.ts) can run the same
 * step with the arguments it already has and every render site sees one
 * answer per bus per poll. The stand tables enter at PRICING (arrival.ts),
 * where the elapsed clock conditions the remaining stand. The per-stop
 * departure hazard would only change the tiny leak from STAND on a repeat
 * poll, which the repeat emission pulls straight back.
 *
 * FORWARD-ONLY. The transition advances cells modulo C and never retreats; a
 * "backwards" proposal is a wrap of C - k, which a 5 s poll cannot do
 * (anchorGate.ts, THE RING). Mass flows along every allowed transition every
 * poll, so on a fold both branches are carried and two fresh fixes in sequence
 * separate them — the filter cannot branch-lock.
 */

import { haversineMeters, type LatLon } from "../geo";
import { distancesTo, type Ring } from "./ring";

/** Position noise on a fresh fix, metres. Deadband-scale, deliberately not 10 m (#88's overconfidence). */
export const SIGMA_M = 20;
/** P(departure | first fresh fix after a stand) — departure.ts DEPARTURE_PRIOR_BY_STEPS[1], pooled over every stop. */
export const P_DEPART_ON_FRESH = 0.76;
/**
 * The same after a LAYOVER-length stand. The pooled 0.76 is mostly ordinary
 * stops, where a 30 m step is the bus leaving. A bus that has stood two
 * minutes or more is on a layover, and layovers are where the yards are:
 * "nearly every 344 Winchester visit repositions two or three times before
 * it leaves" (docs/departure-derivation.md), and on 2026-09-03 #304 pulled
 * out, reversed 85 m into the yard, sat a minute and then left — priced as a
 * departure at 0.76 it read "<1 min" at Winchester / Division and then
 * climbed back to two. One reposition in three is a departure, so the first
 * step off a long stand carries 0.35; consecutive fresh fixes compound it
 * (0.58, 0.72 ...), which is the collector's own confirmation distance
 * (DEPART_FAR_M, ~150 m) in probabilities.
 */
export const P_DEPART_AFTER_LAYOVER = 0.35;
/** A stand at least this long is a layover for the purpose above (tables.ts LAYOVER_MIN_SEC). */
export const LAYOVER_STAND_SEC = 120;
/** Off-stop run -> stand hazard per second (a light, a queue). docs/eta-error-budget.md. */
export const HOLD_ENTER_PER_S = 0.01612;
/** Off-stop stand -> run hazard per second. */
export const HOLD_LEAVE_PER_S = 0.01457;
/** Leak from a stop stand on a repeat poll, per second — a pooled 4 min stand. Pricing uses the real table. */
export const STOP_LEAVE_PER_S = 1 / 240;
/** P(a moving bus stays in its cell over a poll) — the slow tail of P(frozen | running) = 0.16, net of holds. */
export const P_CRAWL = 0.10;
/**
 * The same, for a moving bus inside a stop's zone: pulling out, pulling in,
 * queuing at the kerb. One repeated fix right after a departure is not a
 * shuffle; the collector's own rule needs three (`departure.ts`). At 0.5 a
 * single repeat leaves the departure share at 0.6 and three repeats call it
 * a shuffle, which is that rule in probabilities.
 */
export const P_CRAWL_ZONE = 0.5;
/**
 * The emission's floor: the likelihood of a fix for a cell far from it. Not
 * a numerical nicety but the OFF-ROUTE probability — a detour, a yard, a
 * street the published line does not draw (Red #316 on 2026-09-03 ran from
 * College / Wall straight up to Trumbull / Hillhouse, 100+ m off the line for
 * three polls). With a floor of 1e-9 the belief teleported to the nearest
 * cells on the line, which were the inbound branch, direction unread. At 0.02
 * a bus off the line keeps the branch it had — its cells are all "far", but
 * equally far — until the evidence for another branch has accumulated over
 * polls through TELEPORT below.
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
/** P(stops | pass) pooled over every stop; the per-stop value enters at pricing. */
export const P_STOP = 0.877;
/** Typical driving speed for the transition kernel, m/s (measured p50 6.6-7.1 downtown). */
export const DRIVE_M_S = 7;
/** Longest advance the kernel allows in one poll, cells. */
export const MAX_ADVANCE = 8;
/**
 * A belief older than this is re-initialised from the fix. Long on purpose:
 * a stale prior costs nothing, because the emission floor lets a fix far from
 * every cell that holds mass re-anchor the bus in one poll, while a re-init
 * throws away the history that tells a yard shuffle from a departure.
 */
export const BELIEF_STALE_MS = 600_000;
/** The lead leg switches only when another leg holds this much mass. */
export const LEAD_SWITCH_MASS = 0.8;
/** A bus is called standing on init when the server clock is at least this old. */
const STANDING_MIN_S = 15;

export interface Belief {
  ringKey: string;
  /** [0, C) STAND, [C, 2C) MOVE. Sums to 1. */
  p: Float64Array;
  seenAt: number;
  lastFix: LatLon | null;
  /** Client-side clock: when `lastFix` was first reported (ms). */
  fixAt: number;
  /**
   * The client's own rest clock, the collector's rule (`STATIONARY_RADIUS_M`,
   * detector.ts): where the bus came to rest and when; a fresh fix within
   * REST_RADIUS_M of that point is a shuffle and keeps the clock. Used when
   * the server sends no clock.
   */
  restPoint: LatLon;
  restSince: number;
  /** Server clock origin (ms) when served, else null. */
  serverSince: number | null;
  lastStopId: number | null;
  /** The leg the screen shows the bus on (hysteresis, see `leadLeg`). -1 before the first step. */
  lead: number;
  /** When the mass first left `lead` for a leg BEHIND it, else null (see `leadLeg`). */
  leadDisagreeSince: number | null;
  /** True when this step saw a fresh fix. */
  fresh: boolean;
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

/** A fresh fix within this distance of the rest point is a shuffle, not a move (detector.ts STATIONARY_RADIUS_M). */
export const REST_RADIUS_M = 125;

/** Seconds the bus has been standing, on the clock the stand tables were measured with. */
export function standingSec(b: Belief, now: number): number {
  const origin = b.serverSince ?? b.restSince;
  return Math.max(0, (now - origin) / 1000);
}

/** The origin of that clock, for callers that key on it. */
export function clockOrigin(b: Belief): number {
  return b.serverSince ?? b.restSince;
}

// -- the move kernel -------------------------------------------------------------

const kernelCache = new Map<number, Float64Array>();

/**
 * P(advance = k cells | moving, dt), k = 1..MAX_ADVANCE: a discretised gamma
 * (shape 3) with mean DRIVE_M_S * dt / CELL_M. Cached per whole second of dt.
 */
export function moveKernel(dtSec: number, cellM: number): Float64Array {
  const key = Math.round(dtSec) * 1000 + Math.round(cellM);
  const hit = kernelCache.get(key);
  if (hit) return hit;
  const mean = Math.max(0.5, (DRIVE_M_S * dtSec) / cellM);
  const shape = 3;
  const scale = mean / shape;
  const k = new Float64Array(MAX_ADVANCE + 1);
  let sum = 0;
  for (let j = 1; j <= MAX_ADVANCE; j++) {
    const x = j;
    const pdf = Math.pow(x, shape - 1) * Math.exp(-x / scale);
    k[j] = pdf;
    sum += pdf;
  }
  for (let j = 1; j <= MAX_ADVANCE; j++) k[j] = k[j]! / sum;
  kernelCache.set(key, k);
  return k;
}

/** A departure's first step: one cell mostly, two sometimes (forward). */
const DEPART_KERNEL = [0, 0.7, 0.3];
/**
 * A shuffle's displacement, in cells, EITHER WAY: a bus repositioning in a
 * yard is not travelling the route, and at 344 Winchester it backs up as
 * often as it creeps forward (departure-derivation.md: two or three shuffles
 * per visit). The ring's forward-only rule is about progress; this is not
 * progress, and the pricing does not care which side of the marker the bus
 * rests on (arrival.ts: a stand in the stop's zone is the stand).
 */
const SHUFFLE_KERNEL: ReadonlyArray<readonly [number, number]> = [[-2, 0.15], [-1, 0.35], [1, 0.35], [2, 0.15]];

// -- last_stop_id as a likelihood -----------------------------------------------

/**
 * P(last_stop_id offset | the bus is on leg `leg`), offset = leg - idx(last_stop_id)
 * mod N. From priors.ts: `last_stop_id` is the last stop PASSED, with 60-75% of
 * its mass on {nearest - 1, nearest} and a long tail both ways. Applied
 * tempered (square root), only on the poll the reading changes, never obeyed.
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

function initBelief(ring: Ring, bus: FilterBus, now: number, stops: readonly number[]): Belief {
  const C = ring.C;
  const p = new Float64Array(2 * C);
  const d = distancesTo(ring, bus);
  const since = serverClockMs(bus);
  const age = since === null ? 0 : (now - since) / 1000;
  const standing = since !== null && age >= STANDING_MIN_S;
  const pStand = standing ? 0.9 : 0.3;
  // No off-route floor on a cold start: there is no prior for it to protect,
  // and a flat 0.02 over three hundred cells would outweigh the fix itself.
  for (let c = 0; c < C; c++) {
    const e = Math.exp(-(d[c]! * d[c]!) / (2 * SIGMA_M * SIGMA_M)) + 1e-9;
    p[c] = e * pStand;
    p[C + c] = e * (1 - pStand);
  }
  const b: Belief = {
    ringKey: ring.key, p, seenAt: now, lastFix: { lat: bus.lat, lon: bus.lon },
    fixAt: now, restPoint: { lat: bus.lat, lon: bus.lon }, restSince: now,
    serverSince: since, lastStopId: null, lead: -1, leadDisagreeSince: null, fresh: true,
  };
  applyLastStop(b, ring, bus, stops);
  normalise(b.p);
  b.lead = leadLeg(b, ring, -1, now, b);
  return b;
}

function applyLastStop(b: Belief, ring: Ring, bus: FilterBus, stops: readonly number[]): void {
  const lsid = bus.last_stop_id ?? null;
  if (lsid === null || lsid === b.lastStopId) return;
  b.lastStopId = lsid;
  const lastIdx = stops.indexOf(lsid);
  if (lastIdx < 0) return;
  const N = ring.N, C = ring.C;
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = Math.sqrt(lastStopLikelihood(((i - lastIdx) % N + N) % N, N));
  for (let c = 0; c < C; c++) {
    const f = w[ring.leg[c]!]!;
    b.p[c] = b.p[c]! * f;
    b.p[C + c] = b.p[C + c]! * f;
  }
}

function normalise(p: Float64Array): void {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += p[i]!;
  if (s <= 0) { p.fill(1 / p.length); return; }
  for (let i = 0; i < p.length; i++) p[i] = p[i]! / s;
}

/**
 * The leg an ETA walks from, per cell and mode: a bus STANDING in a stop's
 * zone is at that stop, whichever side of the marker its cell is on (a yard
 * rest 40 m short of 344 Winchester is at 344 Winchester, not on the leg
 * before it); a moving bus is on its cell's leg.
 */
export function anchorLeg(ring: Ring, c: number, standing: boolean): number {
  if (standing && ring.nearStop[c]! >= 0) return ring.nearStop[c]!;
  return ring.leg[c]!;
}

/** Mass per anchor leg, for the lead and for the fold hysteresis. */
export function legMass(b: Belief, ring: Ring): Float64Array {
  const m = new Float64Array(ring.N);
  const C = ring.C;
  for (let c = 0; c < C; c++) {
    m[anchorLeg(ring, c, true)] = m[anchorLeg(ring, c, true)]! + b.p[c]!;
    m[ring.leg[c]!] = m[ring.leg[c]!]! + b.p[C + c]!;
  }
  return m;
}

/**
 * The leg the screen shows the bus on.
 *
 * Argmax of leg mass, with hysteresis only where it is needed:
 *
 *  - a candidate a leg or two AHEAD of the lead is the bus driving on, and the
 *    lead follows it one leg at a time as soon as it outweighs the old leg;
 *  - a candidate far ahead (a fold's other branch, a lap) must carry
 *    LEAD_SWITCH_MASS first — what stops the number racing across the gap as
 *    a branch weight passes 0.5 (#88);
 *  - a candidate BEHIND is a wrap of N - k legs, which a bus cannot do
 *    (anchorGate.ts, THE RING), so the lead holds — a shuffle back into the
 *    yard at 344 Winchester is still the 344 Winchester layover, and the
 *    pricing follows the mass regardless (arrival.ts). It is released only
 *    after LEAD_MAX_HOLD_MS of sustained disagreement, the gate's own rule for
 *    a lead that was simply wrong.
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
    // One leg at a time, and only once the mass has clearly crossed the
    // stop: a row for that stop flips to "next lap" on this switch, which is
    // a 25-minute jump, so a bus a cell short of the marker must not trigger
    // it. A poll or two of "now" after the bus has passed is the cheaper error.
    const next = (prev + 1) % N;
    const beyond = 1 - m[prev]!;
    return beyond >= LEAD_SWITCH_MASS ? next : prev;
  }
  if (ahead <= N / 2) {
    if (state) state.leadDisagreeSince = null;
    return m[best]! >= LEAD_SWITCH_MASS ? best : prev;
  }
  // Behind: hold, with the timeout.
  if (m[best]! < LEAD_SWITCH_MASS) { if (state) state.leadDisagreeSince = null; return prev; }
  if (!state) return prev;
  if (state.leadDisagreeSince === null) { state.leadDisagreeSince = now; return prev; }
  if (now - state.leadDisagreeSince >= LEAD_MAX_HOLD_MS) { state.leadDisagreeSince = null; return best; }
  return prev;
}

/** A lead held against a posterior behind it for this long is released (anchorGate.ts ANCHOR_MAX_HOLD_MS). */
export const LEAD_MAX_HOLD_MS = 300_000;

/** A candidate this many legs ahead of the lead is the bus driving on, not an alternative. */
export const LEAD_FOLLOW_LEGS = 2;

/**
 * One poll. Idempotent within a poll: calling it twice with the same `now`
 * returns the same belief untouched, so every render site can call it.
 */
export function stepBelief(
  prev: Belief | undefined,
  ring: Ring,
  bus: FilterBus,
  now: number,
  stops: readonly number[],
): Belief {
  if (!bus.lat || !bus.lon) return prev && prev.ringKey === ring.key ? prev : initBelief(ring, bus, now, stops);
  if (!prev || prev.ringKey !== ring.key || now - prev.seenAt > BELIEF_STALE_MS || now < prev.seenAt) {
    return initBelief(ring, bus, now, stops);
  }
  if (now === prev.seenAt) return prev;

  const C = ring.C, N = ring.N;
  const dt = Math.max(1, Math.min(60, (now - prev.seenAt) / 1000));
  const fresh = prev.lastFix === null || prev.lastFix.lat !== bus.lat || prev.lastFix.lon !== bus.lon;
  const q = new Float64Array(2 * C);
  const p = prev.p;
  const hIn = Math.min(0.5, HOLD_ENTER_PER_S * dt);

  if (fresh) {
    const kern = moveKernel(dt, ring.loopM / ring.C);
    const stoodLong = standingSec(prev, prev.seenAt) >= LAYOVER_STAND_SEC;
    // Survival of the advance: S[j] = P(k >= j).
    const S = new Float64Array(MAX_ADVANCE + 2);
    S[MAX_ADVANCE + 1] = 0;
    for (let j = MAX_ADVANCE; j >= 1; j--) S[j] = S[j + 1]! + kern[j]!;
    for (let c = 0; c < C; c++) {
      const mStand = p[c]!, mMove = p[C + c]!;
      // Teleport-level mass (TELEPORT / 2C per cell) is not worth walking
      // through the kernel; the teleport below refreshes it every poll.
      if (mStand + mMove < PROPAGATE_MIN) continue;
      if (mStand > 1e-12) {
        // The first step off a stand is 30-35 m whether it is a departure or
        // a shuffle (departure-derivation.md: "first step 30-35 m in both"),
        // so both branches land a cell or two on; only the MODE differs, and
        // the split is the measured departure prior. The next poll settles
        // it: a departure moves again, a shuffle re-freezes.
        //
        // Shuffles happen at kerbs and in yards — inside a stop's zone or its
        // approach — and nowhere else. Allowed mid-leg, a "standing bus
        // shuffling backwards" tracked an off-route bus creeping the wrong
        // way along the inbound branch of a shared road (Red #316, 14:30
        // 2026-09-03) and out-scored the true branch 4 : 1 per fix.
        const canShuffle = ring.nearStop[c]! >= 0 || ring.approachOf[c]! >= 0;
        const pDepart = !canShuffle ? 1 : stoodLong ? P_DEPART_AFTER_LAYOVER : P_DEPART_ON_FRESH;
        for (let j = 1; j < DEPART_KERNEL.length; j++) {
          const x = (c + j) % C;
          q[C + x] = q[C + x]! + mStand * pDepart * DEPART_KERNEL[j]!;
        }
        if (canShuffle) {
          for (const [dj, w] of SHUFFLE_KERNEL) {
            const x = ((c + dj) % C + C) % C;
            q[x] = q[x]! + mStand * (1 - pDepart) * w;
          }
        }
      }
      if (mMove > 1e-12) advance(q, ring, c, mMove, kern, S, hIn);
    }
    // Teleport, then the position emission with its off-route floor.
    const tp = TELEPORT / (2 * C);
    for (let i = 0; i < 2 * C; i++) q[i] = q[i]! * (1 - TELEPORT) + tp;
    const d = distancesTo(ring, bus);
    for (let c = 0; c < C; c++) {
      const e = Math.max(P_OFF_ROUTE, Math.exp(-(d[c]! * d[c]!) / (2 * SIGMA_M * SIGMA_M)));
      q[c] = q[c]! * e;
      q[C + c] = q[C + c]! * e;
    }
  } else {
    // Same cell. A standing bus stays; a moving bus is crawling or came to a hold.
    for (let c = 0; c < C; c++) {
      const mStand = p[c]!, mMove = p[C + c]!;
      const inZone = ring.nearStop[c]! >= 0;
      const atStop = inZone || ring.approachOf[c]! >= 0;
      const crawl = inZone ? P_CRAWL_ZONE : P_CRAWL;
      const hLeave = Math.min(0.5, (atStop ? STOP_LEAVE_PER_S : HOLD_LEAVE_PER_S) * dt);
      const leak = mStand * hLeave * crawl;
      q[c] = q[c]! + mStand - leak + mMove * hIn;
      q[C + c] = q[C + c]! + leak + mMove * crawl * (1 - hIn);
    }
  }

  const moved = fresh && haversineMeters(prev.restPoint, bus) > REST_RADIUS_M;
  const b: Belief = {
    ringKey: ring.key, p: q, seenAt: now,
    lastFix: fresh ? { lat: bus.lat, lon: bus.lon } : prev.lastFix,
    fixAt: fresh ? now : prev.fixAt,
    restPoint: moved ? { lat: bus.lat, lon: bus.lon } : prev.restPoint,
    restSince: moved ? now : prev.restSince,
    serverSince: serverClockMs(bus),
    lastStopId: prev.lastStopId, lead: prev.lead, leadDisagreeSince: prev.leadDisagreeSince, fresh,
  };
  applyLastStop(b, ring, bus, stops);
  normalise(b.p);
  b.lead = leadLeg(b, ring, prev.lead, now, b);
  return b;
}

/**
 * Move mass `m` from cell c forward by the kernel. Passing a stop cell, a
 * fraction P_STOP of the mass reaching it stops there (STAND at the stop);
 * mass landing anywhere comes to a hold with probability hIn.
 */
function advance(q: Float64Array, ring: Ring, c: number, m: number, kern: Float64Array, S: Float64Array, hIn: number): void {
  const C = ring.C;
  let flow = m;
  for (let j = 1; j <= MAX_ADVANCE; j++) {
    if (flow <= 1e-12) break;
    const x = (c + j) % C;
    if (ring.frac[x] === 0) { // the cell ON a stop
      q[x] = q[x]! + flow * P_STOP;
      flow *= 1 - P_STOP;
    }
    const endHere = S[j]! > 0 ? kern[j]! / S[j]! : 1;
    const landed = flow * endHere;
    q[x] = q[x]! + landed * hIn;
    q[C + x] = q[C + x]! + landed * (1 - hIn);
    flow -= landed;
  }
  if (flow > 1e-12) { // beyond the kernel: pile at the far edge
    const x = (c + MAX_ADVANCE) % C;
    q[C + x] = q[C + x]! + flow;
  }
}

/**
 * Situations: the posterior collapsed to (leg, mode) with the mass-weighted
 * mean position within the leg, dropping anything under `minMass`.
 */
export interface Situation {
  leg: number;
  standing: boolean;
  mass: number;
  /** Mass-weighted mean leg fraction. */
  frac: number;
  /** For a standing situation: the stop whose zone holds most of the mass, else -1. */
  zoneStop: number;
  /** True when that zone is the approach zone SHORT of `zoneStop`, not the stop itself. */
  approach: boolean;
  /** Mass-weighted mean cell, for diagnostics. */
  cell: number;
}

export function situations(b: Belief, ring: Ring, minMass = 0.01): Situation[] {
  const C = ring.C;
  type Acc = { mass: number; frac: number; cell: number; zone: Map<number, number> };
  const acc = new Map<number, Acc>();
  for (let c = 0; c < C; c++) {
    for (let mode = 0; mode < 2; mode++) {
      const m = b.p[mode * C + c]!;
      if (m <= 0) continue;
      const key = anchorLeg(ring, c, mode === 0) * 2 + mode;
      let a = acc.get(key);
      if (!a) { a = { mass: 0, frac: 0, cell: 0, zone: new Map() }; acc.set(key, a); }
      a.mass += m;
      a.frac += m * ring.frac[c]!;
      a.cell += m * c;
      if (mode === 0) {
        // Zone key: stop index for the stop's own zone, 1000 + stop index for its approach zone, -1 for none.
        const z = ring.nearStop[c]! >= 0 ? ring.nearStop[c]! : ring.approachOf[c]! >= 0 ? 1000 + ring.approachOf[c]! : -1;
        a.zone.set(z, (a.zone.get(z) ?? 0) + m);
      }
    }
  }
  const out: Situation[] = [];
  let total = 0;
  for (const [key, a] of acc) {
    if (a.mass < minMass) continue;
    let zoneKey = -1, best = 0;
    for (const [z, m] of a.zone) if (m > best) { best = m; zoneKey = z; }
    out.push({
      leg: Math.floor(key / 2), standing: key % 2 === 0, mass: a.mass,
      frac: a.frac / a.mass,
      zoneStop: zoneKey >= 1000 ? zoneKey - 1000 : zoneKey,
      approach: zoneKey >= 1000,
      cell: a.cell / a.mass,
    });
    total += a.mass;
  }
  for (const s of out) s.mass /= total || 1;
  out.sort((x, y) => y.mass - x.mass);
  return out;
}
