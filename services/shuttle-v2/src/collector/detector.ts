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
 * Maximum hop count to treat as a usable segment sample. Loops have ≤20 stops,
 * so a 1- or 2-hop transition is normal; 6+ usually means a feed gap or GPS
 * teleport and shouldn't pollute the segment-time calibration.
 */
export const MAX_SEGMENT_HOPS = 5;

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
  const nearest = network.nearestStopOnRoute(obs.routeId, obs);
  if (!nearest) {
    // Bus is on a route we don't know about, or the route has no stops yet.
    // Drop state so we re-anchor cleanly once the route shows up.
    return { state: null, events: [] };
  }

  // Re-anchor on first sight, after a long gap, or on a route change.
  // We always emit an arrival event so downstream consumers (the live UI,
  // the dwell updater) have an anchor row, but we never emit a dwell or
  // segment because we don't trust the missing time window.
  const gap = prev ? obs.collectedAt - prev.lastObservedAt : Infinity;
  const reanchor =
    !prev || gap > MAX_OBSERVATION_GAP_MS || prev.routeId !== obs.routeId;
  if (reanchor) {
    return {
      state: {
        busId: obs.busId,
        busName: obs.busName,
        routeId: obs.routeId,
        nearestStopId: nearest.stopId,
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

  // Still nearest the same stop: extend dwell, no events yet.
  if (nearest.stopId === prev.nearestStopId) {
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
  const hops = network.hopsForward(obs.routeId, prev.nearestStopId, nearest.stopId);
  if (hops !== null && hops >= 1 && hops <= MAX_SEGMENT_HOPS) {
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
