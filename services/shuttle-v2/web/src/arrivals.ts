// Bus → stop ETA computation: `computeUpcomingArrivals`' contract, priced by
// the ring estimator (web/src/eta/) for every route.
//
// Until 2026-09-06 this file also held the legacy arithmetic — a point anchor
// (`findRouteAnchor`) held by a gate, a stall credit bounded three ways, an
// approach zone, chord proration and a served stand/drive split on an
// allowlist — which the model fell back to on a bridged ring (Green) and on a
// route with no measured drive (the grocery lines). Those two classes are
// priced from pooled priors now (eta/tables.ts), the fallback is gone, and
// the modules only it used (anchorGate.ts, hopPricing.ts, the anchor half of
// anchor.ts) went with it; the replays keep their own copies under
// scripts/eta-replay/legacy/ as the counterfactual baseline. What survives
// here is the contract every caller and every replay depends on.

import { isBusOnRoute } from "./anchor";
import { anchorKeyFor } from "./liveAnchor";
import { arrivalsForBus, globalPoolsFor, ringForBus, type AnchorStore } from "./eta";
import { residual, residualMedian } from "./eta/dist";
import { classPools, poolsWithFallback, stopModel } from "./eta/tables";
import type { LatLon } from "./geo";
import type { BusData } from "./map-data";
import { mergedRouteStops, ROUTE_LISTS } from "./routes";

/**
 * One hop of `segments[route]`. `avg`/`sd`/`n` are v1's arrival-to-arrival
 * numbers, read only when nothing better is served; `dq`/`dqn` are the
 * whole-leg quantiles the model prices from, `drive`/`driveN` the older
 * median form, `legM` the hop's road metres; `spm`/`spmN`/`spmPooled` ride
 * only on the reserved `__pace` carrier row (eta/tables.ts PACE_KEY).
 */
export type SegmentStat = {
  avg: number; sd?: number; n: number;
  drive?: number; driveN?: number;
  dq?: number[]; dqn?: number;
  legM?: number;
  spm?: number[]; spmN?: number; spmPooled?: boolean;
};
export type SegmentTimes = Record<string, Record<string, SegmentStat>>;
/**
 * One stop of `dwells[route]`. `q`/`qn` are the stand quantiles the model
 * prices from and `pstop` the served P(stop); `med`/`sd`/`low` are v1's
 * arrival-to-arrival figures, which NOTHING here reads any more (see WHAT A
 * DWELL STATISTIC ACTUALLY MEASURES in eta/tables.ts).
 */
export type DwellStat = { med: number; sd: number; n: number; low?: number; q?: number[]; qn?: number; pstop?: number };
export type DwellTimes = Record<string, Record<string, DwellStat>>;
export type DwellsByBus = Record<string, DwellTimes>;

/** What the pause chip should say, and whether it is a remainder or a total. */
export interface ShownStand {
  sec: number;
  /**
   * true  — seconds STILL TO STAND, the residual of the stop's stand table
   *         at the elapsed clock, the very term the countdown adds.
   * false — the stop's typical stand, for a stop the bus is not standing at.
   */
  remaining: boolean;
  /**
   * The stop's TYPICAL hold — what the same table says a bus that has only
   * just arrived still has to stand. Present only when `remaining` is true.
   *
   * Deliberately unconditional, so it does not move while a bus sits. The
   * conditional total does move, and correctly: a bus five minutes into a
   * hold is drawn from the longer-hold population, so its expected total is
   * genuinely larger than a bus two minutes in (339 s vs 478 s at stop 11).
   * That is the inspection paradox and it is real — but the operator's call,
   * having seen both: "well actually, stable makes more sense", because the
   * figure reads as a fact about the STOP rather than a prediction about the
   * bus, and a number that creeps upward while nothing happens invites the
   * reader to look for a cause that is not there.
   *
   * The cost, stated so nobody rediscovers it: `typicalSec - elapsed` is NOT
   * what is left. `sec` is. A rider five minutes into a typical six-minute
   * hold may still have three minutes to go.
   */
  typicalSec?: number;
  /**
   * The q10 and q90 of the SAME remainder `sec` is the median of — what is
   * left if this stand ends early, and if it runs on. Present only when
   * `remaining` is true.
   *
   * They exist because a point estimate is the wrong shape of answer late in
   * a long stand: the conditional median rises as a bus out-sits its table
   * and, on the operator's 2026-09-07 case, reached 10:28 against a 9:16
   * truth — a promise that a rider can act on and miss the bus. A pair
   * bounded below by "it may go now" cannot mislead that way. standWait.ts
   * turns them into the chip's words and the countdown's range.
   */
  soonSec?: number;
  lateSec?: number;
}

