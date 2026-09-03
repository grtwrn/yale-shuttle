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

/** Floor on a hop's driving time, whatever the dwell arithmetic says. */
const MIN_HOP_SEC = 30;

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
 * `BusState.stationarySince`.
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
          // For a stop the bus has NOT REACHED YET, price that dwell at a low
          // quantile rather than the median.
          //
          // A rest is a wide distribution, not a number: at Red's 344
          // Winchester the deciles run 3.1 / 5.5 / 8.3 / 10.7 / 12.6 minutes
          // and one visit in seventeen is under two. Billing the middle of it
          // made the board pessimistic by over two minutes on a third to a
          // half of the estimates that span a rest — and pessimistic is the
          // costly direction, because the rider strolls down and the bus has
          // gone. Measured on 30 days of arrivals over Red, Blue Day, Orange
          // Day and Green (31k chains that contain an unstarted rest), p35
          // moves the median error from +0.8..+2.0 min to about zero and the
          // share more than 2 min pessimistic from 36-50% to 17-32%. p25
          // overshoots into optimism (-1.8..-2.7 min). docs/eta-accuracy.md
          // has the table.
          //
          // Step 1 is exempt: the bus is AT that stop, so its dwell belongs to
          // the elapsed-dwell credit below, which knows how long it has really
          // sat. This only re-prices rests still in the future. Conditioning
          // it on whether the bus ALREADY rested somewhere was tried and
          // measured wrong — see the note above STALL_CREDIT_MAX_FRACTION.
          if (step > 1) {
            const d = routeDwells[String(stops[prevI])];
            if (d && d.low !== undefined && d.low < d.med) {
              // Keep a floor on the drive so a hop that is almost all dwell
              // still prices the driving.
              segAvg = Math.max(MIN_HOP_SEC, segAvg - d.med) + d.low;
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
        // First hop only — see the note above STALL_CREDIT_MAX_FRACTION for
        // why carrying it to the adjacent stop was tried and measured wrong.
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
