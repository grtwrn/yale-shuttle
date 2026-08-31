/**
 * Rider counting and return-visit measurement.
 *
 * One row per (ET day, anonymous browser id), carrying only what that browser
 * did on that day: when it first and last appeared, how many times it polled,
 * and how many destination searches it ran. No IP, no user agent, no
 * coordinates, no per-event log — so the data answers "how many people use
 * this, do they come back, and for how long" and cannot answer "where did this
 * person go".
 *
 * Retention needs no extra data. A row per (day, id) already tells you whether
 * an id appears on more than one day, which day it first appeared, and how many
 * days it has been active. The columns added beyond that exist for *depth*
 * (time in app, searches), not for identity.
 *
 * The cost constraint is the design driver: /api/buses is polled every 5 s, so
 * ~40 req/s at launch load. Writing per request would be ~3.5M writes/day on
 * the single synchronous SQLite connection shared with the collector. Instead
 * every sighting updates an in-memory accumulator and the whole day's state is
 * flushed on a timer — one UPSERT per active browser per flush, so a few
 * hundred writes a day regardless of traffic.
 */

import { sql } from "drizzle-orm";

import type { DbBundle } from "../db/client.js";

/** Keep three months of daily rows; enough for a term's worth of trend. */
const RETAIN_DAYS = 90;

/**
 * How often accumulated counters reach the database. Long enough that writes
 * stay negligible, short enough that a crash loses at most this much of the
 * current day's counts (the row itself, and therefore the rider's presence,
 * survives from the first flush onward).
 */
const FLUSH_MS = 60_000;

/**
 * Guard against a malformed or hostile header. Real ids are UUIDs; anything
 * else is ignored rather than stored, so a client cannot inject arbitrary text
 * or a huge value into the database.
 */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ET calendar day as YYYY-MM-DD — the service day the rest of the schema uses. */
