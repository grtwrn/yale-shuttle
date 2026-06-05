import type { TransitNetwork } from "../network/TransitNetwork.js";

/**
 * Estimate of a bus's travel time along its route between two stops.
 * Variance composes additively (independent-segment assumption); the planner
 * derives confidence intervals from `stddev` via the normal approximation.
 */
export interface RouteEta {
  meanSec: number;
  stddevSec: number;
  /** Hops along the loop from origin to target — bounded by MAX_HOPS. */
  hops: number;
}

const MAX_HOPS = 50; // safety cap against malformed loops

/**
 * Expected travel time from a bus currently at `fromStopId` to `targetStopId`
 * on the same route, going forward along the loop. Sums calibrated segment
 * times and intermediate dwells; the dwell at `targetStopId` itself is
 * excluded because we want *arrival*, not departure-time.
 *
 * Returns null if either stop isn't on the route. Wraps the loop, so the
 * planner can ask "how long for the next bus to come back around to my stop"
 * without special-casing direction.
 */
export function etaAlongRoute(
  network: TransitNetwork,
  routeId: number,
  fromStopId: number,
  targetStopId: number,
): RouteEta | null {
  const fromIdx = network.positionOnRoute(routeId, fromStopId);
  const targetIdx = network.positionOnRoute(routeId, targetStopId);
  if (fromIdx === null || targetIdx === null) return null;

  if (fromStopId === targetStopId) {
    return { meanSec: 0, stddevSec: 0, hops: 0 };
  }

  let mean = 0;
  let variance = 0;
  let cur = fromStopId;
  let hops = 0;

  while (cur !== targetStopId && hops < MAX_HOPS) {
    const next = network.nextOnRoute(routeId, cur);
    if (next === null) return null;
    const seg = network.getSegmentStats(routeId, cur, next);
    mean += seg.mean;
    variance += seg.stddev * seg.stddev;
    if (next !== targetStopId) {
      // Intermediate dwell — the bus pauses before continuing. Skipped
      // on the final hop because arrival happens the instant the bus
      // reaches `targetStopId`.
      const dwell = network.getDwellStats(routeId, next);
      mean += dwell.mean;
      variance += dwell.stddev * dwell.stddev;
    }
    cur = next;
    hops += 1;
  }

  if (cur !== targetStopId) return null;
  return { meanSec: mean, stddevSec: Math.sqrt(variance), hops };
}
