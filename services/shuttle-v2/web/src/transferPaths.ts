import { haversineMeters, type LatLon } from './geo';
import type { SegmentTimes } from './arrivals';
import { BUS_SPEED_M_S, mergedRouteStops, ROUTE_LISTS, type RouteListConfig } from './routes';
import { MAX_WALK_M, savesWalking, walkSecFromMeters } from './walk';
import { MAX_RIDE_SEC } from './planner';

export interface TransferRidePath {
  routeLabel: string;
  color: string;
  routeId: string;
  boardStopId: number;
  alightStopId: number;
  /** Actual forward calls, including intermediate repeats on folded routes. */
  stops: number[];
  plannedRideSec: number;
}

/** A route connection, without a claimed bus, wait, connection or arrival time. */
export interface TransferPath {
  key: string;
  first: TransferRidePath;
  second: TransferRidePath;
  walkToSec: number;
  transferWalkSec: number;
  walkFromSec: number;
  directWalkSec: number;
}

export interface TransferPathInputs {
  from: LatLon;
  to: LatLon;
  routeStops: Record<string, number[]>;
  stopCoords: Record<number, LatLon>;
  segmentTimes: SegmentTimes;
  routeConfigs?: readonly RouteListConfig[];
  maxTransferWalkM?: number;
}

/** Enumerate useful one-change paths. Timetable/live feasibility belongs to
 * the itinerary planner: a geometric connection alone is never a promise
 * that the second bus is running or can be caught. */
export function findTransferPaths({ from, to, routeStops, stopCoords, segmentTimes,
  routeConfigs = ROUTE_LISTS, maxTransferWalkM = 400 }: TransferPathInputs): TransferPath[] {
  const valid = (p: LatLon | undefined): p is LatLon => !!p && Number.isFinite(p.lat)
    && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
  if (!valid(from) || !valid(to) || !Number.isFinite(maxTransferWalkM) || maxTransferWalkM < 0) return [];
  const fromDistances = new Map<number, number>(), toDistances = new Map<number, number>();
  for (const [key, point] of Object.entries(stopCoords)) {
    const id = Number(key);
    if (!Number.isInteger(id) || !valid(point)) continue;
    fromDistances.set(id, haversineMeters(from, point));
    toDistances.set(id, haversineMeters(to, point));
  }
  const directWalkSec = walkSecFromMeters(haversineMeters(from, to));
  const firstRides: TransferRidePath[] = [], secondRides: TransferRidePath[] = [];
  for (const cfg of routeConfigs) {
    const stops = mergedRouteStops(cfg, routeStops);
    if (stops.length < 2) continue;
    const routeId = cfg.routeIds.find(id => (routeStops[id]?.length ?? 0) > 0);
    if (!routeId) continue;
    const segments = segmentTimes[routeId] ?? {};
    for (let start = 0; start < stops.length; start++) {
      const boardStopId = stops[start]!;
      if (!fromDistances.has(boardStopId)) continue;
      const nearOrigin = fromDistances.get(boardStopId)! <= MAX_WALK_M;
      const path = [boardStopId];
      let rideSec = 0;
      for (let step = 1; step < stops.length; step++) {
        const previous = stops[(start + step - 1) % stops.length]!;
        const current = stops[(start + step) % stops.length]!;
        // Returning to pickup is the next boarding opportunity, not a
        // useful ride to the destination on this pass of a folded route.
        if (current === boardStopId) break;
        const segment = segments[`${previous}-${current}`];
        const a = stopCoords[previous], b = stopCoords[current];
        rideSec += segment && segment.n >= 1 && Number.isFinite(segment.avg) && segment.avg >= 0
          ? segment.avg : valid(a) && valid(b) ? Math.max(30, haversineMeters(a, b) / BUS_SPEED_M_S) : 90;
        if (rideSec > MAX_RIDE_SEC) break;
        path.push(current);
        if (!toDistances.has(current)) continue;
        const nearDestination = toDistances.get(current)! <= MAX_WALK_M;
        if (!nearOrigin && !nearDestination) continue;
        const ride: TransferRidePath = { routeLabel: cfg.label, color: cfg.color, routeId,
          boardStopId, alightStopId: current, stops: [...path], plannedRideSec: rideSec };
        if (nearOrigin) firstRides.push(ride);
        if (nearDestination) secondRides.push(ride);
      }
    }
  }
  const walks = new Map<string, number>();
  const distance = (a: number, b: number) => {
    const key = a < b ? `${a}/${b}` : `${b}/${a}`;
    let value = walks.get(key);
    if (value === undefined) {
      value = haversineMeters(stopCoords[a]!, stopCoords[b]!);
      walks.set(key, value);
    }
    return value;
  };
  const unique = new Map<string, TransferPath>();
  for (const first of firstRides) for (const second of secondRides) {
    if (first.routeLabel === second.routeLabel) continue;
    const transferM = distance(first.alightStopId, second.boardStopId);
    if (transferM > maxTransferWalkM) continue;
    const walkToSec = walkSecFromMeters(fromDistances.get(first.boardStopId)!);
    const transferWalkSec = walkSecFromMeters(transferM);
    const walkFromSec = walkSecFromMeters(toDistances.get(second.alightStopId)!);
    if (!savesWalking(walkToSec + transferWalkSec + walkFromSec, directWalkSec)) continue;
    // Removing either ride must make the walk longer. Otherwise walking
    // straight to/from the other bus catches that same visit with less
    // walking and no extra wait or boarding.
    if (walkSecFromMeters(fromDistances.get(second.boardStopId)!) <= walkToSec + transferWalkSec) continue;
    if (walkSecFromMeters(toDistances.get(first.alightStopId)!) <= transferWalkSec + walkFromSec) continue;
    const key = JSON.stringify([first.routeLabel, first.stops, second.routeLabel, second.stops]);
    if (!unique.has(key)) unique.set(key, { key, first, second, walkToSec, transferWalkSec, walkFromSec, directWalkSec });
  }
  return [...unique.values()];
}
