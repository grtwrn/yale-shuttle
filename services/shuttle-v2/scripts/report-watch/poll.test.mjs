import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { reconcileReports, pollReports } from './poll.mjs';
import { riderFacingNote } from '../../src/server/reports.ts';
const now = Date.parse('2026-10-15T13:00:00-04:00');
const report = (id, change = {}) => ({ id, status: 'open', body: 'Red has the wrong stop count',
  createdAt: '2026-10-15T12:43:38Z', priority: 'normal', context: '{}', note: null, ...change });
const dirs = [];
const legacyState = r => ({ version: 1, seen: { [r.id]: { lastSeenAt: now,
  digest: createHash('sha256').update(JSON.stringify([r.body, r.note, r.priority,
    JSON.parse(r.context).followups ?? []])).digest('hex') } },
  pending: [{ id: r.id, kind: 'report-submitted', detectedAt: new Date(now).toISOString(),
    createdAt: r.createdAt, priority: r.priority, body: r.body, followupCount: 0 }], recent: [] });
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe('persistent submitted-report watcher', () => {
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
