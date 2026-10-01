import { describe, expect, it } from 'vitest';
import type { UpcomingArrival } from './arrivals';
import { pickLiveArrival, rideBoardArrivals } from './planner';
import { atStopJourneyBoard, journeyArrival } from './journeyArrival';
import { forecastPickupSelection, rawPickupSelection } from './livePickupSelection';

const now = Date.parse('2026-09-17T18:00:00Z');
const row = (busName: string, stopId: number, stopsAhead: number, eta: number): UpcomingArrival => ({
  busName, stopId, stopsAhead, eta, routeLabel: 'Red', color: '#C62828',
  low: Math.max(0, eta - 20), high: eta + 80, lowFloor: Math.max(0, eta - 20),
  departNow: eta, estimated: false,
});
const first = row('#307', 48, 1, 20), later = row('307', 48, 30, 1200);
const target = row('307', 121, 10, 500), laterTarget = row('307', 121, 39, 1800);
const other = row('309', 48, 3, 300), otherTarget = row('309', 121, 12, 800);
const pick = (visits: UpcomingArrival[], walk: number) => pickLiveArrival(rideBoardArrivals(visits, 48, 121), '#307', walk);

describe('selected pickup evidence is independent of destination availability', () => {
  it('keeps the actual other vehicle while its destination forecast disappears', () => {
    const visits = [first, other, target, otherTarget, later, laterTarget];
    const selected = pick(visits, 100)!;
    const missing = pick([first, other, later], 100)!;
    expect(selected.match).toBe(first);
    expect(selected.boardable).toBe(other);
    expect(journeyArrival(selected.boardable, visits, 121, 100, 60, now)).toBeDefined();
    expect(journeyArrival(missing.boardable, [first, other, later], 121, 100, 60, now)).toBeUndefined();
    const actual = forecastPickupSelection(selected, now)!;
    expect(actual.relation).toBe('different-bus');
    expect(actual.countdown.busName).toBe('307');
    expect(actual.boarding.busName).toBe('309');
    expect(forecastPickupSelection(missing, now)).toEqual(actual);
  });

  it('keeps a later pickup by the same bus distinct from its approaching visit', () => {
    const selected = pick([first, target, later, laterTarget], 200)!;
    expect(selected.match).toBe(first);
    expect(selected.boardable).toBe(later);
    const actual = forecastPickupSelection(selected, now)!;
    expect(actual.relation).toBe('same-bus-later-visit');
    expect(actual.countdown).toMatchObject({ busName: '307', stopsAhead: 1, etaSec: 20 });
    expect(actual.boarding).toMatchObject({ busName: '307', stopsAhead: 30, etaSec: 1200 });
    const missing = pick([first, later], 200)!;
    expect(journeyArrival(missing.boardable, [first, later], 121, 200, 60, now)).toBeUndefined();
    expect(forecastPickupSelection(missing, now)).toEqual(actual);
  });

  it('projects the actual folded-route selection when missing destinations change it', () => {
    const incoming = row('307', 48, 1, 20), returning = row('307', 48, 6, 150), destination = row('307', 121, 9, 500);
    const complete = pick([incoming, returning, destination], 0)!;
    const missing = pick([incoming, returning], 0)!;
    expect(complete.match).toBe(returning);
    expect(missing.match).toBe(incoming);
    expect(forecastPickupSelection(complete, now)?.boarding).toMatchObject({ stopsAhead: 6 });
    expect(forecastPickupSelection(missing, now)?.boarding).toMatchObject({ stopsAhead: 1 });
  });
});

describe('within-snapshot pickup occurrence identity', () => {
  it('normalizes bus spelling and does not use ETA equality or object identity as visit identity', () => {
    const clone = { ...first, busName: '307', eta: 999 };
    expect(forecastPickupSelection({ match: first, boardable: clone, departed: false }, now)?.relation).toBe('same-visit');
    expect(forecastPickupSelection({ match: first, boardable: { ...first, stopsAhead: 30 }, departed: false }, now)?.relation).toBe('same-bus-later-visit');
    expect(forecastPickupSelection({ match: first, boardable: { ...first, busName: '309' }, departed: false }, now)?.relation).toBe('different-bus');
  });

  it('copies forecast timing evidence without repricing or mutating either selected row', () => {
    const match = Object.freeze({ ...first }), boardable = Object.freeze({ ...other });
    const actual = forecastPickupSelection({ match, boardable, departed: false }, now)!;
    expect(actual.selectedAtMs).toBe(now);
    expect(actual.countdown).toEqual({ source: 'forecast', busName: '307', stopId: 48, stopsAhead: 1,
      etaSec: 20, lowSec: 0, highSec: 100 });
    expect(actual.boarding).toEqual({ source: 'forecast', busName: '309', stopId: 48, stopsAhead: 3,
      etaSec: 300, lowSec: 280, highSec: 380 });
    expect(match).toEqual(first);
    expect(boardable).toEqual(other);
  });

  it('does not remember another option or an earlier poll', () => {
    const selected = pick([first, other, target, otherTarget], 100)!;
    const original = forecastPickupSelection(selected, now)!;
    const raw = rawPickupSelection('#316', 11, now + 5000);
    const next = forecastPickupSelection({ match: { ...first, stopsAhead: 0 }, boardable: other, departed: false }, now + 10000)!;
    expect(original.countdown).toMatchObject({ stopsAhead: 1 });
    expect(original.selectedAtMs).toBe(now);
    expect(raw.boarding).toEqual({ source: 'raw-at-stop', busName: '316', stopId: 11 });
    expect(next.countdown).toMatchObject({ stopsAhead: 0 });
    expect(forecastPickupSelection(selected, now)).toEqual(original);
  });
});

describe('unavailable and raw pickup boundaries', () => {
  it('returns no metadata for a missing or departed selection', () => {
    expect(forecastPickupSelection(null, now)).toBeUndefined();
    const departed = pick([first, target], 1000)!;
    expect(departed.departed).toBe(true);
    expect(forecastPickupSelection(departed, now)).toBeUndefined();
  });

  it('retains the existing pinned walking tolerance without claiming strict catchability', () => {
    const selected = pick([first, target], 129)!;
    expect(129).toBeGreaterThan(first.eta + 60);
    expect(selected.departed).toBe(false);
    expect(selected.boardable).toBe(first);
    expect(forecastPickupSelection(selected, now)?.relation).toBe('same-visit');
  });

  it('keeps raw current evidence raw when the only modeled pickup is next lap', () => {
    const visits = [target, later, laterTarget];
    const board = atStopJourneyBoard(visits, 'Red', '#307', 48, 121);
    expect(board).toBeUndefined();
    expect(journeyArrival(board, visits, 121, 0, 0, now)).toBeUndefined();
    expect(rawPickupSelection('#307', 48, now)).toEqual({ selectedAtMs: now,
      countdown: { source: 'raw-at-stop', busName: '307', stopId: 48 },
      boarding: { source: 'raw-at-stop', busName: '307', stopId: 48 }, relation: 'raw-current' });
  });
});
