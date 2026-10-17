import { ArrivalDetails, type ArrivalDetailsProps } from './ArrivalDetails';
import { DestinationArrival } from './DestinationArrival';
import type { TripOption } from './planner';
import { fmtMin, fmtWalk } from './format';
import { estimatedGap } from './arrivalDetails';
import { EarlyPickupNotice, type EarlyPickupForecast } from './EarlyPickupNotice';

/** Choose the stronger text contrast on the canonical six-digit route color. */
function routePillTextColor(color: string): '#000' | '#fff' {
  const rgb = parseInt(color.slice(1), 16);
  const [r, g, b] = [16, 8, 0].map(shift => {
    const channel = ((rgb >> shift) & 255) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000' : '#fff';
}

function RoutePill({ option }: { option: TripOption }) {
  return <span data-testid="route-pill" style={{ display: 'inline-block', maxWidth: '100%', boxSizing: 'border-box',
    padding: '3px', borderRadius: 6, fontWeight: 600, lineHeight: '16px',
    background: option.mode === 'walk' ? 'transparent' : option.color,
    color: option.mode === 'walk' ? '#5f6368' : routePillTextColor(option.color),
    border: option.mode === 'walk' ? '1px solid #dadce0' : undefined }}>{option.routeLabel}</span>;
}

export interface TimingRow {
  option: TripOption;
  pickup?: ArrivalDetailsProps;
  status: string;
  note?: string;
  /** Full-width notice under the times, e.g. recent buses skipping the pickup (stopSkips.ts). */
  warning?: string;
  pickupName?: string;
  earlyPickup?: EarlyPickupForecast;
}

/** One route entry owns arrivals, journey legs, and navigation to its details. */
export function MiniMapKey({ rows, destination, departureMs, onSelectRoute, onSelectOption }: {
  rows: TimingRow[]; destination: string; departureMs?: number;
  onSelectRoute?: (routeLabel: string) => void;
  onSelectOption?: (option: TripOption) => void;
}) {
  const canSelect = !!(onSelectOption || onSelectRoute);
  const select = (option: TripOption) => onSelectOption ? onSelectOption(option) : onSelectRoute?.(option.routeLabel);
  return <table aria-label="Route arrival times" data-testid="route-timing-table"
    style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, color: '#374151', textAlign: 'left' }}>
    <colgroup><col style={{ width: '27%' }} /><col style={{ width: '26%' }} /><col style={{ width: '18%' }} /><col style={{ width: '29%' }} /></colgroup>
    <thead><tr style={{ color: '#5f6368', fontSize: 11 }}>
      <th scope="col" style={{ padding: '8px 6px 4px', fontWeight: 500 }}>Route</th>
      <th scope="col" style={{ padding: '8px 6px 4px', fontWeight: 500 }}>Board in <span style={{ fontWeight: 400 }}>(min)</span></th>
      <th scope="col" style={{ padding: '8px 6px 4px', fontWeight: 500 }}>Next in</th>
      <th scope="col" style={{ padding: '8px 6px 4px', fontWeight: 500, textAlign: 'right' }}>Arrive at</th>
    </tr></thead>
    {rows.map(({ option, pickup, status, note, warning, pickupName, earlyPickup }) => <tbody
      key={`${option.routeLabel}:${option.boardStopId}:${option.alightStopId}`} data-route={option.routeLabel} data-pickup={option.boardStopId}
      data-mode={option.mode} data-alight={option.alightStopId} data-pickup-choice={option.pickupPreference}
      data-board-bus={pickup?.busName} data-board-stops-ahead={pickup?.stopsAway}
      data-countdown-bus={option.mode === 'shuttle' ? option.busName : undefined}
      onClick={canSelect ? () => select(option) : undefined}
      style={{ borderTop: '1px solid #eceff1', cursor: canSelect ? 'pointer' : undefined }}>
      <tr>
        <th scope="row" style={{ padding: '0 6px', fontWeight: 650, color: option.mode === 'walk' ? '#5f6368' : option.color, overflowWrap: 'anywhere' }}>
          {canSelect ? <button type="button" aria-label={`View ${option.routeLabel} trip details${pickupName && option.pickupPreference === 'arrive-sooner' ? ` from ${pickupName}` : ''}`}
            aria-describedby={pickupName ? `pickup-${option.routeLabel.replace(/\s/g, '-')}-${option.boardStopId}-${option.alightStopId}` : undefined}
            onClick={event => { event.stopPropagation(); select(option); }}
            style={{ display: 'inline-block', width: '100%', minHeight: 44, padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer', overflowWrap: 'anywhere' }}>
            <RoutePill option={option} />
          </button> : <RoutePill option={option} />}
        </th>
        <td style={{ padding: '0 6px' }}>
          {pickup ? <ArrivalDetails {...pickup} variant="table" /> : <span style={{ display: 'block', padding: '12px 0' }}>{status}</span>}
          {note && <span role="note" style={{ display: 'block', fontSize: 11, color: '#795000', paddingBottom: 6 }}>{note}</span>}
        </td>
        <td style={{ padding: '6px' }}>
          {/* nextSec is the already-live following arrival from now, not the gap after Board in. */}
          {option.mode === 'shuttle' && !option.departed && !option.etaUnavailable && pickup
            && estimatedGap(pickup.etaSec, pickup.nextSec) !== null && pickup.nextSec! >= 0
            ? <span data-testid="route-next-arrival">{pickup.nextSec! < 60 ? '<1 min' : '~' + fmtMin(pickup.nextSec!)}</span>
            : <span aria-label="Following arrival unavailable">—</span>}
        </td>
        <td style={{ padding: '6px', textAlign: 'right' }}>
          {option.departed || option.etaUnavailable ? <span aria-label="Destination arrival unavailable">—</span>
            : <DestinationArrival compact option={option} destination={destination} departureMs={departureMs} />}
        </td>
      </tr>
      {pickupName && <tr><td colSpan={4} style={{ padding: '0 6px 4px', fontSize: 12 }}>
        <span id={`pickup-${option.routeLabel.replace(/\s/g, '-')}-${option.boardStopId}-${option.alightStopId}`} data-testid="pickup-choice-name" style={{ fontWeight: 600 }}>{pickupName}</span>
        {option.pickupPreference && <span style={{ color: '#5f6368' }}> · {option.pickupPreference === 'closest-stop' ? 'Closest stop' : 'Arrive sooner'}</span>}
      </td></tr>}
      {earlyPickup && <tr><td colSpan={4} style={{ padding: '0 6px 6px' }}>
        <EarlyPickupNotice arrival={earlyPickup} walkSec={option.walkToSec} />
      </td></tr>}
      {warning && <tr><td colSpan={4} style={{ padding: '0 6px 6px' }}>
        <span role="note" data-testid="stop-skip-warning" style={{ display: 'block', padding: '4px 6px', borderRadius: 6,
          background: '#fff8e1', color: '#795000', fontSize: 12, lineHeight: '16px' }}>{warning}</span>
      </td></tr>}
      <tr><td colSpan={4} style={{ padding: '0 6px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span data-testid="journey-legs" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5, flex: 1, minWidth: 0, fontSize: 12, color: '#5f6368' }}>
            {option.mode === 'walk' ? <span>🚶 {fmtWalk(option.totalSec)}</span> : <>
              {option.walkToSec > 0 && <><span style={{ whiteSpace: 'nowrap' }}>🚶 {fmtWalk(option.walkToSec)}</span><span aria-hidden="true">›</span></>}
              <span style={{ whiteSpace: 'nowrap' }}>🚌 {fmtMin(option.rideSec)}</span>
              {option.walkFromSec > 0 && <><span aria-hidden="true">›</span><span style={{ whiteSpace: 'nowrap' }}>🚶 {fmtWalk(option.walkFromSec)}</span></>}
            </>}
          </span>
          {canSelect && <span aria-hidden="true" style={{ color: '#9aa0a6', fontSize: 16 }}>›</span>}
        </div>
      </td></tr>
    </tbody>)}
  </table>;
}
