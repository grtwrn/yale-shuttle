import { HEADWAY_MIN, type PublishedWindow } from './schedule';
import { scheduledForTrip } from './planner';
import type { TransferPath, TransferRidePath } from './transferPaths';

/** Time to get off and board the next shuttle, separate from the walk. */
export const TRANSFER_CHANGE_SEC = 60;
export interface ScheduledTransferRide {
  path: TransferRidePath;
  busName: null;
  pickupAtMs: number;
  alightAtMs: number;
  waitSec: number;
}
export interface ScheduledTransferJourney {
  path: TransferPath;
  timing: 'typical';
  departAtMs: number;
  computedAtMs: number;
  first: ScheduledTransferRide;
  second: ScheduledTransferRide;
  changeSec: number;
  arrivalAtMs: number;
  totalSec: number;
}

/** Only for an explicitly selected future departure. A live forecast outage
 * must never silently turn into a typical/headway-based arrival estimate. */
export function planScheduledTransfers(paths: readonly TransferPath[], departAtMs: number, now: number,
  publishedHours?: Record<string, PublishedWindow>): ScheduledTransferJourney[] {
  if (![departAtMs, now].every(Number.isFinite) || departAtMs <= now) return [];
  const schedules = new Map<string, boolean>();
  const active = (ride: TransferRidePath, at: number) => {
    const key = `${ride.routeLabel}/${ride.routeId}/${Math.floor(at / 60_000)}`;
    let value = schedules.get(key);
    if (value === undefined) {
      value = scheduledForTrip({ routeIds: [ride.routeId], busRouteIds: [Number(ride.routeId)], label: ride.routeLabel }, new Date(at), publishedHours);
      schedules.set(key, value);
    }
    return value;
  };
  const wait = (label: string) => (HEADWAY_MIN[label] ?? 15) * 30;
  const result: ScheduledTransferJourney[] = [];
  for (const path of paths) {
    if (![path.walkToSec, path.transferWalkSec, path.walkFromSec, path.first.plannedRideSec, path.second.plannedRideSec]
      .every(n => Number.isFinite(n) && n >= 0)) continue;
    const firstWait = wait(path.first.routeLabel), secondWait = wait(path.second.routeLabel);
    const firstPickup = departAtMs + (path.walkToSec + firstWait) * 1000;
    const firstExit = firstPickup + path.first.plannedRideSec * 1000;
    const secondPickup = firstExit + (path.transferWalkSec + TRANSFER_CHANGE_SEC + secondWait) * 1000;
    if (!active(path.first, firstPickup) || !active(path.second, secondPickup)) continue;
    const secondExit = secondPickup + path.second.plannedRideSec * 1000;
    const arrivalAtMs = secondExit + path.walkFromSec * 1000;
    result.push({ path, timing: 'typical', departAtMs, computedAtMs: now, changeSec: TRANSFER_CHANGE_SEC,
      first: { path: path.first, busName: null, pickupAtMs: firstPickup, alightAtMs: firstExit, waitSec: firstWait },
      second: { path: path.second, busName: null, pickupAtMs: secondPickup, alightAtMs: secondExit, waitSec: secondWait },
      arrivalAtMs, totalSec: (arrivalAtMs - departAtMs) / 1000 });
  }
  return result.sort((a, b) => a.totalSec - b.totalSec
    || (a.path.walkToSec + a.path.transferWalkSec + a.path.walkFromSec) - (b.path.walkToSec + b.path.transferWalkSec + b.path.walkFromSec)
    || (a.path.key < b.path.key ? -1 : a.path.key > b.path.key ? 1 : 0));
}
