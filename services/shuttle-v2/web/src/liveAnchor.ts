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
import { lastStopReading, LEAD_FOLLOW_LEGS, LEAD_SWITCH_MASS, legMass, otherCallOfStand, pricedLeg, situations, standingSec, type Belief, type FilterBus } from "./eta/filter";
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
 * number beside it come from one posterior. Where the countdown has left a
 * held lead for a leg the feed confirms, that leg (`anchorLeg`).
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
  const leg = anchorLeg(belief, ring);
  const lead = travel ? travelPass(belief, ring, leg) : leg;
  // The belief runs on the RING's sequence, which on a route whose order was
  // repaired against its published line is not upstream's (#160,
  // src/network/alignStops.ts); every caller indexes upstream's list.
  if (!ring.repaired) return lead;
  return travel ? travelSlot(ring.order, lead) : (ring.order[lead] ?? lead);
}

/**
 * The leg the screen anchors on: the belief's lead, or the leg the countdown
 * is priced from once that has left the lead and the feed's last stop puts
 * the bus there.
 *
 * The countdown is priced from the lead while `situations` keeps one on its
 * leg, and from the top situation once it has none (`pricedLeg`). The lead
 * holds on longer (`leadLeg`): against a wrap behind for LEAD_MAX_HOLD_MS of
 * disagreement, a clock that restarts whenever the top leg dips under
 * LEAD_SWITCH_MASS, which it does at every stop a moving bus passes; against
 * a far jump until one leg holds LEAD_SWITCH_MASS and the feed confirms it.
 * So the card counted "N stops away" from one leg and the countdown beside it
 * from another. Green #331 came into service at 06:15 ET on 2026-10-02 with
 * its lead on Orange / Bradley (S) from a cold start and drove the Orange St
 * loop with the lead still there: "1 stop away" from West Haven Train Station
 * beside "~25 min", ten stops, which the bus then drove (#302, #321 and #303
 * the same, early mornings). Purple #330 laid over at Building 400 with the
 * lead a stop on, on Building 600's return leg: 4 stops to the station beside
 * a countdown of 5 (2026-10-03 15:58Z, anchorfarorigin20261004).
 *
 * So the anchor goes with the countdown where the feed's last stop confirms
 * the countdown's leg (`lastStopReading`, the arbiter `leadLeg` uses for a far
 * jump), except onto the other call of the stand the lead is at or has just
 * left, which `leadLeg` does not take on the feed's word either
 * (`otherCallOfStand`). Where the feed contradicts it or names no stop, the
 * lead holds as before: on the 2026-09-25 road race Red's buses ran down
 * Temple St beside the Chapel St leg, the mass and the number went with the
 * fix, and the feed's last stop was right (anchor-detour-lap.test.ts). So
 * does a feed that is wrong itself: Purple #126 out at West Campus with 333
 * Cedar stuck as its last stop for 13 minutes (2026-10-02 03:10Z). The
 * countdown is unchanged: `priceRoute` reads the same `pricedLeg`.
 *
 * Replayed side by side with master over 14 archived days (09-20..10-03,
 * every route, 1,959,550 bus polls): no countdown row changes, and the anchor
 * moves on 18,372 polls. Against the collector's stop visits it is within a
 * leg of the bus on 17,600 of the 17,698 that can be scored, where it was on
 * 3,454; one side within a leg and the other three or more off, 11,597 fixed
 * and 28 introduced (26 of them one Pink bus on the VA spur's twin curbs).
 * The Pink ones were the countdown's error: it keeps the lead there now
 * (filter.ts `leadOffItsLine`, pinktwincurb20261005), and the anchor with it.
 * On the served path over the rider watcher's polls (10-01..10-05, 14.8M trip
 * cards) 71,882 cards change, 70,642 of them toward the countdown's own
 * count, and none goes from within two stops of it to six off.
 */
