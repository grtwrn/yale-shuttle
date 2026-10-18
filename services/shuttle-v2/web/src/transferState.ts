import { ROUTE_LISTS } from './routes';
import type { TransferPath, TransferRidePath } from './transferPaths';
import { RIDE_MAX_AGE_MS, type RideEndReason } from './rideEnd';

export interface TransferDestination { lat: number; lon: number; text: string }
export interface OnwardTransfer {
  v: 1;
  plannedAtMs: number;
  firstRouteLabel: string;
  exitStopId: number;
  next: TransferRidePath;
  nextBusName?: string;
  destination: TransferDestination;
}
export interface TransferHandoff {
  onward: OnwardTransfer;
  stoppedAtMs: number;
  reason?: RideEndReason;
  ready?: boolean;
}
export interface TransferSelection { query: string; path: TransferPath; firstBusName?: string; secondBusName?: string }
export const TRANSFER_MAX_AGE_MS = 4 * 3600_000;
export const TRANSFER_HANDOFF_KEY = 'shuttle-transfer-handoff';
const SELECTION_KEY = 'shuttle-transfer-selection';
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonnegative = (v: unknown): v is number => finite(v) && v >= 0;
const stop = (v: unknown): v is number => finite(v) && Number.isInteger(v) && v > 0;
const label = (v: unknown): v is string => typeof v === 'string' && ROUTE_LISTS.some(c => c.label === v);
const clock = (v: unknown, now: number) => finite(v) && Number.isFinite(now) && v <= now + 5000 && now - v < TRANSFER_MAX_AGE_MS;

/** Persist only the selected path and destination, never a live forecast or
 * armed reminder. A fresh source is required to time the next pickup. */
export function parseTransferRidePath(value: unknown): TransferRidePath | null {
  const p = object(value);
  if (!p || !label(p.routeLabel) || typeof p.routeId !== 'string' || !stop(p.boardStopId) || !stop(p.alightStopId)
    || p.boardStopId === p.alightStopId || !nonnegative(p.plannedRideSec) || p.plannedRideSec > 1500
    || !Array.isArray(p.stops) || p.stops.length < 2 || p.stops.length > 100 || !p.stops.every(stop)
    || p.stops[0] !== p.boardStopId || p.stops.at(-1) !== p.alightStopId) return null;
  const cfg = ROUTE_LISTS.find(c => c.label === p.routeLabel)!;
  if (!cfg.routeIds.includes(p.routeId)) return null;
  return { routeLabel: cfg.label, color: cfg.color, routeId: p.routeId, boardStopId: p.boardStopId,
    alightStopId: p.alightStopId, stops: [...p.stops] as number[], plannedRideSec: p.plannedRideSec };
}
export function parseTransferPath(value: unknown): TransferPath | null {
  const p = object(value);
  if (!p) return null;
  const first = parseTransferRidePath(p.first), second = parseTransferRidePath(p.second);
  if (!first || !second || first.routeLabel === second.routeLabel
    || ![p.walkToSec, p.transferWalkSec, p.walkFromSec, p.directWalkSec].every(nonnegative)) return null;
  return { key: JSON.stringify([first.routeLabel, first.stops, second.routeLabel, second.stops]), first, second,
    walkToSec: p.walkToSec as number, transferWalkSec: p.transferWalkSec as number,
    walkFromSec: p.walkFromSec as number, directWalkSec: p.directWalkSec as number };
}
export function parseOnwardTransfer(value: unknown, now: number): OnwardTransfer | null {
  const p = object(value), destination = object(p?.destination);
  if (!p || p.v !== 1 || !clock(p.plannedAtMs, now) || !label(p.firstRouteLabel) || !stop(p.exitStopId)
    || !destination || !finite(destination.lat) || Math.abs(destination.lat) > 90
    || !finite(destination.lon) || Math.abs(destination.lon) > 180
    || typeof destination.text !== 'string' || !destination.text.trim() || destination.text.length > 500) return null;
  const next = parseTransferRidePath(p.next);
  if (!next || next.routeLabel === p.firstRouteLabel) return null;
  return { v: 1, plannedAtMs: p.plannedAtMs as number, firstRouteLabel: p.firstRouteLabel,
    exitStopId: p.exitStopId, next, ...(typeof p.nextBusName === 'string' && p.nextBusName.length <= 40 ? { nextBusName: p.nextBusName } : {}), destination: { lat: destination.lat, lon: destination.lon, text: destination.text } };
}
export function makeOnwardTransfer(path: TransferPath, destination: TransferDestination, now: number, nextBusName?: string): OnwardTransfer {
  return { v: 1, plannedAtMs: now, firstRouteLabel: path.first.routeLabel, exitStopId: path.first.alightStopId,
    next: path.second, destination, ...(nextBusName ? { nextBusName } : {}) };
}
export function loadTransferHandoff(now = Date.now()): TransferHandoff | null {
  try {
    const p = object(JSON.parse(localStorage.getItem(TRANSFER_HANDOFF_KEY) ?? 'null'));
    const onward = parseOnwardTransfer(p?.onward, now);
    if (p && onward && clock(p.stoppedAtMs, now)) {
      const reason = ['age', 'bus-gone', 'off-bus'].includes(String(p.reason)) ? p.reason as RideEndReason : undefined;
      return { onward, stoppedAtMs: p.stoppedAtMs as number, ...(reason ? { reason } : {}), ...(typeof p.ready === 'boolean' ? { ready: p.ready } : {}) };
    }
  } catch { /* Try recovering a first ride that expired while the app was closed. */ }
  try {
    const ride = object(JSON.parse(localStorage.getItem('shuttle-boarded-ride') ?? 'null'));
    const onward = parseOnwardTransfer(ride?.onward, now);
    if (!ride || !onward || !clock(ride.startedAt, now) || now - (ride.startedAt as number) < RIDE_MAX_AGE_MS
      || ride.routeLabel !== onward.firstRouteLabel || ride.alightStopId !== onward.exitStopId
      || !stop(ride.boardStopId) || typeof ride.busName !== 'string' || !ride.busName.trim() || ride.busName.length > 40) return null;
    // Age says tracking ended; it never establishes arrival at the change.
    return { onward, stoppedAtMs: now, reason: 'age', ready: false };
  } catch { return null; }
}

export function saveTransferHandoff(value: TransferHandoff | null): void {
  try {
    if (value) localStorage.setItem(TRANSFER_HANDOFF_KEY, JSON.stringify(value));
    else localStorage.removeItem(TRANSFER_HANDOFF_KEY);
  } catch { /* Storage is best effort; tracking must still work. */ }
}
export function loadTransferSelection(query: string): TransferSelection | null {
  try {
    const p = object(JSON.parse(sessionStorage.getItem(SELECTION_KEY) ?? 'null'));
    const path = parseTransferPath(p?.path);
    if (!p || p.query !== query || !path) return null;
    return { query, path, ...(typeof p.firstBusName === 'string' && p.firstBusName.length <= 40 ? { firstBusName: p.firstBusName } : {}),
      ...(typeof p.secondBusName === 'string' && p.secondBusName.length <= 40 ? { secondBusName: p.secondBusName } : {}) };
  } catch { return null; }
}
export function saveTransferSelection(value: TransferSelection | null): void {
  try {
    if (value) sessionStorage.setItem(SELECTION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SELECTION_KEY);
  } catch { /* The active selection remains in memory. */ }
}
