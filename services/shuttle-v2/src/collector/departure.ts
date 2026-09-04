import { distanceMeters } from "../network/geo.js";
import type { TransitNetwork } from "../network/TransitNetwork.js";
import type { EpochMs } from "../schema/api.js";

import {
  AT_STOP_PIN_M,
  MAX_HANDOFF_GAP_MS,
  MAX_HANDOFF_JUMP_M,
  MAX_HANDOFF_SPEED_MPS,
  MAX_OBSERVATION_GAP_MS,
  MAX_SEGMENT_HOPS,
  MAX_SEGMENT_SEC,
  MIN_DWELL_SEC,
  planTracks,
  reconcileTracks,
  step,
  type BusObservation,
  type BusState,
  type DetectorEvent,
  type TrackedIdentity,
  type TrackPlan,
} from "./detector.js";

/**
 * Stop visits and legs: the DEPARTURE instant, derived from positions.
 *
 * `detector.ts` measures one interval per anchor transition — arrival at A to
 * arrival at B — and emits it twice, as `DwellEvent.dwellSec` and as
 * `SegmentEvent.travelSec`. Nothing in that stream says when the bus LEFT A,
 * so "dwell" there is anchor residence time (it contains the drive toward B)
 * and "travel" contains every second the bus stood at A. This module is the
 * missing observation. It does not touch the detector's events — they stay
 * exactly as they are — it derives, from the same positions and the
 * detector's own state, three things per stop pass and two per hop:
 *
 *   visit  stand   seconds the bus stood at the stop: `departedAt − arrivedAt`
 *          outcome "stopped" (stand ≥ MIN_DWELL_SEC), "passed" (rolled through,
 *                  or never came within AT_STOP_PIN_M at all), "unresolved"
 *                  (the track broke before the bus was seen leaving)
 *   leg    hold    seconds stopped MID-leg — a light, a queue, a hold off-stop
 *          drive   the rest of the rest-to-rest time
 *
 * ## Reference points
 *
 * `pinnedAt` is the first poll within {@link AT_STOP_PIN_M} (75 m) of the stop
 * while the detector anchors the bus there — exactly the instant production's
 * `at_stop_since` starts (the stop-pinned clock, `BusState.stationaryStopId`).
 *
 * `arrivedAt` is the START OF THE FIRST RESTING PLATEAU inside that radius: the
 * poll on which the coordinate that then repeated was first reported. A
 * decelerating bus covers the last 75 m in a poll or two, and that roll-in is
 * motion, so it belongs to the leg, not to `stand`. A bus that never comes to
 * rest inside the radius has `arrivedAt === departedAt` at its closest approach
 * and `stand = 0` — it rolled through.
 *
 * `departedAt` is the END OF THE FINAL RESTING PLATEAU: the last poll at which
 * the coordinate had not yet changed before the run of fixes that carried the
 * bus away. That is backdated from the moment the run is confirmed to the
 * moment it began — the pattern PR #57 established — and it is within one poll
 * interval (5 s) of the true instant, because the feed's ~30 m deadband means
 * the first fresh fix is already 30 m out. Both instants are quantised the
 * same way, so `stand` is unbiased to within a poll.
 *
 * ## Why a candidate needs confirming
 *
 * A parked bus does not drift (99.7% of its consecutive fixes are identical —
 * `docs/layover-clock.md`) but it does SHUFFLE, typically once, a minute or so
 * before pulling out, and a shuffle's first fix is the same ~30 m quantum as a
 * departure's. Of 775 "first fresh fix after ≥60 s frozen" in production, 66%
 * were departures, 14% shuffles and 20% ambiguous, with no separation in the
 * first step. So a fresh fix opens a CANDIDATE and the next polls decide it:
 *
 *   - the fix freezes again within 75 m of the stop for {@link HOLD_MIN_SEC} →
 *     a shuffle; the resting point moves to the new fix and the plateau
 *     restarts (`shuffles` counts). A SHORTER refreeze is not a shuffle: a bus
 *     pulling out at under 6 m/s cannot clear the deadband every poll, so its
 *     outbound run carries single repeated fixes (16% of running polls do),
 *     and treating each as a stop would split one departure into a shuffle
 *     plus a departure ten seconds late.
 *   - the bus reaches {@link DEPART_FAR_M} from the stop → confirmed, `how:
 *     "far"` (the measured definition of a departure: ≥150 m, which no parked
 *     bus reaches — parked p99 from the stop is 92 m, max 215 m)
 *   - the detector pins the bus at a DIFFERENT stop → confirmed, `how: "next"`
 *   - the detector's stationary clock restarts (beyond `STATIONARY_RADIUS_M`
 *     without being at a stop) → confirmed, `how: "clock"`
 *   - the track breaks with the candidate still open → `how: "gap"`, with the
 *     evidence it had and a measured prior for `confidence`
 *
 * A candidate can only open once the bus has been seen at rest (one repeated
 * fix). Before that a fresh fix is the roll-in still in progress, and the
 * resting point simply moves with it.
 *
 * Every event carries the evidence — plateau length, steps to confirm, distance
 * reached, shuffles seen — and not only the decision, because a model that
 * wants to act at the first fresh fix needs the observation, not our current
 * opinion of it.
 *
 * ## Out-and-back routes
 *
 * Stops are identified by their POSITION in the route sequence (`stopIndex`),
 * carried over from the detector's own `nearestIndex`, never by
 * `stops.indexOf(id)`: routes 9 and 10 list the West Campus stops twice.
 *
 * Pure: `stepVisit` is a reducer over `(prevVisitState, detector before/after,
 * observation)`, so a replay over archived positions and the live collector run
 * the identical code.
 */

