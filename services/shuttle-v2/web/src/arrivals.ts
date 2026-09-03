// Bus → stop ETA computation. Extracted from TransitMap.tsx unchanged.

import { findRouteAnchor, isBusOnRoute } from "./anchor";
import { haversineMeters, progressAlongSegment } from "./geo";
import type { LatLon } from "./geo";
import type { BusData } from "./map-data";
import { BUS_SPEED_M_S, mergedRouteStops, ROUTE_LISTS } from "./routes";

export type SegmentStat = { avg: number; sd?: number; n: number };
export type SegmentTimes = Record<string, Record<string, SegmentStat>>;
export type DwellStat = { med: number; sd: number; n: number; low?: number };
export type DwellTimes = Record<string, Record<string, DwellStat>>;
export type DwellsByBus = Record<string, DwellTimes>;

/**
 * How much of the first hop's calibrated time an elapsed dwell may cancel when
 * we have no dwell statistic for the stop. See the stall-credit comment in
 * computeUpcomingArrivals: with dwell data the bound is the dwell itself,
 * which is the quantity actually baked into the segment, and this fraction is
 * only the fallback for a stop the calibrator has never measured.
 */
export const STALL_CREDIT_MAX_FRACTION = 0.5;

/** Floor on any hop's driving time, shared with the unmeasured-hop fallback. */
const MIN_HOP_SEC = 30;

/** A dwell this long is a REST — the driver's layover, taken once a lap. */
const REST_SEC = 5 * 60;

/**
 * What an upcoming rest is worth once the bus has already taken one.
 *
 * A lap holds one rest and the timetable does not say where. On Red it lands
 * at Canal/Munson or at 344 Winchester: over 597 laps in 30 days Canal/Munson
 * held the bus 5 min or more on 2% of them, 344 Winchester on most of the
 * rest, and BOTH on 0.0%. The two dwells correlate at -0.27 — one or the
 * other. A board that bills the median at both is billing a rest that will
 * not happen, which is how a rider was told 9 min for a bus about 4 min away
 * while it sat out its layover at the FIRST of the two (operator screenshot,
 * 2026-09-03).
 *
 * 165 s is the measured conditional median: when the bus had rested at
 * Canal/Munson its 344 Winchester dwell ran 2.7 min, against 8.6 min when it
 * had not.
 */
