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
  it('stays beside the bus when stacking above an arrival chip would be farther away', () => {
    const rect = { left: 141, right: 219, top: 328, bottom: 348 };
    const bus = { left: 166, right: 194, top: 350, bottom: 378 };
    const shift = placeWaitLabel(rect, { left: 25, right: 365, top: 210, bottom: 530 },
      [{ left: 147, right: 243, top: 313, bottom: 347 },
        { left: 182, right: 210, top: 375, bottom: 403 }], bus);
    expect(shift).toEqual({ x: -59, y: 25 });
  });
  it.each([270, 340, 380])('avoids controls and arrival labels in a %ipx phone map', width => {
    const rect = { left: width - 146, right: width - 43, top: 39, bottom: 73 };
    const blockers = [
      { left: 10, right: 44, top: 10, bottom: 84 },
      { left: width - 52, right: width - 8, top: 8, bottom: 52 },
      { left: width - 136, right: width - 26, top: 78, bottom: 102 },
    ];
    const shift = placeWaitLabel(rect, { left: 0, top: 0, right: width, bottom: 320 }, blockers);
    const placed = { left: rect.left + shift.x, right: rect.right + shift.x,
      top: rect.top + shift.y, bottom: rect.bottom + shift.y };
    expect(placed.left).toBeGreaterThanOrEqual(6);
    expect(placed.right).toBeLessThanOrEqual(width - 6);
    expect(placed.top).toBeGreaterThanOrEqual(6);
    expect(placed.bottom).toBeLessThanOrEqual(314);
    for (const b of blockers) expect(placed.right + 6 <= b.left || placed.left >= b.right + 6
      || placed.bottom + 6 <= b.top || placed.top >= b.bottom + 6).toBe(true);
  });
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
    expect(a.compact).toBe('3:21/~5m');
    expect(a.typical).toBe('Usually ~5 min total');
    expect(b.typical).toBe(a.typical);
    expect(b.elapsed).toBe('Waiting 10:01');
    expect(b.compact).toBe('10:01/~5m');
    expect(b.overdue).toBe(true);
    expect(mapWaitLabel({ stopId: 11, standingSec: 201, approach: true }, dwells, undefined)?.elapsed).toBe('Waiting nearby 3:21');
  });
  it('disappears for a moving bus and never invents a typical wait from the old hop median', () => {
    expect(mapWaitLabel(null, dwells, undefined)).toBeNull();
    expect(mapWaitLabel({ stopId: 11, standingSec: 90 }, { 11: { med: 9999, sd: 0, n: 30 } }, undefined)).toBeNull();
    expect(mapWaitLabel({ stopId: 11, standingSec: 90 }, { 11: { ...dwells[11], n: 2 } }, undefined)).toBeNull();
  });
});
