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
import { LEAD_FOLLOW_LEGS, LEAD_SWITCH_MASS, legMass, standingSec, type Belief, type FilterBus } from "./eta/filter";
import type { Ring } from "./eta/ring";
import { haversineMeters, type LatLon } from "./geo";
import { mergedRouteStops, type RouteListConfig } from "./routes";
import { serverTrack } from './etaSource';

/** What the anchor needs of a bus: a fix, the clocks, and the route whose line it is measured against. */
export type AnchorBus = FilterBus & { route_id: number | string };

/** A direct stop observation can settle a display disagreement
 * while the route belief catches up. Require the stop id, a stationary fix,
 * and proximity: at_stop_id alone can linger after departure. */
export function observedAtStop(
  bus: LatLon & { at_stop_id?: number | null; stationary?: boolean },
  stopId: number,
  stopCoords: Record<number, LatLon>,
): boolean {
  const stop = stopCoords[stopId];
  return bus.stationary === true && bus.at_stop_id === stopId && !!stop
    && haversineMeters(bus, stop) <= 75;
}

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
 *
 * `travel` asks for the slot in TRAVEL order instead of the stop the bus is at;
 * the two differ only on a pass upstream's list has no slot for
 * ({@link travelSlot}), or on a pass of a repeated stop the belief has left
 * ({@link travelPass}).
 */
export function resolveAnchorIndex(
  bus: AnchorBus,
  stops: number[],
  stopCoords: Record<number, LatLon>,
  key: string,
  now: number,
  store?: AnchorStore | undefined,
  travel = false,
): number {
  const ring = ringForBus(bus, stops, stopCoords);
  if (!ring) return -1;
  const belief = beliefFor(store, key, bus, ring, stops, now);
  const lead = travel ? travelPass(belief, ring) : belief.lead;
  // The belief runs on the RING's sequence, which on a route whose order was
  // repaired against its published line is not upstream's (#160,
  // src/network/alignStops.ts); every caller indexes upstream's list.
  if (!ring.repaired) return lead;
  return travel ? travelSlot(ring.order, lead) : (ring.order[lead] ?? lead);
}

/**
 * The lead, on the pass of its stop the belief's mass is actually on.
 *
 * Where the line passes a stop twice, the lead can name the wrong pass and
 * stay there. Green, running out past Building 800 toward Building 400:
 * the mass swung to the RETURN pass of Building 800 for a poll or two, the
 * feed's last stop (25, which names both passes) confirmed the jump, and when
 * the mass came back the lead held it as a wrap behind (`leadLeg`, up to
 * LEAD_MAX_HOLD_MS) while the bus called at Building 600 and Building 400 on
 * the way out. Production published exactly that, index 17 for #321 heading
 * out (2026-10-03 21:00Z). Read as "which stop is the bus at" it is harmless.
 * Building 800 is Building 800, and a de-duplicated list cannot tell the
 * passes apart anyway. Counted along the line ({@link tripApproach}) it is a
 * lap: "20 stops away" beside a countdown of one minute.
 *
 * So a count reads the pass the mass is on. It never moves to another stop,
 * only to another pass of the same one, and only to a pass that is both:
 *  - named apart by upstream's list (its own slot), i.e. the West Campus
 *    out-and-back. A twin the repair ADDED (Pink's, the station's added
 *    call) carries the slot of the pass it doubles, and `travelSlot` already
 *    places it. Hopping between such twins moved Pink's count a lap (review
 *    of #360);
 *  - more than LEAD_FOLLOW_LEGS from the lead, i.e. a jump, the move the
 *    feed is asked to confirm. A pass that near (Building 600 either side
 *    of the turnaround) is the lead following, which `leadLeg` already does.
 * And only when the lead's own pass has lost the mass (no more than
 * 1 - LEAD_SWITCH_MASS) and that pass holds LEAD_SWITCH_MASS, each counted
 * over the pass's leg and the LEAD_FOLLOW_LEGS after it, the reach `leadLeg`
 * gives a lead that is following.
 */
