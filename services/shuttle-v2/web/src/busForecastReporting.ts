import type { BusData } from './map-data';
import { ROUTE_LISTS } from './routes';
import { serverTrack } from './etaSource';
import { LIVE_UPDATE_STALE_MS } from './liveUpdates';
import { reportingKey, reportingName, REPORTING_LOSS_GRACE_MS, REPORTING_RETURN_NOTICE_MS,
  type ReportingSnapshot, type ReportingWatch } from './busReporting';

export interface ForecastReportingSnapshot { at: number; watches: ReportingWatch[] }
export interface ForecastReportingRecord extends ReportingWatch {
  status: 'watching' | 'unavailable' | 'restored';
  missingSince?: number;
  missingModels: number;
  changedAt: number;
  dismissed?: boolean;
}
export interface ForecastReportingState { lastModelAt: number | null; records: ForecastReportingRecord[] }
export const emptyForecastReportingState = (): ForecastReportingState => ({ lastModelAt: null, records: [] });

/** Read only the already validated, fresh shared source. A missing/stale
 * whole source cannot establish that one bus's forecast disappeared. */
export function forecastReportingSnapshot(buses: readonly BusData[], modelAt: number, receivedAt: number,
  ready: boolean): ForecastReportingSnapshot | null {
  if (!ready || !Number.isFinite(modelAt)) return null;
  return { at: modelAt, watches: ROUTE_LISTS.flatMap(cfg => buses
    .filter(bus => cfg.busRouteIds.includes(bus.route_id) && serverTrack(bus, cfg.label, receivedAt) != null)
    .map(bus => ({ busName: reportingName(bus.bus_name), routeLabel: cfg.label, routeIds: cfg.busRouteIds }))) };
}

/** A watched bus can keep reporting GPS while its forecast is withheld.
 * Retain that identity through automatic replacement, but forget an ordinary
 * selection change while the old bus still has a forecast. */
export function stepForecastReporting(prior: ForecastReportingState, snapshot: ReportingSnapshot | null,
  watched: readonly ReportingWatch[], scope: readonly string[], available: boolean, visible: boolean): ForecastReportingState {
  let records = prior.records.filter(r => scope.includes(r.routeLabel));
  const model = snapshot?.forecasts;
  if (!available || !visible || !model) return { lastModelAt: model?.at ?? prior.lastModelAt,
    records: records.map(r => ({ ...r, missingSince: undefined, missingModels: 0 })) };
  if (prior.lastModelAt !== null && model.at <= prior.lastModelAt) {
    return records.length === prior.records.length ? prior : { ...prior, records };
  }
  const current = new Map(watched.filter(w => reportingName(w.busName) && scope.includes(w.routeLabel))
    .map(w => [reportingKey(w), w]));
  const present = new Set(model.watches.map(reportingKey));
  const freshGps = (w: ReportingWatch) => snapshot.buses.some(b => reportingName(b.bus_name) === reportingName(w.busName)
    && w.routeIds.includes(b.route_id) && Number.isFinite(b.observed_at)
    && snapshot.serverAt - b.observed_at! >= -5000 && snapshot.serverAt - b.observed_at! < LIVE_UPDATE_STALE_MS);
  for (const [key, watch] of current) {
    if (present.has(key) && freshGps(watch) && !records.some(r => reportingKey(r) === key)) records.push({ ...watch,
      busName: reportingName(watch.busName), status: 'watching', missingModels: 0, changedAt: model.at });
  }
  records = records.flatMap<ForecastReportingRecord>(record => {
    let r = record;
    if (r.status === 'restored' && model.at - r.changedAt >= REPORTING_RETURN_NOTICE_MS) r = { ...r, status: 'watching', dismissed: false };
    if (present.has(reportingKey(r)) && freshGps(r)) {
      if (r.status === 'unavailable') return [{ ...r, status: 'restored', changedAt: model.at,
        missingSince: undefined, missingModels: 0, dismissed: false }];
      if (r.status === 'restored') return [{ ...r, missingSince: undefined, missingModels: 0 }];
      return current.has(reportingKey(r)) ? [{ ...r, missingSince: undefined, missingModels: 0 }] : [];
    }
    // Position loss has its own notice. Do not count missing/stale GPS as
    // evidence for this distinct, still-reporting forecast-loss episode.
    if (!freshGps(r)) return [{ ...r, missingSince: undefined, missingModels: 0 }];
    const missingSince = r.missingSince ?? model.at, missingModels = r.missingModels + 1;
    const lost = missingModels >= 2 && model.at - missingSince >= REPORTING_LOSS_GRACE_MS;
    return [{ ...r, missingSince, missingModels, ...(lost && r.status !== 'unavailable'
      ? { status: 'unavailable' as const, changedAt: model.at, dismissed: false } : {}) }];
  });
  return { lastModelAt: model.at, records };
}

export function forecastReportingNotice(record: ForecastReportingRecord, replacement?: ReportingWatch) {
  const bus = `${record.routeLabel} #${reportingName(record.busName)}`;
  if (record.status === 'restored') return { title: `${bus}: arrival estimate restored`,
    detail: 'Check its updated arrival time before heading to your stop.' };
  return { title: `${bus}: arrival estimate unavailable`, detail: replacement && reportingKey(replacement) !== reportingKey(record)
    ? `The trip now shows #${reportingName(replacement.busName)}; check its updated arrival time.`
    : 'Check the trip again for an updated arrival time.' };
}