// Tuning constants ------------------------------------------------------------

/**
 * Distance from the stop at which a candidate departure is confirmed on its
 * own. The measured gate from production: a bus that reaches 150 m within a
 * minute of its first fresh fix was a departure in every hand-checked case,
 * and a parked bus never gets there (per-visit maximum from the stop: p50
 * 60 m, p99 156 m only at yard stops, and those are `how: "clock"` at 125 m
 * first). It sits above the detector's `STATIONARY_RADIUS_M` (125) so the two
 * agree on the direction of every decision, and below the 160 m widest (N)/(S)
 * twin pair, so reaching it can never mean "arrived at the twin".
 */
export const DEPART_FAR_M = 150;

/**
 * Minimum length of a frozen run to count as standing — mid-leg (a hold) or
 * inside the pin radius after a candidate opened (a shuffle). The feed repeats
 * a coordinate on 16% of polls while a bus is genuinely RUNNING (a bus under
 * 6 m/s cannot clear the deadband in one poll), so a single repeated fix is
 * not a stop; three polls is, and it matches `MIN_DWELL_SEC` so "stopped" means
 * the same thing at a stop and away from one.
 */
export const HOLD_MIN_SEC = MIN_DWELL_SEC;

/**
 * Polls are ~5 s apart but not exactly: three repeated fixes can span 14.6 s.
 * A stillness test on raw seconds would then let a real re-freeze slip past
 * as "under 15 s" — seen on the VA loop, where a bus that had plainly settled
 * for three polls was carried on as a departure. So every "long enough to be
 * standing" test allows one second of cadence jitter: three repeats count.
 */
export const POLL_JITTER_MS = 1000;
export const STILL_MIN_MS = HOLD_MIN_SEC * 1000 - POLL_JITTER_MS;

/**
 * Probability that a candidate which reached `steps` fresh outbound polls and
 * was then cut off by a feed break was a real departure — the `confidence`
 * written on a `how: "gap"` visit. MEASURED, not chosen: the share of every
 * decided candidate in the 2026-09-03 archive (11.7 h, 22 buses, 13 routes)
 * that reached at least that many steps and was confirmed rather than refrozen
 * as a shuffle (`scripts/eta-replay/departure-replay.ts`, "Candidate
 * departures"). Index 0 is a break with no movement seen at all — the row
 * exists only to bound the stand from below.
 */
export const DEPARTURE_PRIOR_BY_STEPS: readonly number[] = [0, 0.76, 0.87, 0.95, 0.98, 0.98];

/**
 * `confidence` by how the departure was confirmed. "far" is the definition of a
 * departure itself; "next" means the detector already has the bus at another
 * stop. "clock" is the detector's 125 m restart without a stop: `docs/layover-
 * clock.md` measured 34 false restarts against 879 visits over 7 h — a restart
 * was a departure 96% of the time, the rest a yard excursion that came back.
 */
export const CONFIDENCE_BY_HOW: Readonly<Record<ConfirmedHow, number>> = {
  far: 1,
  next: 1,
  clock: 0.96,
};

// Outputs ---------------------------------------------------------------------

export type VisitOutcome = "stopped" | "passed" | "unresolved";
export type DepartureHow = "far" | "next" | "clock" | "gap";
/** A confirmation the reducer itself made — everything but a feed break. */
export type ConfirmedHow = Exclude<DepartureHow, "gap">;

