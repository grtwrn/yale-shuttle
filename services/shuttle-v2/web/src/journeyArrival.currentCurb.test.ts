import { describe, expect, it } from 'vitest';
import type { UpcomingArrival } from './arrivals';
import { attachServerEta, ETA_MAX_AGE_MS, serverArrivals, type ServerEtaWire } from './etaSource';
import { atStopJourneyBoard, journeyArrival } from './journeyArrival';
import type { BusData } from './map-data';
import { rawAtStopBoardable, type RawAtStopContext } from './planner';

const now = 1793494091681;
// Tiny constructed fixture: retain seq1778's #50/route17, source clocks,
// standing index/travel=2, and four target rows. Original bus index4 is remapped
// to0. Unrelated canonical slots below are synthetic; this is no route survey.
const stops = [900, 901, 157, 165, 904, 905, 906, 907, 908, 909, 910, 911];
const rawBus = (): BusData => ({ bus_id: 68491, bus_name: '#50', route_id: 17,
  lat: 41.307414, lon: -72.92222, heading: 114, last_stop_id: 157,
  observed_at: 1793494091642, stationary: true, at_stop_id: 157,
  at_stop_since: '2026-11-01T00:47:41.564' });
const source = (): ServerEtaWire => ({ v: 2, at: now, servedAt: now,
  buses: [['50', 'Orange East', 2, { approach: false, standingSec: 30.117, stopId: 157 }]],
  travel: [2], rows: [
    [0, 165, 292, 167, 656, 1, 0, 292, 167],
    [0, 157, 2279, 0, 2873, 12, 0, 2279, 0],
    [0, 165, 2659, 2079, 3282, 13, 0, 2659, 2079],
    [0, 157, 4552, 1980, 5757, 24, 0, 4552, 1980],
  ], repeatVisits: [[0, 165, 13], [0, 157, 24]] });

function fixture(wire = source(), bus = rawBus()) {
  const buses = [bus];
  const attached = attachServerEta(buses, wire, now);
  const visits = serverArrivals(buses, [157, 165], now)!;
  const context: RawAtStopContext = { bus, routeLabel: 'Orange East', stops, now };
  return { wire, bus, buses, attached, visits, context };
}
const board = (visits: readonly UpcomingArrival[], context?: RawAtStopContext) =>
  atStopJourneyBoard(visits, 'Orange East', '#50', 157, 165, context);

