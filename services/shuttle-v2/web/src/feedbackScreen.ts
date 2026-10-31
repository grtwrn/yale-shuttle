import {clientBuild} from './shownLog';
import type {FeedbackSourceReceipt} from '../../src/schema/api';
export type {FeedbackSourceReceipt} from '../../src/schema/api';

export const FEEDBACK_SCREEN_MAX_ROWS = 32;
export interface FeedbackScreenSource extends FeedbackSourceReceipt { receivedAt: number }
const sources = new WeakMap<readonly object[], FeedbackScreenSource>();
const sourceFailures = new WeakMap<readonly object[], 'not-supplied' | 'invalid'>();
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clock = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Whitelist diagnostic metadata. Never copy arbitrary header/report objects. */
export function feedbackSourceReceipt(input: unknown): FeedbackSourceReceipt | undefined {
  if (!record(input) || input.v !== 1 || !sha(input.snapshotId) || !sha(input.sha256)
    || !clock(input.bytes) || input.bytes > 2 * 1024 * 1024 || typeof input.build !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}$/.test(input.build) || !(input.modelAt === null || clock(input.modelAt))
    || !(input.servedAt === null || clock(input.servedAt))
    || (input.modelAt !== null && input.servedAt !== null && input.modelAt > input.servedAt)) return undefined;
  const result: FeedbackSourceReceipt = { v: 1, snapshotId: input.snapshotId, sha256: input.sha256,
    bytes: input.bytes, build: input.build, modelAt: input.modelAt, servedAt: input.servedAt };
  if (input.evaluation !== undefined) {
    const e = input.evaluation;
    if (!record(e) || typeof e.epoch !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(e.epoch)
      || !clock(e.cursor) || e.cursor === 0 || !clock(e.at) || e.at !== result.modelAt || !sha(e.sha256)) return undefined;
    result.evaluation = { epoch: e.epoch, cursor: e.cursor, at: e.at, sha256: e.sha256 };
  }
  return result;
}

/** The source belongs to this immutable bus-array publication, never a mutable
 * global 'latest feed'. The DOM serializes it in the same React commit as rows. */
export function bindFeedbackSource(buses: readonly object[], header: string | null, wire: unknown, receivedAt: number): void {
  sources.delete(buses);
  sourceFailures.set(buses, header ? 'invalid' : 'not-supplied');
  try {
    if (!header || header.length > 2048 || !clock(receivedAt)) return;
    const source = feedbackSourceReceipt(JSON.parse(header));
    if (!source) return;
    const w = record(wire) ? wire : {};
    if (source.modelAt !== (clock(w.at) ? w.at : null) || source.servedAt !== (clock(w.servedAt) ? w.servedAt : null)) return;
    sources.set(buses, { ...source, receivedAt });
    sourceFailures.delete(buses);
  } catch { /* Older servers and broken diagnostic headers cannot break a poll. */ }
}
export function feedbackSourceForBuses(buses: readonly object[]): FeedbackScreenSource | undefined {
  const source = sources.get(buses);
  return source ? { ...source, ...(source.evaluation ? { evaluation: { ...source.evaluation } } : {}) } : undefined;
}
export function feedbackSourceMetadata(buses: readonly object[]) {
  return feedbackSourceForBuses(buses) ?? { unavailable: sourceFailures.get(buses) ?? 'not-supplied' };
}
export interface FeedbackScreenRow {
  mode: 'walk' | 'shuttle'; route: string;
  boardStopId?: number; alightStopId?: number; busName?: string; countdownBusName?: string; stopsAhead?: number;
  pickupChoice?: string;
  board: string; next: string; arrive: string; legs: string; approaching: string;
}
export interface FeedbackNavigationIntent {
  provider: 'google-maps'; mode: 'walking'; publicStopId: number;
  walkLabel: string; requestedAt: number;
  source?: FeedbackSourceReceipt;
}
export interface FeedbackScreen {
  v: 1; capturedAt: number; build: string; view: string; tripDetail: boolean;
  rows: FeedbackScreenRow[]; truncated: boolean;
  source?: FeedbackScreenSource;
  sourceScope: 'public-input-for-render';
  sourceUnavailable?: 'not-supplied' | 'invalid';
  assets: string[];
  navigationIntent?: FeedbackNavigationIntent;
}

