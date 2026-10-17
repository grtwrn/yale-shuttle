import { describe, expect, it } from 'vitest';
import { auditDisplay, type AuditFeed } from './check';
import winchester from '../../web/src/__fixtures__/red-winchester-report-142.json';
import folded from '../../web/src/__fixtures__/folded-standing-display.json';

describe('all-line display audit', () => {
  it('checks every eligible pickup and exit at the recorded Red stand', () => {
    const result = auditDisplay(structuredClone(winchester.feed) as unknown as AuditFeed, winchester.receivedAt);
    expect(result.findings).toEqual([]);
    expect(result.coverage.pickupCounts).toBeGreaterThan(20);
    expect(result.coverage.exitCounts).toBe(result.coverage.pickupCounts);
  });
  it('reports skipped coverage when the model has not confirmed the curb stand', () => {
    const feed = structuredClone(winchester.feed);
    // GPS is at Winchester, but the model is still approaching it. The
    // display cannot take the confirmed-stand override and counts from Wall.
    (feed.server_eta.buses[0]![3] as { approach: boolean }).approach = true;
    // No confirmed stand: explicitly report skipped coverage, not a pass.
    const result = auditDisplay(feed as unknown as AuditFeed, winchester.receivedAt);
    expect(result.coverage.confirmedStands).toBe(1);
  });
  it.each(folded)('checks folded physical rows while declining an ambiguous direction count', capture => {
    const result = auditDisplay(structuredClone(capture.feed) as unknown as AuditFeed, capture.receivedAt);
    expect(result.findings).toEqual([]);
    expect(result.coverage.positions).toBe(1);
    expect(result.coverage.foldedCountsSkipped).toBe(1);
    expect(result.coverage.pickupCounts).toBe(0);
  });
  it('rejects stale or malformed ETA sources and does not score an old vehicle', () => {
    const feed = structuredClone(winchester.feed);
    expect(() => auditDisplay({ ...feed, server_eta: null } as unknown as AuditFeed, winchester.receivedAt)).toThrow();
    feed.server_eta.servedAt += 45_000;
    expect(() => auditDisplay(feed as unknown as AuditFeed, winchester.receivedAt)).toThrow();
    const stale = structuredClone(winchester.feed);
    for (const bus of stale.buses) bus.observed_at = winchester.receivedAt - 60_000;
    expect(auditDisplay(stale as unknown as AuditFeed, winchester.receivedAt).coverage.confirmedStands).toBe(0);
  });
});
