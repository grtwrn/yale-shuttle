import { Fragment } from 'react';
import { fmtClock } from './format';
import type { TripOption } from './planner';

type ArrivalOption = Pick<TripOption, 'mode' | 'totalSec' | 'journeyArrival' | 'departed' | 'etaUnavailable'>;

/** Presentation only: the journey already joins the catchable pickup to its
 * forward destination visit and adds the final walk. Never add pickup and ride
 * bounds here, or substitute the countdown bus's window for this journey. */
export function destinationArrivalView(option: ArrivalOption, now: number, departureMs?: number) {
  if (option.departed || option.etaUnavailable || !Number.isFinite(now)) return null;
  const clock = (at: number) => {
    const date = new Date(at);
    const prefix = date.toDateString() === new Date(now).toDateString() ? ''
      : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, `;
    return prefix + fmtClock(0, date);
  };
  const arrival = option.mode === 'shuttle' && departureMs === undefined ? option.journeyArrival : undefined;
  if (arrival && [arrival.pointMs, arrival.lowMs, arrival.highMs].every(Number.isFinite)
    && arrival.highMs >= arrival.lowMs && arrival.pointMs >= now) {
    const low = clock(Math.floor(arrival.lowMs / 60_000) * 60_000);
    const high = clock(Math.ceil(arrival.highMs / 60_000) * 60_000);
    return {
      text: `${low}–${high}`,
      kind: 'window' as const,
      description: `Estimated arrival window, including the final walk, if you catch shuttle #${arrival.busName.replace(/^#/, '')}. Arrival can be earlier or later.${arrival.catchRisk ? ' The shuttle could reach pickup before you.' : ''}${arrival.estimated ? ' Limited trip data; allow extra time.' : ''}`,
    };
  }
  const point = (departureMs ?? now) + option.totalSec * 1000;
  if (!Number.isFinite(point) || !Number.isFinite(option.totalSec) || option.totalSec < 0) return null;
  return {
    text: `~${clock(point)}`,
    kind: 'point' as const,
    description: option.mode === 'walk' ? 'Estimated arrival on foot; your pace and crossings can change it.'
      : departureMs !== undefined ? 'Estimated arrival for your planned departure. A live arrival window is not available yet.'
        : 'Estimated arrival, including the final walk. An arrival window is not available for this trip.',
  };
}

export function DestinationArrival({ option, destination, departureMs, now = Date.now(), compact = false }: {
  option: ArrivalOption; destination: string; departureMs?: number | undefined; now?: number; compact?: boolean;
}) {
  const view = destinationArrivalView(option, now, departureMs);
  if (!view) return null;
  return <span data-testid="destination-arrival" data-kind={view.kind}
    aria-label={`Estimated arrival at ${destination}: ${view.text}. ${view.description}`}
    title={view.description}
    style={{ flexShrink: 0, maxWidth: compact ? undefined : '60%', textAlign: 'right', color: '#202124', fontSize: compact ? 11 : 16, fontWeight: 600 }}>
    {!compact && <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: '#5f6368' }}>At destination</span>}
    <span style={{ display: compact ? 'inline' : 'block', fontVariantNumeric: 'tabular-nums' }}>{view.text.split('–').map((endpoint, i) => {
      // A date can wrap above its clock; the digits of a clock stay together.
      const timeAt = endpoint.lastIndexOf(' ') + 1;
      return <Fragment key={i}>{i > 0 && <>–<wbr /></>}{endpoint.slice(0, timeAt)}<span style={{ whiteSpace: 'nowrap' }}>{endpoint.slice(timeAt)}</span></Fragment>;
    })}</span>
  </span>;
}
