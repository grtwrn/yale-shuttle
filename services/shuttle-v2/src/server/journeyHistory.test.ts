import Database from 'better-sqlite3';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { createJourneyHistory, journeyOrigin } from './journeyHistory.js';
import { TransitNetwork } from '../network/TransitNetwork.js';
import type { ServerEta } from './serverEta.js';

let db: Database.Database;
const now = Date.parse('2026-09-16T14:27:00Z');
const start = Date.parse('2026-09-15T14:20:00Z');
const seq = [11, 146, 49, 48];
const network = TransitNetwork.build(seq.map((id, i) => ({ id, name: `Stop ${id}`, lat: 41.3 + i * .001, lon: -72.9 })),
  [{ id: 3, name: 'Red', shortName: 'Red', color: '#f00', stops: seq }]);
function position(): NonNullable<ReturnType<ServerEta['historyPosition']>> {
  return { bus: { bus_id: 999, bus_name: '#308', route_id: 3, last_stop_id: 11, lat: 41.3, lon: -72.9, heading: 0,
    at_stop_id: 11, at_stop_since: new Date(now - 60_000).toISOString().slice(0, -1), last_moved_at: new Date(now - 20_000).toISOString(), stationary: true },
    sequence: seq, index: 0, standing: { stopId: 11, standingSec: 60, approach: false }, stopsAhead: 3 };
}
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE stop_visits (bus_name TEXT,route_id INTEGER,stop_id INTEGER,stop_index INTEGER,
    anchored_at INTEGER,pinned_at INTEGER,arrived_at INTEGER,departed_at INTEGER,outcome TEXT,how TEXT,closest_m REAL);
    CREATE INDEX stop_visits_route_stop_time_idx ON stop_visits(route_id,stop_id,anchored_at);
    CREATE TABLE legs(bus_name TEXT,route_id INTEGER,from_stop_id INTEGER,to_stop_id INTEGER,from_index INTEGER,to_index INTEGER,
    departed_at INTEGER,arrived_at INTEGER,hops INTEGER,reached INTEGER);
    CREATE INDEX legs_time_idx ON legs(departed_at);`);
});
afterEach(() => db.close());
function visit(index: number, at: number, departed: number, extra: Record<string, unknown> = {}) {
  const v = { bus_name: '#309', route_id: 3, stop_id: seq[index], stop_index: index, anchored_at: at, pinned_at: at,
    arrived_at: at, departed_at: departed, outcome: 'stopped', how: 'far', closest_m: 10, ...extra };
  db.prepare(`INSERT INTO stop_visits (${Object.keys(v).join(',')}) VALUES (${Object.keys(v).map(() => '?')})`).run(...Object.values(v));
}
function leg(index: number, at: number, arrived: number) {
  db.prepare('INSERT INTO legs VALUES (?,?,?,?,?,?,?,?,?,?)').run('#309', 3, seq[index], seq[index + 1], index, index + 1, at, arrived, 1, 1);
}
function trip(at = start, stand = 300_000) {
  const dep = at + stand;
  visit(0, at, dep);
  leg(0, dep, dep + 20_000);
  visit(1, dep + 20_000, dep + 20_000, { outcome: 'passed', arrived_at: null });
  leg(1, dep + 20_000, dep + 40_000);
  visit(2, dep + 40_000, dep + 65_000);
  leg(2, dep + 65_000, dep + 90_000);
  visit(3, dep + 90_000, dep + 110_000);
}
const read = (p = position(), t = now) => createJourneyHistory(db)('Red', 48, p, network, t)!;
it('measures remaining stop wait plus a connected journey, with no prediction-log dependency', () => {
  trip();
  expect(read().journey).toMatchObject({ mode: 'standing', elapsedSec: 60, fromStopId: 11, toStopId: 48, serviceDates: 1,
    trips: [{ busName: '#309', startedAt: start + 60_000, departedAt: start + 300_000, arrivedAt: start + 390_000, actualSec: 330 }] });
});
it('shows departure-to-arrival context for a moving bus without prorating observed times', () => {
  trip(); const p = position(); p.standing = null;
  const j = read(p).journey!;
  expect(j.mode).toBe('departure'); expect(j.elapsedSec).toBeNull(); expect(j.trips[0]!.actualSec).toBe(90);
});
it('conditions on the bus still waiting at the matched elapsed time', () => {
  trip(start, 40_000);
  expect(read().journey!.trips).toHaveLength(0);
  expect(read().recent).toHaveLength(1);
});
it.each([
  'DELETE FROM legs WHERE from_index = 1',
  "UPDATE stop_visits SET how = 'gap' WHERE stop_index = 2",
  'UPDATE legs SET departed_at = departed_at + 1000 WHERE from_index = 1',
  "UPDATE legs SET bus_name = '#999' WHERE from_index = 1",
  'UPDATE legs SET to_index = 0 WHERE from_index = 1',
  'UPDATE stop_visits SET stop_index = 1 WHERE stop_id = 11',
  'UPDATE legs SET reached = 0 WHERE from_index = 1',
  'UPDATE stop_visits SET closest_m = 100 WHERE stop_index = 3',
])('cannot bridge missing, wrong-occurrence or weak evidence: %s', sql => {
  trip(); db.exec(sql); expect(read().journey!.trips).toHaveLength(0);
});
it('requires completed journeys, matching local time and service-day category', () => {
  trip(now + 1000); trip(start - 6 * 3_600_000); trip(Date.parse('2026-09-12T14:20:00Z'));
  expect(read().journey!.trips).toHaveLength(0);
});
it('fails closed on ambiguous repeated sources, approach rests and subsequent laps', () => {
  const p = position();
  expect(journeyOrigin({ ...p, standing: { ...p.standing!, approach: true } }, seq, 48, now)).toBeNull();
  expect(journeyOrigin({ ...p, sequence: [11, 49, 48], stopsAhead: 2 }, [11, 146, 11, 49, 48], 48, now)).toBeNull();
  expect(journeyOrigin({ ...p, stopsAhead: 7 }, seq, 48, now)).toBeNull();
  expect(journeyOrigin({ ...p, sequence: [11, 48, 49, 48], stopsAhead: 3 }, [11, 48, 49, 48], 48, now)).toBeNull();
  expect(journeyOrigin({ ...p, bus: { ...p.bus, last_moved_at: new Date(now - 1000).toISOString() } }, seq, 48, now)).toBeNull();
});
it('preserves a known repeated source occurrence when the sequences agree', () => {
  const p = { ...position(), sequence: [11, 146, 11, 48], index: 2, stopsAhead: 1 };
  expect(journeyOrigin(p, p.sequence, 48, now)).toMatchObject({ fromIndex: 2, toIndex: 3 });
});
it('returns recent fleet facts when the live origin is unavailable and rejects bad inputs', () => {
  trip(); const history = createJourneyHistory(db);
  expect(history('Red', 48, null, network, now)).toMatchObject({ journey: null, recent: [{ busName: '#309', arrivedAt: start + 390_000 }] });
  expect(history('fake', 48, null, network, now)).toBeNull();
  expect(history('Red', NaN, null, network, now)).toBeNull();
});
it('bounds results and caches only the same source state and elapsed-wait bucket', () => {
  for (let i = 0; i < 105; i++) trip(start - i * 1000);
  const history = createJourneyHistory(db), p = position();
  const result = history('Red', 48, p, network, now)!;
  expect(result.journey!.trips).toHaveLength(24);
  const larger = history('Red', 48, p, network, now, 100)!;
  expect(larger.journey!.trips).toHaveLength(100);
  expect(larger).not.toBe(result);
  expect(history('Red', 48, p, network, now + 1000, 100)).toBe(larger);
  for (const limit of [0, 101, 1.5, NaN]) expect(history('Red', 48, p, network, now, limit)).toBeNull();
  expect(history('Red', 48, p, network, now + 1000)).toBe(result);
  const later = history('Red', 48, p, network, now + 5000)!;
  expect(later).not.toBe(result);
  expect(later.journey!.elapsedSec).toBe(65);
});
