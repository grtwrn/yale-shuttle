import type { TransitNetwork } from "../network/TransitNetwork.js";
import { distanceMeters } from "../network/geo.js";
import { stepManyWithVisits, type VisitState } from "./departure.js";
import { AT_STOP_PIN_M, MAX_HANDOFF_GAP_MS, type BusObservation, type BusState } from "./detector.js";

export interface OpenArrival {
  stopId: number;
  routeId: number;
  arrivedAt: number;
  departedAt: number | null;
}

/** Restore a visit only when replay reaches the exact still-open arrival on
 * disk. Historical events are discarded: they were already persisted. The
 * first new observation is processed normally, retaining any pending departure
 * and shuffle evidence instead of treating its fresh coordinate as a new visit.
 */
export function recoverOpenVisit(
  network: TransitNetwork,
  current: BusObservation,
  history: readonly BusObservation[],
  arrivalsNewestFirst: readonly OpenArrival[],
): { detector: BusState; visit: VisitState } | null {
  const latest = arrivalsNewestFirst[0];
  if (!latest || latest.departedAt !== null || latest.routeId !== current.routeId) return null;
  const stop = network.stops.get(latest.stopId);
  if (!stop || distanceMeters(current, stop) > AT_STOP_PIN_M) return null;
  const last = history.at(-1);
  if (!last || last.collectedAt >= current.collectedAt || current.collectedAt - last.collectedAt > MAX_HANDOFF_GAP_MS) return null;
  const states = new Map<string, BusState>();
  const visits = new Map<string, VisitState>();
  let previousAt = -Infinity;
  for (const obs of history) {
    // Never carry evidence through an identity/route change, duplicate poll,
    // or unobserved interval, even if an old database arrival remains open.
    if (obs.busId !== current.busId || obs.busName !== current.busName || obs.routeId !== current.routeId
      || obs.collectedAt <= previousAt || obs.collectedAt >= current.collectedAt) return null;
    if (previousAt !== -Infinity && obs.collectedAt - previousAt > MAX_HANDOFF_GAP_MS) {
      states.clear(); visits.clear();
    }
    stepManyWithVisits(network, states, visits, [obs]);
    previousAt = obs.collectedAt;
  }
  const detector = states.get(current.busName);
  const visit = visits.get(current.busName);
  if (!detector || !visit?.pass || detector.nearestStopId !== latest.stopId
    || visit.pass.stopId !== latest.stopId || visit.pass.anchoredAt !== detector.enteredAt
    || visit.pass.pinnedAt === null || visit.pass.arrivedAt === null) return null;
  // Consecutive open duplicates may come from older restart behavior. A
  // closed visit or another stop ends this episode; no time-based guessing.
  for (const row of arrivalsNewestFirst) {
    if (row.stopId !== latest.stopId || row.routeId !== current.routeId || row.departedAt !== null) break;
    if (row.arrivedAt === detector.enteredAt) return { detector, visit };
  }
  return null;
}
