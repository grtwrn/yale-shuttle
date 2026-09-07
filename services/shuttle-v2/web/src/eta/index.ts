/**
 * The ring-posterior estimator, behind `computeUpcomingArrivals`' contract.
 *
 * Enabled per route by `MODEL_ROUTE_IDS`, the same way the stand/drive split
 * was rolled out (`SPLIT_SERVED_ROUTE_IDS` in calibrator.ts): a route on the
 * list is priced from a distribution on the ring (filter.ts -> arrival.ts);
 * every other route runs the legacy arithmetic in arrivals.ts unchanged. The
 * list widens route by route on the rider simulator's FIXED/INTRODUCED split
 * (docs/rider-sim.md), never by argument.
 *
 * State rides the caller's `AnchorStore` entry (`belief`, `floors`), so a
 * storeless call — a replay, a hypothetical, a pure test — prices from the
 * stateless prior and remembers nothing, exactly as the anchor gate does.
 */

import { routePathFor } from "../anchor";
import type { AnchorStore, GatedAnchor } from "../anchorGate";
import type { LatLon } from "../geo";
import type { BusData } from "../map-data";
import type { RouteListConfig } from "../routes";
import { priceRoute, type Floors, type StopArrival } from "./arrival";
import { stepBelief, type Belief } from "./filter";
import { ringFor, setRingProfile, type Ring } from "./ring";
import { buildTables, globalClassPools, type ClassPools, type DwellLike, type SegmentLike } from "./tables";

/**
 * Routes priced by the model: every route the payload lists. A route whose
 * tables carry no measured drive at all (the two grocery lines, until they
 * have `legs`) is priced by the legacy arithmetic instead — see
 * `arrivalsForBus` returning null — so the dispatch is data-driven, not a
 * list. The set is kept for the replays' override (`modelRouteIds`).
 */
export const MODEL_ROUTE_IDS: ReadonlySet<string> = new Set(["1", "2", "3", "4", "6", "8", "9", "10", "13", "14", "15", "16", "17", "18", "19"]);

/** The displayed quantile. 0.5 = the median; see the plan's Step 4 sweep. */
export const DISPLAY_TAU = 0.5;

/**
 * The replays pair the model against the legacy arithmetic in ONE process
 * (scripts/eta-replay/gps-replay.ts, `MODEL_ROUTES=`), so the allowlist can be
 * overridden through a global the browser never sets. Never read anywhere
 * else; never a runtime switch for riders.
 */
export function modelRouteIds(): ReadonlySet<string> {
  const g = globalThis as { __SHUTTLE_MODEL_ROUTES__?: ReadonlySet<string> };
  return g.__SHUTTLE_MODEL_ROUTES__ ?? MODEL_ROUTE_IDS;
}

export function modelServesRoute(cfg: RouteListConfig): boolean {
  const ids = modelRouteIds();
  return cfg.routeIds.some((r) => ids.has(String(r)));
}

/**
 * The ring for a bus's route and the canonical sequence, or null when the
 * geometry cannot be traced. Keyed on the BUS's route id, which is what the
 * payload registers the polyline under (`registerRoutePaths`) and what
 * `resolveAnchorIndex` has in hand, so both answer from one ring.
 */
export function ringForBus(bus: { route_id: number | string }, stops: readonly number[], stopCoords: Record<number, LatLon>): Ring | null {
  return ringFor(bus.route_id, routePathFor(bus.route_id), stops, stopCoords);
}

interface ModelEntry extends GatedAnchor { belief?: Belief | undefined; floors?: Floors | undefined }

function entryFor(store: AnchorStore, key: string): ModelEntry {
  let e = store.get(key) as ModelEntry | undefined;
  if (!e) {
    e = { index: -1, lat: 0, lon: 0, atStopId: null, lastStopId: null, disagreeSince: null, seenAt: 0 };
    store.set(key, e);
  }
  return e;
}

/**
 * Step the bus's belief for this poll (idempotent within a poll) and return
 * it. With no store, a fresh belief from the fix alone.
 */
export function beliefFor(
  store: AnchorStore | undefined,
  key: string,
  bus: BusData,
  ring: Ring,
  stops: readonly number[],
  now: number,
): Belief {
  if (!store) return stepBelief(undefined, ring, bus, now, stops);
  const e = entryFor(store, key);
  const b = stepBelief(e.belief, ring, bus, now, stops);
  e.belief = b;
  return b;
}

export interface ModelArrival extends StopArrival { busName: string }

/**
 * Price every target stop for one bus, or null when the model declines the
 * route and the caller must run the legacy arithmetic: a BRIDGED ring (the
 * published line cannot be traced through the stop sequence), or tables with
 * no hop the model can put a number on at all.
 *
 * `dwellsByRoute` is every route's dwell table (the payload's `dwells`), from
 * which the all-routes stand pools are pooled; omit it and a route leans only
 * on its own tables.
 */