describe('observed current curb joins only its existing forward destination', () => {
  it('retains the seq1778-shaped destination when only the current pickup row is omitted', () => {
    const f = fixture();
    const originalWire = JSON.stringify(f.wire), originalVisits = JSON.stringify(f.visits);
    expect(f.attached).toBe(true);
    expect(rawAtStopBoardable('#50', 157, 165, f.visits, f.context)).toBe(true);
    expect(board(f.visits)).toBeUndefined();
    const pickup = board(f.visits, f.context)!;
    expect(pickup).toEqual({ busName: '50', routeLabel: 'Orange East', color: '#E8836A',
      stopId: 157, stopsAhead: 0, eta: 0, low: 0, high: 0,
      departNow: 0, lowFloor: 0, estimated: false });
    expect(journeyArrival(pickup, f.visits, 165, 0, 0, now, 'at-stop')).toEqual({
      busName: '50', pointMs: now + 292_000, lowMs: now + 167_000,
      highMs: now + 656_000, catchRisk: false, estimated: false,
    });
    expect(JSON.stringify(f.wire)).toBe(originalWire);
    expect(JSON.stringify(f.visits)).toBe(originalVisits);
  });

  it('uses destination uncertainty and the final walk without copying it onto the observed board', () => {
    const wire = source();
    const dots = Array.from({ length: 50 }, (_, i) => 167 + i * 10);
    wire.distributions = [dots, [], [], []]; // Explicit synthetic chart control.
    const f = fixture(wire), pickup = board(f.visits, f.context)!;
    expect(pickup.distribution).toBeUndefined();
    const result = journeyArrival(pickup, f.visits, 165, 1, 30, now, 'at-stop')!;
    expect(result.pointMs).toBe(now + 322_000);
    expect(result.distributionMs).toEqual(dots.map(s => now + (s + 30) * 1000));
    expect(result.catchRisk).toBe(true);
  });

  it('keeps the existing current-row and preceding-forecast behavior even without context', () => {
    const f = fixture(), onward = f.visits[0]!;
    const current: UpcomingArrival = { ...onward, stopId: 157, stopsAhead: 0,
      eta: 0, low: 0, high: 0, departNow: 0, lowFloor: 0 };
    expect(board([current, ...f.visits])).toBe(current);
    const lagged = { ...current, eta: 20, low: 0, high: 40 };
    expect(board([lagged, ...f.visits])).toBe(lagged);
    // Context is consulted only for the new missing-pickup join.
    expect(board([current, ...f.visits], { ...f.context, now: NaN })).toBe(current);
  });

  it.each([undefined, NaN, Infinity, now + 1, now - ETA_MAX_AGE_MS])(
    'requires a finite, nonfuture raw observation younger than the source TTL (%s)', observed_at => {
      const bus = rawBus();
      if (observed_at === undefined) delete bus.observed_at;
      else bus.observed_at = observed_at;
      const f = fixture(source(), bus);
      expect(board(f.visits, f.context)).toBeUndefined();
    });

  it('accepts the last fresh raw millisecond but not stale source metadata', () => {
    const f = fixture(source(), { ...rawBus(), observed_at: now - ETA_MAX_AGE_MS + 1 });
    expect(board(f.visits, f.context)).toBeDefined();
    // Keep GPS fresh so only the attached server track expires.
    f.bus.observed_at = now + ETA_MAX_AGE_MS;
    expect(board(f.visits, { ...f.context, now: now + ETA_MAX_AGE_MS })).toBeUndefined();
    expect(board(f.visits, { ...f.context, bus: { ...f.bus }, now: now + ETA_MAX_AGE_MS })).toBeUndefined();
    const invalid = fixture({ ...source(), v: 1 } as unknown as ServerEtaWire);
    expect(board(f.visits, invalid.context)).toBeUndefined();
  });

  it('rejects route, bus, raw curb, motion, and consumer clock mismatches', () => {
    const f = fixture();
    for (const context of [
      { ...f.context, routeLabel: 'Red' },
      { ...f.context, now: NaN },
    ]) expect(board(f.visits, context)).toBeUndefined();
    // Mutate the already tracked object, so failure is not just an absent
    // WeakMap entry on a cloned bus.
    f.bus.bus_name = '#51';
    expect(board(f.visits, f.context)).toBeUndefined();
    f.bus.bus_name = '#50'; f.bus.at_stop_id = 165;
    expect(board(f.visits, f.context)).toBeUndefined();
    f.bus.at_stop_id = 157; f.bus.stationary = false;
    expect(board(f.visits, f.context)).toBeUndefined();
    f.bus.stationary = true;
    expect(board(f.visits, f.context)).toBeDefined();
    expect(atStopJourneyBoard(f.visits, 'Red', '#50', 157, 165, f.context)).toBeUndefined();
    expect(atStopJourneyBoard(f.visits, 'Orange East', '#51', 157, 165, f.context)).toBeUndefined();
  });

  it('requires a fresh nonapproaching canonical stand with identical published and travel slots', () => {
    for (const [index, travel, standing] of [
      [2, 2, null],
      [2, 2, { stopId: 157, standingSec: 30, approach: true }],
      [2, 2, { stopId: 165, standingSec: 30, approach: false }],
      [2, 3, { stopId: 157, standingSec: 30, approach: false }],
      [3, 3, { stopId: 157, standingSec: 30, approach: false }],
      [-1, -1, { stopId: 157, standingSec: 30, approach: false }],
      [12, 12, { stopId: 157, standingSec: 30, approach: false }],
    ] satisfies [number, number, ServerEtaWire['buses'][number][3]][]) {
      const wire = source();
      wire.buses = [['50', 'Orange East', index, standing]]; wire.travel = [travel];
      const f = fixture(wire);
      expect(board(f.visits, f.context)).toBeUndefined();
    }
  });

  it('withholds the new join on repeated, wrong, or absent canonical curbs', () => {
    const f = fixture();
    for (const canonical of [
      stops.map((id, i) => i === 8 ? 157 : id),
      stops.map((id, i) => i === 2 ? 999 : id),
      stops.map((id, i) => i === 3 ? 999 : id),
      [],
    ]) expect(board(f.visits, { ...f.context, stops: canonical })).toBeUndefined();
  });

  it('does not join a previous, fractional, full-lap, or later-lap destination', () => {
    const f = fixture(), destination = f.visits[0]!;
    for (const hops of [-1, 0, 0.5, stops.length, stops.length + 1]) {
      // Malformed hop controls are caller data; no invalid wire is repaired.
      expect(board([{ ...destination, stopsAhead: hops }], f.context)).toBeUndefined();
    }
    expect(board(f.visits.filter(a => a.stopId === 157), f.context)).toBeUndefined();
    expect(board(f.visits.filter(a => a.stopId === 165 && a.stopsAhead > 1), f.context)).toBeUndefined();
    const wrongWay = { ...destination, stopsAhead: 2 };
    expect(board([wrongWay], f.context)).toBeUndefined();
    const conflictingPickup = { ...destination, stopId: 157 };
    expect(board([destination, conflictingPickup], f.context)).toBeUndefined();
  });

  it('keeps invalid or too-early destination times unavailable instead of constructing an ETA', () => {
    const f = fixture(), destination = f.visits[0]!;
    for (const patch of [{ eta: NaN }, { high: NaN }, { low: 700, high: 600 }, { eta: 0 }]) {
      const visits = [{ ...destination, ...patch }];
      expect(journeyArrival(board(visits, f.context), visits, 165, 1, 0, now, 'at-stop')).toBeUndefined();
    }
  });
});
