import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { FeedbackEvidence } from './feedbackEvidence';

const dirs: string[] = [];
const at = 1_790_000_000_000;
const raw = (i = 0) => JSON.stringify({ buses: [{ bus_name: '317', route_id: 16 }],
  server_eta: { v: 2, at: at + i, servedAt: at + i + 500, buses: [], rows: [] }, publicExtra: i });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const directory = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-feedback-source-')); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

describe('immutable feedback public response evidence', () => {
  it('preserves exact bytes, genuine model reference and both checksums through a restart', () => {
    const dir = directory(), store = new FeedbackEvidence({ dir, now: () => at + 1000 });
    const evaluation = { epoch: 'original-epoch', cursor: 9, at, sha256: 'a'.repeat(64) };
    const source = store.observe(raw(), 'image-a', evaluation)!;
    expect(source.sha256).toBe(hash(raw())); expect(source.bytes).toBe(Buffer.byteLength(raw()));
    expect(source.evaluation).toEqual(evaluation);
    const retained = store.retain({ ...source, receivedAt: at + 900, userLatLon: 'ignored by attestation' });
    expect(retained.status).toBe('retained'); if (retained.status !== 'retained') throw Error('Missing evidence');
    const restarted = new FeedbackEvidence({ dir, now: () => at + 999999 });
    const got = restarted.read(source.snapshotId, retained.bundleSha256);
    expect(got.sha256).toBe(hash(got.bytes));
    expect(gunzipSync(Buffer.from(got.bundle.gzipBase64, 'base64')).toString('utf8')).toBe(raw());
    expect(JSON.stringify(got.bundle)).not.toContain('userLatLon');
    expect(restarted.retain(source)).toEqual(retained);
  });
  it('distinguishes cache variants, builds and producer epochs without relabeling the input', () => {
    const store = new FeedbackEvidence({ dir: directory(), now: () => at + 1000 });
    const e = { epoch: 'one', cursor: 1, at, sha256: 'a'.repeat(64) };
    const first = store.observe(raw(), 'one', e)!;
    const otherEpoch = store.observe(raw(), 'one', { ...e, epoch: 'two' })!;
    const otherBuild = store.observe(raw(), 'two', e)!;
    const cacheRebuild = JSON.parse(raw()); cacheRebuild.server_eta.servedAt += 1000;
    const aged = store.observe(JSON.stringify(cacheRebuild), 'one', e)!;
    expect(new Set([first, otherEpoch, otherBuild, aged].map(s => s.snapshotId)).size).toBe(4);
    expect(first.sha256).toBe(otherEpoch.sha256); expect(aged.sha256).not.toBe(first.sha256);
    expect(aged.evaluation).toEqual(e); expect(first.build).toBe('one');
    first.build = 'caller mutation'; expect(store.observe(raw(), 'one', e)!.build).toBe('one');
  });
  it('withholds missing, malformed or mismatched references and does not invent a producer identity', () => {
    const store = new FeedbackEvidence({ dir: directory(), now: () => at + 1000 });
    const source = store.observe(raw(), 'one', { epoch: 'future', cursor: 2, at: at + 5, sha256: 'a'.repeat(64) })!;
    expect(source.evaluation).toBeUndefined();
    expect(store.retain(undefined)).toMatchObject({ status: 'unavailable', reason: 'source-not-supplied' });
    expect(store.retain({ snapshotId: '../private', sha256: 'a'.repeat(64) })).toMatchObject({ reason: 'invalid-source' });
    expect(store.retain({ ...source, modelAt: at + 5 })).toMatchObject({ reason: 'source-mismatch' });
    expect(store.retain({ ...source, evaluation: { epoch: 'forged' } })).toMatchObject({ reason: 'source-mismatch' });
    expect(store.retain({ ...source, snapshotId: 'b'.repeat(64) })).toMatchObject({ reason: 'source-not-retained' });
    expect(store.observe('{}', 'one')).toBeNull(); expect(store.observe(raw(), '../bad')).toBeNull();
  });
  it('does not refresh the age of a repeated snapshot or substitute a newer response after expiry', () => {
    let now = at; const store = new FeedbackEvidence({ dir: directory(), now: () => now, recentMaxAgeMs: 1000 });
    const first = store.observe(raw(), 'one')!; now += 999; store.observe(raw(), 'one');
    now += 2; store.observe(raw(1), 'one');
    expect(store.retain(first)).toMatchObject({ status: 'unavailable', reason: 'source-not-retained' });
    expect(store.stats().recentEntries).toBe(1);
  });
  it('bounds memory by count and compressed bytes and refuses an oversized single payload', () => {
    const store = new FeedbackEvidence({ dir: directory(), now: () => at + 1000, recentMaxEntries: 2, recentMaxBytes: 2000 });
    const first = store.observe(raw(), 'one')!;
    for (let i = 1; i < 10; i++) store.observe(raw(i), 'one');
    expect(store.stats().recentEntries).toBeLessThanOrEqual(2); expect(store.stats().recentBytes).toBeLessThanOrEqual(2000);
    expect(store.retain(first)).toMatchObject({ reason: 'source-not-retained' });
    expect(new FeedbackEvidence({ dir: directory(), maxSourceBytes: 10 }).observe(raw(), 'one')).toBeNull();
    expect(new FeedbackEvidence({ dir: directory(), recentMaxBytes: 10 }).observe(raw(), 'one')).toBeNull();
  });
  it('protects unresolved evidence, refuses a full protected store, and evicts resolved input within its cap', () => {
    const dir = directory(), probe = new FeedbackEvidence({ dir, now: () => at });
    const first = probe.observe(raw(), 'one')!; const saved = probe.retain(first);
    if (saved.status !== 'retained') throw Error('Missing evidence');
    let protectedHashes = new Set([first.snapshotId]);
    const store = new FeedbackEvidence({ dir, now: () => at + 2000,
      retainedMaxBytes: saved.bytes + 10, protectedHashes: () => protectedHashes });
    const second = store.observe(raw(1), 'one')!;
    expect(store.retain(second)).toMatchObject({ reason: 'storage-limit' });
    expect(store.read(first.snapshotId).bundle.source.sha256).toBe(first.sha256);
    protectedHashes = new Set();
    expect(store.retain(second).status).toBe('retained');
    expect(() => store.read(first.snapshotId)).toThrow();
    expect(fs.readdirSync(dir).filter(n => n.endsWith('.json'))).toEqual([second.snapshotId + '.json']);
  });
  it('cleans aged resolved files while preserving unresolved files and refuses an unavailable protection list', () => {
    let now = at; const dir = directory(), protectedHashes = new Set<string>();
    const store = new FeedbackEvidence({ dir, now: () => now, retainedMaxAgeMs: 1000, protectedHashes: () => protectedHashes });
    const one = store.observe(raw(), 'one')!, two = store.observe(raw(1), 'one')!;
    store.retain(one); store.retain(two); protectedHashes.add(one.snapshotId);
    for (const id of [one.snapshotId, two.snapshotId]) fs.utimesSync(path.join(dir, id + '.json'), at / 1000, at / 1000);
    now += 61000; store.maintain();
    expect(store.read(one.snapshotId)).toBeTruthy(); expect(() => store.read(two.snapshotId)).toThrow();
    const unavailable = new FeedbackEvidence({ dir, now: () => now, retainedMaxBytes: 1,
      protectedHashes: () => { throw Error('Cannot establish which reports are open'); } });
    unavailable.maintain(); expect(unavailable.stats().lastError).toBe('maintenance-failed');
    expect(store.read(one.snapshotId)).toBeTruthy();
  });
  it('reports I/O failures without throwing and preserves corruption for investigation', () => {
    const dir = directory(), invalid = path.join(dir, 'file'); fs.writeFileSync(invalid, 'not a directory');
    const broken = new FeedbackEvidence({ dir: invalid, now: () => at }); const s = broken.observe(raw(), 'one')!;
    expect(broken.retain(s)).toMatchObject({ reason: 'storage-failed' });
    const store = new FeedbackEvidence({ dir, now: () => at }); const source = store.observe(raw(), 'one')!;
    const receipt = store.retain(source); if (receipt.status !== 'retained') throw Error('Missing evidence');
    const file = path.join(dir, source.snapshotId + '.json'), original = fs.readFileSync(file);
    const corrupt = JSON.parse(original.toString()); corrupt.gzipSha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(corrupt));
    expect(() => store.read(source.snapshotId, receipt.bundleSha256)).toThrow('checksum');
    expect(store.retain(source)).toMatchObject({ reason: 'storage-failed' });
    expect(fs.readFileSync(file)).not.toEqual(original);
  });
  it('counts and preserves unknown crash files within the archive byte cap', () => {
    const dir = directory(), file = path.join(dir, 'incomplete-write.tmp'); fs.writeFileSync(file, 'unresolved partial input');
    const store = new FeedbackEvidence({dir, now: () => at, retainedMaxBytes: 1});
    const source = store.observe(raw(), 'one')!;
    expect(store.retain(source)).toMatchObject({status: 'unavailable', reason: 'storage-limit'});
    expect(store.stats().retained.unknownBytes).toBe(Buffer.byteLength('unresolved partial input'));
    expect(fs.readFileSync(file, 'utf8')).toBe('unresolved partial input');
  });
  it('reserves free space for the collector while preserving unresolved evidence', () => {
    const dir = directory(), original = new FeedbackEvidence({dir, now: () => at});
    const first = original.observe(raw(), 'one')!, saved = original.retain(first);
    expect(saved.status).toBe('retained');
    const low = new FeedbackEvidence({dir, now: () => at + 1000, availableBytes: () => 95 * 1024 * 1024,
      protectedHashes: () => new Set([first.snapshotId])});
    const next = low.observe(raw(1), 'one')!;
    expect(low.retain(next)).toMatchObject({status: 'unavailable', reason: 'storage-space'});
    expect(low.stats().lastError).toBe('storage-space');
    expect(low.read(first.snapshotId).bundle.source.sha256).toBe(first.sha256);
    expect(low.retain(first).status).toBe('retained'); // reading needs no extra disk space
  });
});
