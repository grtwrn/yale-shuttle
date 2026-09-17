import { useId, useState, type CSSProperties } from 'react';
import { ArrivalPlot } from './ArrivalPlot';
import { ArrivalHistory } from './ArrivalHistory';
import type { TripOption } from './planner';
import { compareDeadline, type DeadlineOption } from './arriveBy';
import { arrivalClock, deadlineError, localDateTime } from './journeyArrival';

const button: CSSProperties = { minHeight: 44, padding: '8px 12px', border: '1px solid #dadce0', borderRadius: 8,
  background: '#fff', color: '#174ea6', font: 'inherit', cursor: 'pointer' };
const input: CSSProperties = { ...button, boxSizing: 'border-box', fontSize: 16, color: '#202124', minWidth: 0, width: '100%' };

export function ArriveBy({ value, onChange, bufferMin, onBufferChange, options, destination,
  lastBusUpdateAt, busUpdateFailed, departureMs, stopNames, onSelect }: {
  value: string | null; onChange: (value: string | null) => void; bufferMin: number; onBufferChange: (value: number) => void;
  options: TripOption[]; destination: string; lastBusUpdateAt: number | null; busUpdateFailed: boolean;
  departureMs?: number; stopNames: Record<number, string>; onSelect: (route: string) => void;
}) {
  const id = useId();
  const now = Date.now();
  if (value === null) return <button type="button" style={{ ...button, width: '100%', marginBottom: 12, textAlign: 'left' }}
    onClick={() => onChange(localDateTime(Math.ceil((now + 30 * 60_000) / (30 * 60_000)) * 30 * 60_000))}>
    Arrive by… <span style={{ color: '#5f6368', fontSize: 13 }}>Plan for class</span>
  </button>;

  const error = deadlineError(value, now);
  const classMs = Date.parse(value);
  const targetMs = classMs - bufferMin * 60_000;
  const comparison = compareDeadline(options, classMs, bufferMin, now, lastBusUpdateAt, busUpdateFailed, departureMs);
  const { recommendation, shuttle, walk } = comparison;
  const heading = recommendation?.option.mode === 'walk' ? (departureMs ? 'Walking fits your buffer' : 'Walk now')
    : recommendation ? `Take ${recommendation.option.routeLabel}` : 'Your arrival is at risk';
  const explanation = recommendation?.option.mode === 'walk'
    ? 'The walking estimate gets you there before your target. It avoids the shuttle wait.'
    : recommendation ? `Head to ${stopNames[recommendation.option.boardStopId] ?? 'your pickup stop'}. The shuttle window fits before your target.`
    : 'No available option fits your buffer with enough information. Check the times below.';
  const renderRow = (r: DeadlineOption) => {
    const walking = r.option.mode === 'walk';
    const unavailable = r.pointMs === undefined;
    const fits = r.status === 'fits' && !r.caution;
    const status = unavailable ? r.caution : r.caution ? (r.option.journeyArrival?.catchRisk ? 'Connection uncertain' : 'Limited trip data')
      : fits ? (walking ? 'Estimate fits buffer' : 'Window fits buffer')
        : r.status === 'buffer' ? 'May use your buffer' : (walking ? 'Estimate past class time' : 'Window extends past class');
    return <button key={r.option.routeLabel} type="button" onClick={() => onSelect(r.option.routeLabel)}
      style={{ ...button, display: 'block', width: '100%', textAlign: 'left', padding: '12px 0', border: 0, borderRadius: 0,
        borderTop: '1px solid #e5e7eb', color: '#202124', background: 'transparent' }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px 12px' }}>
        <strong>{walking ? 'Walk' : `${r.option.routeLabel} · #${r.option.journeyArrival?.busName ?? r.option.busName}`}</strong>
        <span style={{ fontWeight: 600 }}>{unavailable ? 'No live window' : walking ? `About ${arrivalClock(r.pointMs!)}`
          : `${arrivalClock(r.lowMs!, 'low')}–${arrivalClock(r.highMs!, 'high')}`}</span>
      </span>
      <span style={{ display: 'block', fontSize: 12, color: fits ? '#25613c' : '#795000', marginTop: 5 }}>{status} · View trip ›</span>
      {!unavailable && r.caution && <span style={{ display: 'block', color: '#5f6368', fontSize: 12, lineHeight: 1.5, marginTop: 6 }}>{r.caution}</span>}
    </button>;
  };
  return <section aria-label="Arrive by class" style={{ background: '#f8fafd', border: '1px solid #dbe3ee', borderRadius: 12, padding: 16, marginBottom: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <strong style={{ fontSize: 16 }}>Arrive by class</strong>
      <button type="button" style={{ ...button, border: 0, background: 'transparent' }} onClick={() => onChange(null)}>Clear</button>
    </div>
    <label htmlFor={`${id}-time`} style={{ display: 'block', fontSize: 13, marginBottom: 5 }}>Class starts · local time</label>
    <input id={`${id}-time`} type="datetime-local" value={value} onChange={e => onChange(e.target.value)}
      aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} style={input} />
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 13, marginTop: 10 }}>
      Time to get inside
      <select value={bufferMin} onChange={e => onBufferChange(Number(e.target.value))} style={{ ...input, width: 'auto' }}>
        {[0, 5, 10, 15, 20, 30, bufferMin].filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b).map(n => <option key={n} value={n}>{n} min</option>)}
      </select>
    </label>
    {error ? <p id={`${id}-error`} role="alert" style={{ color: '#b3261e', fontSize: 13 }}>{error}</p> : <>
      <p style={{ fontSize: 13, lineHeight: 1.5 }}>Reach <strong>{destination}</strong> by <strong>{arrivalClock(targetMs)}</strong>{bufferMin > 0 ? ` · ${bufferMin} min before class` : ''}.</p>
      <h3 style={{ fontSize: 20, margin: '16px 0 6px', color: recommendation ? '#174ea6' : '#795000' }}>{heading}</h3>
      <p style={{ fontSize: 13, lineHeight: 1.5, margin: '0 0 16px' }}>{explanation}</p>
      <p style={{ fontSize: 12, color: '#5f6368', marginBottom: 6 }}>Estimated arrival at destination</p>
      <div aria-label="Arrival at destination">{shuttle && renderRow(shuttle)}{walk && renderRow(walk)}</div>
      {shuttle?.pointMs !== undefined && shuttle.option.journeyArrival?.distributionMs?.length && !comparison.stale && !comparison.future
        ? <DestinationDistribution row={shuttle} classMs={classMs} targetMs={targetMs} walkMs={walk?.pointMs} destination={destination} /> : null}
      <details style={{ fontSize: 12, color: '#5f6368', lineHeight: 1.5, borderTop: '1px solid #e5e7eb', paddingTop: 6 }}>
        <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>How to read these times ▾</summary>
        <p>Shuttle windows include waiting, the ride and the final walk, assuming you catch the listed bus. They can run earlier or later. Walking uses an estimated pace; crossings and getting inside may take longer.</p>
        <p>Your buffer is separate from the arrival window. These are estimates, not an on-time probability.</p>
        {lastBusUpdateAt !== null && <p>Bus feed last received {arrivalClock(lastBusUpdateAt)}{comparison.stale ? ' · updates interrupted' : ''}.</p>}
        <p>Tap a trip, then its pickup estimate, for stops away, possible pickup times, past trips and how much later the following shuttle is expected.</p>
      </details>
    </>}
  </section>;
}