/**
 * The hold to PUT ON SCREEN beside a bus that is standing at a stop.
 *
 * The chip reads the model's own stand table — the class-shrunk survival
 * curve `stopModel` builds, leaning on the route's and then the network's
 * class pools exactly as the price does — at the same elapsed clock the
 * countdown is billed under, so the two cannot disagree. It has disagreed
 * twice: a per-bus dwell beside a route dwell, then `dwell.med` (the
 * arrival-to-arrival median, which CONTAINS DRIVE TIME) beside the
 * conditional standing quantiles — "⏸ 3 min / ~10 min" beside "5 min"
 * (2026-09-04). Displaying one number while billing another is a bug
 * whichever number is right, so there is only one source.
 *
 * With `elapsedSec` the answer is what is LEFT (report #73: a rider handed
 * "3 of 10" subtracts against the wrong total); without it, the typical
 * stand. Null for a stop with no table.
 */
export function shownStandSec(
  stat: DwellStat | undefined,
  elapsedSec: number | null,
  routeDwells: Record<string, DwellStat>,
  /** Every route's tables, for the network-level pools (omit: the route's own only). */
  dwellsByRoute?: DwellTimes,
): ShownStand | null {
  if (!stat || !stat.q || stat.q.length < 3) return null;
  const pools = poolsWithFallback(classPools(routeDwells), dwellsByRoute ? globalPoolsFor(dwellsByRoute).pools : undefined);
  const m = stopModel(stat, pools);
  if (elapsedSec !== null) {
    const rest = residual(m.stand, elapsedSec);
    return {
      sec: rest(0.5), remaining: true,
      soonSec: rest(0.1), lateSec: rest(0.9),
      typicalSec: residualMedian(m.stand, 0),
    };
  }
  return { sec: residualMedian(m.stand, 0), remaining: false };
}

export type UpcomingArrival = {
  eta: number; low: number; high: number;
  /**
   * The DRIVE FLOOR (eta/arrival.ts `departNow`): this same arrival with the
   * rest the bus is in right now ended this second. Equal to `eta` for a bus
   * that is not resting.
   *
   * It is here so the standing card's range can be floored by a number the
   * model measured rather than one the display reconstructs. standWait.ts used
   * to take `eta - remainingStand`, with the stand read from `shownStandSec`'s
   * separate pass at a separate clock: two arithmetics differing by decay, by
   * the route/horizon corrections and by which clock the stand was billed
   * under, subtracted from one another and floored at zero. On a stand past
   * its table the difference collapses and the low end degenerates to a stand
   * quantile with no drive in it at all — "in <1 min" for a bus three hops and
   * 472 m away (operator, 2026-09-10).
   */
  departNow: number;
  routeLabel: string; color: string; busName: string; stopId: number;
  /**
   * Hops from the bus's anchor to this stop, 1-based — the loop walks twice,
   * so the same vehicle a lap later is `stopsAhead > totalStops`.
   *
   * ⚠️ **It counts hops on the CANONICAL sequence**, `mergedRouteStops`, which
   * keeps the primary route's stops VERBATIM — repeats and all, because Green
   * and Purple pass West Campus twice. It is emphatically NOT an index into
   * the de-duplicated lists TransitMap's render sites build (Green 23 → 20,
   * Purple 15 → 11), which is the distinction `anchorIndexOnList` exists to
   * keep straight (liveAnchor.ts). The right reading is "how many stops of the
   * real ride are between the bus and this stop", which is the quantity a
   * distance bucket wants; translating it to a render list would silently mean
   * something else on exactly the two routes where the estimator is worst.
   *
   * Purely descriptive: nothing in the estimator reads it. It exists so a
   * logged reading can say how far away the bus was when the number was shown
   * (`predictions_log.stops_ahead`, and the by-distance buckets both accuracy
   * readers roll up), which is the difference between "our 1-stop numbers are
   * fine and our 8-stop ones are not" and one undifferentiated median.
   */
  stopsAhead: number;
  /**
   * TRUE when no served table backed any hop of the chain — every drive came
   * from the pace prior (the route's own, or the network's pooled one on a
   * line that has no legs yet) and every stand from a pool. The route cards
   * render it as a `~` prefix and a dimmed number, which is the app telling
   * the rider "this line has not been measured yet" rather than quietly
   * presenting a prior as a measurement.
   *
   * It is a property of the whole chain, not of the first hop: one unmeasured
   * hop among nine calibrated ones is not what the `~` is for, and a route the
   * collector has never seen is.
   */
  estimated: boolean;
};

