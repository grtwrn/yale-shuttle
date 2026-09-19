import { ArrivalDetails, type ArrivalDetailsProps } from './ArrivalDetails';
import { DestinationArrival } from './DestinationArrival';
import type { TripOption } from './planner';

export interface TimingRow {
  option: TripOption;
  pickup?: ArrivalDetailsProps;
  status: string;
  note?: string;
}

/** The map key owns arrival estimates; route cards describe the journey legs. */
export function MiniMapKey({ rows, destination, departureMs }: {
  rows: TimingRow[]; destination: string; departureMs?: number;
}) {
  return <table aria-label="Route arrival times" data-testid="route-timing-table"
    style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 11, lineHeight: '16px', color: '#263238', textAlign: 'left' }}>
    <colgroup><col style={{ width: '23%' }} /><col style={{ width: '37%' }} /><col style={{ width: '40%' }} /></colgroup>
    <thead style={{ position: 'sticky', top: 0, background: 'rgba(255,255,255,0.96)' }}><tr style={{ color: '#5f6368', fontSize: 10 }}>
      <th scope="col" style={{ padding: '2px 5px', fontWeight: 400 }}>Route</th>
      <th scope="col" style={{ padding: '2px 5px', fontWeight: 400 }}>At stop (min)</th>
      <th scope="col" style={{ padding: '2px 5px', fontWeight: 400, textAlign: 'right' }}>At destination</th>
    </tr></thead>
    <tbody>{rows.map(({ option, pickup, status, note }) => <tr key={option.routeLabel} data-route={option.routeLabel}>
      <th scope="row" style={{ padding: '2px 5px', fontWeight: 600, color: option.mode === 'walk' ? '#5f6368' : option.color, overflowWrap: 'anywhere' }}>
        <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 3, verticalAlign: 'middle', marginRight: 4, borderRadius: 1, background: option.mode === 'walk' ? '#9aa0a6' : option.color }} />
        {option.routeLabel}
      </th>
      <td style={{ padding: '0 5px' }}>
        {pickup ? <ArrivalDetails {...pickup} variant="table" /> : <span style={{ display: 'block', padding: '3px 0' }}>{status}</span>}
        {note && <span role="note" style={{ display: 'block', fontSize: 11, color: '#795000', paddingBottom: 3 }}>{note}</span>}
      </td>
      <td style={{ padding: '2px 5px', textAlign: 'right' }}>
        {option.departed || option.etaUnavailable ? <span aria-label="Destination arrival unavailable">—</span>
          : <DestinationArrival compact option={option} destination={destination} departureMs={departureMs} />}
      </td>
    </tr>)}</tbody>
  </table>;
}
