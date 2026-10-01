/** An index in the display list cannot distinguish repeated outbound/inbound stops. */
export function isUnambiguousRideArrival(
  rawRoute: readonly number[] | undefined,
  alightStopId: number,
  busIndex: number,
  alightIndex: number,
): boolean {
  if (alightIndex < 0 || busIndex !== alightIndex || !rawRoute) return false;
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
 * `rideStopPassed`, said only on evidence. Position alone cannot tell a lapped
 * exit from a bus still coming to the pickup — both sit in (alight, board),
 * and a ride can start before its bus arrives (TripBoardingActions) — so the
 * bus must have been seen inside the ride's window (`rode`) first. A stop the
 * line visits twice is never called passed: the ride list keeps only its first
 * visit, so the second may still be ahead (as in `isUnambiguousRideArrival`).
 */
export function rideLappedExit(p: {
  busIndex: number;
  boardIndex: number;
  alightIndex: number;
  stopCount: number;
  rode: boolean;
  rawRoute: readonly number[] | undefined;
  alightStopId: number;
}): boolean {
  if (!p.rode || !p.rawRoute || p.rawRoute.filter((id) => id === p.alightStopId).length !== 1) return false;
  return rideStopPassed(p.busIndex, p.boardIndex, p.alightIndex, p.stopCount);
}

/** The on-bus banner's headline. A named hold (`standWait.ts` `rideHoldText`)
 * takes the countdown's place; a lapped exit replaces the stop count. */
export function rideHeadline(s: {
  busFound: boolean;
  stopsRemaining: number | null;
  alightName: string;
  etaStr: string | null;
  holdText: string | null;
  alightPassed: boolean;
}): string {
  if (!s.busFound) return "Looking for your bus…";
  if (s.stopsRemaining === null) return "Tracking your ride";
  if (s.alightPassed) return `May have passed ${s.alightName}${s.etaStr ? ` · back in ${s.etaStr}` : ""}`;
  if (s.stopsRemaining <= 0) return `Arriving at ${s.alightName}`;
  const trail = s.holdText ?? s.etaStr;
  if (s.stopsRemaining === 1) return `Get off NEXT stop!${trail ? ` · ${trail}` : ""}`;
  if (s.stopsRemaining === 2) return `Get off in 2 stops!${trail ? ` · ${trail}` : ""}`;
  return trail ? `${s.stopsRemaining} stops · ${trail}` : `${s.stopsRemaining} stops until your stop`;
}
