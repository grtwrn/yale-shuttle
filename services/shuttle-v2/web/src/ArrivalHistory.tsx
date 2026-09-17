import { useEffect, useState } from 'react';
import type { JourneyHistory as History } from '../../src/server/journeyHistory';
import { ArrivalPlot } from './ArrivalPlot';

const when = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const minutes = (s: number) => s < 60 ? '<1 min' : `${Math.round(s / 60)} min`;
function valid(raw: unknown): raw is History {
  const h = raw as History | null;
  if (!h || !Number.isFinite(h.asOf) || !Array.isArray(h.recent) || h.recent.length > 3
    || !h.recent.every(t => t && typeof t.busName === 'string' && Number.isFinite(t.arrivedAt))) return false;
  const j = h.journey;
  return j === null || !!j && ['standing', 'departure'].includes(j.mode)
    && typeof j.fromName === 'string' && typeof j.toName === 'string'
    && Number.isInteger(j.serviceDates) && j.serviceDates >= 0 && j.serviceDates <= 24
    && (j.mode === 'departure' ? j.elapsedSec === null : Number.isFinite(j.elapsedSec) && j.elapsedSec! >= 0)
    && Array.isArray(j.trips) && j.trips.length <= 24 && j.trips.every(t => t && typeof t.busName === 'string'
      && [t.startedAt, t.departedAt, t.arrivedAt, t.actualSec].every(Number.isFinite)
      && t.startedAt <= t.departedAt && t.departedAt < t.arrivedAt && t.actualSec > 0);
}

/** One explicitly dated comparison per opening/refresh. The server supplies
 * the bus's current route occurrence; no browser reconstruction of history. */
export function ArrivalHistory({ route, stopId, etaSec, busName }: { route: string; stopId: number; etaSec: number; busName: string }) {
  const [result, setResult] = useState<{ key: string; data?: History; error?: boolean }>();
  const [refresh, setRefresh] = useState(0);
  const key = `${route}|${stopId}|${busName}|${refresh}`;
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    const timeout = setTimeout(() => abort.abort(), 10_000);
    const query = new URLSearchParams({ route, stop: String(stopId), bus: busName, eta: String(Math.round(etaSec)) });
    fetch(`/api/journey-history?${query}`, { signal: abort.signal }).then(async r => {
      if (!r.ok) throw new Error('history unavailable');
      const raw = await r.json();
      if (!valid(raw)) throw new Error('invalid history');
      if (active) setResult({ key, data: raw });
    }).catch(() => { if (active) setResult({ key, error: true }); }).finally(() => clearTimeout(timeout));
    return () => { active = false; abort.abort(); clearTimeout(timeout); };
    // Keep the returned starting point and elapsed wait labeled while the
    // live ETA changes. Reopening/refreshing obtains a new comparison.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, stopId, busName, refresh]);
  const state = result?.key === key ? result : undefined;
  const data = state?.data, j = data?.journey;
  const values = j?.trips.map(t => t.actualSec).sort((a, b) => a - b) ?? [];
  const median = values.length >= 5 ? (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2 : null;
  return <section aria-label="Recorded arrival history" style={{ borderTop: '1px solid #e5e7eb', marginTop: 20, paddingTop: 16 }}>
    <h3 style={{ fontSize: 16, margin: '0 0 8px' }}>Past trips to this stop</h3>
    {!data ? <p style={{ fontSize: 13, color: '#5f6368' }}>{state?.error ? 'Recorded trips are unavailable right now.' : 'Loading recorded trips…'}</p> : <>
      {j && <>
        <p style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>{j.fromName} → {j.toName}</p>
        <p style={{ fontSize: 12, color: '#5f6368', lineHeight: 1.5 }}>{j.mode === 'standing'
          ? `Matched to buses still waiting at ${j.fromName} after ${minutes(j.elapsedSec!)}. Times include the remaining stop wait and travel.`
          : 'Measured from departure at the starting stop. These are full stop-to-stop times; the live estimate accounts for this shuttle’s current progress.'}</p>
      </>}
      {j?.trips.length ? <>
        <ArrivalPlot observed clock={false} values={j.trips.map(t => t.actualSec)}
          title={j.mode === 'standing' ? 'Remaining wait + travel' : 'Travel time after departure'}
          labels={j.trips.map(t => `${when(t.arrivedAt)} · #${t.busName.replace(/^#/, '')}: ${minutes(t.actualSec)} from ${when(t.startedAt)}`)}
          description={`${j.trips.length} recorded ${j.trips.length === 1 ? 'trip' : 'trips'} across ${j.serviceDates} ${j.serviceDates === 1 ? 'date' : 'dates'}. Each dot is one completed journey.`} />
        {median !== null && <p style={{ fontSize: 13 }}>Observed median: <strong>{minutes(median)}</strong></p>}
        <details style={{ fontSize: 12 }}><summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>Dates and recorded times ▾</summary>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead><tr><th>Arrival · bus</th><th>Measured from</th><th>Time to stop</th></tr></thead>
            <tbody>{j.trips.map(t => <tr key={`${t.busName}|${t.arrivedAt}`}><td style={{ padding: '8px 4px 8px 0' }}>{when(t.arrivedAt)} · #{t.busName.replace(/^#/, '')}</td><td>{when(t.startedAt)}</td><td>{minutes(t.actualSec)}</td></tr>)}</tbody>
          </table>
        </details>
      </> : <p style={{ fontSize: 13, color: '#5f6368', lineHeight: 1.5 }}>{j
        ? 'No comparable completed journeys among the recent records.'
        : 'A comparable starting point is not available for this shuttle right now.'}</p>}
      {data.recent.length > 0 && <><h4 style={{ margin: '14px 0 8px', fontSize: 13 }}>Recent recorded arrivals at this stop</h4>
        <ul style={{ paddingLeft: 18, fontSize: 12, lineHeight: 1.8 }}>{data.recent.map(t => <li key={`${t.busName}|${t.arrivedAt}`}>{when(t.arrivedAt)} · #{t.busName.replace(/^#/, '')}</li>)}</ul></>}
      <details style={{ fontSize: 11, color: '#5f6368', lineHeight: 1.5 }}>
        <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>About these records ▾</summary>
        <p>Up to 24 connected journeys among the latest 240 starting-stop visits in 30 days, on the same route and direction, within two hours of this time and the same weekday/weekend category. Only GPS-detected journeys that stopped at both endpoints are shown; skipped stops and recording gaps leave trips out. These observations are context for the live estimate.</p>
      </details>
      <p style={{ fontSize: 11, color: '#5f6368', margin: '6px 0' }}>Comparison captured {when(data.asOf)}</p>
    </>}
    {(data || state?.error) && <button type="button" onClick={() => setRefresh(n => n + 1)} style={{ minHeight: 44, padding: '8px 0', border: 0, background: 'transparent', color: '#174ea6', fontSize: 12, cursor: 'pointer' }}>Refresh comparison</button>}
  </section>;
}
