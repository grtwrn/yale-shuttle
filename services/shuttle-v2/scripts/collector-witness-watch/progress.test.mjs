import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CollectorWitnessJournal } from '../../src/collector/witnessJournal.ts';
import { witnessJSON, witnessSHA } from '../../src/collector/witnessCodec.ts';
import { decodeWitness, validatePage, initialChain } from './protocol.mjs';
import { anchorProgressLeads, anchorProgressSummary, PROGRESS_CONTEXT_MAX_BYTES } from './progress.mjs';
import { WitnessStore } from './storage.mjs';
import { dispatchIncidents } from './incidents.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./__fixtures__/repeated-fix-source-20261018.json', import.meta.url)));
const original = fixture.cases[0], corrected = fixture.cases[1];
const beforeInput = () => decodeWitness(original.frames[0].json);
const badInput = () => decodeWitness(original.frames[1].json);
const network = () => decodeWitness(fixture.topologies[0].json);
const bundle = c => ({ epoch: c.epoch, frames: c.frames, topologies: fixture.topologies });
const head = b => ({ v: 1, epoch: b.epoch, build: 'source-fixture', oldest: b.frames[0].seq,
  latest: b.frames.at(-1).seq, chain: b.frames.at(-1).chain, unavailable: null, evaluationEpoch: 'model-fixture', evaluationCursor: 0 });
const checkpoint = b => ({ epoch: b.epoch, build: 'source-fixture', after: b.frames[0].seq - 1, at: 0,
  chain: b.frames[0].seq === 1 ? initialChain(b.epoch) : null });
function page(b, after = b.frames[0].seq - 1, limit = 16) {
  const frames = b.frames.filter(f => f.seq > after).slice(0, limit), cursor = frames.at(-1)?.seq ?? after;
  return { v: 1, epoch: b.epoch, build: 'source-fixture', cursor, latest: b.frames.at(-1).seq,
    hasMore: cursor < b.frames.at(-1).seq, frames, topologies: b.topologies, evaluations: [] };
}
function evaluate(b, sizes = [16]) {
  let cp = checkpoint(b), context = null, dictionary = new Map(), leads = [], i = 0;
  while (cp.after < b.frames.at(-1).seq) {
    const verified = validatePage(page(b, cp.after, sizes[i++ % sizes.length]), cp, dictionary);
    const next = anchorProgressLeads(verified.frames, context, b.epoch);
    leads.push(...next.leads); context = next.context; cp = verified.checkpoint; dictionary = verified.topologies;
  }
  return { context, leads };
}
function hashes(input) {
  for (const side of ['Before', 'After']) input['state'+side+'SHA256'] = witnessSHA(input['state'+side+'JSON']);
  return input;
}
function changeAfter(input, fn) {
  const s = decodeWitness(input.stateAfterJSON); fn(s);
  input.stateAfterJSON = witnessJSON(s); return hashes(input);
}
function timeline({ middle = [], mutateNetwork = () => {}, mutateBad = () => {} } = {}) {
  const journal = new CollectorWitnessJournal({ epoch: 'progress-controls' }), net = network(), first = beforeInput(), bad = badInput();
  mutateNetwork(net); journal.append(first.at, first, CollectorWitnessJournal.topology(net));
  for (let i = 0; i < middle.length; i++) {
    const control = middle[i], at = first.at + 1000 * (i + 1);
    if (control === 'unavailable') { journal.fail(at, 'synthetic capture gap'); continue; }
    const n = structuredClone(net); if (typeof control === 'function') control(n);
    const input = { ...first, at, observations: [], sourceWrites: [], stateBeforeJSON: first.stateAfterJSON,
      stateAfterJSON: first.stateAfterJSON, pollResult: control === 'failed' ? 'failed' : 'completed',
      sourceWriteEvidence: control === 'unknown-writes' ? 'unavailable' : 'recorded' };
    journal.append(at, hashes(input), CollectorWitnessJournal.topology(n));
  }
  mutateBad(bad); journal.append(bad.at, hashes(bad), CollectorWitnessJournal.topology(net));
  const p = journal.read(journal.epoch, 0, { now: bad.at });
  return { epoch: journal.epoch, frames: p.frames, topologies: p.topologies };
}

