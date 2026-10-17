import type {UpcomingArrival} from './arrivals';
import {STOP_DWELL_SEC} from './planner';

/** A fresh arrival that the walk model excludes from boarding. Show its
 * forecast as information without changing the chosen trip or its wait.
 * Callers provide the current route's arrivals and check feed freshness. */
export function earlyPickupArrival(
  arrivals: readonly UpcomingArrival[], boardStopId: number,
  walkToSec: number, boardingEtaSec: number | null,
): UpcomingArrival | undefined {
  if (!Number.isFinite(walkToSec) || walkToSec <= 0
    || (boardingEtaSec !== null && !Number.isFinite(boardingEtaSec))) return undefined;
  // A physical pickup can precede the visit used for the itinerary. Keep its
  // forecast visible even when the planner waits for a later pass.
  const valid=arrivals.filter(a=>a.stopId===boardStopId&&Number.isFinite(a.eta)&&a.eta>=0);
  const first=valid.reduce<UpcomingArrival | undefined>((best,a)=>!best||a.eta<best.eta?a:best,undefined);
  return first && walkToSec>first.eta+STOP_DWELL_SEC
    && (boardingEtaSec===null || first.eta<boardingEtaSec) ? first : undefined;
}