function DestinationDistribution({ row, classMs, targetMs, walkMs, destination }: {
  row: DeadlineOption; classMs: number; targetMs: number; walkMs?: number; destination: string;
}) {
  const [open, setOpen] = useState(false);
  const arrival = row.option.journeyArrival!;
  return <details onToggle={e => setOpen(e.currentTarget.open)} style={{ borderTop: '1px solid #e5e7eb', fontSize: 13 }}>
    <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer', color: '#174ea6' }}>See possible arrival times ▾</summary>
    {open && <>
      <ArrivalPlot values={arrival.distributionMs!} title={`Arrival at ${destination}`}
        markers={[
          ...(targetMs !== classMs ? [{ value: targetMs, label: 'Your target', color: '#25613c', dashed: true }] : []),
          { value: classMs, label: 'Class starts', color: '#a52a2a' },
          ...(walkMs !== undefined ? [{ value: walkMs, label: 'Walk estimate', color: '#56616e', dashed: true }] : []),
        ]}
        description="Filled dots show modeled shuttle arrival times, including the final walk and assuming you catch this bus. Dots after a deadline indicate possible late arrivals, not a validated chance of being late." />
      {row.caution && <p style={{ color: '#795000', lineHeight: 1.5 }}>{row.caution}</p>}
      <p style={{ fontSize: 12, color: '#5f6368', lineHeight: 1.5 }}>Walking is a single estimate, not a guarantee. Crossings and your pace can change it.</p>
      <ArrivalHistory route={row.option.routeLabel} stopId={row.option.alightStopId}
        etaSec={Math.max(0, (arrival.pointMs - Date.now()) / 1000 - row.option.walkFromSec)} />
      <p style={{ fontSize: 11, color: '#5f6368' }}>Recorded waits above end at the drop-off stop, before your final walk.</p>
    </>}
  </details>;
}
