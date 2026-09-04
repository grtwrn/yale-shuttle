// Bus → stop ETA computation. Extracted from TransitMap.tsx unchanged.

import { findRouteAnchor, isBusOnRoute, routePathFor } from "./anchor";
import { gateAnchor, type AnchorStore } from "./anchorGate";
import {
  buildGeometry,
  beliefStoreFor,
  componentPosition,
  stepStore,
  type BeliefStore,
  type RouteGeometry,
} from "./belief";
import { driveAdequate, priceFirstHop, standAdequate, standingAt, STANDING_HOLD_M } from "./hopPricing";
import { haversineMeters, progressAlongSegment } from "./geo";
import type { LatLon } from "./geo";
import type { BusData } from "./map-data";
import { BUS_SPEED_M_S, mergedRouteStops, ROUTE_LISTS } from "./routes";

/**
 * `drive`, when served, is the seconds from the last poll at the from-stop to
 * arrival at the to-stop — the hop WITHOUT the standing time at its start.
 * With it and the from-stop's `q` present, the first hop is priced by
 * `hopPricing.ts` instead of the credit below; absent, nothing changes.
 */
export type SegmentStat = { avg: number; sd?: number; n: number; drive?: number; driveN?: number };
export type SegmentTimes = Record<string, Record<string, SegmentStat>>;
/**
 * `low` is the p35 the calibrator still serves. NOTHING in the estimator reads
 * it — see WHAT A DWELL STATISTIC ACTUALLY MEASURES below for why the change
 * that did was reverted. Kept so a correctly-derived rest model can use it.
 */
/** `q`: ascending quantiles of the standing time at this stop (see hopPricing.ts). */
export type DwellStat = { med: number; sd: number; n: number; low?: number; q?: number[]; qn?: number };
export type DwellTimes = Record<string, Record<string, DwellStat>>;
export type DwellsByBus = Record<string, DwellTimes>;

const geometryCache = new WeakMap<object, Map<string, RouteGeometry>>();

function weightedMedian(
  values: readonly { eta: number; variance: number; weight: number }[],
): number {
  const total = values.reduce((sum, value) => sum + value.weight, 0);
  if (!(total > 0)) return 0;
  const ordered = [...values].sort((a, b) => a.eta - b.eta);
  let cumulative = 0;
  for (const value of ordered) {
    cumulative += value.weight;
    if (cumulative >= total / 2) return value.eta;
  }
  return ordered[ordered.length - 1]!.eta;
}

function routeGeometry(
  path: readonly (readonly [number, number])[],
  stops: readonly number[],
  stopCoords: Record<number, LatLon>,
): RouteGeometry | null {
  let bySequence = geometryCache.get(path as object);
  if (!bySequence) {
    bySequence = new Map();
    geometryCache.set(path as object, bySequence);
  }
  const key = stops.join(",");
  const cached = bySequence.get(key);
  if (cached) return cached;
  const coords = stops.map((stop) => stopCoords[stop]).filter((p): p is LatLon => !!p);
  if (coords.length !== stops.length) return null;
  const geometry = buildGeometry(
    path.map((p) => [p[0], p[1]] as [number, number]),
    coords,
  );
  if (!(geometry.loopLength > 0) || geometry.legs.length !== stops.length) return null;
  bySequence.set(key, geometry);
  return geometry;
}

/**
 * How much of the first hop's calibrated time an elapsed dwell may cancel when
 * we have no dwell statistic for the stop. It is only that fallback — with
 * dwell data the bound is the dwell figure itself. See the stall-credit
 * comment in computeUpcomingArrivals, and the warning there that the bound is
 * empirical rather than a decomposition of the hop.
 */
export const STALL_CREDIT_MAX_FRACTION = 0.5;

/**
 * The shortest time any hop may be billed at. Shared by the unmeasured-hop
 * estimate and the stall-credit floor below, because it is the same claim in
 * both places: a bus still standing at A is not about to be at B — it has to
 * shut its doors, pull out and cover the block.
 */
