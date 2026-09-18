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

import { routePathFor } from 'file:///home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/anchor.ts';
import type { LatLon } from 'file:///home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/geo.ts';
import type { BusData } from 'file:///home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/map-data.ts';
import { priceRoute, type Floors, type StopArrival } from 'file:///home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-4/kernel-web-src-eta-arrival.mts';
import { stepBelief, type Belief, type FilterBus } from 'file:///home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-4/kernel-web-src-eta-filter.mts';
import { ringFor, setRingProfile, type Ring } from 'file:///home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/ring.ts';
import { buildTables, globalClassPools, type ClassPools, type DwellLike, type SegmentLike } from 'file:///home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/tables.ts';
import { releaseModelEnabled, type ReleasePin } from 'file:///home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/release.ts';

/**
 * The displayed quantile. 0.5 = the median.
 *
 * SWEPT AND LEFT HERE, not defaulted here: `docs/display-quantile-sweep.md`
 * (PR #165). The pooled aggregates favour 0.55–0.60; the paired rider
 * simulator refuses them — τ = 0.55 cost 42% more strands on 2,001 identical
 * Red waits. `display-tau.test.ts` pins it so the next move is a measured one.
 */
export const DISPLAY_TAU = 0.5;

/**
 * Per-vehicle memory: the belief on the ring and the #119 display floors.
 * Keyed by `anchorKeyFor(routeLabel, busName)` (liveAnchor.ts) — the bus
 * NAME, never `bus_id`, which TransLoc reissues per service block.
 */
export interface ModelEntry { belief?: Belief | undefined; floors?: Floors | undefined; releasePin?: ReleasePin | undefined; releaseSmoothing?: Map<number, { at: number; row: StopArrival }> }
export type AnchorStore = Map<string, ModelEntry>;

/**
 * The one store the live app passes everywhere — the map, the route cards,
 * the trip card and the ride page — so every surface answers from one
 * belief per bus. Replays and tests make their own.
 */
export const liveAnchorStore: AnchorStore = new Map();

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

/**
 * `buses[].lap` as the estimator wants it: numeric stop ids, seconds, and
 * nothing that is not a finite non-negative number. Undefined when the server
 * serves none, which is what turns the whole correction off.
 */
function lapAgesOf(bus: BusData): Record<number, number> | undefined {
  const raw = bus.lap;
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<number, number> = {};
  let any = false;
  for (const k in raw) {
    const id = Number(k), v = raw[k];
    if (!Number.isFinite(id) || typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
    out[id] = v;
    any = true;
  }
  return any ? out : undefined;
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
  includeDistribution = false,
): StopArrival[] {
  const tables = tablesFor(ring, ring.stops, stopCoords, routeSegs, routeDwells, dwellsByRoute);
  const belief = beliefFor(store, key, bus, ring, ring.stops, now);
  let floors: Floors | undefined;
  let releasePin: ReleasePin | undefined;
  if (store) {
    const e = entryFor(store, key);
    if (bus.at_stop_id !== undefined && bus.at_stop_id !== null && bus.at_stop_since) {
      const since = new Date(bus.at_stop_since.endsWith('Z') ? bus.at_stop_since : bus.at_stop_since + 'Z').getTime();
      if (Number.isFinite(since) && since <= now) {
        const stopId = Number(bus.at_stop_id), old = e.releasePin;
        const age = lapAgesOf(bus)?.[stopId];
        const lapAtPin = old?.stopId === stopId && old.since === since && old.lapAtPin !== undefined
          ? old.lapAtPin : age === undefined ? undefined : age - (now - since) / 1000;
        e.releasePin = { stopId, since, ...(lapAtPin === undefined ? {} : { lapAtPin }) };
      }
    }
    releasePin = e.releasePin;
    if (!e.floors) e.floors = { map: new Map() };
    floors = e.floors;
  }
  const rows = priceRoute(belief, ring, tables, ring.stops, targetStopIds, now, tau, floors, lapAgesOf(bus), includeDistribution, releasePin);
  // Pool absolute arrival quantiles only while the tracked rest continues.
  // This damps swaps between the leave-now and keep-waiting hypotheses. It
  // imposes no monotone ETA ceiling and releases as soon as the rest ends.
  // Missing lap history retains marginal pricing and the same stabilization.
  if (store && ring.routeId === '3' && releaseModelEnabled() && tables.stops.some(s => s.release)) {
    const entry = entryFor(store, key);
    const memory = entry.releaseSmoothing ??= new Map();
    const active = releasePin && belief.rested && ring.stops[belief.restStop] === releasePin.stopId && tables.stops[belief.restStop]?.release?.stopId === releasePin.stopId;
    for (const row of rows) {
      const rowKey = row.stopId * 2 + row.occurrence, old = memory.get(rowKey);
      const dt = old ? (now - old.at) / 1000 : Infinity;
      if (active && old && dt >= 0 && dt <= 15 && row.stopsAhead <= old.row.stopsAhead) {
        const weight = 1 - Math.exp(-dt / 30);
        const mix = (before: number, current: number) => Math.max(0, (before - dt) * (1 - weight) + current * weight);
        row.eta = mix(old.row.eta, row.eta);
        row.low = Math.min(row.eta, mix(old.row.low, row.low));
        row.high = Math.max(row.eta, mix(old.row.high, row.high));
        if (row.distribution && old.row.distribution?.length === row.distribution.length) {
          row.distribution = row.distribution.map((v, i) => mix(old.row.distribution![i]!, v));
        }
      }
      memory.set(rowKey, { at: now, row: { ...row } });
    }
  }
  return rows;
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
    mix(Math.round((d.lapB ?? 0) * 1e7));
    mix(Math.round(d.lapM ?? -1));
    mix(d.lapN ?? -1);
    if (d.release) {
      const serialized = JSON.stringify(d.release);
      for (let i = 0; i < serialized.length; i++) mix(serialized.charCodeAt(i));
    }
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
    // The per-pass stand tables are keyed by UPSTREAM's index (the server
    // serves `"<stop>#<index>"` against the list it publishes), so a repaired
    // ring asks for its occurrences under the slot upstream gave them.
    t = buildTables(stops, stopCoords, routeSegs, routeDwells, ring, global?.pools, ring.repaired ? ring.order : undefined);
    bySegs.set(key, t);
    // The kernel's profile lives on the shared ring, so every call site —
    // including the table-free `resolveAnchorIndex` — steps with the same speeds.
    setRingProfile(ring, t.hops.map((h) => h.speedMps), t.stops.map((st) => st.pStop), t.stops.map((st) => st.measured ? st.stand : null), t.stops.map((st) => st.layover));
  }
  return t;
}