export function anchorLeg(b: Belief, ring: Ring): number {
  const priced = pricedLeg(b, situations(b, ring));
  if (priced === b.lead) return b.lead;
  return lastStopReading(b, ring, priced) === "confirms" && !otherCallOfStand(b, ring, b.lead, priced) ? priced : b.lead;
}

/**
 * The lead (`lead`, `anchorLeg`'s answer), on the pass of its stop the
 * belief's mass is actually on.
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
 *
 * Not while the lead is held on the call its stand was at (filter.ts
 * `otherCallOfStand`). Pulling out of the outbound stand at Building 800, the
 * mass runs along the return line for a poll or two, but the bus is on its
 * way out, and the lead says so (greenb800switch20261004).
 */
export function travelPass(b: Belief, ring: Ring, lead = b.lead): number {
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
  for (const q of passes) if (near(q) >= LEAD_SWITCH_MASS && !otherCallOfStand(b, ring, lead, q)) return q;
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
 * THE TRIP CARD'S APPROACH FOR A RIDE: {@link tripApproach}, counted to the
 * pass of the pickup the countdown is pinned to. `boardHops` is that pinned
 * arrival's `stopsAhead` and stop (arrivals.ts `UpcomingArrival`) followed by
 * those of the same bus's other arrivals at the pickup and the destination, as
 * the option carries them (planner.ts `TripOption.busBoardHops`); without them
 * the answer is what it always was.
 *
 * A line that comes back the way it went (its published list names a stop
 * twice: Green and Purple, out to West Campus and back) passes some pickups
 * twice: the West Campus stops, and West Haven Train Station, where the repair
 * adds the line's second call (Green on the way out, Purple on the way back;
 * buses stand there both ways). The countdown boards whichever pass reaches
 * the destination before the pickup comes round again (planner.ts
 * `rideBoardArrivals`); `tripApproach` counts to the stop's first slot.
 * Purple, at the station for downtown with the bus at Building 400 on its way
 * back: the countdown was for the return call five stops out, and the card
 * read "10 stops away", counted to the outbound call after the whole downtown
 * loop (stopcountpass20261003). On Green, a rider at Building 800 for
 * downtown was counted to the outbound pass the countdown had rejected.
 *
 * So on those lines a pickup the ring passes more than once is counted along
 * the ring, in travel order, from the bus to the pinned pass, listing
 * upstream's slots on the way: the stop the bus is at or last cleared, then
 * every pass upstream names (`travelSlot`'s convention; a call the repair
 * added is not listed). The arrivals count hops from where the estimator has
 * the bus: usually the belief's lead, sometimes the leg the mass has moved
 * on to. So the pinned pass is read off the ring position every one of the
 * bus's arrivals at the pickup and the destination fits, the nearest ahead of
 * the lead or of the card's own pass (`travelPass`) when more than one does.
 * The pickup's alone can fit two: Purple passes Building 900 half a lap apart,
 * so its arrivals there fit both, and with the estimator's origin a few legs
 * behind the lead the nearest ahead was the other pass (stopcountb90020261004: the
 * card read "3 stops away" for Building 800 beside a countdown 12 stops out).
 * The destination's arrivals tell them apart. Empty when the
 * pinned arrival is the bus standing at the pickup. A bus the feed has
 * standing at the pickup is at the pass of it nearest its anchor: empty when
 * that is the pinned pass, counted on from it when the countdown has passed
 * it over for a later one. A bus that has just left the pinned pass, with the
 * countdown a lap on, is a whole lap away.
 *
 * A pickup the ring passes once, on any line, is the same: a bus that has
 * just left it, with the countdown a lap on, is a whole lap away. Counted
 * `tripApproach`'s way it was empty while the anchor was still on the pickup's
 * leg, so the card read "0 stops away" with the bus drawn at BOARD and its
 * name dropped, beside the next lap's countdown: Purple #317 through 100
 * Church Street South without stopping, 50-60 s at ~65 min until the feed's
 * last stop moved on (purpleatstop20261005); Green #321 off Building 750
 * (stopcountzerodepart20261005). A bus the feed has standing there, or a
 * countdown for this visit, still reads empty. `lapPastPickup` false keeps the
 * old reading, for the ride banner's exit (`rideStopsToExit`).
 *
 * Apart from that, every other pickup, and every pickup on a line whose list
 * names each stop once, reads as before: empty at the stop, else
 * `tripApproach`. That keeps Pink out: its ring's twins are the opposite curbs
 * of the VA spur, which the feed reports once a lap each, in published order.
 */
