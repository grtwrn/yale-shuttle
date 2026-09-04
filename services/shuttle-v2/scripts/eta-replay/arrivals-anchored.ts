/**
 * `computeUpcomingArrivals` with the anchor (and optionally the within-leg
 * progress and the standing mode) SUPPLIED rather than re-derived.
 *
 * WHY A COPY. The shipped function derives the anchor itself (`findRouteAnchor`
 * gated by `anchorGate.ts`), so the only way a caller can influence it is by
 * moving the bus's coordinate -- and on a route that folds back on itself two
 * different route positions ARE the same coordinate, so the channel is lossy
 * exactly where it matters (`anchor-plumbing.ts`: a believed leg survives the
 * round trip 60.5% of the time).
 *
 * DRIFT GUARD. With `override` null and the same `anchorStore` this must be
 * byte-identical to the shipped function; `belief-scoreboard.ts` asserts that
 * on every poll and dies if it ever differs (the `dwell-replica-check.ts`
 * pattern, PR #53). Re-derived from `web/src/arrivals.ts` at origin/master
 * 972c5ba (PR #72 gate, PR #73 drive floor).
 *
 * `diag`, when supplied, receives per-bus internals (anchor, credit applied,
 * proration factor) so a jump can be attributed to what THIS estimator did,
 * not only to what the feed did. It never changes the output.
 */
import { findRouteAnchor, isBusOnRoute } from "../../web/src/anchor";
import { gateAnchor, type AnchorStore } from "../../web/src/anchorGate";
import { driveAdequate, priceFirstHop, standAdequate, standingAt, STANDING_HOLD_M } from "../../web/src/hopPricing";
import { haversineMeters, progressAlongSegment } from "../../web/src/geo";
import type { LatLon } from "../../web/src/geo";
import type { BusData } from "../../web/src/map-data";
import { BUS_SPEED_M_S, mergedRouteStops, ROUTE_LISTS } from "../../web/src/routes";
import {
  MAX_PLAUSIBLE_M_S,
  MIN_HOP_SEC,
  STALL_CREDIT_MAX_FRACTION,
  type DwellTimes,
  type SegmentTimes,
  type UpcomingArrival,
} from "../../web/src/arrivals";

export interface AnchorBelief {
  /** Index into the route's merged stop list. */
  anchor: number;
  /** Fraction of the CURRENT leg already travelled, 0..1, or null to use the chord. */
  legProgress?: number | null;
  /** Standing at `stops[anchor]` since this epoch ms, or null for "not standing". Undefined = use the feed's at_stop. */
  standingSince?: number | null;
}

export type OverrideFn = (
  bus: BusData,
  routeLabel: string,
  stops: number[],
) => AnchorBelief | null;

/** What the estimator did for one bus on one poll. */
export interface BusDiag {
  anchor: number;
  /** Seconds of stall credit actually cancelled off the first hop. */
  credit: number;
  /** Chord/leg proration factor applied to the first hop (1 = none). */
  factor: number;
  /** Served average of the first hop before any adjustment. */
  firstSeg: number;
  standing: boolean;
  atStopId: number | null;
}

function driveFloorSec(a: LatLon | undefined, b: LatLon | undefined): number {
  if (!a || !b) return 0;
  return Math.max(MIN_HOP_SEC, haversineMeters(a, b) / MAX_PLAUSIBLE_M_S);
}

