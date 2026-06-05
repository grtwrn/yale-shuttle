import type { Collector } from "../collector/collector.js";
import type { LiveSnapshot, Route, Stop } from "../schema/api.js";

/**
 * Compose a self-contained snapshot for the /api/live endpoint. Includes the
 * static topology so a freshly-loaded client has everything it needs to
 * render the map without a second round-trip.
 *
 * The shape is intentionally cheap to diff on the client: stops/routes are
 * stable (only change every ~6 h), buses turn over every poll. A future
 * optimization is splitting these into separate endpoints with cache headers,
 * but we'll wait until measurements warrant it.
 */
export function buildLiveSnapshot(collector: Collector): LiveSnapshot {
  const network = collector.ref.get();
  const stops: Stop[] = [];
  for (const s of network.stops.values()) stops.push(s);
  const routes: Route[] = [];
  for (const r of network.routes.values()) routes.push(r);
  return {
    buses: collector.getLiveBuses(),
    stops,
    routes,
    serverTime: Date.now(),
  };
}