export interface StopVisitEvent {
  kind: "visit";
  busId: number;
  busName: string;
  /** The `busId` the matching `arrivals` row was written under (see DwellEvent). */
  anchorBusId: number;
  routeId: number;
  stopId: number;
  /** Position in the route sequence — the identity on out-and-back routes. */
  stopIndex: number;
  /** The detector's arrival at this anchor: `arrivals.arrived_at`, the join key. */
  anchoredAt: EpochMs;
  /** First poll within AT_STOP_PIN_M (production's `at_stop_since`); null when the bus never came that close. */
  pinnedAt: EpochMs | null;
  /** Start of the first resting plateau inside the radius; the closest approach when the bus never rested; null when never pinned. */
  arrivedAt: EpochMs | null;
  /** End of the final resting plateau; equals `arrivedAt` when the bus never rested; null when the track broke first. */
  departedAt: EpochMs | null;
  /** `departedAt − arrivedAt`; 0 for a pass-through, null when unresolved. */
  standSec: number | null;
  /** Seconds from `pinnedAt` to the last poll within the radius — "≥ 15 s within 75 m" is the priors lane's definition of a stop. */
  insideSec: number | null;
  outcome: VisitOutcome;
  /** How the departure was decided; null when there was none to decide. */
  how: DepartureHow | null;
  /** P(the bus left within a poll of `departedAt`), see the constants above. */
  confidence: number | null;
  // -- evidence -------------------------------------------------------------
  /** Metres from the resting fix to the first fresh fix of the confirmed run. */
  firstStepM: number | null;
  /** Fresh outbound polls from the first to the confirming one. */
  steps: number;
  /** Farthest the bus got from the stop by confirmation. */
  farM: number | null;
  /** Seconds from the first fresh fix to confirmation. */
  confirmSec: number | null;
  /** Repeated polls on the final plateau (0: the bus never rested here). */
  restPolls: number;
  /** Candidates that refroze within 75 m — repositionings before the real exit. */
  shuffles: number;
  /** The first fresh fix after the bus had come to rest, shuffle or not. */
  firstMovedAt: EpochMs | null;
  /** Last poll the bus was still seen at rest — the lower bound on an unresolved stand. */
  lastAtRestAt: EpochMs | null;
  /** Closest approach to the stop while anchored there — what "passed" means, in metres. */
  closestM: number;
}

export interface LegEvent {
  kind: "leg";
  busId: number;
  busName: string;
  routeId: number;
  fromStopId: number;
  fromIndex: number;
  toStopId: number;
  toIndex: number;
  hops: number;
  /** The departure instant at `fromStopId` (its closest approach when it was passed). */
  departedAt: EpochMs;
  /** The arrival instant at `toStopId` — start of its first rest, or its closest approach when passed. */
  arrivedAt: EpochMs;
  /** When the bus came within the pin radius of `toStopId` (production's `at_stop_since` there); null when it never did. */
  toPinnedAt: EpochMs | null;
  legSec: number;
  /** Seconds in frozen runs ≥ HOLD_MIN_SEC between the two instants. */
  holdSec: number;
  driveSec: number;
  /** Number of such runs. */
  holds: number;
  /** Whether the bus came within the pin radius of `toStopId`. */
  reached: boolean;
}

export type VisitEvent = StopVisitEvent | LegEvent;

/**
 * What became of every candidate, confirmed or not. Not persisted; the offline
 * replay uses it to measure {@link DEPARTURE_PRIOR_BY_STEPS}.
 */
export interface CandidateOutcome {
  busName: string;
  routeId: number;
  stopId: number;
  outcome: DepartureHow | "shuffle";
  steps: number;
  restPolls: number;
  restSec: number;
  firstStepM: number;
  farM: number;
  movedAt: EpochMs;
  resolvedAt: EpochMs;
}

// State -----------------------------------------------------------------------

interface FrozenRun {
  start: EpochMs;
  end: EpochMs;
}

interface Anchor {
  stopId: number;
  stopIndex: number;
  enteredAt: EpochMs;
  busId: number;
}

/** The identity a visit or leg is stamped with. */
interface Identity {
  busId: number;
  busName: string;
  routeId: number;
}

interface Candidate {
  movedAt: EpochMs;
  /** The last plateau poll — the departure instant if this is confirmed. */
  departedAt: EpochMs;
  restPolls: number;
  restSec: number;
  firstStepM: number;
  steps: number;
  farM: number;
  /** Frozen runs ≥ HOLD_MIN_SEC outside the pin radius while pending — holds in the leg. */
  holdRuns: FrozenRun[];
  /** When the currently repeating fix was first reported, or null while fresh. */
  frozenSince: EpochMs | null;
  /** Whether that repeating fix is inside the pin radius (a shuffle in the making). */
  frozenInside: boolean;
  /** Repeated polls of that fix so far. */
  frozenPolls: number;
  /** Last poll within the pin radius. */
  lastInsideAt: EpochMs;
}

