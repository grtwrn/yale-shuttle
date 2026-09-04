/**
 * COPY of the kalman worktree's uncommitted `anchor-plumbing.ts` (another agent's work,
 * 2026-09-03), vendored so the 60.5% / 62.4% plumbing figure can be re-run from
 * this tree. Reviewed and re-run by the verifier; numbers reproduce exactly.
 */
/**
 * DID THE FILTER'S ANCHOR EVER REACH THE ETA?
 *
 * `eta-stability.ts` feeds each arm a lat/lon and lets
 * `computeUpcomingArrivals` re-derive the anchor with `findRouteAnchor`. But
 * its cause-attribution reads `diagByArm[arm].anchor`, which for the filter
 * arms is the FILTER's leg and for detAnchor is the DETECTOR's index. If those
 * two disagree, "anchor flips fell 84%" and "a perfect anchor is worth 4%" are
 * statements about different anchors.
 *
 * This script measures only that: per poll, the believed leg vs the anchor
 * `computeUpcomingArrivals` would actually use for the same fed bus.
 *
 *   TZ=America/New_York REPLAY_DB=./store/snap2.db npx tsx scripts/eta-replay/anchor-plumbing.ts
 */
import { loadNet, fmtEt } from "./common.js";
import { planTracks, stepMany, type BusObservation, type BusState } from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { findRouteAnchor, isBusOnRoute, registerRoutePaths } from "../../web/src/anchor";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes";
import { buildGeometry, pointAt, projectOnLeg, step as filterStep, type FilterState, type RouteGeometry } from "./progress-filter.js";

const AT_STOP_MAX_M = 75;
const MAX_POLL_GAP_MS = 20_000;

const net = loadNet();
const { db, network } = net;
registerRoutePaths(net.routePaths);

type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const pos = db.prepare(`SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
                        FROM raw_positions ORDER BY collected_at, id`).all() as PosRow[];
console.error(`raw positions ${pos.length}, ${fmtEt(pos[0]!.t)} .. ${fmtEt(pos[pos.length - 1]!.t)} ET`);

const polls: BusObservation[][] = [];
{
  let cur: BusObservation[] = [];
  let curAt = -1;
  for (const p of pos) {
    if (p.t !== curAt) { if (cur.length) polls.push(cur); cur = []; curAt = p.t; }
    cur.push({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t });
  }
  if (cur.length) polls.push(cur);
}

const geoByLabel = new Map<string, RouteGeometry>();
for (const cfg of ROUTE_LISTS) {
  const path = net.routePaths[String(cfg.routeIds[0]!)];
  const stops = mergedRouteStops(cfg, net.routeStops);
  const ll = stops.map((sid) => net.stopCoords[sid]).filter(Boolean) as Array<{ lat: number; lon: number }>;
  if (!path || ll.length !== stops.length || ll.length < 3) continue;
  try { geoByLabel.set(cfg.label, buildGeometry(path, ll)); } catch { /* untraceable */ }
}

type Series = "shippedAnchor" | "filterLeg" | "filterUsed" | "detLeg" | "detUsed";
const SERIES: Series[] = ["shippedAnchor", "filterLeg", "filterUsed", "detLeg", "detUsed"];
interface Acc { flips: number; n: number; }
const acc: Record<Series, Acc> = Object.fromEntries(SERIES.map((s) => [s, { flips: 0, n: 0 }])) as any;
const agree = { filter: 0, filterN: 0, det: 0, detN: 0 };
// per route-label flips, for the fold-back routes
const byLabel = new Map<string, Record<string, number>>();

const states = new Map<string, BusState>();
const filterStates = new Map<string, FilterState>();
const prevBy = new Map<string, { t: number; v: Record<Series, number>; label: string }>();