export function etDay(now: number): string {
  // en-CA renders YYYY-MM-DD, which sorts lexicographically.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

/** What a browser did today, accumulated in memory between flushes. */
interface DayState {
  firstSeen: number;
  lastSeen: number;
  polls: number;
  searches: number;
  dirty: boolean;
}

export type Activity = "poll" | "search";

export interface RiderStats {
  /** Distinct browsers over trailing windows. */
  today: number;
  last7Days: number;
  last30Days: number;
  allTime: number;
  /** Of today's browsers, how many had been seen on an earlier day. */
  returningToday: number;
  newToday: number;
  /** Share of all browsers ever seen that came back on a second day. */
  repeatRate: number;
  /**
   * Of browsers whose first day was at least 7 days ago, the share seen again
   * within the 7 days after that first day. The honest retention number: it
   * only counts browsers that have HAD a week to come back.
   */
  week1Retention: number | null;
  week1Cohort: number;
  /** Median days a browser has been active, over all browsers ever seen. */
  medianDaysActive: number;
  /** Median minutes between first and last sighting, per active day. */
  medianMinutesPerDay: number;
  /** Destination searches today, and per active browser today. */
  searchesToday: number;
  searchesPerRiderToday: number;
}

export interface ActivesTracker {
  /** Record activity. Cheap and idempotent; safe on every request. */
  seen(anonId: string | undefined | null, kind?: Activity, now?: number): void;
  /** Usage and return-visit numbers. */
  stats(now?: number): RiderStats;
  /** Write accumulated counters through. Called on a timer and at shutdown. */
  flush(now?: number): void;
  stop(): void;
}

export function createActivesTracker(bundle: DbBundle): ActivesTracker {
  const db = bundle.db;
  let currentDay = "";
  let today = new Map<string, DayState>();

  const upsert = bundle.sqlite.prepare(`
    INSERT INTO daily_actives (day, anon_id, first_seen_ms, last_seen_ms, polls, searches)
    VALUES (@day, @anonId, @firstSeen, @lastSeen, @polls, @searches)
    ON CONFLICT(day, anon_id) DO UPDATE SET
      first_seen_ms = MIN(first_seen_ms, excluded.first_seen_ms),
      last_seen_ms  = MAX(last_seen_ms,  excluded.last_seen_ms),
      polls         = excluded.polls,
      searches      = excluded.searches
  `);

  function flush(now = Date.now()): void {
    if (today.size === 0) return;
    const day = currentDay;
    try {
      const rows = [...today.entries()].filter(([, v]) => v.dirty);
      if (rows.length === 0) return;
      bundle.sqlite.transaction(() => {
        for (const [anonId, v] of rows) {
          upsert.run({
            day,
            anonId,
            firstSeen: v.firstSeen,
            lastSeen: v.lastSeen,
            polls: v.polls,
            searches: v.searches,
          });
          v.dirty = false;
        }
      })();
    } catch {
      // Counting must never break the endpoint riders depend on. Leave the
      // entries dirty so the next flush retries them.
    }
  }

  function rollover(now: number, day: string): void {
    flush(now);
    currentDay = day;
    today = new Map();
    try {
      const cutoff = etDay(now - RETAIN_DAYS * 86_400_000);
      db.run(sql`DELETE FROM daily_actives WHERE day < ${cutoff}`);
    } catch {
      /* a failed sweep must never break a request */
    }
  }

  const timer = setInterval(() => flush(), FLUSH_MS);
  // Never hold the process open on account of analytics.
  timer.unref?.();

  return {
    seen(anonId, kind = "poll", now = Date.now()) {
      if (!anonId || !ID_PATTERN.test(anonId)) return;
      const day = etDay(now);
      if (day !== currentDay) rollover(now, day);
      const cur = today.get(anonId);
      if (cur) {
        cur.lastSeen = now;
        if (kind === "poll") cur.polls++;
        else cur.searches++;
        cur.dirty = true;
      } else {
        today.set(anonId, {
          firstSeen: now,
          lastSeen: now,
          polls: kind === "poll" ? 1 : 0,
          searches: kind === "search" ? 1 : 0,
          dirty: true,
        });
      }
    },

    flush,

    stop() {
      clearInterval(timer);
      flush();
    },

    stats(now = Date.now()) {
      // Make in-memory counters visible to the queries below.
      flush(now);
      const day = etDay(now);
      const since = (days: number) => etDay(now - (days - 1) * 86_400_000);
      const one = <T>(rows: T[]): T | undefined => rows[0];
      const num = (v: unknown) => (typeof v === "number" ? v : 0);

      const distinct = (from?: string) =>
        num(
          one(
            from
              ? db.all<{ n: number }>(
                  sql`SELECT COUNT(DISTINCT anon_id) AS n FROM daily_actives WHERE day >= ${from}`,
                )
              : db.all<{ n: number }>(sql`SELECT COUNT(DISTINCT anon_id) AS n FROM daily_actives`),
          )?.n,
        );

      const todayCount = distinct(day);
      const returningToday = num(
        one(
          db.all<{ n: number }>(sql`
            SELECT COUNT(*) AS n FROM (
              SELECT anon_id FROM daily_actives WHERE day = ${day}
              INTERSECT
              SELECT anon_id FROM daily_actives WHERE day < ${day}
            )`),
        )?.n,
      );

      const everSeen = distinct();
      const repeaters = num(
        one(
          db.all<{ n: number }>(sql`
            SELECT COUNT(*) AS n FROM (
              SELECT anon_id FROM daily_actives GROUP BY anon_id HAVING COUNT(DISTINCT day) >= 2
            )`),
        )?.n,
      );

      // Week-1 retention over browsers that have actually had a week to return.
      const weekAgo = etDay(now - 7 * 86_400_000);
      const cohort = db.all<{ anon_id: string; first_day: string }>(sql`
        SELECT anon_id, MIN(day) AS first_day FROM daily_actives
        GROUP BY anon_id HAVING first_day <= ${weekAgo}`);
      let returnedInWeek = 0;
      for (const c of cohort) {
        const end = etDay(Date.parse(`${c.first_day}T12:00:00Z`) + 7 * 86_400_000);
        const hit = one(
          db.all<{ n: number }>(sql`
            SELECT COUNT(*) AS n FROM daily_actives
            WHERE anon_id = ${c.anon_id} AND day > ${c.first_day} AND day <= ${end}`),
        );
        if (num(hit?.n) > 0) returnedInWeek++;
      }

      const median = (xs: number[]) => {
        if (xs.length === 0) return 0;
        const s = [...xs].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
      };

      const daysActive = db
        .all<{ n: number }>(sql`SELECT COUNT(DISTINCT day) AS n FROM daily_actives GROUP BY anon_id`)
        .map((r) => num(r.n));

      const minutes = db
        .all<{ ms: number }>(sql`
          SELECT (last_seen_ms - first_seen_ms) AS ms FROM daily_actives
          WHERE last_seen_ms > first_seen_ms`)
        .map((r) => num(r.ms) / 60_000);

      const searchesToday = num(
        one(db.all<{ n: number }>(sql`SELECT SUM(searches) AS n FROM daily_actives WHERE day = ${day}`))?.n,
      );

      return {
        today: todayCount,
        last7Days: distinct(since(7)),
        last30Days: distinct(since(30)),
        allTime: everSeen,
        returningToday,
        newToday: todayCount - returningToday,
        repeatRate: everSeen ? repeaters / everSeen : 0,
        week1Retention: cohort.length ? returnedInWeek / cohort.length : null,
        week1Cohort: cohort.length,
        medianDaysActive: median(daysActive),
        medianMinutesPerDay: Math.round(median(minutes) * 10) / 10,
        searchesToday,
        searchesPerRiderToday: todayCount ? Math.round((searchesToday / todayCount) * 10) / 10 : 0,
      };
    },
  };
}
