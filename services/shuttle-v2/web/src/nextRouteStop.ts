import type { UpcomingArrival } from './arrivals';

/** The next call of this bus, not the next row of a list that merges return
 * visits. Exclude the physical current row even while the forecast is still
 * approaching that curb; keep the earliest future occurrence of other stops. */
export function nextRouteStop(arrivals: readonly UpcomingArrival[], routeLabel: string, busName: string, currentStop: number, canonical: readonly number[]): number | null {
  // A simple loop has an explicit next stop. In particular Pink's repaired
  // model ring carries twin curb positions whose hop counts can tie; do not
  // replace its unambiguous published next stop with that model ambiguity.
  const index = canonical.indexOf(currentStop);
  if (index < 0) return null;
  if (new Set(canonical).size === canonical.length) return canonical[(index + 1) % canonical.length] ?? null;
  const bare = (name: string) => name.replace(/^#/, '');
  let next: UpcomingArrival | undefined;
  for (const arrival of arrivals) {
    if (arrival.routeLabel !== routeLabel || bare(arrival.busName) !== bare(busName) || arrival.stopId === currentStop
      || !Number.isInteger(arrival.stopsAhead) || arrival.stopsAhead < 0 || !Number.isFinite(arrival.eta) || arrival.eta < 0) continue;
    if (!next || arrival.stopsAhead < next.stopsAhead || (arrival.stopsAhead === next.stopsAhead && arrival.eta < next.eta)) next = arrival;
  }
  return next?.stopId ?? null;
}
