import { distanceMeters } from "../network/geo.js";
import type { TransitNetwork } from "../network/TransitNetwork.js";
import type { EpochMs, Stop } from "../schema/api.js";

// Inputs ----------------------------------------------------------------------

export interface BusObservation {
  busId: number;
  busName: string;
  routeId: number;
  lat: number;
  lon: number;
  heading: number;
  lastStopId: number | null;
  collectedAt: EpochMs;
}

/**
 * The identity fields every per-vehicle map entry carries, and the minimum
 * `reconcileTracks` needs to re-file an entry when its track key moves.
 */
export interface TrackedIdentity {
  /** Upstream's `bus_id`. Reissued per service block — NOT a vehicle identity. */
  busId: number;
  /** The fleet number riders see (`#40`, `#317`). Stable across id reissues. */
  busName: string;
}

// Per-bus state. The detector is a pure reducer over these.
export interface BusState extends TrackedIdentity {
  routeId: number;
  nearestStopId: number;
  /**
   * Index of `nearestStopId` in the route's raw stop sequence.
   *
   * The stop id alone is not a position. Two routes need the distinction:
   * the West Campus routes list some stops twice (route 10 is
   * `…26,25,24,23,22,23,24,25,26,72`), so an id maps to two places; and
   * routes that double back put physically-adjacent stops far apart in the
   * sequence, so "the nearest stop" is not necessarily "the next stop".
   * Carrying the index makes hop counts exact instead of inferred.
   */
  nearestIndex: number;
  /** When the bus first became nearest to `nearestStopId`. */
  enteredAt: EpochMs;
  /** Most recent observed position (for staleness checks). */
  lastObservedAt: EpochMs;
  /** Latitude of the most recent observation — the discontinuity check's baseline. */
  lat: number;
  /** Longitude of the most recent observation. */
  lon: number;
  /**
   * When the bus last STARTED standing still at the stop it is waiting at.
   *
   * `enteredAt` is anchored to `nearestIndex`, so it restarts whenever a
   * different stop becomes nearest — and a bus that shuffles a few metres
   * while parked (pulling out of the garage lane at 344 Winchester, 2026-09-03)
   * flips the nearest stop and restarts it. The rider then saw "⏸ 45s" beside
   * a bus that had been sitting nearly its whole ~10 min layover, the stall
   * credit went to almost nothing, and the ETA charged the layover a second
   * time.
   *
   * This clock measures what a rider watching the bus would say. Kept
   * deliberately SEPARATE from `enteredAt`: the dwell and segment events
   * feeding calibration still key on the nearest-stop anchor, so this cannot
   * change any statistic, only what the live payload reports.
   */
  stationarySince: EpochMs;
  /**
   * The point `stationarySince` is measured from — the FRAME, and the whole
   * subject of the 2026-09-03 fix.
   *
   * While the bus is at a stop this is the STOP's own position (see
   * {@link stationaryStopId}). Only when it is standing somewhere that is not
   * a stop does it fall back to where the bus itself came to rest.
   */
  stationaryLat: number;
  stationaryLon: number;
  /**
   * The stop {@link stationaryLat}/{@link stationaryLon} is pinned to, or null
   * while the bus is standing somewhere that is not a stop.
   *
   * Pinning to the stop rather than to the bus is what makes the clock survive
   * a yard shuffle, and a replay of 81,617 production positions is what chose
   * it: anchoring on the bus, a parked bus's own per-visit maximum excursion
   * from its resting point is 64.4 m at p50 and 94.7 m at p90, because the
   * anchor is laid down during roll-in at the EDGE of the stop and the bus then
   * settles ~64 m away. Measured from the stop instead, the same distribution
   * falls to 60.0 m / 73.8 m with the departure signal unchanged.
   *
   * Arriving at a DIFFERENT stop always restarts the clock — a different stop
   * is a different wait. That rule is what stops a stale clock from following
   * a bus to its next stop and over-cancelling the dwell there, which is the
   * direction that makes an ETA too SHORT and has a rider miss the bus.
   */
  stationaryStopId: number | null;
}

// Outputs ---------------------------------------------------------------------

export interface ArrivalEvent {
  kind: "arrival";
  busId: number;
  busName: string;
  routeId: number;
  stopId: number;
  arrivedAt: EpochMs;
}

export interface DwellEvent {
  kind: "dwell";
  busId: number;
  busName: string;
  /**
   * The `busId` in force when the bus *arrived* at `stopId`, which is what the
   * matching `arrivals` row was written under. Usually equal to `busId`, but
   * upstream reissues a bus's id at every service-block boundary, so a dwell
   * that spans a reissue is emitted under the new id while the row it patches
   * carries the old one. Without this the patch silently matches nothing.
   */
  anchorBusId: number;
  routeId: number;
  stopId: number;
  enteredAt: EpochMs;
  leftAt: EpochMs;
  dwellSec: number;
}

export interface SegmentEvent {
  kind: "segment";
  busId: number;
  busName: string;
  routeId: number;
  fromStopId: number;
  toStopId: number;
  /** Hops along the route loop from `fromStopId` to `toStopId`. */
  hops: number;
  travelSec: number;
  startedAt: EpochMs;
}

