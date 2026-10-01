import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createArrivalHistory } from './arrivalHistory.js';
import { ROUTE_LISTS } from '../../web/src/routes.js';
let db: Database.Database;
const rid = ROUTE_LISTS.find(c => c.label === 'Red')!.busRouteIds[0]!;
const now = Date.parse('2026-09-16T18:00:00Z');
const arrived = Date.parse('2026-09-15T18:00:00Z');
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE stop_visits(bus_id INTEGER,bus_name TEXT,route_id INTEGER,stop_id INTEGER,
    anchored_at INTEGER,arrived_at INTEGER,departed_at INTEGER,outcome TEXT,closest_m REAL);
    CREATE INDEX visits_idx ON stop_visits(route_id,stop_id,anchored_at);
    CREATE TABLE predictions_log(bus_id INTEGER,bus_name TEXT,route_id INTEGER,to_stop_id INTEGER,
      predicted_at INTEGER,predicted_sec REAL,stops_ahead INTEGER,surface TEXT);
    CREATE INDEX pred_idx ON predictions_log(bus_id,to_stop_id,predicted_at);`);
});
afterEach(() => db.close());
function visit(at = arrived, over: Record<string, unknown> = {}) {
  const v = { bus_id: 1, bus_name: '#308', route_id: rid, stop_id: 48, anchored_at: at,
    arrived_at: at, departed_at: at + 30_000, outcome: 'stopped', closest_m: 20, ...over };
  db.prepare(`INSERT INTO stop_visits (${Object.keys(v).join(',')}) VALUES (${Object.keys(v).map(() => '?')})`).run(...Object.values(v));
}
function reading(at = arrived - 360_000, over: Record<string, unknown> = {}) {
  const p = { bus_id: 1, bus_name: '308', route_id: rid, to_stop_id: 48,
    predicted_at: at, predicted_sec: 300, stops_ahead: 2, surface: 'trip', ...over };
  db.prepare(`INSERT INTO predictions_log (${Object.keys(p).join(',')}) VALUES (${Object.keys(p).map(() => '?')})`).run(...Object.values(p));
}
it('pairs a real arrival to our similar forecast, once per visit', () => {
  visit(); reading(); reading(arrived - 300_000, { predicted_sec: 330, surface: 'ride' });
  const out = createArrivalHistory(db)('Red', 48, 300, now)!;
  expect(out.trips).toEqual([{ arrivedAt: arrived, busName: '#308', predictedAt: arrived - 360_000, predictedSec: 300, actualSec: 360 }]);
  expect(out.recent).toHaveLength(1);
});
it.each([{ surface: 'upstream' }, { bus_name: '999' }, { stops_ahead: 0 }, { predicted_sec: 1200 }])('does not turn unrelated or non-forecast readings into history (%j)', over => {
  visit(); reading(undefined, over);
  const out = createArrivalHistory(db)('Red', 48, 300, now)!;
  expect(out.trips).toHaveLength(0);
  expect(out.recent).toHaveLength(1);
});
it.each([{ outcome: 'unresolved' }, { outcome: 'passed' }, { closest_m: 140 }, { arrived_at: now + 1000 }])('excludes weak or future arrival evidence (%j)', over => {
  visit(undefined, over); reading();
  expect(createArrivalHistory(db)('Red', 48, 300, now)!.recent).toHaveLength(0);
});
it('does not pair a forecast from a previous stop visit to this lap', () => {
  visit(arrived - 400_000, { departed_at: arrived - 250_000 });
  visit(); reading();
  expect(createArrivalHistory(db)('Red', 48, 300, now)!.trips).toHaveLength(0);
});
it('matches the weekday and local time category and rejects old history', () => {
  for (const at of ['2026-09-12T18:00:00Z', '2026-09-15T10:00:00Z', '2026-08-01T18:00:00Z']) {
    const t = Date.parse(at); visit(t); reading(t - 300_000);
  }
  const out = createArrivalHistory(db)('Red', 48, 300, now)!;
  expect(out.trips).toHaveLength(0);
  expect(out.recent).toHaveLength(2);
});
it('caches reads briefly and invalidates on time or changed forecast bucket', () => {
  visit(); const read = createArrivalHistory(db);
  const first = read('Red', 48, 300, now)!;
  reading();
  expect(read('Red', 48, 300, now + 1000)).toBe(first);
  expect(read('Red', 48, 300, now + 60_000)!.trips).toHaveLength(1);
});
it('bounds inputs and preserves recent facts when the forecast is beyond matching range', () => {
  visit(); reading(); const read = createArrivalHistory(db);
  expect(read('fake', 48, 300, now)).toBeNull();
  expect(read('Red', NaN, 300, now)).toBeNull();
  expect(read('Red', 48, Infinity, now)).toBeNull();
  const far = read('Red', 48, 3600, now)!;
  expect(far.trips).toHaveLength(0);
  expect(far.recent).toHaveLength(1);
  expect(far.forecastHighSec).toBeGreaterThan(far.forecastLowSec);
});

it('uses minutes for the two-hour matching boundary, including across midnight', () => {
  const at = Date.parse('2026-09-15T20:06:00Z');
  visit(at); reading(at - 300_000);
  const read = createArrivalHistory(db);
  expect(read('Red', 48, 300, now)!.trips).toHaveLength(0); // 16:01 versus 14:00 ET
  expect(read('Red', 48, 300, now + 60_000)!.trips).toHaveLength(1);
  db.exec('DELETE FROM stop_visits; DELETE FROM predictions_log');
  const night = Date.parse('2026-09-15T03:50:00Z');
  visit(night); reading(night - 300_000);
  expect(read('Red', 48, 300, Date.parse('2026-09-16T04:15:00Z'))!.trips).toHaveLength(1);
});
