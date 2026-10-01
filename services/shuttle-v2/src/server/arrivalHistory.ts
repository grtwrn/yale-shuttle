/** Bounded, cached public fleet evidence. No rider identifiers are selected. */
import type Database from 'better-sqlite3';
import { ROUTE_LISTS } from '../../web/src/routes.js';

export interface ObservedArrival { arrivedAt: number; busName: string }
export interface MatchedArrival extends ObservedArrival { predictedAt: number; predictedSec: number; actualSec: number }
export interface ArrivalHistory {
  asOf: number;
  days: number;
  forecastLowSec: number;
  forecastHighSec: number;
  trips: MatchedArrival[];
  recent: ObservedArrival[];
}
const DAY = 86_400_000;
const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
function period(t: number) {
  const parts = clock.formatToParts(t);
  return { minute: Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value),
    weekend: ['Sat', 'Sun'].includes(parts.find(p => p.type === 'weekday')?.value ?? '') };
}

export function createArrivalHistory(db: Database.Database) {
  const byRoute = new Map<string, Database.Statement>();
  const prediction = db.prepare(`SELECT predicted_at AS predictedAt, predicted_sec AS predictedSec
    FROM predictions_log WHERE bus_id = ? AND to_stop_id = ? AND route_id = ?
      AND predicted_at >= ? AND predicted_at <= ? AND stops_ahead > 0
      AND ltrim(bus_name, '#') = ltrim(?, '#') AND surface IN ('trip', 'ride', 'card') AND predicted_sec BETWEEN ? AND ?
    ORDER BY ABS(predicted_sec - ?), predicted_at DESC LIMIT 1`);
  const cache = new Map<string, ArrivalHistory>();
  return (label: string, stopId: number, etaSec: number, now: number): ArrivalHistory | null => {
    const cfg = ROUTE_LISTS.find(c => c.label === label);
    if (!cfg || !Number.isInteger(stopId) || stopId < 1 || !Number.isFinite(etaSec) || etaSec < 0 || etaSec > 14_400) return null;
    const promised = Math.round(etaSec / 60) * 60;
    const key = `${label}|${stopId}|${promised}`;
    const old = cache.get(key);
    if (old && now >= old.asOf && now - old.asOf < 60_000) return old;
    let query = byRoute.get(label);
    if (!query) {
      query = db.prepare(`SELECT bus_id AS busId, bus_name AS busName, route_id AS routeId,
          arrived_at AS arrivedAt, departed_at AS departedAt
        FROM stop_visits WHERE route_id IN (${cfg.busRouteIds.map(() => '?').join(',')}) AND stop_id = ?
          AND anchored_at >= ? AND anchored_at <= ? AND arrived_at IS NOT NULL AND arrived_at <= ?
          AND outcome = 'stopped' AND closest_m <= 75
        ORDER BY anchored_at DESC LIMIT 240`);
      byRoute.set(label, query);
    }
    const visits = query.all(...cfg.busRouteIds, stopId, now - 30 * DAY, now, now) as
      Array<ObservedArrival & { busId: number; routeId: number; departedAt: number | null }>;
    visits.sort((a, b) => b.arrivedAt - a.arrivedAt);
    const reference = Math.min(1800, Math.max(30, promised));
    const tolerance = Math.max(60, reference * 0.25);
    const low = Math.max(30, reference - tolerance), high = Math.min(1800, reference + tolerance);
    const out: ArrivalHistory = { asOf: now, days: 30, forecastLowSec: low, forecastHighSec: high, trips: [], recent: [] };
    const seen = new Set<string>();
    const currentPeriod = period(now);
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i]!;
      const identity = `${v.routeId}|${v.busName}|${v.arrivedAt}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (out.recent.length < 3) out.recent.push({ arrivedAt: v.arrivedAt, busName: v.busName });
      if (out.trips.length >= 24 || promised < 30 || promised > 1800) continue;
      // Never pair a reading from the previous visit with this visit. In
      // particular, a forecast issued during a layover is not a future wait.
      const previous = visits.slice(i + 1).find(p => p.busName === v.busName && p.routeId === v.routeId);
      const from = Math.max(v.arrivedAt - 45 * 60_000, previous ? (previous.departedAt ?? previous.arrivedAt) + 1 : 0);
      const p = prediction.get(v.busId, stopId, v.routeId, from, v.arrivedAt - 15_000, v.busName, low, high, promised) as
        { predictedAt: number; predictedSec: number } | undefined;
      if (!p) continue;
      const then = period(p.predictedAt);
      const distance = Math.abs(then.minute - currentPeriod.minute);
      if (then.weekend !== currentPeriod.weekend || Math.min(distance, 1440 - distance) > 120) continue;
      out.trips.push({ arrivedAt: v.arrivedAt, busName: v.busName, ...p, actualSec: (v.arrivedAt - p.predictedAt) / 1000 });
    }
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, out);
    return out;
  };
}
