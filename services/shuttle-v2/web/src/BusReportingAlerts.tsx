import { useEffect, useRef, useState } from 'react';
import { emptyReportingState, reportingKey, reportingNotice, stepBusReporting,
  type ReportingSnapshot, type ReportingWatch } from './busReporting';
import { emptyForecastReportingState, forecastReportingNotice, stepForecastReporting } from './busForecastReporting';
import './BusReportingAlerts.css';

/** In-page notices need no notification permission; the monitor only advances
 * on a new successful poll while the page is visible. Keep the monitor mounted
 * while opening details for a route already in the current trip's scope. */
export function BusReportingAlerts({ snapshot, watched, scope, available, replacements = [], watchForecasts = false, viewKey = '', presented = true }: {
  snapshot: ReportingSnapshot | null;
  watched: readonly ReportingWatch[];
  scope: readonly string[];
  available: boolean;
  replacements?: readonly ReportingWatch[];
  watchForecasts?: boolean;
  viewKey?: string;
  /** Hide this view's notices without discarding its live monitor state. */
  presented?: boolean;
}) {
  const [state, setState] = useState(emptyReportingState);
  const [forecastState, setForecastState] = useState(emptyForecastReportingState);
  const previousViewRef = useRef(viewKey);
  const viewChanged = previousViewRef.current !== viewKey;
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const watchesKey = JSON.stringify(watched), scopeKey = JSON.stringify(scope);
  useEffect(() => {
    const changedView = previousViewRef.current !== viewKey;
    previousViewRef.current = viewKey;
    const currentWatches = JSON.parse(watchesKey), currentScope = JSON.parse(scopeKey);
    // Navigation clears completed recovery notices, not an active loss that
    // the rider may be opening this route to investigate. The reducers still
    // remove records outside the new route scope and preserve dismissal.
    setState(prior => stepBusReporting(changedView
      ? { ...prior, records: prior.records.filter(r => r.status !== 'returned') } : prior,
    snapshot, currentWatches, currentScope, available, visible));
    setForecastState(prior => watchForecasts
      ? stepForecastReporting(changedView
        ? { ...prior, records: prior.records.filter(r => r.status !== 'restored') } : prior,
      snapshot, currentWatches, currentScope, available, visible)
      : emptyForecastReportingState());
  }, [snapshot, watchesKey, scopeKey, available, visible, watchForecasts, viewKey]);
  // The first render of a new view must also omit completed notices while
  // the effect's cleanup has not committed yet. Active losses stay visible.
  const notices = state.records.filter(r => r.status !== 'watching' && !r.dismissed && scope.includes(r.routeLabel)
    && (!viewChanged || r.status !== 'returned'));
  const forecastNotices = watchForecasts ? forecastState.records.filter(r => r.status !== 'watching' && !r.dismissed
    && scope.includes(r.routeLabel) && (!viewChanged || r.status !== 'restored')
    && !notices.some(n => n.status === 'lost' && reportingKey(n) === reportingKey(r))) : [];
  if (!presented || !visible || (!notices.length && !forecastNotices.length)) return null;
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