interface Pass {
  stopId: number;
  stopIndex: number;
  anchoredAt: EpochMs;
  anchorBusId: number;
  /** First poll within the pin radius; null until then. */
  pinnedAt: EpochMs | null;
  /** Start of the first resting plateau; null until the bus has rested. */
  arrivedAt: EpochMs | null;
  closestM: number;
  closestAt: EpochMs;
  /** The latest distinct coordinate (valid once pinned). */
  restLat: number;
  restLon: number;
  /** When that coordinate was first reported. */
  restSince: EpochMs;
  /** Repeated polls of it. */
  restPolls: number;
  lastAtRestAt: EpochMs;
  shuffles: number;
  firstMovedAt: EpochMs | null;
  candidate: Candidate | null;
  /**
   * The detector moved its anchor on while the stationary clock stayed pinned
   * here (a parked bus shuffled enough to flip the nearest stop — the case PR
   * #67 exists for). Remembered so the next pass opens at that anchor with the
   * arrival time the detector actually recorded for it.
   */
  nextAnchor: Anchor | null;
}

interface Transit {
  fromStopId: number;
  fromIndex: number;
  departedAt: EpochMs;
  runs: FrozenRun[];
  frozenSince: EpochMs | null;
}

export interface VisitState extends TrackedIdentity {
  routeId: number;
  pass: Pass | null;
  transit: Transit | null;
}

// Implementation --------------------------------------------------------------

function anchorOf(after: BusState, obs: BusObservation): Anchor {
  return {
    stopId: after.nearestStopId,
    stopIndex: after.nearestIndex,
    enteredAt: after.enteredAt,
    busId: obs.busId,
  };
}

function openPass(network: TransitNetwork, anchor: Anchor, after: BusState, obs: BusObservation): Pass {
  const stop = network.stops.get(anchor.stopId);
  const d = stop ? distanceMeters(obs, stop) : Infinity;
  const pinned = after.stationaryStopId === anchor.stopId && d <= AT_STOP_PIN_M;
  return {
    stopId: anchor.stopId,
    stopIndex: anchor.stopIndex,
    anchoredAt: anchor.enteredAt,
    anchorBusId: anchor.busId,
    pinnedAt: pinned ? obs.collectedAt : null,
    arrivedAt: null,
    closestM: d,
    closestAt: obs.collectedAt,
    restLat: obs.lat,
    restLon: obs.lon,
    restSince: obs.collectedAt,
    restPolls: 0,
    lastAtRestAt: obs.collectedAt,
    shuffles: 0,
    firstMovedAt: null,
    candidate: null,
    nextAnchor: null,
  };
}

function holdWithin(runs: readonly FrozenRun[], from: EpochMs, to: EpochMs): { sec: number; n: number } {
  let sec = 0;
  let n = 0;
  for (const r of runs) {
    const a = Math.max(r.start, from);
    const b = Math.min(r.end, to);
    if (b - a >= STILL_MIN_MS) {
      sec += (b - a) / 1000;
      n++;
    }
  }
  return { sec, n };
}

/** Close a frozen run at `end` if it was long enough to be a hold. */
function closeRun(runs: FrozenRun[], start: EpochMs | null, end: EpochMs): void {
  if (start !== null && end - start >= STILL_MIN_MS) runs.push({ start, end });
}

function makeLeg(
  network: TransitNetwork,
  transit: Transit,
  to: { stopId: number; stopIndex: number; pinnedAt: EpochMs | null },
  arrivedAt: EpochMs,
  reached: boolean,
  id: Identity,
): LegEvent | null {
  const len = network.routeLength(id.routeId);
  if (len === 0) return null;
  const hops = (((to.stopIndex - transit.fromIndex) % len) + len) % len;
  const legSec = (arrivedAt - transit.departedAt) / 1000;
  if (hops < 1 || hops > MAX_SEGMENT_HOPS || legSec <= 0 || legSec > MAX_SEGMENT_SEC) return null;
  const runs = [...transit.runs];
  closeRun(runs, transit.frozenSince, arrivedAt);
  const hold = holdWithin(runs, transit.departedAt, arrivedAt);
  return {
    kind: "leg",
    busId: id.busId,
    busName: id.busName,
    routeId: id.routeId,
    fromStopId: transit.fromStopId,
    fromIndex: transit.fromIndex,
    toStopId: to.stopId,
    toIndex: to.stopIndex,
    hops,
    departedAt: transit.departedAt,
    arrivedAt,
    toPinnedAt: to.pinnedAt,
    legSec,
    holdSec: hold.sec,
    driveSec: legSec - hold.sec,
    holds: hold.n,
    reached,
  };
}

