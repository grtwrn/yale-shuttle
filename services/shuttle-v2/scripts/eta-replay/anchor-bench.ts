import { loadNet } from "./common.js";
import { findRouteAnchor, registerRoutePaths } from "../../web/src/anchor.js";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes.js";

const net = loadNet();
const cases = ROUTE_LISTS.map((cfg) => {
  const stops = mergedRouteStops(cfg, net.routeStops);
  const c = net.stopCoords[stops[Math.floor(stops.length / 3)]!]!;
  return { cfg, stops, bus: { lat: c.lat + 0.0004, lon: c.lon + 0.0004, last_stop_id: stops[0]!, route_id: cfg.busRouteIds[0]! } };
});

function run(label: string) {
  // warm the caches
  for (const c of cases) findRouteAnchor(c.bus, c.stops, net.stopCoords);
  const N = 2000;
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < N; k++) for (const c of cases) findRouteAnchor(c.bus, c.stops, net.stopCoords);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${label.padEnd(8)} ${(ms / (N * cases.length) * 1000).toFixed(1)} us per call  (${N * cases.length} calls in ${ms.toFixed(0)} ms)`);
}

registerRoutePaths(null);
run("chord");
registerRoutePaths(net.routePaths);
run("poly");
registerRoutePaths(null);
run("chord");
registerRoutePaths(net.routePaths);
run("poly");
