// Client-side trip planning. Extracted from TransitMap.tsx unchanged except
// for the walk model, which now matches the server (see walk.ts).

import { computeUpcomingArrivals } from "./arrivals";
import type { DwellTimes, SegmentTimes } from "./arrivals";
import { haversineMeters } from "./geo";
import type { LatLon } from "./geo";
import type { BusData } from "./map-data";
import { BUS_SPEED_M_S, mergedRouteStops, ROUTE_LISTS } from "./routes";
import { fmtSchedule, HEADWAY_MIN, isRouteActiveAt, nextActiveWindow } from "./schedule";
import { MAX_WALK_M, WALK_ONLY_MAX_SEC, walkSecFromMeters } from "./walk";

export type TripOption = {
  mode: "shuttle" | "walk";
  routeLabel: string; color: string;
  boardStopId: number; alightStopId: number;
  walkToSec: number; waitSec: number; rideSec: number; walkFromSec: number;
  totalSec: number; busName: string;
  directWalkSec: number;
  // True when the pinned bus has already gone past the board stop and
  // isn't catchable anymore. Set only while the rider is watching the
  // option (expanded) so we stop advancing to the next catchable bus
  // and show "departed" instead of an arrival time.
  departed?: boolean;
  // Set when the originally-planned bus is no longer catchable and we advanced
  // to a later bus. Drives the "#X just passed — next is …" note. Cleared
  // automatically once the missed bus drops out of the live feed.
  missedBus?: string;
  // The pinned bus's own arrival at the board stop, in seconds remaining as
  // of `computedAtMs` (0 for a bus dwelling there right now). This — not
  // walkToSec + waitSec — is what "🚌 in …" must display: waitSec clamps at 0
  // once the bus will beat the rider to the stop, which freezes the sum at
  // the constant walk time while the bus visibly closes in (report #48, the
  // stuck "1:49"). Undefined for walk options and future-mode plans, where no
  // live bus exists to count down.
  busEtaSec?: number;
  computedAtMs?: number;
  // The OTHER board stops on this same route that planTrip scored for this
  // trip and discarded when it kept one option per route (report #55: a loop
  // passes Prospect/Canner and, seven stops and a 7-min walk later,
  // Whitney/Canner — a rider who misses the bus at the first can still catch
  // the same bus at the second). Distinct boardStopId, nearest walk first,
  // best (lowest total) alight for each; pure data, never ranked or rendered
  // by itself — `alternatePickup` reads it after a miss. Absent when the
  // route offered no second board stop.
  alternates?: TripAlternate[];
  // Filled by the live layer from `alternates` when walking to another stop
  // beats waiting where the rider is (see alternatePickup). Undefined
  // otherwise. When set, the live layer also lists that itinerary as its
  // own card (`viaAlternate`), so the rider sees both and taps either.
  alternatePickup?: AlternatePickup;
  // This card IS the alternate itinerary derived from another option of the
  // same route (switchToAlternate): it boards at a different stop. Keeps its
  // own card key (optionKey) so both can be listed and expanded independently,
  // and is never itself a source of further alternates.
  viaAlternate?: boolean;
};

export type TripAlternate = {
  boardStopId: number; alightStopId: number;
  walkToSec: number; walkFromSec: number; rideSec: number;
};

export type AlternatePickup = {
  stopId: number;
  /** Walk from the rider (live position when known) to `stopId`. */
  walkSec: number;
  busName: string;
  /** That bus's arrival at `stopId`, seconds from `computedAtMs`. */
  busEtaSec: number;
  computedAtMs: number;
};

/** planTrip keeps at most this many alternate board stops per route. */
export const MAX_ALTERNATES = 3;

/** Don't keep looping past a boarding point. */
export const MAX_RIDE_SEC = 25 * 60;

