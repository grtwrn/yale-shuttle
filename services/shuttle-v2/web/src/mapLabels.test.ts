import { describe, expect, it } from 'vitest';
import { compactMapArrival, mapArrivalLabel, mapWaitLabel, placeWaitLabel } from './mapLabels';
import { displayBand, chipCountdownText } from './etaBand';
import { arrivalSummary } from './arrivalDetails';

describe('reports 113/114: point and range keep separate roles', () => {
  for (const [name, eta, low, high] of [['Red', 550, 179, 1081], ['Blue', 150, 119, 241]] as const) {
    it(`${name}: ticking across a legacy width cutoff never replaces the estimate`, () => {
      const at = 1_000_000;
      const old = [], current = [];
      for (let seconds = 0; seconds <= 3; seconds++) {
        old.push(chipCountdownText(displayBand(low, high, at, at + seconds * 1000), eta - seconds));
        const label = mapArrivalLabel({ eta: eta - seconds, low, high, computedAtMs: at }, at + seconds * 1000)!;
        const card = arrivalSummary(eta - seconds, low, high, at, at + seconds * 1000);
        expect(label.point).toBe(card.point);
        expect(label.window).toBe(`Likely ${card.band!.text}`);
        expect(label.window).not.toBeNull();
        expect(compactMapArrival(label)).toBe(card.band!.text);
        current.push(label.point);
      }
      expect(new Set(old).size).toBeGreaterThan(1); // reproduces the switch
      expect(new Set(current).size).toBe(1);
    });
  }
  it('preserves broad uncertainty, missing bands and observed arrival', () => {
    expect(mapArrivalLabel({ eta: 9 * 60, low: 120, high: 19 * 60 })).toEqual({ point: 'About 9 min', window: 'Likely 2–19 min' });
    expect(mapArrivalLabel({ eta: 120 })).toEqual({ point: 'About 2 min', window: null });
    expect(mapArrivalLabel({ eta: 0, low: 0, high: 0 }, 0, true)).toEqual({ point: 'At your stop', window: null });
    expect(mapArrivalLabel({ eta: NaN })).toBeNull();
    expect(compactMapArrival(mapArrivalLabel({ eta: 120 }))).toBe('~2 min');
    expect(compactMapArrival(mapArrivalLabel({ eta: 0 }, 0, true))).toBe('At stop');
    expect(compactMapArrival(null)).toBeNull();
  });
});

describe('bus wait label', () => {
  it('moves a wait label clear of the pickup window and zoom control while keeping it above the bus', () => {
    const rect = { left: 85, right: 188, top: 42, bottom: 78 };
    const blockers = [{ left: 118, right: 222, top: 8, bottom: 80 }, { left: 8, right: 42, top: 7, bottom: 78 }];
    const shift = placeWaitLabel(rect, { left: 0, top: 0, right: 340, bottom: 320 }, blockers);
    expect(rect.left + shift.x).toBeGreaterThanOrEqual(228);
    expect(rect.right + shift.x).toBeLessThanOrEqual(334);
    expect(shift.y).toBeLessThanOrEqual(0);
  });
  const dwells = { 11: { med: 9999, sd: 0, n: 30, qn: 30, q: [60, 120, 180, 240, 300, 300, 360, 420, 480, 600] } };
  it('shows elapsed and a stable typical total, including after that total is exceeded', () => {
    const a = mapWaitLabel({ stopId: 11, standingSec: 201.9 }, dwells, undefined)!;
    const b = mapWaitLabel({ stopId: 11, standingSec: 601 }, dwells, undefined)!;
    expect(a.elapsed).toBe('Waiting 3:21');
    expect(a.typical).toBe('Usually ~5 min total');
    expect(b.typical).toBe(a.typical);
    expect(b.elapsed).toBe('Waiting 10:01');
    expect(b.overdue).toBe(true);
    expect(mapWaitLabel({ stopId: 11, standingSec: 201, approach: true }, dwells, undefined)?.elapsed).toBe('Waiting nearby 3:21');
  });
  it('disappears for a moving bus and never invents a typical wait from the old hop median', () => {
    expect(mapWaitLabel(null, dwells, undefined)).toBeNull();
    expect(mapWaitLabel({ stopId: 11, standingSec: 90 }, { 11: { med: 9999, sd: 0, n: 30 } }, undefined)).toBeNull();
    expect(mapWaitLabel({ stopId: 11, standingSec: 90 }, { 11: { ...dwells[11], n: 2 } }, undefined)).toBeNull();
  });
});
