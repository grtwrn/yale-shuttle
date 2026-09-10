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

/**
 * The head-to-head's horizon cap, applied to BOTH arms.
 *
 * `routes_eta.php` never publishes an ETA past 30 min, so every official row
 * is inside this by construction, while the route cards log a stop 40 min
 * out as readily as one 4 min out. In the 24 h ending 2026-09-06 11:25 ET,
 * 41 of our 88 rows (47%) promised more than 30 min, and those rows carried
 * most of the error (30–60 min: median 1,076 s) — the dashboard was scoring
 * our far horizon against their near one and reading "the official app is
 * better". Trimming ours to their reach is the first half of like-for-like;
 * the other half is the standing rule below. See
 * docs/upstream-eta-measurement.md, "The live etaVsOfficial number".
 */
export const COMPARE_HORIZON_SEC = 30 * 60;

/**
 * Pairing window for the head-to-head, narrower than {@link MATCH_WINDOW_MS}.
 * With every promise capped at 30 min, an arrival 45 min later is not a late
 * bus but a missed detection paired to the next lap; 2 h would score it as an
 * error of one loop. This is the replay's `MATCH_MS`
 * (scripts/eta-replay/upstream-eta-common.ts), so the two agree.
 */
export const COMPARE_MATCH_WINDOW_MS = 45 * 60 * 1000;

/**
 * How far back the standing check looks for the bus's current visit. A
 * layover is minutes, not hours; an `arrivals` row with no `departed_at`
 * further back than this is one the detector never closed (the bus dropped
 * off the feed), not a bus still standing there.
 */
export const STANDING_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** One reading as the wire carries it, already parsed. */
/**
 * The screens that report. A closed set on purpose: it is part of the dedup
 * key, so an unrecognised value would silently create a parallel population
 * rather than an obvious error. Anything else is recorded as `trip`-less and
 * dropped by `parseShownBatch`.
 */
export const SHOWN_SURFACES = ["trip", "ride", "card"] as const;
export type ShownSurface = (typeof SHOWN_SURFACES)[number];
export function isShownSurface(x: unknown): x is ShownSurface {
  return typeof x === "string" && (SHOWN_SURFACES as readonly string[]).includes(x);
}

/**
 * The operator's OWN prediction for the same bus at the same stop, collected
 * from `routes_eta.php` by `collector/upstreamEta.ts`. It shares this table
 * because it is the same kind of statement about the same fleet, pairs against
 * the same `arrivals` rows, and inherits the same dedup key and retention.
 *
 * It is deliberately NOT a member of {@link SHOWN_SURFACES}. That list is the
 * WIRE allowlist — what a browser may claim it displayed — and `upstream` must
 * never be claimable from outside, or anyone could post rows into the arm we
 * score ourselves against and the comparison would measure nothing. The two
 * lists are separate for exactly that reason; `isShownSurface` still guards
 * `/api/shown`, and only the in-process poller writes this value.
 */
export const UPSTREAM_SURFACE = "upstream";

/**
 * What the SERVER-SIDE belief would have said, recorded beside what the
 * browser actually showed (docs/server-side-eta.md). The dual run.
 *
 * The two are the same function over the same payload; they differ only in
 * how WARM the belief behind them is — the browser's opens when the rider
 * opens the app, the server's has been tracking all day. So a divergence
 * here is precisely the effect of the switch, on the very (bus, stop,
 * instant) a rider was looking at, scored against the same `arrivals` rows by
 * the same `truthAt` rule. A comparison is a query rather than an argument.
 *
 * Like {@link UPSTREAM_SURFACE} it is deliberately NOT a member of
 * {@link SHOWN_SURFACES} — that list is the WIRE allowlist, what a browser
 * may claim it displayed. If a client could post `server`, anyone could write
 * into the arm we are about to judge a rider-facing switch on. Only the
 * in-process engine writes this value.
 *
 * And it is NOT a rider surface either: nothing under it was ever on a screen.
 * {@link RIDER_SURFACES_SQL} excludes it for the same reason it excludes
 * `upstream`, and for a sharper one — pooling a shadow arm into "how accurate
 * are WE" would let a candidate flatter its own measurement.
 */
export const SERVER_SURFACE = "server";

