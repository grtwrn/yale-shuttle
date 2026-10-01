/** Warm-belief replay: synthetic payloads from derived fields, 5 s cadence. */
import fs from "node:fs";
import { computeUpcomingArrivals } from "../web/src/arrivals.ts";
import { registerRoutePaths } from "../web/src/anchor.ts";
import { resolveStandingStop, anchorKeyFor } from "../web/src/liveAnchor.ts";
import { ROUTE_LISTS, mergedRouteStops } from "../web/src/routes.ts";
import { applyModelParams } from "../web/src/eta/params.ts";
import { beliefFor, ringForBus, arrivalsForBus } from "../web/src/eta/index.ts";
import type { AnchorStore } from "../web/src/eta/index.ts";
import { stopEtaText } from "../web/src/standWait.ts";

const D = process.env.D!;
const derived = JSON.parse(fs.readFileSync(`${D}/derived.json`, "utf8"));
const tmpl = JSON.parse(fs.readFileSync(`${D}/buses/${fs.readdirSync(`${D}/buses`).sort().filter(f => f.endsWith(".json"))[0]}`, "utf8"));
registerRoutePaths(tmpl.route_paths);
if (tmpl.model_params?.params) applyModelParams(tmpl.model_params.params);
const cfg = ROUTE_LISTS.find(c => c.routeIds[0] === "9")!;
const stops = mergedRouteStops(cfg, tmpl.routes);
const stopCoords: Record<number, any> = {};
for (const [k, v] of Object.entries(tmpl.stop_coords ?? {})) stopCoords[Number(k)] = Array.isArray(v) ? { lat: (v as any)[0], lon: (v as any)[1] } : v;
const routeDwells = tmpl.dwells["9"] ?? {};
const iso = (t: number) => new Date(t).toISOString().replace(/Z$/, "");
const START = Date.parse(process.env.FROM ?? "2026-09-12T14:05:00Z");
const store: AnchorStore = new Map();
const out: any[] = [];
for (const d of derived) {
  if (d.t < START) continue;
  const bus: any = { bus_id: d.bus_id, bus_name: d.bus_name, route_id: 9, lat: d.lat, lon: d.lon,
    heading: d.heading, last_stop_id: d.last, stationary: d.stationary,
    ...(d.at != null ? { at_stop_id: d.at, at_stop_since: iso(d.atSince) } : {}),
    ...(d.ss != null ? { stationary_since: iso(d.ss) } : {}),
    ...(d.moved != null ? { last_moved_at: iso(d.moved) } : {}) };
  const now = d.t;
  const live = computeUpcomingArrivals(stops, [bus], tmpl.routes, stopCoords, tmpl.segments, now, tmpl.dwells, store);
  const ring = ringForBus(bus, stops, stopCoords)!;
  const key = anchorKeyFor(cfg.label, bus.bus_name);
  const belief: any = beliefFor(store, key, bus, ring, ring.stops, now);
  const rest = resolveStandingStop(bus, cfg, tmpl.routes, stopCoords, now, store);
  const rich: any[] = arrivalsForBus(store, key, bus, ring, stops, stopCoords,
    tmpl.segments["9"] ?? {}, routeDwells, new Set(stops), now, undefined, tmpl.dwells);
  const byStop: Record<string, any> = {};
  const seen = new Set<number>();
  for (const a of live) {
    if (a.routeLabel !== cfg.label || seen.has(a.stopId)) continue;
    seen.add(a.stopId);
    const r = rich.find(x => x.stopId === a.stopId);
    byStop[a.stopId] = { eta: Math.round(a.eta), ahead: a.stopsAhead, mass: r ? Math.round(r.leadMass * 100) / 100 : null,
      text: stopEtaText(rest, a, routeDwells, tmpl.dwells) };
  }
  out.push({ t: now, et: new Date(now).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }),
    at: d.at, stat: d.stationary, last: d.last,
    lead: belief.lead, leadStopId: ring.stops[belief.lead], rested: belief.rested,
    restStop: belief.restStop, restStopIdRing: belief.restStop >= 0 ? ring.stops[belief.restStop] : null,
    restStopIdPublished: belief.restStop >= 0 ? stops[belief.restStop] : null,
    rest, byStop });
}
fs.writeFileSync(process.env.OUT!, out.map(r => JSON.stringify(r)).join("\n"));
console.error(`wrote ${out.length} warm polls from ${out[0]?.et} to ${out.at(-1)?.et}`);
