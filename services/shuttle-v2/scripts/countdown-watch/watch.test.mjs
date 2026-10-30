import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { CountdownProjection, sha } from './projection.mjs';
import { runOnce, boundedFiles, COUNTDOWN_CODE_SHA256 } from './poll.mjs';
import { migrateCheckpoint, PRE_BATCH_CODE_SHA256 } from './migrate.mjs';
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

function addHour(x, hour, records, rawBytes) {
  const stamp = new Date(base + hour * 3600000).toISOString().slice(0, 13).replace('T', '-');
  const name = `feed-${stamp}-1.jsonl.gz`, file = path.join(x.learningRoot, source.cycle, name);
  if (records.length) fs.appendFileSync(file, gzipSync(records.map(r => JSON.stringify(r)).join('\n') + '\n'));
  if (rawBytes) fs.appendFileSync(file, rawBytes);
  const liveFile = path.join(x.learningRoot, 'state.json'), live = JSON.parse(fs.readFileSync(liveFile));
  live.source.inputFiles[name] = fs.statSync(file).size;
  fs.writeFileSync(liveFile, JSON.stringify(live));
  if (records.length) fs.writeFileSync(path.join(x.learningRoot, 'status.json'), JSON.stringify({
    cycle: source.cycle, running: true, feedReceivedAt: new Date(records.at(-1).receivedAt).toISOString() }));
  return file;
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

describe('bounded chronological countdown catch-up', () => {
  it('bounds an oldest-first prefix even when the original backlog exceeds eight files and 512 MiB', () => {
    const MiB = 1024 * 1024;
    const files = Array.from({ length: 12 }, (_, i) => ({ name: String(i), bytes: 200 * MiB }));
    expect(boundedFiles(files)).toEqual(files.slice(0, 2));
    expect(boundedFiles(files, { maxFiles: 8, maxBytes: 512 * MiB })).toEqual(files.slice(0, 2));
    expect(() => boundedFiles(files, { maxFiles: 9, maxBytes: 512 * MiB })).toThrow('bounds');
    expect(() => boundedFiles(files, { maxFiles: 8, maxBytes: 513 * MiB })).toThrow('bounds');
    expect(() => boundedFiles(files, { maxFiles: 2, maxBytes: 100 * MiB })).toThrow('bound');
  });
  it('commits historical progress across more than eight original files and resumes after every batch', async () => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true);
    const originals = new Map([[x.file, fs.readFileSync(x.file)]]);
    let last;
    for (let hour = 1; hour < 12; hour++) {
      const records = [180, 3022, 170].map((eta, i) => record(hour * 3 + i - 1, eta,
        { at: base + hour * 3600000 + i * 5000 }));
      last = records.at(-1); const file = addHour(x, hour, records); originals.set(file, fs.readFileSync(file));
    }
    const frontiers = []; let result;
    for (let attempt = 0; attempt < 12; attempt++) {
      result = await x.run({ now: last.receivedAt });
      frontiers.push(JSON.parse(x.state()).frontier);
      expect(result.read.files).toBe(2);
      if (result.ok) break;
      expect(result.errorCode).toBe('backfill_pending');
      expect(result.caughtUp).toBe(false);
      expect(result.lastFrame.at).toBeLessThan(last.receivedAt - 120000);
      expect(JSON.parse(x.state()).checkedAt).toBe(last.receivedAt);
    }
    expect(result.ok).toBe(true); expect(result.caughtUp).toBe(true);
    expect(result.read.pendingFiles).toBe(0); expect(result.totalFrames).toBe(34);
    expect(new Set(frontiers).size).toBe(11); expect(x.findings()).toHaveLength(11);
    const repeated = await x.run({ now: last.receivedAt });
    expect(repeated.ok).toBe(true); expect(repeated.newFrames).toBe(0); expect(x.findings()).toHaveLength(11);
    for (const [file, bytes] of originals) expect(fs.readFileSync(file)).toEqual(bytes);
  });
  it('keeps the exact pending comparison across a batch and finds the original reversal after restart', async () => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true);
    const records = [record(2, 180, { at: base + 2 * 3600000 - 5000 }),
      record(3, 3022, { at: base + 2 * 3600000 }),
      record(4, 170, { at: base + 2 * 3600000 + 5000 })];
    addHour(x, 1, records.slice(0, 1)); addHour(x, 2, records.slice(1));
    const partial = await x.run({ now: records.at(-1).receivedAt });
    expect(partial.ok).toBe(false); expect(partial.errorCode).toBe('backfill_pending');
    expect(partial.lastFrame.seq).toBe(2); expect(x.findings()).toHaveLength(0);
    const recovered = await x.run({ now: records.at(-1).receivedAt });
    expect(recovered.ok).toBe(true); expect(recovered.newFrames).toBe(2); expect(x.findings()).toHaveLength(1);
    const finding = JSON.parse(gunzipSync(fs.readFileSync(path.join(x.directory, 'findings', x.findings()[0]))));
    expect(finding.events[0].before.seq).toBe(2); expect(finding.events[0].returned.seq).toBe(4);
    for (const r of records) expect(finding.frames[r.source.frames[0].sha256].frame).toEqual(r.source.frames[0]);
  });
  it('honors the compressed byte budget on actual original files, then resumes with the same byte budget', async () => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true);
    const next = record(2, 175, { at: base + 3600000 }), last = record(3, 170, { at: base + 2 * 3600000 });
    const second = addHour(x, 1, [next]), third = addHour(x, 2, [last]);
    const sizes = [x.file, second, third].map(file => fs.statSync(file).size);
    const readBounds = { maxFiles: 8, maxBytes: Math.max(sizes[0] + sizes[1], sizes[1] + sizes[2]) + 1 };
    expect(sizes.reduce((a, b) => a + b)).toBeGreaterThan(readBounds.maxBytes);
    const progress = await x.run({ now: last.receivedAt, readBounds });
    expect(progress.errorCode).toBe('backfill_pending'); expect(progress.read.files).toBe(2);
    expect(progress.read.bytes).toBeLessThanOrEqual(readBounds.maxBytes); expect(progress.lastFrame.seq).toBe(2);
    const recovered = await x.run({ now: last.receivedAt, readBounds });
    expect(recovered.ok).toBe(true); expect(recovered.read.files).toBe(2);
    expect(recovered.read.bytes).toBeLessThanOrEqual(readBounds.maxBytes); expect(recovered.lastFrame.seq).toBe(3);
  });
  it('keeps a current stale journal unhealthy even when the native status heartbeat is fresh', async () => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true); const prior = x.state();
    const now = x.now + 180000;
    fs.writeFileSync(path.join(x.learningRoot, 'status.json'), JSON.stringify({ cycle: source.cycle,
      running: true, feedReceivedAt: new Date(now).toISOString() }));
    const result = await x.run({ now }); expect(result.ok).toBe(false);
    expect(result.reason).toContain('fresh source'); expect(x.state()).toEqual(prior);
  });
  it('retains committed historical progress when the final interval still lacks current original source', async () => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true);
    addHour(x, 1, [record(2, 175, { at: base + 3600000 })]);
    addHour(x, 2, [record(3, 170, { at: base + 2 * 3600000 })]);
    const now = base + 3 * 3600000;
    fs.writeFileSync(path.join(x.learningRoot, 'status.json'), JSON.stringify({ cycle: source.cycle,
      running: true, feedReceivedAt: new Date(now).toISOString() }));
    const partial = await x.run({ now }); expect(partial.errorCode).toBe('backfill_pending');
    expect(partial.lastFrame.seq).toBe(2); const committed = x.state();
    const blocked = await x.run({ now }); expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain('fresh source'); expect(x.state()).toEqual(committed);
    expect(JSON.parse(committed).projection.last.seq).toBe(2);
  });
  it.each(['missing', 'shortened', 'changed'])('does not skip a %s original frontier to newer files', async kind => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true); const prior = x.state();
    const next = record(2, 170, { at: base + 3600000 }); addHour(x, 1, [next]);
    if (kind === 'missing') {
      const file = path.join(x.learningRoot, 'state.json'), state = JSON.parse(fs.readFileSync(file));
      delete state.source.inputFiles[path.basename(x.file)]; fs.writeFileSync(file, JSON.stringify(state));
    } else if (kind === 'shortened') fs.truncateSync(x.file, 20);
    else { const bytes = fs.readFileSync(x.file); bytes[15] ^= 1; fs.writeFileSync(x.file, bytes); }
    const result = await x.run({ now: next.receivedAt });
    expect(result.ok).toBe(false); expect(x.state()).toEqual(prior); expect(x.findings()).toHaveLength(0);
  });
  it('never advances beyond an incomplete historical gzip/JSON record into a later file', async () => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true); const prior = x.state();
    const second = record(2, 3022), bytes = gzipSync(JSON.stringify(second) + '\n');
    x.update([], { rawBytes: bytes.subarray(0, Math.floor(bytes.length / 2)) });
    const next = record(3, 170, { at: base + 3600000 }); addHour(x, 1, [next]);
    const result = await x.run({ now: next.receivedAt });
    expect(result.ok).toBe(false); expect(result.reason).toContain('Historical native countdown record is incomplete');
    expect(x.state()).toEqual(prior); expect(x.findings()).toHaveLength(0);
  });
  it('leaves the historical cursor unchanged on storage failure, then resumes normally with retained findings', async () => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true); const prior = x.state();
    const at = base + 3600000;
    addHour(x, 1, [record(2, 180, { at }), record(3, 3022, { at: at + 5000 }), record(4, 170, { at: at + 10000 })]);
    const next = record(5, 165, { at: base + 2 * 3600000 }); addHour(x, 2, [next]);
    const original = path.join(x.directory, 'findings', 'orphan.partial'); fs.writeFileSync(original, 'protected');
    const failed = await x.run({ now: next.receivedAt, policy: { maxOpenBytes: 1 } });
    expect(failed.ok).toBe(false); expect(x.state()).toEqual(prior); expect(fs.readFileSync(original, 'utf8')).toBe('protected');
    const progress = await x.run({ now: next.receivedAt }); expect(progress.errorCode).toBe('backfill_pending');
    expect(x.findings()).toHaveLength(1); expect(fs.readFileSync(original, 'utf8')).toBe('protected');
    expect((await x.run({ now: next.receivedAt })).ok).toBe(true); expect(x.findings()).toHaveLength(1);
  });
});

