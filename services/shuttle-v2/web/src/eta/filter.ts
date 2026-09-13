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
import { MP } from "./params";
import { distancesTo, NEAR_STOP_M, type Ring } from "./ring";

/** Position noise on a fresh fix, metres. Deadband-scale, deliberately not 10 m (#88's overconfidence). */
export const SIGMA_M = 20;
/**
 * SEVEN OF THE CONSTANTS BELOW ARE RE-ESTIMABLE FROM THE FEED and are served,
 * not compiled: the step reads them through `MP` (./params), whose defaults
 * are these exact literals and which the payload's `model_params` may replace
 * (docs/closed-loop.md, stage 3). The literals stay here, beside the
 * measurement that set them, because that is where a reader looks; params.ts
 * duplicates them and `params.test.ts` pins the two equal and proves a served
 * copy of them reproduces every mass exactly. To change one by hand, change
 * BOTH — or, better, let the nightly fit publish it.
 */
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
/**
 * The same two rates for a fresh fix that has NOT left the rest — the bus
 * shuffling at the kerb, which is 91-93% of every fresh fix a standing bus
 * publishes. MEASURED against the detector's own departure instants
 * (`stop_visits.departed_at`, verified equal to `last_at_rest_at` on 511 of
 * 511 Red visits) over the archive of 2026-09-03..09-09, a fresh fix labelled
 * a DEPARTURE when it is the first one after the last poll still at rest and a
 * REPOSITION otherwise:
 *
 *   P(departure | fresh fix, still within REST_RADIUS_M of the rest point)
 *       Red 31.2% (n=3,282)   Blue Day 35.5% (n=3,834)   pooled 33.5% (n=7,116)
 *   P(departure | fresh fix, beyond it)
 *       Red 71.0% (n=  231)   Blue Day 76.3% (n=  350)   pooled 74.2% (n=  581)
 *   repositions per standing poll
 *       Red 0.1148 (2,325 / 20,253)  Blue Day 0.1188 (2,557 / 21,516)
 *
 * So the pooled `P_DEPART_ON_FRESH` and `SHUFFLE_PER_POLL` above are the
 * BEYOND-rest numbers — 0.76 against a measured 0.742, right — applied to both
 * cases, and the belief is consequently about twice as departure-happy as the
 * feed warrants on the fix that matters. Instrumented on the 9/10 replay, the
 * standing mass's mean pDepart is 0.61-0.68 for a fix inside the rest and
 * 0.72-0.75 for one beyond, against those measured 0.335 and 0.742: the model
 * is calibrated for the bus that left and charges the same evidence to the bus
 * that shuffled. That is the standing trough at its source — half the lead
 * cluster is walked out of the stand on the first kerb shuffle, the mixture
 * median lands in the standing part's lower tail, and #119's ratchet keeps it
 * for the rest of the stand.
 *
 * The step cannot discriminate and must not be used to: the fresh fix's own
 * displacement is 32 m at the median whether it is a departure or a shuffle
 * (this measurement, both classes, both routes), exactly as
 * docs/departure-derivation.md says. WHERE it lands is the evidence, not how
 * far it moved.
 *
 * These are deliberately NOT in `MP`: the daily fit's own counter
 * (`estimateVisitRates` in scripts/reestimate-lib.mjs) counts the detector's
 * `shuffles` field — repositions big enough to open a departure candidate,
 * 0.51 per visit against the 1.94 fresh fixes a visit actually publishes — and
 * pools every stop class and both zone cases, so it cannot see this split. If
 * this ships, teach that counter the split before serving either number.
 */
export const SHUFFLE_PER_POLL_IN_REST = 0.117;
export const P_DEPART_ON_FRESH_IN_REST = 0.335;

/**
 * The conditioning above, off by default. Two DISPLAY rules for this defect
 * were measured and refused (PRs #244, #245); this one is a belief change, so
 * it is switched rather than assumed, and every gate is run paired on it.
 */