function visitEvent(
  pass: Pass,
  id: Identity,
  fields: {
    departedAt: EpochMs | null;
    how: DepartureHow | null;
    confidence: number | null;
    cand: Candidate | null;
    resolvedAt: EpochMs;
  },
): StopVisitEvent {
  const { how, confidence, cand } = fields;
  let { departedAt } = fields;
  // Pinned but never at rest, and seen leaving: the kerb instant is the closest
  // approach, and both instants are that poll.
  let arrivedAt = pass.arrivedAt;
  if (pass.pinnedAt !== null && arrivedAt === null && departedAt !== null) {
    arrivedAt = departedAt = pass.closestAt;
  }
  const standSec =
    pass.pinnedAt === null ? 0 : arrivedAt === null || departedAt === null ? null : (departedAt - arrivedAt) / 1000;
  const outcome: VisitOutcome =
    standSec === null ? "unresolved" : standSec * 1000 >= STILL_MIN_MS ? "stopped" : "passed";
  const lastInside = cand ? cand.lastInsideAt : pass.lastAtRestAt;
  return {
    kind: "visit",
    busId: id.busId,
    busName: id.busName,
    anchorBusId: pass.anchorBusId,
    routeId: id.routeId,
    stopId: pass.stopId,
    stopIndex: pass.stopIndex,
    anchoredAt: pass.anchoredAt,
    pinnedAt: pass.pinnedAt,
    arrivedAt,
    departedAt,
    standSec,
    insideSec: pass.pinnedAt === null ? null : (lastInside - pass.pinnedAt) / 1000,
    outcome,
    how,
    confidence,
    firstStepM: cand ? cand.firstStepM : null,
    steps: cand ? cand.steps : 0,
    farM: cand ? cand.farM : null,
    confirmSec: cand && how !== null ? (fields.resolvedAt - cand.movedAt) / 1000 : null,
    restPolls: cand ? cand.restPolls : pass.restPolls,
    shuffles: pass.shuffles,
    firstMovedAt: pass.firstMovedAt,
    lastAtRestAt: pass.arrivedAt === null ? null : pass.lastAtRestAt,
    closestM: pass.closestM,
  };
}

function outcomeOf(pass: Pass, cand: Candidate, id: Identity, outcome: CandidateOutcome["outcome"], at: EpochMs): CandidateOutcome {
  return {
    busName: id.busName,
    routeId: id.routeId,
    stopId: pass.stopId,
    outcome,
    steps: cand.steps,
    restPolls: cand.restPolls,
    restSec: cand.restSec,
    firstStepM: cand.firstStepM,
    farM: cand.farM,
    movedAt: cand.movedAt,
    resolvedAt: at,
  };
}

export interface VisitStepResult {
  state: VisitState | null;
  events: VisitEvent[];
  resolved: CandidateOutcome[];
}

/**
 * The detector's own reanchor conditions, minus "left the modelled path"
 * (which is a legitimate move, bounded by the hop check on the leg). Mirrors
 * `step()` in `detector.ts` so a break in the track is judged identically.
 */
function trackBroken(before: BusState | null, obs: BusObservation): boolean {
  if (!before) return true;
  const gap = obs.collectedAt - before.lastObservedAt;
  if (gap > MAX_OBSERVATION_GAP_MS || before.routeId !== obs.routeId) return true;
  if (before.busId !== obs.busId) {
    const jumpM = distanceMeters(before, obs);
    if (gap > MAX_HANDOFF_GAP_MS) return true;
    if (jumpM > MAX_HANDOFF_JUMP_M && jumpM > (gap / 1000) * MAX_HANDOFF_SPEED_MPS) return true;
  }
  return false;
}

/**
 * Close an open pass whose track is ending — a feed break, a route change, a
 * vehicle handoff that failed the continuity check, or the end of a replay.
 * A pending candidate resolves as `how: "gap"` with the evidence it had; a
 * rest with no movement seen is `unresolved` (its lower bound is
 * `lastAtRestAt`); a pass that never rested emits nothing, because its
 * closest approach is not yet known to be the closest.
 */
