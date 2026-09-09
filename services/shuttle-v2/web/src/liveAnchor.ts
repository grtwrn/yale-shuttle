/**
 * ONE answer per bus per poll.
 *
 * Every surface that asks where a bus is — the countdown, the map marker, the
 * route cards' "N stops away", the ride page, the pause chip — reads the SAME
 * belief off the SAME store (`liveAnchorStore`, web/src/eta/index.ts). It
 * exists because they used not to: five render sites in TransitMap.tsx once
 * called a stateless anchor with no memory while the countdown beside them
 * used a gated one, and the operator watched the stops-away column read
 * 3 / 4 / 4 / 2 / 4 on consecutive polls (2026-09-04, Red #316 oscillating
 * between 344 Winchester and Canal/Munson) while the ETA held still. Two
 * numbers, one screen, contradicting each other.
 *
 * So the sequence lives here once and everything runs it: build the ring,
 * step the belief for this poll (idempotent within a poll — a second call
 * with the same payload object is a query), answer from it.
 *
 * THE INDEX SPACE IS THE STORE'S. The belief's lead leg is an index into the
 * canonical `mergedRouteStops` sequence, which keeps the primary route's
 * stops VERBATIM — repeats and all, because routes 9 and 10 pass West Campus
 * twice and de-duplicating loses real legs. TransitMap's render sites build
 * their own de-duplicated list (Green 23 -> 20 stops, Purple 15 -> 11), so an
 * index means something different there. Hence {@link anchorIndexOnList}:
 * anchor on the canonical list, then translate the answer back to the
 * caller's list by STOP ID.
 *
 * HYPOTHETICAL CALLERS PASS THEIR OWN STORE, OR NONE. With no store the
 * belief is built from the fix alone and nothing is remembered — which is
 * what the replay harnesses and the pure tests depend on.
 */
import { beliefFor, ringForBus, type AnchorStore } from "./eta";
import { standingSec, type FilterBus } from "./eta/filter";
import type { LatLon } from "./geo";
import { mergedRouteStops, type RouteListConfig } from "./routes";

/** What the anchor needs of a bus: a fix, the clocks, and the route whose line it is measured against. */
export type AnchorBus = FilterBus & { route_id: number | string };

/**
 * The store's per-vehicle key. Route label plus the bus NAME, never `bus_id`:
 * TransLoc reissues ids per service block (~1,000 ids for 50 buses in 30 days)
 * and `bus_name` is the identity.
 */
export function anchorKeyFor(routeLabel: string, busName: string): string {
  return `${routeLabel}|${busName}`;
}

/**
 * Where this bus is on `stops`: the leg the countdown is priced on, with the
 * same hysteresis (`leadLeg` in eta/filter.ts), so "N stops away" and the
 * number beside it come from one posterior.
 *
 * Returns -1 when there is nothing to answer from — an empty stop list, or a
 * stop with no coordinate, which is the one case the ring cannot be built.
 */
export function resolveAnchorIndex(
  bus: AnchorBus,
  stops: number[],
  stopCoords: Record<number, LatLon>,
  key: string,
  now: number,
  store?: AnchorStore | undefined,
): number {
  const ring = ringForBus(bus, stops, stopCoords);
  if (!ring) return -1;
  const lead = beliefFor(store, key, bus, ring, stops, now).lead;
  // The belief runs on the RING's sequence, which on a route whose order was
  // repaired against its published line is not upstream's (#160,
  // src/network/alignStops.ts); every caller indexes upstream's list.
  return ring.repaired ? (ring.order[lead] ?? lead) : lead;
}

/**
 * The same answer, expressed as an index into the caller's own stop list.
 *
 * The anchor is always computed on the canonical `mergedRouteStops` sequence —
 * that is the space the shared store's memory is in — and then translated by
 * stop id. A caller whose list de-duplicates a repeated stop gets that stop's
 * first slot, which is all such a list can express and exactly what it showed
 * before; a caller passing the canonical list gets the index untouched.
 */
export function anchorIndexOnList(
  bus: AnchorBus & { bus_name: string },
  cfg: RouteListConfig,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  displayStops: number[],
  now: number,
  store?: AnchorStore | undefined,
): number {
  const canonical = mergedRouteStops(cfg, routeStops);
  if (canonical.length === 0) return -1;
  const idx = resolveAnchorIndex(
    bus, canonical, stopCoords, anchorKeyFor(cfg.label, bus.bus_name), now, store,
  );
  if (idx < 0) return idx;
  const stopId = canonical[idx];
  if (stopId === undefined) return -1;
  // Same length and the same stop in that slot: the caller's list IS the
  // canonical sequence (it just isn't the same array object — `mergedRouteStops`
  // builds a fresh one), so hand the index back untouched. Only a list that
  // de-duplicated a repeat needs the lookup, and there the first slot is all
  // such a list can express.
  if (displayStops.length === canonical.length && displayStops[idx] === stopId) return idx;
  return displayStops.indexOf(stopId);
}

/**
 * WHICH STOP IS THIS BUS STANDING AT, AND FOR HOW LONG — one answer, shared.
 *
 * The price has to decide this to bill the residual stand, and the SCREEN has
 * to decide it to draw the pause chip. They once decided it differently: the
 * chip read `at_stop_id` / `at_stop_since` straight off the payload, which
 * stopped agreeing the moment a bus took its layover short of the marker —
 * no `at_stop_id` is published there, so the countdown priced it as standing
 * while the chip showed nothing and the row read as a bus still rolling.
 * That is report #102, "a bus sitting in a garage lot was counted down as if
 * on its way". So the decision lives here, once, and both read it.
 *
 * The answer is the belief's rest: `restStop` is the stop whose zone held the
 * standing mass when the rest was established (the approach cells of a
 * layover stop count as that stop, so the short-of-the-marker rest lands on
 * 344 Winchester), and the clock is the rest's earliest known origin, the
 * clock the stand tables were measured with (eta/filter.ts).
 *
 * `approach` is true when the bus is not, physically, at the published
 * marker — the caller needs it because the honest label differs.
 *
 * Storeless callers get null: the belief rides the caller's store, so a
 * replay or a pure test behaves as it always did.
 */
export interface StandingAnswer {
  /** Canonical occurrence, including repeated physical stop IDs. */
  stopIndex: number;
  /** The stop the bus is standing at — a canonical-sequence stop id. */
  stopId: number;
  /** Seconds it has been standing, on the same clock the price bills. */
  standingSec: number;
  /** True when the bus is resting short of the marker rather than at it. */
  approach: boolean;
}

export function resolveStandingStop(
  bus: AnchorBus & { bus_name: string; at_stop_id?: number | null | undefined },
  cfg: RouteListConfig,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  now: number,
  store: AnchorStore | undefined,
): StandingAnswer | null {
  if (!store) return null;
  const stops = mergedRouteStops(cfg, routeStops);
  if (stops.length === 0) return null;
  const ring = ringForBus(bus, stops, stopCoords);
  if (!ring) return null;
  const b = beliefFor(store, anchorKeyFor(cfg.label, bus.bus_name), bus, ring, stops, now);
  if (!b.rested || b.restStop < 0) return null;
  const stopId = ring.stops[b.restStop];
  if (stopId === undefined) return null;
  return {
    stopId,
    stopIndex: b.restStop,
    standingSec: standingSec(b, now),
    approach: !(bus.at_stop_id != null && bus.at_stop_id === stopId),
  };
}