let kerbShuffleEvidence = false;
export function setKerbShuffleEvidence(on: boolean): void { kerbShuffleEvidence = on; }
export function kerbShuffleEvidenceOn(): boolean { return kerbShuffleEvidence; }
/** Off-stop run -> stand hazard per second (a light, a queue). docs/eta-error-budget.md. */
export const HOLD_ENTER_PER_S = 0.01612;
/** Off-stop stand -> run hazard per second. */
export const HOLD_LEAVE_PER_S = 0.01457;
/** Leak from a stop stand on a repeat poll, per second — a pooled 4 min stand. Pricing uses the real table. */
export const STOP_LEAVE_PER_S = 1 / 240;
/**
 * The emission is a mixture: a fix is on the cell (Gaussian, σ) or it is a
 * stray — a detour, a yard, a street the published line does not draw
 * (Red #316 on 2026-09-03 ran from College / Wall up to Trumbull / Hillhouse,
 * 100+ m off the line for three polls). The stray component's weight
 * RELATIVE TO A FIX ON THE CELL is derived, not chosen:
 *
 *     ε · 2πσ² / A      ε = share of fixes off the line (~3%, gps-replay
 *                        `offRoute`), A = the area a stray fix can land in,
 *                        a band ±300 m along the loop
 *
 * ~1e-5 on Red, ~3e-6 on Green. A guessed 0.02 here let "driving on past the
 * next stop" survive a fix 85 m BEHIND the stop, on the road, at a
 * fiftieth of its mass, and out-score the reposition that had actually
 * happened (Red #304, 14:06Z 9/3); at the derived weight the fix on the road
 * wins outright, while a held branch still out-lives TELEPORT (below) when a
 * bus is genuinely off the line, because the two branches then pay the same
 * weight and only the prior decides.
 */
export const OFF_ROUTE_SHARE = 0.03;
export const OFF_ROUTE_BAND_M = 600;
export function offRouteWeight(ring: Ring): number {
  return (OFF_ROUTE_SHARE * 2 * Math.PI * SIGMA_M * SIGMA_M) / (ring.loopM * OFF_ROUTE_BAND_M);
}
/**
 * Mass moved to every cell each poll, uniformly: how a bus that really has
 * relocated (an id reissue, a feed gap, a genuine branch error) is found
 * again. 1e-4 spread over ~300 cells is 3e-7 per cell per poll — two orders
 * below the off-route weight above, so a held branch out-lives a single
 * stray fix and loses to several consistent ones.
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
  /**
   * The rest most recently ENDED, kept across the moving spell that follows:
   * the stop it was attributed to (else -1), when it began (`restSince` at the
   * time) and when the fix left it (`moved`); a rest in the approach zone is
   * not one. This is the departure the bus
   * has just made, and it exists because the served lap clock (`buses[].lap`,
   * the collector's departure) lags the belief by a poll or more — see
   * `ownDeparture` in arrival.ts. Cleared by nothing: a later rest
   * simply replaces it when IT ends.
   */
  leftStop: number;
  leftSince: number;
  leftAt: number;
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
  /** When the fix last changed (v1compat `last_moved_at`). See {@link stillSec}. */
  last_moved_at?: string | null | undefined;
}

function naiveUtcMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = new Date(s.endsWith("Z") ? s : s + "Z").getTime();
  return Number.isFinite(t) ? t : null;
}

function serverClockMs(bus: FilterBus): number | null {
  return naiveUtcMs(bus.stationary_since ?? bus.at_stop_since);
}