export function closePass(state: VisitState, at: EpochMs): VisitStepResult {
  const events: VisitEvent[] = [];
  const resolved: CandidateOutcome[] = [];
  const pass = state.pass;
  if (pass && pass.pinnedAt !== null) {
    const cand = pass.candidate;
    if (cand) {
      const k = Math.min(cand.steps, DEPARTURE_PRIOR_BY_STEPS.length - 1);
      events.push(
        visitEvent(pass, state, {
          departedAt: cand.departedAt,
          how: "gap",
          confidence: DEPARTURE_PRIOR_BY_STEPS[k]!,
          cand,
          resolvedAt: at,
        }),
      );
      resolved.push(outcomeOf(pass, cand, state, "gap", at));
    } else if (pass.arrivedAt !== null) {
      events.push(visitEvent(pass, state, { departedAt: null, how: null, confidence: null, cand: null, resolvedAt: at }));
    }
  }
  return { state: null, events, resolved };
}

/**
 * Apply one observation. `before`/`after` are the detector's state for this
 * bus around the same observation (`after === before` means the detector
 * rejected it as not newer, and so does this).
 */
export function stepVisit(
  network: TransitNetwork,
  prev: VisitState | null,
  before: BusState | null,
  after: BusState | null,
  obs: BusObservation,
): VisitStepResult {
  if (!after) return prev ? closePass(prev, obs.collectedAt) : { state: null, events: [], resolved: [] };
  if (after === before) return { state: prev, events: [], resolved: [] };

  const t = obs.collectedAt;
  const events: VisitEvent[] = [];
  const resolved: CandidateOutcome[] = [];
  const fresh = !before || before.lat !== obs.lat || before.lon !== obs.lon;
  const prevAt = before ? before.lastObservedAt : t;
  const id: Identity = obs;

  // A broken track: nothing before it can be joined to anything after it.
  if (!prev || trackBroken(before, obs)) {
    if (prev) {
      const closed = closePass(prev, prevAt);
      events.push(...closed.events);
      resolved.push(...closed.resolved);
    }
    return {
      state: { busId: obs.busId, busName: obs.busName, routeId: obs.routeId, pass: openPass(network, anchorOf(after, obs), after, obs), transit: null },
      events,
      resolved,
    };
  }

  let pass = prev.pass;
  let transit = prev.transit;
  const anchorMoved = !before || after.nearestIndex !== before.nearestIndex;
  const done = (): VisitStepResult => ({
    state: { busId: obs.busId, busName: obs.busName, routeId: obs.routeId, pass, transit },
    events,
    resolved,
  });

  // -- In transit: account for holds ------------------------------------------
  // Runs of an unchanged coordinate. The coordinate was first reported on the
  // PREVIOUS poll, so a run noticed now began then. Accounting continues while
  // the destination pass is pinned but not yet at rest: the run that becomes
  // its rest starts exactly at the leg's end, so it contributes nothing.
  if (transit && !(pass && pass.arrivedAt !== null)) {
    if (fresh) {
      closeRun(transit.runs, transit.frozenSince, prevAt);
      transit.frozenSince = null;
    } else if (transit.frozenSince === null) {
      transit.frozenSince = prevAt;
    }
  }

  /** End the inbound leg at `arrivedAt` of the pass just reached. */
  const endTransit = (to: Pass, arrivedAt: EpochMs, reached: boolean): void => {
    if (!transit) return;
    const leg = makeLeg(network, transit, to, arrivedAt, reached, id);
    if (leg) events.push(leg);
    transit = null;
  };
  /** Start the onward leg from `from` at `departedAt`, carrying over frozen runs that outlive it. */
  const startTransit = (from: Pass, departedAt: EpochMs, runs: FrozenRun[], frozenSince: EpochMs | null): void => {
    transit = {
      fromStopId: from.stopId,
      fromIndex: from.stopIndex,
      departedAt,
      runs: runs.filter((r) => r.end > departedAt),
      frozenSince,
    };
  };

  // -- No pass open: waiting for the detector to move on after a departure --
  if (!pass) {
    if (anchorMoved || (after.stationaryStopId !== null && after.stationaryStopId === after.nearestStopId)) {
      pass = openPass(network, anchorOf(after, obs), after, obs);
    }
    return done();
  }

  const stop = network.stops.get(pass.stopId);
  const dStop = stop ? distanceMeters(obs, stop) : Infinity;
  const left = after.stationaryStopId !== pass.stopId;
  const howIfLeft = (): ConfirmedHow => (after.stationaryStopId !== null ? "next" : "clock");

  // -- Anchored, not yet within the pin radius ---------------------------------
  if (pass.pinnedAt === null) {
    if (anchorMoved) {
      // Passed the stop without ever coming within the pin radius.
      events.push(visitEvent(pass, id, { departedAt: null, how: null, confidence: null, cand: null, resolvedAt: t }));
      const from = pass;
      endTransit(from, from.closestAt, false);
      startTransit(from, from.closestAt, prev.transit ? prev.transit.runs : [], prev.transit ? prev.transit.frozenSince : null);
      pass = openPass(network, anchorOf(after, obs), after, obs);
      return done();
    }
    if (dStop < pass.closestM) pass = { ...pass, closestM: dStop, closestAt: t };
    if (after.stationaryStopId === pass.stopId && dStop <= AT_STOP_PIN_M) {
      pass = { ...pass, pinnedAt: t, restLat: obs.lat, restLon: obs.lon, restSince: t, restPolls: 0, lastAtRestAt: t };
    }
    return done();
  }

  // -- Pinned, not yet at rest: rolling in (or through) --------------------------
  if (pass.arrivedAt === null) {
    if (anchorMoved && !left) pass = { ...pass, nextAnchor: anchorOf(after, obs) };
    if (!fresh) {
      // First repeated fix: the bus has come to rest at the coordinate reported
      // on the previous poll. That is the arrival, and the end of the inbound leg.
      pass = { ...pass, arrivedAt: pass.restSince, restPolls: 1, lastAtRestAt: t };
      endTransit(pass, pass.arrivedAt!, true);
      return done();
    }
    if (dStop < pass.closestM) pass = { ...pass, closestM: dStop, closestAt: t };
    if (dStop >= DEPART_FAR_M || left) {
      // Rolled through without resting. The kerb instant is the closest approach.
      const how: ConfirmedHow = dStop >= DEPART_FAR_M ? "far" : howIfLeft();
      events.push(visitEvent(pass, id, { departedAt: pass.closestAt, how, confidence: CONFIDENCE_BY_HOW[how], cand: null, resolvedAt: t }));
      const from = pass;
      endTransit(from, from.closestAt, true);
      startTransit(from, from.closestAt, prev.transit ? prev.transit.runs : [], prev.transit ? prev.transit.frozenSince : null);
      const next = from.nextAnchor ?? (anchorMoved ? anchorOf(after, obs) : null);
      pass = next ? openPass(network, next, after, obs) : null;
      return done();
    }
    // Still rolling inside the radius: the resting point moves with the bus.
    pass = { ...pass, restLat: obs.lat, restLon: obs.lon, restSince: t, lastAtRestAt: t };
    return done();
  }

  // -- At rest: the departure decision -------------------------------------------
  if (anchorMoved && !left) {
    // The clock stayed pinned here while the nearest stop flipped (#67).
    pass = { ...pass, nextAnchor: anchorOf(after, obs) };
  }

  let cand = pass.candidate;
  let confirm: ConfirmedHow | null = null;

  if (!cand) {
    if (!fresh) {
      pass = { ...pass, restPolls: pass.restPolls + 1, lastAtRestAt: t };
      return done();
    }
    cand = {
      movedAt: t,
      departedAt: pass.lastAtRestAt,
      restPolls: pass.restPolls,
      restSec: (pass.lastAtRestAt - pass.restSince) / 1000,
      firstStepM: distanceMeters(obs, { lat: pass.restLat, lon: pass.restLon }),
      steps: 1,
      farM: dStop,
      holdRuns: [],
      frozenSince: null,
      frozenInside: false,
      frozenPolls: 0,
      lastInsideAt: dStop <= AT_STOP_PIN_M ? t : pass.lastAtRestAt,
    };
    pass = { ...pass, firstMovedAt: pass.firstMovedAt ?? t };
    if (dStop >= DEPART_FAR_M) confirm = "far";
    else if (left) confirm = howIfLeft();
  } else if (fresh) {
    // The outbound run continues. A frozen spell it interrupts was a hold if
    // it was outside the radius and long enough; inside and short, a stutter.
    if (cand.frozenSince !== null && !cand.frozenInside) closeRun(cand.holdRuns, cand.frozenSince, prevAt);
    cand = {
      ...cand,
      steps: cand.steps + 1,
      farM: Math.max(cand.farM, dStop),
      frozenSince: null,
      frozenInside: false,
      frozenPolls: 0,
      lastInsideAt: dStop <= AT_STOP_PIN_M ? t : cand.lastInsideAt,
    };
    if (dStop >= DEPART_FAR_M) confirm = "far";
    else if (left) confirm = howIfLeft();
  } else {
    // Repeated fix while a candidate is open.
    if (left) {
      confirm = howIfLeft();
    } else {
      const since = cand.frozenSince ?? prevAt;
      const inside = cand.frozenSince === null ? dStop <= AT_STOP_PIN_M : cand.frozenInside;
      cand = { ...cand, frozenSince: since, frozenInside: inside, frozenPolls: cand.frozenPolls + 1 };
      if (inside && (cand.frozenPolls >= 3 || t - since >= STILL_MIN_MS)) {
        // Refroze inside the pin radius for long enough: a shuffle. The plateau
        // restarts at the shuffled fix, from when it was first reported.
        resolved.push(outcomeOf(pass, cand, id, "shuffle", t));
        pass = {
          ...pass,
          shuffles: pass.shuffles + 1,
          restLat: obs.lat,
          restLon: obs.lon,
          restSince: since,
          restPolls: cand.frozenPolls,
          lastAtRestAt: t,
          candidate: null,
        };
        return done();
      }
    }
  }

  if (!confirm) {
    pass = { ...pass, candidate: cand };
    return done();
  }

  // -- Departure confirmed ---------------------------------------------------
  const c = cand;
  events.push(visitEvent(pass, id, { departedAt: c.departedAt, how: confirm, confidence: CONFIDENCE_BY_HOW[confirm], cand: c, resolvedAt: t }));
  resolved.push(outcomeOf(pass, c, id, confirm, t));

  const runs = [...c.holdRuns];
  let openSince: EpochMs | null = null;
  if (c.frozenSince !== null && !c.frozenInside) {
    if (fresh) closeRun(runs, c.frozenSince, prevAt);
    else openSince = c.frozenSince; // still frozen out there: the run stays open into the leg
  }
  const from = pass;
  startTransit(from, c.departedAt, runs, openSince);

  // Where is the bus now, in the detector's terms?
  const next = from.nextAnchor ?? (anchorMoved ? anchorOf(after, obs) : null);
  if (next) {
    pass = openPass(network, next, after, obs);
  } else if (after.stationaryStopId === from.stopId && after.stationarySince === t) {
    // Re-pinned at the same stop with a fresh clock: the bus is back, or never
    // really went. A new visit to the same anchor.
    pass = openPass(network, anchorOf(after, obs), after, obs);
  } else {
    pass = null;
  }
  return done();
}