export function travelPass(b: Belief, ring: Ring): number {
  const lead = b.lead;
  const stop = ring.stops[lead];
  const N = ring.N;
  if (stop === undefined || ring.stops.length !== N) return lead;
  const passes: number[] = [];
  for (let q = 0; q < N; q++) {
    const legs = ((q - lead) % N + N) % N;
    if (ring.stops[q] === stop && ring.order[q] !== ring.order[lead]
      && Math.min(legs, N - legs) > LEAD_FOLLOW_LEGS) passes.push(q);
  }
  if (passes.length === 0) return lead;
  const m = legMass(b, ring);
  const near = (q: number) => {
    let sum = 0;
    for (let k = 0; k <= LEAD_FOLLOW_LEGS; k++) sum += m[(q + k) % N]!;
    return sum;
  };
  if (near(lead) > 1 - LEAD_SWITCH_MASS) return lead;
  for (const q of passes) if (near(q) >= LEAD_SWITCH_MASS) return q;
  return lead;
}

/** Per repaired ring order (rings are cached, so the array is stable): ring position -> travel slot. */
const travelSlotsByOrder = new WeakMap<readonly number[], number[]>();

/**
 * A repaired ring position as a slot in upstream's list, in TRAVEL order:
 * `order[pos]`, except on a pass upstream's list has no slot for.
 *
 * The repair can ADD a pass (src/network/alignStops.ts): the line drives past
 * a stop twice and upstream names it once, so two ring positions carry the one
 * slot, and only one of them is the visit that slot describes. As an answer to
 * "which stop is the bus at" that is right, and the ride page relies on it (a
 * bus at either pass of the rider's exit is at the exit, rideArrival.ts). As a
 * place to COUNT from it is not: Green's outbound call at West Haven Train
 * Station (Bradley (S) -> station -> Building 900) carries the slot of the
 * RETURN call, eight slots on and past the whole West Campus spur, so the trip
 * card counted a bus standing there "18 stops away" from a rider at Building
 * 400 it was four stops from, listed the Orange Street loop as its approach,
 * then read "3" at Building 900 — while the countdown beside it held ~8 min
 * (greenstopsjump20261003). Purple's added return pass at the station counted
 * from its outbound one, and Pink's twin passes from their twins.
 *
 * The visit a slot describes is the pass that keeps upstream's order — the one
 * on the longest run of passes in published order. Any other pass answers with
 * the slot of the last named pass before it: the stop the bus last cleared,
 * which is what a count along upstream's list needs of a bus between two of
 * its slots.
 */
export function travelSlot(order: readonly number[], pos: number): number {
  let slots = travelSlotsByOrder.get(order);
  if (!slots) {
    const N = order.length;
    // Longest run in published order ending at, and starting from, each pass.
    const ending = order.map(() => 1), starting = order.map(() => 1);
    for (let p = 0; p < N; p++) {
      for (let q = 0; q < p; q++) if (order[q]! < order[p]!) ending[p] = Math.max(ending[p]!, ending[q]! + 1);
    }
    for (let p = N - 1; p >= 0; p--) {
      for (let q = p + 1; q < N; q++) if (order[q]! > order[p]!) starting[p] = Math.max(starting[p]!, starting[q]! + 1);
    }
    const run = (p: number) => ending[p]! + starting[p]!;
    // The pass a slot describes; on a tie, the earlier one.
    const named = order.map((slot, p) =>
      order.every((s, q) => s !== slot || run(q) < run(p) || (run(q) === run(p) && q >= p)));
    slots = order.map((slot, p) => {
      for (let k = 0; k < N; k++) {
        const q = (p - k + N) % N;
        if (named[q]) return order[q]!;
      }
      return slot;
    });
    travelSlotsByOrder.set(order, slots);
  }
  return slots[pos] ?? order[pos] ?? pos;
}

/**
 * The same answer, expressed as an index into the caller's own stop list.
 *
 * The anchor is always computed on the canonical `mergedRouteStops` sequence —
 * that is the space the shared store's memory is in — and then translated by
 * stop id. A caller whose list de-duplicates a repeated stop gets that stop's
 * first slot, which is all such a list can express and exactly what it showed
 * before; a caller passing the canonical list gets the index untouched.
 *
 * A caller that COUNTS stops from the answer to a stop ahead of the bus passes
 * `travel` ({@link travelSlot}) and the canonical list ({@link tripApproach});
 * a caller asking which stop the bus is at does neither.
 */
