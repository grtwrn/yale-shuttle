import { describe, expect, it } from 'vitest';
import { validEvaluationContext } from './etaEvaluationContext';

const context = () => ({ v: 1, at: 1000,
  trial: { enabled: false, route: false, blue: false, evidence: [] } });
const witness = () => ({ epoch: 'collector-epoch', seq: 2, at: 1000, sha256: '1'.repeat(64),
  chain: '2'.repeat(64), topologySha256: '3'.repeat(64), status: 'recorded' });

describe('collector receipt in immutable model context', () => {
  it('keeps absent and null legacy provenance unknown, and accepts the actual poll receipt', () => {
    expect(validEvaluationContext(context(), 1000)).toBe(true);
    expect(validEvaluationContext({ ...context(), collectorWitness: null }, 1000)).toBe(true);
    expect(validEvaluationContext({ ...context(), collectorWitness: witness() }, 1000)).toBe(true);
  });
  it('allows only the small monotonic poll-stamp skew rather than a future capture', () => {
    expect(validEvaluationContext({ ...context(), collectorWitness: { ...witness(), at: 1001 } }, 1000)).toBe(true);
    expect(validEvaluationContext({ ...context(), collectorWitness: { ...witness(), at: 6001 } }, 1000)).toBe(false);
  });
  it.each([
    { seq: 0 }, { sha256: 'wrong' }, { chain: null }, { epoch: '' }, { status: 'guess' }, { topologySha256: null },
  ])('refuses malformed source identities %j', change => {
    expect(validEvaluationContext({ ...context(), collectorWitness: { ...witness(), ...change } }, 1000)).toBe(false);
  });
  it('preserves an explicitly unavailable capture without inventing topology', () => {
    expect(validEvaluationContext({ ...context(), collectorWitness: { ...witness(), status: 'unavailable', topologySha256: null } }, 1000)).toBe(true);
  });
});
