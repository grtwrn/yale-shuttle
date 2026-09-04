/**
 * What the rider was actually told, and what then happened.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Every accuracy and stability figure in this project has been a
 * RECONSTRUCTION: replay the arithmetic over stored positions and assert that
 * is what the screen said. It has been wrong more than once and expensively —
 * a whole family of stability numbers turned out to have been measured against
 * a client that had not shipped in months, and a hotfix's before/after got
 * credited to the wrong PR because the harness could not see the change it was
 * measuring. `predictions_log` has existed in the schema, with two readers,
 * and zero rows, the entire time.
 *
 * The ETA is computed in the BROWSER, so only the browser can say what it
 * displayed. Recomputing it on the server would be the same inference that has
 * already failed: the server would be logging what it *would* have said, using
 * whatever code is deployed now, not what the rider's (possibly older, cached)
 * bundle actually put on screen. So the client reports, and every row carries
 * the bundle hash that produced it.
 *
 * ── The privacy shape ──────────────────────────────────────────────────────
 *
 * See the block comment on `predictionsLog` in db/schema.ts — it is the
 * contract, not decoration. In short: a row is a statement about a BUS, no
 * viewer is stored, and the server deduplicates on (bus, stop, quantised
 * instant) so one row means "at least one client had this on screen", never
 * "a rider was standing here".
 *
 * ── The cost shape ─────────────────────────────────────────────────────────
 *
 * `actives.ts` is the precedent and this follows it: nothing writes on a
 * request. Readings accumulate in a Map keyed by the dedup key and the whole
 * batch is flushed on a 60 s timer, one transaction, `INSERT OR IGNORE`. The
 * row count is bounded by (live buses x watched stops x buckets per minute),
 * NOT by rider count — a hundred riders at one stop cost exactly what one
 * costs. Every path here is non-throwing: a failed flush drops a minute of
 * measurement and never touches the response.
 */

import type { DbBundle } from "../db/client.js";
import type { BusPosition } from "../schema/api.js";
import type { TransitNetwork } from "../network/TransitNetwork.js";

/**
 * Time resolution of a logged reading, and therefore the dedup granularity.
 *
 * 15 s is not arbitrary: it is the cadence `scripts/rider-canary.mjs` samples
 * at and the cadence `rider-sim` scores its sequences at, so a logged sequence
 * and a replayed one are directly comparable without resampling either. It is
 * also the whole of the time-truncation in this table — a reading is placed in
 * its bucket, never at the instant it happened.
 */
export const PREDICTION_BUCKET_MS = 15_000;

/**
 * How long rows live. Deliberately SHORTER than the 90 d of `daily_actives`,
 * `arrivals` and `legs`:
 *
 *  - the measurement value decays (nobody scores a two-month-old countdown
 *    against a client six deploys ago), while the storage does not — this is
 *    the only table here whose volume scales with usage rather than with the
 *    fleet;
 *  - `arrivals` outlives it at 90 d, so a prediction is always pairable for as
 *    long as it exists;
 *  - and 30 d is already longer than the 7 d both accuracy readers scan.
 *
 * Shorter is also the safe direction for a table that records what was on a
 * screen. Override with SHUTTLE_PREDICTION_RETAIN_DAYS.
 */
export const DEFAULT_PREDICTION_RETAIN_DAYS = 30;

/**
 * Share of page loads that report. Sampling does not reduce the ROW count much
 * (dedup already bounds that) — it reduces REQUESTS, and it means the existence
 * of a row does not imply any particular browser sent it. The server echoes the
 * live value back on every post, so the operator can dial the fleet down to
 * zero through an env var without a deploy.
 */
export const DEFAULT_SAMPLE_RATE = 0.25;

/** How often accumulated readings reach the database. Matches actives.ts. */
const FLUSH_MS = 60_000;

/**
 * A reading older than this is dropped. Bounds how far back a client (or a
 * spammer) can reach, and keeps a batch that sat in a backgrounded tab from
 * being written as if it were current.
 */
export const MAX_READING_AGE_MS = 120_000;

/** Nothing sane is further out than this; the client caps its own ETAs at 90 min. */
const MAX_ETA_SEC = 2 * 60 * 60;

/** Bound the in-memory batch so a flood cannot grow the heap between flushes. */
const MAX_PENDING = 20_000;

/** Bundle hashes are `[A-Za-z0-9_-]` out of a filename; anything else is dropped. */
const BUILD_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;

/** Window a prediction may be paired with an arrival across. Matches accuracy.ts. */
const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;