export type DetectorEvent = ArrivalEvent | DwellEvent | SegmentEvent;

// Tuning constants ------------------------------------------------------------

/**
 * Minimum time at a stop before its dwell counts as real. Filters out the
 * one-poll blips from a bus passing through without stopping (the upstream
 * feed updates every 5 s, so anything under 15 s is almost certainly noise).
 */
export const MIN_DWELL_SEC = 15;

/**
 * Maximum dwell to record. Beyond this, we treat the bus as out-of-service
 * (garaged, broken down) rather than dwelling — keeps obvious outliers out
 * of the dwell calibration.
 */
export const MAX_DWELL_SEC = 30 * 60;

/**
 * Maximum hop count to treat as a usable segment sample. The longest route
 * lists 33 stops, so a 1- or 2-hop transition is normal; 6+ usually means a
 * feed gap or GPS teleport and shouldn't pollute the segment-time
 * calibration.
 */
export const MAX_SEGMENT_HOPS = 5;

/**
 * Minimum travel time for a segment sample to be believable. The feed
 * updates every 5 s, so a sub-10 s "segment" is a bus straddling the midpoint
 * between two stops and flapping between them on GPS noise, not a bus that
 * drove anywhere. Left unchecked these dominate: the calibrator takes the
 * median of each segment's samples, so a stationary bus that flaps for ten
 * minutes contributes ~120 five-second samples and can drag a real 90 s
 * segment estimate down to nothing.
 *
 * At the extreme, a duplicate row for one bus in a single payload yields
 * `travelSec: 0` — that case is also filtered in the collector, but the
 * detector is a pure reducer that anything can feed, so it defends itself.
 */
export const MIN_SEGMENT_SEC = 10;

/**
 * Upper bound on a believable segment. Beyond this the bus was parked,
 * garaged or off-route between the two observations — the same reasoning as
 * {@link MAX_DWELL_SEC}, which already caps the dwell half of the transition.
 * The longest real segment observed on this network averages ~10 min
 * (route 9's downtown → West Campus run), so 45 min is a wide margin.
 */
export const MAX_SEGMENT_SEC = 45 * 60;

/**
 * How many entries ahead of a bus's current position in the route sequence
 * are eligible to become its next anchor.
 *
 * At 5 s polling a bus advances at most one stop per tick, so 2 covers a
 * skipped poll with room to spare. Wider is measurably WORSE, not merely
 * looser: with a large window the anchor can leap two or three stops in one
 * tick, and every leg it leaps over loses its sample. Swept over 59,605
 * recorded positions, legs with at least one sample went 224 (lookahead 2) →
 * 221 (3) → 219 (5) → 215 (8), out of 232 legs on routes that ran that day.
 *
 * The failure mode when a bus really does advance further than the window is
 * safe: nothing in the window is close, the global fallback fires, and we
 * re-anchor with an arrival only. We lose one sample rather than record a
 * wrong one.
 */
export const ANCHOR_LOOKAHEAD = 2;

/**
 * How much closer than the lookahead window's best candidate some other stop
 * on the route must be before we accept that the bus has left the modelled
 * path and re-anchor to it.
 *
 * The value has to clear GPS noise and the width of a street — the (N)/(S)
 * pairs this exists to defeat are 28–160 m apart — while still catching a
 * genuine detour. Swept over the same 59,605 positions at lookahead 2:
 * 50 m → 215 legs (too eager to fall back; the twin steals the anchor again),
 * 150 m → 224, 250 m → 223, 400 m → 222, no-fallback-at-all → 221.
 */
export const ANCHOR_SLACK_M = 150;

/**
 * Gap between observations after which we discard prior dwell state.
 * The bus was off the radar long enough that any pending segment time would
 * include the missing window and be misleading.
 */
export const MAX_OBSERVATION_GAP_MS = 10 * 60_000;

/**
 * How far a bus may stray from where its wait is anchored and still count as
 * standing in the same place.
 *
 * This is a fallback radius: while the bus is at a stop the wait is pinned to
 * the stop and survives ANY shuffle inside {@link AT_STOP_PIN_M} of it (see
 * {@link BusState.stationaryStopId}). The radius only decides matters once the
 * bus is outside that — either standing somewhere that is not a stop, or
 * genuinely pulling away.
 *
 * 125 m, from a replay of production `raw_positions` (PR #63, which adds
 * `scripts/eta-replay/layover-replay.ts` and `docs/layover-clock.md`).
 * Distance alone cannot separate parked from departed on this feed: a bus one
 * poll into its departure has moved 32.4 m, the same ~30 m quantum as a
 * shuffle, and the parked p50 maximum (60 m) is under the departed-at-2-polls
 * p50 (64.5 m). What separates them is the frame, not the number. 125 m is
 * chosen because the residual error is already zero there, and because it
 * stays under the 160 m widest (N)/(S) stop pair on this network, so the
 * fallback radius can never swallow a neighbouring stop.
 */
export const STATIONARY_RADIUS_M = 125;