/**
 * How long a rider still has to board a bus that's dwelling at a stop RIGHT
 * NOW. Floor of 120 s (GPS slack + "the driver waits for someone running"),
 * stretched by the calibrated remaining dwell when we have data — layover
 * stops where the bus rests for minutes are catchable from much farther
 * away. Shared by planTrip (option generation) and the live recompute so the
 * two never disagree about whether a parked bus is boardable. The backend
 * planner's expectedWait applies the same elapsed-vs-median dwell logic.
 */
export function dwellBoardWindowSec(
  bus: BusData,
  routeListId: string,
  stopId: number,
  dwellTimes: DwellTimes,
  now = Date.now(),
): number {
  let remaining = 0;
  const d = dwellTimes[routeListId]?.[String(stopId)];
  if (d && d.n >= 2 && bus.at_stop_since) {
    const elapsed = Math.max(0, (now - new Date(bus.at_stop_since + "Z").getTime()) / 1000);
    remaining = Math.max(0, d.med - elapsed);
  }
  return Math.max(120, remaining + 60);
}

// ── Live bus selection for a planned option ────────────────────────────────
//
// Once a trip is planned, the option stays pinned to its bus so the card does
// not flap between vehicles mid-glance. These constants bound that loyalty:
//
//   STOP_DWELL_SEC    — a bus dwells ~60 s at a stop, so a rider is catchable
//                       until eta + 60 s. Shared with planTrip's own pick.
//   SWITCH_BUFFER_SEC — walking GPS can read 50–100 m long; require the
//                       overshoot past catchability to exceed 90 s before
//                       giving up on the planned bus (spurious-flip guard).
//   PIN_SWITCH_MARGIN_SEC — report #49: loyalty must not survive dominance.
//                       When the pinned bus passes the rider's stop its next
//                       arrival is a full lap out (20–40 min), yet a rider
//                       standing AT the stop made canCatch true for ANY eta
//                       (0 <= eta + 60), so the card told them to wait for it
//                       to come back around while a second bus a few minutes
//                       out was ignored — until an incidental GPS jitter
//                       re-ran planTrip (the rider's observed ~20 s "lag" was
//                       that luck, not design). If a DIFFERENT catchable bus
//                       beats the pinned one by at least this margin, switch
//                       to it in the same poll. 5 min is far above per-poll
//                       ETA noise between two live buses (tens of seconds),
//                       so near-equivalent buses still never trade places,
//                       and far below any lap time (~25 min+), so the
//                       passed-bus case always clears it.

export const STOP_DWELL_SEC = 60;
export const SWITCH_BUFFER_SEC = 90;
export const PIN_SWITCH_MARGIN_SEC = 5 * 60;

export type LiveArrivalPick<A> = { match: A; departed: boolean; missedBus?: string };

/**
 * Which live arrival an already-planned option should follow this poll.
 * `live` is computeUpcomingArrivals output for the board stop (soonest
 * first, may contain each vehicle twice — this lap and the next);
 * `pinnedBusName` is the bus the plan pinned; `effectiveWalkToSec` is the
 * rider's remaining walk. Pure and stateless: called fresh every poll, so
 * every verdict below is reachable within one poll of the data changing.
 * Returns null only for an empty `live`.
 */
