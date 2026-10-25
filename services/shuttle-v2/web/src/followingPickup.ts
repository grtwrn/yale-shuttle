import {nextArrivalAfterPinned} from './arrivals';

/** Following arrival for the pickup shown on the trip card.
 *
 * A directly observed current curb is already available for boarding. The
 * model can still price that same call from the incoming leg (one hop) or
 * the current marker (zero hops). Neither is a second boarding opportunity.
 * Keep later calls, including the same bus's next lap when its current row
 * is absent, and compare them with the boarding time actually on screen.
 * Forecast-selected future visits retain their exact original hop identity.
 */
export function nextArrivalForPickup<A extends {eta: number; busName: string; stopsAhead?: number}>(
  arrivals: readonly A[],
  busName: string,
  displayedEta: number,
  stopsAhead?: number,
  observedCurrentCurb = false,
): A | null {
  if (!observedCurrentCurb) return nextArrivalAfterPinned(arrivals, busName, displayedEta, stopsAhead);
  const norm = (name: string) => name.replace(/^#/, '');
  const following = arrivals.filter(a => norm(a.busName) !== norm(busName)
    || (a.stopsAhead !== 0 && a.stopsAhead !== 1));
  return nextArrivalAfterPinned(following, busName, displayedEta, 0);
}