export function rideApproach(
  bus: AnchorBus & { bus_name: string; at_stop_id?: number | null; stationary?: boolean },
  cfg: RouteListConfig,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  boardStopId: number,
  boardHops: readonly (readonly [hops: number, stopId: number])[] | undefined,
  now: number,
  store?: AnchorStore | undefined,
  lapPastPickup = true,
): number[] | null {
  const atStop = observedAtStop(bus, boardStopId, stopCoords);
  const before = () => atStop ? [] : tripApproach(bus, cfg, routeStops, stopCoords, boardStopId, now, store);
  if (!boardHops?.length || !boardHops.every(([h]) => Number.isInteger(h) && h >= 0)) return before();
  const pinned = boardHops[0]![0];
  const seq = mergedRouteStops(cfg, routeStops);
  const ring = ringForBus(bus, seq, stopCoords);
  const N = ring?.N ?? 0;
  if (!ring || ring.stops.length !== N) return before();
  const passes: number[] = [];
  for (let p = 0; p < N; p++) if (ring.stops[p] === boardStopId) passes.push(p);
  if (passes.length === 1 && lapPastPickup) {
    // Empty is the anchor on the pickup's leg: at the stop, or just past it.
    // The pickup comes round once a lap, so a countdown more than half a lap
    // out is for the next visit, and this one is over.
    const approach = before();
    if (atStop || approach?.length !== 0 || 2 * pinned < N) return approach;
    const bi = seq.indexOf(boardStopId);
    return [...seq.slice(bi), ...seq.slice(0, bi)];
  }
  if (new Set(seq).size === seq.length) return before();
  if (passes.length < 2) return before();
  // The countdown's bus is standing at the pickup: boarding now.
  if (pinned === 0) return [];
  const slot = (p: number) => ring.repaired ? travelSlot(ring.order, p) : p;
  const named = (p: number) => ring.order[p] === slot(p);
  // Ring positions from the anchor's two answers: the lead is the pass in the
  // published slot `index`, the card's own the one in the travel slot.
  const travel = anchorIndexOnList(bus, cfg, routeStops, stopCoords, seq, now, store, true);
  if (travel < 0) return before();
  const index = anchorIndexOnList(bus, cfg, routeStops, stopCoords, seq, now, store);
  let lead = -1, from = -1;
  for (let p = 0; p < N && from < 0; p++) if (ring.order[p] === index && slot(p) === travel) lead = from = p;
  for (let p = 0; p < N && from < 0; p++) if (ring.order[p] === travel && named(p)) from = p;
  for (let p = 0; p < N && lead < 0; p++) if (ring.order[p] === index && named(p)) lead = p;
  if (from < 0 || lead < 0) return before();
  const ahead = (a: number, b: number) => ((b - a) % N + N) % N;
  const near = (q: number) => Math.min(ahead(lead, q), ahead(from, q));
  let origin = -1;
  for (let o = 0; o < N; o++) {
    if (!boardHops.every(([h, stopId]) => h === 0 || ring.stops[(o + h) % N] === stopId)) continue;
    if (origin < 0 || near(o) < near(origin)) origin = o;
  }
  if (origin < 0) return before();
  const target = (origin + pinned) % N;
  if (atStop) {
    const apart = (p: number) => Math.min(ahead(from, p), ahead(p, from));
    from = passes.reduce((best, p) => (apart(p) < apart(best) ? p : best));
  }
  // On the pinned pass already: standing there, or the anchors disagree about
  // the pass (short of a lap), which reads as before. Off it with the
  // countdown a lap on, the bus has just left it: the count is the whole lap.
  if (target === from && (atStop || pinned < N)) return before();
  const approach = [seq[slot(from)]!];
  for (let p = (from + 1) % N; p !== target; p = (p + 1) % N) if (named(p)) approach.push(seq[ring.order[p]!]!);
  return approach;
}

