import { ArrivalDetails, type ArrivalDetailsProps } from './ArrivalDetails';
import { DestinationArrival } from './DestinationArrival';
import type { TripOption } from './planner';
import { fmtMin, fmtWalk } from './format';

function RoutePill({ option }: { option: TripOption }) {
  return <span data-testid="route-pill" style={{ display: 'inline-block', maxWidth: '100%', boxSizing: 'border-box',
    padding: '3px 7px', borderRadius: 6, fontWeight: 600, lineHeight: '16px',
    background: option.mode === 'walk' ? 'transparent' : option.color,
    color: option.mode === 'walk' ? '#5f6368' : '#fff',
    border: option.mode === 'walk' ? '1px solid #dadce0' : undefined }}>{option.routeLabel}</span>;
}

export interface TimingRow {
  option: TripOption;
  pickup?: ArrivalDetailsProps;
  status: string;
  note?: string;
}

/** One route entry owns arrivals, journey legs, and navigation to its details. */
export function MiniMapKey({ rows, destination, departureMs, onSelectRoute }: {
  rows: TimingRow[]; destination: string; departureMs?: number;
  onSelectRoute?: (routeLabel: string) => void;
}) {
  return <table aria-label="Route arrival times" data-testid="route-timing-table"
    style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, color: '#374151', textAlign: 'left' }}>
    <colgroup><col style={{ width: '23%' }} /><col style={{ width: '37%' }} /><col style={{ width: '40%' }} /></colgroup>
    <thead><tr style={{ color: '#5f6368', fontSize: 11 }}>
      <th scope="col" style={{ padding: '8px 6px 4px', fontWeight: 500 }}>Route</th>
      <th scope="col" style={{ padding: '8px 6px 4px', fontWeight: 500 }}>Board in <span style={{ fontWeight: 400 }}>(min)</span></th>
      <th scope="col" style={{ padding: '8px 6px 4px', fontWeight: 500, textAlign: 'right' }}>Arrive at</th>
    </tr></thead>
    {rows.map(({ option, pickup, status, note }) => <tbody key={option.routeLabel} data-route={option.routeLabel}
      onClick={onSelectRoute ? () => onSelectRoute(option.routeLabel) : undefined}
      style={{ borderTop: '1px solid #eceff1', cursor: onSelectRoute ? 'pointer' : undefined }}>
      <tr>
        <th scope="row" style={{ padding: '0 6px', fontWeight: 650, color: option.mode === 'walk' ? '#5f6368' : option.color, overflowWrap: 'anywhere' }}>
          {onSelectRoute ? <button type="button" aria-label={`View ${option.routeLabel} trip details`}
            onClick={event => { event.stopPropagation(); onSelectRoute(option.routeLabel); }}
            style={{ display: 'inline-block', width: '100%', minHeight: 44, padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer', overflowWrap: 'anywhere' }}>
            <RoutePill option={option} />
          </button> : <RoutePill option={option} />}
        </th>
        <td style={{ padding: '0 6px' }}>
          {pickup ? <ArrivalDetails {...pickup} variant="table" /> : <span style={{ display: 'block', padding: '12px 0' }}>{status}</span>}
          {note && <span role="note" style={{ display: 'block', fontSize: 11, color: '#795000', paddingBottom: 6 }}>{note}</span>}
        </td>
        <td style={{ padding: '6px', textAlign: 'right' }}>
          {option.departed || option.etaUnavailable ? <span aria-label="Destination arrival unavailable">—</span>
            : <DestinationArrival compact option={option} destination={destination} departureMs={departureMs} />}
        </td>
      </tr>
      <tr><td colSpan={3} style={{ padding: '0 6px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span data-testid="journey-legs" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5, flex: 1, minWidth: 0, fontSize: 12, color: '#5f6368' }}>
            {option.mode === 'walk' ? <span>🚶 {fmtWalk(option.totalSec)}</span> : <>
              {option.walkToSec > 0 && <><span style={{ whiteSpace: 'nowrap' }}>🚶 {fmtWalk(option.walkToSec)}</span><span aria-hidden="true">›</span></>}
              <span style={{ whiteSpace: 'nowrap' }}>🚌 {fmtMin(option.rideSec)}</span>
              {option.walkFromSec > 0 && <><span aria-hidden="true">›</span><span style={{ whiteSpace: 'nowrap' }}>🚶 {fmtWalk(option.walkFromSec)}</span></>}
            </>}
          </span>
          {onSelectRoute && <span aria-hidden="true" style={{ color: '#9aa0a6', fontSize: 16 }}>›</span>}
        </div>
      </td></tr>
    </tbody>)}
  </table>;
}
