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
 * The id every verification harness uses. Seeded into `excluded_anon_ids` on
 * startup, so a browser-driving script never has to remember to clean up after
 * itself — and a new harness is excluded the moment it uses this id.
 */
export const TEST_ANON_ID = "00000000-0000-4000-8000-000000000000";

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

/**
 * First ET day the operator statistics count. Monday of launch week: the app
 * went to riders the next day, so everything before it is development traffic.
 */
export const DEFAULT_STATS_SINCE_DAY = "2026-08-31";

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

/** One ET day of the trend series behind the operator dashboard. */
export interface DayHistory {
  /** ET calendar day, "YYYY-MM-DD". */
  day: string;
  riders: number;
  /** Browsers whose FIRST ever day is this day (not merely new to the window). */
  newRiders: number;
  returningRiders: number;
  searches: number;
  medianMinutesPerDay: number;
}

export interface ActivesTracker {
  /** Record activity. Cheap and idempotent; safe on every request. */
  seen(anonId: string | undefined | null, kind?: Activity, now?: number): void;
  /** First ET day the statistics count (see the counting epoch). */
  sinceDay(): string;
  /** Usage and return-visit numbers. */
  stats(now?: number): RiderStats;
  /**
   * Per-day trend, oldest first, over the trailing `days` ET days. Only days
   * that actually have rows appear — a day before the first sighting is
   * absent, not a zero, so a chart cannot imply a launch that never happened.
   */
  history(days?: number, now?: number): DayHistory[];
  /** Write accumulated counters through. Called on a timer and at shutdown. */
  flush(now?: number): void;
  stop(): void;
}

export interface ActivesOptions {
  /**
   * First ET day ("YYYY-MM-DD") the statistics count. Defaults to
   * SHUTTLE_STATS_SINCE_DAY, then DEFAULT_STATS_SINCE_DAY. Tests that seed a
   * synthetic history pass their own.
   */
  sinceDay?: string;
}

