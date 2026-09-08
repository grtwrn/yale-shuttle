/**
 * The ring-posterior estimator, behind `computeUpcomingArrivals`' contract.
 *
 * It prices EVERY route, and there is no second estimator behind it. It went
 * out route by route on the rider simulator's FIXED/INTRODUCED split
 * (docs/rider-sim.md) behind an allowlist, then declined two classes on their
 * own evidence — a route with no measured drive (`tables.priced`, the grocery
 * lines) and a ring the published line could not trace (`ring.bridged`,
 * Green) — to the legacy anchor + gate + stall-credit + approach-zone
 * arithmetic in arrivals.ts. Both declines were closed by measurement, not by
 * argument: #157 gave a line the collector has not timed the NETWORK's pooled
 * pace and stand pools (tables.ts), and #160 read Green's stop ORDER off its
 * published polyline (`alignStops.ts`), which took its replay median 288.8 ->
 * 70.1 s. With no route left to decline, the legacy arithmetic had no caller,
 * and it is gone (2026-09-07). `eta/no-bridged-ring.test.ts` pins the second
 * half of that: no route in the checked-in payload fixture builds a bridged
 * ring, so an upstream sequence change fails CI rather than resurrecting a
 * dead arm that is no longer there to catch it.
 *
 * The only thing that declines a route now is having no ring at all — fewer
 * than two stops, or a stop with no coordinate — and then the route shows no
 * times, because there is nothing to price on.
 *
 * State rides the caller's `AnchorStore` entry (`belief`, `floors`), so a
 * storeless call — a replay, a hypothetical, a pure test — prices from the
 * stateless prior and remembers nothing.
 */

import { routePathFor } from "../anchor";
import type { LatLon } from "../geo";
import type { BusData } from "../map-data";
import { priceRoute, type Floors, type StopArrival } from "./arrival";
import { stepBelief, type Belief, type FilterBus } from "./filter";
import { ringFor, setRingProfile, type Ring } from "./ring";
import { etHourOf } from "../schedule";
import { buildTables, globalClassPools, type ClassPools, type DwellLike, type HourContext, type SegmentLike, type StandHourProfile } from "./tables";

/** The displayed quantile. 0.5 = the median; see the plan's Step 4 sweep. */
export const DISPLAY_TAU = 0.5;

/**
 * Per-vehicle memory: the belief on the ring and the #119 display floors.
 * Keyed by `anchorKeyFor(routeLabel, busName)` (liveAnchor.ts) — the bus
 * NAME, never `bus_id`, which TransLoc reissues per service block.
 */
export interface ModelEntry { belief?: Belief | undefined; floors?: Floors | undefined }
export type AnchorStore = Map<string, ModelEntry>;

/**
 * The one store the live app passes everywhere — the map, the route cards,
 * the trip card and the ride page — so every surface answers from one
 * belief per bus. Replays and tests make their own.
 */
export const liveAnchorStore: AnchorStore = new Map();

/**
 * The live app's copy of the payload's `stand_hours`, set once per poll where
 * the payload lands (TransitMap's fetch) and read by every surface that prices
 * — the map, the route cards, the trip card, the ride page and the pause chip
 * — so they cannot price at different hours or with different profiles.
 *
 * A module-level holder rather than a prop threaded through four components,
 * for the same reason `liveAnchorStore` is one: five call sites in a 6.8k-line
 * file, and a `const` referenced from a dependency array declared later in the
 * component is a TDZ ReferenceError that blank-screens the app.
 *
 * `undefined` until a payload carries one — which is also what every test and
 * every replay sees unless it sets one, so the pre-diurnal behaviour is the
 * default rather than a special case.
 */
export const liveStandHours: { profile: StandHourProfile | undefined } = { profile: undefined };

/**
 * The ring for a bus's route and the canonical sequence, or null when the
 * geometry cannot be traced. Keyed on the BUS's route id, which is what the
 * payload registers the polyline under (`registerRoutePaths`) and what
 * `resolveAnchorIndex` has in hand, so both answer from one ring.
 *
 * A route with no registered line is ringed on its chords — the stop
 * coordinates joined in sequence — so it is still priced; the emission's
 * off-route mixture absorbs the road's bow. That is the cold first render
 * and a route upstream ships without a path, not any of the fifteen lines.
 */