export function computeUpcomingArrivals(
  targetStopIds: number[],
  buses: BusData[],
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  segmentTimes: SegmentTimes,
  now = Date.now(),
  dwellTimes: DwellTimes = {},
  /**
   * Per-vehicle memory: the belief on the ring and the display floors
   * (eta/index.ts). Supplied, a bus's posterior carries from poll to poll;
   * omitted, every call prices from the stateless prior and this function
   * stays pure — which is what every hypothetical/replayed call wants, and
   * what the existing tests assert.
   */
  anchorStore?: AnchorStore,
): UpcomingArrival[] {
  const result: UpcomingArrival[] = [];
  const targetSet = new Set(targetStopIds);
  for (const cfg of ROUTE_LISTS) {
    const stops = mergedRouteStops(cfg, routeStops);
    const hitsTarget = stops.some((s) => targetSet.has(s));
    if (!hitsTarget) continue;

    const routeBuses = buses.filter((b) =>
      cfg.busRouteIds.includes(b.route_id) && isBusOnRoute(b, stops, stopCoords),
    );
    if (routeBuses.length === 0) continue;

    const primary = cfg.routeIds[0]!;
    const routeSegs = segmentTimes[primary] ?? {};
    const routeDwells = dwellTimes[primary] ?? {};

    // Every route is priced from a distribution on the ring: no point anchor,
    // no stall credit, no approach zone, no chord proration — those are gone
    // (2026-09-07), and there is no second arithmetic behind this one. Only a
    // route with no ring at all — fewer than two stops, or a stop with no
    // coordinate — has nothing to price on, and then the route shows no times
    // rather than a number from a model that could not be built.
    //
    // `dwellTimes` — every route's tables, not just this one's — goes in so a
    // line the collector has not timed yet can lean on the NETWORK's stand
    // pools (eta/tables.ts `globalClassPools`), the level above its own. With
    // the all-routes pooled pace beside it (calibrator.ts `withPooledPace`)
    // that is what took the grocery lines off the arithmetic that used to sit
    // below this line; #160's repaired ring took Green off it.
    const ring = ringForBus(routeBuses[0]!, stops, stopCoords);
    if (!ring) continue;
    for (const bus of routeBuses) {
      const rows = arrivalsForBus(
        anchorStore, anchorKeyFor(cfg.label, bus.bus_name), bus, ring, stops, stopCoords,
        routeSegs, routeDwells, targetSet, now, undefined, dwellTimes,
      );
      for (const row of rows) {
        result.push({
          eta: row.eta, low: row.low, high: row.high, departNow: row.departNow,
          routeLabel: cfg.label, color: cfg.color,
          busName: bus.bus_name.replace("#", ""),
          stopId: row.stopId, stopsAhead: row.stopsAhead, estimated: row.estimated,
        });
      }
    }
  }
  result.sort((a, b) => a.eta - b.eta);
  return result;
}

/**
 * The bus AFTER the one a trip option is already showing — the "next in …"
 * half of the countdown.
 *
 * WHY THIS IS NOT A `.filter(a => a.eta > shown + 30)`.
 *
 * That is what it used to be, and the margin was doing two jobs at once:
 * skipping the pinned vehicle's own arrival (which sits at ~`shown`), and
 * requiring the answer to be genuinely later. The trouble is that 30 seconds
 * past the pinned bus is exactly where a REAL trailing bus lives — a line
 * running a two-minute gap puts one there — so ordinary recompute noise moved
 * candidates across the boundary, and the fallback when one dropped out was
 * the pinned vehicle's own NEXT LAP. The rider watched "next in 8 min" become
 * "next in 37 min" and back, seven times in six and a half minutes, while the
 * first figure never moved at all (measured live on Blue Day, 2026-09-03).
 *
 * So the two jobs are separated. The arrival already on screen is excluded by
 * IDENTITY — it is the pinned vehicle's earliest entry — and the "genuinely
 * later" test then compares against that entry's own eta. Both sides now come
 * from one `computeUpcomingArrivals` call, so the comparison cannot drift with
 * how long ago the pin was priced, and no threshold sits where real vehicles
 * are.
 *
 * This is deliberately NOT smoothing. Nothing about the world was changing
 * when the number flapped — the same buses were the same distance away, and
 * the first figure was steady. Only a boundary was being crossed. A bus that
 * genuinely leaves early must still be free to move the number.
 *
 * `arrivals` may hold two entries per vehicle (this lap and the next), which
 * is what makes a single-bus line answer "next in 54 min" correctly.
 */
export function nextArrivalAfterPinned<A extends { eta: number; busName: string }>(
  arrivals: readonly A[],
  pinnedBusName: string,
  /** Used only when the pinned vehicle is not in `arrivals` at all. */
  fallbackShownEta: number,
): A | null {
  const norm = (s: string) => s.replace(/^#/, "");
  const sorted = [...arrivals].sort((a, b) => a.eta - b.eta);
  const shownIdx = pinnedBusName
    ? sorted.findIndex((a) => norm(a.busName) === norm(pinnedBusName))
    : -1;
  const shown = sorted[shownIdx];
  const shownEta = shown ? shown.eta : fallbackShownEta;
  return sorted.find((a, i) => i !== shownIdx && a.eta > shownEta) ?? null;
}
