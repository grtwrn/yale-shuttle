import { rideExitNearby } from "./rideAlert";
import type { ReportingSnapshot } from "./busReporting";
import { LIVE_UPDATE_STALE_MS } from "./liveUpdates";

/** Position reporting does not establish that a bus has a usable route ETA. */
export function ridePositionAvailable(
  snapshot: ReportingSnapshot | null, busName: string, routeIds: readonly number[], now: number,
): boolean {
  if (!snapshot || ![snapshot.at, snapshot.serverAt, now].every(Number.isFinite)
    || now - snapshot.at >= LIVE_UPDATE_STALE_MS || snapshot.at > now + 5000) return false;
  const name = (value: string) => value.trim().replace(/^#/, "");
  const matches = snapshot.buses.filter(bus => name(bus.bus_name) === name(busName) && routeIds.includes(bus.route_id));
  if (matches.length !== 1) return false;
  const bus = matches[0]!;
  return Number.isFinite(bus.observed_at) && snapshot.serverAt - bus.observed_at! >= -5000
    && snapshot.serverAt - bus.observed_at! < LIVE_UPDATE_STALE_MS
    && Number.isFinite(bus.lat) && Math.abs(bus.lat) <= 90 && bus.lat !== 0
    && Number.isFinite(bus.lon) && Math.abs(bus.lon) <= 180 && bus.lon !== 0;
}

/** An index in the display list cannot distinguish repeated outbound/inbound stops. */
export function isUnambiguousRideArrival(
  rawRoute: readonly number[] | undefined,
  alightStopId: number,
  busIndex: number,
  alightIndex: number,
  serviceCallAllowed = true,
): boolean {
  if (!serviceCallAllowed || alightIndex < 0 || busIndex !== alightIndex || !rawRoute) return false;
  // Inspect the upstream sequence, before the ride list deduplicates it.
  return rawRoute.filter((id) => id === alightStopId).length === 1;
}

/**
 * The bus has lapped the rider's exit: its anchor sits in the forward arc
 * (alight, board) — past the drop-off, not yet back at the pickup. Without
 * this state the ride surfaces print the loop's length as an ordinary
 * countdown ("21 stops · 50 min", 2026-09-17 restart recovery) and the one
 * thing a returning rider needs to know goes unsaid.
 */
export function rideStopPassed(
  busIndex: number,
  boardIndex: number,
  alightIndex: number,
  stopCount: number,
): boolean {
  if (busIndex < 0 || boardIndex < 0 || alightIndex < 0 || stopCount <= 0) return false;
  const tail = (boardIndex - alightIndex + stopCount) % stopCount;
  const past = (busIndex - alightIndex + stopCount) % stopCount;
  return past > 0 && past < tail;
}

/** The bus is carrying this ride: past the pickup, up to and at the exit. */
export function rideInWindow(
  busIndex: number,
  boardIndex: number,
  alightIndex: number,
  stopCount: number,
): boolean {
  if (busIndex < 0 || boardIndex < 0 || alightIndex < 0 || stopCount <= 0 || boardIndex === alightIndex) return false;
  const steps = (busIndex - boardIndex + stopCount) % stopCount;
  return steps > 0 && steps <= (alightIndex - boardIndex + stopCount) % stopCount;
}

/**
 * What this ride has seen its bus do, in order: carry the rider (at the pickup,
 * or between it and the exit), then reach the exit. Being seen inside the
 * window alone is not enough. The ride list keeps one slot per stop, so a bus
 * on a stop the line passes twice reads off that one slot: Green's second West
 * Campus pass (23, 25, 26), and Pink's run out past Quigley Stadium Outbound
 * and VA Entrance Outbound (110, 124), which the repaired ring visits on the
 * way to the hospital (#160), land in (alight, board) while the bus is still
 * driving to the exit. That printed "May have passed West Haven Train Station
 * · back in 5 min" 2.6 km short of it (incident mayhavepassed20261002). Only a
 * bus that has been AT the exit can have passed it, and only after it carried
 * the ride: a bus coming to the pickup can cross the exit's slot first (Pink,
 * VA Hospital → Quigley Stadium Outbound).
 */
export type RideEvidence = "none" | "rode" | "reached";

export function rideEvidence(
  prev: RideEvidence,
  busIndex: number,
  boardIndex: number,
  alightIndex: number,
  stopCount: number,
  exitServiceCallAllowed = true,
): RideEvidence {
  if (prev === "reached" || busIndex < 0) return prev;
  if (busIndex === alightIndex) return exitServiceCallAllowed && prev === "rode" ? "reached" : prev;
  return busIndex === boardIndex || rideInWindow(busIndex, boardIndex, alightIndex, stopCount) ? "rode" : prev;
}

/**
 * `rideStopPassed`, said only on evidence. Position alone cannot tell a lapped
 * exit from a bus still coming to the pickup — both sit in (alight, board),
 * and a ride can start before its bus arrives (TripBoardingActions) — or from
 * a bus on a repeated pass still driving to the exit, so the bus must have
 * carried the ride to the exit first (`reachedExit`, `rideEvidence`). A stop
 * the line visits twice is never called passed: the ride list keeps only its
 * first visit, so the second may still be ahead (as in `isUnambiguousRideArrival`).
 */
export function rideLappedExit(p: {
  busIndex: number;
  boardIndex: number;
  alightIndex: number;
  stopCount: number;
  reachedExit: boolean;
  rawRoute: readonly number[] | undefined;
  alightStopId: number;
}): boolean {
  if (!p.reachedExit || !p.rawRoute || p.rawRoute.filter((id) => id === p.alightStopId).length !== 1) return false;
  return rideStopPassed(p.busIndex, p.boardIndex, p.alightIndex, p.stopCount);
}

/** The on-bus banner's headline. A named hold (`standWait.ts` `rideHoldText`)
 * takes the countdown's place; a lapped exit replaces the stop count. */
export function rideHeadline(s: {
  busFound: boolean;
  positionAvailable?: boolean;
  stopsRemaining: number | null;
  alightName: string;
  etaStr: string | null;
  holdText: string | null;
  alightPassed: boolean;
  exitMeters?: number | null;
}): string {
  if (!s.busFound) return s.positionAvailable
    ? "Bus location available · arrival estimate unavailable" : "Looking for your bus…";
  if (s.stopsRemaining === null) {
    const timing = s.holdText ?? s.etaStr;
    if (timing) return `Tracking your ride · ${timing}`;
    return s.positionAvailable ? "Bus location available · arrival estimate unavailable" : "Tracking your ride";
  }
  if (s.alightPassed) return `May have passed ${s.alightName}${s.etaStr ? ` · back in ${s.etaStr}` : ""}`;
  if (s.stopsRemaining <= 0) return rideExitNearby(s.exitMeters)
    ? `Arriving at ${s.alightName}` : `Watch for ${s.alightName}`;
  const trail = s.holdText ?? s.etaStr;
  if (s.stopsRemaining === 1) return `Get off NEXT stop!${trail ? ` · ${trail}` : ""}`;
  if (s.stopsRemaining === 2) return `Get off in 2 stops!${trail ? ` · ${trail}` : ""}`;
  return trail ? `${s.stopsRemaining} stops · ${trail}` : `${s.stopsRemaining} stops until your stop`;
}
