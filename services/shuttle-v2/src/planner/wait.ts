import type { TransitNetwork } from "../network/TransitNetwork.js";
import type { BusPosition, EpochMs } from "../schema/api.js";

import { etaAlongRoute } from "./eta.js";

/**
 * Expected wait at a board stop, computed from live bus positions on that
 * route. Returns the soonest expected arrival across all buses currently on
 * the route, plus the variance of that estimate.
 *
 * Critically, this looks at **all** live buses and takes the minimum — not
 * just the closest one by stop count. A bus 2 stops upstream that's dwelling
 * at a known busy stop can easily be slower than one 4 stops upstream
 * cruising through, and the calibrated stats already encode that.
 */
export interface WaitEstimate {
  meanSec: number;
  stddevSec: number;
  /** Which bus the rider will likely board, if any was reachable. */
  busName: string | null;
  busId: number | null;
}

export function expectedWait(
  network: TransitNetwork,
  buses: readonly BusPosition[],
  routeId: number,
  boardStopId: number,
  now: EpochMs,
): WaitEstimate | null {
  let best: { meanSec: number; stddevSec: number; bus: BusPosition } | null = null;

  for (const bus of buses) {
    if (bus.routeId !== routeId) continue;

    // Anchor: where on the route is this bus? Prefer the dwelling-at stop
    // (most precise — bus is actually there); fall back to lastStopId from
    // upstream, then to nearest-on-route by GPS as a last resort.
    const anchorStopId =
      bus.atStopId ??
      bus.lastStopId ??
      network.nearestStopOnRoute(routeId, { lat: bus.lat, lon: bus.lon })?.stopId ??
      null;
    if (anchorStopId === null) continue;

    const eta = etaAlongRoute(network, routeId, anchorStopId, boardStopId);
    if (eta === null) continue;

    // Adjust for time already spent dwelling at the anchor stop. The
    // calibrated dwell stat represents a full stop; if the bus has been
    // there for 20s already and the typical dwell is 30s, only ~10s remain.
    let meanSec = eta.meanSec;
    if (bus.atStopId === anchorStopId && bus.atStopSince !== null) {
      const elapsedDwellSec = Math.max(0, (now - bus.atStopSince) / 1000);
      const stopDwell = network.getDwellStats(routeId, anchorStopId);
      // Bus has already dwelled longer than typical → predicted dwell is 0,
      // not negative. Variance is unaffected (we're not learning new dwell).
      meanSec = Math.max(0, eta.meanSec - Math.min(elapsedDwellSec, stopDwell.mean));
    }

    // The clock is also already ticking on whatever time the position is
    // stale by — subtract it so we always quote wait from "now".
    const stalenessSec = Math.max(0, (now - bus.collectedAt) / 1000);
    meanSec = Math.max(0, meanSec - stalenessSec);

    if (!best || meanSec < best.meanSec) {
      best = { meanSec, stddevSec: eta.stddevSec, bus };
    }
  }

  if (!best) return null;
  return {
    meanSec: best.meanSec,
    stddevSec: best.stddevSec,
    busName: best.bus.busName,
    busId: best.bus.busId,
  };
}
