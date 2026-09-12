/** Replay the DEPLOYED client over captured /api/buses payloads for route 9. */
import fs from "node:fs";
import { computeUpcomingArrivals, nextArrivalAfterPinned } from "../web/src/arrivals.ts";
import { registerRoutePaths } from "../web/src/anchor.ts";
import { resolveStandingStop, anchorKeyFor } from "../web/src/liveAnchor.ts";
import { ROUTE_LISTS, mergedRouteStops } from "../web/src/routes.ts";
import { applyModelParams } from "../web/src/eta/params.ts";
import { beliefFor, ringForBus, arrivalsForBus, liveAnchorStore } from "../web/src/eta/index.ts";
import { stopEtaText, standChipFor } from "../web/src/standWait.ts";
import { arrivalBand } from "../web/src/standWait.ts";

const dir = process.env.PAY!;
const files = fs.readdirSync(dir).sort().filter(f => f.endsWith(".json"));
const cfg = ROUTE_LISTS.find(c => c.routeIds[0] === "9")!;
const out: any[] = [];
let first = true;
for (const f of files) {
  const m = f.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  if (!m) throw new Error("bad name " + f);
  const now = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  if (!Number.isFinite(now)) throw new Error("bad clock " + f);
  const pay = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
  if (first) { registerRoutePaths(pay.route_paths); if (pay.model_params?.params) applyModelParams(pay.model_params.params); }
  const bus = pay.buses.find((b: any) => String(b.route_id) === "9");
  if (!bus) { out.push({ f, et: new Date(now).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }), none: true }); continue; }
  const stops = mergedRouteStops(cfg, pay.routes);
  const stopCoords: Record<number, any> = {};
  for (const [k, v] of Object.entries(pay.stop_coords ?? {})) stopCoords[Number(k)] = Array.isArray(v) ? { lat: (v as any)[0], lon: (v as any)[1] } : v;
  const routeDwells = pay.dwells["9"] ?? {};
  // Exactly StopList's call.
  const live = computeUpcomingArrivals(stops, pay.buses, pay.routes, stopCoords, pay.segments, now, pay.dwells, liveAnchorStore);
  const ring = ringForBus(bus, stops, stopCoords)!;
  const key = anchorKeyFor(cfg.label, bus.bus_name);
  const belief: any = beliefFor(liveAnchorStore, key, bus, ring, stops, now);
  const rest = resolveStandingStop(bus, cfg, pay.routes, stopCoords, now, liveAnchorStore);
  const chip = standChipFor(rest, routeDwells, pay.dwells);
  // Richer rows straight from the model (leadMass / standingAt / occurrence).
  const rich: any[] = arrivalsForBus(liveAnchorStore, key, bus, ring, stops, stopCoords,
    pay.segments["9"] ?? {}, routeDwells, new Set(stops), now, undefined, pay.dwells);
  const entry: any = liveAnchorStore.get(key);
  const byStop: Record<string, any> = {};
  const seen = new Set<number>();
  for (const a of live) {
    if (a.routeLabel !== cfg.label || seen.has(a.stopId)) continue;
    seen.add(a.stopId);
    const r = rich.find(x => x.stopId === a.stopId);
    const band = arrivalBand(null, { low: a.low, high: a.high, departNow: a.departNow, computedAtMs: now }, now);
    const second = nextArrivalAfterPinned(live.filter(x => x.stopId === a.stopId), bus.bus_name, a.eta);
    byStop[a.stopId] = { eta: Math.round(a.eta), low: Math.round(a.low), high: Math.round(a.high),
      dn: Math.round(a.departNow), lf: Math.round(a.lowFloor), ahead: a.stopsAhead, est: a.estimated,
      leadMass: r ? Math.round(r.leadMass * 1000) / 1000 : null, standingAt: r ? r.standingAt : null, occ: r ? r.occurrence : null,
      band: band ? [Math.round(band.lowSec), Math.round(band.highSec)] : null,
      second: second ? Math.round(second.eta) : null,
      text: stopEtaText(rest, a, routeDwells, pay.dwells) };
  }
  out.push({ f, now, et: new Date(now).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }),
    bus: { lat: bus.lat, lon: bus.lon, stationary: bus.stationary, at: bus.at_stop_id ?? null,
      since: bus.at_stop_since ?? null, ss: bus.stationary_since ?? null, last: bus.last_stop_id },
    rest, chip, belief: { rested: belief.rested, restStop: belief.restStop,
      restStopId: belief.restStop >= 0 ? stops[belief.restStop] : null, restSince: belief.restSince,
      restApproach: belief.restApproach, leftStop: belief.leftStop, lead: belief.lead,
      standLeg: belief.standLeg, fresh: belief.fresh, lastStopId: belief.lastStopId, zoneKey: belief.zoneKey },
    floors: entry?.floors ?? null, byStop });
}
fs.writeFileSync(process.env.OUT!, out.map(r => JSON.stringify(r)).join("\n"));
console.error("wrote " + out.length + " polls");