export const MIN_HOP_SEC = 30;

/**
 * Mirrors `MAX_PLAUSIBLE_M_S` in `src/calibrator/calibrator.ts`, where it is
 * defined as the fastest a shuttle can plausibly cover the straight-line
 * distance between two stops (~79 km/h — generous, because the West Campus
 * legs really are highway runs). `arrivals.test.ts` parses the server's
 * source, so the two cannot drift.
 *
 * It must be an UPPER bound on speed, which is why it is not `BUS_SPEED_M_S`.
 * That constant is 6 m/s, a TYPICAL speed used to guess unmeasured hops; using
 * it here would floor a 370 m hop at 62 s and so withhold credit a bus has
 * genuinely earned. That is the padding that broke the Red layover on
 * 2026-09-03 (docs/eta-accuracy.md): the board promised 5 min, the bus came in
 * 2.5, and the rider who trusted the 5 missed it. Measured
 * over 412,994 replayed predictions, the 6 m/s floor did score a better median
 * but paid for it in the pessimistic tail; 22 m/s is the variant that improves
 * the median and the optimistic tail while leaving the pessimistic tail alone.
 */
export const MAX_PLAUSIBLE_M_S = 22;

/**
 * A stall credit may cancel WAITING. It may never cancel DRIVING.
 *
 * This floor is deliberately NOT derived from the dwell/segment decomposition —
 * that premise is false (see below) and has already cost three shipped changes.
 * It rests on geometry: the stops are a known distance apart, and no bus covers
 * that distance faster than `MAX_PLAUSIBLE_M_S`. The straight line understates
 * the road, so the result is a true lower bound on travel time rather than one
 * more estimate to argue with.
 *
 * It exists because the dwell bound alone could erase a hop completely. On the
 * live payload the calibrated dwell median meets or exceeds the whole segment
 * average on 114 of 274 hops (41.6%) — the two are estimators of the same
 * quantity, so this is common, not exceptional — and a bus that had stood long
 * enough was promised at the next stop INSTANTLY: 0 s to cover 311 m. Replaying
 * 88,570 production positions that fired on 9.3% of at-stop next-stop
 * predictions.
 */
function driveFloorSec(a: LatLon | undefined, b: LatLon | undefined): number {
  if (!a || !b) return 0;
  return Math.max(MIN_HOP_SEC, haversineMeters(a, b) / MAX_PLAUSIBLE_M_S);
}

