import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrivalPlot } from './ArrivalPlot';
import { ArrivalHistory } from './ArrivalHistory';
import { fmtMin, remainingSec } from './format';
import { arrivalSummary, estimatedGap } from './arrivalDetails';

export interface ArrivalDetailsProps {
  routeLabel: string;
  busName: string;
  etaSec: number;
  distributionSec?: number[];
  stopId?: number;
  lowSec?: number;
  highSec?: number;
  computedAtMs?: number;
  nextSec?: number | null;
  nextBusName?: string;
  stopsAway?: number | null;
  holdingAt?: string;
  atPickup?: boolean;
  variant?: 'card' | 'table';
}

export function ArrivalDetails(props: ArrivalDetailsProps) {
  const { routeLabel, busName, etaSec, lowSec, highSec, computedAtMs, nextSec, distributionSec, stopId, nextBusName, stopsAway, holdingAt, atPickup } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const titleId = useId();
  const { point, band } = arrivalSummary(etaSec, lowSec, highSec, computedAtMs, Date.now(), atPickup);
  const gap = estimatedGap(etaSec, nextSec);
  const next = gap !== null ? (nextSec! < 60 ? '<1 min' : fmtMin(nextSec!)) : null;
  const pickup = atPickup ? 'At your stop' : `Arrives in ${etaSec < 60 ? '<1 min' : `~${fmtMin(etaSec)}`}`;
  const table = props.variant === 'table';
  const compact = atPickup ? 'At stop' : `${etaSec < 60 ? '<1' : `~${fmtMin(etaSec).replace(' min', '')}`}${band ? ` (${band.text.replace(' min', '')})` : ''}`;
  const sameBus = !!nextBusName && nextBusName.replace(/^#/, '') === busName.replace(/^#/, '');
  const dots = distributionSec?.map(s => now + remainingSec(s, computedAtMs, now) * 1000);
  // An interval bar communicates the three known quantiles without inventing
  // a bell curve or a density from only three numbers.
  const extent = Math.max(60, etaSec, band?.highSec ?? 0);
  const position = (sec: number) => `${Math.max(0, Math.min(100, 100 * sec / extent))}%`;
  const valueStyle = { margin: 0, fontWeight: 600, textAlign: 'right' as const };
  return <>
    <button type="button" aria-haspopup="dialog" aria-label={`${routeLabel} arrival details: ${pickup}${band ? `, likely ${band.text}` : ''}${next ? `, next in ${next}` : ''}`}
      onKeyDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); dialog.current?.showModal(); setOpen(true); }}
      style={{ border: 0, background: 'transparent', padding: '4px 0', minHeight: 44, minWidth: 0, color: '#374151', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}>
      <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
        {table ? <span data-testid={band ? 'pickup-range' : undefined}>{compact}</span> : <>{pickup}{band && <span data-testid="pickup-range" style={{ fontWeight: 400, color: '#5f6368' }}>, {band.text} range</span>}</>}
      </span>
      {next && <span style={{ display: 'block', fontSize: 12, color: '#5f6368' }}>{table ? `Next ${next.startsWith('<') ? '' : '~'}${next.replace(' min', '')}` : `Next in ${next.startsWith('<') ? next : `~${next}`}`}</span>}
    </button>
    {createPortal(<dialog ref={dialog} aria-labelledby={titleId} onClose={() => setOpen(false)} onKeyDown={e => e.stopPropagation()} onClick={e => {
      e.stopPropagation();
      if (e.target === e.currentTarget) {
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.currentTarget.close();
      }
    }} style={{ fontFamily: 'Arial, sans-serif', boxSizing: 'border-box', width: 'min(420px, calc(100vw - 24px))', maxHeight: '85dvh', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 18, padding: 22, color: '#202124', background: '#fff', boxShadow: '0 12px 60px #0004' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h2 id={titleId} style={{ margin: 0, fontSize: 19 }}>{routeLabel} arrival</h2>
        <button type="button" autoFocus aria-label="Close arrival details" onClick={e => { e.stopPropagation(); dialog.current?.close(); }}
          style={{ minWidth: 44, minHeight: 44, border: 0, background: '#f3f4f6', borderRadius: '50%', fontSize: 22, cursor: 'pointer' }}>×</button>
      </div>
      <p style={{ margin: '18px 0 4px', fontSize: 28, fontWeight: 650 }}>{point}</p>
      {band && !atPickup ? <>
        <p style={{ margin: 0, color: '#4b5563' }}>Likely arrival window: <strong>{band.text}</strong></p>
        <p style={{ fontSize: 13, lineHeight: 1.5, color: '#5f6368' }}>Use the early end of the estimated window when deciding when to reach your stop.</p>
      </> : !atPickup ? <p style={{ color: '#5f6368', fontSize: 13 }}>An arrival window is not available yet.</p> : null}
      {holdingAt && !atPickup && <p style={{ padding: 12, borderRadius: 10, background: '#fff8e1', fontSize: 13, lineHeight: 1.5 }}>Waiting at {holdingAt}. The window may stay wide until the shuttle leaves.</p>}
      <dl style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '14px 18px', fontSize: 14, borderTop: '1px solid #e5e7eb', paddingTop: 18, marginBottom: 0 }}>
        <dt>Shuttle</dt><dd style={valueStyle}>#{busName.replace(/^#/, '')}</dd>
        {stopsAway != null && <><dt>Stops to pickup</dt><dd style={valueStyle}>{stopsAway}</dd></>}
        {next ? <>
          <dt>{sameBus ? 'Next pass by this shuttle' : 'Following shuttle'}{nextBusName && !sameBus ? ` · #${nextBusName.replace(/^#/, '')}` : ''}</dt>
          <dd style={valueStyle}>{gap! < 60 ? '<1 min' : `About ${fmtMin(gap!)}`} later</dd>
        </> : <><dt>Next arrival</dt><dd style={valueStyle}>Not available</dd></>}
      </dl>
      {next && <p style={{ fontSize: 12, lineHeight: 1.5, color: '#5f6368', marginBottom: 0 }}>The following arrival is estimated in about {next} from now. Both arrival estimates can change.</p>}
      {open && stopId !== undefined && <ArrivalHistory route={routeLabel} stopId={stopId} etaSec={etaSec} busName={busName} />}
      {band && !atPickup && <details style={{ borderTop: '1px solid #e5e7eb', marginTop: 16, fontSize: 13 }}>
        <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer', color: '#174ea6' }}>Forecast for this shuttle ▾</summary>
        {dots?.length ? <ArrivalPlot values={dots} title="Model estimate for this shuttle"
          markers={[{ value: now + etaSec * 1000, label: 'Estimate', color: '#174ea6' }]}
          description="Predicted pickup times for this shuttle. Taller stacks show times the forecast considers more likely." /> : <>
          <div role="img" aria-label={`Likely arrival window ${band.text}; estimate ${fmtMin(etaSec)}`} style={{ margin: '30px 6px 22px' }}>
            <div style={{ height: 8, position: 'relative', background: '#e5e7eb', borderRadius: 5 }}>
              <span style={{ position: 'absolute', left: position(band.lowSec), right: position(extent - band.highSec), height: 8, borderRadius: 5, background: '#a8c7fa' }} />
              <span style={{ position: 'absolute', left: position(etaSec), top: -5, height: 18, width: 4, borderRadius: 2, background: '#174ea6', transform: 'translateX(-50%)' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#5f6368', marginTop: 8 }}><span>Now</span><span>{Math.ceil(extent / 60)} min</span></div>
          </div>
        </>}
      </details>}
    </dialog>, document.body)}
  </>;
}
