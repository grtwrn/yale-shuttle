import { distanceMeters } from "../network/geo.js";
import type { TransitNetwork } from "../network/TransitNetwork.js";
import { WALK_M_PER_S } from "../network/TransitNetwork.js";
import type {
  BusPosition,
  EpochMs,
  LatLon,
  Plan,
  PlanLeg,
  PlanResponse,
} from "../schema/api.js";

import { etaAlongRoute } from "./eta.js";
import { expectedWait } from "./wait.js";

// Tuning ---------------------------------------------------------------------

/**
 * Maximum walk leg (origin → board stop, or alight stop → destination).
 * 1500 m ≈ 18 min walk. Higher than the strict "walking distance" cutoff so
 * destination-niche routes (e.g. Grocery TJ from Prospect → Peabody, ~1257 m)
 * remain in scope. The walkDoesntDominate check below stops the higher
 * ceiling from suggesting silly detours.
 */
const MAX_WALK_M = 1500;

/** 1.645 σ ≈ one-sided 90% CI bound on the normal. */
const Z_90 = 1.645;

/**
 * Drop the standalone walk-only option once the direct walk exceeds an hour.
 * Nobody plans a 60+ min walk across New Haven — leaving it in clutters the
 * picker when the only viable option is a bus.
 */
const WALK_ONLY_MAX_SEC = 3600;

/**
 * Cap on candidate plans returned from `planTrip` (plus the walk option).
 * Three is enough to surface trade-offs (fast vs few-walk vs route preference)
 * without overwhelming the picker.
 */
const MAX_PLANS = 3;

// Implementation -------------------------------------------------------------

export interface PlanInputs {
  network: TransitNetwork;
  buses: readonly BusPosition[];
  from: LatLon;
  to: LatLon;
  now: EpochMs;
}

/**
 * Build ranked trip options from `from` to `to`. Considers, in this order:
 *
 *  1. Direct walk — always an option, dropped only if very long.
 *  2. Single-route plans: pick an origin stop near `from`, a board stop on
 *     a shared route, an alight stop on the same route also near `to`.
 *     Wait time is derived from live buses on that route via
 *     {@link expectedWait}; ride time from {@link etaAlongRoute}.
 *
 * For this network (~170 stops, ~15 routes) the candidate set stays tiny — the
 * MAX_WALK_M radius admits only a handful of board × alight × route
 * combinations regardless of network size. We sort by total seconds
 * (the rider's actual cost) and dedupe; transfers are intentionally out of
 * scope for v1, because empirically they're almost never worth the wait.
 *
 * Returns the ranked plans plus a list of routes that *could* take you
 * between origin and destination but aren't currently running, which the UI
 * uses to explain "this route goes there, next active Sat 10 AM" instead of
 * dead-ending at Walk.
 */
