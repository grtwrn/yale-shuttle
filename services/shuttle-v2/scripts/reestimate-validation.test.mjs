import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMPILED } from './reestimate-lib.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import { cachedArtifact, chronologicalPlan, fileIdentity, identityHash, researchCandidate, validationCells, validationDecision, visitAvailableBy } from './reestimate-validation.mjs';

const temps = [];
afterEach(() => { for (const p of temps.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const unit = { '0-2': 1, '2-5': 1, '5-10': 1, '10-30': 1 };

describe('chronological evaluation', () => {
  it('keeps all five blocks ordered, disjoint, and immune to repeated dates', () => {
    const dates = Array.from({ length: 30 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
    const p = chronologicalPlan([...dates.reverse(), '2026-08-30']);
    expect(p.ready).toBe(true);
    expect([p.training.length, p.correctionFit.length, p.selection.length, p.calibration.length, p.test.length]).toEqual([14, 2, 1, 2, 3]);
    const all = [p.training, p.correctionFit, p.selection, p.calibration, p.test].flat();
    expect(all).toEqual([...new Set(all)].sort());
    expect(p.test).toEqual(['2026-08-28', '2026-08-29', '2026-08-30']);
  });
  it('refuses to turn insufficient dates into a shared tuning/test window', () => {
    const dates = Array.from({ length: 14 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
    expect(chronologicalPlan(dates).ready).toBe(false);
    expect(chronologicalPlan(dates).reasons[0]).toContain('15 distinct');
  });
  it('counts only visits whose outcome and known confirmation delay precede training cutoff', () => {
    expect(visitAvailableBy({ departed_at: 90_000, first_moved_at: 95_000, confirm_sec: 10 }, 100_000)).toBe(false);
    expect(visitAvailableBy({ departed_at: 101_000 }, 100_000)).toBe(false);
    expect(visitAvailableBy({ departed_at: null }, 100_000)).toBe(false);
    expect(visitAvailableBy({ departed_at: 90_000, confirm_sec: 10 }, 100_000)).toBe(true);
  });
  it('fits interval corrections to the frozen candidate and never reads final test outcomes', () => {
    const plan = chronologicalPlan(Array.from({ length: 15 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`));
    const calls = [];
    const result = researchCandidate(plan, {
      fits: { P_REPEAT_STAND: { value: 0.9, n: 100_000 } },
      replay: (day, phase, params) => { calls.push({ day, phase, params: structuredClone(params) }); return `${day}|${phase}`; },
      read: file => {
        expect(plan.test.some(day => file.startsWith(day))).toBe(false);
        return Array.from({ length: 600 }, () => file.includes('interval-calibration')
          ? { r: 3, eta: 100, low: 90, high: 110, det: 130 }
          : { r: 3, eta: 600, low: 300, high: 900, det: 650 });
      },
      pooledShares: () => ({}),
    });
    expect(calls.map(c => c.day)).toEqual([...plan.correctionFit, ...plan.selection, ...plan.calibration]);
    expect(result.candidate.params.P_REPEAT_STAND).toBe(0.9);
    expect(result.candidate.params.HORIZON_BIAS['10-30'].b).toBe(50);
    const calibration = calls.filter(c => c.phase === 'interval-calibration');
    expect(calibration).toHaveLength(2);
    for (const c of calibration) {
      expect(c.params.P_REPEAT_STAND).toBe(result.candidate.params.P_REPEAT_STAND);
      expect(c.params.HORIZON_BIAS).toEqual(result.candidate.params.HORIZON_BIAS);
      expect(c.params.HORIZON_BIAS).not.toEqual(COMPILED.HORIZON_BIAS);
    }
    expect(result.candidate.params.CONFORMAL['0-2']).toBe(3);
  });
  it('CLI fails closed before network or replay work when complete archive dates are insufficient', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-empty-archive-')); temps.push(dir);
    const archive = path.join(dir, 'archive'); fs.mkdirSync(archive);
    // A manifest alone must not count as a completed input day.
    for (let i = 1; i <= 20; i++) {
      const day = path.join(archive, `2026-09-${String(i).padStart(2, '0')}`); fs.mkdirSync(day);
      fs.writeFileSync(path.join(day, 'manifest.json'), '{"ok":true}');
    }
    const work = path.join(dir, 'work');
    const run = spawnSync(process.execPath, ['scripts/reestimate-params.mjs', '--dry-run', '--archive', archive,
      '--work', work, '--base-url', 'http://127.0.0.1:1', '--base', path.join(dir, 'missing.db')], { encoding: 'utf8', timeout: 10_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('found 0');
    const report = JSON.parse(fs.readFileSync(path.join(work, 'latest-validation.json'), 'utf8'));
    expect(report.accepted).toBe(false);
  });
});

describe('content-addressed completed artifacts', () => {
  function setup() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-validation-')); temps.push(dir); return path.join(dir, 'pairs.jsonl'); }
  it('invalidates for actual source/input/parameter bytes and reuses only an intact output', () => {
    const file = setup(), input = `${file}.input`;
    fs.writeFileSync(input, 'first');
    let produced = 0;
    const produce = p => { produced++; fs.writeFileSync(p, '{"ok":true}\n'); };
    const validate = p => JSON.parse(fs.readFileSync(p, 'utf8'));
    const id = () => ({ source: 'a', params: { scale: 1 }, inputs: fileIdentity([input]) });
    expect(cachedArtifact(file, id(), produce, validate).reused).toBe(false);
    expect(cachedArtifact(file, id(), produce, validate).reused).toBe(true);
    fs.writeFileSync(input, 'other');
    expect(cachedArtifact(file, id(), produce, validate).reused).toBe(false);
    expect(cachedArtifact(file, { ...id(), params: { scale: 1.1 } }, produce, validate).reused).toBe(false);
    expect(cachedArtifact(file, { ...id(), source: 'b' }, produce, validate).reused).toBe(false);
    fs.writeFileSync(file, 'truncated');
    expect(cachedArtifact(file, { ...id(), source: 'b' }, produce, validate).reused).toBe(false);
    expect(produced).toBe(5);
    expect(identityHash({ a: 1, b: 2 })).toBe(identityHash({ b: 2, a: 1 }));
  });
  it('never reuses an interrupted or invalid production attempt', () => {
    const file = setup();
    fs.writeFileSync(file, 'partial legacy artifact');
    expect(() => cachedArtifact(file, {}, p => { fs.writeFileSync(p, 'partial'); throw new Error('crashed'); }, () => {})).toThrow('crashed');
    expect(fs.existsSync(`${file}.complete.json`)).toBe(false);
    expect(() => cachedArtifact(file, {}, p => fs.writeFileSync(p, 'broken'), p => JSON.parse(fs.readFileSync(p, 'utf8')))).toThrow();
    expect(fs.existsSync(`${file}.complete.json`)).toBe(false);
    expect(cachedArtifact(file, {}, p => fs.writeFileSync(p, '{}'), p => JSON.parse(fs.readFileSync(p, 'utf8'))).reused).toBe(false);
  });
});

describe('proper-score, route and tail gates', () => {
  const pair = (det, low = 60, high = 140) => ({ r: 3, eta: 100, low, high, det });
  it('scores exact median/interval performance and does not hide missing or past outcomes', () => {
    const c = validationCells([pair(100), pair(180), pair(null), pair(-20)], unit)['3|0-2'];
    expect(c.n).toBe(4); expect(c.scored).toBe(2); expect(c.covered).toBe(1); expect(c.late).toBe(1);
    expect(c.abs).toBe(80); expect(c.width).toBe(160);
    // IS:80 + (80 +10*40), plus the two median errors.
    expect(c.wis).toBeCloseTo((0.5 * 80 + 0.1 * 560) / 1.5);
  });
  const days = (change = x => x) => Array.from({ length: 3 }, (_, i) => ({ day: `2026-09-${10 + i}`,
    champion: validationCells(Array.from({ length: 40 }, () => pair(100, 0, 200)), unit),
    challenger: validationCells(Array.from({ length: 40 }, (_, j) => change(pair(100), j)), unit) }));
  it('cannot promote apparently perfect correlated-poll results or legacy outcome clocks', () => {
    const d = validationDecision(days());
    expect(d.promote).toBe(false);
    expect(d.reasons).toContainEqual(expect.stringContaining('identity'));
    expect(d.reasons).toContainEqual(expect.stringContaining('availability'));
  });
  it('checks every route/horizon and fails on upper-tail harm despite a narrow interval', () => {
    const d = validationDecision(days((p, j) => ({ ...p, det: j < 9 ? 200 : 100 })), { groupingVerified: true, availabilityVerified: true, baselineVintageVerified: true });
    expect(d.promote).toBe(false);
    expect(d.reasons).toContainEqual(expect.stringContaining('3|0-2: upper-tail'));
    expect(d.reasons).toContainEqual(expect.stringContaining('weighted interval score'));
  });
  it('accepts better proper scores only with adequate untouched dates and verified evidence', () => {
    const evidence = { groupingVerified: true, availabilityVerified: true, baselineVintageVerified: true };
    expect(validationDecision(days(), evidence).promote).toBe(true);
    expect(validationDecision(days().slice(0, 2), evidence).promote).toBe(false);
    expect(validationDecision([], evidence).promote).toBe(false);
  });
  it('rejects missing cells, wider unhelpful bands, and missing outcomes', () => {
    const evidence = { groupingVerified: true, availabilityVerified: true, baselineVintageVerified: true };
    expect(validationDecision(days(p => ({ ...p, low: -100, high: 300 })), evidence).promote).toBe(false);
    expect(validationDecision(days((p, j) => ({ ...p, det: j < 5 ? null : 100 })), evidence).promote).toBe(false);
    const d = days(); delete d[0].challenger['3|0-2'];
    expect(validationDecision(d, evidence).promote).toBe(false);
  });
});
