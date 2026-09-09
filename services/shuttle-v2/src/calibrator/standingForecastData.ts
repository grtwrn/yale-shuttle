import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AnalyticEpisode } from "./analytic/analytic.js";

export interface StandingRoutePattern { routeId: number; stopIds: number[] }
export const standingPatternId = (routeId: number, stops: readonly number[]): string =>
  `${routeId}:${createHash("sha256").update(JSON.stringify([stops])).digest("hex").slice(0, 24)}`;

const calendar = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
export function standingDayOf(ms: number): string {
  const parts = Object.fromEntries(calendar.formatToParts(ms).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function midnight(day: string): number {
  const utc = Date.parse(`${day}T00:00:00Z`), edt = utc + 4 * 3600_000;
  return standingDayOf(edt) === day ? edt : utc + 5 * 3600_000;
}
export function standingDayBounds(now: number): readonly [number, number] {
  const start = midnight(standingDayOf(now));
  return [start, midnight(standingDayOf(start + 26 * 3600_000))];
}
export function standingTrainingStart(cutoff: number): number {
  const previous = standingDayBounds(cutoff - 1)[0];
  return standingDayBounds(previous - 1)[0];
}

interface StoredVisit {
  id: number; bus_id: number; bus_name: string; route_id: number; stop_id: number; stop_index: number;
  anchored_at: number; pinned_at: number | null; departed_at: number | null; outcome: string;
  observed_known_at: number | null; pattern_id: string | null; stop_ids: string | null;
  identity_ambiguous: number | null;
  next_two_anchor_at: number | null;
}
export interface StandingTrainingDate { routeId: number; day: string; from: number; until: number }

const secondLaterAnchor = `(SELECT later.anchored_at FROM stop_visits later
  WHERE later.route_id=v.route_id AND later.bus_name=v.bus_name
    AND (later.anchored_at,later.id)>(v.anchored_at,v.id)
  ORDER BY later.anchored_at,later.id LIMIT 1 OFFSET 1)`;
function hasMetadata(sqlite: Database.Database): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='standing_forecast_observations'").get());
}

/** Last completed observed service dates per route, not the last calendar days.
 * A weekday route keeps its history across a weekend. No partial-day threshold. */
export function standingTrainingDates(sqlite: Database.Database, cutoff: number,
  lookbackDays: number, serviceDaysPerRoute: number, knownCutoff = cutoff): StandingTrainingDate[] {
  const metadata = hasMetadata(sqlite);
  const known = metadata ? "o.known_at" : "NULL";
  const stmt = sqlite.prepare(`SELECT DISTINCT v.route_id FROM stop_visits v
    ${metadata ? "LEFT JOIN standing_forecast_observations o ON o.visit_id=v.id" : ""}
    WHERE v.anchored_at>=? AND v.anchored_at<? AND v.outcome IN ('stopped','passed')
      AND v.departed_at>=v.anchored_at AND v.departed_at<=? ${metadata ? "AND COALESCE(o.identity_ambiguous,0)=0" : ""}
      AND ((${known} IS NOT NULL AND ${known}<=?) OR
        (${known} IS NULL AND ${secondLaterAnchor}<=?)) ORDER BY v.route_id`);
  const counts = new Map<number, number>(), dates: StandingTrainingDate[] = [];
  let until = cutoff;
  for (let i = 0; i < lookbackDays; i++) {
    const from = standingDayBounds(until - 1)[0];
    const routes = stmt.all(from, until, knownCutoff, knownCutoff, knownCutoff - 120_000) as { route_id: number }[];
    for (const { route_id: routeId } of routes) {
      const n = counts.get(routeId) ?? 0;
      if (n >= serviceDaysPerRoute) continue;
      dates.push({ routeId, day: standingDayOf(from), from, until }); counts.set(routeId, n + 1);
    }
    until = from;
  }
  return dates.sort((a, b) => a.from - b.from || a.routeId - b.routeId);
}
export interface StandingReadResult {
  episodes: AnalyticEpisode[];
  counts: { read: number; explicit: number; legacyProxy: number; unknownAvailability: number; unresolvedPattern: number; ambiguousIdentity: number };
}

/** Bounded historical adapter. New rows carry actual availability and pattern.
 * Legacy training uses the study's two-later-anchors +120s proxy, explicitly;
 * live history uses the time this process first observed an existing row. */
export function readStandingEpisodes(sqlite: Database.Database, patterns: readonly StandingRoutePattern[],
  from: number, observedAt: number, mode: "training" | "live", maximumRows: number,
  selectedDates?: readonly StandingTrainingDate[]): StandingReadResult {
  const selection = selectedDates == null ? "v.anchored_at>=? AND v.anchored_at<?" :
    selectedDates.length ? selectedDates.map(() => "(v.route_id=? AND v.anchored_at>=? AND v.anchored_at<?)").join(" OR ") : "0";
  const parameters = selectedDates == null ? [from, observedAt] : selectedDates.flatMap(d => [d.routeId, d.from, d.until]);
  const metadata = hasMetadata(sqlite);
  const rows = sqlite.prepare(`SELECT v.id, v.bus_id, v.bus_name, v.route_id, v.stop_id, v.stop_index,
      v.anchored_at, v.pinned_at, v.departed_at, v.outcome,
      ${metadata ? "o.known_at AS observed_known_at, o.pattern_id, p.stop_ids, o.identity_ambiguous" :
        "NULL AS observed_known_at, NULL AS pattern_id, NULL AS stop_ids, NULL AS identity_ambiguous"},
      ${mode === "training" ? secondLaterAnchor : "NULL"} AS next_two_anchor_at
    FROM stop_visits v ${metadata ? "LEFT JOIN standing_forecast_observations o ON o.visit_id=v.id LEFT JOIN standing_forecast_patterns p ON p.id=o.pattern_id" : ""}
    WHERE (${selection}) ORDER BY v.anchored_at,v.id LIMIT ?`)
    .all(...parameters, maximumRows + 1) as StoredVisit[];
  if (rows.length > maximumRows) throw new Error(`standing forecast input exceeds ${maximumRows} rows`);
  const byRoute = new Map(patterns.map(p => [p.routeId, p]));
  const disputed = new Set<string>();
  const groups = new Map<string, StoredVisit[]>();
  for (const row of rows) {
    const sequence = byRoute.get(row.route_id)?.stopIds;
    if (!sequence || sequence[row.stop_index] !== row.stop_id) disputed.add(`${row.route_id}:${standingDayOf(row.anchored_at)}`);
    const key = JSON.stringify([row.route_id, row.bus_name]);
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const counts = { read: rows.length, explicit: 0, legacyProxy: 0, unknownAvailability: 0, unresolvedPattern: 0, ambiguousIdentity: 0 };
  const episodes: AnalyticEpisode[] = [];
  for (const group of groups.values()) for (let i = 0; i < group.length; i++) {
    const row = group[i]!, day = standingDayOf(row.anchored_at);
    const explicit = row.observed_known_at != null;
    let patternId: string | null = null;
    if (explicit) {
      if (row.pattern_id && row.stop_ids) {
        try {
          const sequence: unknown = JSON.parse(row.stop_ids);
          if (Array.isArray(sequence) && sequence.every(s => Number.isInteger(s)) &&
            sequence[row.stop_index] === row.stop_id && standingPatternId(row.route_id, sequence) === row.pattern_id) patternId = row.pattern_id;
        } catch { /* A malformed stored pattern is unresolvable, never guessed. */ }
      }
    } else {
      const pattern = byRoute.get(row.route_id);
      if (pattern && !disputed.has(`${row.route_id}:${day}`) && pattern.stopIds[row.stop_index] === row.stop_id) {
        patternId = standingPatternId(row.route_id, pattern.stopIds);
      }
    }
    let knownAt = explicit ? row.observed_known_at : mode === "live" ? observedAt :
      row.next_two_anchor_at != null ? row.next_two_anchor_at + 120_000 : null;
    const physicalEnd = Math.max(row.anchored_at, row.pinned_at ?? 0, row.departed_at ?? 0);
    if (knownAt != null && (!Number.isFinite(knownAt) || knownAt < physicalEnd || knownAt > observedAt)) knownAt = null;
    if (explicit) counts.explicit++; else if (knownAt != null && mode === "training") counts.legacyProxy++;
    if (knownAt == null) counts.unknownAvailability++;
    if (patternId == null) counts.unresolvedPattern++;
    if (row.identity_ambiguous) counts.ambiguousIdentity++;
    episodes.push({ id: row.id, routeId: row.route_id, routePatternId: patternId ?? `${row.route_id}:unresolved`,
      stopId: row.stop_id, stopIndex: row.stop_index, busKey: row.bus_name, day,
      anchoredAt: row.anchored_at, pinnedAt: row.pinned_at, departedAt: row.departed_at,
      knownAt, outcome: row.outcome, patternResolved: patternId != null && !row.identity_ambiguous });
  }
  episodes.sort((a, b) => a.anchoredAt - b.anchoredAt || Number(a.id) - Number(b.id));
  return { episodes, counts };
}
