import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MiniMapKey, type TimingRow } from './MiniMapKey';
import type { TripOption } from './planner';
import { ROUTE_LISTS } from './routes';

const now = Date.parse('2026-09-30T20:00:00-04:00');
const option: TripOption = { mode: 'shuttle', routeLabel: 'Red', color: '#c62828', busName: '307', boardStopId: 48,
  alightStopId: 121, walkToSec: 120, waitSec: 300, rideSec: 600, walkFromSec: 60, totalSec: 1080, directWalkSec: 1800, computedAtMs: now };
const rows: TimingRow[] = [{ option, status: 'Live',
  pickup: { routeLabel: 'Red', busName: '307', etaSec: 300, lowSec: 180, highSec: 540, computedAtMs: now,
    nextSec: 1500, nextBusName: '309', stopId: 48, distributionSec: [200, 300, 400] } }];

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
afterEach(() => vi.restoreAllMocks());

describe('route option arrival times', () => {
  it('keeps a request-only pickup visible with dispatch instructions and no passing-bus times', () => {
    const html = renderToStaticMarkup(<MiniMapKey rows={[{ ...rows[0]!, option: { ...option,
      routeLabel: 'Purple', boardStopId: 122,
      pickupRequest: { kind: 'call-dispatch', stopName: 'Union Station', message: 'Call Dispatch to request this stop.' } },
    }]} destination="Building 400" onSelectOption={()=>{}} />);
    expect(html).toContain('data-pickup-service="on-demand"');
    expect(html).toContain('On request'); expect(html).toContain('tel:+12032815470');
    expect(html).toContain('option 1'); expect(html).toContain('View Purple trip details');
    expect(html).not.toContain('pickup-range'); expect(html).not.toContain('route-next-arrival');
    expect(html).not.toContain('data-testid="destination-arrival"');
  });
  it('keeps an untimed closest pickup and a distinct farther action without an earlier-arrival claim', () => {
    const html=renderToStaticMarkup(<MiniMapKey rows={[
      {option:{...option,boardStopId:100,etaUnavailable:true,pickupPreference:'closest-stop'},pickupName:'Prospect/Canner',status:'Unavailable'},
      {option:{...option,boardStopId:129,pickupPreference:'more-walking'},pickupName:'Whitney/Canner',status:'Live'},
    ]} destination="Union Station" onSelectOption={()=>{}} />);
    expect(html).toContain('Closest stop');expect(html).toContain('More walking');expect(html).not.toContain('Arrive sooner');
    expect(html).toContain('View Red trip details from Whitney/Canner');expect(html).toContain('View Red trip details"');
    const closest=html.split('data-pickup="100"')[1]!.split('</tbody>')[0]!;
    expect(closest).toContain('Unavailable');expect(closest).toContain('Destination arrival unavailable');
    expect(closest).not.toContain('pickup-range');expect(closest).not.toContain('route-next-arrival');
  });
  // Expected foregrounds checked against the canonical palette's sRGB contrast.
  // Keep this at the rendered component boundary: a helper test would miss a
  // pill that still hard-codes white after the calculation changes.
  it.each(ROUTE_LISTS)('keeps $label text legible on its identifying color', route => {
    const darkText = ['Blue Weekend', 'Blue Night', 'Blue West', 'Orange Day', 'Orange Night', 'Orange East', 'Green', 'Gold'];
    const html = renderToStaticMarkup(<MiniMapKey rows={[{
      option: { ...option, routeLabel: route.label, color: route.color }, status: 'Live',
    }]} destination="Union Station" />);
    const pill = html.match(/<span data-testid="route-pill" style="([^"]*)"/)!;
    expect(pill[1]).toContain(`background:${route.color}`);
    expect(pill[1]).toContain(`color:${darkText.includes(route.label) ? '#000' : '#fff'}`);
  });
  it('keeps the walking label neutral rather than giving it a shuttle background', () => {
    const html = renderToStaticMarkup(<MiniMapKey rows={[{
      option: { ...option, mode: 'walk', routeLabel: 'Walk' }, status: 'Walk',
    }]} destination="Union Station" />);
    const pill = html.match(/<span data-testid="route-pill" style="([^"]*)"/)!;
    expect(pill[1]).toContain('background:transparent');
    expect(pill[1]).toContain('color:#5f6368');
  });
  it('adds an approaching bus forecast without replacing the selected boarding time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const html = renderToStaticMarkup(<MiniMapKey rows={[{...rows[0]!,earlyPickup:{busName:'309',eta:14,low:7,high:25}}]} destination="Union Station" />);
    expect(html).toContain('data-testid="pickup-range">~5 (3 – 9)</span>');
    expect(html).toContain('Approaching #309: &lt;1 min');
    expect(html).toContain('data-testid="route-next-arrival">~25 min</span>');
  });
  it('shows the pickup time as text, with no arrival chart dialog or second control', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const html = renderToStaticMarkup(<MiniMapKey rows={rows} destination="Union Station" onSelectRoute={() => {}} />);
    expect(html).toContain('data-testid="pickup-range">~5 (3 – 9)</span>');
    expect(html).not.toContain('<dialog');
    expect(html).not.toContain('aria-haspopup');
    expect([...html.matchAll(/<button\b[^>]*aria-label="([^"]*)"/g)].map(m => m[1])).toEqual(['View Red trip details']);
  });
  it('puts a skipped-stop warning on its own full-width line, and nothing when there is none', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const warning = '⚠️ 2 of the last 3 Red buses skipped Union Station (S). Try 100 Church Street South (4 min walk).';
    const html = renderToStaticMarkup(<MiniMapKey rows={[{ ...rows[0]!, warning }]} destination="Union Station" />);
    expect(html).toContain('<td colSpan="4" style="padding:0 6px 6px"><span role="note" data-testid="stop-skip-warning"');
    expect(html).toContain(`>${warning}</span>`);
    expect(renderToStaticMarkup(<MiniMapKey rows={rows} destination="Union Station" />)).not.toContain('stop-skip-warning');
  });
  it('gives the following arrival its own Next in column, measured from now rather than from the first bus', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const html = renderToStaticMarkup(<MiniMapKey rows={rows} destination="Union Station" />);
    expect(html).toMatch(/<th scope="col"[^>]*>Next in<\/th>/);
    expect(html).toContain('data-testid="route-next-arrival">~25 min</span>');
    expect(html).not.toContain('~20 min');
    expect(html).toContain('data-testid="pickup-range">~5 (3 – 9)</span>');
    expect(html).toContain('colSpan="4"');
  });
  it('uses the already-live following ETA without aging it a second time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    const row = { ...rows[0]!, pickup: { ...rows[0]!.pickup!, etaSec: 180, nextSec: 1380 } };
    expect(renderToStaticMarkup(<MiniMapKey rows={[row]} destination="Union Station" />))
      .toContain('data-testid="route-next-arrival">~23 min</span>');
  });
  it('keeps the following arrival when the current bus is at the pickup, including its next lap', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const row = { ...rows[0]!, pickup: { ...rows[0]!.pickup!, etaSec: 0, atPickup: true, nextSec: 300, nextBusName: '307' } };
    const html = renderToStaticMarkup(<MiniMapKey rows={[row]} destination="Union Station" />);
    expect(html).toContain('>At stop</span>');
    expect(html).toContain('data-testid="route-next-arrival">~5 min</span>');
  });
  it('shows a sub-minute following arrival without false second precision', () => {
    const row = { ...rows[0]!, pickup: { ...rows[0]!.pickup!, etaSec: 0, nextSec: 30 } };
    expect(renderToStaticMarkup(<MiniMapKey rows={[row]} destination="Union Station" />))
      .toContain('data-testid="route-next-arrival">&lt;1 min</span>');
  });
  it.each([undefined, null, NaN, Infinity, -1, 299])('does not invent a following arrival for missing, invalid or earlier nextSec %s', nextSec => {
    const row = { ...rows[0]!, pickup: { ...rows[0]!.pickup!, nextSec } };
    const html = renderToStaticMarkup(<MiniMapKey rows={[row]} destination="Union Station" />);
    expect(html).toContain('aria-label="Following arrival unavailable">—</span>');
    expect(html).not.toContain('data-testid="route-next-arrival"');
  });
  it.each(['walk', 'departed', 'unavailable', 'scheduled'])('leaves Next in unavailable for %s rows', state => {
    const row: TimingRow = { ...rows[0]!, option: { ...option,
      mode: state === 'walk' ? 'walk' : 'shuttle', departed: state === 'departed', etaUnavailable: state === 'unavailable' },
      pickup: state === 'scheduled' ? undefined : rows[0]!.pickup };
    expect(renderToStaticMarkup(<MiniMapKey rows={[row]} destination="Union Station" />))
      .toContain('aria-label="Following arrival unavailable">—</span>');
  });
  it('selects the route when anywhere on the row, including the pickup time, is tapped', () => {
    const select = vi.fn();
    const body = elements(MiniMapKey({ rows, destination: 'Union Station', onSelectRoute: select }))
      .find(e => e.type === 'tbody' && e.props['data-route'] === 'Red')!;
    (body.props.onClick as () => void)();
    expect(select).toHaveBeenCalledWith('Red');
  });
  it('names two pickups on one line and selects the exact trip rather than just its route', () => {
    const select = vi.fn();
    const choices: TimingRow[] = [
      { ...rows[0]!, option: { ...option, pickupPreference: 'closest-stop' }, pickupName: 'Prospect/Canner' },
      { ...rows[0]!, option: { ...option, boardStopId: 129, pickupPreference: 'arrive-sooner' }, pickupName: 'Whitney/Canner' },
    ];
    const html = renderToStaticMarkup(<MiniMapKey rows={choices} destination="Union Station" onSelectOption={select} />);
    expect(html).toContain('aria-label="View Red trip details" aria-describedby="pickup-Red-48-121"');
    expect(html).toContain('id="pickup-Red-48-121"');
    expect(html).toContain('View Red trip details from Whitney/Canner');
    expect(html).toContain('Closest stop');
    expect(html).toContain('Arrive sooner');
    const body = elements(MiniMapKey({ rows: choices, destination: 'Union Station', onSelectOption: select }))
      .find(e => e.type === 'tbody' && e.props['data-pickup'] === 129)!;
    (body.props.onClick as () => void)();
    expect(select).toHaveBeenCalledWith(choices[1]!.option);
  });
});