/** Every value the `surface` COLUMN may hold. A superset of the wire list. */
export const PREDICTION_SURFACES = [...SHOWN_SURFACES, UPSTREAM_SURFACE, SERVER_SURFACE] as const;
export type PredictionSurface = (typeof PREDICTION_SURFACES)[number];
/**
 * Guards a READ, not a write. `/api/predictions?surface=…` names which arm to
 * report on; `isShownSurface` still guards what a browser may claim it showed.
 */
export function isPredictionSurface(x: unknown): x is PredictionSurface {
  return typeof x === "string" && (PREDICTION_SURFACES as readonly string[]).includes(x);
}

/**
 * The predicate EVERY reader of "how accurate are WE" must carry.
 *
 * `predictions_log` stopped being one population the moment the operator's own
 * ETAs landed in it, and a scan with no surface clause silently pools two apps.
 * It is not hypothetical: within an hour of the poller shipping, `/api/predictions`
 * reported n=3056 of which 1586 were upstream rows, and the v1-compat
 * `/api/accuracy` — the number RIDERS see — would have done the same. That is
 * precisely the inference error the `surface` column exists to prevent, so the
 * fragment lives in one place and every reader spells it the same way.
 *
 * A reader that genuinely wants the operator's arm — or the server-side
 * shadow — asks for it explicitly. The list grows with every arm that is not
 * a rider's screen; `predictions.test.ts` fails if a member of
 * {@link PREDICTION_SURFACES} that is not a {@link SHOWN_SURFACES} member goes
 * unnamed here.
 */
export const RIDER_SURFACES_SQL = "surface NOT IN ('upstream', 'server')";

export interface ShownReading {
  /** As displayed, `#` optional. Resolved against the live fleet server-side. */
  busName: string;
  stopId: number;
  etaSec: number;
  lowSec: number;
  highSec: number;
  stopsAhead: number;
  /** Which screen showed it. See `predictionsLog.surface`. */
  surface: ShownSurface;
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
  /**
   * Which arm. Defaults to the rider-reported surfaces — see
   * {@link RIDER_SURFACES_SQL}. Pass `"upstream"` to read the operator's.
   */
  surface?: string | undefined;
  /** Rows returned (default 200, max 5000). The summary always covers the window. */
  limit?: number | undefined;
  now?: number | undefined;
}

/**
 * Below this many paired rows in an arm, the dashboard says nothing at all.
 *
 * A comparison is a claim about which app is better, and an hour of thin
 * coverage will produce a number that flips sign the next hour. Refusing to
 * print is the honest failure; printing "n = 6" and hoping the reader notices
 * is not.
 */
export const MIN_COMPARE_PAIRS = 50;

/** The two statistics every arm reports. */
export interface ErrorStats {
  medianAbsErrorSec: number;
  /** Share of paired rows within 120 s, as a percentage to one decimal. */
  within120Pct: number;
}

/** One arm of the head-to-head, already paired against real arrivals. */
export interface ArmAccuracy extends ErrorStats {
  /** Predictions in the window for this arm, before any rule is applied. */
  n: number;
  /** ...promising more than {@link COMPARE_HORIZON_SEC}. Dropped. */
  beyondHorizon: number;
  /**
   * ...made while the bus was already standing at the predicted stop.
   * Dropped: not a forecast, and under the plain "first arrival at or after"
   * rule they scored as a whole lap of error.
   */
  standing: number;
  /** ...of which an arrival was found for. Only these feed the statistics. */
  paired: number;
}

/**
 * Both arms on the SAME (bus, stop, minute) — the only controlled read the
 * log can give. `ours` and `official` are null below {@link MIN_COMPARE_PAIRS}
 * pairs; `n` is always reported so the operator can see why.
 */
export interface SharedPairs {
  n: number;
  ours: ErrorStats | null;
  official: ErrorStats | null;
}

