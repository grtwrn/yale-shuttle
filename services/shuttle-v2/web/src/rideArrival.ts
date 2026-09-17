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
