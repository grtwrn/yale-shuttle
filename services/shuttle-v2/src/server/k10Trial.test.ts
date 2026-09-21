import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { applyK10Trial, K10_MODEL, k10Prediction } from './k10Trial.js';
import type { K10Evidence } from '../collector/k10Clock.js';
import type { ServerEtaWire } from '../../web/src/etaSource.js';

interface Fixture extends K10Evidence {
  now: number; target: number;
  expected: { eta: number; low: number; high: number };
}
const fixtures: Fixture[] = JSON.parse(gunzipSync(fs.readFileSync(new URL('./__fixtures__/k10-parity.json.gz', import.meta.url))).toString());
const sample = fixtures.find(f => !f.released && f.index >= 8 && f.index <= 14 && f.expected.eta > 120)!;
function wire(f = sample): ServerEtaWire {
  return { v: 2, at: f.now, servedAt: f.now, buses: [['309', 'Red', f.index, null]],
    rows: [[0, f.target, 800, 100, 1400, K10_MODEL.sequence.indexOf(f.target) - f.index, 0, 200, 50]],
    distributions: [Array.from({ length: 50 }, (_, i) => i * 20)] };
}

describe('K10 trial prior and hybrid', () => {
  it('matches all 7,425 independent Python forecasts across 14 pickups', () => {
    expect(fixtures).toHaveLength(7425);
    expect(new Set(fixtures.map(f => f.target)).size).toBe(14);
    for (const f of fixtures) {
      const p = k10Prediction(K10_MODEL, f.target, f.origin.departed, f.now)!;
      expect(p).not.toBeNull();
      for (const key of ['eta', 'low', 'high'] as const) expect(p[key]).toBeCloseTo(f.expected[key], 7);
      expect(p.distribution).toHaveLength(50);
      expect(p.distribution).toEqual([...p.distribution].sort((a, b) => a - b));
    }
  });
  it('changes point, band and distribution together, preserving drive metadata', () => {
    const base = wire(), before = JSON.stringify(base);
    const trial = applyK10Trial(base, new Map([['309', sample]]), K10_MODEL.sequence);
    expect(trial.trial?.changedRows).toBe(1);
    expect(trial.rows[0]!.slice(2, 5)).toEqual(['eta','low','high'].map(k => Math.round(sample.expected[k as keyof typeof sample.expected])));
    expect(trial.rows[0]!.slice(5)).toEqual(base.rows[0]!.slice(5));
    expect(trial.distributions).not.toEqual(base.distributions);
    expect(JSON.stringify(base)).toBe(before);
  });
  it('hands off byte-for-byte after observed release, including quantiles', () => {
    for (const f of fixtures.filter(f => f.released)) {
      const base = wire(f), trial = applyK10Trial(base, new Map([['309', f]]), K10_MODEL.sequence);
      expect(trial.rows).toEqual(base.rows);
      expect(trial.distributions).toEqual(base.distributions);
    }
  });
  it('falls back before the upstream countdown could reach now during snapshot freshness', () => {
    const expired = fixtures.filter(f => !f.released && f.expected.eta <= 60);
    expect(expired.length).toBeGreaterThan(50);
    for (const f of expired) {
      const base = wire(f), trial = applyK10Trial(base, new Map([['309', f]]), K10_MODEL.sequence);
      expect(trial.rows).toEqual(base.rows);
      expect(trial.distributions).toEqual(base.distributions);
    }
  });
  it('fails back for unobserved/future/stale evidence, topology changes and expired model', () => {
    const base = wire();
    const check = (e: K10Evidence, seq = K10_MODEL.sequence, w = base) => {
      expect(applyK10Trial(w, new Map([['309', e]]), seq).rows).toEqual(w.rows);
    };
    expect(applyK10Trial(base, new Map(), K10_MODEL.sequence).rows).toEqual(base.rows);
    check({ ...sample, origin: { ...sample.origin, knownAt: sample.now + 1 } });
    check({ ...sample, observedAt: sample.now - 15_001 });
    check({ ...sample, observedAt: sample.now + 1 });
    check(sample, K10_MODEL.sequence.slice(1));
    check(sample, K10_MODEL.sequence, { ...base, at: K10_MODEL.validUntil });
    expect(k10Prediction({ ...K10_MODEL, paths: { [sample.target]: K10_MODEL.paths[sample.target]!.slice(0, 5) } }, sample.target, sample.origin.departed, sample.now)).toBeNull();
  });
  it('preserves other routes, untested pickups, and next-lap occurrences', () => {
    const base = wire();
    for (const changed of [
      { ...base, buses: [['309','Blue',sample.index,null]] },
      { ...base, rows: [[0,11,800,100,1400,2,0,200,50]] },
      { ...base, rows: [base.rows[0]!.map((n,i) => i === 5 ? n + 29 : n)] },
    ] as ServerEtaWire[]) expect(applyK10Trial(changed,new Map([['309',sample]]),K10_MODEL.sequence).rows).toEqual(changed.rows);
  });
});