/**
 * How close to a stop a bus must be for its wait to be pinned to that stop.
 *
 * Deliberately the same 75 m as `AT_STOP_MAX_M` in `collector.ts`, which is
 * the radius the payload uses to call a bus "at" a stop at all: the clock is
 * pinned over exactly the region where a rider can see it. `detector.test.ts`
 * pins the two equal so they cannot drift apart.
 */
export const AT_STOP_PIN_M = 75;

/** The fields {@link stationaryFields} carries. */
export type StationaryState = Pick<
  BusState,
  "stationarySince" | "stationaryLat" | "stationaryLon" | "stationaryStopId"
>;

/**
 * What the recorded feed says about the stand a bus is already in — the pure
 * half of the restart seed.
 *
 * Every field is the reducers' own quantity, reconstructed from
 * `raw_positions` rather than from state this process never had:
 * `stationarySince` is the clock (`at_stop_since`, and `stop_visits.pinned_at`),
 * and the three rest fields are what `departure.ts` would be holding had it
 * watched the whole stand.
 */
export interface StandRun extends StationaryState {
  /**
   * Earliest sample reachable from `obs` with no hole longer than
   * {@link MAX_HANDOFF_GAP_MS}, distance ignored.
   *
   * The bound on how far back a CALLER may join anything to this observation.
   * `stationarySince` cannot serve for that: it is the first sample inside the
   * pin radius, and a bus rolling in is anchored to the stop well before it
   * gets there (`pinned_at − anchored_at` is a median 10 s but a p95 of 95 s),
   * so an arrival row for this very stand routinely predates it.
   */
  unbrokenSince: EpochMs;
  /**
   * Start of the FIRST resting plateau inside the run — the visit's
   * `arrivedAt`. Null when the bus never came to rest in it (still rolling in).
   */
  restedSince: EpochMs | null;
  /**
   * Start of the plateau `obs` itself sits on, or null when `obs` is a fresh
   * fix — i.e. the bus is moving right now and this is not a stand to resume.
   */
  restSince: EpochMs | null;
  /** Repeated polls of that plateau inside the run. */
  restPolls: number;
}

/**
 * Recovers the state of a bus the detector is seeing for the FIRST time, from
 * history the detector itself does not hold.
 *
 * `states` is in-memory only, so every process restart makes each bus a first
 * sighting again — and a bus standing at a stop across one had its wait
 * restarted from zero. On 2026-09-04 six deploys landed between 15:48 and
 * 15:58 UTC; #44 sat at 333 Cedar from 15:53:39 to 16:03:34 and was re-arrived
 * four times (15:53:39, 15:55:11, 15:56:53, 15:59:14), so the rider watching it
 * saw "⏸ 1min" beside a bus four and a half minutes into its layover, and the
 * stall credit went with it. That is what report #100 caught — the first from
 * an outside rider.
 *
 * The seed is consulted ONLY when `prev` is null. Every other re-anchor (a long
 * gap, a route change, an id reissue across a layover) restarts the clock
 * deliberately and must keep doing so.
 *
 * Returning null means "no better answer than now", which is the old behaviour.
 */
export type StationarySeed = (
  obs: BusObservation,
  anchorStop: Stop | null,
) => StandSeed | null;

/**
 * A {@link StandRun} the caller has been able to match to the `arrivals` row
 * the stand already opened.
 *
 * Only the caller can decide that — the rule is pure and has no database — so
 * `enteredAt` is filled in by the collector and is null everywhere else,
 * including in every test that feeds {@link seedStationaryFromHistory}
 * straight into {@link step}.
 */
export interface StandSeed extends StandRun {
  /**
   * `arrivals.arrived_at` of the row this stand opened before the restart, or
   * null when there is none to resume.
   *
   * Non-null makes {@link step} RESUME the visit: it takes this as
   * `enteredAt` and emits no arrival event, so one stand keeps one row and the
   * departure closes that row with the whole stand rather than the sliver
   * after the restart.
   */
  enteredAt?: EpochMs | null;
}

/** One recorded position, as `raw_positions` stores it. */
export interface PositionSample {
  lat: number;
  lon: number;
  collectedAt: EpochMs;
}

/**
 * The {@link StationarySeed} rule itself, over history the caller has already
 * fetched. Pure, so the production feed can be replayed through it.
 *
 * Deliberately the mirror of {@link stationaryFields} case 1 — the wait began
 * at the earliest sample of an unbroken run within {@link AT_STOP_PIN_M} of
 * this very stop, and a shuffle inside that radius does not end it. Two limits
 * keep the answer honest:
 *
 *  - {@link MAX_HANDOFF_GAP_MS} ends the run at a feed absence. A bus that went
 *    off the air is one the live rules re-anchor anyway, so the seed must not
 *    reach across the gap and claim a wait the running process would have
 *    thrown away.
 *  - The caller's window bounds how far back it can look at all.
 *
 * The rest fields mirror `departure.ts`'s plateau bookkeeping over the same
 * run, because the feed repeats a coordinate rather than interpolating: a
 * plateau begins at the poll on which the repeating fix was FIRST reported,
 * which is what `Pass.restSince` holds and what `arrivedAt` is taken from.
 *
 * `history` is newest-first (the order the index yields) and must exclude `obs`
 * itself. `null` means "no better answer than now" — the behaviour without a
 * seed at all.
 */