export function arrivalsForBus(
  store: AnchorStore | undefined,
  key: string,
  bus: BusData,
  ring: Ring,
  stops: readonly number[],
  stopCoords: Record<number, LatLon>,
  routeSegs: Record<string, SegmentLike>,
  routeDwells: Record<string, DwellLike>,
  targetStopIds: ReadonlySet<number>,
  now: number,
  tau = DISPLAY_TAU,
  dwellsByRoute?: Record<string, Record<string, DwellLike>>,
): StopArrival[] | null {
  if (ring.bridged) return null;
  const tables = tablesFor(ring, stops, stopCoords, routeSegs, routeDwells, dwellsByRoute);
  if (!tables.priced) return null;
  const belief = beliefFor(store, key, bus, ring, stops, now);
  let floors: Floors | undefined;
  if (store) {
    const e = entryFor(store, key);
    if (!e.floors) e.floors = { map: new Map() };
    floors = e.floors;
  }
  return priceRoute(belief, ring, tables, stops, targetStopIds, now, tau, floors);
}

/** Whether the model prices this route's payload at all (its tables carry a measured drive). */
export function modelPricesRoute(ring: Ring, stops: readonly number[], stopCoords: Record<number, LatLon>, routeSegs: Record<string, SegmentLike>, routeDwells: Record<string, DwellLike>, dwellsByRoute?: Record<string, Record<string, DwellLike>>): boolean {
  // A route whose published line cannot be traced through its stop sequence
  // (a leg had to be bridged with a chord) is a route whose sequence does not
  // describe how the buses drive: Green's West Campus spur, where buses call
  // at West Haven station before Building 900 on the return and the served
  // leg times carry the station stop inside an 11 km highway hop. No model
  // on that ring can be right, and the legacy arithmetic is no worse. The
  // condition is the geometry's, not a route list.
  if (ring.bridged) return false;
  return tablesFor(ring, stops, stopCoords, routeSegs, routeDwells, dwellsByRoute).priced;
}

// Tables (and the chain prefix sums behind them, arrival.ts) are rebuilt only
// when the served numbers change. Keyed on the segment table's identity — one
// object per payload — and on a fingerprint of the dwell table's CONTENT,
// because the rider simulator (and any caller that merges a patch) hands over
// a fresh dwell object every poll; keyed on identity alone this rebuilt the
// prefix sums for every rider on every poll, a second per poll.
const tableCache = new WeakMap<object, Map<string, ReturnType<typeof buildTables>>>();
function mixInto(h: number, routeDwells: Record<string, DwellLike>): number {
  const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 16777619); };
  for (const k in routeDwells) {
    const d = routeDwells[k]!;
    for (let i = 0; i < k.length; i++) mix(k.charCodeAt(i));
    mix(d.qn ?? d.n);
    mix(Math.round((d.pstop ?? -1) * 1000));
    if (d.q) for (const x of d.q) mix(Math.round(x));
  }
  return h;
}
function dwellFingerprint(routeDwells: Record<string, DwellLike>): string {
  return (mixInto(2166136261, routeDwells) >>> 0).toString(16);
}

// The all-routes pools are pooled once per distinct dwell payload, by
// CONTENT, for the same reason as the tables above: a caller that merges a
// patch hands over a fresh object every poll, and pooling every route's
// tables on every poll for every rider is not free.
const globalPoolCache = new Map<string, ClassPools>();
export function globalPoolsFor(dwellsByRoute: Record<string, Record<string, DwellLike>>): { pools: ClassPools; key: string } {
  let h = 2166136261;
  for (const r in dwellsByRoute) {
    for (let i = 0; i < r.length; i++) h = Math.imul(h ^ r.charCodeAt(i), 16777619);
    h = mixInto(h, dwellsByRoute[r]!);
  }
  const key = (h >>> 0).toString(16);
  let pools = globalPoolCache.get(key);
  if (!pools) {
    if (globalPoolCache.size > 8) globalPoolCache.clear();
    pools = globalClassPools(dwellsByRoute);
    globalPoolCache.set(key, pools);
  }
  return { pools, key };
}
function tablesFor(
  ring: Ring, stops: readonly number[], stopCoords: Record<number, LatLon>,
  routeSegs: Record<string, SegmentLike>, routeDwells: Record<string, DwellLike>,
  dwellsByRoute?: Record<string, Record<string, DwellLike>>,
) {
  let bySegs = tableCache.get(routeSegs);
  if (!bySegs) { bySegs = new Map(); tableCache.set(routeSegs, bySegs); }
  const global = dwellsByRoute ? globalPoolsFor(dwellsByRoute) : undefined;
  const key = ring.key + "|" + dwellFingerprint(routeDwells) + "|" + (global?.key ?? "");
  let t = bySegs.get(key);
  if (!t) {
    if (bySegs.size > 8) bySegs.clear();
    t = buildTables(stops, stopCoords, routeSegs, routeDwells, ring, global?.pools);
    bySegs.set(key, t);
    // The kernel's profile lives on the shared ring, so every call site —
    // including the table-free `resolveAnchorIndex` — steps with the same speeds.
    setRingProfile(ring, t.hops.map((h) => h.speedMps), t.stops.map((st) => st.pStop), t.stops.map((st) => st.measured ? st.stand : null), t.stops.map((st) => st.layover));
  }
  return t;
}
