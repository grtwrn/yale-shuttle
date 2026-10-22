import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DAY, appendRolling, maintainImages, saveImage, atomicJson, withStorageLock } from './storage.mjs';
import { maintainLearning } from './learning.mjs';
import { rotateOutput } from './maintain.mjs';
const roots = [];
async function root() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shuttle-retention-')); roots.push(dir); return dir; }
afterEach(async () => { vi.useRealTimers(); for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function image(dir, name, at, runId, bytes = 8) {
  await fs.mkdir(path.join(dir, 'images'), { recursive: true });
  await fs.writeFile(path.join(dir, 'images', name), Buffer.alloc(bytes));
  await fs.appendFile(path.join(dir, 'images.jsonl'), JSON.stringify({ name, at: new Date(at).toISOString(), runId, label: name }) + '\n');
}
test('a full store evicts the oldest capture and continues writing with a consistent gallery', async () => {
  const dir = await root(), now = Date.now();
  await atomicJson(path.join(dir, 'storage-policy.json'), { imageMaxBytes: 16 });
  await image(dir, 'old.jpg', now - 2000, 'old'); await image(dir, 'recent.jpg', now - 1000, 'recent');
  const result = await saveImage(dir, { name: 'new.jpg', at: new Date(now).toISOString(), label: 'new', runId: 'new' }, Buffer.alloc(8), 'new');
  expect(result.imageBytes).toBe(16); expect(result.deletedImages).toBe(1);
  expect(await fs.readdir(path.join(dir, 'images'))).toEqual(['new.jpg', 'recent.jpg']);
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
  expect(html).toContain('new.jpg'); expect(html).not.toContain('old.jpg');
  expect((await fs.readFile(path.join(dir, 'images.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
});
test('age retention protects current journey and explicitly pinned evidence', async () => {
  const dir = await root(), now = Date.now();
  for (const [name, run] of [['expired.jpg', 'old'], ['active.jpg', 'active'], ['pinned.jpg', 'pin']]) await image(dir, name, now - 8 * DAY, run);
  await atomicJson(path.join(dir, 'storage-pins.json'), { runIds: ['pin'] });
  const result = await maintainImages(dir, { now, activeRunId: 'active' });
  expect(result.deletedImages).toBe(1); expect(await fs.readdir(path.join(dir, 'images'))).toEqual(['active.jpg', 'pinned.jpg']);
});
test('dry runs preserve bytes and symlinks cannot delete files outside the image store', async () => {
  const dir = await root(), now = Date.now();
  await image(dir, 'expired.jpg', now - 8 * DAY, 'old');
  const other = path.join(dir, 'outside.jpg'); await fs.writeFile(other, 'evidence');
  await fs.symlink(other, path.join(dir, 'images/link.jpg'));
  expect((await maintainImages(dir, { now, dryRun: true })).deletedImages).toBe(1);
  expect(await fs.readFile(path.join(dir, 'images/expired.jpg'))).toHaveLength(8);
  await maintainImages(dir, { now }); expect(await fs.readFile(other, 'utf8')).toBe('evidence');
});
test('metadata recovers an image left by an interrupted write and repeated names never overwrite it', async () => {
  const dir = await root(), now = Date.now(); await fs.mkdir(path.join(dir, 'images'));
  await fs.writeFile(path.join(dir, 'images/orphan.jpg'), 'original');
  await saveImage(dir, { name: 'orphan.jpg', at: new Date(now).toISOString(), label: 'next' }, Buffer.from('next'));
  expect(await fs.readFile(path.join(dir, 'images/orphan.jpg'), 'utf8')).toBe('original');
  expect(await fs.readFile(path.join(dir, 'images/orphan-2.jpg'), 'utf8')).toBe('next');
});
test('JSON logs retain the configured number of chunks and keep complete rows', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T20:00:00Z'));
  const dir = await root(); await atomicJson(path.join(dir, 'storage-policy.json'), { samples: { chunkBytes: 20, maxFiles: 3 } });
  for (let i = 0; i < 12; i++) await appendRolling(dir, 'samples', { i, text: 'sample' });
  const files = (await fs.readdir(dir)).filter(n => /^samples(?:-\d+)?\.jsonl$/.test(n));
  expect(files).toHaveLength(3);
  const rows = (await Promise.all(files.map(f => fs.readFile(path.join(dir, f), 'utf8')))).flatMap(s => s.trim().split('\n').map(JSON.parse));
  expect(rows.map(r => r.i).sort((a, b) => a - b)).toEqual([9, 10, 11]);
});
test('an interrupted lock creation does not permanently stop capture', async () => {
  const dir = await root(), file = path.join(dir, 'storage.lock');
  await fs.writeFile(file, ''); await fs.utimes(file, Date.now() / 1000 - 60, Date.now() / 1000 - 60);
  expect(await withStorageLock(dir, async () => 'recovered')).toBe('recovered');
  expect(await fs.stat(file).catch(e => e.code)).toBe('ENOENT');
});
test('output rotation keeps an append writer usable and bounds compressed backups', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T20:00:00Z'));
  const dir = await root(), file = path.join(dir, 'watcher.log');
  const writer = await fs.open(file, 'a');
  try {
    for (let i = 0; i < 4; i++) { await writer.write(String(i).repeat(64)); await rotateOutput(file, { maxBytes: 32, maxBackups: 2 }); }
    await writer.write('live'); expect(await fs.readFile(file, 'utf8')).toBe('live');
    const backups = (await fs.readdir(dir)).filter(n => n.endsWith('.gz')).sort();
    expect(backups).toHaveLength(2);
    expect(await Promise.all(backups.map(async name => zlib.gunzipSync(await fs.readFile(path.join(dir, name))).toString()))).toEqual(['2'.repeat(32), '3'.repeat(32)]);
  } finally { await writer.close(); }
});
test.each(['legacy','served-control-v2'])('learning cleanup preserves active calibration, pending/candidate receipts and current champion evidence for %s', async protocol => {
  const dir = await root(), now = Date.parse('2026-10-13T20:00:00Z'), active = 'cycle-1791816582411', retired = 'cycle-1791761234701', champion = 'cycle-1791700000000';
  await atomicJson(path.join(dir, 'state.json'), { id: active, forecastProtocol: protocol, calibrationDays: ['2026-10-13', '2026-10-14'],
    champion: { version: 'prospective-1791700000000' }, pending: { x: { at: Date.parse('2026-10-12T16:00:00Z'), closed: false } },
    visits: { x: { candidate: { receivedAt: Date.parse('2026-10-12T15:09:00Z') } } } });
  for (const [cycle, hour] of [[active, '2026-10-12-14'], [active, '2026-10-12-15'], [active, '2026-10-12-16'], [active, '2026-10-13-04'], [retired, '2026-10-12-14'], [champion, '2026-10-12-14']]) {
    const folder = path.join(dir, cycle); await fs.mkdir(folder, { recursive: true });
    await atomicJson(path.join(folder, 'frozen-candidate.json'), { startedAt: Number(cycle.slice(6)) });
    const f = path.join(folder, `feed-${hour}-123.jsonl.gz`); await fs.writeFile(f, 'raw'); await fs.utimes(f, now / 1000 - 100, now / 1000 - 100);
  }
  const result = await maintainLearning(dir, { now, closedMaxBytes: 1 });
  expect(result.removed.map(r => r.reason).sort()).toEqual(protocol === 'served-control-v2' ? ['superseded-cycle'] : ['superseded-cycle', 'unreferenced-warming-input']);
  expect((await fs.readdir(path.join(dir, active))).filter(n => n.startsWith('feed'))).toHaveLength(protocol === 'served-control-v2' ? 4 : 3);
  expect(await fs.readFile(path.join(dir, champion, 'feed-2026-10-12-14-123.jsonl.gz'), 'utf8')).toBe('raw');
  expect(await fs.readFile(path.join(dir, retired, 'frozen-candidate.json'), 'utf8')).toContain('startedAt');
});