export function seedStationaryFromHistory(
  history: readonly PositionSample[],
  obs: BusObservation,
  anchorStop: Stop | null,
): StandRun | null {
  // Not at a stop: there is nothing to pin to, and `stationaryFields`'s
  // fallback-radius branch reaches the same answer without any history.
  if (!anchorStop || distanceMeters(obs, anchorStop) > AT_STOP_PIN_M) return null;
  let since = obs.collectedAt;
  let unbrokenSince = obs.collectedAt;
  let inRun = true;
  // Newest-first, so this collects the run in reverse.
  const run: PositionSample[] = [];
  for (const sample of history) {
    if (unbrokenSince - sample.collectedAt > MAX_HANDOFF_GAP_MS) break;
    unbrokenSince = sample.collectedAt;
    if (!inRun) continue;
    if (distanceMeters(sample, anchorStop) > AT_STOP_PIN_M) {
      // The pinned run ends here, but the observed one may not: keep walking so
      // `unbrokenSince` can reach back over the roll-in.
      inRun = false;
      continue;
    }
    since = sample.collectedAt;
    run.push(sample);
  }
  if (since >= obs.collectedAt) return null;

  // Oldest-first, with `obs` on the end: the plateaus as the reducer sees them.
  const ordered: PositionSample[] = run.reverse();
  ordered.push({ lat: obs.lat, lon: obs.lon, collectedAt: obs.collectedAt });
  let restedSince: EpochMs | null = null;
  let plateauStart = ordered[0]!.collectedAt;
  let plateauPolls = 0;
  for (let i = 1; i < ordered.length; i++) {
    const before = ordered[i - 1]!;
    const now = ordered[i]!;
    if (before.lat === now.lat && before.lon === now.lon) {
      plateauPolls++;
      if (restedSince === null) restedSince = plateauStart;
    } else {
      plateauStart = now.collectedAt;
      plateauPolls = 0;
    }
  }

  return {
    stationarySince: since,
    // Pinned to the STOP, exactly as `stationaryFields` would have stored it:
    // the frame is the stop, not wherever the bus came to rest.
    stationaryLat: anchorStop.lat,
    stationaryLon: anchorStop.lon,
    stationaryStopId: anchorStop.id,
    unbrokenSince,
    restedSince,
    // A fresh fix on this very poll means the bus is moving; there is no
    // plateau to hand the visit reducer and nothing to resume.
    restSince: plateauPolls > 0 ? plateauStart : null,
    restPolls: plateauPolls,
  };
}

/**
 * Carry the stationary clock when the bus has not actually gone anywhere,
 * restart it when it has.
 *
 * Three cases, in order:
 *
 *  1. **At the same stop as last time** — the clock is carried, unconditionally.
 *     Not "carried unless the bus moved a bit": a bus repositioning inside its
 *     own stop has not started a new wait no matter how far across the yard it
 *     shuffles, and the anchor is never re-based, so a slow creep cannot
 *     ratchet it either.
 *  2. **At a DIFFERENT stop** — a different stop is a different wait. Restart,
 *     pinned to the new stop. This is the rule that stops a stale clock
 *     following a bus onward and over-cancelling the dwell at its next stop.
 *  3. **Not at a stop** — fall back to a plain radius around whatever the clock
 *     is anchored to (the stop it was pinned to, or the bus's own resting
 *     point). Past {@link STATIONARY_RADIUS_M} the bus has left; restart.
 *
 * The bug this replaced anchored case 3 on the BUS and re-anchored on every
 * breach, so each ~30 m creep around a garage yard ratcheted the clock forward.
 * Red #316 at 344 Winchester lost its clock on all six of its layovers in a
 * 7 h window, each time 55–80 s before it actually pulled out — 340 s thrown
 * away on the one the operator filed as urgent (#82, "it jumped from 3min to
 * 8 min!"). Fleet-wide that fired on 73.7% of layovers and inflated a
 * rider-visible ETA on 50.0% of them.
 */
function stationaryFields(
  prev: StationaryState | null,
  obs: BusObservation,
  anchorStop: Stop | null,
): StationaryState {
  if (anchorStop && distanceMeters(obs, anchorStop) <= AT_STOP_PIN_M) {
    if (prev && prev.stationaryStopId === anchorStop.id) {
      // Same stop, same wait — the clock survives any shuffle within it.
      return {
        stationarySince: prev.stationarySince,
        stationaryLat: prev.stationaryLat,
        stationaryLon: prev.stationaryLon,
        stationaryStopId: prev.stationaryStopId,
      };
    }
    // A different stop is a different wait. Pin to the stop, not to the bus:
    // the bus is at the stop's edge on the poll it arrives, and anchoring
    // there is what makes every later shuffle read as movement.
    return {
      stationarySince: obs.collectedAt,
      stationaryLat: anchorStop.lat,
      stationaryLon: anchorStop.lon,
      stationaryStopId: anchorStop.id,
    };
  }
  if (
    prev &&
    distanceMeters(obs, { lat: prev.stationaryLat, lon: prev.stationaryLon }) <=
      STATIONARY_RADIUS_M
  ) {
    // Off the stop but not away: keep the clock AND the original point, so a
    // slow drift cannot walk the anchor across town one metre at a time.
    return {
      stationarySince: prev.stationarySince,
      stationaryLat: prev.stationaryLat,
      stationaryLon: prev.stationaryLon,
      stationaryStopId: prev.stationaryStopId,
    };
  }
  return {
    stationarySince: obs.collectedAt,
    stationaryLat: obs.lat,
    stationaryLon: obs.lon,
    stationaryStopId: null,
  };
}