export function ringForBus(bus: { route_id: number | string }, stops: readonly number[], stopCoords: Record<number, LatLon>): Ring | null {
  const path = routePathFor(bus.route_id) ?? chordPath(stops, stopCoords);
  return ringFor(bus.route_id, path, stops, stopCoords);
}

function chordPath(stops: readonly number[], stopCoords: Record<number, LatLon>): readonly (readonly [number, number])[] | undefined {
  const pts: [number, number][] = [];
  for (const sid of stops) {
    const c = stopCoords[sid];
    if (!c) return undefined;
    pts.push([c.lat, c.lon]);
  }
  if (pts.length < 2) return undefined;
  pts.push(pts[0]!);
  return pts;
}

function entryFor(store: AnchorStore, key: string): ModelEntry {
  let e = store.get(key);
  if (!e) {
    e = {};
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
  bus: FilterBus,
  ring: Ring,
  stops: readonly number[],
  now: number,
): Belief {
  const seq = ring.stops.length === ring.N ? ring.stops : stops;
  if (!store) return stepBelief(undefined, ring, bus, now, seq);
  const e = entryFor(store, key);
  const b = stepBelief(e.belief, ring, bus, now, seq);
  e.belief = b;
  return b;
}

export interface ModelArrival extends StopArrival { busName: string }

/**
 * Price every target stop for one bus. `dwellsByRoute` is every route's
 * dwell table (the payload's `dwells`), from which the all-routes stand
 * pools are pooled; omit it and a route leans only on its own tables.
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
  /** The served `stand_hours`; omit and stands are priced as served. */
  standHours?: StandHourProfile,
): StopArrival[] {
  const tables = tablesFor(ring, ring.stops, stopCoords, routeSegs, routeDwells, dwellsByRoute, hourContext(now, standHours));
  const belief = beliefFor(store, key, bus, ring, ring.stops, now);
  let floors: Floors | undefined;
  if (store) {
    const e = entryFor(store, key);
    if (!e.floors) e.floors = { map: new Map() };
    floors = e.floors;
  }
  return priceRoute(belief, ring, tables, ring.stops, targetStopIds, now, tau, floors);
}

// Tables (and the chain prefix sums behind them, arrival.ts) are rebuilt only
// when the served numbers change. Keyed on the segment table's identity — one
// object per payload — and on a fingerprint of the dwell tables' CONTENT,
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
// content, for the same reason as above.
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

/**
 * The hour the stands are priced at, resolved in ET (never `getHours()`), and
 * the profile to price it with. Undefined with no profile, which is what makes
 * an old payload — or a server that has not built one — price exactly as it
 * did before this term existed.
 */
export function hourContext(now: number, standHours: StandHourProfile | undefined): HourContext | undefined {
  return standHours ? { hour: etHourOf(new Date(now)), profile: standHours } : undefined;
}

function tablesFor(
  ring: Ring, stops: readonly number[], stopCoords: Record<number, LatLon>,
  routeSegs: Record<string, SegmentLike>, routeDwells: Record<string, DwellLike>,
  dwellsByRoute?: Record<string, Record<string, DwellLike>>,
  hour?: HourContext,
) {
  let bySegs = tableCache.get(routeSegs);
  if (!bySegs) { bySegs = new Map(); tableCache.set(routeSegs, bySegs); }
  const global = dwellsByRoute ? globalPoolsFor(dwellsByRoute) : undefined;
  // The hour is part of the cache key, so the tables rebuild when it turns —
  // once an hour per route, not once per poll.
  const key = ring.key + "|" + dwellFingerprint(routeDwells) + "|" + (global?.key ?? "") + "|" + (hour ? hour.hour : "-");
  let t = bySegs.get(key);
  if (!t) {
    if (bySegs.size > 8) bySegs.clear();
    // The per-pass stand tables are keyed by UPSTREAM's index (the server
    // serves `"<stop>#<index>"` against the list it publishes), so a repaired
    // ring asks for its occurrences under the slot upstream gave them.
    t = buildTables(stops, stopCoords, routeSegs, routeDwells, ring, global?.pools, ring.repaired ? ring.order : undefined, hour);
    bySegs.set(key, t);
    // The kernel's profile lives on the shared ring, so every call site —
    // including the table-free `resolveAnchorIndex` — steps with the same speeds.
    setRingProfile(ring, t.hops.map((h) => h.speedMps), t.stops.map((st) => st.pStop), t.stops.map((st) => st.measured ? st.stand : null), t.stops.map((st) => st.layover));
  }
  return t;
}
