import { computeUpcomingArrivals } from '../../web/src/arrivals';
import { registerRoutePaths } from '../../web/src/anchor';
import { applyModelParams } from '../../web/src/eta/params';
import { isBusInService } from '../../web/src/schedule';
import type { AnchorStore } from '../../web/src/eta';

/** Use the client estimator and independent arm memories. No server ETA cache
 * is attached: that cache was generated with the live champion only. */
export function forecastArms(feed: any, now: number, champion: any, challenger: any,
  stores: {champion: AnchorStore; challenger: AnchorStore}) {
  registerRoutePaths(feed.route_paths);
  const targets = Object.keys(feed.stop_coords).map(Number);
  const buses = feed.buses.filter((b: any) => isBusInService(b, now));
  const compute = (wire: any, store: AnchorStore) => {
    if (!applyModelParams(wire)) throw Error('Invalid frozen model parameters');
    const rows = buses.flatMap((bus: any) => computeUpcomingArrivals(targets, [bus],
      feed.routes, feed.stop_coords, feed.segments, now,
      feed.dwells, store)
      .map(a => ({bus, stop:a.stopId, eta:a.eta, low:a.low, high:a.high})));
    // Repeated ring stops can also emit a later occurrence. The prospective
    // identity names the next observed service visit, so use its first ETA.
    const first = new Map();
    for (const row of rows) {
      const key = `${row.bus.route_id}|${row.bus.bus_id}|${row.bus.bus_name}|${row.stop}`;
      if (!first.has(key) || row.eta < first.get(key).eta) first.set(key,row);
    }
    return [...first.values()];
  };
  return {champion:compute(champion,stores.champion), challenger:compute(challenger,stores.challenger)};
}