// Vehicle identity ------------------------------------------------------------

/**
 * Longest feed absence across which we will let a *reissued* `busId` inherit
 * the previous id's anchor.
 *
 * Upstream's `bus_id` is not a vehicle identifier: it is reissued per service
 * block. Measured on production, the last 30 days carried 1,059 distinct
 * `bus_id` values for 50 distinct `bus_name` values — a median id lifetime of
 * 5.9 h and roughly 20–30 reissues a day. Tracking by id therefore throws away
 * a bus's anchor several times a day, which is why {@link trackKeyFor} keys on
 * `bus_name` instead.
 *
 * But identity continuity is not the same as *observational* continuity, and
 * the recorded data separates the two sharply. Over a 6.6 h replay of 76,134
 * production positions, a bus's feed gaps while its id was unchanged were 15–30 s
 * in 96 of 97 cases; EVERY multi-minute absence coincided with an id reissue
 * (gaps of 75 s to 55 min, with the bus sitting still at a layover point).
 * A reissue is the bus going off the air at a block boundary, not a bus we
 * merely mislabelled.
 *
 * Inheriting the anchor across that gap is actively harmful: `enteredAt` keeps
 * pointing at the pre-layover arrival, so the segment emitted when the bus
 * finally pulls out bills the entire layover as travel time. Replayed naively,
 * 13 of the window's 15 reissues did exactly that — route 15's 10→153 leg went
 * from 326 s to 1,149 s, route 19's 145→147 from 300 s to 950 s, injecting
 * 6,733 s of standing time into the travel-time calibration.
 *
 * 60 s is twice the worst same-id gap observed and well under the shortest
 * dropout reissue (75 s), so it admits the genuinely continuous handoff and
 * rejects the layovers. Beyond it we re-anchor exactly as before — the bus
 * keeps its identity and its live-map slot, it just doesn't keep a stale
 * stopwatch.
 */
export const MAX_HANDOFF_GAP_MS = 60_000;

/**
 * Ceiling on how far a bus may have moved across an id reissue before we call
 * the two observations different vehicles. Same purpose as
 * {@link MAX_HANDOFF_GAP_MS} in space rather than time, and the backstop for
 * the case {@link planTracks} cannot see: two live ids for one `bus_name` that
 * alternate between polls instead of appearing together.
 *
 * A distance floor as well as a speed limit, because at a 5 s poll a pure
 * speed test is indistinguishable from GPS jitter. 250 m clears the widest
 * (N)/(S) stop pair on this network (160 m); 25 m/s is 90 km/h, comfortably
 * above anything a shuttle does on Whalley Ave and far below the kilometres
 * that separate two buses working opposite halves of the same loop.
 */
export const MAX_HANDOFF_JUMP_M = 250;
export const MAX_HANDOFF_SPEED_MPS = 25;

/**
 * Track key for a bus: the stable `bus_name`, except while more than one live
 * `bus_id` is claiming that name in the same poll.
 *
 * Name collisions are rare but real — in one 7-day production window `#43` was
 * reported by ids 65531 and 65533 simultaneously for 6.7 h, both on route 1,
 * one at stop 102 while the other was at stop 2. Merging those two streams
 * would thrash a single anchor between two physical buses on opposite sides of
 * the loop and emit fabricated segments between them. So a contended name
 * falls back to the id-qualified key, which is precisely the old behaviour —
 * two independent tracks — for exactly as long as the contention lasts.
 *
 * Chosen over a name-plus-generation-counter because a generation counter has
 * to be invented and maintained by the collector (it is not in the feed), it
 * makes the key unstable across a process restart, and it cannot by itself
 * tell a reissue apart from a collision. The name is the identity riders and
 * the UI already use; qualification by id is only needed when the feed itself
 * says the name is ambiguous.
 */
export function trackKeyFor(busName: string, busId: number, contended: boolean): string {
  return contended ? `${busName}#${busId}` : busName;
}

/** How one poll's observations map onto track keys. */
export interface TrackPlan {
  /** Track key for each `busId` present in the poll. */
  keys: ReadonlyMap<number, string>;
  /** Every key in {@link keys}, for membership tests. */
  keySet: ReadonlySet<string>;
  /** Every `busName` present in the poll. */
  names: ReadonlySet<string>;
  /** Names carried by more than one `busId` in this poll. */
  contendedNames: ReadonlySet<string>;
}