describe('explicit reviewed reader migration', () => {
  function legacy(x) {
    const file = path.join(x.directory, 'state.json'), state = JSON.parse(x.state());
    state.codeSHA256 = PRE_BATCH_CODE_SHA256;
    const bytes = Buffer.from(JSON.stringify(state, null, 3) + '\n'); fs.writeFileSync(file, bytes);
    return { bytes, state };
  }
  it('preserves the exact original checkpoint and all pending comparisons, source identity, prefixes and clocks', async () => {
    const x = fixture([record(1, 180), record(2, 3022)]); expect((await x.run()).ok).toBe(true);
    const before = legacy(x);
    expect((await x.run()).reason).toContain('explicit source migration'); expect(x.state()).toEqual(before.bytes);
    const receipt = await migrateCheckpoint({ directory: x.directory,
      expectedCheckpointSHA256: sha(before.bytes), reviewedTargetCodeSHA256: COUNTDOWN_CODE_SHA256,
      note: 'Synthetic reviewed control for the bounded reader; no actual rider outcome.' });
    const after = JSON.parse(x.state());
    expect(after).toEqual({ ...before.state, codeSHA256: COUNTDOWN_CODE_SHA256 });
    expect(fs.readFileSync(path.join(x.directory, 'migrations', receipt.originalCheckpointFile))).toEqual(before.bytes);
    expect(sha(fs.readFileSync(receipt.receiptFile))).toBe(receipt.receiptSHA256);
    x.update([record(3, 170)]); expect((await x.run()).ok).toBe(true); expect(x.findings()).toHaveLength(1);
    const body = JSON.parse(gunzipSync(fs.readFileSync(path.join(x.directory, 'findings', x.findings()[0]))));
    expect(body.events[0].before.seq).toBe(1); expect(body.events[0].returned.seq).toBe(3);
  });
  it.each(['checkpoint', 'target', 'source', 'review'])('refuses an unreviewed %s without changing the checkpoint', async kind => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true);
    const before = legacy(x);
    if (kind === 'source') {
      before.state.codeSHA256 = 'f'.repeat(64);
      before.bytes = Buffer.from(JSON.stringify(before.state)); fs.writeFileSync(path.join(x.directory, 'state.json'), before.bytes);
    }
    await expect(migrateCheckpoint({ directory: x.directory,
      expectedCheckpointSHA256: kind === 'checkpoint' ? '0'.repeat(64) : sha(before.bytes),
      reviewedTargetCodeSHA256: kind === 'target' ? '0'.repeat(64) : COUNTDOWN_CODE_SHA256,
      note: kind === 'review' ? '' : 'Synthetic migration review.' })).rejects.toThrow();
    expect(x.state()).toEqual(before.bytes); expect(fs.existsSync(path.join(x.directory, 'migrations'))).toBe(false);
  });
  it.each(['different bytes', 'symlink'])('does not overwrite original migration custody with %s', async kind => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true); const before = legacy(x);
    const custody = path.join(x.directory, 'migrations'); fs.mkdirSync(custody);
    const original = path.join(custody, sha(before.bytes) + '.state.json');
    if (kind === 'symlink') fs.symlinkSync(path.join(x.directory, 'state.json'), original);
    else fs.writeFileSync(original, 'previous immutable custody');
    await expect(migrateCheckpoint({ directory: x.directory, expectedCheckpointSHA256: sha(before.bytes),
      reviewedTargetCodeSHA256: COUNTDOWN_CODE_SHA256, note: 'Synthetic migration custody control.' })).rejects.toThrow('custody');
    expect(x.state()).toEqual(before.bytes);
    if (kind === 'symlink') expect(fs.lstatSync(original).isSymbolicLink()).toBe(true);
    else expect(fs.readFileSync(original, 'utf8')).toBe('previous immutable custody');
  });
  it('refuses to migrate while the countdown storage lock has a live owner', async () => {
    const x = fixture([record(1, 180)]); expect((await x.run()).ok).toBe(true); const before = legacy(x);
    const lock = path.join(x.directory, 'storage.lock'); fs.writeFileSync(lock, String(process.pid));
    await expect(migrateCheckpoint({ directory: x.directory, expectedCheckpointSHA256: sha(before.bytes),
      reviewedTargetCodeSHA256: COUNTDOWN_CODE_SHA256, note: 'Synthetic migration lock control.' })).rejects.toThrow('busy');
    expect(x.state()).toEqual(before.bytes); expect(fs.readFileSync(lock, 'utf8')).toBe(String(process.pid));
    expect(fs.existsSync(path.join(x.directory, 'migrations'))).toBe(false);
  }, 15000);
});
