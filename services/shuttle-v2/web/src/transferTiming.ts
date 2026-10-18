import type { UpcomingArrival } from './arrivals';
import type { BusData } from './map-data';
import { serverArrivals } from './etaSource';
import { journeyArrival, type JourneyArrival } from './journeyArrival';
import { STOP_DWELL_SEC, rideBoardArrivals } from './planner';
import type { TransferPath, TransferRidePath } from './transferPaths';

export interface TimedTransferRide {
  path: TransferRidePath;
  busName: string;
  pickup: UpcomingArrival;
  destination: JourneyArrival;
  /** The source's canonical visit, not a deduplicated display-stop index. */
  alightHops: number;
}

/** Conditional on boarding both buses. There is deliberately no composed
 * confidence interval: separate bus forecasts do not provide a joint one. */
export interface LiveTransferJourney {
  timing: 'live';
  /** Snapshot visit identity; UI selections use path.key instead. */
  key: string;
  path: TransferPath;
  first: TimedTransferRide;
  second: TimedTransferRide;
  computedAtMs: number;
  arrivalAtMs: number;
  totalSec: number;
  connection: {
    readyAtMs: number;
    pickupAtMs: number;
    bufferSec: number;
    /** The source windows overlap or there is less than a minute to change. */
    uncertain: boolean;
  };
  firstPickupUncertain: boolean;
}

