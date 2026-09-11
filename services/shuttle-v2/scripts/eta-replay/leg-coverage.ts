/** How many legs does the published line actually supply, per route? */
import { loadNet } from "./common.js";
import { traceStopLegs, polylineMeters, haversineMeters } from "../../web/src/geo.js";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes.js";
import type { LatLon } from "../../web/src/geo.js";

const net = loadNet();
let totalLegs = 0, totalBridged = 0;
for (const cfg of ROUTE_LISTS) {
  const stops = mergedRouteStops(cfg, net.routeStops);
  const path = net.routePaths[cfg.routeIds[0]!];
  if (!stops.length || !path) { console.log(`${cfg.label.padEnd(15)} no path`); continue; }
  const ring: LatLon[] = stops.map((s) => net.stopCoords[s]!);
  ring.push(ring[0]!);
  const legs = traceStopLegs(path, ring);
  const bridged = legs.filter((l) => l.bridged).length;
  // how far does the road bow off its own chord, per leg?
  let worst = 0, worstAt = "";
  legs.forEach((l, i) => {
    if (l.bridged) return;
    const a = ring[i]!, b = ring[i + 1]!;
    const chord = haversineMeters(a, b);
    const road = polylineMeters(l.slice);
    if (road - chord > worst) { worst = road - chord; worstAt = `${net.stopById.get(stops[i]!)?.name} -> ${net.stopById.get(stops[(i + 1) % stops.length]!)?.name}`; }
  });
  totalLegs += legs.length; totalBridged += bridged;
  console.log(`${cfg.label.padEnd(15)} legs ${String(legs.length).padStart(3)}  chord fallback ${String(bridged).padStart(2)}   worst road-minus-chord ${worst.toFixed(0).padStart(5)} m  ${worstAt}`);
}
console.log(`\nTOTAL legs ${totalLegs}, chord fallback ${totalBridged} (${(100 * totalBridged / totalLegs).toFixed(1)}%)`);
