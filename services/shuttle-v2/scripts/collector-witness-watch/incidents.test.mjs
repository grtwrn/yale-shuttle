import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WitnessStore } from './storage.mjs';
import { dispatchIncidents } from './incidents.mjs';
import { pollWitnesses, runOnce } from './poll.mjs';
import { fixture, association } from './testFixtures.mjs';
import { witnessJSON, witnessSHA } from '../../src/collector/witnessCodec.ts';

const roots = [], stores = [];
afterEach(() => {
  for (const s of stores.splice(0)) try { s.close(); } catch {}
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
function setup(options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-incidents-')); roots.push(base);
  const root = path.join(base, 'capture'), directory = path.join(base, 'guardian/pending');
  const store = new WitnessStore(root, { policy: { minFreeBytes: 0, maxAgeMs: 1000 } }); stores.push(store);
  const f = fixture(options); f.add(); store.updateReports([], { now: f.at }); store.beginEpoch(f.head(), 'test', f.at);
  const commit = () => store.commitPage(f.page(store.checkpoint().after), { seenHead: f.head(), now: f.at });
  function lead(fields = {}) {
    const afterJSON = witnessJSON({ id: 77, from_stop_id: 1, to_stop_id: 2, leg_sec: 5, ...fields });
    f.add({ sourceWrites: [{ mutations: [{ table: 'legs', afterJSON, afterSHA256: witnessSHA(afterJSON) }] }] });
    return commit();
  }
  return { base, root, directory, store, f, commit, lead };
}

describe('durable collector incident review delivery', () => {
  it('queues one stable diagnostic with its protected source reference and deduplicates restart delivery', async () => {
    const a = setup(), saved = a.lead(), source = a.store.readChunk(saved.key);
    let result = await dispatchIncidents(a); expect(result).toMatchObject({ ok: true, pending: 0 }); expect(result.delivered).toHaveLength(1);
    const names = fs.readdirSync(a.directory), value = JSON.parse(fs.readFileSync(path.join(a.directory, names[0])));
    expect(value).toMatchObject({ source: 'collector-witness-watch', kind: 'derived-leg-speed-review', detail: { rowId: 77 }, evidence: { database: a.store.file } });
    expect(value.note).toContain('Not independent physical service');
    expect(a.store.readChunk(saved.key)).toEqual(source);
    result = await dispatchIncidents(a); expect(result.delivered).toEqual([]); expect(fs.readdirSync(a.directory)).toEqual(names);
  });
  it('describes a known multi-hop proxy without dropping its incident, source capture or pins', async () => {
    const a = setup(), saved = a.lead({ hops: 4, reached: 0, from_index: 15, to_index: 3, to_pinned_at: null });
    const source = a.store.readChunk(saved.key), pins = a.store.db.prepare('SELECT * FROM incident_chunks ORDER BY incident,chunk').all();
    expect(await dispatchIncidents(a)).toMatchObject({ ok: true, pending: 0 });
    const [name] = fs.readdirSync(a.directory), value = JSON.parse(fs.readFileSync(path.join(a.directory, name)));
    expect(value).toMatchObject({ kind: 'derived-leg-speed-review',
      detail: { reviewClass: 'multi-hop-proxy', calibrationOneHopSQL: { status: 'excluded' } } });
    expect(value.summary).toContain('excluded from one-hop calibration');
    expect(a.store.readChunk(saved.key)).toEqual(source);
    expect(a.store.db.prepare('SELECT * FROM incident_chunks ORDER BY incident,chunk').all()).toEqual(pins);
    expect(pins.length).toBeGreaterThan(0);
  });
  it('retries a failed queue write after later polls, preserving old evidence and its delivery debt', async () => {
    const a = setup(), saved = a.lead(), bad = path.join(a.base, 'not-a-directory'); fs.writeFileSync(bad, 'preserve');
    const failed = await dispatchIncidents({ ...a, directory: bad }); expect(failed).toMatchObject({ ok: false, pending: 1 });
    a.f.add(); a.commit(); a.store.updateReports([], { now: a.f.at }); a.store.maintain({ now: a.f.at });
    expect(a.store.readChunk(saved.key)).toBeTruthy(); expect(a.store.checkpoint().after).toBe(3);
    const recovered = await dispatchIncidents(a); expect(recovered).toMatchObject({ ok: true, pending: 0 }); expect(recovered.delivered).toHaveLength(1);
  });
  it('survives a lost delivery acknowledgement and does not resurrect a processed incident', async () => {
    const a = setup(); a.lead();
    a.store.db.exec("CREATE TRIGGER lost_ack BEFORE INSERT ON meta WHEN NEW.key LIKE 'incident-delivery:%' BEGIN SELECT RAISE(ABORT,'lost delivery acknowledgement'); END");
    expect(await dispatchIncidents(a)).toMatchObject({ ok: false, pending: 1 });
    const name = fs.readdirSync(a.directory)[0], processed = path.join(path.dirname(a.directory), 'processed'); fs.mkdirSync(processed);
    const prior = JSON.parse(fs.readFileSync(path.join(a.directory, name))); prior.processedAt = 'reviewed later';
    fs.writeFileSync(path.join(a.directory, name), JSON.stringify(prior)); fs.renameSync(path.join(a.directory, name), path.join(processed, name));
    a.store.db.exec('DROP TRIGGER lost_ack'); a.store.close(); stores.splice(stores.indexOf(a.store), 1);
    const reopened = new WitnessStore(a.root, { policy: { minFreeBytes: 0 } }); stores.push(reopened);
    expect(await dispatchIncidents({ store: reopened, directory: a.directory })).toMatchObject({ ok: true, pending: 0 });
    expect(fs.readdirSync(a.directory)).toEqual([]); expect(fs.readdirSync(processed)).toEqual([name]);
  });
  it.each(['v1', 'v2'])('preserves a prior %s incident through a metadata revisit, lost acknowledgement and restart', async metric => {
    const a = setup(), first = a.lead();
    const row = a.store.db.prepare('SELECT id,json FROM incidents').get(), current = JSON.parse(row.json);
    expect(current.metricVersion).toBe(2);
    // Simulate the original serialized record before diagnostic context was
    // added. Revisited input must preserve its original JSON and delivery.
    const legacy = { ...current };
    delete legacy.reviewClass; delete legacy.sourceLeg; delete legacy.endpointQualification; delete legacy.calibrationOneHopSQL;
    if (metric === 'v1') {
      Object.assign(legacy, { minimumDistanceM: current.stopPoleDistanceM,
        lowerBoundMetresPerSec: current.stopPoleDistancePerLegSecond,
        scope: 'Diagnostic lead only. Review raw GPS, topology, state and committed source rows; do not filter rows or infer physical service.' });
      delete legacy.metricVersion; delete legacy.stopPoleDistanceM; delete legacy.stopPoleDistancePerLegSecond;
    }
    const originalJSON = JSON.stringify(legacy);
    a.store.db.prepare('UPDATE incidents SET json=? WHERE id=?').run(originalJSON, row.id);
    a.store.db.exec("CREATE TRIGGER lost_metric_ack BEFORE INSERT ON meta WHEN NEW.key LIKE 'incident-delivery:%' BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END");
    expect(await dispatchIncidents(a)).toMatchObject({ ok: false, pending: 1 });
    const name = fs.readdirSync(a.directory)[0], file = path.join(a.directory, name), bytes = fs.readFileSync(file);
    a.store.db.exec('DROP TRIGGER lost_metric_ack');

    const page = a.f.page(a.f.head().latest - 1);
    page.evaluations = [association(page.frames[0])];
    const revisited = a.store.commitPage(page, { seenHead: { ...a.f.head(), evaluationCursor: page.frames[0].seq }, revisit: true, now: a.f.at });
    expect(a.store.db.prepare('SELECT id,json FROM incidents').all()).toEqual([{ id: row.id, json: originalJSON }]);
    expect(a.store.readChunk(first.key)).toBeTruthy(); expect(a.store.readChunk(revisited.key)).toBeTruthy();
    a.store.close(); stores.splice(stores.indexOf(a.store), 1);
    const reopened = new WitnessStore(a.root, { policy: { minFreeBytes: 0 } }); stores.push(reopened);
    expect(await dispatchIncidents({ store: reopened, directory: a.directory })).toMatchObject({ ok: true, pending: 0 });
    expect(fs.readdirSync(a.directory)).toEqual([name]); expect(fs.readFileSync(file)).toEqual(bytes);
    expect(JSON.parse(bytes).detail).toEqual(legacy);
  });
  it('refuses conflicting queue content without overwriting it or releasing source pins', async () => {
    const a = setup(); a.lead();
    a.store.db.exec("CREATE TRIGGER lost_ack BEFORE INSERT ON meta WHEN NEW.key LIKE 'incident-delivery:%' BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END");
    await dispatchIncidents(a); a.store.db.exec('DROP TRIGGER lost_ack');
    const name = fs.readdirSync(a.directory)[0], file = path.join(a.directory, name), previous = JSON.parse(fs.readFileSync(file));
    previous.detail.rowId = 999; const bytes = JSON.stringify(previous); fs.writeFileSync(file, bytes);
    expect(await dispatchIncidents(a)).toMatchObject({ ok: false, pending: 1 }); expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(a.store.db.prepare('SELECT count(*) n FROM incident_chunks').get().n).toBeGreaterThan(0);
  });
  it('pins available history before and after a lead while rolling unrelated older chunks', () => {
    const a = setup(), unrelated = a.commit(); a.f.advance(2 * 3600000); a.f.add();
    const before = a.commit(); a.lead(); a.f.add(); const after = a.commit();
    a.f.advance(2 * 3600000); a.f.add(); a.commit(); a.store.updateReports([], { now: a.f.at }); a.store.maintain({ now: a.f.at });
    expect(a.store.readChunk(before.key)).toBeTruthy(); expect(a.store.readChunk(after.key)).toBeTruthy();
    expect(() => a.store.readChunk(unrelated.key)).toThrow('unavailable');
    expect(a.store.db.prepare('SELECT count(*) n FROM incident_chunks').get().n).toBe(3);
  });
  it('queues an explicit expired-source gap and preserves evidence on both sides', async () => {
    const a = setup({ maxFrames: 1 }), before = a.commit(); a.f.add(); a.f.add();
    const fetcher = async url => { url = new URL(url); const value = url.pathname === '/api/reports' ? { reports: [] } : url.search ? a.f.page(Number(url.searchParams.get('after'))) : a.f.head();
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); };
    expect((await pollWitnesses({ store: a.store, fetcher, token: 'fixture', now: a.f.at })).boundary).toBe('source-prefix-expired');
    expect(await dispatchIncidents(a)).toMatchObject({ ok: true, pending: 0 });
    const name = fs.readdirSync(a.directory)[0], incident = JSON.parse(fs.readFileSync(path.join(a.directory, name)));
    expect(incident).toMatchObject({ kind: 'collector-witness-gap', detail: { missingFrom: 2, missingThrough: 2, firstAvailable: 3 } });
    expect(a.store.readChunk(before.key)).toBeTruthy();
  });
  it('delivers retained incidents even when the production read fails, with private errors excluded from status', async () => {
    const a = setup(); a.lead(); const cp = a.store.checkpoint(); a.store.close(); stores.splice(stores.indexOf(a.store), 1);
    const tokenFile = path.join(a.base, 'token'); fs.writeFileSync(tokenFile, 'test-secret');
    const result = await runOnce({ dir: a.root, tokenFile, incidents: a.directory, now: a.f.at,
      fetcher: async () => { throw Error('test-secret arbitrary endpoint error'); } });
    expect(result).toMatchObject({ ok: false, cursor: cp.after, incidentDelivery: { ok: true, pending: 0 } });
    expect(result.incidentDelivery.delivered).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('test-secret');
  });
  it('bounds the supervisor log without changing its open file or losing source data', async () => {
    const a = setup(), saved = a.commit(); a.store.close(); stores.splice(stores.indexOf(a.store), 1);
    const tokenFile = path.join(a.base, 'token'), log = path.join(a.root, 'watcher.log');
    fs.writeFileSync(tokenFile, 'fixture'); fs.writeFileSync(log, Buffer.alloc(1024 * 1024 + 128, 46)); const inode = fs.statSync(log).ino;
    const fetcher = async url => { url = new URL(url); return new Response(JSON.stringify(url.pathname === '/api/reports' ? { reports: [] } : a.f.head()), { headers: { 'content-type': 'application/json' } }); };
    expect((await runOnce({ dir: a.root, tokenFile, incidents: a.directory, fetcher, now: a.f.at })).ok).toBe(true);
    expect(fs.statSync(log).ino).toBe(inode); expect(fs.statSync(log).size).toBe(0);
    expect(fs.readdirSync(a.root).filter(n => /^watcher\.log\.\d+\.gz$/.test(n))).toHaveLength(1);
    const reopened = new WitnessStore(a.root, { policy: { minFreeBytes: 0 } }); stores.push(reopened);
    expect(reopened.readChunk(saved.key).frames).toHaveLength(1);
  });
  it('groups consecutive capture failures and retains the review incident after the source head recovers', async () => {
    const a = setup(); a.f.advance(5000); a.f.journal.fail(a.f.at, 'capture unavailable'); const first = a.commit();
    a.f.advance(5000); a.f.journal.fail(a.f.at, 'capture unavailable again'); const second = a.commit();
    expect(a.store.db.prepare('SELECT count(*) n FROM incidents').get().n).toBe(1);
    expect(a.store.get('capture-run')).toMatchObject({ reason: 'frame-unavailable', lastSeq: 3 });
    a.f.add(); a.commit(); expect(a.f.head().unavailable).toBeNull(); expect(a.store.get('capture-run')).toBeNull();
    expect(await dispatchIncidents(a)).toMatchObject({ ok: true, pending: 0 });
    const name = fs.readdirSync(a.directory)[0], value = JSON.parse(fs.readFileSync(path.join(a.directory, name)));
    expect(value.kind).toBe('collector-capture-unavailable'); expect(a.store.readChunk(first.key)).toBeTruthy(); expect(a.store.readChunk(second.key)).toBeTruthy();
  });
  it('queues partial failed polls and unknown write provenance as separate diagnostic episodes', async () => {
    const a = setup(); a.f.add({ pollResult: 'failed' }); a.commit();
    a.f.add({ sourceWriteEvidence: 'unavailable' }); a.commit();
    const records = a.store.db.prepare('SELECT json FROM incidents').all().map(r => JSON.parse(r.json));
    expect(records.map(r => r.reason).sort()).toEqual(['poll-failed','source-writes-unavailable']);
    expect(a.store.get('capture-run')).toMatchObject({ reason: 'source-writes-unavailable' });
  });
  it('rolls incident grouping back with a later cursor failure, then retries once', () => {
    const a = setup(); a.f.advance(5000); a.f.journal.fail(a.f.at, 'unavailable'); const cp = a.store.checkpoint();
    a.store.db.exec("CREATE TRIGGER fault_cursor BEFORE INSERT ON meta WHEN NEW.key='checkpoint' BEGIN SELECT RAISE(ABORT,'late cursor fault'); END");
    expect(a.commit).toThrow('late cursor fault'); expect(a.store.checkpoint()).toEqual(cp); expect(a.store.get('capture-run')).toBeNull();
    expect(a.store.db.prepare('SELECT count(*) n FROM incidents').get().n).toBe(0);
    a.store.db.exec('DROP TRIGGER fault_cursor'); a.commit();
    expect(a.store.db.prepare('SELECT count(*) n FROM incidents').get().n).toBe(1);
  });
});