for (const poll of polls) {
  const plan = planTracks(poll);
  stepMany(network, states, poll, plan);
  for (const o of poll) {
    const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(o.routeId));
    if (!cfg) continue;
    const stops = mergedRouteStops(cfg, net.routeStops);
    const geo = geoByLabel.get(cfg.label);
    const key = plan.keys.get(o.busId) ?? o.busName;
    const st = states.get(key);
    const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
    const cand = st && dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
    const at = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.enteredAt } : null;

    const base = { bus_id: o.busId, bus_name: o.busName, route_id: o.routeId, heading: o.heading, last_stop_id: o.lastStopId as number };
    const withAt = (b: any) => ({ ...b, stationary: at != null, ...(at ? { at_stop_id: at.id, at_stop_since: new Date(at.since).toISOString().replace(/Z$/, "") } : {}) });

    const rawBus = withAt({ ...base, lat: o.lat, lon: o.lon });
    if (!isBusOnRoute(rawBus as any, stops, net.stopCoords)) continue;
    const shippedAnchor = findRouteAnchor(rawBus as any, stops, net.stopCoords);

    let filterLeg = -1, filterUsed = -1;
    if (geo) {
      const fkey = `${cfg.label}|${o.busName}`;
      const r = filterStep(geo, filterStates.get(fkey) ?? null, { lat: o.lat, lon: o.lon, t: o.collectedAt });
      filterStates.set(fkey, r.state);
      filterLeg = r.out.leg;
      filterUsed = findRouteAnchor(withAt({ ...base, lat: r.out.lat, lon: r.out.lon }) as any, stops, net.stopCoords);
      agree.filterN++; if (filterLeg === filterUsed) agree.filter++;
    }

    let detLeg = -1, detUsed = -1;
    if (geo && st) {
      let bestLeg = -1, bestPerp = Infinity;
      for (let li = 0; li < stops.length; li++) {
        if (stops[li] !== st.nearestStopId) continue;
        const pr = projectOnLeg(geo, li, { lat: o.lat, lon: o.lon });
        if (pr && pr.perp < bestPerp) { bestPerp = pr.perp; bestLeg = li; }
      }
      if (bestLeg >= 0) {
        const pr = projectOnLeg(geo, bestLeg, { lat: o.lat, lon: o.lon })!;
        const pt = pointAt(geo, pr.progress);
        detLeg = bestLeg;
        detUsed = findRouteAnchor(withAt({ ...base, lat: pt.lat, lon: pt.lon }) as any, stops, net.stopCoords);
        agree.detN++; if (detLeg === detUsed) agree.det++;
      }
    }

    const v: Record<Series, number> = { shippedAnchor, filterLeg, filterUsed, detLeg, detUsed };
    const pk = `${cfg.label}|${o.busName}`;
    const prev = prevBy.get(pk);
    if (prev && o.collectedAt - prev.t > 0 && o.collectedAt - prev.t <= MAX_POLL_GAP_MS) {
      const lab = byLabel.get(cfg.label) ?? {};
      for (const s of SERIES) {
        const a = prev.v[s], b = v[s];
        if (a < 0 || b < 0) continue;
        acc[s].n++;
        const adv = b - a;
        const flip = adv !== 0 && adv !== 1 && !(a === stops.length - 1 && b === 0);
        if (flip) { acc[s].flips++; lab[s] = (lab[s] ?? 0) + 1; }
        lab[`${s}_n`] = (lab[`${s}_n`] ?? 0) + 1;
      }
      byLabel.set(cfg.label, lab);
    }
    prevBy.set(pk, { t: o.collectedAt, v, label: cfg.label });
  }
}

console.log("\n== anchor flips per consecutive-poll pair (flip = index moved by anything but 0 or +1) ==");
for (const s of SERIES) {
  const a = acc[s];
  console.log(`  ${s.padEnd(15)} ${String(a.flips).padStart(7)} / ${String(a.n).padStart(7)}  ${(100 * a.flips / Math.max(1, a.n)).toFixed(2)}%`);
}
console.log("\n== does the BELIEVED leg equal the anchor computeUpcomingArrivals actually uses? ==");
console.log(`  filter : ${agree.filter}/${agree.filterN} = ${(100 * agree.filter / Math.max(1, agree.filterN)).toFixed(1)}%`);
console.log(`  det    : ${agree.det}/${agree.detN} = ${(100 * agree.det / Math.max(1, agree.detN)).toFixed(1)}%`);
console.log("\n== per route label ==");
const rows = [...byLabel.entries()].sort((a, b) => (b[1].shippedAnchor ?? 0) - (a[1].shippedAnchor ?? 0));
console.log("  label                shipped%   filterLeg%  filterUsed%  detLeg%   detUsed%");
for (const [lab, r] of rows) {
  const p = (s: string) => r[`${s}_n`] ? (100 * (r[s] ?? 0) / r[`${s}_n`]!).toFixed(2).padStart(8) : "     n/a";
  console.log(`  ${lab.padEnd(20)} ${p("shippedAnchor")} ${p("filterLeg")} ${p("filterUsed")} ${p("detLeg")} ${p("detUsed")}`);
}
