// Client-side trip planning. Extracted from TransitMap.tsx unchanged except
// for the walk model, which now matches the server (see walk.ts).

import { computeUpcomingArrivals } from "./arrivals";
import type { DwellTimes, SegmentTimes } from "./arrivals";
import { haversineMeters } from "./geo";
import type { LatLon } from "./geo";
import type { BusData } from "./map-data";
import { BUS_SPEED_M_S, mergedRouteStops, ROUTE_LISTS } from "./routes";
import {
  fmtSchedule, fmtWindows, HEADWAY_MIN, isRouteActiveAt, isWindowActiveAt, nextActiveWindow, nextWindowStart,
} from "./schedule";
import type { PublishedWindow } from "./schedule";
import { AT_PLACE_M, MAX_WALK_M, WALK_ONLY_MAX_SEC, walkSecFromMeters } from "./walk";

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
};

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
        [b], buses, routeStops, stopCoords, segmentTimes, now, dwellTimes,
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
    bestPerRoute.set(label, nearBest[0]);
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

/**
 * Wording split inside the "already there" state: at or below this the two
 * points are ONE spot ("the same place you're starting from"); above it they
 * are two, a few steps apart.
 *
 * 10 m because that is smaller than any separation this network treats as two
 * places: the closest pair of distinct stops it serves is 10.3 m (Front / Rt 1
 * (N) and (S) — measured over the 172-stop fixture; the next four pairs are
 * 10.3–10.8 m). So the stronger sentence is never printed for two points the
 * app itself would call different stops.
 */
export const SAME_SPOT_M = 10;

/**
 * "You're already there": the destination is within `AT_PLACE_M` of the origin
 * and the planner produced no shuttle worth showing.
 *
 * The state is real and the planner is right to produce it. With endpoints
 * this close the dominance rule above discards every shuttle option — both
 * walk legs would have to fit inside a direct walk of ~zero — leaving a single
 * 0-minute Walk. What was wrong is what the screen then said: the "shuttles
 * that go there" fallback keys on exactly that walk-only shape and answered a
 * rider standing at their destination with a dozen routes and "should be
 * running now — no bus reporting yet".
 *
 * Both halves of the test matter. Distance alone is not enough: two stops can
 * be 10 m apart, so a (silly but real) ride between them can survive, and an
 * option must never be overruled by a message. An empty shuttle list alone is
 * not enough either: that is also what an off-hours cross-town trip looks
 * like, and THAT rider does want the route list.
 *
 * The threshold cannot hide a ride. Measured on the test network from Phelps
 * Gate, the first surviving shuttle option needs ~200 m of separation — well
 * clear of AT_PLACE_M — and `planner.test.ts` pins that.
 */
export function isAlreadyThere(
  from: LatLon | null | undefined,
  to: LatLon | null | undefined,
  options: readonly TripOption[] | null | undefined,
): boolean {
  if (!from || !to || !options) return false;
  if (options.some((o) => o.mode === "shuttle")) return false;
  return haversineMeters(from, to) <= AT_PLACE_M;
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

/**
 * The published window for a ROUTE_LISTS entry, if the payload carries one.
 * Looked up by the route ids the config lists (`routeIds`, then `busRouteIds`
 * as served by upstream), so a merged config still finds its timetable.
 */
export function publishedWindowFor(
  cfg: { routeIds: readonly string[]; busRouteIds: readonly number[] },
  publishedHours: Record<string, PublishedWindow> | undefined,
): PublishedWindow | undefined {
  if (!publishedHours) return undefined;
  for (const rid of cfg.routeIds) {
    const w = publishedHours[rid];
    if (w) return w;
  }
  for (const rid of cfg.busRouteIds) {
    const w = publishedHours[String(rid)];
    if (w) return w;
  }
  return undefined;
}

/**
 * The hours line a rider reads on a route's details page ("Runs M–F 7a–6p"):
 * the operator's published window when the payload carries one, ROUTE_HOURS
 * rendered as text otherwise, and null when neither knows the route — the
 * caller renders nothing rather than "Runs ". Same precedence as the All tab
 * and the "Shuttles that go there" panel, so the three never disagree.
 */
export function routeHoursCaption(
  cfg: { label: string; routeIds: readonly string[]; busRouteIds: readonly number[] },
  publishedHours: Record<string, PublishedWindow> | undefined,
): string | null {
  const published = publishedWindowFor(cfg, publishedHours);
  const hours = published ? fmtWindows([published]) : fmtSchedule(cfg.label);
  return hours ? `Runs ${hours}` : null;
}

export function findPotentialRoutes(
  from: LatLon, to: LatLon,
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  after: Date,
  // `/api/buses` `route_hours`: the operator's published timetable, keyed by
  // route id. When a route has one it is what the rider is told ("Runs …",
  // "Next: …", "should be running"); otherwise the hand-maintained ROUTE_HOURS
  // — which is the widened in-service gate, not the timetable — stands in.
  publishedHours?: Record<string, PublishedWindow>,
): PotentialRoute[] {
  const out: PotentialRoute[] = [];
  for (const cfg of ROUTE_LISTS) {
    const stops = mergedRouteStops(cfg, routeStops);
    if (stops.length < 2) continue;
    const published = publishedWindowFor(cfg, publishedHours);
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
      schedule: published ? fmtWindows([published]) : fmtSchedule(cfg.label),
      nextActive: published ? nextWindowStart([published], after) : nextActiveWindow(cfg.label, after),
      activeNow: published ? isWindowActiveAt([published], after) : isRouteActiveAt(cfg.label, after),
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

/**
 * How much WORSE a third shuttle may get before it gives up a slot it already
 * holds. Report #93: Division/Prospect → LEPH put Red at 39 min against Orange
 * at 34 — exactly `THIRD_SHUTTLE_SLACK_SEC` — so a second of wait noise on a
 * 5-second poll took the row away and gave it back, and Red "flashed off
 * screen". A row that is present, then absent, then present is worse than
 * either steady state: the rider cannot tell whether the route is an option.
 *
 * 90 s to match the reordering hysteresis in TransitMap (`HYST_SEC`, from the
 * same operator asking for "some stability — avoid flicker" on 2026-07-17).
 * This deliberately does NOT change which option is best or how options are
 * ranked — an option enters the third slot on the same test it always did, and
 * a shuttle that genuinely falls behind still leaves. It only refuses to act on
 * movement smaller than the noise the number is already known to carry.
 */
export const THIRD_SHUTTLE_HOLD_SEC = 90;

/**
 * `shownLabels` is the route labels this list returned on the previous poll —
 * pass it to get the hysteresis above; omit it (fresh plan, tests) for the
 * plain rule. Still pure: the caller owns the memory.
 */
export function topVisibleOptions(
  sorted: readonly TripOption[],
  shownLabels?: readonly string[],
): TripOption[] {
  const shuttles = sorted.filter((o) => o.mode === "shuttle");
  const second = shuttles[1];
  const third = shuttles[2];
  const held = third !== undefined && !!shownLabels?.includes(third.routeLabel);
  const slack = THIRD_SHUTTLE_SLACK_SEC + (held ? THIRD_SHUTTLE_HOLD_SEC : 0);
  const keepThird =
    second !== undefined && third !== undefined &&
    third.totalSec <= second.totalSec + slack;
  let seen = 0;
  return sorted.filter((o) => {
    if (o.mode !== "shuttle") return true;
    seen++;
    return seen <= 2 || (seen === 3 && keepThird);
  });
}
