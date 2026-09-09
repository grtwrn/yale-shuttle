/** Bounded, read-only views of detector evidence. No rider tables or model writes. */
import type Database from "better-sqlite3";

import { TransitNetwork } from "../network/TransitNetwork.js";
import { haversineMeters } from "../network/legs.js";
import type { Route, Stop } from "../schema/api.js";
import type {
  StopDataCatalog, StopDataDay, StopDataDetail, StopDataSelection, StopDataVisit,
} from "../schema/stop-data.js";
import { etDay, etDayStartMs } from "./actives.js";
import { normBusName } from "./predictions.js";

export const STOP_DATA_LIMITS = {
  catalogDays: 90,
  visits: 2000,
  positions: 6000,
  positionWindowHours: 3,
} as const;

const DAY_MS = 86_400_000;
const MAX_AGE_DAYS = 400;
// The recorded pin may start late. Leave enough earlier raw evidence to
// inspect a full unrecorded rest instead of centering only on that clock.
const POSITION_BEFORE_MS = 15 * 60_000;
const POSITION_AFTER_MS = 2 * 60_000;
const GAP_WARNING_SEC = 30;
const CATALOG_OCCURRENCES = 5000;
const EVIDENCE_NOTE = "Stop visits are recorded detector decisions, not independently verified arrival labels. Historical route topology is not stored with each visit.";

export class StopDataInputError extends Error {}

interface VisitRow {
  id: number;
  bus_id: number;
  bus_name: string;
  route_id: number;
  stop_id: number;
  stop_index: number;
  anchored_at: number;
  pinned_at: number | null;
  arrived_at: number | null;
  departed_at: number | null;
  stand_sec: number | null;
  outcome: string;
  how: string | null;
  confidence: number | null;
}

// Explicit allowlist: adding columns to the underlying database does not widen this API.
const VISIT_COLUMNS = "id,bus_id,bus_name,route_id,stop_id,stop_index,anchored_at,pinned_at,arrived_at,departed_at,stand_sec,outcome,how,confidence";

function validId(value: number, zeroAllowed = false): boolean {
  return Number.isSafeInteger(value) && value >= (zeroAllowed ? 0 : 1);
}

/** Real ET calendar boundaries, including 23/25-hour DST days. */
export function stopDataDayRange(day: string, now: number): { from: number; to: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new StopDataInputError("day must be YYYY-MM-DD in America/New_York");
  const from = etDayStartMs(day);
  if (from <= 0 || etDay(from) !== day || day > etDay(now) || from < now - MAX_AGE_DAYS * DAY_MS) {
    throw new StopDataInputError("day must be a valid date within the last 400 days");
  }
  return { from, to: etDayStartMs(etDay(from + 26 * 3_600_000)) };
}

function validateSelection(selection: StopDataSelection, now: number) {
  if (!validId(selection.routeId) || !validId(selection.stopId) || !validId(selection.stopIndex, true)) {
    throw new StopDataInputError("routeId and stopId must be positive integers; stopIndex must be a nonnegative integer");
  }
  return stopDataDayRange(selection.day, now);
}

function makeVisit(row: VisitRow, day: string, previousDepartureAt: number | null): StopDataVisit {
  const qualityNotes: string[] = [];
  if (row.outcome === "passed") qualityNotes.push("Pass-through: excluded from standing durations.");
  if (row.outcome === "unresolved") qualityNotes.push("Unresolved visit: no completed standing outcome.");
  if (row.pinned_at === null) qualityNotes.push("No recorded pin clock.");
  if (row.departed_at === null) qualityNotes.push("No recorded departure; duration is censored.");
  if (row.how === "gap") qualityNotes.push("Detector closed this visit across an observation gap.");
  if (row.pinned_at !== null && row.departed_at !== null && row.departed_at < row.pinned_at) {
    qualityNotes.push("Departure precedes the pin clock; excluded from standing durations.");
  }
  if (row.stand_sec !== null && row.stand_sec < 0) qualityNotes.push("Stored standing duration is negative.");
  const completed = row.outcome === "stopped" && row.departed_at !== null;
  return {
    id: String(row.id), day, routeId: row.route_id, stopId: row.stop_id, stopIndex: row.stop_index,
    busId: row.bus_id, busKey: normBusName(row.bus_name), busName: row.bus_name,
    anchoredAt: row.anchored_at, pinnedAt: row.pinned_at, recordedPinnedAt: row.pinned_at,
    arrivedAt: row.arrived_at, departedAt: row.departed_at, recordedStandSec: row.stand_sec,
    pinnedStandSec: completed && row.pinned_at !== null && row.departed_at! >= row.pinned_at
      ? (row.departed_at! - row.pinned_at) / 1000 : null,
    outcome: row.outcome, how: row.how, confidence: row.confidence, qualityNotes,
    previousDepartureAt,
    loopSec: usableDeparture(row) && previousDepartureAt !== null && row.departed_at! > previousDepartureAt
      ? (row.departed_at! - previousDepartureAt) / 1000 : null,
  };
}

