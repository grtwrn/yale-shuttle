import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { observe, poll, rotateLog } from './poll';
import type { Finding } from './check';
import fixture from '../../web/src/__fixtures__/red-winchester-report-142.json';
const finding: Finding = { kind: 'pickup-count', line: 'Red', bus: '#317', standingStop: 11, targetStop: 48, expected: 3, actual: 11 };
const directories: string[] = [];
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const historyFile = (dir: string) => path.join(dir, 'unavailable-history.json');
const missingFeed = { buses: [{ bus_name: '#317', route_id: 3 }], routes: {}, stop_coords: {} };
const failedFetch = (feed: unknown = missingFeed, health: unknown = { ok: true, build: 'abcdef123456' }) =>
  (async (url: string | URL | Request) => Response.json(String(url).endsWith('/healthz') ? health : feed)) as typeof fetch;
async function temporary() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ys-display-evidence-'));
  directories.push(directory); return directory;
}
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { force: true, recursive: true }); });
describe('persistent display observer', () => {
  it('bounds the log tail while preserving launchd’s open append descriptor', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ys-display-audit-')); directories.push(directory);
    const file = path.join(directory, 'watcher.log'), output = await fs.open(file, 'a');
    try {
      await output.write('abcdefghijkl');
      await rotateLog(file, 8);
      await output.write('new');
      expect(await fs.readFile(file, 'utf8')).toBe('new');
      expect(await fs.readFile(file + '.1', 'utf8')).toBe('efghijkl');
    } finally { await output.close(); }
  });
  it('requires distinct polls, survives restart, deduplicates and re-arms after recovery', () => {
    const now = fixture.receivedAt;
    const first = observe(null, [finding], 'abcd1234', now, now);
    expect(first.alerts).toEqual([]);
    const restarted = JSON.parse(JSON.stringify(first.state));
    expect(observe(restarted, [finding], 'abcd1234', now, now + 60_000).alerts).toEqual([]);
    const next = observe(restarted, [finding], 'abcd1234', now + 60_000, now + 60_000);
    expect(next.alerts).toEqual([finding]);
    expect(observe(next.state, [finding], 'abcd1234', now + 120_000, now + 120_000).alerts).toEqual([]);
    const recovered = observe(next.state, [], 'abcd1234', now + 120_000, now + 120_000);
    expect(recovered.state.queue).toHaveLength(1); // no disappearing evidence
    expect(observe(recovered.state, [finding], 'abcd1234', now + 180_000, now + 180_000).alerts).toEqual([]);
    expect(observe(first.state, [finding], 'newbuild', now + 60_000, now + 60_000).alerts).toEqual([]);
    expect(observe(first.state, [finding], 'abcd1234', now + 300_000, now + 300_000).alerts).toEqual([]);
  });
  it('bounds the review queue', () => {
    let state = null;
    for (let i = 0; i < 110; i++) {
      state = observe(state, [finding], String(i), i * 120_000, i * 120_000).state;
      state = observe(state, [finding], String(i), i * 120_000 + 60_000, i * 120_000 + 60_000).state;
    }
    expect(state!.queue).toHaveLength(100);
  });
  it('writes a healthy coverage heartbeat only for the matching production build', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ys-display-audit-')); directories.push(directory);
    const fetchImpl = (async (url: string | URL | Request) => Response.json(String(url).endsWith('/healthz')
      ? { ok: true, build: 'abcdef123456' } : fixture.feed)) as typeof fetch;
    const status = await poll({ directory, revision: 'abcdef1234567890', fetchImpl, clock: () => fixture.receivedAt });
    expect(status.ok).toBe(true);
    expect(status.coverage.pickupCounts).toBeGreaterThan(20);
    const state = await fs.readFile(path.join(directory, 'state.json'), 'utf8');
    await expect(poll({ directory, revision: 'different', fetchImpl })).rejects.toThrow(/revision must match/);
    expect(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).toBe(state);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8')).ok).toBe(false);
  });
  it('preserves prior evidence through network failures and dirty local source', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ys-display-audit-')); directories.push(directory);
    await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({ build: 'abc12345', observations: {}, queue: [{ at: 'old', findings: [finding] }] }));
    const before = await fs.readFile(path.join(directory, 'state.json'), 'utf8');
    await expect(poll({ directory, revision: 'abc12345', fetchImpl: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
    expect(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).toBe(before);
    const fetchImpl = (async () => Response.json({ ok: true, build: 'abc12345' })) as typeof fetch;
    await expect(poll({ directory, revision: 'abc12345', sourceClean: false, fetchImpl })).rejects.toThrow(/revision must match/);
  });
  it('alerts once after three failed checks instead of silently reporting monitoring coverage', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ys-display-audit-')); directories.push(directory);
    const notices: number[] = [];
    for (let i = 0; i < 4; i++) await expect(poll({ directory, revision: 'abc12345',
      fetchImpl: async () => { throw new Error('offline'); }, notify: async n => { notices.push(n); } })).rejects.toThrow('offline');
    expect(notices).toEqual([0]);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'health.json'), 'utf8')).failures).toBe(4);
  });
  it('records a normal empty fleet as idle, clears pending confirmations, and preserves old incidents', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ys-display-idle-')); directories.push(directory);
    const previous = observe(null, [finding], 'abcdef123456', fixture.receivedAt, fixture.receivedAt).state;
    previous.queue.push({ at: 'earlier', build: 'abcdef123456', findings: [finding] });
    await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(previous));
    await fs.writeFile(path.join(directory, 'health.json'), JSON.stringify({ failures: 3, notified: true }));
    const { server_eta, ...feed } = fixture.feed;
    const notices: number[] = [];
    const fetchImpl = (async (url: string | URL | Request) => Response.json(String(url).endsWith('/healthz')
      ? { ok: true, build: 'abcdef123456' } : { ...feed, buses: [] })) as typeof fetch;
    const status = await poll({ directory, revision: 'abcdef1234567890', fetchImpl, clock: () => fixture.receivedAt + 60_000,
      notify: async n => { notices.push(n); } });
    expect(status.ok).toBe(true); expect(status.activity).toBe('idle');
    expect(status.coverage.buses).toBe(0); expect(status.queuedBatches).toBe(1);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).observations).toEqual({});
    expect(JSON.parse(await fs.readFile(path.join(directory, 'queue.json'), 'utf8'))).toEqual(previous.queue);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'health.json'), 'utf8')).failures).toBe(0);
    expect(notices).toEqual([]);
    await expect(poll({ directory, revision: 'wrong', fetchImpl })).rejects.toThrow(/revision must match/);
    await expect(poll({ directory, revision: 'abcdef1234567890', sourceClean: false, fetchImpl })).rejects.toThrow(/revision must match/);
  });
  it('allows a separately verified operator revision and still rejects a nonempty missing-ETA feed', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ys-display-source-')); directories.push(directory);
    const builds: string[] = [];
    const sourceMatches = (build: string) => { builds.push(build); return true; };
    const fetchImpl = (async (url: string | URL | Request) => Response.json(String(url).endsWith('/healthz')
      ? { ok: true, build: 'abcdef123456' } : fixture.feed)) as typeof fetch;
    const status = await poll({ directory, revision: 'different-operator-revision', sourceMatches, fetchImpl, clock: () => fixture.receivedAt });
    expect(status.ok).toBe(true); expect(status.operatorRevision).toBe('different-operator-revision');
    expect(builds).toEqual(['abcdef123456']);
    const { server_eta, ...nonempty } = fixture.feed;
    const missing = (async (url: string | URL | Request) => Response.json(String(url).endsWith('/healthz')
      ? { ok: true, build: 'abcdef123456' } : nonempty)) as typeof fetch;
    const before = await fs.readFile(path.join(directory, 'state.json'), 'utf8');
    await expect(poll({ directory, revision: 'different-operator-revision', sourceMatches, fetchImpl: missing,
      clock: () => fixture.receivedAt })).rejects.toThrow(/ETA snapshot/);
    expect(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).toBe(before);
  });
  it('retains the failed check’s inspected values after recovery without changing queued incidents', async () => {
    const directory = await temporary(), now = fixture.receivedAt;
    const queue = [{ at: 'earlier', build: 'abcdef123456', findings: [finding] }];
    const state = JSON.stringify({ build: 'abcdef123456', observations: {}, queue });
    await fs.writeFile(path.join(directory, 'state.json'), state);
    const { server_eta, ...feed } = structuredClone(fixture.feed);
    await expect(poll({ directory, revision: 'abcdef1234567890', fetchImpl: failedFetch(feed), clock: () => now })).rejects.toThrow(/ETA snapshot/);
    expect(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).toBe(state);
    const before = await fs.readFile(historyFile(directory), 'utf8'), row = JSON.parse(before).checks[0];
    expect(row.sha256).toBe(hash(row.json)); expect(row.bytes).toBe(Buffer.byteLength(row.json));
    const check = JSON.parse(row.json);
    expect(check.complete).toBe(true); expect(check.responseStatus).toEqual({ health: 200, feed: 200 });
    expect(check.operatorRevision).toBe('abcdef1234567890');
    expect(JSON.parse(check.values.feed.json)).toEqual(feed);
    expect(check.values.feed.sha256).toBe(hash(JSON.stringify(feed)));
    const status = await poll({ directory, revision: 'abcdef1234567890', fetchImpl: failedFetch({ ...feed, buses: [] }), clock: () => now + 60_000 });
    expect(status.activity).toBe('idle'); expect(status.ok).toBe(true);
    expect(await fs.readFile(historyFile(directory), 'utf8')).toBe(before);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'queue.json'), 'utf8'))).toEqual(queue);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'health.json'), 'utf8')).failures).toBe(0);
  });
  it('marks uninspected inputs explicitly for network, HTTP and JSON read failures', async () => {
    const cases: { fetchImpl: typeof fetch; statuses: { health: number | null; feed: number | null }; health: string }[] = [
      { fetchImpl: async () => { throw Error('offline'); }, statuses: { health: null, feed: null }, health: 'unavailable' },
      { fetchImpl: (async (u: string | URL | Request) => Response.json({}, { status: String(u).endsWith('/healthz') ? 503 : 200 })) as typeof fetch,
        statuses: { health: 503, feed: 200 }, health: 'unavailable' },
      { fetchImpl: (async (u: string | URL | Request) => String(u).endsWith('/healthz') ? Response.json({ ok: true, build: 'abcdef123456' }) : new Response('invalid JSON')) as typeof fetch,
        statuses: { health: 200, feed: 200 }, health: 'captured' },
    ];
    for (const c of cases) {
      const directory = await temporary();
      await expect(poll({ directory, revision: 'abcdef1234567890', fetchImpl: c.fetchImpl })).rejects.toThrow();
      const history = JSON.parse(await fs.readFile(historyFile(directory), 'utf8')), check = JSON.parse(history.checks[0].json);
      expect(check.complete).toBe(false); expect(check.responseStatus).toEqual(c.statuses);
      expect(check.values.health.state).toBe(c.health); expect(check.values.feed.state).toBe('unavailable');
      expect(JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8')).failureEvidenceError).toBeNull();
    }
  });
  it('keeps hashes and explicit omission states when a parsed input exceeds one MiB', async () => {
    const directory = await temporary(), feed = { ...missingFeed, extra: 'x'.repeat(1024 * 1024) };
    await expect(poll({ directory, revision: 'abcdef1234567890', fetchImpl: failedFetch(feed) })).rejects.toThrow(/ETA snapshot/);
    const history = JSON.parse(await fs.readFile(historyFile(directory), 'utf8')), check = JSON.parse(history.checks[0].json);
    expect(check.complete).toBe(false); expect(check.values.feed.state).toBe('oversized');
    expect(check.values.feed.bytes).toBe(Buffer.byteLength(JSON.stringify(feed)));
    expect(check.values.feed.sha256).toBe(hash(JSON.stringify(feed))); expect(check.values.feed.json).toBeUndefined();
    expect(check.values.health.state).toBe('captured');
  });
  it('bounds a check’s combined escaped inputs without silently dropping their identities', async () => {
    const directory = await temporary(), extra = '\\'.repeat(400_000);
    const feed = { ...missingFeed, extra }, health = { ok: true, build: 'abcdef123456', extra };
    await expect(poll({ directory, revision: 'abcdef1234567890', fetchImpl: failedFetch(feed, health) })).rejects.toThrow(/ETA snapshot/);
    const history = JSON.parse(await fs.readFile(historyFile(directory), 'utf8')), row = history.checks[0], check = JSON.parse(row.json);
    expect(row.bytes).toBeLessThanOrEqual(2 * 1024 * 1024); expect(check.complete).toBe(false);
    expect(check.values.feed.state).toBe('check-bound'); expect(check.values.health.state).toBe('check-bound');
    expect(check.values.feed.sha256).toBe(hash(JSON.stringify(feed))); expect(check.values.health.sha256).toBe(hash(JSON.stringify(health)));
  });
  it('rolls availability samples at 32 checks while keeping the newest check', async () => {
    const directory = await temporary(); let now = fixture.receivedAt;
    for (let i = 0; i < 40; i++) {
      now = fixture.receivedAt + i * 60_000;
      await expect(poll({ directory, revision: 'abcdef1234567890', fetchImpl: failedFetch(), clock: () => now })).rejects.toThrow(/ETA snapshot/);
    }
    const history = JSON.parse(await fs.readFile(historyFile(directory), 'utf8'));
    expect(history.checks).toHaveLength(32);
    expect(history.checks[0].checkedAt).toBe(new Date(fixture.receivedAt + 8 * 60_000).toISOString());
    expect(history.checks.at(-1).checkedAt).toBe(new Date(now).toISOString());
    expect(history.checks.every((r: { json: string; sha256: string }) => hash(r.json) === r.sha256)).toBe(true);
  });
  it('rolls before formatted history exceeds eight MiB and retains the newest full input', async () => {
    const directory = await temporary(); let now = fixture.receivedAt;
    const feed = { ...missingFeed, extra: 'x'.repeat(700_000) };
    for (let i = 0; i < 16; i++) {
      now = fixture.receivedAt + i * 60_000;
      await expect(poll({ directory, revision: 'abcdef1234567890', fetchImpl: failedFetch(feed), clock: () => now })).rejects.toThrow(/ETA snapshot/);
    }
    const raw = await fs.readFile(historyFile(directory)), history = JSON.parse(raw.toString());
    expect(raw.length).toBeLessThanOrEqual(8 * 1024 * 1024); expect(history.checks.length).toBeGreaterThan(0); expect(history.checks.length).toBeLessThan(16);
    const last = history.checks.at(-1); expect(last.checkedAt).toBe(new Date(now).toISOString());
    expect(JSON.parse(JSON.parse(last.json).values.feed.json)).toEqual(feed);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8')).failureEvidence.evictedChecks).toBeGreaterThan(0);
  });
  it.each(['invalid-json', 'bad-checksum'])('preserves %s history and reports capture failure separately', async kind => {
    const directory = await temporary();
    await expect(poll({ directory, revision: 'abcdef1234567890', fetchImpl: failedFetch() })).rejects.toThrow(/ETA snapshot/);
    let raw = await fs.readFile(historyFile(directory), 'utf8');
    if (kind === 'invalid-json') raw = '{incomplete';
    else { const history = JSON.parse(raw); history.checks[0].sha256 = '0'.repeat(64); raw = JSON.stringify(history); }
    await fs.writeFile(historyFile(directory), raw);
    await expect(poll({ directory, revision: 'abcdef1234567890', fetchImpl: failedFetch() })).rejects.toThrow(/ETA snapshot/);
    expect(await fs.readFile(historyFile(directory), 'utf8')).toBe(raw);
    const status = JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'));
    expect(status.ok).toBe(false); expect(status.failureEvidence).toBeNull(); expect(status.failureEvidenceError).toMatch(/Could not retain/);
  });
  it('preserves the primary failure, prior evidence and notification cadence when evidence writing fails', async () => {
    const directory = await temporary(), notices: number[] = [];
    const options = { directory, revision: 'abcdef1234567890', fetchImpl: failedFetch(), notify: async (n: number) => { notices.push(n); } };
    await expect(poll(options)).rejects.toThrow(/ETA snapshot/);
    const raw = await fs.readFile(historyFile(directory), 'utf8');
    await fs.mkdir(historyFile(directory) + '.tmp');
    for (let i = 0; i < 3; i++) await expect(poll(options)).rejects.toThrow(/ETA snapshot/);
    expect(await fs.readFile(historyFile(directory), 'utf8')).toBe(raw); expect(notices).toEqual([0]);
    const status = JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'));
    expect(status.error).toMatch(/ETA snapshot/); expect(status.failureEvidence).toBeNull(); expect(status.failureEvidenceError).toMatch(/Could not retain/);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'health.json'), 'utf8')).failures).toBe(4);
  });
});