/**
 * How long the bus's fix has been unchanged, or Infinity when the payload does
 * not say.
 *
 * Both of the clocks `serverClockMs` reads are pinned to a stop: the collector
 * anchors them the moment a bus comes within 75 m and carries them until it is
 * 125 m away, so they keep running while a bus drives straight THROUGH a
 * stop's zone (detector.ts `stationaryFields`, and `at_stop_since` is the same
 * clock behind a gate a drive-through also passes). They answer "how long has
 * this wait been going on", which is the right question for pricing the
 * remainder of a stand and the wrong one for "is the bus still here".
 *
 * `last_moved_at` is the collector's answer to the second question. A payload
 * that does not carry it — an older server, a fixture, a replay — says nothing
 * either way, and then the served clock decides alone, exactly as before.
 */
/**
 * How far from a stop's marker a bus can be and still be standing AT it.
 *
 * Read off where buses actually come to rest, not chosen: over the 23,226
 * polls of 2026-09-08 on which a bus was demonstrably at rest inside a stop's
 * zone, its distance to that stop's coordinate was 22 m at the median, 39 m at
 * p75 and 55 m at p90. Buses pull up past the sign, so the marker is not where
 * they stand.
 *
 * Inside this radius the belief is left alone: a bus here is close enough that
 * "now" is true whether it is pulling in, pulling out, or crawling through, and
 * refusing the stand would only trade one wrong answer for another — the moving
 * half of a cold belief sits on the leg OUT of the stop, so a bus refused its
 * stand reads as a LAP away, not as "about to arrive".
 */
export const STOOD_HERE_M = 55;

function stillSec(bus: FilterBus, now: number): number {
  const t = naiveUtcMs(bus.last_moved_at);
  return t === null ? Infinity : (now - t) / 1000;
}

/**
 * Is the bus in the act of LEAVING the stop the feed says it last served?
 *
 * This is the whole of the correction, and it is deliberately narrow. Refusing
 * to believe the served clock whenever the bus is moving also catches a bus
 * that has merely SHUFFLED where it stands, or has just pulled in and not yet
 * held still for `STANDING_MIN_S` — and getting those wrong is not cheap. The
 * moving half of a cold belief sits on the leg OUT of the nearest stop, so a
 * bus refused its stand does not read as "about to arrive", it reads as a lap
 * away: on the 2026-09-08 cold-start replay, 95% of the frames a blanket rule
 * newly withheld showed the bus at the kerb as more than ten minutes off.
 *
 * A departure has a second witness, and it is the one the feed gives for free:
 * `last_stop_id` has already advanced to this stop. So both must hold — the
 * fix is moving, and upstream says the stop is behind the bus — and then the
 * bus is inside the zone of a stop it has served and is not standing at it.
 *
 * A bus at rest passes `stillSec` and is untouched whatever `last_stop_id`
 * says; a bus still approaching has the PREVIOUS stop in `last_stop_id` and is
 * untouched too. And a bus close enough to the marker to BE at it
 * ({@link STOOD_HERE_M}) is untouched whatever it is doing, because there
 * "now" is not a lie whether it is pulling in, pulling out or crawling through.
 */
function leavingLastStop(bus: FilterBus, ring: Ring, stops: readonly number[], now: number): boolean {
  if (stillSec(bus, now) >= STANDING_MIN_S) return false;
  const lsid = bus.last_stop_id ?? null;
  if (lsid === null) return false;
  for (let i = 0; i < ring.N; i++) {
    if (stops[i] !== lsid) continue;
    const d = haversineMeters(stopPoint(ring, i), bus);
    if (d > STOOD_HERE_M && d <= NEAR_STOP_M) return true;
  }
  return false;
}

/** Seconds the bus has been standing, on the clock the stand tables were measured with. */
export function standingSec(b: Belief, now: number): number {
  return Math.max(0, (now - clockOrigin(b)) / 1000);
}

/**
 * The origin of that clock, for callers that key on it: the rest's earliest
 * known origin (`restSince`), never the served clock alone. The collector's
 * clock restarts when the bus moves 125 m from where IT saw the bus come to
 * rest, and its rest point is not this filter's: a shuffle inside a layover
 * restarted the served clock while the rest identity here — correctly —
 * continued, and the residual stand restarted from zero: Blue Night #40 at
 * 22:40Z 9/3, 237 -> 749 s two minutes before it left, a strand for every
 * rider down the line. The stand tables are arrival-to-departure at the
 * stop, so the time since the rest began is the clock they were measured
 * with.
 */
