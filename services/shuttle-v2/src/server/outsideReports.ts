/**
 * "Has anyone other than me written in?"
 *
 * The operator's own two browsers filed 60 of the first 69 reports, and the
 * one report from a real outside rider (a Trader Joe's request, 2026-09-01)
 * sat unnoticed among them until it was found by hand — grouping anonymous
 * ids and IP addresses in a shell one-liner. This module answers the question
 * the dashboard actually needs to ask.
 *
 * What counts as "outside":
 *   - not from an anon id listed in `operator_anon_ids`,
 *   - not an automated filing (the map-bot posts as a rider would, so its
 *     reports are recognised by their "[map-bot]" body prefix),
 *   - and that is all. A report with NO anon id counts as outside: storage
 *     may simply have been blocked, and a false "someone wrote in" is a
 *     cheap error next to missing the one person who did.
 */
import { sql } from "drizzle-orm";
import type { DbBundle } from "../db/client.js";
import { etDayStartMs, resolveStatsSinceDay } from "./actives.js";

/** The map-bot files reports through the public endpoint, like a rider. */
export const AUTOMATED_BODY_PREFIX = "[map-bot]";

export interface OutsideReport {
  id: number;
  createdAt: number;
  kind: string;
  status: string;
  routeId: number | null;
  /** Truncated: the dashboard is a glance, and the full text lives in triage. */
  excerpt: string;
  /** Whether an operator/bot note has been written back to the rider yet. */
  answered: boolean;
}

export interface OutsideReportsResult {
  reports: OutsideReport[];
  /** Total outside reports ever, so the page can say "1 of 69". */
  total: number;
  /** Highest id, so a browser can remember what it has already seen. */
  newestId: number | null;
}

const EXCERPT_MAX = 240;

export interface OutsideReportsOptions {
  /**
   * First ET day to show, "YYYY-MM-DD". Defaults to the statistics epoch —
   * the same one the dashboard prints under its hero — so this panel cannot
   * disagree with the page it sits on. See the note on the WHERE below.
   */
  sinceDay?: string;
}

/**
 * Everything that decides whether a report belongs on the dashboard, in ONE
 * place: the list and the total MUST share it, or the page says "1 of 69"
 * about a list of one. The epoch floor lives here for the same reason the
 * counting floor lives in `notExcluded` — a second query cannot forget it.
 *
 * `created_at` is epoch MILLISECONDS (see the schema: `unixepoch() * 1000`),
 * so the day-shaped epoch is converted once, by `etDayStartMs`, rather than
 * compared as text.
 */
const OUTSIDE_WHERE = `
     WHERE (anon_id IS NULL OR anon_id NOT IN (SELECT anon_id FROM operator_anon_ids))
       AND substr(body, 1, ${AUTOMATED_BODY_PREFIX.length}) <> ?
       AND created_at >= ?
`;

export function outsideReports(
  bundle: DbBundle,
  limit = 20,
  opts: OutsideReportsOptions = {},
): OutsideReportsResult {
  const capped = Math.max(1, Math.min(100, Math.floor(limit) || 20));
  // Reports filed before the app was in riders' hands are development traffic,
  // exactly as the pre-epoch sightings are. They stay in the triage queue
  // (/api/reports shows everything) and in the rider's own history; they are
  // simply not what "has anyone written in?" is asking about.
  const sinceMs = etDayStartMs(resolveStatsSinceDay(opts.sinceDay));
  const rows = bundle.sqlite.prepare(`
    SELECT id, created_at, kind, status, route_id, body, note
      FROM reports
    ${OUTSIDE_WHERE}
     ORDER BY id DESC
     LIMIT ?
  `).all(AUTOMATED_BODY_PREFIX, sinceMs, capped) as Array<{
    id: number; created_at: number; kind: string; status: string;
    route_id: number | null; body: string; note: string | null;
  }>;
  const totalRow = bundle.sqlite.prepare(`
    SELECT COUNT(*) AS n, MAX(id) AS newest
      FROM reports
    ${OUTSIDE_WHERE}
  `).get(AUTOMATED_BODY_PREFIX, sinceMs) as { n: number; newest: number | null };
  return {
    // Note the shape: no client_ip, no anon_id, no context. This endpoint is
    // reachable with the stats COOKIE, which must never unlock anything that
    // identifies a reporter (see requireStatsAuth in app.ts).
    reports: rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      kind: r.kind,
      status: r.status,
      routeId: r.route_id,
      excerpt: r.body.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX),
      answered: typeof r.note === "string" && r.note.trim().length > 0,
    })),
    total: totalRow.n,
    newestId: totalRow.newest,
  };
}

/** Ids the operator has claimed as their own browsers. */
export function operatorIds(bundle: DbBundle): string[] {
  return (bundle.sqlite.prepare("SELECT anon_id FROM operator_anon_ids ORDER BY anon_id")
    .all() as Array<{ anon_id: string }>).map((r) => r.anon_id);
}

/**
 * Seed from the environment so a fresh machine knows whose reports are whose
 * before anyone opens the dashboard. Never throws: an unreadable value leaves
 * the table as it is, and every report then reads as "outside" — visible, not
 * silent.
 */
export function seedOperatorIds(bundle: DbBundle, raw: string | undefined): void {
  if (!raw) return;
  try {
    for (const id of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      bundle.db.run(sql`
        INSERT OR IGNORE INTO operator_anon_ids (anon_id, note)
        VALUES (${id}, 'seeded from SHUTTLE_OPERATOR_ANON_IDS')`);
    }
  } catch {
    /* a failed seed must never stop the server booting */
  }
}
