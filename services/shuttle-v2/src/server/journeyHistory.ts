/** Observed fleet journeys. No ETA values or rider reports select the sample. */
import type Database from 'better-sqlite3';
import type { TransitNetwork } from '../network/TransitNetwork.js';
import type { ServerEta } from './serverEta.js';
import { ROUTE_LISTS } from '../../web/src/routes.js';

type Position = NonNullable<ReturnType<ServerEta['historyPosition']>>;
export interface RecordedJourney {
  busName: string;
  startedAt: number;
  departedAt: number;
  arrivedAt: number;
  actualSec: number;
}
export interface JourneyHistory {
  asOf: number;
  days: number;
  journey: null | {
    fromStopId: number; fromName: string; toStopId: number; toName: string;
    mode: 'standing' | 'departure'; elapsedSec: number | null;
    trips: RecordedJourney[]; serviceDates: number;
  };
  recent: Array<{ busName: string; arrivedAt: number }>;
}
type Visit = { busName: string; stopIndex: number; anchoredAt: number; pinnedAt: number | null;
  arrivedAt: number | null; departedAt: number | null; outcome: string; how: string | null; closestM: number };
type Leg = { fromStopId: number; toStopId: number; fromIndex: number; toIndex: number;
  departedAt: number; arrivedAt: number; hops: number };
const DAY = 86_400_000;
const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function period(at: number) {
  const p = clock.formatToParts(at);
  return { minute: Number(p.find(x => x.type === 'hour')?.value) * 60 + Number(p.find(x => x.type === 'minute')?.value),
    weekend: ['Sat', 'Sun'].includes(p.find(x => x.type === 'weekday')?.value ?? '') };
}
const utc = (s: string | undefined) => s ? Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z') : NaN;

/** Translate the forecast occurrence to the detector's route order. Ambiguous
 * repeats, later laps and contradictory rest states have no comparison. */
export function journeyOrigin(p: Position, seq: readonly number[], target: number, now: number) {
  const from = p.sequence[p.index];
  if (from === undefined || p.stopsAhead < 1 || p.stopsAhead >= p.sequence.length || seq.length < 2
    || p.sequence[(p.index + p.stopsAhead) % p.sequence.length] !== target) return null;
  const candidates = seq.flatMap((id, i) => id === from ? [i] : []);
  const sameOrder = seq.length === p.sequence.length && seq.every((id, i) => id === p.sequence[i]);
  const fromIndex = sameOrder ? p.index : candidates.length === 1 ? candidates[0]! : -1;
  if (fromIndex < 0) return null;
  let toIndex = -1;
  for (let hop = 1; hop < seq.length; hop++) {
    const i = (fromIndex + hop) % seq.length;
    if (seq[i] === target) { toIndex = i; break; }
  }
  if (toIndex < 0) return null;
  // A second pass of the target is a different journey. Only the next pass
  // can be matched with the connected historical paths below.
  for (let hop = 1; hop < p.stopsAhead; hop++) if (p.sequence[(p.index + hop) % p.sequence.length] === target) return null;
  const pin = utc(p.bus.at_stop_since);
  const moved = utc(p.bus.last_moved_at);
  const standing = p.standing !== null;
  // A near-stop/approach rest is not on the historical pinned clock. Do not
  // present departure-only durations for such a bus as if it were moving.
  if (standing && (p.standing!.approach || p.standing!.stopId !== from || p.bus.at_stop_id !== from
    || !Number.isFinite(pin) || pin > now || !Number.isFinite(moved) || now - moved < 10_000)) return null;
  const elapsedSec = standing ? Math.floor((now - pin) / 5000) * 5 : null;
  return { fromIndex, toIndex, fromStopId: from, mode: standing ? 'standing' as const : 'departure' as const, elapsedSec };
}

const VISIT_COLUMNS = `bus_name AS busName, stop_index AS stopIndex, anchored_at AS anchoredAt,
  pinned_at AS pinnedAt, arrived_at AS arrivedAt, departed_at AS departedAt,
  outcome, how, closest_m AS closestM`;