export function createActivesTracker(bundle: DbBundle, opts: ActivesOptions = {}): ActivesTracker {
  const db = bundle.db;
  let currentDay = "";
  let today = new Map<string, DayState>();

  const upsert = bundle.sqlite.prepare(`
    INSERT INTO daily_actives (day, anon_id, first_seen_ms, last_seen_ms, polls, searches)
    VALUES (@day, @anonId, @firstSeen, @lastSeen, @polls, @searches)
    ON CONFLICT(day, anon_id) DO UPDATE SET
      -- IFNULL first: SQLite's MIN()/MAX() scalars return NULL if ANY argument
      -- is NULL, so a row written before these columns existed would keep a
      -- NULL timestamp forever and never contribute a session length.
      first_seen_ms = MIN(IFNULL(first_seen_ms, excluded.first_seen_ms), excluded.first_seen_ms),
      last_seen_ms  = MAX(IFNULL(last_seen_ms,  excluded.last_seen_ms),  excluded.last_seen_ms),
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

  /**
   * Every figure the tracker reports excludes flagged browsers AND anything
   * before the counting epoch. Defined once, at tracker scope, so a new
   * statistic cannot silently forget either half.
   *
   * The epoch exists because the operator's numbers should describe the
   * SERVICE, not the build: sightings from before the app was in riders'
   * hands are development traffic, and a browser that only appears there must
   * not make its owner's first real visit read as "returning". Rows before it
   * are still stored (the 90-day sweep owns deletion); they are simply not
   * counted. Override with SHUTTLE_STATS_SINCE_DAY=YYYY-MM-DD.
   */
  const SINCE_DAY = (() => {
    for (const raw of [opts.sinceDay?.trim(), process.env.SHUTTLE_STATS_SINCE_DAY?.trim()]) {
      if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    }
    return DEFAULT_STATS_SINCE_DAY;
  })();
  const notExcluded = sql`day >= ${SINCE_DAY}
    AND anon_id NOT IN (SELECT anon_id FROM excluded_anon_ids)`;

  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };

  const oneDecimal = (v: number) => Math.round(v * 10) / 10;

  const one = <T>(rows: T[]): T | undefined => rows[0];
  const num = (v: unknown) => (typeof v === "number" ? v : 0);

  // Make the harness id excluded from the first run, without a manual step.
  try {
    db.run(sql`INSERT OR IGNORE INTO excluded_anon_ids (anon_id, note)
               VALUES (${TEST_ANON_ID}, 'verification harnesses')`);
  } catch {
    /* pre-migration database — the next boot seeds it */
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

    history(days = 30, now = Date.now()) {
      // Same reason stats() flushes: today's counters live in memory until the
      // timer fires, and the dashboard asks for today.
      flush(now);
      const requested = Number.isFinite(days) ? Math.floor(days) : 30;
      // Never look past the retention horizon: rows older than that are swept,
      // so a wider window would only ever add days that cannot have data.
      const span = Math.max(1, Math.min(RETAIN_DAYS, requested));
      const from = etDay(now - (span - 1) * 86_400_000);

      // One pass for the counts. `firsts` is computed over ALL history rather
      // than the window, so "new" means first ever seen: a browser whose first
      // day predates the window is returning, not new. It aliases anon_id to
      // `fid` so the joined query's bare `anon_id` (and therefore the shared
      // exclusion fragment) is unambiguous.
      const rows = db.all<{
        day: string;
        riders: number;
        newRiders: number;
        searches: number;
      }>(sql`
        WITH firsts AS (
          SELECT anon_id AS fid, MIN(day) AS first_day FROM daily_actives
          WHERE ${notExcluded}
          GROUP BY anon_id
        )
        SELECT day,
               COUNT(*) AS riders,
               SUM(CASE WHEN first_day = day THEN 1 ELSE 0 END) AS newRiders,
               COALESCE(SUM(searches), 0) AS searches
        FROM daily_actives JOIN firsts ON fid = anon_id
        WHERE day >= ${from} AND ${notExcluded}
        GROUP BY day
        ORDER BY day`);

      // SQLite has no median, so the per-day session lengths come back raw and
      // are folded here — one extra statement, not one per day.
      const perDay = new Map<string, number[]>();
      for (const r of db.all<{ day: string; ms: number }>(sql`
        SELECT day, (last_seen_ms - first_seen_ms) AS ms FROM daily_actives
        WHERE day >= ${from} AND last_seen_ms > first_seen_ms AND ${notExcluded}`)) {
        const bucket = perDay.get(r.day);
        if (bucket) bucket.push(num(r.ms) / 60_000);
        else perDay.set(r.day, [num(r.ms) / 60_000]);
      }

      return rows.map((r) => {
        const riders = num(r.riders);
        const newRiders = num(r.newRiders);
        return {
          day: r.day,
          riders,
          newRiders,
          returningRiders: riders - newRiders,
          searches: num(r.searches),
          medianMinutesPerDay: oneDecimal(median(perDay.get(r.day) ?? [])),
        };
      });
    },

    sinceDay() {
      return SINCE_DAY;
    },

    stats(now = Date.now()) {
      // Make in-memory counters visible to the queries below.
      flush(now);
      const day = etDay(now);
      const since = (days: number) => etDay(now - (days - 1) * 86_400_000);


      const distinct = (from?: string) =>
        num(
          one(
            from
              ? db.all<{ n: number }>(
                  sql`SELECT COUNT(DISTINCT anon_id) AS n FROM daily_actives
                      WHERE day >= ${from} AND ${notExcluded}`,
                )
              : db.all<{ n: number }>(
                  sql`SELECT COUNT(DISTINCT anon_id) AS n FROM daily_actives WHERE ${notExcluded}`,
                ),
          )?.n,
        );

      const todayCount = distinct(day);
      const returningToday = num(
        one(
          db.all<{ n: number }>(sql`
            SELECT COUNT(*) AS n FROM (
              SELECT anon_id FROM daily_actives WHERE day = ${day} AND ${notExcluded}
              INTERSECT
              SELECT anon_id FROM daily_actives WHERE day < ${day} AND day >= ${SINCE_DAY}
            )`),
        )?.n,
      );

      const everSeen = distinct();
      const repeaters = num(
        one(
          db.all<{ n: number }>(sql`
            SELECT COUNT(*) AS n FROM (
              SELECT anon_id FROM daily_actives WHERE ${notExcluded}
              GROUP BY anon_id HAVING COUNT(DISTINCT day) >= 2
            )`),
        )?.n,
      );

      // Week-1 retention over browsers that have actually had a week to return.
      const weekAgo = etDay(now - 7 * 86_400_000);
      const cohort = db.all<{ anon_id: string; first_day: string }>(sql`
        SELECT anon_id, MIN(day) AS first_day FROM daily_actives
        WHERE ${notExcluded}
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

      const daysActive = db
        .all<{ n: number }>(
          sql`SELECT COUNT(DISTINCT day) AS n FROM daily_actives
              WHERE ${notExcluded} GROUP BY anon_id`,
        )
        .map((r) => num(r.n));

      const minutes = db
        .all<{ ms: number }>(sql`
          SELECT (last_seen_ms - first_seen_ms) AS ms FROM daily_actives
          WHERE last_seen_ms > first_seen_ms AND ${notExcluded}`)
        .map((r) => num(r.ms) / 60_000);

      const searchesToday = num(
        one(
          db.all<{ n: number }>(
            sql`SELECT SUM(searches) AS n FROM daily_actives
                WHERE day = ${day} AND ${notExcluded}`,
          ),
        )?.n,
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
        medianMinutesPerDay: oneDecimal(median(minutes)),
        searchesToday,
        searchesPerRiderToday: todayCount ? Math.round((searchesToday / todayCount) * 10) / 10 : 0,
      };
    },
  };
}
