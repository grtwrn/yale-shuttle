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
