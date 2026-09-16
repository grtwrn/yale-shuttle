import type { TripOption } from './planner';
import { deadlineStatus, type DeadlineStatus } from './journeyArrival';
import { LIVE_UPDATE_STALE_MS } from './liveUpdates';

export interface DeadlineOption {
  option: TripOption;
  pointMs?: number;
  lowMs?: number;
  highMs?: number;
  status: DeadlineStatus;
  caution?: string;
}

export function compareDeadline(options: readonly TripOption[], classMs: number, bufferMin: number,
  now: number, lastBusUpdateAt: number | null, failed: boolean, departureMs?: number) {
  const stale = failed || lastBusUpdateAt === null || now - lastBusUpdateAt >= LIVE_UPDATE_STALE_MS;
  const future = departureMs !== undefined;
  const rows: DeadlineOption[] = options.filter(o => !o.departed).map(option => {
    if (option.mode === 'walk') {
      const pointMs = (departureMs ?? now) + option.totalSec * 1000;
      return { option, pointMs, status: deadlineStatus(pointMs, classMs, bufferMin) };
    }
    const a = option.journeyArrival;
    if (future || stale || option.etaUnavailable || !a || a.pointMs < now || ![a.pointMs, a.lowMs, a.highMs].every(Number.isFinite)) {
      return { option, status: 'unknown', caution: future ? 'Live window available closer to departure.'
        : stale ? 'Bus updates interrupted.' : 'Destination window unavailable.' };
    }
    const caution = a.catchRisk ? 'The bus could reach pickup before you. This window assumes you catch it.'
      : a.estimated ? 'Limited trip data; allow extra time.' : undefined;
    return { option, pointMs: a.pointMs, lowMs: a.lowMs, highMs: a.highMs,
      status: deadlineStatus(a.highMs, classMs, bufferMin), caution };
  });
  const walk = rows.find(r => r.option.mode === 'walk');
  // Preserve the planner's stable ordering among routes that fit. Small
  // per-poll ETA noise must not keep swapping the recommended line.
  const fits = rows.find(r => r.option.mode === 'shuttle' && r.status === 'fits' && !r.caution);
  const shuttle = fits ?? rows.find(r => r.option.mode === 'shuttle' && r.pointMs !== undefined)
    ?? rows.find(r => r.option.mode === 'shuttle');
  const recommendation = fits && (walk?.status !== 'fits' || fits.pointMs! < walk.pointMs!)
    ? fits : walk?.status === 'fits' ? walk : undefined;
  return { walk, shuttle, recommendation, stale, future };
}
