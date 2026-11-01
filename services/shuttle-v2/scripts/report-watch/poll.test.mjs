import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { reconcileReports, pollReports, loadOpenReports } from './poll.mjs';
import { riderFacingNote } from '../../src/server/reports.ts';
import * as evidence from './evidence.mjs';
const now = Date.parse('2026-10-15T13:00:00-04:00');
const report = (id, change = {}) => ({ id, status: 'open', body: 'Red has the wrong stop count',
  createdAt: '2026-10-15T12:43:38Z', priority: 'normal', context: '{}', note: null, ...change });
const dirs = [];
const batch = (count, first = 1) => Array.from({ length: count }, (_, n) => report(first + n));
const jsonResponse = reports => ({ ok: true, json: async () => ({ reports }) });
async function pollFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shuttle-report-capacity-')); dirs.push(dir);
  const tokenFile = path.join(dir, 'token'); await fs.writeFile(tokenFile, 'test-only-token');
  return { dir, tokenFile, notifier: async () => {}, healthNotifier: async () => {} };
}
const legacyState = r => ({ version: 1, seen: { [r.id]: { lastSeenAt: now,
  digest: createHash('sha256').update(JSON.stringify([r.body, r.note, r.priority,
    JSON.parse(r.context).followups ?? []])).digest('hex') } },
  pending: [{ id: r.id, kind: 'report-submitted', detectedAt: new Date(now).toISOString(),
    createdAt: r.createdAt, priority: r.priority, body: r.body, followupCount: 0 }], recent: [] });
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe('persistent submitted-report watcher', () => {
  it('keeps a small queue to one request and exposes verified coverage', async () => {
    const requests = [];
    const loaded = await loadOpenReports({ base: 'https://reports.test', token: 'test-only-token',
      fetcher: async (url, options) => { requests.push([String(url), options]); return jsonResponse(batch(17)); } });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0][0]).searchParams.get('limit')).toBe('200');
    expect(requests[0][1].headers).toEqual({ 'x-admin-token': 'test-only-token' });
    expect(loaded.coverage).toEqual({ complete: true, limit: 200, observedReports: 17, reason: 'complete' });
  });
  it('detects an older follow-up beyond the first 200 and reconciles the final complete set', async () => {
    const options = await pollFixture(), old = report(1), resolved = report(999);
    await pollReports({ ...options, now, fetcher: async () => jsonResponse([old, resolved]) });
    const reports = batch(201);
    reports[0] = report(1, { context: JSON.stringify({ followups: [{ at: now, text: 'Still happening' }] }) });
    const limits = [];
    const next = await pollReports({ ...options, now: now + 60000, fetcher: async url => {
      const limit = Number(new URL(url).searchParams.get('limit')); limits.push(limit);
      return jsonResponse(limit === 200 ? reports.slice(1) : reports);
    } });
    expect(limits).toEqual([200, 1000]);
    expect(next.ok).toBe(true); expect(next.coverage).toEqual({ complete: true, limit: 1000, observedReports: 201, reason: 'complete' });
    const state = JSON.parse(await fs.readFile(path.join(options.dir, 'state.json'), 'utf8'));
    expect(state.events.find(e => e.id === 1)?.kind).toBe('report-updated');
    expect(state.pending.some(e => e.id === 999)).toBe(false);
    expect(state.pending.some(e => e.id === 1)).toBe(true);
  });
  it('can prove an exactly 200-report queue complete with the larger request', async () => {
    const options = await pollFixture(), limits = [];
    const status = await pollReports({ ...options, now, fetcher: async url => {
      limits.push(Number(new URL(url).searchParams.get('limit'))); return jsonResponse(batch(200));
    } });
    expect(limits).toEqual([200, 1000]); expect(status.ok).toBe(true);
    expect(status.saturated).toBe(false); expect(status.coverage.complete).toBe(true);
  });
  it('keeps a full 1000 response unhealthy, preserves observed work and alerts once across restarts', async () => {
    const options = await pollFixture(), alerts = []; let count = 1000;
    // This control exercises real queue persistence and coverage health across
    // restarts. Evidence's actual filesystem work and retention are exercised
    // independently; creating 1,000 diagnostic manifests is not its oracle.
    const capture = vi.spyOn(evidence, 'preserveReportEvidence').mockResolvedValue({
      ok: true, captured: [], unavailable: [], bytes: 0, maxBytes: 256 * 1024 * 1024, cleanupUncertain: false,
    });
    const fetcher = async url => jsonResponse(batch(Math.min(count, Number(new URL(url).searchParams.get('limit')))));
    for (let n = 0; n < 4; n++) {
      await expect(pollReports({ ...options, now: now + n * 60000, fetcher,
        healthNotifier: async (kind, cause) => alerts.push([kind, cause]) })).rejects.toThrow('Report check failed');
      const status = JSON.parse(await fs.readFile(path.join(options.dir, 'status.json'), 'utf8'));
      expect(status.ok).toBe(false); expect(status.saturated).toBe(true);
      expect(status.coverage).toEqual({ complete: false, limit: 1000, observedReports: 1000, reason: 'response-limit' });
      expect(status.pending).toBe(1000);
      expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ complete: false, reports: batch(1000) }));
      expect(JSON.parse(await fs.readFile(path.join(options.dir, 'queue.json'), 'utf8')).pending).toHaveLength(1000);
    }
    expect(alerts).toEqual([['failed', 'coverage']]);
    count = 999;
    const recovered = await pollReports({ ...options, now: now + 300000, fetcher,
      healthNotifier: async (kind, cause) => alerts.push([kind, cause]) });
    expect(recovered.ok).toBe(true); expect(recovered.pending).toBe(999);
    expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ complete: true, reports: batch(999) }));
    expect(capture).toHaveBeenCalledTimes(5);
    expect(alerts).toEqual([['failed', 'coverage'], ['recovered', undefined]]);
  });
  it('refuses pending overflow before replacing any protected state or queue', async () => {
    const options = await pollFixture();
    const prior = reconcileReports(null, batch(1000), now, false);
    const stateBytes = JSON.stringify(prior), queueBytes = JSON.stringify({ pending: prior.pending });
    await fs.writeFile(path.join(options.dir, 'state.json'), stateBytes);
    await fs.writeFile(path.join(options.dir, 'queue.json'), queueBytes);
    let notifications = 0;
    await expect(pollReports({ ...options, now: now + 60000,
      notifier: async () => { notifications++; }, fetcher: async url =>
        jsonResponse(batch(Number(new URL(url).searchParams.get('limit')), 1001)) })).rejects.toThrow('Report check failed');
    expect(await fs.readFile(path.join(options.dir, 'state.json'), 'utf8')).toBe(stateBytes);
    expect(await fs.readFile(path.join(options.dir, 'queue.json'), 'utf8')).toBe(queueBytes);
    expect(notifications).toBe(0);
    const status = JSON.parse(await fs.readFile(path.join(options.dir, 'status.json'), 'utf8'));
    expect(status.pending).toBe(1000); expect(status.coverage.reason).toBe('pending-capacity');
    expect(status.ok).toBe(false); expect(status.saturated).toBe(true);
  });
  it('preserves prior state when the larger request fails', async () => {
    const options = await pollFixture();
    await pollReports({ ...options, now, fetcher: async () => jsonResponse([report(1)]) });
    const state = await fs.readFile(path.join(options.dir, 'state.json'), 'utf8');
    const queue = await fs.readFile(path.join(options.dir, 'queue.json'), 'utf8');
    const limits = [];
    await expect(pollReports({ ...options, now: now + 60000, fetcher: async url => {
      const limit = Number(new URL(url).searchParams.get('limit')); limits.push(limit);
      return limit === 200 ? jsonResponse(batch(200)) : { ok: false, status: 503 };
    } })).rejects.toThrow('Report check failed');
    expect(limits).toEqual([200, 1000]);
    expect(await fs.readFile(path.join(options.dir, 'state.json'), 'utf8')).toBe(state);
    expect(await fs.readFile(path.join(options.dir, 'queue.json'), 'utf8')).toBe(queue);
  });
  it('shares one deadline across escalation and aborts a stalled larger request', async () => {
    const signals = [];
    await expect(loadOpenReports({ base: 'https://reports.test', token: 'test-only-token', budgetMs: 30,
      fetcher: async (_url, options) => {
        signals.push(options.signal);
        return signals.length === 1 ? jsonResponse(batch(200)) : new Promise(() => {});
      } })).rejects.toThrow('Report fetch budget exceeded');
    expect(signals).toHaveLength(2); expect(signals[0]).toBe(signals[1]); expect(signals[1].aborted).toBe(true);
  });
  it('bounds a stalled response body with the same request deadline and cancels it', async () => {
    let canceled = false;
    const response = new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel() { canceled = true; } }));
    await expect(loadOpenReports({ base: 'https://reports.test', token: 'test-only-token', budgetMs: 30,
      fetcher: async () => response })).rejects.toThrow('Report fetch budget exceeded');
    expect(canceled).toBe(true);
  });
  it('enforces the decoded byte cap before JSON parsing and preserves saved work', async () => {
    const options = await pollFixture();
    await pollReports({ ...options, now, fetcher: async () => jsonResponse([report(1)]) });
    const state = await fs.readFile(path.join(options.dir, 'state.json'), 'utf8');
    const queue = await fs.readFile(path.join(options.dir, 'queue.json'), 'utf8');
    let canceled = false;
    await expect(pollReports({ ...options, now: now + 60000, fetcher: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); },
      cancel() { canceled = true; },
    })) })).rejects.toThrow('Report check failed');
    expect(canceled).toBe(true);
    expect(await fs.readFile(path.join(options.dir, 'state.json'), 'utf8')).toBe(state);
    expect(await fs.readFile(path.join(options.dir, 'queue.json'), 'utf8')).toBe(queue);
    const status = JSON.parse(await fs.readFile(path.join(options.dir, 'status.json'), 'utf8'));
    expect(status.ok).toBe(false); expect(status.coverage.reason).toBe('response-bytes');
    expect(JSON.stringify(status)).not.toContain('test-only-token');
  });
  it('rejects a server result beyond the requested row limit', async () => {
    await expect(loadOpenReports({ base: 'https://reports.test', token: 'test-only-token',
      fetcher: async () => jsonResponse(batch(201)) })).rejects.toMatchObject({ reason: 'invalid-response' });
  });
  it('cannot turn malformed or duplicate rows into a complete empty queue', async () => {
    const options = await pollFixture();
    await pollReports({ ...options, now, fetcher: async () => jsonResponse([report(1)]) });
    const state = await fs.readFile(path.join(options.dir, 'state.json'), 'utf8');
    const queue = await fs.readFile(path.join(options.dir, 'queue.json'), 'utf8');
    for (const rows of [[{}], [report(0)], [report(1), report(1)], [report(1, { status: 'addressed' })],
      [report(1, { body: null })], [report(1, { priority: 'unknown' })], [report(1, { note: {} })],
      [report(1, { context: [] })], [report(1, { createdAt: 'invalid' })]]) {
      await expect(pollReports({ ...options, now: now + 60000,
        fetcher: async () => jsonResponse(rows) })).rejects.toThrow('Report check failed');
      expect(await fs.readFile(path.join(options.dir, 'state.json'), 'utf8')).toBe(state);
      expect(await fs.readFile(path.join(options.dir, 'queue.json'), 'utf8')).toBe(queue);
      const status = JSON.parse(await fs.readFile(path.join(options.dir, 'status.json'), 'utf8'));
      expect(status.ok).toBe(false); expect(status.coverage).toMatchObject({ complete: false, reason: 'invalid-response' });
    }
  });
  it('also protects direct reconciliation from malformed complete observations', () => {
    const prior = reconcileReports(null, [report(1)], now);
    expect(() => reconcileReports(prior, [{}], now + 60000, true)).toThrow('Report coverage is incomplete');
    expect(prior.pending.map(item => item.id)).toEqual([1]);
  });
  it('finds today on startup, baselines the older backlog, and deduplicates restart polls', () => {
    const state = reconcileReports(null, [report(142), report(139, { createdAt: '2026-10-05T12:00:00Z' })], now);
    expect(state.events.map(r => r.id)).toEqual([142]);
    expect(reconcileReports(state, [report(142), report(139, { createdAt: '2026-10-05T12:00:00Z' })], now + 60000).events).toEqual([]);
  });
  it('catches follow-ups to older reports and a newly submitted report', () => {
    const first = reconcileReports(null, [report(139, { createdAt: '2026-10-05T12:00:00Z' })], now);
    const changed = reconcileReports(first, [report(143), report(139, { createdAt: '2026-10-05T12:00:00Z',
      context: JSON.stringify({ followups: [{ at: now, text: 'Still happening' }] }) })], now + 60000);
    expect(changed.events.map(e => [e.id, e.kind])).toEqual([[143, 'report-submitted'], [139, 'report-updated']]);
  });
  it('does not requeue a report when only an internal operator audit changes', () => {
    const older = report(111, { createdAt: '2026-09-16T18:13:51Z' });
    const first = reconcileReports(null, [older], now);
    const updated = { ...older, note: '\n---\n[internal operator audit]\nReviewed the retained source; still unresolved.' };
    const next = reconcileReports(first, [updated], now + 60000);
    expect(next.events).toEqual([]);
    expect(next.pending).toEqual([]);
  });
  it('preserves unresolved pending work when an internal note changes', () => {
    const first = reconcileReports(null, [report(142)], now);
    const next = reconcileReports(first, [report(142, { note: '\n---\nInternal review' })], now + 60000);
    expect(next.events).toEqual([]);
    expect(next.pending).toEqual(first.pending);
  });
  it('compares notes by the actual server rider-facing projection', () => {
    const notes = [null, '', '\n---\nInternal only', '[triage]', 'A fix is available.',
      'A fix is available.\n---\nInternal audit', '[fixed] [approved] A fix is available.\r\n --- \r\nInternal audit',
      'automated: A fix is available.\n----\nDifferent audit', 'automated-abuse: A fix is available.'];
    for (const before of notes) for (const after of notes) {
      const first = reconcileReports(null, [report(139, { note: before })], now);
      const next = reconcileReports(first, [report(139, { note: after })], now + 60000);
      expect(next.events.length, JSON.stringify([before, after])).toBe(riderFacingNote(before) === riderFacingNote(after) ? 0 : 1);
    }
  });
  it('still detects body, priority, and follow-up changes alongside an internal audit', () => {
    const first = reconcileReports(null, [report(139)], now);
    for (const change of [{ body: 'Still the wrong stop' }, { priority: 'urgent' },
      { context: JSON.stringify({ followups: [{ at: now, text: 'Still happening' }] }) }]) {
      const next = reconcileReports(first, [report(139, { ...change, note: '\n---\nInternal review' })], now + 60000);
      expect(next.events.map(e => [e.id, e.kind])).toEqual([[139, 'report-updated']]);
    }
  });
  it('detects a follow-up edit even when its timestamp and count are unchanged', () => {
    const first = reconcileReports(null, [report(139, { context: JSON.stringify({ followups: [{ at: now, text: 'First description' }] }) })], now);
    const next = reconcileReports(first, [report(139, { context: JSON.stringify({ followups: [{ at: now, text: 'Corrected description' }] }) })], now + 60000);
    expect(next.events).toHaveLength(1);
  });
  it('upgrades unchanged legacy fingerprints quietly and keeps pending work', () => {
    const r = report(139, { note: '\n---\nPrevious internal audit' }), legacy = legacyState(r);
    const upgraded = reconcileReports(legacy, [r], now + 60000);
    expect(upgraded.version).toBe(2);
    expect(upgraded.seen[r.id].fingerprintVersion).toBe(2);
    expect(upgraded.events).toEqual([]);
    expect(upgraded.pending).toEqual(legacy.pending);
    const later = reconcileReports(upgraded, [report(139, { note: '\n---\nNew internal audit' })], now + 120000);
    expect(later.events).toEqual([]);
    expect(later.pending).toEqual(legacy.pending);
  });
  it('does not lose a rider change made while the legacy watcher was stopped', () => {
    const legacy = legacyState(report(139));
    const updated = report(139, { context: JSON.stringify({ followups: [{ at: now, text: 'New evidence' }] }) });
    const next = reconcileReports(legacy, [updated], now + 60000);
    expect(next.events.map(e => [e.id, e.kind])).toEqual([[139, 'report-updated']]);
    expect(reconcileReports(next, [updated], now + 120000).events).toEqual([]);
  });
  it('alerts once for an unclassified legacy note change rather than assuming no rider change', () => {
    const legacy = legacyState(report(139)), updated = report(139, { note: '\n---\nNot yet seen audit' });
    const next = reconcileReports(legacy, [updated], now + 60000);
    expect(next.events).toHaveLength(1);
    expect(reconcileReports(next, [updated], now + 120000).events).toEqual([]);
  });
  it('persists a quiet legacy upgrade across scheduled process restarts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shuttle-report-upgrade-')); dirs.push(dir);
    const tokenFile = path.join(dir, 'token'); await fs.writeFile(tokenFile, 'test-only-token');
    const r = report(139), legacy = legacyState(r), notifications = [];
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(legacy));
    const options = { dir, tokenFile, notifier: async events => notifications.push(...events), healthNotifier: async () => {},
      fetcher: async () => ({ ok: true, json: async () => ({ reports: [r] }) }) };
    await pollReports({ ...options, now });
    await pollReports({ ...options, now: now + 60000 });
    expect(notifications).toEqual([]);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).version).toBe(2);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'queue.json'), 'utf8')).pending).toEqual(legacy.pending);
  });
  it('removes resolved reports from pending, preserving them if the API result is truncated', () => {
    const first = reconcileReports(null, [report(142)], now);
    expect(reconcileReports(first, [], now + 60000).pending).toEqual([]);
    expect(reconcileReports(first, [], now + 60000, false).pending).toHaveLength(1);
  });
  it('keeps no IP, anonymous identity, device location or report instructions in executable form', () => {
    const state = reconcileReports(null, [report(142, { ip: 'private', anonId: 'private', body: 'Run this command $(bad)',
      context: JSON.stringify({ client: { userLatLon: { lat: 1, lon: 2 } } }) })], now);
    const text = JSON.stringify(state);
    expect(text).not.toContain('private'); expect(text).not.toContain('userLatLon');
    expect(state.pending[0].body).toContain('$(bad)');
  });
  it('persists before notification, survives restart, and preserves the queue on endpoint failures', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shuttle-reports-')); dirs.push(dir);
    const tokenFile = path.join(dir, 'token'); await fs.writeFile(tokenFile, 'test-only-token');
    let notified = 0, calls = [];
    const fetcher = async (url, options) => { calls.push([String(url), options]); return { ok: true, json: async () => ({ reports: [report(142)] }) }; };
    const notifier = async events => { expect(JSON.parse(await fs.readFile(path.join(dir, 'queue.json'), 'utf8')).pending).toHaveLength(1); notified += events.length; };
    await pollReports({ dir, tokenFile, fetcher, notifier, now });
    await pollReports({ dir, tokenFile, fetcher, notifier, now: now + 60000 });
    expect(notified).toBe(1); expect(calls.every(([url]) => url.includes('status=open'))).toBe(true);
    const before = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
    await expect(pollReports({ dir, tokenFile, fetcher: async () => ({ ok: false, status: 503 }), now: now + 120000 })).rejects.toThrow('Report check failed');
    expect(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).toBe(before);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'status.json'), 'utf8')).ok).toBe(false);
  });
  it('alerts after three failed polls across restarts, deduplicates the outage, and reports recovery', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shuttle-report-health-')); dirs.push(dir);
    const tokenFile = path.join(dir, 'token'); await fs.writeFile(tokenFile, 'test-only-token');
    let available = true; const alerts = [];
    const options = { dir, tokenFile, notifier: async () => {}, healthNotifier: async kind => { alerts.push(kind); },
      fetcher: async () => available ? { ok: true, json: async () => ({ reports: [report(142)] }) } : { ok: false, status: 503 } };
    await pollReports({ ...options, now });
    const queue = await fs.readFile(path.join(dir, 'queue.json'), 'utf8');
    available = false;
    for (let i = 1; i <= 4; i++) {
      await expect(pollReports({ ...options, now: now + i * 60000 })).rejects.toThrow('Report check failed');
      expect(alerts).toEqual(i < 3 ? [] : ['failed']);
    }
    expect(await fs.readFile(path.join(dir, 'queue.json'), 'utf8')).toBe(queue);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'status.json'), 'utf8')).consecutiveFailures).toBe(4);
    available = true;
    const healthy = await pollReports({ ...options, now: now + 300000 });
    expect(healthy.ok).toBe(true); expect(healthy.consecutiveFailures).toBe(0);
    expect(alerts).toEqual(['failed', 'recovered']);
    available = false;
    for (let i = 6; i <= 8; i++) await expect(pollReports({ ...options, now: now + i * 60000 })).rejects.toThrow();
    expect(alerts).toEqual(['failed', 'recovered', 'failed']);
  });
  it('retries a failed local health notification without exposing endpoint errors or credentials', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shuttle-report-notify-')); dirs.push(dir);
    const tokenFile = path.join(dir, 'token'); await fs.writeFile(tokenFile, 'test-only-token');
    // A malformed health receipt must not disable failure tracking itself.
    await fs.writeFile(path.join(dir, 'health.json'), 'null');
    let notifyFails = true, available = false; const attempts = [];
    const options = { dir, tokenFile, fetcher: async () => {
      if (!available) throw Error('private endpoint details test-only-token');
      return { ok: true, json: async () => ({ reports: [] }) };
    },
      healthNotifier: async kind => { attempts.push(kind); if (notifyFails) throw Error('private notification failure'); } };
    for (let i = 1; i <= 3; i++) await expect(pollReports({ ...options, now: now + i * 60000 })).rejects.toThrow('Report check failed');
    const status = JSON.parse(await fs.readFile(path.join(dir, 'status.json'), 'utf8'));
    expect(status.notificationError).toBeTruthy(); expect(JSON.stringify(status)).not.toContain('private');
    expect(JSON.stringify(status)).not.toContain('test-only-token');
    notifyFails = false;
    for (let i = 4; i <= 5; i++) await expect(pollReports({ ...options, now: now + i * 60000 })).rejects.toThrow();
    expect(attempts).toEqual(['failed', 'failed']);
    available = true; notifyFails = true;
    const recovered = await pollReports({ ...options, now: now + 360000 });
    expect(recovered.ok).toBe(true); expect(recovered.notificationError).toBeTruthy();
    notifyFails = false;
    await pollReports({ ...options, now: now + 420000 });
    await pollReports({ ...options, now: now + 480000 });
    expect(attempts).toEqual(['failed', 'failed', 'recovered', 'recovered']);
  });
  it('alerts on a damaged watcher state without clearing the saved queue', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shuttle-report-state-')); dirs.push(dir);
    const tokenFile = path.join(dir, 'token'); await fs.writeFile(tokenFile, 'test-only-token');
    const alerts = []; const options = { dir, tokenFile, notifier: async () => {}, healthNotifier: async kind => { alerts.push(kind); },
      fetcher: async () => ({ ok: true, json: async () => ({ reports: [report(142)] }) }) };
    await pollReports({ ...options, now });
    const stateFile = path.join(dir, 'state.json'), queue = await fs.readFile(path.join(dir, 'queue.json'), 'utf8');
    await fs.writeFile(stateFile, '{damaged');
    for (let i = 1; i <= 3; i++) await expect(pollReports({ ...options, now: now + i * 60000 })).rejects.toThrow('Report check failed');
    expect(alerts).toEqual(['failed']);
    expect(await fs.readFile(stateFile, 'utf8')).toBe('{damaged');
    expect(await fs.readFile(path.join(dir, 'queue.json'), 'utf8')).toBe(queue);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'status.json'), 'utf8')).pending).toBe(1);
  });
});