/**
 * WHAT A DWELL STATISTIC ACTUALLY MEASURES — read this before using `dwells`
 * for anything.
 *
 * `dwells[route][stop]` does NOT measure how long a bus stands at that stop.
 * Nothing in this system measures that. `detector.ts` computes ONE number per
 * transition —
 *
 *     elapsedSec = obs.collectedAt - prev.enteredAt
 *
 * the time from the bus becoming nearest stop A to it becoming nearest stop B
 * — and emits that same number twice: as `DwellEvent.dwellSec` (keyed on A)
 * and as `SegmentEvent.travelSec` (keyed on A→B). They are not two
 * measurements. Joined on their shared anchor over 30 days,
 * **119,329 of 119,329 rows have `dwell_sec == travel_sec` exactly**, mean
 * difference 0.
 *
 * So a segment is arrival to arrival (which is why the planner must never add
 * a dwell to it), but `seg.avg - dwells[from].med` is NOT "the drive". It is
 * two estimators of the SAME quantity disagreeing: a 30-day shrunk mean keyed
 * (route, from, to) minus a 14-day windowed median keyed (route, from). The
 * proof is that the subtraction goes negative — on the live payload the dwell
 * median exceeds the whole segment average on **41.2% of hops** (113 of 274),
 * which is impossible if the segment were that dwell plus a drive.
 *
 * That false premise has now cost two shipped changes, so it is written down
 * here rather than left to be re-derived:
 *
 * 1. **Re-pricing an unstarted rest at the low quantile** (2026-09-03, PR #40,
 *    reverted the same day). It billed `max(30, seg.avg - med) + low` for
 *    every hop after the first, meaning to shave a rest the bus had not begun.
 *    Because `med` is an estimate of the whole hop, `seg.avg - med` collapsed
 *    onto the 30 s floor and the hop became `30 + low` — LARGER than
 *    `seg.avg`. It raised 66% of eligible hops on the live payload (median
 *    +12.9 s) and 77% swept over a week (median +24.9 s, mean +43.4 s); Blue
 *    Night's 333 Cedar → 129 York went from a 63 s segment to 597 s. Replayed
 *    over 262,762 real (prediction, actual) pairs it moved the median absolute
 *    error 37.5 → 46.7 s and the share more than two minutes PESSIMISTIC
 *    11.0% → 13.0% — the exact direction it was merged to reduce, and the one
 *    that costs a rider the bus. Expressing the same intent as an honest
 *    discount (`seg.avg - (med - low)`) overshoots the other way: -28.8 s of
 *    bias overall and -105 s median on rest-spanning chains, because
 *    `med - low` is p50-p35 of the WHOLE hop, compounded over five hops.
 * 2. The step-1 stall-credit bound below rests on the same story. It is left
 *    alone deliberately — it is guarded by a recorded-pass gate
 *    (`npm run test:accuracy`) and its measured alternatives were worse — but
 *    it is NOT the principled "cancel only the dwell part" it reads as. See
 *    the note there.
 *
 * `DwellStats.low` (the p35) is still calibrated and still served. Nothing in
 * the estimator reads it; it is kept because a correctly-derived rest model
 * may want it, and ripping it out is a larger diff for no rider benefit.
 */

/**
 * The dwell the ETA actually BILLS at a stop — the single definition, shared
 * with whatever puts a hold on screen.
 *
 * It is the median, at every position: the stop the bus is standing at and
 * every stop still ahead of it. The ETA charges the segment average for both,
 * and the median is the dwell statistic that average is drawn from.
 *
 * It exists because the two drifted: the route page showed a stop's MEDIAN
 * hold ("⏸ ~10 min") beside an arrival time computed from the low quantile,
 * and a rider did the arithmetic — "it says arrive in 8 but expected dwell is
 * 10" (report #73). Displaying one number while billing another is a bug
 * whichever number is right, so there is only one.
 *
 * The `started` argument is kept, and deliberately ignored, so that a future
 * position-dependent price has one place to live rather than growing a second
 * call site. Report #77 — "it said five minutes dwell, then nine when it got
 * there" — is answered by there being nothing left to disagree: the figure a
 * rider sees before the bus arrives is the figure they see after.
 */
export function billedDwellSec(
  stat: { med: number; low?: number } | undefined,
  _started: boolean,
): number | null {
  if (!stat || !Number.isFinite(stat.med)) return null;
  return stat.med;
}

/**
 * The credit is spent on the FIRST hop only, and never beyond the dwell that
 * hop actually contains.
 *
 * On 2026-09-03 this briefly reached the adjacent stop too, on the theory
 * that a driver's break taken one stop early leaves the layover ahead
 * double-charged. Measured against a week of `arrivals`, the theory is wrong:
 * of 321 cases where a bus held 3+ minutes at a non-layover stop with a
 * layover-sized hold at the next stop, the layover was still taken as
 * scheduled 292 times and skipped only 29 — 91% against. A bus holding
 * abnormally long is usually running late and will take its layover anyway,
 * so crediting it forward makes the ETA optimistic in nine cases out of ten,
 * which is the direction that has a rider stroll to the stop and miss the
 * bus. The replay agreed it was not worth it (+0.1 s median even at its most
 * conservative). Reverted; do not re-add without new evidence.
 *
 * What DID fix the reported symptom is in the collector, not here: a parked
 * bus that shuffled a few metres restarted its own dwell clock, so the credit
 * was ~0 on a bus most of the way through its layover. See
 * `BusState.stationarySince`, whose frame is the stop the bus is waiting at —
 * anchoring it on the BUS is what let a yard shuffle throw the layover away
 * (report #82).
 */

