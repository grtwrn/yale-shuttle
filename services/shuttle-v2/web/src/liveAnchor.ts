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
import { findRouteAnchor, routePathFor } from "./anchor";
import type { AnchorBus } from "./anchor";
import { beliefFor, modelRouteIds } from "./eta";
import { ringFor } from "./eta/ring";
import { gateAnchor, noteFix, type AnchorStore, type GateBus } from "./anchorGate";
import type { LatLon } from "./geo";
import { remainingStandSec, standAdequate, standingAt, STANDING_HOLD_M } from "./hopPricing";
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
  // A route the ring estimator serves answers from its belief: the leg the
  // countdown is priced on, with the same hysteresis, so "N stops away" and
  // the number beside it come from one posterior. The legacy path below is
  // untouched for every other route.
  if (bus.route_id !== undefined && modelRouteIds().has(String(bus.route_id))) {
    const ring = ringFor(bus.route_id, routePathFor(bus.route_id), stops, stopCoords);
    if (ring && !ring.bridged) return beliefFor(store, key, bus as never, ring, stops, now).lead;
  }
  const travelFrom = store ? noteFix(store, key, bus, now) : null;
  const raw = findRouteAnchor(bus, stops, stopCoords, travelFrom);
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

/**
 * WHICH STOP IS THIS BUS STANDING AT, AND FOR HOW LONG — one answer, shared.
 *
 * The estimator has always had to decide this to price the first hop, and it
 * decided it inline. The SCREEN had to decide it too, and decided it
 * differently: the pause chip read `at_stop_id` / `at_stop_since` straight off
 * the payload. That was harmless while the two agreed, and stopped being
 * harmless the moment the approach-zone rule shipped (#130), because a bus
 * taking its layover short of the marker publishes no `at_stop_id` at all. The
 * countdown then prices it as standing — correctly — while the chip beside it
 * shows nothing and the row reads as a bus still rolling.
 *
 * That is the same "two answers, one screen" this module was created to end,
 * and it is the substance of report #102: "a bus sitting in a garage lot was
 * counted down as if on its way". So the decision lives here, once, and both
 * the price and the label read it.
 *
 * `approach` is true when the answer came from the approach zone rather than
 * from a published `at_stop_id` — the caller needs it because the honest label
 * differs for a bus that is not, physically, at the marker.
 *
 * Storeless callers get null: `standingAt`'s memory and the approach memo both
 * ride the caller's store, exactly as the anchor gate does, so a replay or a
 * pure test behaves as it always did.
 */
export interface StandingAnswer {
  /** The stop the bus is standing at — a canonical-sequence stop id. */
  stopId: number;
  /** Seconds it has been standing, on the same clock the price bills. */
  standingSec: number;
  /** True when this came from the approach zone, not a published at_stop_id. */
  approach: boolean;
}

export function resolveStandingStop(
  bus: AnchorBus & GateBus & {
    bus_name: string;
    at_stop_since?: string | null | undefined;
    stationary_since?: string | null | undefined;
  },
  cfg: RouteListConfig,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  dwellTimes: Record<string, { q?: number[] | undefined; qn?: number | undefined; n: number }>,
  now: number,
  store: AnchorStore | undefined,
  /** The anchor index, when the caller has already resolved it this poll. */
  anchorIdx?: number,
): StandingAnswer | null {
  if (!store) return null;
  const stops = mergedRouteStops(cfg, routeStops);
  if (stops.length === 0) return null;
  const key = anchorKeyFor(cfg.label, bus.bus_name);
  const idx = anchorIdx ?? resolveAnchorIndex(bus, stops, stopCoords, key, now, store);
  if (idx < 0) return null;
  // The candidate is the NEXT stop in sequence and never the nearest — see
  // APPROACH_ZONE_M in hopPricing.ts for why that one constraint is what makes
  // the rule a scalpel, and why it must never be re-derived from
  // `last_stop_id`, which is garbage right after a bus_id reissue.
  const nextStopId = stops[(idx + 1) % stops.length];
  const nextStand = nextStopId === undefined ? undefined : dwellTimes[String(nextStopId)];
  const approach = nextStopId !== undefined && standAdequate(nextStand)
    ? { stopId: nextStopId, typicalStandSec: remainingStandSec(nextStand.q, 0) }
    : undefined;
  const st = standingAt(store, key, bus, now, stopCoords, STANDING_HOLD_M, approach);
  if (!st) return null;
  return {
    stopId: st.stopId,
    standingSec: st.standingSec,
    approach: !(bus.at_stop_id != null && bus.at_stop_id === st.stopId),
  };
}
