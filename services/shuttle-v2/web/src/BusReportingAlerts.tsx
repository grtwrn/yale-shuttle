import { useEffect, useState } from 'react';
import { emptyReportingState, reportingKey, reportingNotice, stepBusReporting,
  type ReportingSnapshot, type ReportingWatch } from './busReporting';
import { emptyForecastReportingState, forecastReportingNotice, stepForecastReporting } from './busForecastReporting';
import './BusReportingAlerts.css';

/** In-page notices need no notification permission; the monitor only advances
 * on a new successful poll while the page is visible. Mount per viewing scope. */
export function BusReportingAlerts({ snapshot, watched, scope, available, replacements = [], watchForecasts = false }: {
  snapshot: ReportingSnapshot | null;
  watched: readonly ReportingWatch[];
  scope: readonly string[];
  available: boolean;
  replacements?: readonly ReportingWatch[];
  watchForecasts?: boolean;
}) {
  const [state, setState] = useState(emptyReportingState);
  const [forecastState, setForecastState] = useState(emptyForecastReportingState);
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const watchesKey = JSON.stringify(watched), scopeKey = JSON.stringify(scope);
  useEffect(() => {
    setState(prior => stepBusReporting(prior, snapshot, JSON.parse(watchesKey), JSON.parse(scopeKey), available, visible));
  }, [snapshot, watchesKey, scopeKey, available, visible]);
  useEffect(() => {
    setForecastState(prior => watchForecasts
      ? stepForecastReporting(prior, snapshot, JSON.parse(watchesKey), JSON.parse(scopeKey), available, visible)
      : emptyForecastReportingState());
  }, [snapshot, watchesKey, scopeKey, available, visible, watchForecasts]);
  const notices = state.records.filter(r => r.status !== 'watching' && !r.dismissed && scope.includes(r.routeLabel));
  const forecastNotices = watchForecasts ? forecastState.records.filter(r => r.status !== 'watching' && !r.dismissed
    && scope.includes(r.routeLabel) && !notices.some(n => n.status === 'lost' && reportingKey(n) === reportingKey(r))) : [];
  if (!visible || (!notices.length && !forecastNotices.length)) return null;
  return <div className="bus-reporting-alerts" data-testid="bus-reporting-alerts" aria-label="Bus tracking updates">
    {notices.map(record => {
      const key = reportingKey(record);
      const notice = reportingNotice(record, replacements.find(w => w.routeLabel === record.routeLabel));
      return <div key={`${key}:${record.status}`} className={`bus-reporting-notice ${record.status}`}
        role={record.status === 'lost' ? 'alert' : 'status'}>
        <div><strong>{notice.title}</strong><p>{notice.detail}</p></div>
        <button type="button" aria-label={`Dismiss tracking update for ${record.routeLabel} #${record.busName}`}
          onClick={() => setState(prior => ({ ...prior, records: prior.records.map(r => reportingKey(r) === key
            ? { ...r, dismissed: true } : r) }))}>×</button>
      </div>;
    })}
    {forecastNotices.map(record => {
      const key = reportingKey(record);
      const notice = forecastReportingNotice(record, replacements.find(w => w.routeLabel === record.routeLabel));
      return <div key={`forecast:${key}:${record.status}`}
        className={`bus-reporting-notice ${record.status === 'restored' ? 'returned' : 'lost'}`}
        data-testid="bus-forecast-update" role={record.status === 'unavailable' ? 'alert' : 'status'}>
        <div><strong>{notice.title}</strong><p>{notice.detail}</p></div>
        <button type="button" aria-label={`Dismiss arrival update for ${record.routeLabel} #${record.busName}`}
          onClick={() => setForecastState(prior => ({ ...prior, records: prior.records.map(r => reportingKey(r) === key
            ? { ...r, dismissed: true } : r) }))}>×</button>
      </div>;
    })}
  </div>;
}
