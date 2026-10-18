import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectorWitnessJournal } from './witnessJournal';
import { witnessJSON, witnessSHA } from './witnessCodec';

afterEach(() => vi.useRealTimers());
const topology = () => CollectorWitnessJournal.topology({
  stops: new Map([[1, { lat: 41.3, lon: -72.9 }]]),
  routes: new Map([[4, [1, 2, 1]]]), roadMetres: new Map([['4:1:2', 401.6037796068831]]),
});

describe('exact collector witness values', () => {
  it('preserves binary64 bits, map order and shared reducer references', () => {
    expect(witnessJSON(-0)).not.toBe(witnessJSON(0));
    expect(witnessJSON(401.6037796068831)).not.toBe(witnessJSON(401.60377960688317));
    expect(witnessJSON(new Map([[1, 2], [3, 4]]))).not.toBe(witnessJSON(new Map([[3, 4], [1, 2]])));
    const shared = { at: 5 };
    expect(witnessJSON([shared, shared])).not.toBe(witnessJSON([{ at: 5 }, { at: 5 }]));
    expect(witnessJSON({ b: 2, a: 1 })).toBe(witnessJSON({ a: 1, b: 2 }));
    expect(() => witnessJSON(NaN)).toThrow('Nonfinite');
  });

  it('distinguishes duplicate stop occurrences and a one-ULP road distance change', () => {
    const a = topology(), b = CollectorWitnessJournal.topology({
      stops: new Map([[1, { lat: 41.3, lon: -72.9 }]]),
      routes: new Map([[4, [1, 1, 2]]]), roadMetres: new Map([['4:1:2', 401.6037796068831]]),
    });
    expect(a.sha256).not.toBe(b.sha256);
  });
});

describe('bounded collector witness journal', () => {
  it('keeps immutable input bytes and includes the topology dictionary needed by each page', () => {
    const j = new CollectorWitnessJournal({ epoch: 'test' }), t = topology(), input = { busId: 3, at: 1000 };
    const first = j.append(1000, input, t); input.busId = 8;
    const second = j.append(2000, { busId: 9 }, t);
    const page = j.read('test', 0, { now: 2000, limit: 1 });
    expect(page).toMatchObject({ cursor: 1, latest: 2, hasMore: true });
    expect(page.frames[0]!.json).toBe(witnessJSON({ busId: 3, at: 1000 }));
    expect(page.topologies).toEqual([t]); expect(second.previousChain).toBe(first.chain);
    expect(first.sha256).toBe(witnessSHA(first.json));
    expect(() => { (page.frames[0] as { json: string }).json = 'changed'; }).toThrow();
    page.frames.splice(0); expect(j.read('test', 0, { now: 2000 }).frames).toHaveLength(2);
  });

  it('bounds frames and retains shared topology until its last referring frame expires', () => {
    vi.useFakeTimers(); vi.setSystemTime(2000);
    const j = new CollectorWitnessJournal({ epoch: 'test', maxFrames: 1 }), t = topology();
    j.append(1000, { value: 1 }, t); j.append(2000, { value: 2 }, t);
    expect(() => j.read('test', 0)).toThrow('expired');
    expect(j.read('test', 1).topologies).toEqual([t]);
    expect(j.stats()).toMatchObject({ retainedFrames: 1, retainedTopologies: 1 });
  });

  it('bounds combined frame/topology bytes and reports the resulting gap', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const j = new CollectorWitnessJournal({ epoch: 'test', maxBytes: 20 });
    j.append(1000, { value: 'larger than twenty bytes' }, topology());
    expect(j.stats()).toMatchObject({ retainedFrames: 0, retainedTopologies: 0, retainedBytes: 0 });
    expect(() => j.read('test', 0)).toThrow('expired');
    expect(j.read('test', 1).frames).toEqual([]);
  });

  it('removes age-expired topology and refuses another epoch or an invalid cursor', () => {
    vi.useFakeTimers(); vi.setSystemTime(3001);
    const j = new CollectorWitnessJournal({ epoch: 'test', maxAgeMs: 2000 });
    j.append(1000, {}, topology());
    expect(() => j.read('test', 0)).toThrow('expired');
    expect(j.stats().retainedTopologies).toBe(0);
    expect(() => j.read('other', 1)).toThrow('epoch');
    expect(() => j.read('test', 2)).toThrow('cursor');
  });

  it('retains a capture failure as a chained unavailable frame after recovery', () => {
    const j = new CollectorWitnessJournal({ epoch: 'test' });
    j.append(1000, {}, topology()); j.fail(2000, 'input too large'); j.append(3000, {}, topology());
    const page = j.read('test', 0, { now: 3000 });
    expect(page.frames.map(f => f.status)).toEqual(['recorded', 'unavailable', 'recorded']);
    expect(page.frames[1]!.topologySha256).toBeNull();
    expect(page.frames[2]!.previousChain).toBe(page.frames[1]!.chain);
    expect(j.head(3000).unavailable).toBeNull();
  });

  it('latches lost clock continuity and cannot silently recover the same epoch', () => {
    const j = new CollectorWitnessJournal({ epoch: 'test' });
    j.append(1000, {}, topology()); j.fail(1000, 'capture lost');
    expect(() => j.read('test', 0, { now: 1000 })).toThrow('continuity');
    expect(() => j.append(2000, {}, topology())).toThrow('continuity');
  });

  it('rejects an invalid topology receipt before advancing the source cursor', () => {
    const j = new CollectorWitnessJournal({ epoch: 'test' }), t = topology();
    expect(() => j.append(1000, {}, { ...t, json: t.json + ' ' })).toThrow('receipt');
    expect(j.head(1000).latest).toBe(0);
  });
});