interface Track {
  visits: UpcomingArrival[];
  byHop: Map<number, UpcomingArrival>;
  conflicting: boolean;
}
const norm = (name: string) => name.replace(/^#/, '');

/** Time structural paths from one set of fresh, already-served forecasts.
 * Empty/missing forecasts produce no timed connection. Callers retain the
 * geometric path separately when an estimate is unavailable; this function
 * neither runs an estimator nor treats missing rows as a departed bus. */
function transferRideReader(arrivals: readonly UpcomingArrival[], now: number): (path: TransferRidePath) => TimedTransferRide[] {
  const routes = new Map<string, Map<string, Track>>();
  for (const a of arrivals) {
    if (![a.eta, a.low, a.high, a.stopsAhead, a.stopId].every(Number.isFinite)
      || a.eta < 0 || a.low < 0 || a.high < a.low || !Number.isInteger(a.stopsAhead) || a.stopsAhead < 0) continue;
    let buses = routes.get(a.routeLabel);
    if (!buses) routes.set(a.routeLabel, buses = new Map());
    const name = norm(a.busName);
    let track = buses.get(name);
    if (!track) buses.set(name, track = { visits: [], byHop: new Map(), conflicting: false });
    const visit = { ...a, busName: name };
    const previous = track.byHop.get(a.stopsAhead);
    if (previous) {
      if (previous.stopId !== a.stopId || previous.eta !== a.eta || previous.low !== a.low || previous.high !== a.high) track.conflicting = true;
      continue;
    }
    track.visits.push(visit); track.byHop.set(a.stopsAhead, visit);
  }
  for (const buses of routes.values()) for (const track of buses.values()) track.visits.sort((a, b) => a.stopsAhead - b.stopsAhead);
  const cache = new Map<string, TimedTransferRide[]>();
  const rides = (path: TransferRidePath): TimedTransferRide[] => {
    const key = JSON.stringify([path.routeLabel, path.stops]);
    const saved = cache.get(key);
    if (saved) return saved;
    const result: TimedTransferRide[] = [];
    cache.set(key, result);
    for (const [busName, track] of routes.get(path.routeLabel) ?? []) {
      if (track.conflicting) continue;
      for (const pickup of track.visits) {
        if (pickup.stopId !== path.boardStopId) continue;
        const alightHops = pickup.stopsAhead + path.stops.length - 1;
        const end = track.byHop.get(alightHops);
        if (!end || end.stopId !== path.alightStopId) continue;
        if (path.stops.some((id, i) => {
          const seen = track.byHop.get(pickup.stopsAhead + i);
          return seen && seen.stopId !== id;
        })) continue;
        const destination = journeyArrival(pickup, track.visits, path.alightStopId, 0, 0, now);
        // journeyArrival chooses the first forward destination. A later pass
        // cannot borrow the earlier pass's arrival or skip a return to pickup.
        if (!destination || destination.pointMs !== now + end.eta * 1000) continue;
        result.push({ path, busName, pickup, destination, alightHops });
      }
    }
    return result;
  };
  return rides;
}

export function timeLiveTransfers(paths: readonly TransferPath[], arrivals: readonly UpcomingArrival[], now: number): LiveTransferJourney[] {
  if (!Number.isFinite(now)) return [];
  const rides = transferRideReader(arrivals, now);
  const result: LiveTransferJourney[] = [];
  for (const path of paths) {
    if (![path.walkToSec, path.transferWalkSec, path.walkFromSec].every(n => Number.isFinite(n) && n >= 0)) continue;
    for (const first of rides(path.first)) {
      // Keep the existing first-pickup grace, with an explicit catch-risk
      // flag. Never extend that grace into a promise that bus two will wait.
      if (path.walkToSec > first.pickup.eta + STOP_DWELL_SEC || now + path.walkToSec * 1000 > first.destination.pointMs) continue;
      const readyAtMs = first.destination.pointMs + path.transferWalkSec * 1000;
      for (const second of rides(path.second)) {
        const pickupAtMs = now + second.pickup.eta * 1000;
        if (pickupAtMs < readyAtMs) continue;
        const arrivalAtMs = second.destination.pointMs + path.walkFromSec * 1000;
        if (arrivalAtMs < pickupAtMs) continue;
        const bufferSec = (pickupAtMs - readyAtMs) / 1000;
        result.push({ timing: 'live', key: JSON.stringify([path.key, first.busName, first.pickup.stopsAhead, second.busName, second.pickup.stopsAhead]),
          path, first, second, computedAtMs: now, arrivalAtMs, totalSec: (arrivalAtMs - now) / 1000,
          connection: { readyAtMs, pickupAtMs, bufferSec,
            uncertain: bufferSec < 60 || first.destination.highMs + path.transferWalkSec * 1000 > now + second.pickup.low * 1000 },
          firstPickupUncertain: path.walkToSec > first.pickup.low });
      }
    }
  }
  return result.sort((a, b) => a.totalSec - b.totalSec
    || (a.path.walkToSec + a.path.transferWalkSec + a.path.walkFromSec) - (b.path.walkToSec + b.path.transferWalkSec + b.path.walkFromSec)
    || Number(a.connection.uncertain) - Number(b.connection.uncertain)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Live entry point: an old browser-local estimate or a failed poll cannot
 * supply a timed transfer. The path remains available to the caller. */
export function planLiveTransfers(paths: readonly TransferPath[], buses: readonly BusData[], now: number, available: boolean): LiveTransferJourney[] {
  if (!available || !paths.length) return [];
  const targets = new Set<number>();
  for (const path of paths) for (const ride of [path.first, path.second]) for (const stop of ride.stops) targets.add(stop);
  const arrivals = serverArrivals(buses, [...targets], now);
  return arrivals ? timeLiveTransfers(paths, arrivals, now) : [];
}

export interface TransferRideForecasts {
  visits: UpcomingArrival[];
  pickups: UpcomingArrival[];
  rides: TimedTransferRide[];
}
/** Refresh the current leg independently of the previous bus. This also
 * preserves pickup evidence when the destination row temporarily disappears. */
export function liveTransferRideForecasts(path: TransferRidePath, buses: readonly BusData[], now: number, available: boolean): TransferRideForecasts {
  if (!available || !Number.isFinite(now)) return { visits: [], pickups: [], rides: [] };
  const visits = (serverArrivals(buses, [...new Set(path.stops)], now) ?? []).filter(a => a.routeLabel === path.routeLabel);
  return { visits, pickups: rideBoardArrivals(visits, path.boardStopId, path.alightStopId).sort((a, b) => a.eta - b.eta),
    rides: transferRideReader(visits, now)(path) };
}