/**
 * Drive the detector AND the visit reducer over one batch of observations.
 * The detector events are exactly what `stepMany` would have returned for the
 * same batch — it is the same `step`, called in the same order — so a caller
 * can substitute this for `stepMany` without changing anything it persists
 * today. `visits` is keyed like `states` (the track key, see `trackKeyFor`)
 * and is reconciled with the same plan.
 */
export function stepManyWithVisits(
  network: TransitNetwork,
  states: Map<string, BusState>,
  visits: Map<string, VisitState>,
  observations: readonly BusObservation[],
  plan: TrackPlan = planTracks(observations),
): { events: DetectorEvent[]; visits: VisitEvent[]; resolved: CandidateOutcome[] } {
  reconcileTracks(states, plan);
  reconcileTracks(visits, plan);
  const events: DetectorEvent[] = [];
  const visitEvents: VisitEvent[] = [];
  const resolved: CandidateOutcome[] = [];
  for (const obs of observations) {
    const key = plan.keys.get(obs.busId) ?? obs.busName;
    const before = states.get(key) ?? null;
    const { state: after, events: ev } = step(network, before, obs);
    if (after) states.set(key, after);
    else states.delete(key);
    for (const e of ev) events.push(e);

    const v = stepVisit(network, visits.get(key) ?? null, before, after, obs);
    if (v.state) visits.set(key, v.state);
    else visits.delete(key);
    for (const e of v.events) visitEvents.push(e);
    for (const r of v.resolved) resolved.push(r);
  }
  return { events, visits: visitEvents, resolved };
}

/**
 * Age out visit state alongside the detector's. A track that stops reporting
 * is closed the way a broken track is, so a rest that was still open when the
 * bus went dark is recorded as unresolved rather than lost.
 */
export function pruneVisits(
  visits: Map<string, VisitState>,
  states: ReadonlyMap<string, BusState>,
): VisitEvent[] {
  const out: VisitEvent[] = [];
  for (const [key, v] of visits) {
    if (states.has(key)) continue;
    const pass = v.pass;
    if (pass && pass.pinnedAt !== null) out.push(...closePass(v, pass.lastAtRestAt).events);
    visits.delete(key);
  }
  return out;
}
