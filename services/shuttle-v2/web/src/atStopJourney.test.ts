import { describe, expect, it } from 'vitest';
import type { UpcomingArrival } from './arrivals';
import { atStopJourneyBoard, journeyArrival } from './journeyArrival';
import { boardingVisitAllowed, type TripOption } from './planner';
import { compareDeadline } from './arriveBy';

const now = 1_000_000;
const row = (stopId: number, stopsAhead: number, eta: number, patch: Partial<UpcomingArrival> = {}): UpcomingArrival => ({
  stopId, stopsAhead, eta, low: eta / 2, high: eta * 2, busName: '307', routeLabel: 'Red', color: 'red',
  departNow: eta, lowFloor: 0, estimated: false, distribution: [eta / 2, eta, eta * 2], ...patch,
});
const visits = [row(10, 1, 10), row(20, 6, 500), row(10, 30, 3000), row(20, 35, 3500)];
const board = (rows = visits, bus = '#307') => atStopJourneyBoard(rows, 'Red', bus, 10, 20);
const arrival = (rows = visits, walk = 0) => journeyArrival(board(rows), rows, 20, walk, 30, now);

describe('raw at-stop journey uses an existing ordered forecast', () => {
  it('restores the first destination plus final walk, preserving both pickup and destination occurrences', () => {
    const before = structuredClone(visits);
    expect(board()).toBe(visits[0]);
    expect(arrival()).toMatchObject({ busName: '307', pointMs: now + 530_000,
      distributionMs: [now + 280_000, now + 530_000, now + 1030_000] });
    expect(visits).toEqual(before);
  });
  it('keeps an already-arrived pickup instead of substituting its next lap', () => {
    const here = row(10, 0, 0);
    expect(board([...visits, here])).toBe(here);
    expect(arrival([...visits.slice(1), here], 1)?.catchRisk).toBe(true);
  });
  it('matches normalized raw bus identity and route regardless of wire order', () => {
    const mixed = [...visits, row(20, 0, 0, { busName: '309' }),
      row(20, 0, 0, { routeLabel: 'Blue Day' })].reverse();
    for (const name of ['#307', '307']) expect(board(mixed, name)).toBe(visits[0]);
    expect(arrival(mixed)).toEqual(arrival());
  });
  it('does not borrow the next destination lap when the first destination is before pickup', () => {
    const outgoing = [visits[1]!, visits[2]!, visits[3]!];
    expect(board(outgoing)).toBeUndefined();
    expect(arrival(outgoing)).toBeUndefined();
  });
  it('retains missing data instead of manufacturing a board-now row', () => {
    for (const rows of [[], [visits[0]!], [visits[1]!],
      [visits[0]!, row(20, 6, 500, { busName: '309' })],
      [visits[0]!, row(20, 6, 500, { routeLabel: 'Blue Day' })]]) {
      expect(arrival(rows)).toBeUndefined();
    }
  });
  it('preserves the folded-route boarding gate and refuses to skip a repeated pickup', () => {
    const folded = [row(10, 1, 10), row(10, 5, 300), row(20, 8, 500)];
    expect(boardingVisitAllowed('#307', 10, 20, folded)).toBe(false);
    expect(arrival(folded)).toBeUndefined();
    const laterVisit = folded.slice(1);
    expect(boardingVisitAllowed('#307', 10, 20, laterVisit)).toBe(true);
    expect(board(laterVisit)).toBe(folded[1]);
    expect(arrival(laterVisit)?.pointMs).toBe(now + 530_000);
  });
  it('flags a nonzero walk that can miss pickup and rejects impossible destination timing', () => {
    expect(arrival(visits, 5)?.catchRisk).toBe(false);
    expect(arrival(visits, 6)?.catchRisk).toBe(true);
    expect(arrival(visits, 501)).toBeUndefined();
    for (const patch of [{ eta: 1 }, { high: NaN }, { low: 1000, high: 900 }]) {
      expect(arrival([visits[0]!, row(20, 6, 500, patch)])).toBeUndefined();
    }
  });
});

describe('restored journey class-deadline availability', () => {
  const option: TripOption = { mode: 'shuttle', routeLabel: 'Red', color: 'red', boardStopId: 10,
    alightStopId: 20, busName: '307', walkToSec: 0, walkFromSec: 30, waitSec: 0,
    rideSec: 500, totalSec: 530, directWalkSec: 1500 };
  const compare = (classSec: number, journey = arrival(), patch: Partial<TripOption> = {}) =>
    compareDeadline([{ ...option, journeyArrival: journey, ...patch }], now + classSec * 1000, 5, now, now, false);
  it('moves unavailable timing to fits, tight buffer or late using the full destination window', () => {
    expect(compare(1400).shuttle?.status).toBe('fits');
    expect(compare(1100).shuttle?.status).toBe('buffer');
    expect(compare(1000).shuttle?.status).toBe('late');
    expect(compare(1400, arrival(), { journeyArrival: undefined }).shuttle?.status).toBe('unknown');
  });
  it('does not recommend a risky walking connection or stale/missing timing', () => {
    expect(compare(1400, arrival(visits, 6)).recommendation).toBeUndefined();
    expect(compare(1400, arrival(), { etaUnavailable: true }).shuttle?.status).toBe('unknown');
    expect(compareDeadline([{ ...option, journeyArrival: arrival() }], now + 1400_000, 5,
      now, now - 45_000, false).shuttle?.status).toBe('unknown');
  });
});
