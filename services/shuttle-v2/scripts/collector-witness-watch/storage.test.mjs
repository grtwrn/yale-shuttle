import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { WitnessStore, StorageHold } from './storage.mjs';
import { fixture, association } from './testFixtures.mjs';
import { witnessJSON, witnessSHA } from '../../src/collector/witnessCodec.ts';

const roots = [], stores = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
afterEach(() => {
  for (const s of stores.splice(0)) try { s.close(); } catch {}
  for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
function open(policy = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-witness-test-')); roots.push(dir);
  const store = new WitnessStore(dir, { policy: { minFreeBytes: 0, ...policy } }); stores.push(store);
  return store;
}
function start(store, f) { store.updateReports([], { now: f.at }); store.beginEpoch(f.head(), 'test', f.at); }
function commit(store, f, after = store.checkpoint().after, options = {}) { return store.commitPage(f.page(after), { seenHead: f.head(), now: f.at, ...options }); }

describe('durable bounded collector evidence', () => {
  it('commits bytes and cursor together, survives a fresh process and deduplicates lost acknowledgments', () => {
    const f = fixture(), s = open(); f.add(); start(s, f);
    const page = f.page(), first = commit(s, f, 0, { transport: { receivedAt: 123 } });
    const cp = s.checkpoint(), file = s.file; s.close(); stores.splice(stores.indexOf(s), 1);
    const moduleURL = new URL('./storage.mjs', import.meta.url).href;
    const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import{WitnessStore}from ${JSON.stringify(moduleURL)};const s=new WitnessStore(${JSON.stringify(path.dirname(file))},{policy:{minFreeBytes:0}});const r=s.commitPage(${JSON.stringify(page)},{seenHead:${JSON.stringify(f.head())}});console.log(JSON.stringify({duplicate:r.duplicate,cp:s.checkpoint(),receipt:s.readChunk(r.key).transport.receivedAt}));s.close();`], { cwd: process.cwd(), encoding: 'utf8' }));
    expect(result).toEqual({ duplicate: true, cp, receipt: 123 });
    const restored = new WitnessStore(path.dirname(file), { policy: { minFreeBytes: 0 } }); stores.push(restored);
    expect(restored.readChunk(first.key).frames[0].json).toBe(page.frames[0].json);
    f.add(); commit(restored, f); const advanced = restored.checkpoint();
    restored.commitPage(page, { seenHead: f.head() }); expect(restored.checkpoint()).toEqual(advanced);
  });
  it('rolls back chunks, topology and cursor if a later index write fails; retry commits once', () => {
    const f = fixture(), s = open(), frame = f.add(); start(s, f); const before = s.checkpoint(), page = f.page(); page.evaluations = [association(frame)];
    s.db.exec("CREATE TRIGGER fault BEFORE INSERT ON model_refs BEGIN SELECT RAISE(ABORT,'injected later SQL failure'); END");
    expect(() => s.commitPage(page, { seenHead: f.head(), now: f.at })).toThrow('injected');
    expect(s.checkpoint()).toEqual(before); expect(s.db.prepare('SELECT count(*) n FROM chunks').get().n).toBe(0);
    expect(s.db.prepare('SELECT count(*) n FROM topologies').get().n).toBe(0);
    s.db.exec('DROP TRIGGER fault'); s.commitPage(page, { seenHead: f.head(), now: f.at });
    expect(s.checkpoint().after).toBe(1); expect(s.db.prepare('SELECT count(*) n FROM chunks').get().n).toBe(1);
  });
  it('links late model references without counting a second poll and acknowledges unchanged revisits', () => {
    const f = fixture(), s = open(), frame = f.add(); start(s, f); commit(s, f);
    const page = f.page(); page.evaluations = [association(frame)]; const head = { ...f.head(), evaluationCursor: 1 };
    s.commitPage(page, { seenHead: head, revisit: true, now: f.at });
    expect(s.checkpoint().after).toBe(1); expect(s.db.prepare('SELECT count(*) n FROM frames').get().n).toBe(1);
    expect(s.db.prepare('SELECT count(*) n FROM model_refs').get().n).toBe(1);
    s.commitPage(page, { seenHead: { ...head, evaluationCursor: 2 }, revisit: true, now: f.at });
    expect(s.checkpoint().evaluationCursor).toBe(2);
    expect(() => s.commitPage({ ...page, frames: [{ ...frame, at: frame.at + 1 }] }, { seenHead: head, revisit: true, now: f.at })).toThrow('revisit');
  });
  it('protects report-linked history and diagnostics while physically shrinking unprotected expired chunks', () => {
    const f = fixture(), s = open({ maxAgeMs: 1000 }); const frame = f.add(); start(s, f);
    const page = f.page(); page.evaluations = [association(frame)]; const first = s.commitPage(page, { seenHead: f.head(), now: f.at });
    const report = { id: 150, status: 'open', createdAt: new Date(f.at + 86400000).toISOString(), context: JSON.stringify({ screen: { evaluation: association(frame).evaluation } }) };
    s.updateReports([report], { now: f.at });
    f.add({ observations: [{ blob: randomBytes(60000).toString('base64') }] }); const second = commit(s, f);
    // Move beyond the report's surrounding history window.
    for (let i = 0; i < 62; i++) f.add();
    let cp = s.checkpoint().after;
    while (cp < f.head().latest) { commit(s, f, cp); cp = s.checkpoint().after; }
    s.updateReports([report], { now: f.at }); const before = s.disk().bytes;
    s.maintain({ now: f.at });
    expect(s.readChunk(first.key).frames[0].seq).toBe(1);
    expect(s.get('reportProtection').findings[0].protection).toBe('model-reference-and-time-window');
    // Resolution releases historical pins; the current checkpoint chunk stays.
    s.updateReports([], { now: f.at }); const r = s.maintain({ now: f.at });
    expect(() => s.readChunk(first.key)).toThrow('unavailable'); expect(() => s.readChunk(second.key)).toThrow('unavailable');
    expect(r.bytes).toBeLessThan(before); expect(r.bytes).toBeLessThan(r.maxBytes);
  });
  it('keeps incident source rows and their topology through age cleanup', () => {
    const f = fixture(), s = open({ maxAgeMs: 1000 });
    const afterJSON = witnessJSON({ id: 77, from_stop_id: 1, to_stop_id: 2, leg_sec: 5 });
    f.add({ sourceWrites: [{ mutations: [{ table: 'legs', afterJSON, afterSHA256: witnessSHA(afterJSON) }] }] }); start(s, f);
    const first = commit(s, f); f.add(); commit(s, f); s.updateReports([], { now: f.at });
    const r = s.maintain({ now: f.at }); expect(r.incidents).toBe(1); expect(s.readChunk(first.key).frames).toHaveLength(1);
    expect(s.topology(f.topology.sha256).json).toBe(f.topology.json);
  });
  it('retains shared frame headers through late-association cleanup and retires only the old epoch', () => {
    const f = fixture(), s = open({ maxAgeMs: 60000 });
    f.add(); start(s, f); const first = commit(s, f);
    const frame = f.add(), original = commit(s, f), late = f.page(1);
    late.evaluations = [association(frame)];
    const retained = s.commitPage(late, { seenHead: { ...f.head(), evaluationCursor: 1 }, revisit: true, now: f.at });
    const cp = s.checkpoint();
    f.advance(62000); s.updateReports([], { now: f.at });
    expect(s.maintain({ now: f.at }).deleted).toBe(2);
    expect(() => s.readChunk(first.key)).toThrow('unavailable');
    expect(() => s.readChunk(original.key)).toThrow('unavailable');
    expect(s.readChunk(retained.key).frames[0]).toEqual(frame);
    expect(s.db.prepare('SELECT epoch,seq FROM frames').all()).toEqual([{ epoch: 'collector-test', seq: 2 }]);
    expect(s.db.prepare('SELECT collector_seq FROM model_refs').all()).toEqual([{ collector_seq: 2 }]);
    expect(s.checkpoint()).toEqual(cp);

    const next = fixture({ epoch: 'next-collector-epoch' }); next.advance(100000); next.add();
    start(s, next); const current = commit(s, next); s.updateReports([], { now: next.at });
    expect(s.maintain({ now: next.at }).deleted).toBe(1);
    expect(() => s.readChunk(retained.key)).toThrow('unavailable');
    expect(s.readChunk(current.key).frames[0].seq).toBe(1);
    expect(s.db.prepare('SELECT epoch,seq FROM frames').all()).toEqual([{ epoch: 'next-collector-epoch', seq: 1 }]);
    expect(s.db.prepare('SELECT count(*) n FROM model_refs').get().n).toBe(0);
    expect(s.topology(next.topology.sha256).json).toBe(next.topology.json);
    expect(s.checkpoint()).toMatchObject({ epoch: 'next-collector-epoch', after: 1 });
  });
  it('holds on a full protected store, preserves its cursor and measures journal-inclusive disk use', () => {
    const f = fixture(), s = open({ maxBytes: 3 * 1024 * 1024 }), at = f.at;
    f.add(); start(s, f);
    s.updateReports([{ id: 150, status: 'open', createdAt: new Date(at).toISOString(), context: '{}' }], { now: f.at });
    let peak = 0;
    s.db.function('observe_disk', () => { peak = Math.max(peak, s.disk().bytes); return 0; });
    s.db.exec('CREATE TRIGGER measure_disk AFTER INSERT ON chunks BEGIN SELECT observe_disk(); END');
    let held = false;
    for (let i = 0; i < 15; i++) {
      const cp = s.checkpoint(); f.add({ observations: [{ blob: randomBytes(80000).toString('base64') }] });
      try { commit(s, f); } catch (e) { expect(e).toBeInstanceOf(StorageHold); expect(s.checkpoint()).toEqual(cp); held = true; break; }
    }
    expect(held).toBe(true); expect(peak).toBeGreaterThan(0); expect(peak).toBeLessThan(3 * 1024 * 1024);
    expect(s.maintain({ now: f.at }).reportProtection[0].availableChunks).toBeGreaterThan(0);
  });
  it('does not advance or delete evidence on corrupted topology, unknown files or an incomplete report queue', () => {
    const f = fixture(), s = open({ maxAgeMs: 1 }); f.add(); start(s, f); const first = commit(s, f); f.add(); const cp = s.checkpoint();
    s.updateReports([], { complete: false, now: f.at });
    expect(s.maintain({ now: f.at }).cleanupUncertain).toBe(true); expect(s.readChunk(first.key)).toBeTruthy();
    fs.writeFileSync(path.join(s.root, 'unknown.partial'), 'preserve');
    expect(() => commit(s, f)).toThrow(StorageHold); expect(s.checkpoint()).toEqual(cp);
    fs.unlinkSync(path.join(s.root, 'unknown.partial'));
    s.db.prepare('UPDATE topologies SET payload=?').run(Buffer.from('corrupt'));
    expect(() => commit(s, f)).toThrow(); expect(s.checkpoint()).toEqual(cp);
  });
  it('a concurrent read transaction blocks the writer without losing an acknowledged cursor', () => {
    const f = fixture(), s = open(); f.add(); start(s, f); commit(s, f); const cp = s.checkpoint();
    const reader = new DatabaseSync(s.file, { readOnly: true });
    try {
      reader.exec('BEGIN'); reader.prepare('SELECT count(*) n FROM chunks').get(); f.add();
      expect(() => commit(s, f)).toThrow(/locked|busy/i); expect(s.checkpoint()).toEqual(cp);
      reader.exec('COMMIT'); commit(s, f); expect(s.checkpoint().after).toBe(2);
    } finally { reader.close(); }
  });
  it('exports a closed database that can be reopened without the original directory', () => {
    const f = fixture(), s = open(); f.add(); start(s, f); const saved = commit(s, f); const original = s.file;
    s.close(); stores.splice(stores.indexOf(s), 1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-witness-export-')); roots.push(dir);
    fs.copyFileSync(original, path.join(dir, 'witnesses.sqlite'));
    const restored = new WitnessStore(dir, { policy: { minFreeBytes: 0 } }); stores.push(restored);
    expect(restored.readChunk(saved.key).frames[0].json).toBe(f.page().frames[0].json);
    expect(restored.topology(f.topology.sha256).json).toBe(f.topology.json);
    expect(restored.checkpoint().after).toBe(1);
  });
  it('keeps legacy null references unknown and refuses a forked model identity without advancing', () => {
    const f = fixture(), s = open(), frame = f.add(); start(s, f);
    expect(s.updateReports([{ id: 151, status: 'open', createdAt: new Date(f.at).toISOString(), context: '{"evaluation":null}' }], { now: f.at }).uncertain).toBe(false);
    const page = f.page(); page.evaluations = [association(frame)]; s.commitPage(page, { seenHead: f.head(), now: f.at });
    const cp = s.checkpoint(), fork = structuredClone(page); fork.evaluations[0].evaluation.sha256 = 'f'.repeat(64);
    expect(() => s.commitPage(fork, { seenHead: f.head(), revisit: true, now: f.at })).toThrow('Conflicting');
    expect(s.checkpoint()).toEqual(cp); expect(s.db.prepare('SELECT count(*) n FROM model_refs').get().n).toBe(1);
  });
});