/**
 * Compute the track keys for a batch of observations.
 *
 * A name counts as contended only when two ids report it *at the same
 * instant* — i.e. within one poll, which is where the ambiguity actually
 * lives. Two ids for one name at different timestamps is the ordinary reissue
 * case and must stay on one key. Testing per-instant rather than per-batch
 * also makes this safe to call on a multi-tick replay stream, not just on the
 * single poll the collector feeds it.
 */
export function planTracks(observations: readonly BusObservation[]): TrackPlan {
  const idsPerName = new Map<string, Set<number>>();
  const idsPerNamePerTick = new Map<string, Set<number>>();
  for (const o of observations) {
    let ids = idsPerName.get(o.busName);
    if (!ids) idsPerName.set(o.busName, (ids = new Set()));
    ids.add(o.busId);

    const tickKey = `${o.collectedAt} ${o.busName}`;
    let tickIds = idsPerNamePerTick.get(tickKey);
    if (!tickIds) idsPerNamePerTick.set(tickKey, (tickIds = new Set()));
    tickIds.add(o.busId);
  }
  const contendedNames = new Set<string>();
  for (const [tickKey, ids] of idsPerNamePerTick) {
    if (ids.size > 1) contendedNames.add(tickKey.slice(tickKey.indexOf(" ") + 1));
  }

  const keys = new Map<number, string>();
  const keySet = new Set<string>();
  for (const o of observations) {
    const key = trackKeyFor(o.busName, o.busId, contendedNames.has(o.busName));
    keys.set(o.busId, key);
    keySet.add(key);
  }
  return { keys, keySet, names: new Set(idsPerName.keys()), contendedNames };
}

/**
 * Re-file the entries of a map keyed by track key so its keys agree with
 * `plan`. Applied to the detector's `states` and to the collector's
 * `livePositions` so both stay in lockstep.
 *
 * Three cases, all driven by the entry's own `busId`:
 *
 *  - **The id is in this poll under a different key** — the name just became
 *    contended (or stopped being). Move the entry rather than drop it: the
 *    stream we were tracking is still the stream we were tracking, it only
 *    needs a longer name to stay apart from its twin.
 *  - **The id is gone but the entry's key is one the poll is filling** — an id
 *    reissue. Leave it; the new id steps onto the anchor, subject to the
 *    continuity checks in {@link step}.
 *  - **The id is gone and the key is not** — a retired half of a name that is
 *    no longer contended. Drop it, or the map serves two entries for one
 *    physical bus until the 120 s live TTL expires, which on the map is a
 *    rider-visible duplicate marker.
 *
 * Entries whose `busName` is absent from the poll entirely are left alone;
 * they are simply buses not reporting right now and belong to the TTL sweep.
 */
export function reconcileTracks<T extends TrackedIdentity>(
  map: Map<string, T>,
  plan: TrackPlan,
): void {
  const drops: string[] = [];
  const moves: Array<[string, T]> = [];
  for (const [key, entry] of map) {
    const want = plan.keys.get(entry.busId);
    if (want !== undefined) {
      if (want !== key) {
        drops.push(key);
        moves.push([want, entry]);
      }
    } else if (plan.names.has(entry.busName) && !plan.keySet.has(key)) {
      drops.push(key);
    }
  }
  // Deletes before sets: a move's destination can be another entry's old key.
  for (const key of drops) map.delete(key);
  for (const [key, entry] of moves) map.set(key, entry);
}

// Implementation --------------------------------------------------------------

/**
 * Apply a new observation to per-bus state and emit any state-transition
 * events. Pure: same `(prevState, obs)` always yields the same result, which
 * makes replay debugging trivial — feed historical GPS rows through this and
 * the events come out identical.
 *
 * Returns the new state and any events that fired. The caller persists events
 * to SQLite and updates the network's segment/dwell stats from them.
 */
