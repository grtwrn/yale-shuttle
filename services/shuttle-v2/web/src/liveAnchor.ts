/**
 * ONE answer per bus per poll.
 *
 * `findRouteAnchor` is stateless and `gateAnchor` (anchorGate.ts) is what stops
 * its answer moving backwards or jumping without corroboration. The gate's
 * memory lives on a store, and `liveAnchorStore` exists precisely so "the map,
 * the route cards and the trip card" cannot disagree about where a bus is.
 *
 * `computeUpcomingArrivals` ran the full sequence — `noteFix` ->
 * `findRouteAnchor` -> `gateAnchor` — but five places in TransitMap.tsx called
 * `findRouteAnchor` directly with no store, so the screen could hold two
 * answers at once: a gated countdown beside an ungated "N stops away". The
 * operator watched that column read 3 / 4 / 4 / 2 / 4 on consecutive polls
 * (2026-09-04, Red #316 oscillating between 344 Winchester and Canal/Munson)
 * while the ETA beside it stayed put. Two numbers, one screen, contradicting
 * each other.
 *
 * So the sequence lives here once and everything runs it.
 *
 * THE INDEX SPACE IS THE STORE'S. The gate remembers an index, so every caller
 * sharing a store must mean the same thing by it. `computeUpcomingArrivals`
 * anchors on `mergedRouteStops`, which keeps the primary route's sequence
 * VERBATIM — repeats and all, because routes 9 and 10 pass West Campus twice
 * and de-duplicating loses real legs. TransitMap's render sites build their own
 * de-duplicated list (Green 23 -> 20 stops, Purple 15 -> 11), so an index means
 * something different there. Sharing one store across the two spaces would put
 * Green and Purple buses a few slots out rather than fixing anything. Hence
 * {@link anchorIndexOnList}: anchor on the canonical list, then translate the
 * answer back to the caller's list by STOP ID.
 *
 * HYPOTHETICAL CALLERS PASS THEIR OWN STORE, OR NONE. With no store this is
 * exactly `findRouteAnchor` and nothing is remembered — which is what the
 * replay harnesses and the existing tests depend on.
 */
import { findRouteAnchor } from "./anchor";
import type { AnchorBus } from "./anchor";
import { gateAnchor, noteFix, ringPrior, type AnchorStore, type GateBus } from "./anchorGate";
import type { LatLon } from "./geo";
import { mergedRouteStops, type RouteListConfig } from "./routes";

/**
 * The gate's per-vehicle key. Route label plus the bus NAME, never `bus_id`:
 * TransLoc reissues ids per service block (~1,000 ids for 50 buses in 30 days)
 * and `bus_name` is the identity.
 */
export function anchorKeyFor(routeLabel: string, busName: string): string {
  return `${routeLabel}|${busName}`;
}

/**
 * Where this bus is on `stops`, corroborated. Runs the whole sequence in the
 * one order it must run in: remember the fix (so the anchor can read direction
 * of travel off the last two DISTINCT ones), pick the raw anchor, then gate it.
 *
 * Returns -1 when the raw anchor has no opinion — an empty stop list — which
 * is the same answer `findRouteAnchor` gives, so a caller's existing `< 0`
 * guard keeps working.
 */
export function resolveAnchorIndex(
  bus: AnchorBus & GateBus,
  stops: number[],
  stopCoords: Record<number, LatLon>,
  key: string,
  now: number,
  store?: AnchorStore | undefined,
): number {
  // `noteFix` is idempotent within a poll on purpose: arrivals are computed
  // several times per poll off one shared store, and a repeated coordinate is
  // not a new fix. Calling it once per render site is therefore safe — it does
  // not consume the fix memory `findRouteAnchor` reads direction from.
  const travelFrom = store ? noteFix(store, key, bus, now) : null;
  // Where the bus already was on the ring, so the chooser stops proposing moves
  // the gate would only have to refuse (ring.ts, docs/ring-anchor.md). Read
  // AFTER `noteFix`, so this poll's step is already in the budget — a bus that
  // pulls out has to be able to reach the next slot in the poll it pulls out,
  // not the one after. With no store there is no prior and this is exactly
  // `findRouteAnchor`, which is what the replay harnesses depend on.
  const prior = store ? ringPrior(store, key, now) : null;
  const raw = findRouteAnchor(bus, stops, stopCoords, travelFrom, prior);
  if (raw < 0) return raw;
  // The gate needs the route's stop count for its ring arithmetic, and the
  // sequence itself to ask whether `at_stop_id` names the very slot proposed —
  // both from the list it was just asked about, not some other spelling of the
  // route.
  return store ? gateAnchor(store, key, raw, bus, now, stops.length, stops).index : raw;
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
  bus: AnchorBus & GateBus & { bus_name: string },
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