/**
 * Ours against the operator's, on the same arrivals, like for like.
 *
 * `official` is `surface = "upstream"` — `routes_eta.php`, whole minutes, so
 * ~±30 s of its error is rounding; `ours` is every rider-reported surface
 * pooled. Three rules make the two arms comparable, and every one was set by
 * measurement (docs/upstream-eta-measurement.md, "The live etaVsOfficial
 * number"):
 *
 *  1. **One horizon.** Rows promising more than {@link COMPARE_HORIZON_SEC}
 *     are dropped from both arms — upstream has none, ours had 47%.
 *  2. **A standing bus is not a forecast.** A row whose bus is already at the
 *     predicted stop at `predicted_at` (its latest `arrivals` row there has
 *     not departed yet) is dropped from both arms. Both apps print ~0 while a
 *     layover runs, and the "first arrival at or after" is the NEXT visit, a
 *     lap away: under that rule upstream's 0–2 min bucket read a median error
 *     of 2,627 s, and 35 s once standing rows were excluded. The replay
 *     measured that scoring them as 0 instead moves neither arm's ranking, so
 *     exclusion — the symmetric, simpler reading — is what both the replay and
 *     this do. `standing` reports how many.
 *  3. **Same moment, same arrival.** `shared` scores only the (bus, stop,
 *     minute) both arms predicted, paired to the same arrival. The per-arm
 *     numbers still cover different stop populations (see `upstreamEta.ts`),
 *     so `shared` is the ranking and the arms are the shape.
 *
 * The whole thing is null until both arms have {@link MIN_COMPARE_PAIRS}
 * paired rows under these rules.
 */
