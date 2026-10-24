import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { CountdownProjection, sha } from './projection.mjs';
import { runOnce } from './poll.mjs';
import { maintainFindings, DEFAULT_POLICY } from './storage.mjs';

const directories = [];
const temporary = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'countdown-watch-')); directories.push(p); return p; };
afterEach(() => { for (const p of directories.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const base = Date.parse('2026-10-24T15:00:00Z');
const source = { cycle: 'cycle-1', sourceKey: 'a'.repeat(64), build: 'fixture', epoch: 'epoch-a' };
function record(seq, eta, { at = base + seq * 5000, stops = [22], epoch = source.epoch,
  build = source.build, anchor = 4, following = false } = {}) {
  const rows = stops.map(stop => [0, stop, eta, eta - 30, eta + 100, 3, 0, eta, eta - 30]);
  if (following) rows.push([0, 22, eta + 2800, eta + 2600, eta + 3000, 21, 0, eta + 2800, eta + 2600]);
  const payload = { buses: [{ bus_name: '#101', bus_id: 101, route_id: 9, lat: 41.3, lon: -72.9 }],
    model_params: { version: 'fixture-only' }, segments: {}, dwells: {},
    server_eta: { v: 2, at, servedAt: at, buses: [['101', 'Green', anchor, null]],
      travel: [anchor], rows, distributions: rows.map(row => Array(50).fill(row[2])),
      repeatVisits: following ? [[0, 22, 21]] : [] } };
  const json = JSON.stringify(payload), contextJson = JSON.stringify({ at, v: 1 });
  const frame = { seq, at, json, bytes: Buffer.byteLength(json), sha256: sha(json),
    contextJson, contextBytes: Buffer.byteLength(contextJson), contextSha256: sha(contextJson) };
  return { receivedAt: at + 100, source: { build, epoch, cursor: seq,
    responseAt: at + 90, hasMore: false, frames: [frame], feed: payload } };
}
function fixture(records) {
  const learningRoot = temporary(), directory = temporary(), cycle = path.join(learningRoot, source.cycle);
  fs.mkdirSync(cycle);
  const frozen = JSON.stringify({ id: source.cycle, sourceKey: source.sourceKey,
    productionBuild: source.build, source: { epoch: source.epoch } });
  fs.writeFileSync(path.join(cycle, 'frozen-candidate.json'), frozen);
  const name = 'feed-2026-10-24-15-1.jsonl.gz', file = path.join(cycle, name);
  let now;
  function update(next, { rawBytes } = {}) {
    if (next.length) fs.appendFileSync(file, gzipSync(next.map(r => JSON.stringify(r)).join('\n') + '\n'));
    if (rawBytes) fs.appendFileSync(file, rawBytes);
    now = next.at(-1)?.receivedAt ?? now;
    fs.writeFileSync(path.join(learningRoot, 'state.json'), JSON.stringify({ id: source.cycle,
      forecastProtocol: 'served-control-v2', sourceKey: source.sourceKey, productionBuild: source.build,
      frozenCandidateSha256: sha(frozen), source: { epoch: source.epoch, inputFiles: { [name]: fs.statSync(file).size } } }));
    fs.writeFileSync(path.join(learningRoot, 'status.json'), JSON.stringify({ cycle: source.cycle,
      running: true, feedReceivedAt: new Date(now).toISOString() }));
  }
  update(records);
  return { learningRoot, directory, file, update, get now() { return now; },
    run(options = {}) { return runOnce({ learningRoot, directory, now, ...options }); },
    state() { return fs.readFileSync(path.join(directory, 'state.json')); },
    findings() { return fs.readdirSync(path.join(directory, 'findings')).filter(n => n.endsWith('.json.gz')); } };
}

describe('durable original-offer projection', () => {
  it('recovers a pending jump in a fresh instance with exact original bytes and all repeated calls', () => {
    const records = [record(1, 180, { following: true }), record(2, 3022, { following: true }), record(3, 170, { following: true })];
    const first = new CountdownProjection(); first.consume(records[0], source); first.consume(records[1], source);
    const resumed = new CountdownProjection(first.snapshot()); resumed.consume(records[2], source);
    const [finding] = resumed.findings(); expect(finding.body.events).toHaveLength(1);
    expect(finding.body.events[0].before.rows).toHaveLength(2);
    expect(finding.body.events[0].jump.rows[1].distribution).toHaveLength(50);
    expect(finding.body.events[0].jump.rows[1].explicitFollowing).toBe(true);
    for (const r of records) expect(finding.body.frames[r.source.frames[0].sha256].frame).toEqual(r.source.frames[0]);
    expect(finding.body.physicalETAErrorEstablished).toBe(false);
  });
  it('consolidates overlapping stops without dropping either complete forecast triple', () => {
    const p = new CountdownProjection();
    for (const [i, eta] of [180, 3022, 170].entries()) p.consume(record(i + 1, eta, { stops: [22, 23] }), source);
    const [finding] = p.findings(); expect(p.findings()).toHaveLength(1);
    expect(finding.body.events.map(e => e.stop)).toEqual([22, 23]);
    expect(Object.keys(finding.body.frames)).toHaveLength(3);
  });
  it('correlates a later overlapping finding part with the same episode after restart', () => {
    const p = new CountdownProjection();
    for (const [i, eta] of [180, 3022, 170].entries()) p.consume(record(i + 1, eta), source);
    const q = new CountdownProjection(p.snapshot()); q.consume(record(4, 3012), source); q.consume(record(5, 160), source);
    expect(q.findings()[0].body.episodeId).toBe(p.findings()[0].body.episodeId);
    expect(q.findings()[0].id).not.toBe(p.findings()[0].id);
  });
  it.each(['epoch', 'build', 'sourceKey', 'cycle'])('never joins %s namespaces across a restart', key => {
    const p = new CountdownProjection(); p.consume(record(1, 180), source);
    const next = { ...source, [key]: key === 'cycle' ? 'cycle-2' : key === 'sourceKey' ? 'b'.repeat(64) : 'next' };
    const q = new CountdownProjection(p.snapshot()); q.consume(record(2, 3022, next), next); q.consume(record(3, 170, next), next);
    expect(q.findings()).toEqual([]); expect(q.boundaries[0].reason).toBe('source-changed');
  });
  it.each(['sequence', 'clock'])('marks a %s gap unknown instead of closing a reversal', kind => {
    const p = new CountdownProjection(); p.consume(record(1, 180), source); p.consume(record(2, 3022), source);
    p.consume(record(kind === 'sequence' ? 4 : 3, 170, { at: kind === 'clock' ? base + 200000 : base + 20000 }), source);
    expect(p.findings()).toEqual([]); expect(p.boundaries.at(-1).reason).toBe('cursor-or-clock-gap');
  });
  it('breaks comparisons on a fresh missing-forecast receipt without inventing an empty fleet', () => {
    const p = new CountdownProjection(); p.consume(record(1, 180), source); p.consume(record(2, 3022), source);
    const missing = record(3, 170); missing.source.frames = []; missing.source.feed.server_eta = null;
    p.consume(missing, source); p.consume(record(4, 165), source);
    expect(p.findings()).toEqual([]); expect(p.boundaries.some(b => b.reason === 'current-forecast-unavailable')).toBe(true);
    expect(p.state.feedReceipt.emptyFleet).toBe(false);
  });
  it.each(['body', 'context', 'quantile'])('refuses corrupted %s evidence', kind => {
    const p = new CountdownProjection(), bad = record(1, 180), frame = bad.source.frames[0];
    if (kind === 'body') frame.json += ' ';
    if (kind === 'context') frame.contextJson += ' ';
    if (kind === 'quantile') { const payload = JSON.parse(frame.json); payload.server_eta.distributions[0][49] = -1;
      frame.json = JSON.stringify(payload); frame.bytes = Buffer.byteLength(frame.json); frame.sha256 = sha(frame.json); }
    expect(() => p.consume(bad, source)).toThrow(); expect(p.findings()).toEqual([]);
  });
});

describe('read-only local polling and protected rolling evidence', () => {
  it('resumes concatenated gzip prefixes, commits one finding, and leaves all source bytes unchanged', async () => {
    const x = fixture([record(1, 180), record(2, 3022)]); expect((await x.run()).ok).toBe(true);
    x.update([record(3, 170)]); const original = fs.readFileSync(x.file), result = await x.run();
    expect(result.ok).toBe(true); expect(result.newFrames).toBe(1); expect(x.findings()).toHaveLength(1);
    const body = JSON.parse(gunzipSync(fs.readFileSync(path.join(x.directory, 'findings', x.findings()[0]))));
    expect(body.events[0].before.seq).toBe(1); expect(body.events[0].returned.seq).toBe(3);
    expect(fs.readFileSync(x.file)).toEqual(original);
    const repeat = await x.run(); expect(repeat.ok).toBe(true); expect(repeat.newFrames).toBe(0); expect(x.findings()).toHaveLength(1);
  });
  it('waits for a partial gzip/JSON tail and then consumes the original completed record once', async () => {
    const x = fixture([record(1, 180), record(2, 3022)]); expect((await x.run()).ok).toBe(true);
    const bytes = gzipSync(JSON.stringify(record(3, 170)) + '\n'), cut = Math.floor(bytes.length / 2);
    x.update([], { rawBytes: bytes.subarray(0, cut) });
    expect((await x.run()).ok).toBe(true); expect(x.findings()).toHaveLength(0);
    x.update([], { rawBytes: bytes.subarray(cut) });
    expect((await x.run()).ok).toBe(true); expect(x.findings()).toHaveLength(1);
  });
  it('preserves the committed cursor when a prior compressed prefix is changed', async () => {
    const x = fixture([record(1, 180), record(2, 3022)]); expect((await x.run()).ok).toBe(true);
    const prior = x.state(), bytes = fs.readFileSync(x.file); bytes[15] ^= 1; fs.writeFileSync(x.file, bytes);
    expect((await x.run()).ok).toBe(false); expect(x.state()).toEqual(prior); expect(x.findings()).toHaveLength(0);
  });
  it('does not advance or evict open evidence when its protected storage is full', async () => {
    const x = fixture([record(1, 180), record(2, 3022)]); expect((await x.run()).ok).toBe(true);
    const prior = x.state(); x.update([record(3, 170)]);
    const original = path.join(x.directory, 'findings', 'orphan.partial'); fs.writeFileSync(original, 'protected');
    const result = await x.run({ policy: { maxOpenBytes: 1 } });
    expect(result.ok).toBe(false); expect(x.state()).toEqual(prior); expect(fs.readFileSync(original, 'utf8')).toBe('protected');
  });
  it('reuses an orphaned immutable finding after a checkpoint write failure instead of duplicating it', async () => {
    const x = fixture([record(1, 180), record(2, 3022)]); expect((await x.run()).ok).toBe(true);
    const prior = x.state(); x.update(Array.from({ length: 18 }, (_, i) => record(i + 3, 170 - i * 5)));
    const failed = await x.run({ policy: { maxStateBytes: prior.length + 1 } });
    expect(failed.ok).toBe(false); expect(failed.reason).toContain('checkpoint exceeds bound');
    expect(x.findings()).toHaveLength(1); const retained = fs.readFileSync(path.join(x.directory, 'findings', x.findings()[0]));
    expect(x.state()).toEqual(prior);
    const recovered = await x.run(); expect(recovered.ok).toBe(true); expect(recovered.newFindingParts[0].existing).toBe(true);
    expect(x.findings()).toHaveLength(1); expect(fs.readFileSync(path.join(x.directory, 'findings', x.findings()[0]))).toEqual(retained);
  });
  it('requires a matching explicit review receipt before age or size can remove a finding', async () => {
    const x = fixture([record(1, 180), record(2, 3022), record(3, 170)]); expect((await x.run()).ok).toBe(true);
    const name = x.findings()[0], file = path.join(x.directory, 'findings', name), bytes = fs.readFileSync(file), id = name.slice(0, 64);
    const policy = { ...DEFAULT_POLICY, maxReviewedAgeMs: 1 };
    expect((await maintainFindings(x.directory, { policy, now: x.now + 100 })).removed).toBe(0);
    const receipt = { id, status: 'reviewed', reviewedAt: new Date(x.now).toISOString(),
      note: 'Synthetic control; no actual rider or physical outcome.', bundleSHA256: '0'.repeat(64) };
    const review = path.join(x.directory, 'reviews', id + '.json'); fs.writeFileSync(review, JSON.stringify(receipt));
    expect((await maintainFindings(x.directory, { policy, now: x.now + 100 })).removed).toBe(0);
    receipt.bundleSHA256 = sha(bytes); fs.writeFileSync(review, JSON.stringify(receipt));
    expect((await maintainFindings(x.directory, { policy, now: x.now + 100 })).removed).toBe(1);
    expect(fs.existsSync(file)).toBe(false); expect(fs.existsSync(review)).toBe(false);
    fs.writeFileSync(review, JSON.stringify(receipt)); // Recovery of interrupted paired removal.
    await maintainFindings(x.directory, { policy, now: x.now + 100 });
    expect(fs.existsSync(review)).toBe(false);
  });
  it('refuses stale native input without changing its existing checkpoint', async () => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true); const prior = x.state();
    expect((await x.run({ now: x.now + 180000 })).ok).toBe(false); expect(x.state()).toEqual(prior);
  });
  it('keeps fresh idle receipts healthy while retaining the actual older model clock', async () => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true);
    const idle = record(1, 0, { at: base + 200000 }); idle.source.frames = [];
    idle.source.feed = { buses: [], server_eta: null }; x.update([idle]);
    const first = await x.run(); expect(first.ok).toBe(true); expect(first.lastFrame.at).toBe(base + 5000);
    expect(first.feedReceipt.emptyFleet).toBe(true); expect(first.newFrames).toBe(0);
    idle.receivedAt += 10000; idle.source.responseAt += 10000; x.update([idle]);
    const next = await x.run(); expect(next.ok).toBe(true); expect(next.boundaries).toHaveLength(0);
  });
  it('rejects overlapping output and input directories before writing into the native tree', async () => {
    const x = fixture([record(1, 180)]);
    await expect(runOnce({ directory: path.join(x.learningRoot, 'bad-output'), learningRoot: x.learningRoot, now: x.now })).rejects.toThrow('separate');
    expect(fs.existsSync(path.join(x.learningRoot, 'bad-output'))).toBe(false);
  });
});