/**
 * THE RIDE BANNER'S COUNT: stops left to the rider's exit, the number behind
 * "N stops", "Get off in 2 stops!", "Get off NEXT stop!" and the get-off alert.
 * `exitArrivals` are this bus's arrivals at the exit, soonest first, the first
 * being the ride countdown's own.
 *
 * The banner used to subtract slots in its de-duplicated list, which keeps the
 * order in which upstream first names each stop. Green's runs Building 900,
 * 800, 600, 400, 750, West Haven Train Station, while the bus drives 400, 600,
 * 750, 800, 900, the station. So a ride from Building 400 read 2, 3, 1, 4, 5
 * stops as it went: "Get off in 2 stops!" at the pickup, "Get off NEXT stop!"
 * at Building 750 with three stops to go, beside a countdown that was right
 * (ridebannercount20261004, 8 of 8 recorded rides). Purple's return leg read
 * "Get off at the next stop" at Building 400 for LEPH / 60 College, and Pink's
 * return past Quigley Stadium rose to 6 two stops out, the same way.
 *
 * On a line that comes back the way it went (its list names a stop twice:
 * Green and Purple) the count is the countdown's own: its hops to the exit,
 * every call of the ring. Both passes of a West Campus stop are calls, and so
 * is West Haven Train Station's second, which the repair adds (Green on the
 * way out, Purple on the way back) and the trip card does not list. Counted
 * the card's way, Purple's return read "Get off NEXT stop!" at Building 900
 * for LEPH / 60 College with the station still to come; counted from the
 * card's anchor, whose pass can run ahead, Green read "Get off in 2 stops!"
 * standing at Building 600 for the station, four out. The countdown's hops
 * were right on both. A bus the feed has standing at the exit while the
 * countdown is still closing on it has arrived: "NEXT stop!" stayed up for a
 * poll or two at Building 400 (rideApproach's `observedAtStop`, which every
 * other line already gets).
 *
 * Every other line counts as the trip card does ({@link rideApproach}),
 * which on a list that names each stop once is the old count in travel order.
 *
 * Null when there is nothing to answer from.
 */
export function rideStopsToExit(
  bus: AnchorBus & { bus_name: string; at_stop_id?: number | null; stationary?: boolean },
  cfg: RouteListConfig,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  alightStopId: number,
  exitArrivals: readonly { stopsAhead: number; stopId: number }[],
  now: number,
  store?: AnchorStore | undefined,
): number | null {
  const hops = exitArrivals.map((a): [number, number] => [a.stopsAhead, a.stopId]);
  const seq = mergedRouteStops(cfg, routeStops);
  const pinned = hops[0]?.[0];
  if (new Set(seq).size !== seq.length && pinned !== undefined && Number.isInteger(pinned) && pinned >= 0) {
    // One hop out, at the exit's kerb: the pass the countdown is for (a stop's
    // two passes are never one hop apart).
    if (pinned === 1 && observedAtStop(bus, alightStopId, stopCoords)) return 0;
    // At an exit the list names once, the bus is there, as on the ride page
    // (rideArrival.ts `isUnambiguousRideArrival`), even once the countdown has
    // moved on to the next call there, a lap on.
    const idx = anchorIndexOnList(bus, cfg, routeStops, stopCoords, seq, now, store);
    if (idx >= 0 && seq[idx] === alightStopId && seq.indexOf(alightStopId) === seq.lastIndexOf(alightStopId)) return 0;
    return pinned;
  }
  // At the exit the bus is there, as above, even with the countdown a lap on:
  // not the trip card's lap past a pickup it has just left.
  const approach = rideApproach(bus, cfg, routeStops, stopCoords, alightStopId, hops.length ? hops : undefined, now, store, false);
  return approach ? approach.length : null;
}