export interface OfficialComparison {
  hours: number;
  /** {@link COMPARE_HORIZON_SEC}, echoed so the dashboard labels itself. */
  horizonCapSec: number;
  /** {@link COMPARE_MATCH_WINDOW_MS} in seconds. */
  matchWindowSec: number;
  /** {@link MIN_COMPARE_PAIRS}, echoed for the same reason. */
  minPairs: number;
  ours: ArmAccuracy;
  official: ArmAccuracy;
  shared: SharedPairs;
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
  /**
   * What a SHADOW arm would have said for the same (bus, stop) pairs a rider
   * just reported — {@link SERVER_SURFACE}, the dual run.
   *
   * It is deliberately driven by a rider's post rather than by a timer. A
   * shadow row is only worth writing where a rider row exists to compare it
   * against, and pinning the volume to the rider surface's own is what keeps
   * this off the disk arithmetic that gave `upstream` its separate 7-day
   * sweep (120k rows a day against the surfaces' 3k).
   *
   * Same validation, same dedup key, same 60 s flush, same non-throwing
   * contract. The caller supplies the surface, and it must not be a
   * {@link SHOWN_SURFACES} member — a shadow is not a screen.
   */
  shadow(readings: readonly ShownReading[], surface: PredictionSurface, ctx: RecordContext): number;
  /** Write accumulated readings through. On a timer, at shutdown, and in tests. */
  flush(now?: number): void;
  /** Logged predictions beside their outcomes. Flushes first. */
  paired(query?: PairedQuery): { summary: PairedSummary; rows: PairedPrediction[] };
  /**
   * Ours against the operator's over a trailing window. Null when either arm
   * has fewer than {@link MIN_COMPARE_PAIRS} paired rows — see the constant.
   */
  officialComparison(hours?: number, now?: number): OfficialComparison | null;
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
  /**
   * A rider's screen, or one of the shadow arms. The wire is still guarded by
   * `isShownSurface` — this widens what the COLUMN may hold, never what a
   * request may assert.
   */
  surface: PredictionSurface;
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
         client_build, surface)
      VALUES
        (@busId, @busName, @routeId, @fromStopId, @toStopId, @stopsAhead,
         @predictedSec, @predictedLowSec, @predictedHighSec, @predictedAt,
         @clientBuild, @surface)
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

  /**
   * @param as the surface to file under. `null` means "a rider's own screen",
   *   and then `r.surface` is used and must pass `isShownSurface` — the wire
   *   allowlist. A non-null value is a SHADOW arm and is never claimable from
   *   outside; `record` cannot reach this parameter at all.
   */
  function record(readings: readonly ShownReading[], ctx: RecordContext, as: PredictionSurface | null = null): number {
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
        // The wire allowlist, and only for a rider's own claim. A shadow arm's
        // surface comes from the caller, in process, and is checked once
        // outside the loop.
        if (as === null && !isShownSurface(r.surface)) continue;
        const surface: PredictionSurface = as ?? r.surface;

        // The stop must be one this bus's route actually serves. Cheap, and it
        // is the difference between "a reading" and "an arbitrary row a
        // stranger chose to write".
        const positions = ctx.network.routeStopPositions.get(bus.routeId)?.get(r.stopId);
        if (!positions || positions.length === 0) continue;

        // The server owns the clock (see ShownReading.ageMs) and quantises.
        const at = Math.floor((now - r.ageMs) / PREDICTION_BUCKET_MS) * PREDICTION_BUCKET_MS;
        const key = `${bus.busId}:${r.stopId}:${at}:${surface}`;
        if (pending.has(key)) {
          // Same bucket, same vehicle, same stop, same screen: one row. First
          // writer wins here exactly as it does in SQLite, so the two layers
          // agree — and the key carries the surface for the same reason the
          // index does (see `predictionsLog.surface`).
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
          surface,
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
    record: (readings, ctx) => record(readings, ctx),
    shadow: (readings, surface, ctx) => (
      // A shadow may not impersonate a screen. Enforced here rather than by
      // the type alone, because the whole point of the two lists is that the
      // separation survives a careless caller.
      isShownSurface(surface) ? 0 : record(readings, ctx, surface)
    ),
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
        // The surface clause is NOT optional. Without it this reader pools our
        // app with the operator's — see RIDER_SURFACES_SQL.
        const filters: string[] = ["predicted_at >= ?"];
        const args: Array<string | number> = [from];
        if (query.surface !== undefined) { filters.push("surface = ?"); args.push(query.surface); }
        else filters.push(RIDER_SURFACES_SQL);
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

    officialComparison(hours = 24, nowMs?: number): OfficialComparison | null {
      flush();
      const now = nowMs ?? Date.now();
      const window = clampInt(hours, 24, 1, 24 * 90);
      const from = now - window * 3_600_000;

      let rows: SurfacePredRow[] = [];
      try {
        rows = bundle.sqlite
          .prepare(
            `SELECT bus_name, route_id, to_stop_id, predicted_sec, predicted_at, surface
             FROM predictions_log WHERE predicted_at >= ? ORDER BY predicted_at ASC`,
          )
          .all(from) as SurfacePredRow[];
      } catch {
        return null;
      }
      if (rows.length === 0) return null;

      // Arrivals from STANDING_LOOKBACK_MS before the first prediction (the
      // visit a bus may still be standing on) to the match window after the
      // last. `arrivals_time_idx` serves the range; one scan for both arms.
      const earliest = rows[0]!.predicted_at - STANDING_LOOKBACK_MS;
      const latest = rows[rows.length - 1]!.predicted_at + COMPARE_MATCH_WINDOW_MS;
      let arrivals: VisitRow[] = [];
      try {
        arrivals = bundle.sqlite
          .prepare(
            `SELECT bus_name, route_id, stop_id, arrived_at, departed_at FROM arrivals
             WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at ASC`,
          )
          .all(earliest, latest) as VisitRow[];
      } catch {
        return null;
      }
      const index = new Map<string, Visit[]>();
      for (const a of arrivals) {
        const key = `${normBusName(a.bus_name)}:${a.route_id}:${a.stop_id}`;
        const visit = { t: a.arrived_at, d: a.departed_at };
        const list = index.get(key);
        if (list) list.push(visit);
        else index.set(key, [visit]);
      }

      const ours = new ArmTally();
      const theirs = new ArmTally();
      // Earliest scored row per (bus, stop, minute) on each side, for `shared`.
      const ourMoments = new Map<string, ScoredMoment>();
      const theirMoments = new Map<string, ScoredMoment>();
      for (const r of rows) {
        const official = r.surface === UPSTREAM_SURFACE;
        const tally = official ? theirs : ours;
        tally.n += 1;
        // Rule 1: one horizon for both arms.
        if (r.predicted_sec > COMPARE_HORIZON_SEC) {
          tally.beyondHorizon += 1;
          continue;
        }
        const bus = normBusName(r.bus_name);
        const truth = truthAt(index.get(`${bus}:${r.route_id}:${r.to_stop_id}`), r.predicted_at);
        // Rule 2: a bus already standing at the stop is not being forecast.
        if (truth.kind === "standing") {
          tally.standing += 1;
          continue;
        }
        if (truth.kind === "missing") continue;
        const err = (truth.at - r.predicted_at) / 1000 - r.predicted_sec;
        tally.errs.push(err);
        // Rule 3's raw material: the minute is the resolution of upstream's
        // clock, and the first row in a minute is the one nearest its start.
        const moment = `${bus}:${r.to_stop_id}:${Math.floor(r.predicted_at / 60_000)}`;
        const moments = official ? theirMoments : ourMoments;
        if (!moments.has(moment)) moments.set(moment, { arrivedAt: truth.at, err });
      }

      if (ours.errs.length < MIN_COMPARE_PAIRS || theirs.errs.length < MIN_COMPARE_PAIRS) {
        return null;
      }

      // Rule 3: the same moment must also have resolved to the same arrival —
      // two rows a minute apart straddling a departure are not one moment.
      const sharedOurs: number[] = [];
      const sharedTheirs: number[] = [];
      for (const [moment, mine] of ourMoments) {
        const other = theirMoments.get(moment);
        if (!other || other.arrivedAt !== mine.arrivedAt) continue;
        sharedOurs.push(mine.err);
        sharedTheirs.push(other.err);
      }
      const enough = sharedOurs.length >= MIN_COMPARE_PAIRS;

      return {
        hours: window,
        horizonCapSec: COMPARE_HORIZON_SEC,
        matchWindowSec: COMPARE_MATCH_WINDOW_MS / 1000,
        minPairs: MIN_COMPARE_PAIRS,
        ours: ours.arm(),
        official: theirs.arm(),
        shared: {
          n: sharedOurs.length,
          ours: enough ? errorStats(sharedOurs) : null,
          official: enough ? errorStats(sharedTheirs) : null,
        },
      };
    },
  };
}

