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
    style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, color: '#374151', textAlign: 'left' }}>
    <colgroup><col style={{ width: '23%' }} /><col style={{ width: '37%' }} /><col style={{ width: '40%' }} /></colgroup>
    <thead><tr style={{ color: '#5f6368', fontSize: 11 }}>
      <th scope="col" style={{ padding: '8px 6px 4px', fontWeight: 500 }}>Route</th>
      <th scope="col" style={{ padding: '8px 6px 4px', fontWeight: 500 }}>At stop <span style={{ fontWeight: 400 }}>(in min)</span></th>
      <th scope="col" style={{ padding: '8px 6px 4px', fontWeight: 500, textAlign: 'right' }}>At destination</th>
    </tr></thead>
    <tbody>{rows.map(({ option, pickup, status, note }) => <tr key={option.routeLabel} data-route={option.routeLabel}
      style={{ borderTop: '1px solid #eceff1' }}>
      <th scope="row" style={{ padding: '6px', fontWeight: 650, color: option.mode === 'walk' ? '#5f6368' : option.color, overflowWrap: 'anywhere' }}>
        {option.routeLabel}
      </th>
      <td style={{ padding: '0 6px' }}>
        {pickup ? <ArrivalDetails {...pickup} variant="table" /> : <span style={{ display: 'block', padding: '12px 0' }}>{status}</span>}
        {note && <span role="note" style={{ display: 'block', fontSize: 11, color: '#795000', paddingBottom: 6 }}>{note}</span>}
      </td>
      <td style={{ padding: '6px', textAlign: 'right' }}>
        {option.departed || option.etaUnavailable ? <span aria-label="Destination arrival unavailable">—</span>
          : <DestinationArrival compact option={option} destination={destination} departureMs={departureMs} />}
      </td>
    </tr>)}</tbody>
  </table>;
}