describe('captured route progress at a repeated GPS fix', () => {
  it('finds the original116→53 cascade and its exact source row, but no lead after the fix', () => {
    const old = evaluate(bundle(original));
    expect(old.leads).toHaveLength(1);
    expect(old.leads[0]).toMatchObject({ seq: 5872, busName: '#58', routeId: 4, fromStopId: 116,
      toStopId: 53, previousFrame: { seq: 5871 }, sourceArrivals: [{ rowId: 1005,
        rowSHA256: 'e6ee7a8e6ce29ef55fbfdd73f56cb38ca7c69e9f42959d4bbdbe715107c9948a' }] });
    expect(evaluate(bundle(corrected)).leads).toEqual([]);
    expect(anchorProgressSummary(old.context).coverage).toEqual({ frames: 2, observations: 12,
      boundObservations: 6, candidateLeads: 1, withholdEvents: { 'cold-observation-context': 6 } });
  });
  it('does not infer the previous observation from a clipped stateBefore snapshot', () => {
    expect(evaluate({ ...bundle(original), frames: original.frames.slice(1) }).leads).toEqual([]);
  });
  it('has the same leads and final context on both sides of a page boundary', () => {
    const b = timeline({ middle: [null, null] });
    expect(evaluate(b, [1])).toEqual(evaluate(b));
    expect(evaluate(b, [2, 1])).toEqual(evaluate(b));
    expect(evaluate(b).leads).toHaveLength(1);
  });
  it.each(['marker', 'path', 'order', 'route missing'])('withholds across A→B→A %s changes while the bus is absent', kind => {
    const change = n => {
      if (kind === 'marker') n.stops.get(116).lat += .00001;
      if (kind === 'path') n.routes.get(4).path[0][0] += .00001;
      if (kind === 'order') [n.routes.get(4).stops[0], n.routes.get(4).stops[1]] = [n.routes.get(4).stops[1], n.routes.get(4).stops[0]];
      if (kind === 'route missing') n.routes.delete(4);
    };
    const b = timeline({ middle: [change, null] }), r = evaluate(b, [1]);
    expect(r.leads).toEqual([]);
    expect(r.context.lastUnknown.reason).toBe('observation-or-geometry-generation-changed');
  });
  it('does not lose relevant coverage when only another route changes', () => {
    const b = timeline({ middle: [n => { n.routes.get(8).path[0][0] += .00001; }, null] });
    expect(evaluate(b, [1]).leads).toHaveLength(1);
  });
  it.each(['unavailable', 'failed', 'unknown-writes'])('withholds across an intervening %s frame', control => {
    expect(evaluate(timeline({ middle: [control] }), [1]).leads).toEqual([]);
  });
  it.each(['missing path', 'missing marker', 'invalid index'])('withholds with %s', control => {
    const b = timeline({ mutateNetwork(n) {
      if (control === 'missing path') delete n.routes.get(4).path;
      if (control === 'missing marker') n.stops.delete(116);
      if (control === 'invalid index') n.routes.get(4).stops[23] = 53;
    } });
    expect(evaluate(b).leads).toEqual([]);
  });
  it('keeps the global escape when the previous stop is no longer competitive', () => {
    const b = timeline({ mutateNetwork(n) { n.stops.get(116).lat += .02; } });
    expect(evaluate(b).leads).toEqual([]);
  });
  it('distinguishes two indexed occurrences even when they name the same marker', () => {
    const b = timeline({ mutateNetwork(n) { n.routes.get(4).stops[24] = 116; },
      mutateBad(input) { changeAfter(input, s => { s.states.get('#58').nearestStopId = 116; }); } });
    expect(evaluate(b).leads).toMatchObject([{ fromStopId: 116, toStopId: 116, fromIndex: 23, toIndex: 24 }]);
  });
  it.each(['moving fix', 'provider handoff', 'collision', 'route change', 'duplicate observation', 'long gap'])('withholds for %s', control => {
    const b = timeline({ mutateBad(input) {
      const obs = input.observations.find(o => o.busName === '#58');
      if (control === 'moving fix') { obs.lat += .00001; changeAfter(input, s => { s.states.get('#58').lat = obs.lat; }); }
      if (control === 'provider handoff') { obs.busId++; changeAfter(input, s => { s.states.get('#58').busId = obs.busId; }); }
      if (control === 'collision') input.observations.push({ ...obs, busId: obs.busId + 100 });
      if (control === 'route change') { obs.routeId = 13; changeAfter(input, s => { const v = s.states.get('#58'); v.routeId = 13; v.nearestIndex = 5; }); }
      if (control === 'duplicate observation') obs.collectedAt = original.frames[0].at;
      if (control === 'long gap') {
        input.at += 60000;
        for (const o of input.observations) o.collectedAt = input.at;
        changeAfter(input, s => { for (const v of s.states.values()) v.lastObservedAt = input.at; });
      }
    } });
    expect(evaluate(b).leads).toEqual([]);
  });
  it('does not mutate checkpoint context and treats a corrupt context as cold', () => {
    const b = bundle(original), verified = validatePage(page(b), checkpoint(b));
    const first = anchorProgressLeads(verified.frames.slice(0, 1), null, b.epoch), saved = structuredClone(first.context);
    expect(anchorProgressLeads(verified.frames.slice(1), first.context, b.epoch).leads).toHaveLength(1);
    expect(first.context).toEqual(saved);
    first.context.tracks[0].stateSHA256 = 'invalid';
    expect(anchorProgressLeads(verified.frames.slice(1), first.context, b.epoch).leads).toEqual([]);
  });
  it('bounds context explicitly rather than claiming coverage of an oversized fleet', () => {
    const b = timeline({ mutateBad(input) { input.observations = Array.from({ length: 129 }, (_, i) => ({ ...input.observations[0], busId: 1000+i, busName: '#'+i })); } });
    const r = evaluate(b);
    expect(r.leads).toEqual([]); expect(r.context.lastUnknown.reason).toBe('state-unavailable-or-bound');
    expect(Buffer.byteLength(JSON.stringify(r.context))).toBeLessThanOrEqual(PROGRESS_CONTEXT_MAX_BYTES);
    expect(anchorProgressSummary(r.context).trackedObservations).toBe(0);
  });
});