/**
 * THE RIDE PAGE'S STOP LIST: the ride's calls in travel order, pickup first and
 * exit last, the calls {@link rideStopsToExit} counts. So the bus is that many
 * rows above the exit ({@link rideCallIndex}), and the list and the banner read
 * one count.
 *
 * The list used to walk the de-duplicated list from the pickup's slot to the
 * exit's, in the order upstream first names each stop. Green's keeps Building
 * 900, 800, 600, 400, 750, West Haven Train Station, so every recorded Building
 * 400 -> station ride listed "Building 400 · Building 750 · West Haven Train
 * Station", without the 600, 800 and 900 the bus calls at on the way, and drew
 * the bus at Building 750 while it stood at Building 800. Purple's Building 400
 * -> LEPH / 60 College listed the two of them and nothing between
 * (ridestoplist20261004).
 *
 * On a line that comes back the way it went (its list names a stop twice:
 * Green and Purple) the calls are the ring's, every pass and the station's
 * added call, in its repaired travel order. Of the pickup's passes, the one
 * nearest before a pass of the exit: the ride the planner boards (planner.ts
 * `rideBoardArrivals`). Every other line walks upstream's list, which is the
 * order the banner counts in (Pink's twin curbs being one call a lap).
 *
 * Empty when the pickup or the exit is not on the line.
 */
export function rideCalls(
  cfg: RouteListConfig,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  boardStopId: number,
  alightStopId: number,
): number[] {
  const seq = mergedRouteStops(cfg, routeStops);
  const busRouteId = cfg.busRouteIds[0];
  const ring = new Set(seq).size !== seq.length && busRouteId !== undefined
    ? ringForBus({ route_id: busRouteId }, seq, stopCoords)
    : null;
  const calls = ring && ring.stops.length === ring.N ? ring.stops : seq;
  if (!calls.includes(alightStopId)) return [];
  if (boardStopId === alightStopId) return [boardStopId];
  const N = calls.length;
  let best: number[] = [];
  for (let p = 0; p < N; p++) {
    if (calls[p] !== boardStopId) continue;
    let k = 1;
    while (calls[(p + k) % N] !== alightStopId) k++;
    if (best.length === 0 || k + 1 < best.length) {
      best = [];
      for (let j = 0; j <= k; j++) best.push(calls[(p + j) % N]!);
    }
  }
  return best;
}

/**
 * The bus's row in {@link rideCalls}: the call it is at or last cleared, read
 * back from the exit by the banner's count ({@link rideStopsToExit}); -1 before
 * the pickup or past the exit.
 *
 * Only while the shared anchor has the bus at one of the ride's calls (its stop
 * or its travel slot's). A ride can be started before its bus comes
 * (TripBoardingActions), and the countdown to an exit the ring passes twice is
 * then for whichever pass comes first: a Green bus still on Whitney Avenue,
 * coming to a rider at Building 400, counted 5, 4, 3, 2, 1 to West Haven Train
 * Station's outbound call and would have been drawn down the list
 * (ridestoplist20261004: 249 of 424 recorded polls before boarding on Green and
 * Purple, none once riding).
 */
export function rideCallIndex(
  bus: AnchorBus & { bus_name: string },
  cfg: RouteListConfig,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  calls: readonly number[],
  stopsToExit: number | null,
  now: number,
  store?: AnchorStore | undefined,
): number {
  if (stopsToExit === null || !Number.isInteger(stopsToExit) || stopsToExit < 0 || stopsToExit >= calls.length) return -1;
  const seq = mergedRouteStops(cfg, routeStops);
  const onRide = [false, true].some((travel) => {
    const stopId = seq[anchorIndexOnList(bus, cfg, routeStops, stopCoords, seq, now, store, travel)];
    return stopId !== undefined && calls.includes(stopId);
  });
  return onRide ? calls.length - 1 - stopsToExit : -1;
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
