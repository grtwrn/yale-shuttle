import type { TransitNetwork } from "../network/TransitNetwork.js";
import type { EpochMs } from "../schema/api.js";

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

// Per-bus state. The detector is a pure reducer over these.
export interface BusState {
  busId: number;
  busName: string;
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
): { state: BusState | null; events: DetectorEvent[] } {
  const global = network.nearestStopOnRoute(obs.routeId, obs);
  if (!global) {
    // Bus is on a route we don't know about, or the route has no stops yet.
    // Drop state so we re-anchor cleanly once the route shows up.
    return { state: null, events: [] };
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
    return { state: prev, events: [] };
  }

  const gap = prev ? obs.collectedAt - prev.lastObservedAt : Infinity;

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

  // Re-anchor on first sight, after a long gap, on a route change, or when
  // the bus left the modelled path (above). We always emit an arrival event
  // so downstream consumers (the live UI, the dwell updater) have an anchor
  // row, but we never emit a dwell or segment because we don't trust the
  // missing time window.
  const reanchor =
    !prev || gap > MAX_OBSERVATION_GAP_MS || prev.routeId !== obs.routeId || !continuous;
  if (reanchor) {
    return {
      state: {
        busId: obs.busId,
        busName: obs.busName,
        routeId: obs.routeId,
        nearestStopId: nearest.stopId,
        nearestIndex: nearest.index,
        enteredAt: obs.collectedAt,
        lastObservedAt: obs.collectedAt,
      },
      events: [
        {
          kind: "arrival",
          busId: obs.busId,
          busName: obs.busName,
          routeId: obs.routeId,
          stopId: nearest.stopId,
          arrivedAt: obs.collectedAt,
        },
      ],
    };
  }

  // Still at the same point in the sequence: extend dwell, no events yet.
  // Compared by INDEX, not by stop id — on an out-and-back route the two
  // visits to a stop are different points in the trip, and collapsing them
  // would erase the turnaround.
  if (nearest.index === prev.nearestIndex) {
    return {
      state: { ...prev, lastObservedAt: obs.collectedAt },
      events: [],
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
      enteredAt: obs.collectedAt,
      lastObservedAt: obs.collectedAt,
    },
    events,
  };
}

/**
 * Run the detector across a batch of observations for many buses. Mutates the
 * supplied state map and returns all emitted events in arrival order.
 */
export function stepMany(
  network: TransitNetwork,
  states: Map<number, BusState>,
  observations: readonly BusObservation[],
): DetectorEvent[] {
  const out: DetectorEvent[] = [];
  for (const obs of observations) {
    const prev = states.get(obs.busId) ?? null;
    const { state, events } = step(network, prev, obs);
    if (state) states.set(obs.busId, state);
    else states.delete(obs.busId);
    for (const e of events) out.push(e);
  }
  return out;
}