/** Running counts for one arm of {@link OfficialComparison}. */
class ArmTally {
  n = 0;
  beyondHorizon = 0;
  standing = 0;
  errs: number[] = [];
  arm(): ArmAccuracy {
    return {
      n: this.n,
      beyondHorizon: this.beyondHorizon,
      standing: this.standing,
      paired: this.errs.length,
      ...errorStats(this.errs),
    };
  }
}

function errorStats(errs: readonly number[]): ErrorStats {
  const abs = errs.map((e) => Math.abs(e));
  const within = abs.filter((a) => a <= 120).length;
  return {
    medianAbsErrorSec: pct(abs, 0.5),
    within120Pct: errs.length === 0 ? 0 : Math.round((within / errs.length) * 1000) / 10,
  };
}

/** One `arrivals` row as the comparison sees it: when, and whether it has ended. */
export interface Visit {
  t: number;
  /** null while the detector has not seen the bus leave. */
  d: number | null;
}

interface ScoredMoment {
  arrivedAt: number;
  err: number;
}

export type Truth =
  | { kind: "arrived"; at: number }
  | { kind: "standing" }
  | { kind: "missing" };

/**
 * What actually happened to a prediction made at `at` for this (bus, route,
 * stop). The rule is the replay's `truthFor` (upstream-eta-common.ts):
 *
 *  - the bus's latest visit at or before `at` has not departed by `at` — it
 *    is STANDING there, and the prediction is not a forecast;
 *  - otherwise the first arrival at or after `at`, within the match window;
 *  - otherwise nothing usable.
 *
 * An unclosed visit older than {@link STANDING_LOOKBACK_MS} is not "standing":
 * the detector lost the bus, and the row would otherwise flag every later
 * prediction at that stop for as long as it existed.
 *
 * Exported because the scorecard (scorecard.ts) scores every arm under THIS
 * rule and no other: the dashboard's head-to-head, the hourly scorecard and
 * the replay must agree on what "the truth" is, or their numbers cannot be
 * read against each other.
 */
export function truthAt(visits: readonly Visit[] | undefined, at: number): Truth {
  if (!visits || visits.length === 0) return { kind: "missing" };
  const i = lowerBound(visits, at);
  if (i > 0) {
    const prev = visits[i - 1]!;
    const stillThere = prev.d === null || prev.d >= at;
    if (stillThere && at - prev.t <= STANDING_LOOKBACK_MS) return { kind: "standing" };
  }
  if (i < visits.length && visits[i]!.t - at <= COMPARE_MATCH_WINDOW_MS) {
    return { kind: "arrived", at: visits[i]!.t };
  }
  return { kind: "missing" };
}

/** Index of the first visit with `t >= at` in an ascending list. */
function lowerBound(visits: readonly Visit[], at: number): number {
  let lo = 0;
  let hi = visits.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (visits[mid]!.t < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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

/** The columns `officialComparison` needs, plus the arm each row belongs to. */
interface SurfacePredRow {
  bus_name: string;
  route_id: number;
  to_stop_id: number;
  predicted_sec: number;
  predicted_at: number;
  surface: string;
}

interface ArrivalRow {
  bus_name: string;
  route_id: number;
  stop_id: number;
  arrived_at: number;
}

interface VisitRow extends ArrivalRow {
  departed_at: number | null;
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