export function step(
  network: TransitNetwork,
  prev: BusState | null,
  obs: BusObservation,
  seed: StationarySeed | null = null,
): { state: BusState | null; events: DetectorEvent[]; resumed: StandSeed | null } {
  const global = network.nearestStopOnRoute(obs.routeId, obs);
  if (!global) {
    // Bus is on a route we don't know about, or the route has no stops yet.
    // Drop state so we re-anchor cleanly once the route shows up.
    return { state: null, events: [], resumed: null };
  }

  // Reject an observation that is not strictly newer than the one already
  // folded in — checked before every other transition, including re-anchor.
  // The collector's in-flight guard is the primary defence against
  // overlapping polls, but this is the invariant that actually matters and it
  // costs one comparison: an older observation applied after a newer one
  // would rewind `enteredAt`/`nearestStopId` and emit a dwell and segment
  // measured over a negative or double-counted window, straight into the
  // calibration tables. Equal timestamps are rejected too — that is a
  // duplicate row for one bus in a single payload, whose only possible
  // "segment" has travelSec 0.
  if (prev && obs.collectedAt <= prev.lastObservedAt) {
    return { state: prev, events: [], resumed: null };
  }

  const gap = prev ? obs.collectedAt - prev.lastObservedAt : Infinity;

  // Identity handoff. Because tracking is keyed on the stable `bus_name`
  // (see `trackKeyFor`), `prev` can have been recorded under a different
  // `bus_id` than the one now reporting. That is normally the same physical
  // bus whose id upstream just reissued — but it is also how the two
  // pathological cases arrive: a bus that dropped off the feed for a whole
  // layover, and two live buses sharing one name in a feed where they never
  // appear in the same poll. Inherit the anchor only if the new observation is
  // continuous with the old one in both time and space; otherwise fall through
  // to the re-anchor below, which keeps the identity and the live-map slot but
  // restarts the stopwatch instead of billing the gap as travel time.
  let discontinuous = false;
  if (prev && prev.busId !== obs.busId) {
    const jumpM = distanceMeters(prev, obs);
    discontinuous =
      gap > MAX_HANDOFF_GAP_MS ||
      (jumpM > MAX_HANDOFF_JUMP_M && jumpM > (gap / 1000) * MAX_HANDOFF_SPEED_MPS);
  }

  // Anchor selection. While we are tracking a bus, prefer the closest stop
  // among the few it could plausibly reach next, rather than the closest stop
  // on the whole route — see `nearestStopAheadOnRoute` for why an unbounded
  // scan makes a bus teleport across the sequence at (N)/(S) stop pairs.
  //
  // The window is trusted only while it stays competitive with the global
  // best. If the bus turns up ANCHOR_SLACK_M closer to something outside the
  // window, it genuinely left the modelled path — a detour, a deadhead, or a
  // driver skipping ahead — and we re-anchor there instead of dragging a
  // stale position along behind it.
  let nearest = global;
  let continuous = false;
  if (prev && prev.routeId === obs.routeId) {
    const ahead = network.nearestStopAheadOnRoute(
      obs.routeId,
      obs,
      prev.nearestIndex,
      ANCHOR_LOOKAHEAD,
    );
    if (ahead && ahead.meters <= global.meters + ANCHOR_SLACK_M) {
      nearest = ahead;
      continuous = true;
    }
  }

  // The stop the stationary clock pins to while the bus is standing at it.
  // Deliberately the detector's own anchor rather than a fresh unbounded
  // nearest-neighbour: the anchor is what `collector.ts` publishes as
  // `at_stop_id` beside this clock, so pinning to anything else would report a
  // wait for one stop while naming another. It is also the more stable of the
  // two — the lookahead window is what stops a bus teleporting between the
  // (N)/(S) twins 28 m apart, and every such teleport would otherwise read as
  // "arrived at a different stop" and throw the wait away.
  const anchorStop = network.stops.get(nearest.stopId) ?? null;

  // The one reanchor that is not a lost track is the first sighting of a bus by
  // a freshly started process: the bus never went anywhere, we did. Consulted
  // here and nowhere else, so every other reanchor is untouched.
  const seeded = prev ? null : (seed?.(obs, anchorStop) ?? null);
  // ...and the DB agreed this stand already has a row. Resuming its instant is
  // what keeps one stand to one arrival, and what lets the departure close it
  // with the whole stand rather than the piece after the restart.
  const resumed = seeded && seeded.enteredAt != null ? seeded : null;

  // Re-anchor on first sight, after a long gap, on a route change, or when
  // the bus left the modelled path (above). We always emit an arrival event
  // so downstream consumers (the live UI, the dwell updater) have an anchor
  // row, but we never emit a dwell or segment because we don't trust the
  // missing time window.
  const reanchor =
    !prev ||
    gap > MAX_OBSERVATION_GAP_MS ||
    prev.routeId !== obs.routeId ||
    discontinuous ||
    !continuous;
  if (reanchor) {
    return {
      state: {
        busId: obs.busId,
        busName: obs.busName,
        routeId: obs.routeId,
        nearestStopId: nearest.stopId,
        nearestIndex: nearest.index,
        // A resumed stand keeps the anchor instant the row it is resuming was
        // written under, so the dwell patch finds that row and `stop_visits`
        // joins to it. It also lifts the 15 s `at_stop_id` gate in
        // `updateLivePositions`, which is measured from here and would
        // otherwise withhold the stop for three polls after every deploy.
        enteredAt: resumed?.enteredAt ?? obs.collectedAt,
        lastObservedAt: obs.collectedAt,
        lat: obs.lat,
        lon: obs.lon,
        // A reanchor means we lost track of this bus; nothing about how long
        // it had been standing survives that. Passing `null` for the previous
        // state restarts the clock — but still PINS it to the stop when the
        // bus is at one, so the frame is right from the very first poll rather
        // than from wherever the bus happened to be seen.
        //
        // {@link StationarySeed} is the exception, and only on a first
        // sighting: it recovers the clock from recorded positions.
        ...stationaryFields(seeded, obs, anchorStop),
      },
      // A resumed stand already HAS its arrival row. Writing another is the
      // duplicate this exists to end — and each one truncated the measured
      // stand, because `stop_visits.pinned_at` and the dwell patch both key on
      // the anchor instant above.
      events: resumed
        ? []
        : [
            {
              kind: "arrival",
              busId: obs.busId,
              busName: obs.busName,
              routeId: obs.routeId,
              stopId: nearest.stopId,
              arrivedAt: obs.collectedAt,
            },
          ],
      resumed,
    };
  }

  // Still at the same point in the sequence: extend dwell, no events yet.
  // Compared by INDEX, not by stop id — on an out-and-back route the two
  // visits to a stop are different points in the trip, and collapsing them
  // would erase the turnaround.
  //
  // `busId`/`busName` are refreshed from the observation, not carried over.
  // A bus that sits at a stop through an id reissue would otherwise keep the
  // retired id in its state indefinitely — and every subsequent poll would
  // look like a fresh handoff, re-running the continuity check forever. (In
  // the 6.6 h replay that mislabelled 457 observations as handoffs.)
  if (nearest.index === prev.nearestIndex) {
    return {
      state: {
        ...prev,
        busId: obs.busId,
        busName: obs.busName,
        lastObservedAt: obs.collectedAt,
        lat: obs.lat,
        lon: obs.lon,
        ...stationaryFields(prev, obs, anchorStop),
      },
      events: [],
      resumed: null,
    };
  }

  // Transition: bus is nearest a new stop. Emit dwell + arrival + segment.
  const events: DetectorEvent[] = [];
  const elapsedSec = (obs.collectedAt - prev.enteredAt) / 1000;

  if (elapsedSec >= MIN_DWELL_SEC && elapsedSec <= MAX_DWELL_SEC) {
    events.push({
      kind: "dwell",
      busId: obs.busId,
      busName: obs.busName,
      anchorBusId: prev.busId,
      routeId: obs.routeId,
      stopId: prev.nearestStopId,
      enteredAt: prev.enteredAt,
      leftAt: obs.collectedAt,
      dwellSec: elapsedSec,
    });
  }

  events.push({
    kind: "arrival",
    busId: obs.busId,
    busName: obs.busName,
    routeId: obs.routeId,
    stopId: nearest.stopId,
    arrivedAt: obs.collectedAt,
  });

  // Segment time from prev → nearest. Includes the dwell at prev — this
  // matches rider experience: "if the bus is at A, how long until it
  // reaches B" naturally includes the pause at A. The trip planner then
  // adds dwell separately at the *boarding* stop only, never at A again.
  //
  // Hops come from the tracked INDICES, so they are exact rather than
  // inferred from stop ids. That matters on the West Campus routes, where
  // `hopsForward(22, 23)` has to guess between two occurrences of stop 23,
  // and it is what keeps this count small enough to pass MAX_SEGMENT_HOPS on
  // the return leg. Because the window bounds forward progress, `hops` is
  // already in 1..ANCHOR_LOOKAHEAD here; the check is kept as an assertion of
  // that invariant rather than as the load-bearing filter it used to be.
  const routeLen = network.routeLength(obs.routeId);
  const hops =
    routeLen > 0
      ? (((nearest.index - prev.nearestIndex) % routeLen) + routeLen) % routeLen
      : 0;
  const plausibleDuration =
    elapsedSec >= MIN_SEGMENT_SEC && elapsedSec <= MAX_SEGMENT_SEC;
  if (plausibleDuration && hops >= 1 && hops <= MAX_SEGMENT_HOPS) {
    events.push({
      kind: "segment",
      busId: obs.busId,
      busName: obs.busName,
      routeId: obs.routeId,
      fromStopId: prev.nearestStopId,
      toStopId: nearest.stopId,
      hops,
      travelSec: elapsedSec,
      startedAt: prev.enteredAt,
    });
  }

  return {
    state: {
      busId: obs.busId,
      busName: obs.busName,
      routeId: obs.routeId,
      nearestStopId: nearest.stopId,
      nearestIndex: nearest.index,
      // The nearest-stop anchor restarts here — that is what it is for, and
      // the dwell/segment events above depend on it.
      enteredAt: obs.collectedAt,
      lastObservedAt: obs.collectedAt,
      lat: obs.lat,
      lon: obs.lon,
      // ...but the stationary clock does NOT, unless the bus actually reached
      // a different stop or left the one it was waiting at. This is the whole
      // fix: a parked bus that shuffles enough to flip the nearest stop keeps
      // the wait a rider has been watching.
      ...stationaryFields(prev, obs, anchorStop),
    },
    events,
    resumed: null,
  };
}

/**
 * Run the detector across a batch of observations for many buses. Mutates the
 * supplied state map and returns all emitted events in arrival order.
 *
 * `states` is keyed by track key (see {@link trackKeyFor}) — the vehicle's
 * stable fleet number, not upstream's per-service-block `bus_id`. The caller
 * may pass a `plan` it has already computed so that other per-vehicle maps
 * (the collector's `livePositions`) key identically; omitted, one is derived
 * from `observations`.
 */
export function stepMany(
  network: TransitNetwork,
  states: Map<string, BusState>,
  observations: readonly BusObservation[],
  plan: TrackPlan = planTracks(observations),
): DetectorEvent[] {
  reconcileTracks(states, plan);
  const out: DetectorEvent[] = [];
  for (const obs of observations) {
    const key = plan.keys.get(obs.busId) ?? obs.busName;
    const prev = states.get(key) ?? null;
    const { state, events } = step(network, prev, obs);
    if (state) states.set(key, state);
    else states.delete(key);
    for (const e of events) out.push(e);
  }
  return out;
}