export function anchorIndexOnList(
  bus: AnchorBus & { bus_name: string },
  cfg: RouteListConfig,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  displayStops: number[],
  now: number,
  store?: AnchorStore | undefined,
  travel = false,
): number {
  const canonical = mergedRouteStops(cfg, routeStops);
  if (canonical.length === 0) return -1;
  const served = serverTrack(bus, cfg.label, now);
  const idx = served !== undefined
    ? (served ? (travel ? served.travel : served.index) : -1)
    : resolveAnchorIndex(bus, canonical, stopCoords, anchorKeyFor(cfg.label, bus.bus_name), now, store, travel);
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
 * THE TRIP CARD'S APPROACH: the stops this bus still has to clear to reach the
 * rider's pickup, starting with the one it is at or last cleared, in travel
 * order. Its length is the card's "N stops away"; it is also the card's
 * approach list and the map's dashed approach. Null when there is nothing to
 * answer from.
 *
 * Counted on the CANONICAL sequence, repeats and all. The card used to count on
 * its own de-duplicated list (Purple 15 -> 11 stops), which has no slots for
 * the West Campus return leg, so a bus on that leg was counted from the
 * outbound pass of the same stop, back before the spur. As #330 came back up
 * the spur, the card counted it 6, 7, 8, 9 stops from Union Station (S). The
 * real counts were 8, 7, 6, 5. All the way downtown it then read 9, with
 * Building 900 ... 400 listed as still ahead, until LEPH / 60 College snapped
 * it to 4 (purplestopsjump20261003). A bus still going out was short-counted
 * the same way, with the return leg skipped.
 *
 * The pickup is the stop's first slot, the same pass the de-duplicated list
 * names (a trip option carries a stop, not a pass).
 */
export function tripApproach(
  bus: AnchorBus & { bus_name: string },
  cfg: RouteListConfig,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  boardStopId: number,
  now: number,
  store?: AnchorStore | undefined,
): number[] | null {
  const seq = mergedRouteStops(cfg, routeStops);
  const bi = seq.indexOf(boardStopId);
  if (bi < 0) return null;
  const idx = anchorIndexOnList(bus, cfg, routeStops, stopCoords, seq, now, store, true);
  if (idx < 0) return null;
  return idx <= bi ? seq.slice(idx, bi) : [...seq.slice(idx), ...seq.slice(0, bi)];
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
  const served = serverTrack(bus, cfg.label, now);
  if (served !== undefined) return served?.standing ?? null;
  if (!store) return null;
  const stops = mergedRouteStops(cfg, routeStops);
  if (stops.length === 0) return null;
  const ring = ringForBus(bus, stops, stopCoords);
  if (!ring) return null;
  // The belief's indices are positions in the RING's sequence, which on a route
  // whose order was repaired against its published line is not upstream's list
  // (#160, src/network/alignStops.ts) — the same `seq` every other reader of the
  // belief takes (eta/index.ts `beliefFor` / `arrivalsForBus`). Read `restStop`
  // out of upstream's list instead and a rest is named by whatever stop happens
  // to sit in that slot: on Green, a 435 s stand at Building 800 (ring 13/18)
  // came back as Building 600 and as WEST HAVEN TRAIN STATION, 2.4 km away, so
  // the pause chip was drawn on the wrong row and priced from the wrong stop's
  // stand table (production, 2026-09-12 10:16-10:24 ET, #331).
  const seq = ring.stops.length === ring.N ? ring.stops : stops;
  const b = beliefFor(store, anchorKeyFor(cfg.label, bus.bus_name), bus, ring, seq, now);
  if (!b.rested || b.restStop < 0) return null;
  const stopId = seq[b.restStop];
  if (stopId === undefined) return null;
  return {
    stopId,
    standingSec: standingSec(b, now),
    approach: !(bus.at_stop_id != null && bus.at_stop_id === stopId),
  };
}
