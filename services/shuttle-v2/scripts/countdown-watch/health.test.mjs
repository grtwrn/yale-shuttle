import { describe, it, expect } from 'vitest';
import { inspectCountdownCapture, advance } from '../learning-watch/poll.mjs';
const now = Date.parse('2026-10-24T15:00:00Z');
const expected = { id: 'cycle-1', sourceKey: 'a'.repeat(64), productionBuild: 'fixture', source: { epoch: 'epoch' } };
function healthy() { return { checkedAt: new Date(now).toISOString(), ok: true,
  source: { cycle: expected.id, sourceKey: expected.sourceKey, build: expected.productionBuild, epoch: expected.source.epoch },
  lastFrame: { at: now }, storage: { openBytes: 0, maxOpenBytes: 1000, saturated: false } }; }
describe('independent fleet countdown supervision', () => {
  it('accepts fresh matching source coverage without interpreting candidates as accuracy failures', () => {
    const status = healthy(); status.totalStopLevelCandidates = 50;
    expect(inspectCountdownCapture(status, expected, now)).toEqual([]);
  });
  it.each(['missing', 'stale', 'future'])('reports a %s heartbeat', kind => {
    const status = kind === 'missing' ? null : healthy();
    if (status) status.checkedAt = new Date(now + (kind === 'future' ? 5001 : -120001)).toISOString();
    expect(inspectCountdownCapture(status, expected, now).map(i => i.code)).toContain('countdown-heartbeat');
  });
  it.each(['cycle', 'sourceKey', 'build', 'epoch'])('refuses a fresh heartbeat from another %s', key => {
    const status = healthy(); status.source[key] = 'changed';
    expect(inspectCountdownCapture(status, expected, now).map(i => i.code)).toContain('countdown-capture');
  });
  it('reports storage/capture failures and preserves the existing three-check incident confirmation', () => {
    const status = healthy(); status.ok = false; status.storage.openBytes = 1001; status.storage.saturated = true;
    const issues = inspectCountdownCapture(status, expected, now);
    let prior;
    for (let i = 0; i < 3; i++) { prior = advance(prior, expected.id, issues, now + i * 60000); expect(prior.alerts.length).toBe(i === 2 ? 1 : 0); }
  });
  it('keeps stale models unhealthy while accepting explicit fresh forecast-unavailable receipts', () => {
    const status = healthy(); status.lastFrame.at = now - 200000;
    expect(inspectCountdownCapture(status, expected, now).map(i => i.code)).toContain('countdown-capture');
    status.feedReceipt = { receivedAt: now, forecastAvailable: false, emptyFleet: false };
    expect(inspectCountdownCapture(status, expected, now)).toEqual([]);
  });
});