export function createJourneyHistory(db: Database.Database) {
  const sources = db.prepare(`SELECT ${VISIT_COLUMNS} FROM stop_visits
    WHERE route_id = ? AND stop_id = ? AND stop_index = ? AND anchored_at BETWEEN ? AND ?
      AND departed_at IS NOT NULL AND departed_at <= ? AND how != 'gap'
      AND outcome = 'stopped' AND closest_m <= 75 ORDER BY anchored_at DESC LIMIT 240`);
  // Exact departure time uses the existing time-leading index: at most a
  // fleet poll, rather than a scan of a month's legs for each path step.
  const legs = db.prepare(`SELECT from_stop_id AS fromStopId, to_stop_id AS toStopId,
    from_index AS fromIndex, to_index AS toIndex, departed_at AS departedAt, arrived_at AS arrivedAt, hops
    FROM legs INDEXED BY legs_time_idx WHERE departed_at = ? AND route_id = ? AND bus_name = ?
      AND from_index = ? AND reached = 1 AND arrived_at <= ? LIMIT 2`);
  const atArrival = db.prepare(`SELECT ${VISIT_COLUMNS} FROM stop_visits
    WHERE route_id = ? AND stop_id = ? AND stop_index = ? AND bus_name = ? AND anchored_at BETWEEN ? AND ?
      AND (arrived_at = ? OR (outcome = 'passed' AND departed_at = ?))
    ORDER BY anchored_at DESC LIMIT 2`);
  const recentQueries = new Map<string, Database.Statement>();
  const cache = new Map<string, JourneyHistory>();

  return (label: string, stopId: number, position: Position | null, network: Pick<TransitNetwork, 'routes' | 'stops'>, now: number, limit = 24): JourneyHistory | null => {
    const cfg = ROUTE_LISTS.find(c => c.label === label);
    if (!cfg || !Number.isInteger(stopId) || stopId < 1 || !Number.isFinite(now)
      || !Number.isInteger(limit) || limit < 1 || limit > 100) return null;
    const route = position && cfg.busRouteIds.includes(position.bus.route_id) ? network.routes.get(position.bus.route_id) : undefined;
    const seq = route?.stops ?? [];
    const origin = position && route ? journeyOrigin(position, seq, stopId, now) : null;
    const key = `${label}|${stopId}|${limit}|${route?.id}|${origin?.fromIndex}|${origin?.toIndex}|${origin?.mode}|${origin?.elapsedSec}|${seq.join(',')}|${Math.floor(now / 60_000)}`;
    const old = cache.get(key);
    if (old && now >= old.asOf && now - old.asOf < 60_000) return old;
    const out: JourneyHistory = { asOf: now, days: 30, journey: null, recent: [] };
    let recent = recentQueries.get(label);
    if (!recent) {
      recent = db.prepare(`SELECT bus_name AS busName, arrived_at AS arrivedAt FROM stop_visits
        WHERE route_id IN (${cfg.busRouteIds.map(() => '?').join(',')}) AND stop_id = ? AND anchored_at BETWEEN ? AND ?
        AND arrived_at <= ? AND outcome = 'stopped' AND closest_m <= 75 ORDER BY anchored_at DESC LIMIT 20`);
      recentQueries.set(label, recent);
    }
    const seenRecent = new Set<string>();
    for (const v of (recent.all(...cfg.busRouteIds, stopId, now - 30 * DAY, now, now) as JourneyHistory['recent']).sort((a, b) => b.arrivedAt - a.arrivedAt)) {
      const id = `${v.busName}|${v.arrivedAt}`;
      if (!seenRecent.has(id) && out.recent.length < 3) { out.recent.push(v); seenRecent.add(id); }
    }
    if (origin && route) {
      const journey: NonNullable<JourneyHistory['journey']> = out.journey = {
        fromStopId: origin.fromStopId, fromName: network.stops.get(origin.fromStopId)?.name ?? `Stop ${origin.fromStopId}`,
        toStopId: stopId, toName: network.stops.get(stopId)?.name ?? `Stop ${stopId}`,
        mode: origin.mode, elapsedSec: origin.elapsedSec, trips: [], serviceDates: 0,
      };
      const rows = sources.all(route.id, origin.fromStopId, origin.fromIndex, now - 30 * DAY, now, now) as Visit[];
      const reference = period(now), seen = new Set<string>();
      for (const source of rows) {
        if (journey.trips.length >= limit) break;
        const departed = source.departedAt!;
        const started = origin.mode === 'standing'
          ? source.pinnedAt === null ? NaN : source.pinnedAt + origin.elapsedSec! * 1000 : departed;
        // Survival conditioning includes only trips still stopped at the
        // matched elapsed time. Never prorate an observed moving leg.
        if (!Number.isFinite(started) || started > departed || (origin.mode === 'standing'
          && (started === departed || source.arrivedAt === null || started < source.arrivedAt))) continue;
        const then = period(started), distance = Math.abs(then.minute - reference.minute);
        if (then.weekend !== reference.weekend || Math.min(distance, 1440 - distance) > 120) continue;
        let index = origin.fromIndex, departure = departed;
        for (let count = 0; count < seq.length; count++) {
          const next = legs.all(departure, route.id, source.busName, index, now) as Leg[];
          if (next.length !== 1) break;
          const leg = next[0]!, remaining = (origin.toIndex - index + seq.length) % seq.length;
          if (leg.fromStopId !== seq[index] || leg.toStopId !== seq[leg.toIndex] || leg.arrivedAt <= departure
            || leg.hops < 1 || leg.hops > remaining || (leg.toIndex - index + seq.length) % seq.length !== leg.hops) break;
          const visits = atArrival.all(route.id, leg.toStopId, leg.toIndex, source.busName, source.anchoredAt, leg.arrivedAt,
            leg.arrivedAt, leg.arrivedAt) as Visit[];
          if (visits.length !== 1) break;
          const visit = visits[0]!;
          if (leg.toIndex === origin.toIndex) {
            const id = `${source.busName}|${leg.arrivedAt}`;
            if (visit.outcome === 'stopped' && visit.closestM <= 75 && !seen.has(id)) {
              seen.add(id);
              journey.trips.push({ busName: source.busName, startedAt: started, departedAt: departed,
                arrivedAt: leg.arrivedAt, actualSec: (leg.arrivedAt - started) / 1000 });
            }
            break;
          }
          // A missing/gap-ended visit cannot bridge two unrelated laps. Its
          // actual departure must be the next leg's exact start timestamp.
          if (visit.how === 'gap' || visit.departedAt === null || visit.departedAt < leg.arrivedAt || visit.departedAt > now) break;
          index = leg.toIndex; departure = visit.departedAt;
        }
      }
      journey.serviceDates = new Set(journey.trips.map(t => date.format(t.startedAt))).size;
    }
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, out);
    return out;
  };
}