export function planTrip(inputs: PlanInputs): PlanResponse {
  const { network, from, to, now, buses } = inputs;

  const originStops = network.stopsNear(from, MAX_WALK_M);
  const destStops = network.stopsNear(to, MAX_WALK_M);
  const directWalkSec = distanceMeters(from, to) / WALK_M_PER_S;

  const destStopIds = new Set(destStops.map((d) => d.toStopId));
  const destWalkSecById = new Map(
    destStops.map((d) => [d.toStopId, d.seconds] as const),
  );

  const candidates: Plan[] = [];

  // For each origin stop within walking distance of `from`, iterate routes
  // serving that stop and try each route's downstream stops as alight points.
  for (const origin of originStops) {
    const edgesFromOrigin = network.segmentEdges.get(origin.toStopId);
    if (!edgesFromOrigin) continue;
    const routesAtOrigin = new Set(edgesFromOrigin.map((e) => e.routeId));

    for (const routeId of routesAtOrigin) {
      const route = network.routes.get(routeId);
      if (!route) continue;

      const wait = expectedWait(network, buses, routeId, origin.toStopId, now);
      // No live bus on this route — record the candidate for the "potential
      // routes" rollup but don't fabricate a plan.
      if (!wait) continue;

      // Walk forward along the route from the origin and try each subsequent
      // stop as a candidate alight. Stop at the loop wrap (we don't want
      // "ride a full loop back to a stop one before origin" as a suggestion).
      const idx = network.positionOnRoute(routeId, origin.toStopId);
      if (idx === null) continue;

      for (let offset = 1; offset < route.stops.length; offset++) {
        const alightStopId = route.stops[(idx + offset) % route.stops.length]!;
        if (!destStopIds.has(alightStopId)) continue;

        const eta = etaAlongRoute(network, routeId, origin.toStopId, alightStopId);
        if (!eta) continue;

        const walkFromSec = destWalkSecById.get(alightStopId) ?? 0;
        const totalSec = origin.seconds + wait.meanSec + eta.meanSec + walkFromSec;

        // Sanity: skip plans where the walk dominates the ride — the
        // raised MAX_WALK_M ceiling would otherwise produce "walk 14 min,
        // wait 2, ride 1, walk 10" against a 19-min direct walk.
        if (origin.seconds + walkFromSec >= directWalkSec) continue;

        // Variance: independent walk/wait/ride components compose additively.
        // Walking has no variance (or tiny — ignore).
        const variance = wait.stddevSec ** 2 + eta.stddevSec ** 2;
        const stddev = Math.sqrt(variance);
        const halfWidth = Z_90 * stddev;

        const legs: PlanLeg[] = [];
        if (origin.seconds > 0) {
          legs.push({
            mode: "walk",
            fromStopId: null,
            toStopId: origin.toStopId,
            meters: origin.meters,
            seconds: origin.seconds,
          });
        }
        legs.push({
          mode: "ride",
          routeId,
          boardStopId: origin.toStopId,
          alightStopId,
          busName: wait.busName,
          waitSec: wait.meanSec,
          rideSec: eta.meanSec,
          confidenceLowSec: Math.max(0, wait.meanSec + eta.meanSec - halfWidth),
          confidenceHighSec: wait.meanSec + eta.meanSec + halfWidth,
        });
        if (walkFromSec > 0) {
          const destDist = destStops.find((d) => d.toStopId === alightStopId);
          legs.push({
            mode: "walk",
            fromStopId: alightStopId,
            toStopId: null,
            meters: destDist?.meters ?? 0,
            seconds: walkFromSec,
          });
        }

        candidates.push({
          totalSec,
          confidenceLowSec: Math.max(0, totalSec - halfWidth),
          confidenceHighSec: totalSec + halfWidth,
          legs,
          badge: null, // assigned after dedupe + sort
        });
      }
    }
  }

  // Dedupe by (boardStopId, alightStopId, routeId) — multiple buses on the
  // same route would otherwise produce duplicate plans differing only in
  // `busName`. Keep the one with the smallest total time.
  const dedup = new Map<string, Plan>();
  for (const c of candidates) {
    const ride = c.legs.find((l) => l.mode === "ride");
    if (!ride || ride.mode !== "ride") continue;
    const key = `${ride.routeId}:${ride.boardStopId}:${ride.alightStopId}`;
    const existing = dedup.get(key);
    if (!existing || c.totalSec < existing.totalSec) dedup.set(key, c);
  }

  const sorted = [...dedup.values()].sort((a, b) => a.totalSec - b.totalSec);
  const top = sorted.slice(0, MAX_PLANS);

  const walkOnly: Plan | null =
    directWalkSec <= WALK_ONLY_MAX_SEC
      ? {
          totalSec: directWalkSec,
          confidenceLowSec: directWalkSec,
          confidenceHighSec: directWalkSec,
          legs: [
            {
              mode: "walk",
              fromStopId: null,
              toStopId: null,
              meters: distanceMeters(from, to),
              seconds: directWalkSec,
            },
          ],
          badge: null,
        }
      : null;

  const plans: Plan[] = walkOnly ? [...top, walkOnly] : [...top];
  plans.sort((a, b) => a.totalSec - b.totalSec);

  // Badges: fastest is always whichever first beats the rest by total time.
  // walk-only gets its own badge when it wins (worth flagging — riders often
  // overlook how short a walk is). Other badges (fewest-transfers, etc.) are
  // single-leg-only territory for now and not assigned.
  if (plans[0]) {
    const onlyWalk = plans[0].legs.every((l) => l.mode === "walk");
    plans[0] = { ...plans[0], badge: onlyWalk ? "walk-only" : "fastest" };
  }

  // Only surface routes that geographically connect from → to *and* have no
  // live bus right now. Routes that produced an actual plan are already in
  // `plans`; routes the rider could ride if the system were running are the
  // ones worth flagging. Pick the best (shortest walk + closest alight) tuple
  // per route to keep the list short.
  const liveRouteIds = new Set(inputs.buses.map((b) => b.routeId));
  return {
    plans,
    potentialRoutes: collectPotentialRoutes(network, originStops, destStops, liveRouteIds),
  };
}

/**
 * Routes that geographically connect from → to but currently have no live
 * bus. The UI uses this to explain "the Grocery TJ route goes there, but
 * it's Sa/Su only, next active Sat 10:00 AM" rather than dead-ending at Walk.
 *
 * `nextActiveAt` is null in v2 — operating-hours metadata isn't in the
 * upstream feed and we don't have a schedule table yet. Returning the route
 * id is still useful so the UI can show the badge.
 */
function collectPotentialRoutes(
  network: TransitNetwork,
  originStops: ReturnType<TransitNetwork["stopsNear"]>,
  destStops: ReturnType<TransitNetwork["stopsNear"]>,
  liveRouteIds: ReadonlySet<number>,
): PlanResponse["potentialRoutes"] {
  const destWalkSecById = new Map(
    destStops.map((d) => [d.toStopId, d.seconds] as const),
  );
  // For each route with no live bus, find the (origin, alight) pair that
  // minimizes walk-to + walk-from. One entry per route — the rider doesn't
  // need to see all 12 ways they could fail to board a bus that isn't there.
  const bestPerRoute = new Map<
    number,
    { boardStopId: number; alightStopId: number; walkSec: number }
  >();
  for (const origin of originStops) {
    const edges = network.segmentEdges.get(origin.toStopId);
    if (!edges) continue;
    for (const edge of edges) {
      if (liveRouteIds.has(edge.routeId)) continue;
      const route = network.routes.get(edge.routeId);
      if (!route) continue;
      const originIdx = network.positionOnRoute(edge.routeId, origin.toStopId);
      if (originIdx === null) continue;
      for (let offset = 1; offset < route.stops.length; offset++) {
        const alight = route.stops[(originIdx + offset) % route.stops.length]!;
        const walkFrom = destWalkSecById.get(alight);
        if (walkFrom === undefined) continue;
        const walkSec = origin.seconds + walkFrom;
        const prev = bestPerRoute.get(edge.routeId);
        if (!prev || walkSec < prev.walkSec) {
          bestPerRoute.set(edge.routeId, {
            boardStopId: origin.toStopId,
            alightStopId: alight,
            walkSec,
          });
        }
      }
    }
  }
  return [...bestPerRoute.entries()].map(([routeId, best]) => ({
    routeId,
    boardStopId: best.boardStopId,
    alightStopId: best.alightStopId,
    nextActiveAt: null,
  }));
}