export function clockOrigin(b: Belief): number {
  return b.restSince;
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

/** The published coordinate of stop `i` — the cell the ring puts on the marker. */
function stopPoint(ring: Ring, i: number): LatLon {
  const c = ring.stopCell[i]!;
  return { lat: ring.lat[c]!, lon: ring.lon[c]! };
}

function restMaskFor(ring: Ring, point: LatLon): Uint8Array {
  const d = distancesTo(ring, point);
  const mask = new Uint8Array(ring.C);
  for (let c = 0; c < ring.C; c++) if (d[c]! <= REST_RADIUS_M) mask[c] = 1;
  return mask;
}

/** The zone (stop, approach) holding most of the standing mass inside the rest mask. */
/**
 * Which stop a rest is at, read off the belief: the zone holding the most
 * standing mass inside the rest mask — and only if that zone holds the
 * MAJORITY of the standing mass there. The mask is 125 m wide and a stop's
 * zone 75 m, so a bus that came to a hold 190 m past a stop has that stop's
 * kerb inside its mask; with a sliver of mass on the kerb and the rest on
 * the road, the rest is a hold on the road (restStop -1), not a return to
 * the stop it just left (Blue Night #40, 22:44Z 9/3: "now" flipping to a
 * lap away and back as the rest re-attached to the stop behind it).
 */
function restStopFromBelief(ring: Ring, p: Float64Array, mask: Uint8Array): { restStop: number; restApproach: boolean } {
  const byZone = new Map<number, number>();
  let inMask = 0;
  for (let c = 0; c < ring.C; c++) {
    if (mask[c] !== 1 || p[c]! <= 0) continue;
    inMask += p[c]!;
    const zk = ring.nearStop[c]! >= 0 ? ring.nearStop[c]! : ring.approachOf[c]! >= 0 ? 1000 + ring.approachOf[c]! : -1;
    if (zk < 0) continue;
    byZone.set(zk, (byZone.get(zk) ?? 0) + p[c]!);
  }
  let best = -1, bestMass = 0;
  for (const [zk, m] of byZone) if (m > bestMass) { bestMass = m; best = zk; }
  if (best < 0 || bestMass < 0.5 * inMask) return { restStop: -1, restApproach: false };
  return best >= 1000 ? { restStop: best - 1000, restApproach: true } : { restStop: best, restApproach: false };
}

function initBelief(ring: Ring, bus: FilterBus, now: number, stops: readonly number[]): Belief {
  const C = ring.C;
  const p = new Float64Array(2 * C);
  const d = distancesTo(ring, bus);
  const since = serverClockMs(bus);
  const age = since === null ? 0 : (now - since) / 1000;
  // A warm belief decides this from its own fixes — it watches the bus and
  // sees it move — and it gets it right: on the incident below, a tracked
  // belief dropped #307 to next-lap on the very poll it pulled out. A COLD
  // belief has one frame and no history, so it believed the served clock, and
  // the served clock is pinned to a stop and runs on through a drive-past.
  //
  // Red #307, Division / Prospect, 2026-09-08 10:35:15 ET: `stationary_since`
  // 20 s old, `at_stop_id` 48, and the bus 67 m beyond the stop doing 6.6 m/s,
  // having served it ten seconds earlier. A fresh page load priced it `eta 0`
  // — "now, then 67 min" — and the rider's actual bus was 11.5 min away.
  //
  // `last_moved_at` is the evidence the warm belief builds for itself, handed
  // over in the payload; `leavingLastStop` is where it is spent, and why it is
  // spent narrowly. Where the payload does not carry the clock — an older
  // server, a fixture, a replay — the served clock decides alone, as before.
  const standing = since !== null && age >= STANDING_MIN_S && !leavingLastStop(bus, ring, stops, now);
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
    fixAt: now, restPoint: { lat: bus.lat, lon: bus.lon }, restSince: since ?? now,
    rested: standing, restStop: -1, restApproach: false, restMask,
    leftStop: -1, leftSince: 0, leftAt: 0,
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
    // A stand in the approach zone of a LAYOVER stop is that layover
    // (hopPricing.ts #130): its anchor leg is the stop's, so the lead and the
    // pricing agree. A stand short of a kerb stop is a hold on the road.
    b.standLeg[c] = z.stop >= 0 && (!z.approach || ring.layover[z.stop] === 1) ? z.stop : ring.leg[c]!;
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
  // Has the fix left the rest? The collector's own rule (STATIONARY_RADIUS_M):
  // inside the radius the bus is still where it came to rest, whatever the
  // published line says.
  const leftRest = fresh && haversineMeters(prev.restPoint, bus) > REST_RADIUS_M;
  const q = new Float64Array(2 * C);
  const p = prev.p;
  const hIn = Math.min(0.5, MP.HOLD_ENTER_PER_S * dt);
  const cellM = ring.loopM / ring.C;

  if (fresh) {
    // The joint of transition and the mode's own likelihood for "the fix
    // changed": P(fresh | standing) = 1 - P_REPEAT_STAND, P(fresh | moving)
    // = 1 - P_REPEAT_MOVE. Without the first factor a single crawl repeat
    // left a standing ghost that fresh fixes never cancelled (review, 9).
    const stood = prev.rested ? standingSec(prev, prev.seenAt) : 0;
    // THE FIX MOVED BUT THE BUS HAS NOT LEFT THE REST.
    //
    // `leftRest` above is the collector's own standing rule
    // (STATIONARY_RADIUS_M): inside the radius the bus is still where it came
    // to rest, whatever the published line says. The emission already honours
    // that — a cell outside `restMask` gets no stray floor while the rest
    // holds — but the TRANSITION did not: the departure kernel walked standing
    // mass forward out of the rest, into MOVE, on a fix that was still inside
    // it. So a bus shuffling at a kerb mid-layover was re-read as a bus
    // pulling out: the lead cluster split, the mixture median fell into the
    // standing tail, and #119's ceiling then held that trough for the whole
    // stand (Red #310, 12:21 ET 2026-09-11: 466 -> 169 s held ten minutes
    // while the truth fell 795 -> 195 s; median shown deficit on layover rests
    // 171 s, 59.5% of it the estimate rather than the ratchet).
    //
    // The rule is the collector's rule applied to the kernel: while the fix is
    // inside the rest, standing mass inside the rest's extent does not depart,
    // it repositions. It is NOT a rate — two rate-based forms were measured
    // and refused (P_DEPART_ON_FRESH_IN_REST below, PR #246: applying the
    // measured 33.5% flatly still collapses the number a poll early and fails
    // `accuracy-layover.test.ts`; correcting only from the SECOND consecutive
    // in-rest fresh fix, PR #247, is inert because the first fix has already
    // moved 62-77% of the mass out of the stand). A rate cannot be right here:
    // a genuine departure's own first step is 30-35 m, which is inside the
    // radius too (docs/departure-derivation.md), so any rate splits the
    // cluster on exactly the poll it should not.
    //
    // The case for it: P(departure | fresh fix still inside the rest radius) is
    // 33.5% over 7,116 such fixes on Red and Blue Day, against 74.2% beyond it,
    // and 91-93% of all fresh fixes during a stand are inside. The argument for
    // its safety was that it cannot delay a real departure past the rest — the
    // first fix beyond REST_RADIUS_M sets `leftRest`, which ends the rest by
    // construction (`moved` below) and prices the bus as driving on that poll.
    //
    // MEASURED AND REFUSED, 2026-09-11, and that argument is why: the bound
    // arrives three polls late. `accuracy-layover.test.ts`'s departure-collapse
    // assertion fails — on the recorded Red #309 pass the board must fall to
    // 0.7x its standing value within two polls of the departure, and it reads
    // 88.3 s against an 83.1 s bound (master 41.4 s). A departing bus is still
    // INSIDE the radius for its first three polls:
    //
    //   poll (ET)   d from rest   truth    master   this rule
    //   12:33:18         0 m       70 s     118.7       118.7
    //   12:33:33        65 m       55 s      41.4        88.8
    //   12:33:48        65 m       40 s      85.7        88.3   (repeat fix)
    //   12:34:03       101 m       25 s      34.8        76.1
    //   12:34:18       167 m       10 s      20.4        21.8   (rest ends)
    //
    // so the worst moment costs a rider +51 s of pessimism where master costs
    // +10 s. And step SIZE cannot rescue it: on that same pass the kerb
    // shuffles DURING the stand are 103-155 m from the rest point while the
    // departure's own first step is 65 m — the shuffle moves further than the
    // departure, so no displacement threshold separates them. What does
    // separate them is that a shuffle comes BACK, which is only visible a poll
    // or two later, i.e. after the two-poll window the gate measures; the switch stays off
    // and every other caller prices exactly as before.
    //
    // Restricted to a rest with an IDENTITY (`restStop >= 0`), exactly as the
    // emission's `held` is and for the same measured reason: a rest the belief
    // cannot name is where the branch is least certain (Purple's fold detour),
    // and it keeps its escape hatch.
    const heldRest = kerbShuffleEvidence && prev.rested && prev.restStop >= 0 && !leftRest;
    const shufflePoll = MP.SHUFFLE_PER_POLL * (dt / 5);
    const fromStand = 1 - MP.P_REPEAT_STAND;
    const departKern = Float64Array.from(DEPART_KERNEL);
    for (let c = 0; c < C; c++) {
      const inZone = ring.nearStop[c]! >= 0 || ring.approachOf[c]! >= 0 || (prev.rested && prev.restMask[c] === 1);
      const fromMove = 1 - (inZone ? MP.P_REPEAT_MOVE_ZONE : MP.P_REPEAT_MOVE);
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
        // Inside the rest, with the fix inside it too: no walk out of the mask
        // (see above). The mass spreads through the shuffle kernel and stays
        // STANDING, which is what `standZone` prices as the rest stop's own
        // remaining stand.
        if (heldRest && prev.restMask[c] === 1) {
          pDepart = 0;
        } else if (canShuffle) {
          const z = standZone(prev, ring, c);
          const table = z.stop >= 0 ? ring.stand[z.stop] : null;
          if (table) {
            const hd = hazard(table, stood) * dt;
            pDepart = hd / (hd + shufflePoll);
          } else {
            pDepart = MP.P_DEPART_ON_FRESH;
          }
        }
        // Through `advance`, so a first step that lands ON a stop cell is
        // captured as an arrival there (an arriving bus that paused 40 m
        // short of the marker read as departing when this landed directly).
        if (pDepart > 0) advance(q, ring, c, mStand * pDepart, departKern, hIn);
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
    const off = offRouteWeight(ring);
    // A fix that is off the line carries almost no positional weight: at
    // 93 m the Gaussian is 2e-5, barely above the stray floor, so the
    // TRANSITION decides and the departure hazard walks the bus on. That is
    // how Red #304 — resting in the Science Park Garage lot, 93-154 m off
    // Red's line — had half its mass past 344 Winchester on the poll it
    // drove back toward the road, and a rider at Winchester / Division was
    // shown "in 9 s" for a bus three and a half minutes away.
    //
    // But the fix says something the line cannot: it is 37 m from where the
    // bus came to rest. While the rest still holds — the fix inside
    // REST_RADIUS_M of the rest point, the collector's own definition of
    // standing — a cell outside the rest's extent is not somewhere the bus
    // can be, so it gets no stray floor. Cells inside keep it, and TELEPORT
    // still re-finds a bus that really has relocated. The moment the fix
    // leaves the radius the rest ends and the floor is back everywhere.
    //
    // Only for a rest that has an IDENTITY (`restStop`), and that is the
    // measurement talking, not taste. Applied to every rest — including the
    // ones the belief cannot name, a hold at a light, a yard mid-leg — the
    // 9/4 gps-replay moved Purple's median 102.9 -> 105.0 s and Orange
    // East's 48.1 -> 48.5, which is Purple's known fold detour (§ the open
    // fold): the bus sits on a parallel street that IS another leg's
    // published line, and the stray floor is exactly what lets consistent
    // fixes pull the belief onto the branch it is really on. A rest we
    // cannot name is the case where the branch is least certain, so it
    // keeps its escape hatch. Restricted to named rests, no route is worse
    // and Blue Night's p90 comes down.
    const held = prev.rested && prev.restStop >= 0 && !leftRest;
    for (let c = 0; c < C; c++) {
      const e = Math.exp(-(d[c]! * d[c]!) / (2 * SIGMA_M * SIGMA_M))
        + (held && prev.restMask[c] !== 1 ? 0 : off);
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
      const hLeave = Math.min(0.5, (atStop ? STOP_LEAVE_PER_S : MP.HOLD_LEAVE_PER_S) * dt);
      const stay = mStand * MP.P_REPEAT_STAND;
      const leak = stay * hLeave;
      const movedRepeat = mMove * (atStop ? MP.P_REPEAT_MOVE_ZONE : MP.P_REPEAT_MOVE);
      q[c] = q[c]! + stay - leak + movedRepeat * hIn;
      q[C + c] = q[C + c]! + leak + movedRepeat * (1 - hIn);
    }
  }

  // A fix beyond the rest radius is the bus having left where it rested —
  // EXCEPT when what it left was the approach to a layover it was already
  // serving, and where it arrived is that same layover's marker. Then it has
  // closed the last metres of a wait it has been serving all along
  // (docs/eta-ring-posterior.md, "the second stand"): Red #310 rested 147 m
  // short of 344 Winchester for 7 min, rolled in, and the board stepped UP
  // 185 s as the stop's whole stand was charged a second time; Red #304 did
  // the same from the garage lot, 83 m short, for 154 s. The rest continues,
  // RE-CENTRED on the marker so the mask and the next radius test are taken
  // from where the bus now stands, and its clock stays the earliest known
  // origin — the same principle as the shuffle, across a short roll-in.
  //
  // It is as narrow as the approach zone it replaces: the previous rest must
  // already have been ATTRIBUTED to that stop (`restApproach`, the majority
  // rule in `restStopFromBelief`), the stop must be a layover by its own
  // stand table, and the fix must be inside the stop's own zone. A bus that
  // rests short of a stop and drives PAST it is beyond NEAR_STOP_M and
  // departs normally; a rest short of a KERB stop is a hold on the road and
  // is never attributed to it, so pulling in there is a genuine new stand.
  const closedIn = leftRest && prev.rested && prev.restApproach && prev.restStop >= 0
    && ring.layover[prev.restStop] === 1
    && haversineMeters(stopPoint(ring, prev.restStop), bus) <= NEAR_STOP_M;
  const moved = leftRest && !closedIn;
  const since = serverClockMs(bus);
  const b: Belief = {
    ringKey: ring.key, p: q, seenAt: now, lastObs: bus,
    lastFix: fresh ? { lat: bus.lat, lon: bus.lon } : prev.lastFix,
    fixAt: fresh ? now : prev.fixAt,
    restPoint: moved || closedIn ? { lat: bus.lat, lon: bus.lon } : prev.restPoint,
    // The rest's clock is its EARLIEST known origin: the server's clock
    // when served (the collector's, which the stand tables were measured
    // with), else the local one — and a creep inside the radius that costs
    // the served clock must not restart the residual from zero. The roll-in
    // costs it too: `at_stop_since` begins at the marker, minutes after the
    // bus actually stopped.
    restSince: moved ? (since ?? now) : Math.min(prev.restSince, since ?? Infinity),
    rested: moved ? false : prev.rested,
    restStop: moved ? -1 : prev.restStop,
    // At the marker the rest is the stop's own, no longer its approach.
    restApproach: moved || closedIn ? false : prev.restApproach,
    // A named rest ending is a departure the belief has seen and the served
    // clock has not yet: remember which stop, and when. A rest in the stop's
    // APPROACH zone is a hold short of it, not a visit, and is not recorded.
    leftStop: moved && prev.restStop >= 0 && !prev.restApproach ? prev.restStop : prev.leftStop,
    leftSince: moved && prev.restStop >= 0 && !prev.restApproach ? prev.restSince : prev.leftSince,
    leftAt: moved && prev.restStop >= 0 && !prev.restApproach ? now : prev.leftAt,
    restMask: moved || closedIn ? restMaskFor(ring, bus) : prev.restMask,
    serverSince: since,
    lastStopId: prev.lastStopId, lead: prev.lead, leadDisagreeSince: prev.leadDisagreeSince, fresh,
    standLeg: moved || closedIn ? new Int32Array(C) : prev.standLeg,
    zoneKey: moved || closedIn ? new Int32Array(C) : prev.zoneKey,
  };
  applyLastStop(b, ring, bus, stops);
  normalise(b.p);
  // The rest is established by a repeated fix (or a server clock already
  // running), and its stop is read off the belief at that moment.
  let restChanged = moved || closedIn;
  // The same soundness as the cold start above: the served clock's age is not
  // by itself evidence of a stand, because it is pinned to a stop and runs on
  // through a bus that is merely driving past. A repeated fix (`!fresh`) IS
  // evidence and is untouched; the served-clock arm now has to agree with the
  // movement clock when the payload carries one.
  const servedSaysStanding = since !== null
    && (now - since) / 1000 >= STANDING_MIN_S
    && !leavingLastStop(bus, ring, stops, now);
  if (!b.rested && (!fresh || servedSaysStanding)) {
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
  /** Share of the situation's mass inside the rest radius of an established rest. */
  inRest: number;
}

export function situations(b: Belief, ring: Ring, minMass = 0.01): Situation[] {
  const C = ring.C, N = ring.N;
  // Accumulators indexed by (anchor leg * 2 + mode); zone tallies per key.
  const mass = new Float64Array(2 * N), frac = new Float64Array(2 * N), cell = new Float64Array(2 * N), rest = new Float64Array(2 * N);
  const zoneMass = new Map<number, number>();
  const p = b.p;
  const masked = b.rested && b.restStop >= 0;
  for (let c = 0; c < C; c++) {
    const ms = p[c]!, mm = p[C + c]!;
    const inMask = masked && b.restMask[c] === 1;
    if (ms > 0) {
      const k = b.standLeg[c]! * 2;
      mass[k] = mass[k]! + ms; frac[k] = frac[k]! + ms * ring.frac[c]!; cell[k] = cell[k]! + ms * c;
      if (inMask) rest[k] = rest[k]! + ms;
      const zk = k * 4096 + (b.zoneKey[c]! + 1);
      zoneMass.set(zk, (zoneMass.get(zk) ?? 0) + ms);
    }
    if (mm > 0) {
      const k = ring.leg[c]! * 2 + 1;
      mass[k] = mass[k]! + mm; frac[k] = frac[k]! + mm * ring.frac[c]!; cell[k] = cell[k]! + mm * c;
      if (inMask) rest[k] = rest[k]! + mm;
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
      inRest: rest[k]! / m,
    });
    total += m;
  }
  for (const s of out) s.mass /= total || 1;
  out.sort((x, y) => y.mass - x.mass);
  return out;
}
