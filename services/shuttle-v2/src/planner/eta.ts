import type { TransitNetwork } from "../network/TransitNetwork.js";

/**
 * Estimate of a bus's travel time along its route between two stops.
 * Variance composes additively (independent-segment assumption); the planner
 * derives confidence intervals from `stddev` via the normal approximation.
 */
export interface RouteEta {
  meanSec: number;
  stddevSec: number;
  /**
   * Hops along the loop from origin to target. Bounded by the route's own
   * sequence length (index-addressed traversal cannot outrun the loop), so
   * no separate safety cap is needed.
   */
  hops: number;
}

/**
 * Expected travel time from a bus currently at `fromStopId` to `targetStopId`
 * on the same route, going forward along the loop. Sums calibrated segment
 * times and intermediate dwells; the dwell at `targetStopId` itself is
 * excluded because we want *arrival*, not departure-time.
 *
 * Returns null if either stop isn't on the route. Wraps the loop, so the
 * planner can ask "how long for the next bus to come back around to my stop"
 * without special-casing direction.
 *
 * ## Out-and-back routes
 *
 * Traversal is by route-sequence INDEX, not by stop id. Stepping by id
 * (`nextOnRoute`) cannot walk routes 9/10, whose West Campus leg repeats
 * stops: from route 10's `…26,25,24,23,22,23,24,25,26,72`, id-stepping
 * oscillates 23→22→23→22 forever and the old hop cap turned that into a
 * `null`. That silently deleted 219 of 380 ordered stop pairs on route 9 and
 * 54 of 110 on route 10 — every one of them a trip the planner then refused
 * to offer, because `expectedWait` gives up when `etaAlongRoute` is null.
 *
 * Occurrence choice, when a stop is visited twice:
 *  - `from` uses the FIRST occurrence ({@link TransitNetwork.positionOnRoute},
 *    unchanged semantics). GPS cannot tell the two visits apart — they are
 *    the same coordinate — so we assume the earlier one, which on both West
 *    Campus routes means "still has the out-and-back to do". That over-quotes
 *    rather than under-quotes; a rider who sees the bus early is fine, one
 *    who sees "2 min" and waits 20 files a bug report.
 *  - `target` uses the NEAREST occurrence forward of `from`, which is simply
 *    the first time the bus will actually be there.
 */
export function etaAlongRoute(
  network: TransitNetwork,
  routeId: number,
  fromStopId: number,
  targetStopId: number,
): RouteEta | null {
  const n = network.routeLength(routeId);
  if (n === 0) return null;

  const fromIdx = network.positionOnRoute(routeId, fromStopId);
  const targetIdxs = network.positionsOnRoute(routeId, targetStopId);
  if (fromIdx === null || targetIdxs.length === 0) return null;

  if (fromStopId === targetStopId) {
    return { meanSec: 0, stddevSec: 0, hops: 0 };
  }

  // Shortest forward index distance to any occurrence of the target.
  let hops = Infinity;
  for (const t of targetIdxs) {
    const d = (((t - fromIdx) % n) + n) % n;
    if (d > 0 && d < hops) hops = d;
  }
  // Every occurrence sits exactly on `fromIdx`, which the id equality check
  // above already handled — nothing left to travel to.
  if (!Number.isFinite(hops)) return null;

  let mean = 0;
  let variance = 0;

  for (let step = 0; step < hops; step++) {
    const cur = network.stopIdAtIndex(routeId, fromIdx + step);
    const next = network.stopIdAtIndex(routeId, fromIdx + step + 1);
    if (cur === null || next === null) return null;
    const seg = network.getSegmentStats(routeId, cur, next);
    mean += seg.mean;
    variance += seg.stddev * seg.stddev;
    if (step < hops - 1) {
      // Intermediate dwell — the bus pauses before continuing. Skipped
      // on the final hop because arrival happens the instant the bus
      // reaches `targetStopId`.
      const dwell = network.getDwellStats(routeId, next);
      mean += dwell.mean;
      variance += dwell.stddev * dwell.stddev;
    }
  }

  return { meanSec: mean, stddevSec: Math.sqrt(variance), hops };
}
