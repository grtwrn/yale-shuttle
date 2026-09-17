import { describe, expect, it } from 'vitest';
import type { UpcomingArrival } from './arrivals';
import { journeyArrival, deadlineError, deadlineStatus, localDateTime } from './journeyArrival';

const now = Date.parse('2026-09-16T14:00:00Z');
const row = (stopId: number, stopsAhead: number, eta: number, patch: Partial<UpcomingArrival> = {}): UpcomingArrival => ({
  stopId, stopsAhead, eta, low: eta / 2, high: eta * 2, busName: '307', routeLabel: 'Red', color: '#f00',
  departNow: eta, lowFloor: 0, estimated: false, ...patch,
});

describe('destination arrival for a catchable visit', () => {
  const board = row(48, 2, 180);
  it('uses the full alight distribution plus walking, without adding pickup uncertainty twice', () => {
    const a = journeyArrival(board, [board, row(121, 8, 600)], 121, 60, 120, now)!;
    expect(a).toEqual({ busName: '307', pointMs: now + 720_000, lowMs: now + 420_000,
      highMs: now + 1320_000, catchRisk: false, estimated: false });
  });
  it('selects the same vehicle and route after boarding, not the preceding pass or another bus', () => {
    const a = journeyArrival(board, [row(121, 1, 30), row(121, 3, 200, { busName: '309' }),
      row(121, 4, 220, { routeLabel: 'Blue Day' }), row(121, 8, 600)], 121, 0, 0, now)!;
    expect(a.pointMs).toBe(now + 600_000);
  });
  it('does not stitch together different pickup passes on a folded route', () => {
    expect(journeyArrival(board, [board, row(48, 5, 400), row(121, 8, 600)], 121, 0, 0, now)).toBeUndefined();
    const nextBoard = row(48, 5, 400);
    expect(journeyArrival(nextBoard, [board, nextBoard, row(121, 8, 600)], 121, 0, 0, now)).toBeDefined();
  });
  it('flags a pickup that could beat the walk without relying on driver dwell', () => {
    expect(journeyArrival(board, [row(121, 8, 600)], 121, 91, 0, now)?.catchRisk).toBe(true);
    const here = row(48, 0, 0);
    expect(journeyArrival(here, [row(121, 4, 600)], 121, 0, 0, now)?.catchRisk).toBe(false);
    expect(journeyArrival(here, [row(121, 4, 600)], 121, 1, 0, now)?.catchRisk).toBe(true);
  });
  it('withholds impossible or missing journeys instead of inventing a range', () => {
    expect(journeyArrival(undefined, [], 121, 0, 0, now)).toBeUndefined();
    for (const destination of [row(121, 8, 100), row(121, 8, 600, { high: NaN }), row(121, 8, 600, { low: 900, high: 800 })]) {
      expect(journeyArrival(board, [destination], 121, 0, 0, now)).toBeUndefined();
    }
    expect(journeyArrival(board, [row(121, 8, 600)], 121, 700, 0, now)).toBeUndefined();
  });
});

describe('class deadline', () => {
  it('separates the indoor buffer from missing class', () => {
    expect(deadlineStatus(now + 900_000, now + 1200_000, 5)).toBe('fits');
    expect(deadlineStatus(now + 900_001, now + 1200_000, 5)).toBe('buffer');
    expect(deadlineStatus(now + 1200_001, now + 1200_000, 5)).toBe('late');
    expect(deadlineStatus(undefined, now + 1200_000, 5)).toBe('unknown');
  });
  it('keeps the date, rejects passed times and never rolls them into tomorrow', () => {
    expect(Date.parse(localDateTime(now))).toBe(now);
    expect(deadlineError(localDateTime(now - 60_000), now)).toMatch(/passed/);
    expect(deadlineError(localDateTime(now + 86400_000), now)).toBeNull();
    expect(deadlineError('invalid', now)).toMatch(/Choose/);
  });
});

it('translates the selected destination dots by the final walk only', () => {
  const board = row(48, 2, 180, { distribution: [90, 180, 360] });
  const right = row(121, 8, 600, { distribution: [400, 600, 900] });
  const wrong = row(121, 3, 250, { busName: '999', distribution: [1, 2, 3] });
  expect(journeyArrival(board, [board, wrong, right], 121, 60, 120, now)?.distributionMs)
    .toEqual([now + 520_000, now + 720_000, now + 1020_000]);
});
