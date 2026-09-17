import { useEffect, useState } from 'react';
import type { ArrivalHistory as History } from '../../src/server/arrivalHistory';
import { ArrivalPlot } from './ArrivalPlot';

const when = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const minutes = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;
function valid(raw: unknown): raw is History {
  const h = raw as History | null;
  return !!h && Number.isFinite(h.asOf) && Number.isFinite(h.forecastLowSec) && Number.isFinite(h.forecastHighSec)
    && Array.isArray(h.trips) && h.trips.length <= 24 && h.trips.every(t => typeof t.busName === 'string'
      && [t.arrivedAt, t.predictedAt, t.predictedSec, t.actualSec].every(Number.isFinite) && t.actualSec >= 0)
    && Array.isArray(h.recent) && h.recent.length <= 3 && h.recent.every(t => typeof t.busName === 'string' && Number.isFinite(t.arrivedAt));
}

/** Mount only inside an open disclosure. One snapshot per opening; no hidden
 * polling or browser estimator, and a changed trip cancels its old request. */
export function ArrivalHistory({ route, stopId, etaSec }: { route: string; stopId: number; etaSec: number }) {
  const [result, setResult] = useState<{ key: string; data?: History; error?: boolean }>();
  const key = `${route}|${stopId}`;
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    const timeout = setTimeout(() => abort.abort(), 10_000);
    const query = new URLSearchParams({ route, stop: String(stopId), eta: String(Math.round(etaSec)) });
    fetch(`/api/arrival-history?${query}`, { signal: abort.signal }).then(async r => {
      if (!r.ok) throw new Error('history unavailable');
      const raw = await r.json();
      if (!valid(raw)) throw new Error('invalid history');
      if (active) setResult({ key, data: raw });
    }).catch(() => { if (active) setResult({ key, error: true }); }).finally(() => clearTimeout(timeout));
    return () => { active = false; abort.abort(); clearTimeout(timeout); };
    // Keep the comparison labeled by its returned forecast range while live
    // ETA updates continue. Reopening requests fresh matching evidence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, stopId]);
  const state = result?.key === key ? result : undefined;
  const data = state?.data;
  return <section aria-label="Recorded arrival history" style={{ borderTop: '1px solid #e5e7eb', marginTop: 20, paddingTop: 16 }}>
    <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>What happened on past trips</h3>
    {!data ? <p style={{ fontSize: 13, color: '#5f6368' }}>{state?.error ? 'Recorded trips are unavailable right now.' : 'Loading recorded trips…'}</p> : <>
      {data.trips.length ? <>
        <ArrivalPlot observed clock={false} values={data.trips.map(t => t.actualSec)} title="Recorded time until arrival"
          labels={data.trips.map(t => `${when(t.arrivedAt)} · #${t.busName.replace(/^#/, '')}: predicted ${minutes(t.predictedSec)}, arrived after ${minutes(t.actualSec)}`)}
          description={`${data.trips.length} recorded trips · each hollow dot is one observed arrival, not a predicted outcome.`} />
        <p style={{ fontSize: 12, color: '#5f6368', lineHeight: 1.5 }}>Same line and stop, with forecasts of {minutes(data.forecastLowSec)}–{minutes(data.forecastHighSec)}, near this time of day. These past waits are context, not a probability for your shuttle.</p>
        <details style={{ fontSize: 12 }}><summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>Dates and recorded waits ▾</summary>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead><tr><th>Arrival · bus</th><th>Forecast</th><th>Actual wait</th></tr></thead>
            <tbody>{data.trips.map(t => <tr key={`${t.busName}|${t.arrivedAt}`}><td style={{ padding: '8px 4px 8px 0' }}>{when(t.arrivedAt)} · #{t.busName.replace(/^#/, '')}</td><td>{minutes(t.predictedSec)}</td><td>{minutes(t.actualSec)}</td></tr>)}</tbody>
          </table>
        </details>
      </> : <p style={{ fontSize: 13, color: '#5f6368', lineHeight: 1.5 }}>No matches among the recent recorded trips. We’ll show observations here when comparable forecasts have recorded arrivals.</p>}
      {data.recent.length > 0 && <><h4 style={{ margin: '14px 0 8px', fontSize: 13 }}>Recent recorded arrivals at this stop</h4>
        <ul style={{ paddingLeft: 18, fontSize: 12, lineHeight: 1.8 }}>{data.recent.map(t => <li key={`${t.busName}|${t.arrivedAt}`}>{when(t.arrivedAt)} · #{t.busName.replace(/^#/, '')}</li>)}</ul></>}
      <p style={{ fontSize: 11, color: '#5f6368', lineHeight: 1.5 }}>Up to 24 matches among recent recorded trips from the past 30 days, within two hours of this time and the same weekday/weekend category. Arrivals are detected from shuttle GPS; recording gaps can leave trips out.</p>
    </>}
  </section>;
}
