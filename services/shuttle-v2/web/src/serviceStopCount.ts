/** Service calls before one selected arrival, independent of traversal hops.
 * Missing metadata preserves older producers; explicit unknown never guesses. */
export function serviceStopCount(arrival: { stopsAhead?: number; serviceStopsAhead?: number | null }): number | null {
  const count = arrival.serviceStopsAhead === undefined ? arrival.stopsAhead : arrival.serviceStopsAhead;
  if (!Number.isSafeInteger(count) || count! < 0) return null;
  if (arrival.serviceStopsAhead !== undefined && arrival.stopsAhead !== undefined
    && (!Number.isSafeInteger(arrival.stopsAhead) || arrival.stopsAhead < 0 || count! > arrival.stopsAhead
      || (arrival.stopsAhead === 0 ? count !== 0 : count === 0))) return null;
  return count!;
}
