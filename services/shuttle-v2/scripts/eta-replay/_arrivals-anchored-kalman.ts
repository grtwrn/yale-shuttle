/**
 * COPY of the kalman worktree's uncommitted `arrivals-anchored.ts` (another agent's work,
 * 2026-09-03), vendored here unchanged so `jitter-audit.ts ARM=belief` can score
 * that arm. Not shipped code.
 */
/**
 * `computeUpcomingArrivals` with the anchor (and optionally the within-leg
 * progress and the standing mode) SUPPLIED rather than re-derived.
 *
 * WHY A COPY. The shipped function calls `findRouteAnchor` itself, so the only
 * way a caller can influence the anchor is by moving the bus's coordinate --
 * and on a route that folds back on itself two different route positions ARE
 * the same coordinate, so the channel is provably lossy exactly where it
 * matters. `anchor-plumbing.ts` measures the loss: a believed leg survives the
 * round trip 60.5% of the time.
 *
 * DRIFT GUARD. With `override` returning null this must be byte-identical to
 * the shipped function. `belief-scoreboard.ts` asserts that on every poll it
 * scores and dies if it ever differs, which is the `dwell-replica-check.ts`
 * pattern (PR #53): a stale replica once mismatched 95,305 of 350,301 pairs
 * and nobody noticed.
 *
 * `diag`, when supplied, receives per-bus internals (anchor, credit applied,
 * proration factor) so a jump can be attributed to what THIS estimator did,
 * not only to what the feed did. It never changes the output.
 */
import { findRouteAnchor, isBusOnRoute } from "../../web/src/anchor";
import { haversineMeters, progressAlongSegment } from "../../web/src/geo";
import type { LatLon } from "../../web/src/geo";
import type { BusData } from "../../web/src/map-data";
import { BUS_SPEED_M_S, mergedRouteStops, ROUTE_LISTS } from "../../web/src/routes";
import {
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

export function computeUpcomingArrivalsAnchored(
  targetStopIds: number[],
  buses: BusData[],
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  segmentTimes: SegmentTimes,
  now: number,
  dwellTimes: DwellTimes,
  override: OverrideFn | null,
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

    for (const bus of routeBuses) {
      const belief = override ? override(bus, cfg.label, stops) : null;
      const gpsAnchorIdx = belief ? belief.anchor : findRouteAnchor(bus, stops, stopCoords);
      if (gpsAnchorIdx < 0) continue;

      const busIdx = gpsAnchorIdx;
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
        if (step === 1) firstSegAvg = segAvg;
        if (step === 1 && stallCredit > 0) {
          const dwell = routeDwells[String(stops[busIdx])];
          const cancellable = dwell && dwell.med > 0
            ? dwell.med
            : segAvg * STALL_CREDIT_MAX_FRACTION;
          const applied = Math.min(stallCredit, cancellable, segAvg);
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