function usableDeparture(row: VisitRow): boolean {
  return row.outcome === "stopped" && row.departed_at !== null && row.departed_at >= row.anchored_at
    && row.how !== "gap" && (row.pinned_at === null || row.departed_at >= row.pinned_at);
}

function visitSeries(rows: VisitRow[], day: string): StopDataVisit[] {
  const priorByBus = new Map<string, VisitRow>();
  return rows.map((row) => {
    const key = normBusName(row.bus_name);
    const previous = priorByBus.get(key);
    // Anchor order alone does not establish availability: the old visit must
    // actually have departed before this visit started.
    const previousDepartureAt = previous && previous.departed_at! < row.anchored_at ? previous.departed_at : null;
    const visit = makeVisit(row, day, previousDepartureAt);
    if (usableDeparture(row)) priorByBus.set(key, row);
    return visit;
  });
}

export function readStopDataDay(sqlite: Database.Database, selection: StopDataSelection, now = Date.now()): StopDataDay {
  const { from, to } = validateSelection(selection, now);
  const args = [selection.routeId, selection.stopId, selection.stopIndex, from, Math.min(to, now + 1)];
  const where = "route_id = ? AND stop_id = ? AND stop_index = ? AND anchored_at >= ? AND anchored_at < ?";
  const totalVisits = (sqlite.prepare(`SELECT COUNT(*) AS n FROM stop_visits WHERE ${where}`).get(...args) as { n: number }).n;
  const rows = sqlite.prepare(`SELECT ${VISIT_COLUMNS} FROM stop_visits WHERE ${where} ORDER BY anchored_at,id LIMIT ?`)
    .all(...args, STOP_DATA_LIMITS.visits) as VisitRow[];
  const truncated = totalVisits > rows.length;
  return {
    schemaVersion: 1, source: "retained_database", selection: { ...selection },
    dayStartAt: from, dayEndAt: to, visits: visitSeries(rows, selection.day), totalVisits, truncated,
    warnings: [EVIDENCE_NOTE, ...(truncated ? [`Only the first ${STOP_DATA_LIMITS.visits} visits are shown.`] : [])],
  };
}

function readTopology(sqlite: Database.Database): TransitNetwork {
  const stops = sqlite.prepare("SELECT id,name,lat,lon FROM stops").all() as Stop[];
  const routes = (sqlite.prepare("SELECT id,name,short_name,color,stops_json,path_json FROM routes").all() as {
    id: number; name: string; short_name: string; color: string; stops_json: string; path_json: string | null;
  }[]).flatMap((row): Route[] => {
    try {
      const stopIds: unknown = JSON.parse(row.stops_json);
      const path: unknown = row.path_json === null ? undefined : JSON.parse(row.path_json);
      if (!Array.isArray(stopIds) || !stopIds.every((id) => Number.isSafeInteger(id))) return [];
      const validPath = Array.isArray(path) && path.every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
      return [{ id: row.id, name: row.name, shortName: row.short_name, color: row.color, stops: stopIds as number[],
        ...(validPath ? { path: path as [number, number][] } : {}) }];
    } catch { return []; }
  });
  // Use the detector's canonical order, including the normal topology repair.
  return TransitNetwork.build(stops, routes);
}

