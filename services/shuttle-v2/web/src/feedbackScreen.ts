import {clientBuild} from './shownLog';

export const FEEDBACK_SCREEN_MAX_ROWS = 32;
export interface FeedbackScreenRow {
  mode: 'walk' | 'shuttle'; route: string;
  boardStopId?: number; alightStopId?: number; busName?: string; stopsAhead?: number;
  pickupChoice?: string;
  board: string; next: string; arrive: string; legs: string; approaching: string;
}
export interface FeedbackScreen {
  v: 1; capturedAt: number; build: string; view: string; tripDetail: boolean;
  rows: FeedbackScreenRow[]; truncated: boolean;
}

const text = (value: unknown, max = 160) => typeof value === 'string'
  ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const integer = (value: unknown, minimum: number) => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647 ? value : undefined;

/** Whitelist public trip facts. Never copy a planner object, address or GPS fix. */
export function feedbackScreenRow(input: Record<string, unknown>): FeedbackScreenRow | null {
  const route = text(input.route, 80), mode = input.mode;
  if (!route || (mode !== 'walk' && mode !== 'shuttle')) return null;
  return {
    mode, route,
    ...(mode === 'shuttle' ? {
      boardStopId: integer(input.boardStopId, 1), alightStopId: integer(input.alightStopId, 1),
      busName: text(input.busName, 24) || undefined, stopsAhead: integer(input.stopsAhead, 0),
      pickupChoice: input.pickupChoice === 'closest-stop' || input.pickupChoice === 'arrive-sooner'
        ? input.pickupChoice : undefined,
    } : {}),
    board: text(input.board), next: text(input.next), arrive: text(input.arrive),
    legs: text(input.legs), approaching: text(input.approaching),
  };
}

export function feedbackScreenFromRows(rows: readonly Record<string, unknown>[],
  meta: { capturedAt: number; build: string; view: string; tripDetail: boolean }): FeedbackScreen {
  const valid = rows.map(feedbackScreenRow).filter((row): row is FeedbackScreenRow => row !== null);
  return {v: 1, capturedAt: meta.capturedAt, build: text(meta.build, 24), view: text(meta.view, 24),
    tripDetail: meta.tripDetail, rows: valid.slice(0, FEEDBACK_SCREEN_MAX_ROWS), truncated: valid.length > FEEDBACK_SCREEN_MAX_ROWS};
}

/** Read the rendered table, including its rounded times and unavailable states.
 * A form keeps this snapshot from opening through retries; later polls do not
 * replace the evidence. Off-screen rows on this tab count; hidden tabs do not. */
export function captureFeedbackScreen(view: string,
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
  now = Date.now()): FeedbackScreen | undefined {
  if (!doc) return undefined;
  try {
    const rows = [...doc.querySelectorAll<HTMLElement>('[data-testid="route-timing-table"] tbody[data-route]')]
      .filter(row => row.getClientRects().length > 0).map(row => {
        const cells = row.querySelectorAll(':scope > tr:first-child > td');
        const number = (name: string) => { const raw = row.getAttribute(name); return raw === null ? undefined : Number(raw); };
        return {
          mode: row.getAttribute('data-mode'), route: row.getAttribute('data-route'),
          boardStopId: number('data-pickup'), alightStopId: number('data-alight'),
          busName: row.getAttribute('data-board-bus'), stopsAhead: number('data-board-stops-ahead'),
          pickupChoice: row.getAttribute('data-pickup-choice'),
          board: (cells[0] as HTMLElement)?.innerText, next: (cells[1] as HTMLElement)?.innerText,
          arrive: (cells[2] as HTMLElement)?.innerText,
          legs: row.querySelector<HTMLElement>('[data-testid="journey-legs"]')?.innerText,
          approaching: row.querySelector<HTMLElement>('[data-testid="approaching-pickup"]')?.innerText,
        };
      });
    const detail = doc.querySelector('[data-testid="trip-detail-panel"]');
    return feedbackScreenFromRows(rows, {capturedAt: now, build: clientBuild(), view,
      tripDetail: !!detail?.getClientRects().length});
  } catch { return undefined; } // Diagnostic capture must never prevent feedback.
}
