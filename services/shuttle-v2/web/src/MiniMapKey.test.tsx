import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MiniMapKey, type TimingRow } from './MiniMapKey';
import type { TripOption } from './planner';

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
    expect(html).toContain('<td colSpan="3" style="padding:0 6px 6px"><span role="note" data-testid="stop-skip-warning"');
    expect(html).toContain(`>${warning}</span>`);
    expect(renderToStaticMarkup(<MiniMapKey rows={rows} destination="Union Station" />)).not.toContain('stop-skip-warning');
  });
  it('selects the route when anywhere on the row, including the pickup time, is tapped', () => {
    const select = vi.fn();
    const body = elements(MiniMapKey({ rows, destination: 'Union Station', onSelectRoute: select }))
      .find(e => e.type === 'tbody' && e.props['data-route'] === 'Red')!;
    (body.props.onClick as () => void)();
    expect(select).toHaveBeenCalledWith('Red');
  });
});