/** One reading as the wire carries it, already parsed. */
export interface ShownReading {
  /** As displayed, `#` optional. Resolved against the live fleet server-side. */
  busName: string;
  stopId: number;
  etaSec: number;
  lowSec: number;
  highSec: number;
  stopsAhead: number;
  /**
   * Age of the reading at the moment the batch was sent, in ms — NOT a
   * timestamp. The server owns the clock: a client whose clock is wrong (or
   * lying) would otherwise write rows at instants that never existed, and the
   * whole point of the table is that its instants are trustworthy enough to
   * pair with an arrival.
   */
  ageMs: number;
}

export interface RecordContext {
  buses: readonly BusPosition[];
  network: TransitNetwork;
  clientBuild?: string | null;
  now?: number;
}

/** One logged prediction beside what actually happened. */
export interface PairedPrediction {
  predictedAt: number;
  busName: string;
  routeId: number;
  stopId: number;
  stopsAhead: number;
  predictedSec: number;
  lowSec: number;
  highSec: number;
  clientBuild: string | null;
  /** Epoch ms the bus actually reached the stop, or null when nothing matched. */
  arrivedAt: number | null;
  /** actual wait − predicted wait, in seconds. Positive = the bus was late. */
  errorSec: number | null;
}

export interface PairedSummary {
  /** Predictions in the window. */
  n: number;
  /** ...of which an arrival was found for. */
  paired: number;
  medianAbsErrorSec: number;
  p90AbsErrorSec: number;
  /** Median SIGNED error: negative means the bus beat what riders were told. */
  medianSignedErrorSec: number;
  /** Distinct bundle hashes in the window, most rows first. */
  builds: Array<{ build: string | null; n: number }>;
}

export interface PairedQuery {
  /** Trailing window in hours (default 24, max 720 = the retention). */
  hours?: number | undefined;
  routeId?: number | undefined;
  stopId?: number | undefined;
  busName?: string | undefined;
  build?: string | undefined;
  /** Rows returned (default 200, max 5000). The summary always covers the window. */
  limit?: number | undefined;
  now?: number | undefined;
}

export interface PredictionRecorder {
  /** Share of page loads that should report, 0..1. 0 disables the feature. */
  sampleRate(): number;
  /**
   * Validate and accumulate. Never throws, never writes. Returns how many of
   * the offered readings survived validation — for the response body and for
   * tests, not for the rider.
   */
  record(readings: readonly ShownReading[], ctx: RecordContext): number;
  /** Write accumulated readings through. On a timer, at shutdown, and in tests. */
  flush(now?: number): void;
  /** Logged predictions beside their outcomes. Flushes first. */
  paired(query?: PairedQuery): { summary: PairedSummary; rows: PairedPrediction[] };
  stop(): void;
}

export interface PredictionOptions {
  /** 0..1. Defaults to SHUTTLE_PREDICTION_SAMPLE, then DEFAULT_SAMPLE_RATE. */
  sampleRate?: number;
}

