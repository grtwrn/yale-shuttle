import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bindingObservation, readWaitingSelection, runnerBinding } from './selection-identity.mjs';
import { appendRolling } from '../retention/storage.mjs';

const row = (overrides = {}) => ({ dataset: { mode: 'shuttle', route: 'Purple', pickup: '97', alight: '98',
  countdownBus: '54', boardBus: '54', ...overrides }, getClientRects: () => [{}] });
const region = (name = 'Purple', text = '🚌 #54 · 3 stops away') => ({
  getAttribute: key => key === 'aria-label' ? name + ' stops' : null,
  getClientRects: () => [{}], innerText: text,
});
const panel = ({ rows = [row()], regions = [region()], hidden = false } = {}) => ({
  hidden, getClientRects: () => hidden ? [] : [{}],
  querySelectorAll: selector => selector === '[data-testid="trip-stop-list"]' ? regions
    : selector === '[data-testid="route-timing-table"]' ? [{ getClientRects: () => [{}],
      querySelectorAll: () => rows }] : [],
});
function page(panels) {
  vi.stubGlobal('getComputedStyle', node => ({ visibility: node.hidden ? 'hidden' : 'visible' }));
  return { locator: selector => {
    expect(selector).toBe('[data-testid="map-trip-panel"]');
    return { evaluateAll: (read, label) => read(panels, label) };
  } };
}
afterEach(() => vi.unstubAllGlobals());

describe('scoped waiting itinerary identity metadata', () => {
  it('reads the expanded itinerary and ignores another overview or route rather than parsing whole-body text', async () => {
    const overview = panel({ regions: [], rows: [row({ countdownBus: '45', boardBus: '45' })] });
    const otherRoute = panel({ regions: [region('Red')], rows: [row({ route: 'Red', countdownBus: '99', boardBus: '99' })] });
    const result = await readWaitingSelection(page([overview, otherRoute, panel()]), 'Purple');
    expect(result).toMatchObject({ state: 'bound', routeLabel: 'Purple', boardStopId: 97, alightStopId: 98,
      countdownBus: '54', boardBus: '54', approachBus: '54' });
  });

  it('keeps countdown and boardable vehicles distinct and accepts an unnamed at-pickup approach', async () => {
    const result = await readWaitingSelection(page([panel({ rows: [row({ countdownBus: '#45', boardBus: '#54' })],
      regions: [region('Purple', '🚌 #45 · 1 stop away')] })]), 'Purple');
    expect(result).toMatchObject({ state: 'bound', countdownBus: '45', boardBus: '54', approachBus: '45' });
    const atPickup = await readWaitingSelection(page([panel({ regions: [region('Purple', 'BOARD🚌Station')] })]), 'Purple');
    expect(atPickup).toMatchObject({ state: 'bound', countdownBus: '54', approachBus: null });
  });

  it.each(['overview', 'hidden', 'duplicate-panel', 'duplicate-row', 'missing-bus', 'wrong-row-route', 'disagreeing-approach'])
  ('retains %s as unknown rather than borrowing another identity', async fault => {
    let panels = [panel()];
    if (fault === 'overview') panels = [panel({ regions: [] })];
    if (fault === 'hidden') panels = [panel({ hidden: true })];
    if (fault === 'duplicate-panel') panels.push(panel());
    if (fault === 'duplicate-row') panels = [panel({ rows: [row(), row()] })];
    if (fault === 'missing-bus') panels = [panel({ rows: [row({ boardBus: undefined })] })];
    if (fault === 'wrong-row-route') panels = [panel({ rows: [row({ route: 'Red' })] })];
    if (fault === 'disagreeing-approach') panels = [panel({ regions: [region('Purple', '🚌 #45 · 3 stops away')] })];
    expect(await readWaitingSelection(page(panels), 'Purple')).toMatchObject({ state: 'unknown' });
  });

  it('records an unavailable DOM read as unknown without affecting the legacy runner', async () => {
    expect(await readWaitingSelection({ locator: () => { throw Error('page unavailable'); } }, 'Purple'))
      .toMatchObject({ state: 'unknown', reason: 'dom-read-unavailable' });
  });

  it('joins immutable before/after observations without changing the final legacy journey binding', () => {
    const run = { id: 'run', phase: 'waiting', line: { label: 'Purple', busRouteIds: [13] },
      busName: '#54', boardStopId: 97, exitStopId: 98 };
    const before = runnerBinding(run);
    run.busName = '#45';
    const record = { runId: run.id, line: run.line.label, sampleId: 'run:20', sampledAt: '2026-11-02T00:59:41Z',
      stage: 'binding-applied', before, after: runnerBinding(run), selection: { state: 'unknown' },
      feedResponse: { state: 'captured', sha256: 'receipt' }, feedStableDuringRead: false };
    const event = bindingObservation(record, '2026-11-02T00:59:42Z');
    expect(event.kind).toBe('sample-binding-observed');
    expect(event.detail).toMatchObject({ sampleId: 'run:20', before: { busName: '54' }, after: { busName: '45' },
      changed: true, feedStableDuringRead: false, feedResponse: record.feedResponse });
    expect(before.busName).toBe('54');
    expect(run.busName).toBe('#45');
    const unresolved = bindingObservation({ ...record, after: null, stage: 'followed-bus-unavailable' }, event.at);
    expect(unresolved.detail).toMatchObject({ after: null, changed: null, stage: 'followed-bus-unavailable' });
  });

  it('uses the existing bounded event stream and leaves sample/journey files and legacy event kinds alone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rider-binding-events-'));
    try {
      await fs.writeFile(path.join(root, 'storage-policy.json'), JSON.stringify({ events: { chunkBytes: 1024, maxFiles: 2 } }));
      await fs.writeFile(path.join(root, 'samples.jsonl'), '{"phase":"waiting","legacy":true}\n');
      await fs.writeFile(path.join(root, 'journeys.jsonl'), '{"busName":"#54","legacy":true}\n');
      for (let i = 0; i < 12; i++) await appendRolling(root, 'events', bindingObservation({
        runId: 'run', line: 'Purple', sampleId: 'run:' + i, sampledAt: '2026-11-02T00:59:41Z',
        stage: 'binding-not-reached', before: runnerBinding(null), after: null,
        selection: { state: 'unknown' }, feedResponse: { state: 'unavailable' }, feedStableDuringRead: false,
      }, '2026-11-02T00:59:42Z'));
      const files = (await fs.readdir(root)).filter(name => /^events(?:-\d+)?\.jsonl$/.test(name));
      expect(files.length).toBeLessThanOrEqual(2);
      expect(files.some(name => /^events-\d+\.jsonl$/.test(name))).toBe(true);
      const retained = (await Promise.all(files.map(name => fs.readFile(path.join(root, name), 'utf8'))))
        .flatMap(raw => raw.trim().split('\n').filter(Boolean).map(JSON.parse));
      expect(retained.every(event => event.kind === 'sample-binding-observed')).toBe(true);
      expect(retained.filter(event => event.kind === 'journey-finished' || event.kind.startsWith('candidate-'))).toEqual([]);
      expect(await fs.readFile(path.join(root, 'samples.jsonl'), 'utf8')).toBe('{"phase":"waiting","legacy":true}\n');
      expect(await fs.readFile(path.join(root, 'journeys.jsonl'), 'utf8')).toBe('{"busName":"#54","legacy":true}\n');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
