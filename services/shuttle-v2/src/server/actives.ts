/**
 * Unique-rider counting.
 *
 * The question "how many people use this" had no answer before: the app logs no
 * requests, stores no sessions, and the only person-shaped data it held was the
 * IP on a submitted report — 23 distinct IPs across 44 reports, which counts
 * people who wrote in, not people who ride. Fly's metrics are request volume,
 * not visitors.
 *
 * What this adds is the smallest thing that answers it. The browser generates a
 * random id for itself once and keeps it in localStorage next to the favourites
 * it already stores; it rides along on the `/api/buses` poll the app already
 * makes, so there is no extra request and no beacon. The server records one row
 * per (ET day, id) and nothing else — no IP, no user agent, no coordinates, no
 * time of day. See the `dailyActives` comment in db/schema.ts for why it is not
 * IP-based.
 *
 * The cost has to be near zero, because /api/buses is the hot path: 200 riders
 * polling every 5 s is 40 req/s, and a naive `INSERT OR IGNORE` per request
 * would put 3.5 million writes a day on the single synchronous SQLite
 * connection shared with the collector. So the first sighting of an id on a
 * given day writes one row and the id then lives in a Set for the rest of the
 * day: ~200 writes/day instead of ~3,500,000.
 */

import { sql } from "drizzle-orm";

import type { DB } from "../db/client.js";
import { dailyActives } from "../db/schema.js";

/** Keep three months of daily rows; enough for a term's worth of trend. */
const RETAIN_DAYS = 90;

/**
 * Guard against a malformed or hostile header inflating the table. Real ids are
 * UUIDs; anything else is ignored rather than stored, so a client cannot inject
 * arbitrary text or a huge value into the database.
 */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ET calendar day as YYYY-MM-DD — the same service day the rest of the schema counts in. */
export function etDay(now: number): string {
  // en-CA renders as YYYY-MM-DD, which sorts lexicographically.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

export interface ActivesTracker {
  /** Record a sighting. Cheap and idempotent; safe to call on every request. */
  seen(anonId: string | undefined | null, now?: number): void;
  /** Rider counts over the trailing windows. */
  stats(now?: number): { today: number; last7Days: number; last30Days: number; allTime: number };
}

export function createActivesTracker(db: DB): ActivesTracker {
  // Ids already written for `currentDay`. Bounded by the number of real riders,
  // and dropped wholesale at the day rollover, so it cannot grow unbounded.
  let currentDay = "";
  let seenToday = new Set<string>();

  const insert = db
    .insert(dailyActives)
    .values({ day: sql.placeholder("day"), anonId: sql.placeholder("anonId") })
    .onConflictDoNothing()
    .prepare();

  return {
    seen(anonId, now = Date.now()) {
      if (!anonId || !ID_PATTERN.test(anonId)) return;
      const day = etDay(now);
      if (day !== currentDay) {
        currentDay = day;
        seenToday = new Set();
        // Sweep on the rollover: once a day, not on a timer, and not on the
        // request path for the other 86,399 seconds.
        try {
          const cutoff = etDay(now - RETAIN_DAYS * 86_400_000);
          db.run(sql`DELETE FROM daily_actives WHERE day < ${cutoff}`);
        } catch {
          /* a failed sweep must never break a rider's request */
        }
      }
      if (seenToday.has(anonId)) return;
      seenToday.add(anonId);
      try {
        insert.run({ day, anonId });
      } catch {
        // Never let counting break the endpoint riders depend on. Drop the id
        // from the set so a later request retries the write.
        seenToday.delete(anonId);
      }
    },

    stats(now = Date.now()) {
      const since = (days: number) => etDay(now - (days - 1) * 86_400_000);
      const count = (where?: string) => {
        const rows = where
          ? db.all<{ n: number }>(
              sql`SELECT COUNT(DISTINCT anon_id) AS n FROM daily_actives WHERE day >= ${where}`,
            )
          : db.all<{ n: number }>(sql`SELECT COUNT(DISTINCT anon_id) AS n FROM daily_actives`);
        return rows[0]?.n ?? 0;
      };
      return {
        today: count(etDay(now)),
        last7Days: count(since(7)),
        last30Days: count(since(30)),
        allTime: count(),
      };
    },
  };
}