const text = (value: unknown, max = 160) => typeof value === 'string'
  ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const integer = (value: unknown, minimum: number) => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647 ? value : undefined;

/** Only public pickup facts, never a URL, planner object, address or rider fix.
 * This describes a requested action; it cannot attest that another app opened. */
export function feedbackNavigationIntent(input: unknown): FeedbackNavigationIntent | undefined {
  if (!record(input) || input.provider !== 'google-maps' || input.mode !== 'walking'
    || !clock(input.requestedAt)) return undefined;
  const publicStopId = integer(input.publicStopId, 1), walkLabel = text(input.walkLabel, 24);
  // fmtWalk's displayed text, or empty when the UI shows no initial walk leg.
  if (publicStopId === undefined || typeof input.walkLabel !== 'string' || !/^(?:[1-9]\d{0,4} min)?$/.test(walkLabel)) return undefined;
  const source = feedbackSourceReceipt(input.source);
  return { provider: 'google-maps', mode: 'walking', publicStopId, walkLabel, requestedAt: input.requestedAt,
    ...(source ? { source } : {}) };
}

// A single page-memory value. No request, timer or persistence happens on click.
let latestNavigationIntent: FeedbackNavigationIntent | undefined;
export function latestFeedbackNavigationIntent(): FeedbackNavigationIntent | undefined {
  return feedbackNavigationIntent(latestNavigationIntent);
}
/** Test/page-lifetime seam; does not change an already captured report draft. */
export function resetFeedbackNavigationIntent(): void { latestNavigationIntent = undefined; }

/** Capture phase also sees the berth link, whose bubble handler stops propagation.
 * Merely observing the matching anchor leaves href/default navigation untouched. */
export function noteFeedbackDirectionsClick(target: EventTarget | null, href: string | null,
  input: { publicStopId: number; walkLabel: string; source?: unknown }, requestedAt = Date.now()): boolean {
  try {
    const link = (target as Element | null)?.closest?.('a');
    if (!href || link?.getAttribute('href') !== href) return false;
    const intent = feedbackNavigationIntent({ ...input, provider: 'google-maps', mode: 'walking', requestedAt });
    if (!intent) return false;
    latestNavigationIntent = intent;
    return true;
  } catch { return false; } // Diagnostic capture must never prevent navigation.
}

export function feedbackAssetPaths(input: unknown): string[] {
  return Array.isArray(input) ? [...new Set(input.filter((value): value is string => typeof value === 'string'
    && /^\/assets\/[A-Za-z0-9._-]{1,150}\.(?:js|css)$/.test(value)))].slice(0, 8) : [];
}

/** Whitelist public trip facts. Never copy a planner object, address or GPS fix. */
export function feedbackScreenRow(input: Record<string, unknown>): FeedbackScreenRow | null {
  const route = text(input.route, 80), mode = input.mode;
  if (!route || (mode !== 'walk' && mode !== 'shuttle')) return null;
  return {
    mode, route,
    ...(mode === 'shuttle' ? {
      boardStopId: integer(input.boardStopId, 1), alightStopId: integer(input.alightStopId, 1),
      busName: text(input.busName, 24) || undefined, countdownBusName: text(input.countdownBusName, 24) || undefined,
      stopsAhead: integer(input.stopsAhead, 0),
      pickupChoice: input.pickupChoice === 'closest-stop' || input.pickupChoice === 'arrive-sooner' || input.pickupChoice === 'more-walking'
        ? input.pickupChoice : undefined,
    } : {}),
    board: text(input.board), next: text(input.next), arrive: text(input.arrive),
    legs: text(input.legs), approaching: text(input.approaching),
  };
}

