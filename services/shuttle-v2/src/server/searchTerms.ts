/**
 * What riders search for, so lookup can be fixed with evidence.
 *
 * Two questions this answers and nothing else did:
 *   - which searches find NOTHING (a place worth adding),
 *   - which searches are common (matching worth tuning).
 *
 * Both were previously answered by reading rider reports one at a time:
 * "one6three" and "ice rink" each cost a report, a triage note and a code
 * change, and only because somebody bothered to write in. Most riders who
 * fail to find a place just leave.
 *
 * PRIVACY — read before extending this. A destination is the most revealing
 * thing this app ever handles. Rows are keyed by (ET day, normalised query)
 * and hold counts, so:
 *   - no anon id, no IP, no user agent, no time of day, no session;
 *   - two searches by one rider and one search by two riders are one row;
 *   - nothing here can reconstruct a person's movements.
 * Do not add a column that narrows a row towards one person. If a future
 * question needs that, it is the wrong question.
 */
import { sql } from "drizzle-orm";

import type { DbBundle } from "../db/client.js";
import { etDay } from "./actives.js";

/** Flushed on a timer, like the rider counters — never a write per request. */
const FLUSH_MS = 60_000;
/** Shorter than the 90 days the rider counts keep: a month finds a missing place. */
const RETAIN_DAYS = 30;
/** Longer queries are truncated; the tail is never the useful part. */
const MAX_Q_LEN = 60;
/**
 * Below this a query is a prefix on the way to a word, not a question. The
 * lookup itself already ignores anything shorter for the same reason.
 */
const MIN_Q_LEN = 3;

export interface SearchTermRow {
  q: string;
  n: number;
  zero: number;
}

export interface SearchTermsReport {
  /** Most-searched terms over the window. */
  top: SearchTermRow[];
  /** Terms that found nothing — the places to add, longest form first. */
  missing: SearchTermRow[];
  /** Totals over the window. */
  searches: number;
  zeroSearches: number;
  distinctTerms: number;
  days: number;
}

export interface SearchTermsTracker {
  /** Record one search. Never throws; a failure here must not cost a lookup. */
  record(query: string, resultCount: number, now?: number): void;
  report(days?: number, limit?: number, now?: number): SearchTermsReport;
  flush(now?: number): void;
  stop(): void;
}

/**
 * Lower-case, collapse whitespace, drop the punctuation a rider's spelling
 * varies on. Deliberately the same shape of normalisation the matcher uses,
 * so "Elena's" and "elenas" are one row rather than two.
 */
export function normalizeQuery(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['''’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_Q_LEN);
}

/**
 * Drop terms that are a strict prefix of a longer term in the same list.
 *
 * The lookup fires on a debounce as the rider types, so "one6", "one6t" and
 * "one6three" all reach the server on the way to one question. Keeping the
 * prefixes would bury the actual query under its own keystrokes — and it is
 * the longest form that names the place worth adding.
 */
export function collapsePrefixes(rows: SearchTermRow[]): SearchTermRow[] {
  const byLength = [...rows].sort((a, b) => b.q.length - a.q.length);
  const kept: SearchTermRow[] = [];
  for (const r of byLength) {
    if (kept.some((k) => k.q.startsWith(r.q))) continue;
    kept.push(r);
  }
  return kept.sort((a, b) => b.n - a.n || a.q.localeCompare(b.q));
}

export function createSearchTermsTracker(bundle: DbBundle): SearchTermsTracker {
  const db = bundle.db;
  let currentDay = "";
  let pending = new Map<string, { n: number; zero: number }>();

  const upsert = bundle.sqlite.prepare(`
    INSERT INTO search_terms (day, q, n, zero) VALUES (@day, @q, @n, @zero)
    ON CONFLICT(day, q) DO UPDATE SET
      -- ADDED, not replaced: this process only knows its own tally since the
      -- last flush, and a restart must not throw away the day's earlier
      -- counts (the mistake daily_actives made, see actives.ts).
      n    = n + excluded.n,
      zero = zero + excluded.zero
  `);

  function flush(now = Date.now()): void {
    if (pending.size === 0) return;
    const day = currentDay || etDay(now);
    const rows = [...pending.entries()];
    pending = new Map();
    try {
      bundle.sqlite.transaction(() => {
        for (const [q, v] of rows) upsert.run({ day, q, n: v.n, zero: v.zero });
      })();
    } catch {
      /* counting must never break a lookup; the tally is simply lost */
    }
  }

  const timer = setInterval(() => flush(), FLUSH_MS);
  timer.unref?.();

  return {
    record(query, resultCount, now = Date.now()) {
      try {
        const q = normalizeQuery(query ?? "");
        if (q.length < MIN_Q_LEN) return;
        const day = etDay(now);
        if (day !== currentDay) {
          flush(now);
          currentDay = day;
          try {
            db.run(sql`DELETE FROM search_terms WHERE day < ${etDay(now - RETAIN_DAYS * 86_400_000)}`);
          } catch {
            /* a failed sweep must never break a request */
          }
        }
        const cur = pending.get(q) ?? { n: 0, zero: 0 };
        cur.n += 1;
        if (resultCount <= 0) cur.zero += 1;
        pending.set(q, cur);
      } catch {
        /* see above */
      }
    },

    report(days = 30, limit = 25, now = Date.now()) {
      flush(now);
      const span = Math.max(1, Math.min(RETAIN_DAYS, Math.floor(days) || 30));
      const from = etDay(now - (span - 1) * 86_400_000);
      const rows = db.all<{ q: string; n: number; zero: number }>(sql`
        SELECT q, SUM(n) AS n, SUM(zero) AS zero
        FROM search_terms WHERE day >= ${from}
        GROUP BY q ORDER BY n DESC`);
      const cap = Math.max(1, Math.min(200, Math.floor(limit) || 25));
      // A term counts as "missing" only when it NEVER found anything: a query
      // that works most of the time and missed once is a flaky upstream, not
      // a gap in the list.
      const missing = collapsePrefixes(rows.filter((r) => r.zero >= r.n));
      return {
        top: collapsePrefixes(rows).slice(0, cap),
        missing: missing.slice(0, cap),
        searches: rows.reduce((s, r) => s + r.n, 0),
        zeroSearches: rows.reduce((s, r) => s + r.zero, 0),
        distinctTerms: rows.length,
        days: span,
      };
    },

    flush,
    stop() {
      clearInterval(timer);
      flush();
    },
  };
}