const roots = [], stores = [];
afterEach(() => { for (const s of stores.splice(0)) try { s.close(); } catch {} for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
function storeFor(b, policy = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-progress-')); roots.push(base);
  const store = new WitnessStore(path.join(base, 'capture'), { policy: { minFreeBytes: 0, ...policy } }); stores.push(store);
  store.updateReports([], { now: b.frames[0].at }); store.beginEpoch(head(b), 'test-capture', b.frames[0].at);
  const commit = (limit = 1, options = {}) => store.commitPage(page(b, store.checkpoint().after, limit), { seenHead: head(b), now: b.frames.at(-1).at, ...options });
  return { base, store, commit };
}
describe('atomic bounded progress diagnostic storage and delivery', () => {
  it('commits both evidence frames and one stable incident; lost acknowledgments and late associations do not duplicate it', async () => {
    const b = bundle(original), a = storeFor(b); a.commit(); const last = a.commit(), cp = a.store.checkpoint(), context = a.store.get('anchor-progress');
    expect(last.leads).toHaveLength(1); expect(a.store.db.prepare('SELECT count(*) n FROM incidents').get().n).toBe(1);
    expect(a.store.db.prepare('SELECT count(*) n FROM incident_chunks').get().n).toBe(2);
    const p = page(b, b.frames[0].seq, 1);
    expect(a.store.commitPage(p, { seenHead: head(b) }).duplicate).toBe(true);
    p.evaluations = [{ collectorEpoch: b.epoch, collectorSeq: b.frames[1].seq, collectorSHA256: b.frames[1].sha256,
      evaluation: { epoch: 'model-fixture', cursor: 1, at: b.frames[1].at, sha256: 'a'.repeat(64), contextSha256: 'b'.repeat(64) } }];
    a.store.commitPage(p, { seenHead: { ...head(b), evaluationCursor: 1 }, revisit: true, now: b.frames[1].at });
    expect(a.store.get('anchor-progress')).toEqual(context); expect(a.store.checkpoint().after).toBe(cp.after);
    expect(a.store.db.prepare('SELECT count(*) n FROM incidents').get().n).toBe(1);
    const directory = path.join(a.base, 'guardian/pending');
    expect(await dispatchIncidents({ store: a.store, directory })).toMatchObject({ ok: true, pending: 0 });
    const names = fs.readdirSync(directory); expect(names).toHaveLength(1); expect(names[0]).toMatch(/^collector-progress-/);
    const incident = JSON.parse(fs.readFileSync(path.join(directory, names[0])));
    expect(incident).toMatchObject({ kind: 'unchanged-fix-anchor-progress-review', detail: { previousFrame: { seq: 5871 } } });
    expect(incident.note).toContain('Not independent physical service');
  });
  it('does not bootstrap missing context from a last-frame association revisit after an upgrade', () => {
    const b = bundle(original), a = storeFor(b); a.commit();
    a.store.db.prepare("DELETE FROM meta WHERE key='anchor-progress'").run();
    const p = page(b, b.frames[0].seq-1, 1);
    p.evaluations = [{ collectorEpoch: b.epoch, collectorSeq: b.frames[0].seq, collectorSHA256: b.frames[0].sha256,
      evaluation: { epoch: 'model-fixture', cursor: 1, at: b.frames[0].at, sha256: 'a'.repeat(64), contextSha256: 'b'.repeat(64) } }];
    a.store.commitPage(p, { seenHead: { ...head(b), evaluationCursor: 1 }, revisit: true, now: b.frames[0].at });
    expect(a.store.get('anchor-progress')).toBeNull();
    expect(a.commit().leads).toEqual([]);
  });
  it('rolls back context, chunks and cursor with an incident insertion failure, then retries once', () => {
    const b = bundle(original), a = storeFor(b); a.commit(); const cp = a.store.checkpoint(), context = a.store.get('anchor-progress');
    a.store.db.exec("CREATE TRIGGER fail_progress BEFORE INSERT ON incidents BEGIN SELECT RAISE(ABORT,'injected progress commit failure'); END");
    expect(() => a.commit()).toThrow('injected progress'); expect(a.store.checkpoint()).toEqual(cp);
    expect(a.store.get('anchor-progress')).toEqual(context); expect(a.store.db.prepare('SELECT count(*) n FROM chunks').get().n).toBe(1);
    a.store.db.exec('DROP TRIGGER fail_progress'); expect(a.commit().leads).toHaveLength(1);
  });
  it('keeps the previous nonactive observation chunk while rolling expired history before the incident commit', () => {
    const b = timeline({ middle: [null] }), a = storeFor(b, { maxAgeMs: 1 });
    const first = a.commit(); a.commit(); a.commit(); a.store.updateReports([], { now: b.frames.at(-1).at }); a.store.maintain({ now: b.frames.at(-1).at });
    expect(a.store.readChunk(first.key).frames[0].seq).toBe(1);
    expect(a.store.db.prepare('SELECT count(*) n FROM incidents').get().n).toBe(1);
  });
  it('withholds a lead explicitly if rolling cleanup already retired its prior observation', () => {
    const b = timeline({ middle: [null] }), a = storeFor(b); const first = a.commit(); a.commit();
    a.store.db.prepare('DELETE FROM chunks WHERE key=?').run(first.key);
    a.store.db.exec('DELETE FROM frames WHERE seq=1');
    expect(a.commit().leads).toEqual([]);
    expect(a.store.get('anchor-progress').lastUnknown.reason).toBe('prior-frame-not-retained');
  });
  it.each([
    { name: 'stable approach', make: () => bundle(original), split: 1 },
    { name: 'after geometry B', make: () => timeline({ middle: [n => { n.stops.get(116).lat += .00001; }, null] }), split: 2 },
    { name: 'after geometry returns to A', make: () => timeline({ middle: [n => { n.stops.get(116).lat += .00001; }, null] }), split: 3 },
  ])('continues in a fresh actual process $name with the same lead identity, checkpoint and context', ({ make, split }) => {
    const b = make(), expected = storeFor(b);
    for (let i = 0; i < b.frames.length; i++) expected.commit();
    const a = storeFor(b); for (let i = 0; i < split; i++) a.commit();
    a.store.close(); stores.splice(stores.indexOf(a.store), 1);
    const input = path.join(a.base, 'next.json'); fs.writeFileSync(input, JSON.stringify({ page: page(b, b.frames[split-1].seq, 16), head: head(b), root: path.join(a.base, 'capture'), now: b.frames.at(-1).at }));
    const script = `import fs from'node:fs';import{WitnessStore}from ${JSON.stringify(new URL('./storage.mjs', import.meta.url).href)};const x=JSON.parse(fs.readFileSync(process.argv[1])),s=new WitnessStore(x.root,{policy:{minFreeBytes:0}});s.commitPage(x.page,{seenHead:x.head,now:x.now});console.log(JSON.stringify({cp:s.checkpoint(),context:s.get('anchor-progress'),incidents:s.db.prepare('SELECT * FROM incidents ORDER BY id').all()}));s.close();`;
    const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, input], { cwd: process.cwd(), encoding: 'utf8' }));
    expect(result).toEqual({ cp: expected.store.checkpoint(), context: expected.store.get('anchor-progress'), incidents: expected.store.db.prepare('SELECT * FROM incidents ORDER BY id').all() });
  });
  it('resets context at an epoch boundary instead of joining the same-looking provider and topology', () => {
    const b = bundle(original), a = storeFor(b); a.commit();
    const next = { ...b, epoch: 'new-epoch', frames: b.frames.slice(1) }; a.store.beginEpoch(head(next), 'producer-context-changed', b.frames[1].at);
    expect(a.store.get('anchor-progress')).toBeNull();
    expect(a.store.commitPage(page(next), { seenHead: head(next), now: b.frames[1].at }).leads).toEqual([]);
  });
});
