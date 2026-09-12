/** Where the standing mass sits across Building 800's two ring passes. */
import fs from "node:fs";
import { registerRoutePaths } from "../web/src/anchor.ts";
import { ROUTE_LISTS, mergedRouteStops } from "../web/src/routes.ts";
import { applyModelParams } from "../web/src/eta/params.ts";
import { beliefFor, ringForBus } from "../web/src/eta/index.ts";
import type { AnchorStore } from "../web/src/eta/index.ts";
import { legMass } from "../web/src/eta/filter.ts";
import { anchorKeyFor } from "../web/src/liveAnchor.ts";

const D = process.env.D!;
const derived = JSON.parse(fs.readFileSync(`${D}/derived.json`, "utf8"));
const tmpl = JSON.parse(fs.readFileSync(`${D}/buses/${fs.readdirSync(`${D}/buses`).sort().filter(f => f.endsWith(".json"))[0]}`, "utf8"));
registerRoutePaths(tmpl.route_paths);
if (tmpl.model_params?.params) applyModelParams(tmpl.model_params.params);
const cfg = ROUTE_LISTS.find(c => c.routeIds[0] === "9")!;
const stops = mergedRouteStops(cfg, tmpl.routes);
const stopCoords: Record<number, any> = {};
for (const [k, v] of Object.entries(tmpl.stop_coords ?? {})) stopCoords[Number(k)] = Array.isArray(v) ? { lat: (v as any)[0], lon: (v as any)[1] } : v;
const iso = (t: number) => new Date(t).toISOString().replace(/Z$/, "");
const store: AnchorStore = new Map();
const key = anchorKeyFor(cfg.label, "#331");
const et = (t: number) => new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
for (const d of derived) {
  if (d.t < Date.parse("2026-09-12T14:05:00Z")) continue;
  if (d.t > Date.parse("2026-09-12T14:17:30Z")) break;
  const bus: any = { bus_id: d.bus_id, bus_name: "#331", route_id: 9, lat: d.lat, lon: d.lon, heading: d.heading,
    last_stop_id: d.last, stationary: d.stationary,
    ...(d.at != null ? { at_stop_id: d.at, at_stop_since: iso(d.atSince) } : {}),
    ...(d.ss != null ? { stationary_since: iso(d.ss) } : {}),
    ...(d.moved != null ? { last_moved_at: iso(d.moved) } : {}) };
  const ring = ringForBus(bus, stops, stopCoords)!;
  const b: any = beliefFor(store, key, bus, ring, ring.stops, d.t);
  if (d.t < Date.parse("2026-09-12T14:15:30Z")) continue;
  const m = legMass(b, ring);
  // in-mask standing mass per zone, the quantity restStopFromBelief argmaxes
  const byZone = new Map<number, number>();
  let inMask = 0;
  for (let c = 0; c < ring.C; c++) {
    if (b.restMask[c] !== 1 || b.p[c] <= 0) continue;
    inMask += b.p[c];
    const zk = ring.nearStop[c] >= 0 ? ring.nearStop[c] : ring.approachOf[c] >= 0 ? 1000 + ring.approachOf[c] : -1;
    if (zk >= 0) byZone.set(zk, (byZone.get(zk) ?? 0) + b.p[c]);
  }
  const zones = [...byZone].sort((x, y) => y[1] - x[1]).slice(0, 4)
    .map(([z, v]) => `${z >= 1000 ? "appr" + (z - 1000) : "stop" + z}(${ring.stops[z >= 1000 ? z - 1000 : z]})=${(v / (inMask || 1) * 100).toFixed(0)}%`);
  console.log(et(d.t), "at=" + d.at, "lead", String(b.lead).padStart(2), "rested", String(b.rested).padEnd(5), "restStop", String(b.restStop).padStart(3),
    "| legMass 12=" + m[12].toFixed(3), "13=" + m[13].toFixed(3), "17=" + m[17].toFixed(3), "18=" + m[18].toFixed(3),
    "| inMask", inMask.toFixed(3), "zones:", zones.join(" "));
}