export type UpcomingArrival = {
  eta: number; low: number; high: number;
  routeLabel: string; color: string; busName: string; stopId: number;
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
   * Per-vehicle anchor memory. Supplied, a bus is only relocated on the loop
   * when something corroborates the move (see anchorGate.ts); omitted, the
   * anchor is the raw stateless one and this function stays pure — which is
   * what every hypothetical/replayed call wants, and what the existing tests
   * assert.
   */
  anchorStore?: AnchorStore,
  /**
   * Directed-loop posterior memory. When supplied with a published route
   * path, this replaces the point anchor for ETA pricing. Omitted calls retain
   * the established anchor path (tests, future-mode plans, old replays).
   */
  beliefStore?: BeliefStore,
): UpcomingArrival[] {
  const result: UpcomingArrival[] = [];
  const targetSet = new Set(targetStopIds);
  const activeBeliefStore = beliefStore ?? (
    anchorStore ? beliefStoreFor(anchorStore) : undefined
  );
  for (const cfg of ROUTE_LISTS) {
    const stops = mergedRouteStops(cfg, routeStops);
    const hitsTarget = stops.some((s) => targetSet.has(s));
    if (!hitsTarget) continue;

    const routeBuses = buses.filter((b) =>
      cfg.busRouteIds.includes(b.route_id) && isBusOnRoute(b, stops, stopCoords),
    );
    if (routeBuses.length === 0) continue;

    const routeSegs = segmentTimes[cfg.routeIds[0]] ?? {};
    const routeDwells = dwellTimes[cfg.routeIds[0]] ?? {};
    const segValues = Object.values(routeSegs).filter((s) => s.n >= 2);
    const avgSeg = segValues.length > 0
      ? segValues.reduce((sum, s) => sum + s.avg, 0) / segValues.length
      : 0;
    const fallbackSd = avgSeg * 0.5;
    // The stand/drive pricing (hopPricing.ts) and its standing memory engage
    // only on a route the calibrator serves the split for; otherwise nothing
    // below this line behaves differently from before it existed.
    const splitServed = Object.values(routeSegs).some(driveAdequate)
      && Object.values(routeDwells).some(standAdequate);
    // Stage the posterior where a point anchor is structurally incapable of
    // representing the route: one stop sequence visits the same spur twice.
    // On simple loops the matched replay found no branch problem to solve and
    // the handoff added reversals; retaining the established gate there makes
    // this a measured rollout rather than a global algorithm switch.
    const seenStops = new Set<number>();
    const hasRepeatedStop = stops.some((stop) => {
      if (seenStops.has(stop)) return true;
      seenStops.add(stop);
      return false;
    });

    for (const bus of routeBuses) {
      // Anchor = segment start. GPS is the ground-truth signal;
      // last_stop_id only breaks ties on routes that revisit a
      // vicinity (e.g., Red passes 130 Prospect on both inbound
      // and outbound legs). This replaces the older "trust feed,
      // advance one stop at a time" pattern which stalled when
      // last_stop_id was multi-stops-stale and the bus had drifted
      // off-axis from subsequent segment lines.
      const rawAnchorIdx = findRouteAnchor(bus, stops, stopCoords);
      if (rawAnchorIdx < 0) continue;
      // A 35 m GPS wobble must not relocate the bus a third of a lap. The gate
      // holds the previous anchor until an arrival/departure, real movement, or
      // a corroborated last_stop_id change says the bus actually went
      // somewhere. Releases in the SAME poll on at_stop_id, so a bus leaving
      // early still collapses the countdown immediately.
      let gpsAnchorIdx = anchorStore
        ? gateAnchor(anchorStore, `${cfg.label}|${bus.bus_name}`, rawAnchorIdx, bus, now, stops.length).index
        : rawAnchorIdx;

      // at_stop_id is GPS-computed every poll cycle (~5 s) and is more
      // current than last_stop_id (the feed lags by one stop on arrival).
      // findRouteAnchor already returns at_stop_id's index whenever it is
      // legitimate — near the bus AND at most one stop ahead of the GPS
      // anchor — so the anchor is simply trusted here.
      //
      // The dwell/stall credit is granted ONLY when the anchor agrees the bus
      // is actually at that stop. There used to be a second at_stop_id
      // override right here with NO distance and NO ordering check, weaker
      // even than findRouteAnchor's. On Green the two Orange/Pearl platforms
      // are 35 m apart but 9 stops apart in the loop, so a 35 m GPS wobble
      // relocated the bus a third of a lap and swung the displayed ETA by
      // ~10 minutes — exactly the "6 min then it said 16" in report #32.
      let stallCredit = 0;
      if (bus.at_stop_id && bus.at_stop_since) {
        const atIdx = stops.indexOf(bus.at_stop_id);
        if (atIdx >= 0 && atIdx === gpsAnchorIdx) {
          stallCredit = Math.max(
            0,
            (now - new Date(bus.at_stop_since + "Z").getTime()) / 1000,
          );
        }
      }

      // Mid-segment proration: if the bus is en route (not dwelling at
      // the anchor) and GPS shows it between A and B, scale the first
      // segment's time by the fraction of A→B still ahead.
      //
      // Use the along-segment projection t (0 = at A, 1 = at B) — the
      // same number the anchor-advance uses — so the two stay
      // consistent. Perpendicular GPS jitter moves t very little, unlike
      // straight-line-to-B distance which can swing wildly. Remaining
      // fraction = (1 - t), clamped [0, 1]: if anchor-advance didn't
      // fire but t happens to exceed 1 due to sub-step drift, treat it
      // as 0 remaining rather than negative.
      // "Standing" for the split pricing is NOT "at_stop_id is set this poll".
      // The flag is a PUBLICATION signal with a 75 m radius; a parked bus that
      // shuffles to 85 m loses it for one poll while plainly still standing,
      // and pricing that poll as en route collapses the countdown to the
      // drive and brings it back ("in 8 -> in 1 -> in 6"). The stop-pinned
      // clock survives that shuffle (PR #67); so does this memory of it.
      let standingSec: number | null = stallCredit > 0 ? stallCredit : null;
      let standingMemo: { stopId: number; standingSec: number } | null = null;
      if (anchorStore && splitServed) {
        standingMemo = standingAt(
          anchorStore,
          `${cfg.label}|${bus.bus_name}`,
          bus,
          now,
          stopCoords,
          STANDING_HOLD_M,
        );
        if (standingMemo) {
          const N = stops.length;
          for (let i = 0; i < N; i++) {
            if (stops[i] !== standingMemo.stopId) continue;
            const d = ((i - gpsAnchorIdx) % N + N) % N;
            if (d <= 1 || d === N - 1) {
              gpsAnchorIdx = i;
              standingSec = standingMemo.standingSec;
              break;
            }
          }
        }
      }
      const fallbackBusIdx = gpsAnchorIdx;
      let firstSegProgressFactor = 1;
      if (stallCredit === 0 && bus.lat && bus.lon) {
        const a = stopCoords[stops[fallbackBusIdx]];
        const b = stopCoords[stops[(fallbackBusIdx + 1) % stops.length]];
        if (a && b) {
          const t = progressAlongSegment({ lat: bus.lat, lon: bus.lon }, a, b);
          firstSegProgressFactor = Math.max(0, Math.min(1, 1 - t));
        }
      }

      type Hypothesis = {
        branchId: number;
        busIdx: number;
        firstSegProgressFactor: number;
        standingSec: number | null;
        stallCredit: number;
        weight: number;
      };
      let hypotheses: Hypothesis[] = [{
        branchId: -1,
        busIdx: fallbackBusIdx,
        firstSegProgressFactor,
        standingSec,
        stallCredit,
        weight: 1,
      }];

      const path = activeBeliefStore && hasRepeatedStop
        ? routePathFor(cfg.routeIds[0])
        : undefined;
      const geometry = path ? routeGeometry(path, stops, stopCoords) : null;
      if (activeBeliefStore && geometry && bus.lat && bus.lon) {
        const coldStandingSec = bus.at_stop_since
          ? Math.max(0, (now - new Date(bus.at_stop_since + "Z").getTime()) / 1000)
          : null;
        const posterior = stepStore(
          activeBeliefStore,
          `${cfg.label}|${bus.bus_name}`,
          geometry,
          {
            lat: bus.lat,
            lon: bus.lon,
            t: now,
            lastStopId: bus.last_stop_id,
            stops,
            standingSec: coldStandingSec,
          },
        );
        // A 50/50 half-lap mixture has no honest scalar ETA: its mean is a
        // route position the bus cannot occupy. Keep collecting evidence but
        // retain the established gated anchor until one direction resolves.
        // This is a fallback, not MAP—the losing branch remains in the store
        // and can recover on a later fix.
        if (posterior.resolved) {
          hypotheses = posterior.branches.flatMap((branch) =>
            branch.components.map((component): Hypothesis => {
              const pos = componentPosition(geometry, component);
              const pinned = component.mode === "standing"
                && standingMemo?.stopId === stops[pos.leg];
              return {
                branchId: branch.id,
                busIdx: pos.leg,
                firstSegProgressFactor: pinned ? 1 : 1 - pos.progress,
                standingSec: pinned ? standingMemo?.standingSec ?? null : null,
                stallCredit: 0,
                weight: component.weight,
              };
            })
          );
        }
      }

      const estimates = new Map<string, Array<{ eta: number; variance: number; weight: number; stopId: number; occurrence: number; branchId: number }>>();
      const totalStops = stops.length;
      const MAX_ETA_SEC = 90 * 60; // sanity cap — beyond this the lap-2 guess is noise
      for (const hypothesis of hypotheses) {
        let cumulative = 0;
        let cumulativeVar = 0;
        let hypothesisStallCredit = hypothesis.stallCredit;
        const recordedForStop = new Map<number, number>();
        // Walk the loop TWICE so each stop can get the upcoming arrival and
        // the same vehicle a full lap later. Each posterior component walks
        // only forward; matching occurrences are mixed below, never exposed as
        // duplicate buses.
        for (let step = 1; step <= totalStops * 2; step++) {
        const busIdx = hypothesis.busIdx;
        const prevI = (busIdx + step - 1) % totalStops;
        const curI = (busIdx + step) % totalStops;
        const seg = routeSegs[`${stops[prevI]}-${stops[curI]}`];
        let segAvg: number;
        let segVar: number;
        if (seg && seg.n >= 1) {
          segAvg = seg.avg;
          segVar = (seg.sd ?? 0) ** 2;
          // A hop is priced at the segment average and nothing else. See
          // WHAT A DWELL STATISTIC ACTUALLY MEASURES above for why the hop is
          // NOT split into a rest plus a drive, and what happened when it was.
        } else {
          // Unmeasured hop. The route-average segment time is a fair guess
          // for a typical block-to-block hop, but never for a long one:
          // Purple's Building 900 → LEPH leg (6.7 km, n:0 after a quiet
          // week) was priced at the 2.9 min route average and the board
          // promised a 19-min ride in 3. Take whichever is longer — the
          // straight-line distance at bus speed is a floor the bus cannot
          // beat, and the planner already prices the same case that way.
          const pc = stopCoords[stops[prevI]], cc = stopCoords[stops[curI]];
          const byDistance = pc && cc
            ? Math.max(MIN_HOP_SEC, haversineMeters(pc, cc) / BUS_SPEED_M_S)
            : 0;
          if (avgSeg > 0 && avgSeg >= byDistance) {
            segAvg = avgSeg;
            segVar = fallbackSd * fallbackSd;
          } else {
            segAvg = byDistance || 90;
            segVar = (segAvg * 0.5) ** 2;
          }
        }
        // Burn stall credit on the first segment only, bounded by the
        // calibrated dwell for this stop.
        //
        // ⚠️ THIS BOUND IS EMPIRICAL, NOT PRINCIPLED. It reads as "a bus that
        // has been sitting can cancel the DWELL part of the hop but still has
        // to drive" — and that is the false premise corrected above: `med` is
        // an estimate of the WHOLE hop, not of a dwell inside it. What the
        // bound actually leaves behind is the gap between two estimators of
        // the same quantity (a 30-day shrunk mean minus a 14-day windowed
        // median), which on a right-skewed layover is substantial and happens
        // to be about the right size. On the Red case below that gap is
        // 557 - 475 = 82 s, which is close to the true drive — by luck of the
        // skew, not by construction.
        //
        // It is left exactly as it is because it is the best-MEASURED of the
        // options and a recorded pass of that Red layover gates it
        // (`npm run test:accuracy`). Do NOT re-derive it from the old story,
        // and do not change it without a replay: the alternatives below were
        // all measured worse.
        //
        // Both wrong answers have shipped. Crediting every elapsed second
        // (until 2026-09-02) drove the hop to zero and promised a bus that was
        // still minutes of driving away: replaying 69k positions, the
        // next-stop error for a dwelling bus reached -203 s past 5 min of
        // dwell. Capping at half the hop (2026-09-02 to 09-03) fixed that
        // average and broke the layover, which is the dangerous direction: on
        // Red, #316 had sat 10 min of its ~8 min layover at 344 Winchester,
        // 82 s of driving from Winchester/Division, and the board told a rider
        // 3 stops later "5 min" — half of the 557 s segment is 279 s of pure
        // padding — so the bus left, arrived ~2.5 min later, and the rider who
        // trusted the 5 was too late. The dwell bound gives 557 - 475 = 82 s,
        // which is the answer — for the reason in the warning above, not the
        // reason originally written here.
        // First hop only — see the note above STALL_CREDIT_MAX_FRACTION for
        // why carrying it to the adjacent stop was tried and measured wrong.
        // A served stand/drive split prices the first hop directly — the
        // standing time conditioned on how long the bus has stood, plus the
        // drive; en route, the DRIVE alone prorated. Neither the credit nor
        // the chord proration below then runs, because both act on the whole
        // arrival-to-arrival segment and re-bill the layover as the bus leaves
        // (docs/eta-estimator-design.md, "the departure cliff").
        // Both halves must be adequately sampled for THIS hop, independently
        // of every other hop; a thin cell prices exactly as master does.
        const standStat = routeDwells[String(stops[busIdx])];
        const split = step === 1 && driveAdequate(seg) && standAdequate(standStat)
          ? { drive: Math.max(seg.drive, driveFloorSec(stopCoords[stops[prevI]], stopCoords[stops[curI]])), stand: standStat.q }
          : null;
        if (split) {
          const t = 1 - hypothesis.firstSegProgressFactor;
          segAvg = priceFirstHop(
            { q: split.stand },
            split.drive,
            hypothesis.standingSec,
            t,
          );
          segVar = Math.min(segVar, segAvg * segAvg);
          hypothesisStallCredit = 0;
        }
        if (step === 1 && hypothesisStallCredit > 0) {
          const dwell = routeDwells[String(stops[busIdx])];
          const cancellable = dwell && dwell.med > 0
            ? dwell.med
            : segAvg * STALL_CREDIT_MAX_FRACTION;
          // ...and never past the driving the hop still contains. Before this
          // floor the bound above could take the hop to exactly zero — see
          // driveFloorSec. Report #80 is NOT that case and is unchanged by it:
          // 344 Winchester -> Winchester/Division is 112 m, so the floor is
          // 30 s against the 98.9 s the hop is already billed.
          const room = Math.max(
            0,
            segAvg - driveFloorSec(stopCoords[stops[prevI]], stopCoords[stops[curI]]),
          );
          const applied = Math.min(hypothesisStallCredit, cancellable, room);
          segAvg -= applied;
          hypothesisStallCredit -= applied;
        }
        // Mid-segment proration on the first segment: scale down by the
        // fraction of the A→B distance still ahead of the bus. Scale
        // variance by fraction² so "almost there" also means "less
        // uncertainty about when."
        if (step === 1 && !split && hypothesis.firstSegProgressFactor < 1) {
          segAvg *= hypothesis.firstSegProgressFactor;
          segVar *= hypothesis.firstSegProgressFactor * hypothesis.firstSegProgressFactor;
        }
        cumulative += segAvg;
        cumulativeVar += segVar;
        if (cumulative > MAX_ETA_SEC) break;
        const sid = stops[curI];
        const recorded = recordedForStop.get(sid) ?? 0;
        if (targetSet.has(sid) && recorded < 2 && cumulative >= 0) {
          recordedForStop.set(sid, recorded + 1);
          const key = `${sid}|${recorded}`;
          const values = estimates.get(key) ?? [];
          values.push({
            eta: cumulative,
            variance: cumulativeVar,
            weight: hypothesis.weight,
            stopId: sid,
            occurrence: recorded,
            branchId: hypothesis.branchId,
          });
          estimates.set(key, values);
        }
      }
      }

      for (const values of estimates.values()) {
        const weight = values.reduce((sum, value) => sum + value.weight, 0);
        if (!(weight > 0)) continue;
        // Modes on one geometric branch differ only by stop/run dynamics and
        // are averaged continuously. Taking a component median made the point
        // ETA jump whenever P(standing) crossed 0.5. Across geometric branches
        // use the posterior median so no impossible halfway-around-the-loop
        // ETA is invented.
        const byBranch = new Map<number, typeof values>();
        for (const value of values) {
          const group = byBranch.get(value.branchId) ?? [];
          group.push(value);
          byBranch.set(value.branchId, group);
        }
        const branchValues = [...byBranch.values()].map((group) => {
          const branchWeight = group.reduce((sum, value) => sum + value.weight, 0);
          const branchEta = group.reduce(
            (sum, value) => sum + value.weight * value.eta,
            0,
          ) / branchWeight;
          const branchVariance = group.reduce(
            (sum, value) => sum + value.weight * (
              value.variance + (value.eta - branchEta) ** 2
            ),
            0,
          ) / branchWeight;
          return {
            eta: branchEta,
            variance: branchVariance,
            weight: branchWeight,
          };
        });
        const eta = weightedMedian(branchValues);
        const mean = values.reduce(
          (sum, value) => sum + value.weight * value.eta,
          0,
        ) / weight;
        const variance = values.reduce(
          (sum, value) => sum + value.weight * (
            value.variance + (value.eta - mean) ** 2
          ),
          0,
        ) / weight;
        const sd = Math.sqrt(Math.max(0, variance));
        result.push({
          eta,
          low: Math.max(0, mean - sd),
          high: mean + sd,
          routeLabel: cfg.label,
          color: cfg.color,
          busName: bus.bus_name.replace("#", ""),
          stopId: values[0]!.stopId,
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
