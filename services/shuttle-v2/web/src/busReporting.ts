import type { BusData } from './map-data';
import { LIVE_UPDATE_STALE_MS } from './liveUpdates';

export const REPORTING_LOSS_GRACE_MS = 5_000;
export const REPORTING_RETURN_NOTICE_MS = 30_000;
export interface ReportingWatch { busName: string; routeLabel: string; routeIds: readonly number[] }
export interface ReportingSnapshot { buses: readonly BusData[]; at: number; serverAt: number }
export interface ReportingRecord extends ReportingWatch {
  status: 'watching' | 'lost' | 'returned';
  missingSince?: number;
  missingPolls: number;
  changedAt: number;
  dismissed?: boolean;
}
export interface ReportingState { lastPollAt: number | null; records: ReportingRecord[] }
export const emptyReportingState = (): ReportingState => ({ lastPollAt: null, records: [] });
export const reportingName = (name: string) => name.trim().replace(/^#/, '');
export const reportingKey = (watch: ReportingWatch) => `${watch.routeLabel}:${reportingName(watch.busName)}`;

/** Only successful, new position snapshots prove a vehicle stopped reporting.
 * Keep a missing selected bus when its card switches to another vehicle, but
 * forget an ordinary selection change while the previous bus is still live.
 * Physical bus number + line survives an upstream tracking-ID change. */
export function stepBusReporting(
  prior: ReportingState, snapshot: ReportingSnapshot | null, watched: readonly ReportingWatch[],
  scope: readonly string[], available: boolean, visible: boolean,
): ReportingState {
  let records = prior.records.filter(r => scope.includes(r.routeLabel));
  if (!available || !visible) return { lastPollAt: snapshot?.at ?? prior.lastPollAt,
    records: records.map(r => ({ ...r, missingSince: undefined, missingPolls: 0 })) };
  if (!snapshot || (prior.lastPollAt !== null && snapshot.at <= prior.lastPollAt)) {
    return records.length === prior.records.length ? prior : { ...prior, records };
  }
  const current = new Map(watched.filter(w => reportingName(w.busName) && scope.includes(w.routeLabel))
    .map(w => [reportingKey(w), w]));
  const fresh = (w: ReportingWatch) => snapshot.buses.some(b =>
    reportingName(b.bus_name) === reportingName(w.busName) && w.routeIds.includes(b.route_id)
    && (b.observed_at === undefined || (Number.isFinite(b.observed_at)
      && snapshot.serverAt - b.observed_at < LIVE_UPDATE_STALE_MS)));
  for (const [key, watch] of current) {
    if (!records.some(r => reportingKey(r) === key) && fresh(watch)) records.push({ ...watch,
      busName: reportingName(watch.busName), status: 'watching', missingPolls: 0, changedAt: snapshot.at });
  }
  records = records.flatMap<ReportingRecord>(r => {
    if (r.status === 'returned' && snapshot.at - r.changedAt >= REPORTING_RETURN_NOTICE_MS) {
      r = { ...r, status: 'watching', dismissed: false };
    }
    const selected = current.has(reportingKey(r));
    if (fresh(r)) {
      if (r.status === 'lost') return [{ ...r, status: 'returned' as const,
        changedAt: snapshot.at, missingSince: undefined, missingPolls: 0, dismissed: false }];
      if (r.status === 'returned' && snapshot.at - r.changedAt < REPORTING_RETURN_NOTICE_MS) {
        return [{ ...r, missingSince: undefined, missingPolls: 0 }];
      }
      return selected ? [{ ...r, status: 'watching' as const, missingSince: undefined,
        missingPolls: 0, dismissed: false }] : [];
    }
    const missingSince = r.missingSince ?? snapshot.at, missingPolls = r.missingPolls + 1;
    const lost = missingPolls >= 2 && snapshot.at - missingSince >= REPORTING_LOSS_GRACE_MS;
    return [{ ...r, missingSince, missingPolls, ...(lost && r.status !== 'lost'
      ? { status: 'lost' as const, changedAt: snapshot.at, dismissed: false } : {}) }];
  });
  return { lastPollAt: snapshot.at, records };
}

export function reportingNotice(record: ReportingRecord, replacement?: ReportingWatch) {
  const bus = `${record.routeLabel} #${reportingName(record.busName)}`;
  if (record.status === 'returned') return { title: `${bus} is reporting again`,
    detail: 'Check the updated arrival time before heading to your stop.' };
  return { title: `${bus} stopped reporting`,
    detail: 'Its arrival time is unavailable. The feed does not say whether tracking was interrupted or the bus left service.'
      + (replacement && reportingKey(replacement) !== reportingKey(record)
        ? ` The trip now shows #${reportingName(replacement.busName)}; check its updated arrival.` : '') };
}
