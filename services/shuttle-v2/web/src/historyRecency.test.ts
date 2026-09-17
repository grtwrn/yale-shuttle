import { expect, it } from 'vitest';
import { historyRecency } from './historyRecency';
const DAY = 86_400_000, now = 30 * DAY;

it('halves influence every two days without deleting or moving old trips', () => {
  const trips = [0, 2, 4, 30].map(days => ({ arrivedAt: now - days * DAY, actualSec: 600 }));
  const copy = structuredClone(trips);
  expect(historyRecency(trips, now).weights).toEqual([1, 0.5, 0.25, 2 ** -15]);
  expect(trips).toEqual(copy);
});
it('gives recent trips more influence than a larger old group', () => {
  const trips = [...Array.from({ length: 6 }, () => ({ arrivedAt: now, actualSec: 600 })),
    ...Array.from({ length: 10 }, () => ({ arrivedAt: now - 8 * DAY, actualSec: 120 }))];
  expect(historyRecency(trips, now).median).toBe(600);
  expect(historyRecency(trips.reverse(), now).median).toBe(600);
});
it('keeps the ordinary median for equal-age samples and refuses a dominant single trip', () => {
  expect(historyRecency([60, 120, 180, 240, 300, 360].map(actualSec => ({ arrivedAt: now, actualSec })), now).median).toBe(210);
  const thin = historyRecency([{ arrivedAt: now, actualSec: 600 },
    ...Array.from({ length: 99 }, () => ({ arrivedAt: now - 30 * DAY, actualSec: 120 }))], now);
  expect(thin.effectiveTrips).toBeLessThan(2);
  expect(thin.median).toBeNull();
});
it('ignores invalid or future records and handles an empty comparison', () => {
  expect(historyRecency([], now)).toEqual({ weights: [], median: null, effectiveTrips: 0 });
  expect(historyRecency([{ arrivedAt: now + DAY, actualSec: 10 }, { arrivedAt: now, actualSec: NaN }], now).weights).toEqual([0, 0]);
});