const RESTED_DWELL_SEC = 165;

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

    const routeSegs = segmentTimes[cfg.routeIds[0]] ?? {};
    const routeDwells = dwellTimes[cfg.routeIds[0]] ?? {};
    const segValues = Object.values(routeSegs).filter((s) => s.n >= 2);
    const avgSeg = segValues.length > 0
      ? segValues.reduce((sum, s) => sum + s.avg, 0) / segValues.length
      : 0;
    const fallbackSd = avgSeg * 0.5;

    for (const bus of routeBuses) {
      // Anchor = segment start. GPS is the ground-truth signal;
      // last_stop_id only breaks ties on routes that revisit a
      // vicinity (e.g., Red passes 130 Prospect on both inbound
      // and outbound legs). This replaces the older "trust feed,
      // advance one stop at a time" pattern which stalled when
      // last_stop_id was multi-stops-stale and the bus had drifted
      // off-axis from subsequent segment lines.
      const gpsAnchorIdx = findRouteAnchor(bus, stops, stopCoords);
      if (gpsAnchorIdx < 0) continue;

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
      const busIdx = gpsAnchorIdx;
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

      // Has this bus already taken its rest? Sitting at its anchor stop well
      // past a normal stop IS the lap's rest, and a big dwell still ahead of
      // it will not happen — see RESTED_DWELL_SEC.
      const restTaken = stallCredit >= REST_SEC;

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
      let firstSegProgressFactor = 1;
      if (stallCredit === 0 && bus.lat && bus.lon) {
        const a = stopCoords[stops[busIdx]];
        const b = stopCoords[stops[(busIdx + 1) % stops.length]];
        if (a && b) {
          const t = progressAlongSegment({ lat: bus.lat, lon: bus.lon }, a, b);
          firstSegProgressFactor = Math.max(0, Math.min(1, 1 - t));
        }
      }

      let cumulative = 0;
      let cumulativeVar = 0;
      const totalStops = stops.length;
      // Walk the loop TWICE so each stop can get two arrivals per bus: the
      // upcoming one and the same vehicle a full lap later. On single-bus
      // routes (Blue Weekend most weekends) that second-lap entry is the only
      // way to answer "and the one after that?" (report #29), and it turns
      // "departed" into an honest wait-for-it-to-come-around when the rider
      // can't catch the current pass (report #30). It also covers the bus's
      // own anchor stop (reachable only at step ≥ totalStops), so a bus
      // dwelling AT a stop still yields an ETA for that stop.
      const recordedForStop = new Map<number, number>();
      const MAX_ETA_SEC = 90 * 60; // sanity cap — beyond this the lap-2 guess is noise
      for (let step = 1; step <= totalStops * 2; step++) {
        const prevI = (busIdx + step - 1) % totalStops;
        const curI = (busIdx + step) % totalStops;
        const seg = routeSegs[`${stops[prevI]}-${stops[curI]}`];
        let segAvg: number;
        let segVar: number;
        if (seg && seg.n >= 1) {
          segAvg = seg.avg;
          segVar = (seg.sd ?? 0) ** 2;
          // A hop's served time is the dwell at its from-stop plus the drive.
          // For a stop the bus has NOT REACHED YET, re-price that dwell at a
          // low quantile instead of the median: a layover is a wide
          // distribution (Red's 344 Winchester runs 3.1 min at the tenth
          // percentile to 12.6 at the ninetieth, and one visit in seventeen is
          // under two minutes), and billing the middle of it made the board
          // pessimistic by more than two minutes on a third to a half of the
          // readings that span a layover. Pessimistic is the costly direction:
          // the rider walks down and the bus has gone. Measured over 30 days
          // on Red, Blue Day, Orange Day and Green, this moves the median
          // error on such estimates from +0.8..+2.0 min to about zero and the
          // >2-min-pessimistic share from 36-50% to 17-32% (p25 overshoots
          // into optimism; see docs/eta-accuracy.md).
          //
          // Step 1 is exempt: the bus is AT that stop, so its dwell is handled
          // by the elapsed-dwell credit below, which knows how long it has
          // actually sat. This only re-prices rests still in the future.
          if (step > 1) {
            const d = routeDwells[String(stops[prevI])];
            if (d && d.med > 0) {
              // Keep a floor on the drive so a hop whose average is almost all
              // dwell still prices the driving.
              const drive = Math.max(MIN_HOP_SEC, segAvg - d.med);
              // A rest already taken elsewhere will not be taken again here.
              const rest = restTaken && d.med > REST_SEC
                ? Math.min(d.low ?? d.med, RESTED_DWELL_SEC)
                : d.low;
              if (rest !== undefined && rest < d.med) segAvg = drive + rest;
            }
          }
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
            ? Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S)
            : 0;
          if (avgSeg > 0 && avgSeg >= byDistance) {
            segAvg = avgSeg;
            segVar = fallbackSd * fallbackSd;
          } else {
            segAvg = byDistance || 90;
            segVar = (segAvg * 0.5) ** 2;
          }
        }
        // Burn stall credit on the first segment only, and never more than the
        // waiting that segment actually contains.
        //
        // A segment sample runs arrival to arrival, so seg.avg = the dwell at
        // this stop + the drive to the next one. What a bus that has already
        // been sitting here can cancel is the DWELL part, and nothing more —
        // it still has to drive. So the bound is the calibrated dwell for this
        // stop, and the fraction below is only the fallback for a stop the
        // calibrator has never measured.
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
        // which is the drive, which is the answer.
        if (step === 1 && stallCredit > 0) {
          const dwell = dwellTimes[cfg.routeIds[0]]?.[String(stops[busIdx])];
          const cancellable = dwell && dwell.med > 0
            ? dwell.med
            : segAvg * STALL_CREDIT_MAX_FRACTION;
          const applied = Math.min(stallCredit, cancellable, segAvg);
          segAvg -= applied;
          stallCredit -= applied;
        }
        // Mid-segment proration on the first segment: scale down by the
        // fraction of the A→B distance still ahead of the bus. Scale
        // variance by fraction² so "almost there" also means "less
        // uncertainty about when."
        if (step === 1 && firstSegProgressFactor < 1) {
          segAvg *= firstSegProgressFactor;
          segVar *= firstSegProgressFactor * firstSegProgressFactor;
        }
        cumulative += segAvg;
        cumulativeVar += segVar;
        if (cumulative > MAX_ETA_SEC) break;
        const sid = stops[curI];
        const recorded = recordedForStop.get(sid) ?? 0;
        if (targetSet.has(sid) && recorded < 2 && cumulative >= 0) {
          recordedForStop.set(sid, recorded + 1);
          const sd = Math.sqrt(cumulativeVar);
          result.push({
            eta: cumulative,
            low: Math.max(0, cumulative - sd),
            high: cumulative + sd,
            routeLabel: cfg.label,
            color: cfg.color,
            busName: bus.bus_name.replace("#", ""),
            stopId: sid,
          });
        }
      }
    }
  }
  result.sort((a, b) => a.eta - b.eta);
  return result;
}