export function computeUpcomingArrivalsAnchored(
  targetStopIds: number[],
  buses: BusData[],
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  segmentTimes: SegmentTimes,
  now: number,
  dwellTimes: DwellTimes,
  override: OverrideFn | null,
  anchorStore?: AnchorStore,
  diag?: Map<string, BusDiag>,
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
    // The stand/drive pricing (hopPricing.ts) and its standing memory engage
    // only on a route the calibrator serves the split for; otherwise nothing
    // below this line behaves differently from before it existed.
    const splitServed = Object.values(routeSegs).some(driveAdequate)
      && Object.values(routeDwells).some(standAdequate);

    for (const bus of routeBuses) {
      const belief = override ? override(bus, cfg.label, stops) : null;
      let gpsAnchorIdx: number;
      if (belief) gpsAnchorIdx = belief.anchor;
      else {
        const rawAnchorIdx = findRouteAnchor(bus, stops, stopCoords);
        if (rawAnchorIdx < 0) continue;
        gpsAnchorIdx = anchorStore
          ? gateAnchor(anchorStore, `${cfg.label}|${bus.bus_name}`, rawAnchorIdx, bus, now, stops.length).index
          : rawAnchorIdx;
      }
      if (gpsAnchorIdx < 0) continue;

      let stallCredit = 0;
      if (belief && belief.standingSince !== undefined) {
        if (belief.standingSince !== null) {
          stallCredit = Math.max(0, (now - belief.standingSince) / 1000);
        }
      } else if (bus.at_stop_id && bus.at_stop_since) {
        const atIdx = stops.indexOf(bus.at_stop_id);
        if (atIdx >= 0 && atIdx === gpsAnchorIdx) {
          stallCredit = Math.max(
            0,
            (now - new Date(bus.at_stop_since + "Z").getTime()) / 1000,
          );
        }
      }
      const standing = stallCredit > 0;

      // "Standing" for the split pricing is NOT "at_stop_id is set this poll".
      // The flag is a PUBLICATION signal with a 75 m radius; a parked bus that
      // shuffles to 85 m loses it for one poll while plainly still standing,
      // and pricing that poll as en route collapses the countdown to the
      // drive and brings it back ("in 8 -> in 1 -> in 6"). The stop-pinned
      // clock survives that shuffle (PR #67); so does this memory of it.
      let standingSec: number | null = stallCredit > 0 ? stallCredit : null;
      if (anchorStore && splitServed) {
        const st = standingAt(anchorStore, `${cfg.label}|${bus.bus_name}`, bus, now, stopCoords, STANDING_HOLD_M);
        if (st) {
          const N = stops.length;
          for (let i = 0; i < N; i++) {
            if (stops[i] !== st.stopId) continue;
            const d = ((i - gpsAnchorIdx) % N + N) % N;
            if (d <= 1 || d === N - 1) { gpsAnchorIdx = i; standingSec = st.standingSec; break; }
          }
        }
      }
      const busIdx = gpsAnchorIdx;
      let firstSegProgressFactor = 1;
      if (belief && belief.legProgress != null) {
        if (stallCredit === 0) {
          firstSegProgressFactor = Math.max(0, Math.min(1, 1 - belief.legProgress));
        }
      } else if (stallCredit === 0 && bus.lat && bus.lon) {
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
      const recordedForStop = new Map<number, number>();
      const MAX_ETA_SEC = 90 * 60;
      let creditApplied = 0;
      let firstSegAvg = 0;
      for (let step = 1; step <= totalStops * 2; step++) {
        const prevI = (busIdx + step - 1) % totalStops;
        const curI = (busIdx + step) % totalStops;
        const seg = routeSegs[`${stops[prevI]}-${stops[curI]}`];
        let segAvg: number;
        let segVar: number;
        if (seg && seg.n >= 1) {
          segAvg = seg.avg;
          segVar = (seg.sd ?? 0) ** 2;
        } else {
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
        if (step === 1) firstSegAvg = segAvg;
        // Both halves must be adequately sampled for THIS hop, independently
        // of every other hop; a thin cell prices exactly as master does.
        const standStat = routeDwells[String(stops[busIdx])];
        const split = step === 1 && driveAdequate(seg) && standAdequate(standStat)
          ? { drive: Math.max(seg.drive, driveFloorSec(stopCoords[stops[prevI]], stopCoords[stops[curI]])), stand: standStat.q }
          : null;
        if (split) {
          const t = bus.lat && bus.lon
            ? (() => { const a = stopCoords[stops[busIdx]], b = stopCoords[stops[curI]]; return a && b ? progressAlongSegment({ lat: bus.lat, lon: bus.lon }, a, b) : 0; })()
            : 0;
          segAvg = priceFirstHop({ q: split.stand }, split.drive, standingSec, t);
          segVar = Math.min(segVar, segAvg * segAvg);
          stallCredit = 0;
          firstSegProgressFactor = 1;
        }
        if (step === 1 && stallCredit > 0) {
          const dwell = routeDwells[String(stops[busIdx])];
          const cancellable = dwell && dwell.med > 0
            ? dwell.med
            : segAvg * STALL_CREDIT_MAX_FRACTION;
          const room = Math.max(
            0,
            segAvg - driveFloorSec(stopCoords[stops[prevI]], stopCoords[stops[curI]]),
          );
          const applied = Math.min(stallCredit, cancellable, room);
          segAvg -= applied;
          stallCredit -= applied;
          creditApplied = applied;
        }
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
      if (diag) diag.set(bus.bus_name.replace("#", ""), {
        anchor: busIdx, credit: creditApplied, factor: firstSegProgressFactor, firstSeg: firstSegAvg,
        standing, atStopId: bus.at_stop_id ?? null,
      });
    }
  }
  result.sort((a, b) => a.eta - b.eta);
  return result;
}
