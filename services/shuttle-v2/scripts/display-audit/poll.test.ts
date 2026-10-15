import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { observe, poll, rotateLog } from './poll';
import type { Finding } from './check';
import fixture from '../../web/src/__fixtures__/red-winchester-report-142.json';
const finding: Finding = { kind: 'pickup-count', line: 'Red', bus: '#317', standingStop: 11, targetStop: 48, expected: 3, actual: 11 };
const directories: string[] = [];
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
});
