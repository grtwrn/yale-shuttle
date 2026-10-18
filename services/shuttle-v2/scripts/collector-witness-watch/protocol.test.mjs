import { describe, it, expect } from 'vitest';
import { witnessJSON, witnessSHA } from '../../src/collector/witnessCodec.ts';
import { decodeWitness, validatePage, validHead, initialChain, derivedLegLeads } from './protocol.mjs';
import { fixture, association } from './testFixtures.mjs';

describe('collector witness transport verification', () => {
  it('round-trips minus zero, one ULP, dates, maps, aliases and cycles', () => {
    const a = { n: -0, exact: 401.6037796068831, time: new Date(1000) }; a.self = a;
    const v = decodeWitness(witnessJSON([a, a, new Map([[a, new Set([a])]])]));
    expect(v[0]).toBe(v[1]); expect(v[0].self).toBe(v[0]); expect(Object.is(v[0].n, -0)).toBe(true);
    expect(v[0].exact).toBe(401.6037796068831); expect(v[2].get(v[0]).has(v[0])).toBe(true);
    expect(() => decodeWitness(witnessJSON(a) + ' ')).toThrow('Noncanonical');
    expect(() => decodeWitness('["ref",0]')).toThrow();
  });
  it('requires the model index in a valid head and exact state/topology/frame bytes', () => {
    const f = fixture(); f.add(); const head = f.head();
    expect(validHead(head)).toBe(true); expect(validHead({ ...head, evaluationCursor: undefined })).toBe(false);
    const cp = { epoch: head.epoch, build: head.build, after: 0, chain: initialChain(head.epoch) };
    const page = f.page(); expect(validatePage(page, cp).frames).toHaveLength(1);
    expect(() => validatePage({ ...page, frames: [{ ...page.frames[0], json: page.frames[0].json + ' ' }] }, cp)).toThrow();
    expect(() => validatePage({ ...page, topologies: [] }, cp)).toThrow('topology');
    expect(() => validatePage({ ...page, frames: [{ ...page.frames[0], previousChain: 'f'.repeat(64) }] }, cp)).toThrow('forked');
    expect(() => validatePage({ ...page, evaluations: [association({ ...page.frames[0], sha256: 'f'.repeat(64) })] }, cp)).toThrow('association');
  });
  it('verifies a previously stored topology before accepting server omission', () => {
    const f = fixture(); f.add(); const h = f.head(), p = f.page();
    const cp = { epoch: h.epoch, build: h.build, after: 0, chain: initialChain(h.epoch) };
    expect(validatePage({ ...p, topologies: [] }, cp, new Map([[f.topology.sha256, f.topology]])).frames[0].topology.decoded.stops.size).toBe(2);
    expect(() => validatePage({ ...p, topologies: [] }, cp, new Map([[f.topology.sha256, { ...f.topology, json: '{}' }]]))).toThrow();
  });
  it('retains an explicit source gap between good polls', () => {
    const f = fixture(); f.add(); f.journal.fail(f.at + 1, 'oversized'); f.add(); const h = f.head();
    const got = validatePage(f.page(), { epoch: h.epoch, build: h.build, after: 0, chain: initialChain(h.epoch) });
    expect(got.frames.map(x => x.frame.status)).toEqual(['recorded', 'unavailable', 'recorded']);
  });
  it('emits a diagnostic lead for a 5-second derived leg without filtering a row', () => {
    const f = fixture(), afterJSON = witnessJSON({ id: 5, from_stop_id: 1, to_stop_id: 2, leg_sec: 5 });
    f.add({ sourceWrites: [{ mutations: [{ table: 'legs', afterJSON, afterSHA256: witnessSHA(afterJSON) }] }] });
    const h = f.head(), p = f.page(), records = validatePage(p, { epoch: h.epoch, build: h.build, after: 0, chain: initialChain(h.epoch) });
    const leads = derivedLegLeads(records.frames);
    expect(leads).toHaveLength(1); expect(leads[0]).toMatchObject({ rowId: 5, legSec: 5 });
    expect(p.frames).toHaveLength(1); expect(leads[0].scope).toContain('do not filter');
    records.frames[0].input.pollResult = 'failed'; expect(derivedLegLeads(records.frames)).toEqual([]);
  });
});