export function readStopDataCatalog(
  sqlite: Database.Database, now = Date.now(), existingNetwork?: Pick<TransitNetwork, "routes" | "stops">,
): StopDataCatalog {
  const today = etDay(now);
  const dayNames = Array.from({ length: STOP_DATA_LIMITS.catalogDays }, (_, i) =>
    new Date(Date.parse(`${today}T12:00:00Z`) - i * DAY_MS).toISOString().slice(0, 10));
  const boundaries = dayNames.map(etDayStartMs);
  const from = boundaries[boundaries.length - 1]!;
  const until = now + 1;
  const count = sqlite.prepare("SELECT COUNT(*) AS n FROM stop_visits WHERE anchored_at >= ? AND anchored_at < ?");
  const days = dayNames.map((day, i) => {
    return { day, visitCount: (count.get(boundaries[i]!, i === 0 ? until : boundaries[i - 1]!) as { n: number }).n };
  }).filter((day) => day.visitCount > 0);
  const groups = sqlite.prepare(`SELECT route_id,stop_id,stop_index,COUNT(*) AS n FROM stop_visits
    WHERE anchored_at >= ? AND anchored_at < ? GROUP BY route_id,stop_id,stop_index LIMIT ?`)
    .all(from, until, CATALOG_OCCURRENCES + 1) as { route_id: number; stop_id: number; stop_index: number; n: number }[];
  const truncated = groups.length > CATALOG_OCCURRENCES;
  if (truncated) groups.length = CATALOG_OCCURRENCES;
  const network = existingNetwork ?? readTopology(sqlite);
  const byRoute = new Map<number, StopDataCatalog["routes"][number]>();
  for (const group of groups) {
    const route = network.routes.get(group.route_id);
    const stop = network.stops.get(group.stop_id);
    let result = byRoute.get(group.route_id);
    if (!result) {
      result = { routeId: group.route_id, name: route?.name ?? `Route ${group.route_id}`, shortName: route?.shortName ?? String(group.route_id), occurrences: [] };
      byRoute.set(group.route_id, result);
    }
    result.occurrences.push({ stopId: group.stop_id, stopIndex: group.stop_index,
      name: stop?.name ?? `Stop ${group.stop_id}`, lat: stop?.lat ?? null, lon: stop?.lon ?? null,
      visitCount: group.n, currentTopologyMatch: route?.stops[group.stop_index] === group.stop_id });
  }
  for (const route of byRoute.values()) route.occurrences.sort((a, b) => a.stopIndex - b.stopIndex || a.stopId - b.stopId);
  // Separate indexed extremum queries avoid MIN+MAX's full-table aggregate scan.
  const edge = (table: "stop_visits" | "raw_positions", column: "anchored_at" | "collected_at", direction: "ASC" | "DESC") => {
    const row = sqlite.prepare(`SELECT ${column} AS at FROM ${table} ORDER BY ${column} ${direction} LIMIT 1`).get() as { at: number } | undefined;
    return row?.at ?? null;
  };
  return {
    schemaVersion: 1, source: "retained_database", generatedAt: now, timezone: "America/New_York", days,
    routes: [...byRoute.values()].sort((a, b) => a.name.localeCompare(b.name)),
    availability: {
      visitsFrom: edge("stop_visits", "anchored_at", "ASC"), visitsTo: edge("stop_visits", "anchored_at", "DESC"),
      positionsFrom: edge("raw_positions", "collected_at", "ASC"), positionsTo: edge("raw_positions", "collected_at", "DESC"),
    },
    limits: STOP_DATA_LIMITS,
    warnings: [EVIDENCE_NOTE, "Raw GPS is normally retained for about 6 hours; missing positions are not evidence that a bus was absent.",
      ...(truncated ? [`Catalogue limited to ${CATALOG_OCCURRENCES} route/stop occurrences.`] : [])],
  };
}