export function pickLiveArrival<A extends { eta: number; busName: string }>(
  live: readonly A[],
  pinnedBusName: string,
  effectiveWalkToSec: number,
): LiveArrivalPick<A> | null {
  if (live.length === 0) return null;
  const norm = (s: string) => s.replace(/^#/, "");
  const canCatch = (a: A) => effectiveWalkToSec <= a.eta + STOP_DWELL_SEC;
  const canCatchWithBuffer = (a: A) =>
    effectiveWalkToSec <= a.eta + STOP_DWELL_SEC + SWITCH_BUFFER_SEC;
  const catchable = live.filter(canCatch);
  const pinned = live.find((a) => norm(a.busName) === norm(pinnedBusName));
  if (pinned && canCatch(pinned)) {
    // Dominance check (report #49): stay loyal to the pinned bus unless a
    // different catchable vehicle beats it by the full margin. Same-name
    // entries are the same vehicle a lap sooner/later — never a "switch".
    const better = catchable[0];
    if (
      better &&
      norm(better.busName) !== norm(pinned.busName) &&
      pinned.eta - better.eta >= PIN_SWITCH_MARGIN_SEC
    ) {
      return { match: better, departed: false };
    }
    return { match: pinned, departed: false };
  }
  if (pinned && canCatchWithBuffer(pinned)) {
    // Borderline — GPS may be reading long. Stay on the planned bus. (A
    // sooner catchable alternative cannot exist here: catchable requires
    // eta >= walk - 60, which in this branch exceeds the pinned eta.)
    return { match: pinned, departed: false };
  }
  if (catchable.length > 0) {
    const match = catchable[0];
    // The planned bus is still in the feed but we can no longer make it —
    // record it as missed so the card can surface "#X just passed"... but
    // only if it's genuinely a DIFFERENT vehicle. Arrivals include a second
    // lap per bus, so on a single-bus route the next catchable arrival is
    // usually the same bus a loop later; naming it produced "You can't
    // catch #12" directly above an ETA for #12.
    const missed = pinned ? norm(pinned.busName) : undefined;
    const missedBus = missed && missed !== norm(match.busName) ? missed : undefined;
    return { match, departed: false, missedBus };
  }
  return { match: pinned ?? live[0], departed: true };
}

export function planTrip(
  from: LatLon, to: LatLon,
  buses: BusData[],
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  segmentTimes: SegmentTimes,
  dwellTimes: DwellTimes,
  targetDate?: Date | null,
  now = Date.now(),
): TripOption[] {
  // Future-plan mode: the user picked a date/time >60s away. We can't
  // rely on live buses, so we filter by published operating hours and
  // estimate wait from headway.
  const futureMode = !!targetDate && targetDate.getTime() - now > 60_000;
  const directWalkM = haversineMeters(from, to);
  const directWalkSec = walkSecFromMeters(directWalkM);

  const fromDist: Record<number, number> = {};
  const toDist: Record<number, number> = {};
  for (const [k, c] of Object.entries(stopCoords)) {
    const sid = Number(k);
    fromDist[sid] = haversineMeters(from, c);
    toDist[sid] = haversineMeters(to, c);
  }
  const options: TripOption[] = [];

  for (const cfg of ROUTE_LISTS) {
    // Skip routes that won't be running at the target time. In live mode
    // we still let computeUpcomingArrivals gate (bus presence filters
    // naturally).
    if (futureMode && !isRouteActiveAt(cfg.label, targetDate!)) continue;
    const stops = mergedRouteStops(cfg, routeStops);
    if (stops.length < 2) continue;
    const routeSegs = segmentTimes[cfg.routeIds[0]] ?? {};

    for (let i = 0; i < stops.length; i++) {
      const b = stops[i];
      if (fromDist[b] === undefined || fromDist[b] > MAX_WALK_M) continue;
      // Compute ride-time cumulatively walking forward along the route,
      // WRAPPING around the loop — these are circular routes, so a board
      // stop late in the stop array still reaches an alight earlier in
      // it. The old forward-only scan couldn't pair those, which made
      // the planner skip the stop nearest the rider whenever it sat
      // "after" the destination in array order and suggest a farther
      // one instead (user report 2026-07-17, Blue). MAX_RIDE_SEC still
      // caps how far around the loop an option can ride.
      // These two depend only on the BOARD stop, not on how far around the
      // loop we ride, but they sat inside the alight scan and were recomputed
      // for every candidate. computeUpcomingArrivals is the expensive one, and
      // the wrap-around change above roughly doubled the (board, alight) pairs
      // — so it was running about 4x more often than it used to.
      const hereBus = futureMode ? undefined : buses.find(
        (bb) => cfg.busRouteIds.includes(bb.route_id) && bb.at_stop_id === b,
      );
      const boardArrivals = futureMode ? [] : computeUpcomingArrivals(
        [b], buses, routeStops, stopCoords, segmentTimes, now,
      ).filter((a) => a.routeLabel === cfg.label);
      let cumRide = 0;
      for (let step = 1; step < stops.length; step++) {
        const prev = stops[(i + step - 1) % stops.length];
        const cur = stops[(i + step) % stops.length];
        const seg = routeSegs[`${prev}-${cur}`];
        if (seg && seg.n >= 1) {
          cumRide += seg.avg;
        } else {
          // Fall back to haversine / bus-speed when we have no observed
          // segment time. Using a fixed 180 s default inflated long
          // routes to unusable totals whenever a route had no active
          // buses collecting data.
          const pc = stopCoords[prev], cc = stopCoords[cur];
          if (pc && cc) {
            cumRide += Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S);
          } else {
            cumRide += 90;
          }
        }
        // Stop searching along this route once the ride would wrap past
        // 25 minutes — any further alight would mean the bus is just
        // circling back near the boarding point.
        if (cumRide > MAX_RIDE_SEC) break;
        if (toDist[cur] === undefined || toDist[cur] > MAX_WALK_M) continue;
        const walkToSec = walkSecFromMeters(fromDist[b]);
        const walkFromSec = walkSecFromMeters(toDist[cur]);
        // (The "more walking than walking direct" test used to live here,
        // before waitSec/rideSec were known. See the dominance check below.)
        // Wait time: for a live plan we need a real bus on the route; for
        // a future plan we use half the published headway since no bus
        // exists yet to time against.
        let waitSec: number; let busName: string;
        let busEtaSec: number | undefined;
        if (futureMode) {
          waitSec = (HEADWAY_MIN[cfg.label] ?? 15) * 30;
          busName = "";
        } else {
          // A bus physically dwelling AT this board stop is boardable NOW if
          // the rider can reach it before it pulls away — generate the option
          // with wait 0 instead of relying on ETA math. Without this the
          // stop was silently DROPPED here (a dwelling bus used to emit no
          // ETA for its own stop), which is how the planner missed a 10-min
          // fastest route entirely (report #28: bus parked 13 m from the
          // board stop, every pair boarding there discarded).
          const arrivals = boardArrivals;
          if (hereBus && walkToSec <= dwellBoardWindowSec(hereBus, cfg.routeIds[0], b, dwellTimes, now)) {
            waitSec = 0;
            busEtaSec = 0; // it is AT the stop
            busName = hereBus.bus_name.replace(/^#/, "");
          } else if (arrivals.length === 0) {
            continue;
          } else {
            // Pin the soonest *catchable* bus (one the rider can reach before it
            // finishes dwelling), not merely the soonest — with second-lap
            // arrivals that's usually the same vehicle a loop later rather
            // than nothing. Pinning an uncatchable bus made the live recompute
            // flag it "🚌 #X just passed your stop" the instant a fresh plan
            // rendered. Falls back to the soonest when none is catchable —
            // the option then correctly shows "departed".
            // STOP_DWELL_SEC is shared with pickLiveArrival's canCatch so
            // plan-time and live pinning can never disagree.
            const next = arrivals.find((a) => walkToSec <= a.eta + STOP_DWELL_SEC) ?? arrivals[0];
            waitSec = Math.max(0, next.eta - walkToSec);
            busEtaSec = next.eta;
            busName = next.busName;
          }
        }
        const totalSec = walkToSec + waitSec + cumRide + walkFromSec;
        // An option whose two walking legs already exceed the direct walk is
        // never worth offering: totalSec = walkTo + wait + ride + walkFrom with
        // wait >= 0 and ride > 0, so walkTo + walkFrom >= directWalkSec IMPLIES
        // totalSec >= directWalkSec. More walking is therefore always also
        // slower, and this single test drops exactly the strictly-dominated
        // options — no faster trip can be lost to it.
        //
        // (An earlier attempt at report #40 added "&& totalSec >= directWalkSec"
        // believing this filter was discarding a faster ride. By the identity
        // above that conjunct is unreachable, so it changed nothing. The actual
        // client/server divergence in #40 was the walk model: the client ran at
        // 1.083 m/s effective against the server's 1.4, inflating every walk and
        // every walk-derived comparison. That is fixed in walk.ts.)
        if (walkToSec + walkFromSec >= directWalkSec) continue;
        options.push({
          mode: "shuttle",
          routeLabel: cfg.label, color: cfg.color,
          boardStopId: b, alightStopId: cur,
          walkToSec, waitSec, rideSec: cumRide, walkFromSec,
          totalSec, busName,
          directWalkSec,
          busEtaSec,
          computedAtMs: busEtaSec !== undefined ? now : undefined,
        });
      }
    }
  }
  // Options slower than just walking are KEPT (the user wants to see every
  // route), but the picker demotes and labels them "slower than walking" at
  // render time so one can't masquerade as the recommendation — that was
  // report #15: a 2-min ride wrapped in 29 min of walking totalled MORE
  // than the direct walk yet read like the top pick.
  const viable = options;
  // Per-route pick: lowest total time, with one carve-out — among options
  // whose totals are within ~3 min of the route's best, prefer the
  // shortest walk to the boarding stop ("catch the bus right outside").
  // The old pick minimized walk-to unconditionally, which ignored wait:
  // report #3 saw a 43-min wait at the nearest stop chosen over boarding
  // the same (resting) bus a 4-min walk away.
  const TOTAL_TIE_SEC = 180;
  const byRoute = new Map<string, TripOption[]>();
  for (const o of viable) {
    const bucket = byRoute.get(o.routeLabel);
    if (bucket) bucket.push(o);
    else byRoute.set(o.routeLabel, [o]);
  }
  const bestPerRoute = new Map<string, TripOption>();
  for (const [label, group] of byRoute) {
    const minTotal = Math.min(...group.map((o) => o.totalSec));
    const nearBest = group.filter((o) => o.totalSec <= minTotal + TOTAL_TIE_SEC);
    nearBest.sort((a, b) => a.walkToSec - b.walkToSec || a.totalSec - b.totalSec);
    const kept = nearBest[0];
    // Remember the route's other board stops (best alight for each) so the
    // live layer can offer one after a miss. Same-route candidates only —
    // dedup and ranking above are untouched by this.
    //
    // Stops the loop visits twice (Green/Purple's West Campus out-and-back
    // lists Buildings 400–900 in both directions) are left out: an alternate
    // is keyed by stop id, so its ride time would come from one occurrence
    // and the live arrival from whichever the bus reaches first — the bus
    // heading AWAY — and the two would be summed as one trip. Ambiguous, so
    // never offered.
    const altCfg = ROUTE_LISTS.find((c) => c.label === label);
    const altStops = altCfg ? mergedRouteStops(altCfg, routeStops) : [];
    const repeated = new Set(altStops.filter((sid, i) => altStops.indexOf(sid) !== i));
    const bestByBoard = new Map<number, TripOption>();
    for (const o of group) {
      if (o.boardStopId === kept.boardStopId || repeated.has(o.boardStopId)) continue;
      const prev = bestByBoard.get(o.boardStopId);
      if (!prev || o.totalSec < prev.totalSec) bestByBoard.set(o.boardStopId, o);
    }
    const alternates: TripAlternate[] = [...bestByBoard.values()]
      .sort((a, b) => a.walkToSec - b.walkToSec)
      .slice(0, MAX_ALTERNATES)
      .map((o) => ({
        boardStopId: o.boardStopId, alightStopId: o.alightStopId,
        walkToSec: o.walkToSec, walkFromSec: o.walkFromSec, rideSec: o.rideSec,
      }));
    bestPerRoute.set(label, alternates.length > 0 ? { ...kept, alternates } : kept);
  }
  // Sort the chosen options by total time for display.
  const dedup = [...bestPerRoute.values()]
    .sort((a, b) => a.totalSec - b.totalSec)
    .slice(0, 6);
  // Include the direct-walk option and sort the whole list by totalSec
  // so the FASTEST badge actually lands on the fastest one — previously
  // walk was hard-prepended and always got the badge. Skip the walk
  // suggestion entirely when the direct walk exceeds an hour: nobody
  // plans a 60+ min walk across New Haven, and offering it as a trip
  // option clutters the picker when the only viable choice is a bus.
  // ...unless it's the only thing we have. Report #35: a 4.3 km trip where
  // the server planner returned a perfectly good 53-min walk, but the client
  // walk model put it at 66 min — over this cutoff — so the walk was
  // suppressed, no shuttle matched, and the rider got a bare "No trip options
  // found between these locations." Suppressing the clutter is fine;
  // suppressing the last option is not. (The 29% model gap that produced those
  // 66 min is itself fixed — see walk.ts — but the guard stays: any trip with
  // no shuttle option must still offer the walk.)
  const walkList: TripOption[] = directWalkSec <= WALK_ONLY_MAX_SEC || dedup.length === 0
    ? [{
        mode: "walk",
        routeLabel: "Walk",
        color: "#546e7a",
        boardStopId: 0, alightStopId: 0,
        walkToSec: 0, waitSec: 0, rideSec: 0, walkFromSec: 0,
        totalSec: directWalkSec, busName: "",
        directWalkSec,
      }]
    : [];
  return [...walkList, ...dedup].sort((a, b) => a.totalSec - b.totalSec);
}

// ── Alternate pickup after a miss (report #55) ─────────────────────────────
//
// "The shuttle loops around my pickup location, so multiple stops could work:
// if I miss the Blue at Prospect/Canner I could pick it up on Whitney/Canner."
// planTrip already scored that second stop and dropped it (one option per
// route); the live layer then re-derives the card against the FROZEN board
// stop and pickLiveArrival switches VEHICLE only. So after a miss the card
// says "next in 25 min" and never that an 8-min walk catches the same bus.
//
// The test is arrival at the DESTINATION, not boarding time: on the same bus
// a rider boards sooner at an upstream stop yet arrives exactly when they
// would have — walking back buys nothing, and comparing boarding times would
// have suggested it. Comparing totals also makes the helper safe to run in
// every live state: while the pinned bus is still catchable at the rider's
// stop no downstream stop can beat it (the bus gets there later, the ride is
// shorter by the same amount), so it stays quiet until a miss — including the
// single-bus case the departed/missedBus flags never see, where the pinned
// bus's ETA silently jumps to a full lap.
//
// The gain must clear PIN_SWITCH_MARGIN_SEC: pickLiveArrival deliberately
// tolerates a different bus up to that much better at the rider's own stop
// (loyalty beats flapping), and this line must not undercut that by naming
// the same near-equivalent bus one stop over.

export const ALT_PICKUP_MIN_GAIN_SEC = PIN_SWITCH_MARGIN_SEC;

/**
 * The option re-planned through one of its alternates: the rider walks to
 * that stop instead and rides from there. Used when the rider taps the
 * alternate-pickup line; the live layer then re-derives wait/ETA against the
 * NEW board stop exactly as for any option, so the map, the step list and the
 * countdown all follow without special cases. The original board stop joins
 * the alternates, so the line can offer the way back if that turns better.
 * Null when `stopId` is not one of the option's alternates.
 */
/**
 * The identity of an option card. One card per route, except a same-route
 * alternate itinerary (report #55), which is keyed by its board stop so the
 * two can be listed, expanded and mapped independently.
 */
export function optionKey(o: Pick<TripOption, "routeLabel" | "boardStopId" | "viaAlternate">): string {
  return o.viaAlternate ? `${o.routeLabel} via ${o.boardStopId}` : o.routeLabel;
}

/** The route label behind an option key (see optionKey). */
export function optionKeyLabel(key: string): string {
  return key.split(" via ")[0]!;
}

export function switchToAlternate(option: TripOption, stopId: number): TripOption | null {
  const alt = option.alternates?.find((a) => a.boardStopId === stopId);
  if (!alt || option.mode !== "shuttle") return null;
  const {
    alternatePickup: _pickup, departed: _departed, missedBus: _missed,
    busEtaSec: _eta, computedAtMs: _at, alternates, ...rest
  } = option;
  const original: TripAlternate = {
    boardStopId: option.boardStopId, alightStopId: option.alightStopId,
    walkToSec: option.walkToSec, walkFromSec: option.walkFromSec, rideSec: option.rideSec,
  };
  const others = (alternates ?? []).filter((a) => a.boardStopId !== stopId);
  return {
    ...rest,
    viaAlternate: true,
    boardStopId: alt.boardStopId, alightStopId: alt.alightStopId,
    walkToSec: alt.walkToSec, rideSec: alt.rideSec, walkFromSec: alt.walkFromSec,
    waitSec: 0,
    totalSec: alt.walkToSec + alt.rideSec + alt.walkFromSec,
    alternates: [original, ...others].sort((a, b) => a.walkToSec - b.walkToSec).slice(0, MAX_ALTERNATES),
  };
}

export function alternatePickup(
  option: TripOption,
  buses: BusData[],
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  segmentTimes: SegmentTimes,
  dwellTimes: DwellTimes,
  now = Date.now(),
  liveFrom?: LatLon | null,
): AlternatePickup | null {
  if (option.mode !== "shuttle" || !option.alternates?.length) return null;
  // `departed` is not "the bus just left" — arrivals include each bus a lap
  // later, so a bus that just left still yields a (long) catchable ETA and the
  // card simply shows it. departed means NO arrival within the 90-min horizon
  // was catchable, and the option's totalSec is then stale plan-time data:
  // there is no honest rival to compare an alternate against, so say nothing
  // rather than send a rider to the nearest stop to wait for a lap.
  if (option.departed) return null;
  const cfg = ROUTE_LISTS.find((c) => c.label === option.routeLabel);
  if (!cfg) return null;
  const norm = (s: string) => s.replace(/^#/, "");
  // When the rider reaches the destination if they stay put — what the card
  // shows now, computed against the frozen board stop by the live layer.
  const stayTotal = option.totalSec;
  // Alternates are nearest-walk first; the first one that works is the answer
  // — a rider who just missed a bus wants the closest stop that saves them,
  // not a farther one that shaves another minute.
  for (const alt of option.alternates) {
    const coords = stopCoords[alt.boardStopId];
    const walkSec = liveFrom && coords
      ? walkSecFromMeters(haversineMeters(liveFrom, coords))
      : alt.walkToSec;
    let boardSec: number; let busName: string; let busEtaSec: number;
    // Same two rules planTrip uses to call a bus catchable at a board stop:
    // a bus dwelling there right now is boardable inside its dwell window;
    // otherwise the rider must reach the stop before eta + STOP_DWELL_SEC.
    const hereBus = buses.find(
      (b) => cfg.busRouteIds.includes(b.route_id) && b.at_stop_id === alt.boardStopId,
    );
    if (hereBus && walkSec <= dwellBoardWindowSec(hereBus, cfg.routeIds[0], alt.boardStopId, dwellTimes, now)) {
      boardSec = walkSec; busName = norm(hereBus.bus_name); busEtaSec = 0;
    } else {
      const next = computeUpcomingArrivals(
        [alt.boardStopId], buses, routeStops, stopCoords, segmentTimes, now,
      ).find((a) => a.routeLabel === option.routeLabel && walkSec <= a.eta + STOP_DWELL_SEC);
      if (!next) continue;
      boardSec = Math.max(walkSec, next.eta); busName = next.busName; busEtaSec = next.eta;
    }
    const total = boardSec + alt.rideSec + alt.walkFromSec;
    if (total > stayTotal - ALT_PICKUP_MIN_GAIN_SEC) continue;
    return { stopId: alt.boardStopId, walkSec, busName, busEtaSec, computedAtMs: now };
  }
  return null;
}

// Routes that geographically connect from→to (a stop within walking
// distance of each) regardless of whether they're running right now.
// Used as a fallback when planTrip returns only Walk: lets the picker
// explain "the Grocery TJ route goes there, but it's Sa/Su 10a–6p,
// next active Sat 10:00 AM" rather than leaving the rider staring at
// just "walk 45 min".
export interface PotentialRoute {
  label: string;
  color: string;
  boardStopId: number;
  alightStopId: number;
  schedule: string;
  nextActive: Date | null;
  /**
   * The schedule says this route should be running at `after`, yet no bus
   * produced a trip — the feed is empty (first bus not out yet, a dropout)
   * or the bus is off its route. The rider must read "should be running,
   * no bus reporting", never "Next: tomorrow 7:00 AM", which is what
   * `nextActive` alone says at 07:02 on a school morning.
   */
  activeNow: boolean;
}

export function findPotentialRoutes(
  from: LatLon, to: LatLon,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  after: Date,
): PotentialRoute[] {
  const out: PotentialRoute[] = [];
  for (const cfg of ROUTE_LISTS) {
    const stops = mergedRouteStops(cfg, routeStops);
    if (stops.length < 2) continue;
    // Any board stop near "from" and any alight stop near "to",
    // with alight further along the route than board (so we're not
    // suggesting a ride that goes the wrong way).
    let bestBoard = -1;
    let bestAlight = -1;
    let bestTotal = Infinity;
    for (let i = 0; i < stops.length; i++) {
      const b = stops[i];
      const bc = stopCoords[b];
      if (!bc) continue;
      const dFrom = haversineMeters(from, bc);
      if (dFrom > MAX_WALK_M) continue;
      // Wrap around the loop — same circular-route fix as planTrip.
      for (let j = 1; j < stops.length; j++) {
        const a = stops[(i + j) % stops.length];
        const ac = stopCoords[a];
        if (!ac) continue;
        const dTo = haversineMeters(to, ac);
        if (dTo > MAX_WALK_M) continue;
        const total = dFrom + dTo;
        if (total < bestTotal) {
          bestTotal = total; bestBoard = b; bestAlight = a;
        }
      }
    }
    if (bestBoard === -1) continue;
    out.push({
      label: cfg.label,
      color: cfg.color,
      boardStopId: bestBoard,
      alightStopId: bestAlight,
      schedule: fmtSchedule(cfg.label),
      nextActive: nextActiveWindow(cfg.label, after),
      activeNow: isRouteActiveAt(cfg.label, after),
    });
  }
  // Routes that should be running now first, then by next-active — soonest
  // first, routes with no schedule last.
  out.sort((a, b) => {
    if (a.activeNow !== b.activeNow) return a.activeNow ? -1 : 1;
    const ta = a.nextActive ? a.nextActive.getTime() : Infinity;
    const tb = b.nextActive ? b.nextActive.getTime() : Infinity;
    return ta - tb;
  });
  return out;
}

/**
 * Which of the sorted options the collapsed list shows.
 *
 * Two shuttles plus the walk row, and a third shuttle ONLY when it is nearly
 * as good as the second — riders weigh similar options themselves (from
 * Prospect/Canner to the Green, Blue ranked one minute behind Orange with a
 * quarter of the walking, and sat hidden behind "show more": report #46). A
 * distant third is noise and cedes its slot; the walk row always shows because
 * it is a different kind of answer, not a competing shuttle.
 */
export const THIRD_SHUTTLE_SLACK_SEC = 5 * 60;

export function topVisibleOptions(sorted: readonly TripOption[]): TripOption[] {
  const shuttles = sorted.filter((o) => o.mode === "shuttle");
  const second = shuttles[1];
  const third = shuttles[2];
  const keepThird =
    second !== undefined && third !== undefined &&
    third.totalSec <= second.totalSec + THIRD_SHUTTLE_SLACK_SEC;
  let seen = 0;
  return sorted.filter((o) => {
    if (o.mode !== "shuttle") return true;
    seen++;
    return seen <= 2 || (seen === 3 && keepThird);
  });
}
