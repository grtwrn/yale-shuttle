import { RIDE_MAX_AGE_MS } from './rideEnd';
import { loadTransferHandoff, parseOnwardTransfer, type OnwardTransfer } from './transferState';

export interface BoardedRide {
  routeLabel: string;
  color: string;
  busName: string;
  boardStopId: number;
  alightStopId: number;
  startedAt: number;
  toLat?: number;
  toLon?: number;
  toText?: string;
  /** Only the first bus of a transfer trip carries the remaining ride. */
  onward?: OnwardTransfer;
}
export const BOARDED_LS_KEY = 'shuttle-boarded-ride';
export function loadBoardedRide(now = Date.now()): BoardedRide | null {
  try {
    if (!Number.isFinite(now)) return null;
    const value: unknown = JSON.parse(localStorage.getItem(BOARDED_LS_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const p = value as Partial<BoardedRide>;
    // Preserve the existing loader's accepted legacy rides. Boarding-memory
    // helpers already reject invalid bus identities without breaking restore.
    if (typeof p.routeLabel !== 'string' || typeof p.boardStopId !== 'number'
      || typeof p.alightStopId !== 'number' || typeof p.startedAt !== 'number'
      || now - p.startedAt >= RIDE_MAX_AGE_MS) return null;
    const ride = { ...p } as BoardedRide;
    delete ride.onward;
    const onward = parseOnwardTransfer(p.onward, now);
    if (onward && onward.firstRouteLabel === ride.routeLabel && onward.exitStopId === ride.alightStopId) ride.onward = onward;
    // A persisted handoff is the first ride's completed transition. A crash
    // between saving that marker and removing the ride must not resurrect it.
    const handoff = ride.onward && loadTransferHandoff(now);
    if (handoff && handoff.onward.plannedAtMs === ride.onward?.plannedAtMs && handoff.stoppedAtMs >= ride.startedAt) return null;
    return ride;
  } catch { return null; }
}
export function saveBoardedRide(ride: BoardedRide | null): void {
  try {
    if (ride) localStorage.setItem(BOARDED_LS_KEY, JSON.stringify(ride));
    else localStorage.removeItem(BOARDED_LS_KEY);
  } catch { /* The active ride remains in memory. */ }
}