export function readStopDataVisit(sqlite: Database.Database, visitId: string, now = Date.now()): StopDataDetail | null {
  if (!/^[1-9]\d*$/.test(visitId) || !validId(Number(visitId))) throw new StopDataInputError("visit id must be a positive integer");
  const row = sqlite.prepare(`SELECT ${VISIT_COLUMNS} FROM stop_visits WHERE id = ? AND anchored_at <= ?`).get(Number(visitId), now) as VisitRow | undefined;
  if (!row) return null;
  const day = etDay(row.anchored_at);
  const prior = sqlite.prepare(`SELECT ${VISIT_COLUMNS} FROM stop_visits
    WHERE route_id = ? AND stop_id = ? AND stop_index = ? AND anchored_at >= ? AND anchored_at < ?
      AND outcome = 'stopped' AND (how IS NULL OR how != 'gap')
      AND departed_at >= anchored_at AND (pinned_at IS NULL OR departed_at >= pinned_at)
      AND LTRIM(TRIM(bus_name), '#') = ? ORDER BY anchored_at DESC,id DESC LIMIT 1`)
    .get(row.route_id, row.stop_id, row.stop_index, etDayStartMs(day), row.anchored_at, normBusName(row.bus_name)) as VisitRow | undefined;
  const visit = makeVisit(row, day, prior && prior.departed_at! < row.anchored_at ? prior.departed_at : null);
  const foundStop = sqlite.prepare("SELECT id AS stopId,name,lat,lon FROM stops WHERE id = ?").get(row.stop_id) as StopDataDetail["stop"] | undefined;
  const stop = foundStop ?? { stopId: row.stop_id, name: `Stop ${row.stop_id}`, lat: null, lon: null };
  const requestedFrom = Math.max(0, Math.min(row.anchored_at, row.pinned_at ?? row.anchored_at, row.arrived_at ?? row.anchored_at) - POSITION_BEFORE_MS);
  const desiredTo = Math.min(now, (row.departed_at ?? row.anchored_at + 30 * 60_000) + POSITION_AFTER_MS);
  const requestedTo = Math.max(requestedFrom, Math.min(desiredTo, requestedFrom + STOP_DATA_LIMITS.positionWindowHours * 3_600_000));
  const windowCapped = requestedTo < desiredTo;
  const raw = sqlite.prepare(`SELECT bus_id,lat,lon,collected_at FROM raw_positions
    WHERE route_id = ? AND collected_at >= ? AND collected_at <= ? AND LTRIM(TRIM(bus_name), '#') = ?
    ORDER BY collected_at,id LIMIT ?`)
    .all(row.route_id, requestedFrom, requestedTo, visit.busKey, STOP_DATA_LIMITS.positions + 1) as {
      bus_id: number; lat: number; lon: number; collected_at: number;
    }[];
  const truncated = raw.length > STOP_DATA_LIMITS.positions;
  if (truncated) raw.length = STOP_DATA_LIMITS.positions;
  // A name can survive id rotation or be reused. Neither simultaneous nor
  // sequential ids establish that GPS fixes belong to one physical track.
  const identityAmbiguous = new Set(raw.map((point) => point.bus_id)).size > 1;
  const positions = raw.map((point, i) => {
    const previous = raw[i - 1];
    return { at: point.collected_at, lat: point.lat, lon: point.lon, busId: point.bus_id,
      distanceM: stop.lat !== null && stop.lon !== null ? haversineMeters(point, { lat: stop.lat, lon: stop.lon }) : null,
      gapSec: previous ? (point.collected_at - previous.collected_at) / 1000 : null };
  });
  const actualFrom = positions[0]?.at ?? null;
  const actualTo = positions[positions.length - 1]?.at ?? null;
  const maxGapSec = positions.length > 1 ? Math.max(...positions.slice(1).map((p) => p.gapSec!)) : null;
  const missingBefore = actualFrom === null || actualFrom > requestedFrom + GAP_WARNING_SEC * 1000;
  const missingAfter = actualTo === null || actualTo < requestedTo - GAP_WARNING_SEC * 1000;
  return {
    schemaVersion: 1, source: "retained_database", visit, stop, positions,
    coverage: { requestedFrom, requestedTo, actualFrom, actualTo, missingBefore, missingAfter, maxGapSec, truncated, windowCapped, identityAmbiguous },
    warnings: [EVIDENCE_NOTE,
      ...(positions.length === 0 ? ["No retained raw GPS for this visit. Normal GPS retention is about 6 hours."] : []),
      ...(missingBefore || missingAfter ? ["GPS does not cover both edges of the requested window."] : []),
      ...(maxGapSec !== null && maxGapSec > GAP_WARNING_SEC ? ["GPS has gaps over 30 seconds; do not treat the connecting line as observed movement."] : []),
      ...(identityAmbiguous ? ["This bus name spans multiple bus ids, which may be id rotation or name reuse; do not join GPS tracks across id changes."] : []),
      ...(truncated ? [`Only the first ${STOP_DATA_LIMITS.positions} GPS points are shown.`] : []),
      ...(windowCapped ? [`GPS window capped at ${STOP_DATA_LIMITS.positionWindowHours} hours.`] : []),
      ...(stop.lat === null ? ["Current stop coordinates are unavailable; GPS distance cannot be calculated."] : []),
      "GPS distance uses the currently stored stop marker; historical marker revisions are not available.",
    ],
  };
}