export function feedbackScreenFromRows(rows: readonly Record<string, unknown>[],
  meta: { capturedAt: number; build: string; view: string; tripDetail: boolean; source?: unknown; assets?: unknown; navigationIntent?: unknown }): FeedbackScreen {
  const valid = rows.map(feedbackScreenRow).filter((row): row is FeedbackScreenRow => row !== null);
  const source = feedbackSourceReceipt(meta.source), receivedAt = record(meta.source) ? meta.source.receivedAt : undefined;
  const bound = source && clock(receivedAt) ? { ...source, receivedAt } : undefined;
  const navigationIntent = feedbackNavigationIntent(meta.navigationIntent);
  return {v: 1, capturedAt: meta.capturedAt, build: text(meta.build, 24), view: text(meta.view, 24),
    tripDetail: meta.tripDetail, rows: valid.slice(0, FEEDBACK_SCREEN_MAX_ROWS), truncated: valid.length > FEEDBACK_SCREEN_MAX_ROWS,
    assets: feedbackAssetPaths(meta.assets),
    ...(navigationIntent ? { navigationIntent } : {}),
    sourceScope: 'public-input-for-render', ...(bound ? { source: bound }
      : { sourceUnavailable: meta.source === undefined || (record(meta.source) && meta.source.unavailable === 'not-supplied')
        ? 'not-supplied' : 'invalid' })};
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
          countdownBusName: row.getAttribute('data-countdown-bus'),
          pickupChoice: row.getAttribute('data-pickup-choice'),
          board: (cells[0] as HTMLElement)?.innerText, next: (cells[1] as HTMLElement)?.innerText,
          arrive: (cells[2] as HTMLElement)?.innerText,
          legs: row.querySelector<HTMLElement>('[data-testid="journey-legs"]')?.innerText,
          approaching: row.querySelector<HTMLElement>('[data-testid="approaching-pickup"]')?.innerText,
        };
      });
    for (const leg of doc.querySelectorAll<HTMLElement>('[data-feedback-transfer-ride]')) {
      if (!leg.getClientRects().length) continue;
      const number = (name: string) => { const value = leg.getAttribute(name); return value === null ? undefined : Number(value); };
      rows.push({ mode: 'shuttle', route: leg.getAttribute('data-route'), boardStopId: number('data-pickup'), alightStopId: number('data-alight'),
        busName: leg.getAttribute('data-board-bus'), countdownBusName: leg.getAttribute('data-countdown-bus'),
        stopsAhead: number('data-board-stops-ahead'), pickupChoice: null,
        board: leg.querySelector<HTMLElement>('[data-transfer-pickup]')?.innerText ?? '', next: '—', arrive: '',
        legs: leg.querySelector<HTMLElement>('[data-transfer-ride-stops]')?.innerText,
        approaching: leg.querySelector<HTMLElement>('details summary')?.innerText });
    }
    const detail = doc.querySelector('[data-testid="trip-detail-panel"],[data-testid="transfer-detail"],[data-testid="transfer-handoff"]');
    const rawSource = doc.querySelector('[data-feedback-source]')?.getAttribute('data-feedback-source');
    let source: unknown;
    try { source = rawSource ? JSON.parse(rawSource) : undefined; } catch { source = null; }
    const origin = new URL(doc.baseURI).origin;
    const urls = [...doc.querySelectorAll('script[src],link[rel="stylesheet"][href]')].map(element =>
      element.getAttribute('src') ?? element.getAttribute('href') ?? '');
    // Imported chunks are resources too; they are not script elements.
    for (const resource of doc.defaultView?.performance.getEntriesByType('resource') ?? []) urls.push(resource.name);
    const assets = urls.flatMap(value => {
      try {
        const url = new URL(value, doc.baseURI);
        return url.origin === origin ? [url.pathname] : [];
      } catch { return []; }
    });
    return feedbackScreenFromRows(rows, {capturedAt: now, build: clientBuild(), view,
      tripDetail: !!detail?.getClientRects().length, source, assets, navigationIntent: latestFeedbackNavigationIntent()});
  } catch { return undefined; } // Diagnostic capture must never prevent feedback.
}
