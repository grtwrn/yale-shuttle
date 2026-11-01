import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrivalDetails, BusHoldCaption } from './ArrivalDetails';

afterEach(() => vi.restoreAllMocks());

describe('visible waiting-bus context', () => {
  it('names the waiting shuttle and explains the departure dependency without inventing its departure time', () => {
    const html = renderToStaticMarkup(<BusHoldCaption busName="#46" holdingAt="333 Cedar" />);
    expect(html).toContain('role="note"');
    expect(html).toContain('Shuttle #46 is waiting at 333 Cedar. Arrival timing depends on when it leaves.');
    expect(html).not.toMatch(/unavailable|offline|no service|leaves in|departures? in/i);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<dialog');
  });

  it.each([
    { busName: '46', holdingAt: undefined },
    { busName: '46', holdingAt: '' },
    { busName: '46', holdingAt: '   ' },
    { busName: '', holdingAt: '333 Cedar' },
    { busName: '46', holdingAt: '333 Cedar', atPickup: true },
  ])('withholds an unsupported or already-at-pickup waiting note: %j', props => {
    expect(renderToStaticMarkup(<BusHoldCaption {...props} />)).toBe('');
  });

  it('keeps the table quote as plain text so its caller can place waiting context across the full row', () => {
    const now = Date.parse('2026-11-01T22:20:28.097Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const html = renderToStaticMarkup(<ArrivalDetails routeLabel="Blue Weekend" busName="46" stopId={150}
      etaSec={229} lowSec={8} highSec={903} computedAtMs={now} holdingAt="333 Cedar" variant="table" />);
    expect(html).toContain('data-testid="route-pickup"');
    expect(html).toContain('data-testid="pickup-range"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<dialog');
  });
});
