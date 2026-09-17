import { describe, expect, it } from 'vitest';
import { arrivalSummary, estimatedGap, predictionWindow } from './arrivalDetails';

describe('arrival detail window', () => {
  it('keeps a point visible across wide windows and reserves at-stop language for observed presence', () => {
    expect(arrivalSummary(390, 120, 1200, 0, 0).token).toBe('About 6 min\nLikely 2–20 min');
    expect(arrivalSummary(0).point).toBe('About <1 min');
    expect(arrivalSummary(0, 0, 600, 0, 0, true).token).toBe('At your stop');
  });
  it('preserves wide uncertainty and rounds the interval outwards', () => {
    expect(predictionWindow(3 * 60 + 45, 19 * 60 + 5, undefined, 0)?.text).toBe('3–20 min');
    expect(predictionWindow(-30, 8 * 60 + 5, undefined, 0)?.text).toBe('<1–9 min');
  });
  it('ages both bounds and handles arrival, absent and invalid data', () => {
    expect(predictionWindow(120, 480, 1000, 31000)?.text).toBe('1–8 min');
    expect(predictionWindow(0, 0)).toBeNull();
    expect(predictionWindow(undefined, 300)).toBeNull();
    expect(predictionWindow(300, 120)).toBeNull();
    expect(predictionWindow(NaN, 300)).toBeNull();
  });

  it('collapses the two spellings of about a minute into one', () => {
    // "<1–1 min" is not a range: the ends differ only by the "<" — the same
    // pair standLeftText collapses for the departure chip (2026-09-10, and
    // flagged again by the 2026-09-17 rider eval against the live card).
    expect(predictionWindow(30, 55, 0, 0)?.text).toBe('~1 min');
    expect(predictionWindow(0, 70, 0, 0)?.text).toBe('<1–2 min');
  });
});

describe('arrivalSummary while the bus is holding', () => {
  // The 2026-09-17 ride eval: #316 stood at 344 Winchester three stops out
  // and the card read "About 4 min" then "About 1 min" six seconds later —
  // the stand's residual decayed and the point collapsed to the drive floor,
  // where it sat through the rest of the hold, six minutes before pickup.
  // During a hold the strongest claim is the window, not the point.
  it('leads with the hold and the window instead of an almost-now point', () => {
    const s = arrivalSummary(52, 30, 640, 0, 0, false, { at: '344 Winchester' });
    expect(s.point).toBe('Waiting at 344 Winchester');
    expect(s.token).toBe('Waiting at 344 Winchester\nLikely arrives <1–11 min');
  });

  it('says "near" for a bus holding short of the marker', () => {
    expect(arrivalSummary(52, 30, 640, 0, 0, false, { at: '344 Winchester', near: true }).point)
      .toBe('Waiting near 344 Winchester');
  });

  it('keeps the point when there is no window, disclaimed by the hold', () => {
    expect(arrivalSummary(240, undefined, undefined, 0, 0, false, { at: '344 Winchester' }).token)
      .toBe('Waiting at 344 Winchester\nAbout 4 min away');
  });

  it('still says "At your stop" once the bus is at the board stop', () => {
    expect(arrivalSummary(0, 0, 600, 0, 0, true, { at: 'Division/Prospect' }).token).toBe('At your stop');
  });

  it('is unchanged for a bus that is not holding', () => {
    expect(arrivalSummary(390, 120, 1200, 0, 0).token).toBe('About 6 min\nLikely 2–20 min');
  });
});

it('reports a gap only for an available later arrival', () => {
  expect(estimatedGap(300, 780)).toBe(480);
  expect(estimatedGap(300, 300)).toBe(0);
  expect(estimatedGap(300, 200)).toBeNull();
  expect(estimatedGap(300, null)).toBeNull();
  expect(estimatedGap(300, Infinity)).toBeNull();
});
