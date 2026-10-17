import { describe, expect, it } from 'vitest';
import { evaluate, UNIT } from './lib.mjs';
import { conformalFit } from '../reestimate-lib.mjs';
import { validationCells } from '../reestimate-validation.mjs';

const at = Date.parse('2026-10-14T12:00:00Z');
const days = ['2026-10-14', '2026-10-15', '2026-10-16'];
const frozen = () => ({ id: 'policy-fixture', startedAt: at - 3 * 86400000, calibratedAt: at - 10000,
  champion: { publishedAt: at - 4 * 86400000 }, candidate: { params: { CONFORMAL: UNIT } }, requiredRoutes: [13] });
const rows = () => days.flatMap((day, d) => Array.from({ length: 40 }, (_, i) => ({
  id: `${day}-${i}`, day, phase: 'test', at: at + d * 86400000,
  availableAt: at + d * 86400000 + 100000, inputHash: 'synthetic-input', r: 13, h: '0-2', busId: i,
  det: 100, champion: { eta: 100, low: 0, high: 200 }, challenger: { eta: 100, low: 50, high: 150 },
})));

describe('prospective promotion policy', () => {
  it('cannot turn an unserved fleet into calibration support or a passing test', () => {
    const missing = rows().map(row => ({ ...row, det: null, reason: 'no-service-observed' }));
    const fit = conformalFit(missing.map(row => ({ ...row.challenger, det: row.det })));
    expect(Object.values(fit).every(cell => cell.n === 0 && cell.w === null)).toBe(true);
    const decision = evaluate(frozen(), missing, days);
    expect(decision.promote).toBe(false);
    for (const arm of ['champion', 'challenger']) {
      expect(decision.totals[arm]['0|all'].n).toBe(120);
      expect(decision.totals[arm]['0|all'].scored).toBe(0);
    }
  });
  it('rejects a challenger that omits forecasts even when its scored intervals improve', () => {
    const partial = rows();
    for (const row of partial.slice(0, 10)) row.challenger = { eta: 100, low: null, high: null, missing: true };
    const decision = evaluate(frozen(), partial, days);
    expect(decision.totals.champion['0|all'].n).toBe(120);
    expect(decision.totals.challenger['0|all'].n).toBe(120);
    expect(decision.totals.challenger['0|all'].scored).toBe(110);
    expect(decision.promote).toBe(false);
    expect(decision.reasons.some(reason => /outcome matching fell/.test(reason))).toBe(true);
  });
  it('uses the shared reference cohort while pricing intervals from the candidate ETA', () => {
    const pair = { r: 13, h: '0-2', eta: 400, low: 300, high: 500, det: 100 };
    const factors = { '0-2': 0.5, '2-5': 1, '5-10': 2, '10-30': 3 };
    const cells = validationCells([pair], factors, { referenceHorizons: true });
    expect(cells['13|0-2'].n).toBe(1);
    expect(cells['13|5-10']).toBeUndefined();
    expect(cells['13|0-2'].width).toBe(400); // 2x the candidate's original 200-second width
    expect(cells['13|0-2'].early).toBe(1); // [200,600] leaves the 100-second arrival below the band
  });
});