/** `#40` and `40` are the same bus. Upstream serves the former, the client the latter. */
export function normBusName(name: string): string {
  return name.trim().replace(/^#/, "");
}

export function resolveSampleRate(explicit?: number): number {
  const raw = explicit ?? Number(process.env.SHUTTLE_PREDICTION_SAMPLE ?? NaN);
  if (!Number.isFinite(raw)) return DEFAULT_SAMPLE_RATE;
  return Math.max(0, Math.min(1, raw));
}

export function resolveRetainDays(): number {
  const raw = Number(process.env.SHUTTLE_PREDICTION_RETAIN_DAYS ?? NaN);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PREDICTION_RETAIN_DAYS;
  return Math.min(90, Math.floor(raw));
}

interface PendingRow {
  busId: number;
  busName: string;
  routeId: number;
  fromStopId: number;
  toStopId: number;
  stopsAhead: number;
  predictedSec: number;
  predictedLowSec: number;
  predictedHighSec: number;
  predictedAt: number;
  clientBuild: string | null;
}

export function createPredictionRecorder(
  bundle: DbBundle,
  opts: PredictionOptions = {},
): PredictionRecorder {
  const sample = resolveSampleRate(opts.sampleRate);
  let pending = new Map<string, PendingRow>();

  // Prepared once. `OR IGNORE` against `predictions_shown_uniq` is what makes
  // a hundred riders at one stop cost one row, and it is also what makes the
  // FIRST reporter of a bucket the one that counts — a late poster cannot
  // rewrite a value somebody else already established.
  let insert: import("better-sqlite3").Statement | null = null;
  try {
    insert = bundle.sqlite.prepare(`
      INSERT OR IGNORE INTO predictions_log
        (bus_id, bus_name, route_id, from_stop_id, to_stop_id, stops_ahead,
         predicted_sec, predicted_low_sec, predicted_high_sec, predicted_at,
         client_build)
      VALUES
        (@busId, @busName, @routeId, @fromStopId, @toStopId, @stopsAhead,
         @predictedSec, @predictedLowSec, @predictedHighSec, @predictedAt,
         @clientBuild)
    `);
  } catch {
    // Pre-migration database. Recording degrades to a no-op rather than
    // throwing on every post.
  }

  function flush(_now = Date.now()): void {
    if (pending.size === 0 || !insert) return;
    const rows = [...pending.values()];
    pending = new Map();
    try {
      bundle.sqlite.transaction(() => {
        for (const r of rows) insert!.run(r);
      })();
    } catch {
      // Measurement must never break the endpoint. A dropped batch costs a
      // minute of readings; re-queueing a failing batch would cost the heap.
    }
  }

  const timer = setInterval(() => flush(), FLUSH_MS);
  timer.unref?.();

  function record(readings: readonly ShownReading[], ctx: RecordContext): number {
    if (sample <= 0 || !insert) return 0;
    let accepted = 0;
    try {
      const now = ctx.now ?? Date.now();
      const build = typeof ctx.clientBuild === "string" && BUILD_PATTERN.test(ctx.clientBuild)
        ? ctx.clientBuild
        : null;

      // The live fleet is the authority on which vehicle a name refers to and
      // which route it is on, so a client cannot assert either. It also means
      // a reading about a bus that is not running is simply dropped.
      const fleet = new Map<string, BusPosition>();
      for (const b of ctx.buses) fleet.set(normBusName(b.busName), b);

      for (const r of readings) {
        if (pending.size >= MAX_PENDING) break;
        const bus = fleet.get(normBusName(r.busName ?? ""));
        if (!bus) continue;
        if (!Number.isFinite(r.ageMs) || r.ageMs < 0 || r.ageMs > MAX_READING_AGE_MS) continue;
        if (!Number.isFinite(r.etaSec) || r.etaSec < 0 || r.etaSec > MAX_ETA_SEC) continue;
        if (!Number.isFinite(r.lowSec) || !Number.isFinite(r.highSec)) continue;
        if (r.lowSec < 0 || r.highSec < r.lowSec || r.highSec > MAX_ETA_SEC * 2) continue;
        if (!Number.isInteger(r.stopsAhead) || r.stopsAhead < 1 || r.stopsAhead > 200) continue;
        if (!Number.isInteger(r.stopId)) continue;

        // The stop must be one this bus's route actually serves. Cheap, and it
        // is the difference between "a reading" and "an arbitrary row a
        // stranger chose to write".
        const positions = ctx.network.routeStopPositions.get(bus.routeId)?.get(r.stopId);
        if (!positions || positions.length === 0) continue;

        // The server owns the clock (see ShownReading.ageMs) and quantises.
        const at = Math.floor((now - r.ageMs) / PREDICTION_BUCKET_MS) * PREDICTION_BUCKET_MS;
        const key = `${bus.busId}:${r.stopId}:${at}`;
        if (pending.has(key)) {
          // Same bucket, same vehicle, same stop: one row. First writer wins
          // here exactly as it does in SQLite, so the two layers agree.
          accepted++;
          continue;
        }
        pending.set(key, {
          busId: bus.busId,
          busName: bus.busName,
          routeId: bus.routeId,
          // The anchor the client priced from is not on the wire (it would be
          // one more field describing where the bus is, which the payload
          // already says). `last_stop_id` is the server's own view of it.
          fromStopId: bus.lastStopId ?? -1,
          toStopId: r.stopId,
          stopsAhead: r.stopsAhead,
          predictedSec: r.etaSec,
          predictedLowSec: r.lowSec,
          predictedHighSec: r.highSec,
          predictedAt: at,
          clientBuild: build,
        });
        accepted++;
      }
    } catch {
      // Never break the endpoint.
    }
    return accepted;
  }

  return {
    sampleRate: () => sample,
    record,
    flush,
    stop() {
      clearInterval(timer);
      flush();
    },
    paired(query: PairedQuery = {}) {
      flush();
      const now = query.now ?? Date.now();
      const hours = clampInt(query.hours, 24, 1, 24 * 90);
      const limit = clampInt(query.limit, 200, 1, 5000);
      const from = now - hours * 3_600_000;

      let preds: PredRow[] = [];
      try {
        const filters: string[] = ["predicted_at >= ?"];
        const args: Array<string | number> = [from];
        if (query.routeId !== undefined) { filters.push("route_id = ?"); args.push(query.routeId); }
        if (query.stopId !== undefined) { filters.push("to_stop_id = ?"); args.push(query.stopId); }
        if (query.busName !== undefined) { filters.push("bus_name = ?"); args.push(`#${normBusName(query.busName)}`); }
        if (query.build !== undefined) { filters.push("client_build = ?"); args.push(query.build); }
        preds = bundle.sqlite
          .prepare(
            `SELECT bus_name, route_id, to_stop_id, stops_ahead, predicted_sec,
                    predicted_low_sec, predicted_high_sec, predicted_at, client_build
             FROM predictions_log WHERE ${filters.join(" AND ")}
             ORDER BY predicted_at ASC`,
          )
          .all(...args) as PredRow[];
      } catch {
        preds = [];
      }

      if (preds.length === 0) {
        return { summary: emptySummary(), rows: [] };
      }

      // Pair on bus_NAME, not bus_id: `bus_id` is reissued per service block
      // (~1,000 ids for 50 buses in 30 days) and the name is the identity. The
      // two pre-existing accuracy readers join on the id; they are older than
      // that finding and are left alone rather than quietly changed here.
      const earliest = preds[0]!.predicted_at;
      const latest = preds[preds.length - 1]!.predicted_at + MATCH_WINDOW_MS;
      let arrivals: ArrivalRow[] = [];
      try {
        arrivals = bundle.sqlite
          .prepare(
            `SELECT bus_name, route_id, stop_id, arrived_at FROM arrivals
             WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at ASC`,
          )
          .all(earliest, latest) as ArrivalRow[];
      } catch {
        arrivals = [];
      }

      const index = new Map<string, number[]>();
      for (const a of arrivals) {
        const key = `${normBusName(a.bus_name)}:${a.route_id}:${a.stop_id}`;
        const list = index.get(key);
        if (list) list.push(a.arrived_at);
        else index.set(key, [a.arrived_at]);
      }

      const rows: PairedPrediction[] = [];
      const abs: number[] = [];
      const signed: number[] = [];
      const builds = new Map<string | null, number>();
      for (const p of preds) {
        builds.set(p.client_build, (builds.get(p.client_build) ?? 0) + 1);
        const list = index.get(`${normBusName(p.bus_name)}:${p.route_id}:${p.to_stop_id}`);
        const actual = list ? firstAtLeast(list, p.predicted_at) : null;
        const matched = actual !== null && actual <= p.predicted_at + MATCH_WINDOW_MS ? actual : null;
        const errorSec = matched === null
          ? null
          : (matched - p.predicted_at) / 1000 - p.predicted_sec;
        if (errorSec !== null) {
          abs.push(Math.abs(errorSec));
          signed.push(errorSec);
        }
        rows.push({
          predictedAt: p.predicted_at,
          busName: p.bus_name,
          routeId: p.route_id,
          stopId: p.to_stop_id,
          stopsAhead: p.stops_ahead,
          predictedSec: p.predicted_sec,
          lowSec: p.predicted_low_sec,
          highSec: p.predicted_high_sec,
          clientBuild: p.client_build,
          arrivedAt: matched,
          errorSec,
        });
      }

      return {
        summary: {
          n: preds.length,
          paired: abs.length,
          medianAbsErrorSec: pct(abs, 0.5),
          p90AbsErrorSec: pct(abs, 0.9),
          medianSignedErrorSec: pct(signed, 0.5),
          builds: [...builds.entries()]
            .map(([build, n]) => ({ build, n }))
            .sort((a, b) => b.n - a.n),
        },
        // Newest first: the operator asking "what did we just say" wants the
        // tail, and the window's summary above already covers everything.
        rows: rows.slice(-limit).reverse(),
      };
    },
  };
}

// ---------------------------------------------------------------------------

interface PredRow {
  bus_name: string;
  route_id: number;
  to_stop_id: number;
  stops_ahead: number;
  predicted_sec: number;
  predicted_low_sec: number;
  predicted_high_sec: number;
  predicted_at: number;
  client_build: string | null;
}

interface ArrivalRow {
  bus_name: string;
  route_id: number;
  stop_id: number;
  arrived_at: number;
}

function emptySummary(): PairedSummary {
  return {
    n: 0,
    paired: 0,
    medianAbsErrorSec: 0,
    p90AbsErrorSec: 0,
    medianSignedErrorSec: 0,
    builds: [],
  };
}

function clampInt(v: number | undefined, dflt: number, lo: number, hi: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

function pct(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return Math.round(s[i]! * 10) / 10;
}

/** First element of a sorted ascending list ≥ target, or null. */
function firstAtLeast(sorted: readonly number[], target: number): number | null {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length ? sorted[lo]! : null;
}
