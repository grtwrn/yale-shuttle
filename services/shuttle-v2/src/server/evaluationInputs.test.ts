import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { EvaluationInputError, EvaluationInputs } from './evaluationInputs';

const clock = 1792239000000;
const journal = (options = {}) => new EvaluationInputs({ epoch: 'fixture-epoch', ...options });
const frame = (j: EvaluationInputs, index: number, json = JSON.stringify({ bus: index })) => j.append(index, clock + index * 5000, json);
function errorCode(fn: () => unknown) {
  try { fn(); throw Error('Expected journal error'); }
  catch (e) { expect(e).toBeInstanceOf(EvaluationInputError); return (e as EvaluationInputError).code; }
}
describe('exact production observation retention', () => {
  it('exports only a genuine retained current observation identity without input or private context', () => {
    const j = journal(); expect(j.reference(null, clock)).toBeUndefined(); frame(j, 0);
    expect(j.reference(clock + 1, clock)).toBeUndefined();
    const reference = j.reference(clock, clock)!;
    expect(reference).toEqual({epoch: 'fixture-epoch', cursor: 1, at: clock, sha256: createHash('sha256').update(JSON.stringify({bus: 0})).digest('hex')});
    reference.epoch = 'mutated'; expect(j.reference(clock, clock)!.epoch).toBe('fixture-epoch');
    frame(j, 1); expect(j.reference(clock, clock + 5000)).toBeUndefined();
    expect(j.reference(clock + 5000, clock + 5000)?.cursor).toBe(2);
    j.fail('capture failed'); expect(j.reference(clock + 5000, clock + 5000)).toBeUndefined();
    const expired = journal({maxAgeMs: 1000}); frame(expired, 0);
    expect(expired.reference(clock, clock + 1001)).toBeUndefined();
  });
  it('retains original bytes and hash rather than a later cached HTTP rebuild', () => {
    const j = journal(); frame(j, 0, '{"modelTime":1}'); frame(j, 0, '{"cachedAge":2}');
    const r = j.read(j.epoch, 0, { now: clock }); expect(r.frames).toHaveLength(1);
    expect(r.frames[0]!.json).toBe('{"modelTime":1}');
    expect(r.frames[0]!.sha256).toBe(createHash('sha256').update('{"modelTime":1}').digest('hex'));
    expect(Object.isFrozen(r.frames[0])).toBe(true); r.frames.pop(); expect(j.stats().retained).toBe(1);
  });
  it('paginates without silently moving the cursor past unseen frames', () => {
    const j = journal(); for (let i = 0; i < 5; i++) frame(j, i);
    const a = j.read(j.epoch, 0, { limit: 2, now: clock + 25000 }); expect(a.cursor).toBe(2); expect(a.hasMore).toBe(true);
    const b = j.read(j.epoch, a.cursor, { limit: 2, now: clock + 25000 }); expect(b.frames.map(f => f.seq)).toEqual([3, 4]);
    const c = j.read(j.epoch, b.cursor, { now: clock + 25000 }); expect(c.frames.map(f => f.seq)).toEqual([5]); expect(c.hasMore).toBe(false);
  });
  it('reports a gap after frame-count retention rather than rejoining at the latest frame', () => {
    const j = journal({ maxFrames: 2 }); for (let i = 0; i < 4; i++) frame(j, i);
    expect(errorCode(() => j.read(j.epoch, 0, { now: clock + 20000 }))).toBe('gap');
    expect(j.read(j.epoch, 2, { now: clock + 20000 }).frames.map(f => f.seq)).toEqual([3, 4]);
  });
  it('enforces UTF8 byte retention and fails a single oversized observation visibly', () => {
    const j = journal({ maxBytes: 12 }); frame(j, 0, '🚍🚍'); frame(j, 1, '🚍🚍'); expect(j.stats().retainedBytes).toBe(8);
    expect(errorCode(() => j.read(j.epoch, 0, { now: clock + 5000 }))).toBe('gap');
    expect(errorCode(() => frame(j, 2, '🚍🚍🚍🚍'))).toBe('unavailable');
    expect(errorCode(() => frame(j, 3, '{}'))).toBe('unavailable'); expect(j.stats().failed).toBe(true);
  });
  it('expires idle history and reports missing retained frames', () => {
    const j = journal({ maxAgeMs: 10000 }); frame(j, 0);
    expect(errorCode(() => j.read(j.epoch, 0, { now: clock + 10001 }))).toBe('gap');
    expect(j.read(j.epoch, 1, { now: clock + 10001 }).frames).toEqual([]); expect(j.stats().retainedBytes).toBe(0);
  });
  it('distinguishes process epochs and rejects impossible cursors', () => {
    const j = journal(); frame(j, 0); expect(errorCode(() => j.read('other', 0))).toBe('epoch');
    for (const cursor of [-1, 2, NaN, 0.5]) expect(errorCode(() => j.read(j.epoch, cursor))).toBe('cursor');
  });
  it('marks source clock/version regression unavailable without clearing prior evidence', () => {
    const j = journal(); frame(j, 1); expect(errorCode(() => frame(j, 0))).toBe('unavailable'); expect(j.stats().retained).toBe(1);
    const cached = journal(); frame(cached, 0); expect(errorCode(() => cached.append(0, clock + 1, '{}'))).toBe('unavailable');
  });
  it('retains explicit source capture failures until a new journal instance', () => {
    const j = journal(); frame(j, 0); j.fail('Source snapshot failed');
    expect(errorCode(() => j.read(j.epoch, 0))).toBe('unavailable'); expect(j.stats().retained).toBe(1);
    expect(journal().stats().failed).toBe(false);
  });
  it('serves a new empty journal without inventing an observation', () => {
    const j = journal(); expect(j.head()).toEqual({ epoch: j.epoch, cursor: 0, at: null, observationVersion: null });
    expect(j.read(j.epoch, 0, { now: clock })).toEqual({ epoch: j.epoch, cursor: 0, latest: 0, hasMore: false, frames: [] });
  });
  it('retains and hashes immutable route-adjustment context within the same byte budget', () => {
    const context = { v: 1 as const, at: clock, trial: { enabled: false, route: true, blue: true, evidence: [] } };
    const original = JSON.stringify(context), size = Buffer.byteLength(original) + 2;
    const j = journal({ maxBytes: size + 1 }); j.append(0, clock, '{}', context);
    context.trial.blue = false;
    const stored = j.read(j.epoch, 0, { now: clock }).frames[0]!;
    expect(stored.contextJson).toBe(original);
    expect(stored.contextSha256).toBe(createHash('sha256').update(original).digest('hex'));
    expect(j.stats().retainedBytes).toBe(size);
    j.append(1, clock + 5000, '{}', { ...context, at: clock + 5000 });
    expect(j.stats().retained).toBe(1);
    expect(errorCode(() => j.read(j.epoch, 0, { now: clock + 5000 }))).toBe('gap');
  });
  it('refuses a malformed or differently timed context without replacing earlier evidence', () => {
    const j = journal(); frame(j, 0);
    const context = { v: 1 as const, at: clock, trial: { enabled: false, route: true, blue: true, evidence: [] } };
    expect(errorCode(() => j.append(1, clock + 5000, '{}', context))).toBe('unavailable');
    expect(j.stats().retained).toBe(1); expect(j.stats().failed).toBe(true);
  });
});
