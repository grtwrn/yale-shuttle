/**
 * What the archive feed may serve, and for which day.
 *
 * Stage 2 of the closed loop (docs/closed-loop.md): the production volume is
 * 1 GB and retention sweeps `raw_positions` after 6 h, the census after ~4
 * weekdays and the upstream rows of `predictions_log` after 7 days, so the
 * rows a replay needs do not survive where they are written. The Pi pulls
 * each day through `GET /api/archive/day?day=&table=` and keeps it 180 days.
 *
 * The allowlist is the whole contract: a table is served only if it is named
 * here WITH the epoch column its time-leading index covers, so a request can
 * never turn into a full scan, and `reports` (free text, IP addresses) can
 * never be asked for by this route at all.
 */

import { etDay, etDayStartMs } from "./actives.js";

/** Table → the indexed epoch-ms column that bounds a day; null = keyed by `day`. */
const ARCHIVE_COLUMNS = {
  raw_positions: "collected_at",
  arrivals: "arrived_at",
  stop_visits: "anchored_at",
  legs: "departed_at",
  predictions_log: "predicted_at",
  upstream_etas: "sampled_at",
  scorecard_days: null,
} as const;

export type ArchiveTable = keyof typeof ARCHIVE_COLUMNS;
export const ARCHIVE_TABLES = Object.keys(ARCHIVE_COLUMNS) as ArchiveTable[];

export function isArchiveTable(name: string): name is ArchiveTable {
  return Object.prototype.hasOwnProperty.call(ARCHIVE_COLUMNS, name);
}

/** How far back a day may be asked for: the longest retention any table has. */
export const ARCHIVE_MAX_AGE_DAYS = 400;

export interface ArchiveDayRange {
  day: string;
  /** ET midnight of the day and of the next, epoch ms. */
  from: number;
  to: number;
  column: string | null;
}

/**
 * The ET day's bounds for a table, or null when the day is malformed, in the
 * future, or older than anything retained. Today is allowed: the archiver
 * runs after 03:30 for yesterday, but a hand run for a day in progress is a
 * legitimate partial.
 */
export function archiveDayRange(day: string, now: number, table: ArchiveTable): ArchiveDayRange | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const from = etDayStartMs(day);
  if (from === 0 || etDay(from) !== day) return null;
  const today = etDay(now);
  if (day > today) return null;
  if (from < now - ARCHIVE_MAX_AGE_DAYS * 86_400_000) return null;
  const to = etDayStartMs(etDay(from + 26 * 3_600_000));
  return { day, from, to, column: ARCHIVE_COLUMNS[table] };
}

/** The epoch column for a table, for callers that already checked the name. */
export function archiveColumn(table: ArchiveTable): string | null {
  return ARCHIVE_COLUMNS[table];
}
