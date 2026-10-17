import type { TransitNetwork } from "../network/TransitNetwork.js";
import { stepManyWithVisits, type StopVisitEvent, type VisitState } from "./departure.js";
import { MAX_HANDOFF_GAP_MS, type BusObservation, type BusState } from "./detector.js";

export interface OpenArrival {
  stopId: number;
  routeId: number;
  arrivedAt: number;
  departedAt: number | null;
}

/** Restore a visit only when replay reaches the exact still-open arrival on
 * disk. Historical events are discarded: they were already persisted. The
 * first new observation is processed normally, retaining route position and
 * any pending departure/shuffle evidence. If the visit already closed while
 * its arrival anchor remains open, its following transit also needs matching
 * persisted visit evidence. An open anchor can still be on the
 * approach, outside the curb radius: matching its exact database arrival and
 * fresh history proves continuity without asserting that the bus is at a stop.
 */
export function recoverOpenVisit(
  network: TransitNetwork,
  current: BusObservation,
  history: readonly BusObservation[],
  arrivalsNewestFirst: readonly OpenArrival[],
  isPersistedClosedVisit?: (visit: StopVisitEvent) => boolean,
): { detector: BusState; visit: VisitState } | null {
  const latest = arrivalsNewestFirst[0];
  if (!latest || latest.departedAt !== null || latest.routeId !== current.routeId) return null;
  if (!network.stops.has(latest.stopId)) return null;
  const last = history.at(-1);
  if (!last || last.collectedAt >= current.collectedAt || current.collectedAt - last.collectedAt > MAX_HANDOFF_GAP_MS) return null;
  const states = new Map<string, BusState>();
  const visits = new Map<string, VisitState>();
  let previousAt = -Infinity;
  let segmentStart = history[0]!.collectedAt;
  let completeTransit = true;
  let closed: StopVisitEvent | undefined;
  for (const obs of history) {
    // Never carry evidence through an identity/route change, duplicate poll,
    // or unobserved interval, even if an old database arrival remains open.
    if (obs.busId !== current.busId || obs.busName !== current.busName || obs.routeId !== current.routeId
      || obs.collectedAt <= previousAt || obs.collectedAt >= current.collectedAt) return null;
    if (previousAt !== -Infinity && obs.collectedAt - previousAt > MAX_HANDOFF_GAP_MS) {
      states.clear(); visits.clear();
      segmentStart = obs.collectedAt; completeTransit = true;
    }
    const before = visits.get(current.busName);
    const replayed = stepManyWithVisits(network, states, visits, [obs]);
    for (const event of replayed.visits) {
      if (event.kind === "visit" && event.stopId === latest.stopId) closed = event;
    }
    const after = visits.get(current.busName);
    if (after?.transit !== before?.transit) {
      // A leg starting at the first cold anchor may already have been under
      // way when the bounded history began. Its departure/hold clock is not
      // established until the origin pass itself starts inside the history.
      completeTransit = !after?.transit || (before?.pass != null && before.pass.anchoredAt > segmentStart);
    }
    previousAt = obs.collectedAt;
  }
  const detector = states.get(current.busName);
  const visit = visits.get(current.busName);
  if (!detector || !visit || detector.nearestStopId !== latest.stopId) return null;
  if (visit.pass && (visit.pass.stopId !== latest.stopId || visit.pass.anchoredAt !== detector.enteredAt)) return null;
  // The first fix's anchor and movement clock are cold-start guesses. If
  // either still survives, an earlier leg or pre-reissue movement is missing.
  if (detector.enteredAt <= segmentStart || detector.lastMovedAt <= segmentStart) return null;
  if (visit.transit && !completeTransit) return null;
  // The visit can finish before the detector changes anchor. Reopening it
  // after a restart adds a false pass and moves the following leg's departure
  // forward. Restore its transit only when the full departure was replayed
  // and the caller proves that exact closed visit is already on disk.
  if (!visit.pass && (!closed || closed.anchoredAt !== detector.enteredAt
    || closed.departedAt === null || closed.how === "gap" || closed.outcome === "unresolved"
    || visit.transit?.fromStopId !== closed.stopId || visit.transit.fromIndex !== closed.stopIndex
    || visit.transit.departedAt !== closed.departedAt || !isPersistedClosedVisit?.(closed))) return null;
  // Consecutive open duplicates may come from older restart behavior. A
  // closed visit or another stop ends this episode; no time-based guessing.
  for (const row of arrivalsNewestFirst) {
    if (row.stopId !== latest.stopId || row.routeId !== current.routeId || row.departedAt !== null) break;
    if (row.arrivedAt === detector.enteredAt) return { detector, visit };
  }
  return null;
}
