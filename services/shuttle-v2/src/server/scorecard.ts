/**
 * The scorecard: truth for every ETA arm, every hour, kept per day.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * Every accuracy number so far has been a one-off — a replay run by hand on a
 * snapshot, a dashboard line over the trailing day, a table in a PR. None of
 * them is still true a week later, and none of them can tell a deploy from
 * weather. The operator's ask (2026-09-06): "I want our algos continually
 * improving with data … build the closed loop." This is its first stage: the
 * same rules, applied to what riders were actually shown AND to the official
 * app's own numbers, scored against the detector's arrivals, written down per
 * ET day so the next stages (parameter re-estimation, champion/challenger)
 * have a fixed, versioned record to read. See docs/closed-loop.md.
 *
 * ── The rules (all shared with the dashboard's head-to-head) ───────────────
 *
 * The truth is {@link truthAt} in predictions.ts — the ONE rule every reader
 * carries, measured into shape by docs/upstream-eta-measurement.md:
 *
 *  - a prediction made while the bus already stands at the predicted stop is
 *    not a forecast (both apps print ~0 through a layover; paired to the next
 *    visit it read as a lap of error) — counted as `standing`, never scored;
 *  - otherwise the first arrival at or after the prediction, within 45 min;
 *  - promises past {@link COMPARE_HORIZON_SEC} (30 min, upstream's reach) are
 *    counted as `beyondHorizon` and never scored, on every arm alike.
 *
 * Error = promise − actual, seconds (the replay's convention): NEGATIVE is
 * optimistic — the bus came later than promised — and positive is pessimistic.
 *
 * ── Cadence and cost ───────────────────────────────────────────────────────
 *
 * Hourly, at :35 (operator: "can the nightly learning be increased to
 * hourly?"). A prediction is scored once its truth has SETTLED — its 45-min
 * match window is in the past — so each tick scores the hour that just
 * settled, incrementally: a {@link DayScorer} holds the day's tallies in
 * memory, is advanced over an index range (`predictions_time_idx`,
 * `upstream_etas_time_idx`, `arrivals_time_idx`), and the day's rows are
 * REPLACED. The day's closing pass, on the first tick after 03:30 ET the next
 * morning, recomputes it from scratch — so a restart mid-day (which rebuilds
 * the accumulator from midnight) and any late detector write can never leave
 * a day's final row different from a clean recompute. Backfill on boot is
 * the same code: every day the logs still cover that has no final row.
 *
 * The census arm is ~320k rows on a weekday, so even the closing pass is
 * chunked by the hour with a turn of the event loop between chunks: the
 * collector's 5 s poll runs in this process and must not wait on
 * measurement. Every path is non-throwing; a failed tick costs an hour.
 */

import type Database from "better-sqlite3";

import { etDay, etDayStartMs } from "./actives.js";
import {
  COMPARE_HORIZON_SEC,
  COMPARE_MATCH_WINDOW_MS,
  SHOWN_SURFACES,
  STANDING_LOOKBACK_MS,
  UPSTREAM_SURFACE,
  normBusName,
  truthAt,
  type Visit,
} from "./predictions.js";

/** Promised-minutes buckets. Upper bounds are exclusive; "10-30" ends at the cap. */
export const HORIZONS = ["0-2", "2-5", "5-10", "10-30"] as const;
export type Horizon = (typeof HORIZONS)[number];
/** Every horizon at or under the cap, pooled. */
export const ALL_HORIZON = "all";
/** `route_id` of the pooled-over-routes rows. */
export const ALL_ROUTES = 0;

/** The three rider surfaces pooled. What "ours" means on the dashboard. */
export const OURS_SURFACE = "ours";
/** The verbatim per-stop census (`upstream_etas`), uncapped and network-wide. */
export const CENSUS_SURFACE = "census";
export const SCORECARD_SURFACES = [
  ...SHOWN_SURFACES,
  OURS_SURFACE,
  UPSTREAM_SURFACE,
  CENSUS_SURFACE,
] as const;
export type ScorecardSurface = (typeof SCORECARD_SURFACES)[number];

/** A promised arrival that moves by this much between consecutive rows is a jump. */
export const JUMP_SEC = 180;
/** Consecutive rows further apart than this are two looks, not one wait. */
export const JUMP_GAP_MS = 5 * 60_000;
/** The last number shown before the bus arrived was at least this: a strand. */
export const STRAND_SEC = 180;
/**
 * The last row must fall within this of the arrival to say the screen was
 * still showing the number as the bus came — a rider who looked ten minutes
 * earlier and left was not stranded by it.
 */
export const STRAND_WINDOW_MS = 90_000;

/**
 * A prediction is scored once this much time has passed: the 45-min match
 * window plus slack for the recorder's 60 s flush and the detector's write.
 */
export const SETTLE_MS = COMPARE_MATCH_WINDOW_MS + 2 * 60_000;
/** A day's closing pass runs once it is this far behind: 03:30 ET next morning. */
export const FINAL_AFTER_MS = 3.5 * 3_600_000;
/** How long the rows live. Tiny rows; a year of trend is the point. */
export const RETAIN_DAYS = 400;
/** Rows are only ever rebuilt this far back — past the logs' own retention. */
export const MAX_BACKFILL_DAYS = 45;
/** Chunk the scan by this much so the event loop gets a turn between reads. */
const CHUNK_MS = 3_600_000;

export function horizonOf(sec: number): Horizon | null {
  if (!(sec <= COMPARE_HORIZON_SEC)) return null;
  if (sec < 120) return "0-2";
  if (sec < 300) return "2-5";
  if (sec < 600) return "5-10";
  return "10-30";
}

/** The metrics JSON of one `scorecard_days` row. Percentages to one decimal. */
export interface ScorecardMetrics {
  /** Rows seen, before any rule. */
  n: number;
  /** ...promising more than the cap; not scored. */
  beyondHorizon: number;
  /** ...made while the bus stood at the stop; not scored. */
  standing: number;
  /** ...with no arrival inside the match window; not scored. */
  missing: number;
  /** ...scored. Every statistic below is over these. */
  paired: number;
  /** promise − actual, seconds; negative = optimistic. Null when unpaired. */
  medianSignedSec: number | null;
  medianAbsSec: number | null;
  p90AbsSec: number | null;
  within120Pct: number | null;
  /** Bus beat the promise by ≥ 120 s. */
  pessimistic120Pct: number | null;
  /** Bus came ≥ 120 s later than promised. */
  optimistic120Pct: number | null;
  /** Scored rows that carried a low < high band (ours do; upstream's are a point). */
  intervalRows: number;
  /** Share of those whose actual wait fell inside [low, high]. */
  intervalCoveragePct: number | null;
  /** Waits whose last number was shown within STRAND_WINDOW_MS of the arrival. */
  waits: number;
  /** ...where that number was still ≥ STRAND_SEC. */
  strands: number;
  /** Consecutive-row pairs (same surface, bus, stop, arrival, ≤ JUMP_GAP_MS apart). */
  jumpPairs: number;
  /** ...whose promised arrival instant moved by ≥ JUMP_SEC. */
  jumps: number;
  /** Rider surfaces only: rows per client bundle hash, so a deploy is visible. */
  builds?: Record<string, number>;
}

export interface ScorecardRow {
  routeId: number;
  horizon: Horizon | typeof ALL_HORIZON;
  surface: ScorecardSurface;
  metrics: ScorecardMetrics;
}

interface Cell {
  n: number;
  beyond: number;
  standing: number;
  missing: number;
  signed: number[];
  intervalRows: number;
  covered: number;
  waits: number;
  strands: number;
  jumpPairs: number;
  jumps: number;
  builds: Map<string, number> | null;
}

function newCell(withBuilds: boolean): Cell {
  return {
    n: 0, beyond: 0, standing: 0, missing: 0, signed: [],
    intervalRows: 0, covered: 0, waits: 0, strands: 0, jumpPairs: 0, jumps: 0,
    builds: withBuilds ? new Map() : null,
  };
}

/** One prediction, whichever table it came from, in the shape the scorer scores. */
interface Pred {
  bus: string;
  routeId: number;
  stopId: number;
  at: number;
  sec: number;
  low: number;
  high: number;
  surface: ScorecardSurface;
  build: string | null;
}

/** The open wait of one (surface, bus, stop): rows paired to one arrival. */
interface WaitState {
  arrival: number;
  routeId: number;
  lastAt: number;
  lastSec: number;
}

interface PredRow {
  bus_name: string;
  route_id: number;
  to_stop_id: number;
  predicted_sec: number;
  predicted_low_sec: number;
  predicted_high_sec: number;
  predicted_at: number;
  client_build: string | null;
  surface: string;
}

interface CensusRow {
  bus_name: string;
  route_id: number | null;
  stop_id: number;
  eta_sec: number | null;
  sampled_at: number;
  calc_at: number | null;
}

interface VisitRow {
  bus_name: string;
  route_id: number;
  stop_id: number;
  arrived_at: number;
  departed_at: number | null;
}

const isShown = (s: string): boolean => (SHOWN_SURFACES as readonly string[]).includes(s);

/**
 * The tallies of one ET day, advanced over settled time in index ranges.
 * `rows()` is a pure function of what has been fed in, so a day rebuilt from
 * scratch and a day advanced hour by hour produce the same rows (the suite
 * asserts it).
 */
export class DayScorer {
  readonly day: string;
  readonly dayStart: number;
  readonly dayEnd: number;
  /** Predictions made before this instant have been scored. */
  scoredThrough: number;
  /** Rows read so far, for the log line. */
  scanned = 0;

  private readonly cells = new Map<string, Cell>();
  private readonly waits = new Map<string, WaitState>();
  private readonly sqlite: Database.Database;

  constructor(sqlite: Database.Database, day: string) {
    this.sqlite = sqlite;
    this.day = day;
    this.dayStart = etDayStartMs(day);
    // The day ends where the next one starts: 23 or 25 hours on a DST day.
    this.dayEnd = etDayStartMs(etDay(this.dayStart + 26 * 3_600_000));
    this.scoredThrough = this.dayStart;
  }

  /** True once every prediction of the day has been scored. */
  get complete(): boolean {
    return this.scoredThrough >= this.dayEnd;
  }

  /**
   * Score predictions made in [scoredThrough, through), clamped to the day.
   * Reads the two prediction tables over their time indexes and the arrivals
   * that can be truth for them: the standing lookback before, the match
   * window after.
   */
  advance(through: number): void {
    const to = Math.min(through, this.dayEnd);
    const from = this.scoredThrough;
    if (to <= from) return;

    const visits = this.loadVisits(from - STANDING_LOOKBACK_MS, to + COMPARE_MATCH_WINDOW_MS);
    for (const p of this.loadPredictions(from, to)) this.score(p, visits);
    this.scoredThrough = to;
    // A wait whose arrival has settled can get no more rows: close it now, so
    // rows() reflects it this hour rather than when the next look at that
    // stop happens to come in.
    // Once the day is complete no row can follow at all, so every wait is
    // over — including one whose bus arrived just after midnight.
    for (const [key, w] of this.waits) {
      if (w.arrival < to || this.complete) {
        this.closeWait(w, this.surfaceOfKey(key));
        this.waits.delete(key);
      }
    }
  }

  /** Every non-empty cell, as rows to store. Pure. */
  rows(): ScorecardRow[] {
    const out: ScorecardRow[] = [];
    for (const [key, c] of this.cells) {
      if (c.n === 0) continue;
      const [routeId, horizon, surface] = key.split("|") as [string, string, string];
      out.push({
        routeId: Number(routeId),
        horizon: horizon as Horizon | typeof ALL_HORIZON,
        surface: surface as ScorecardSurface,
        metrics: metricsOf(c),
      });
    }
    return out.sort((a, b) =>
      a.routeId - b.routeId || a.surface.localeCompare(b.surface) || a.horizon.localeCompare(b.horizon));
  }

  // -- scoring ---------------------------------------------------------------

  private score(p: Pred, visits: Map<string, Visit[]>): void {
    this.scanned += 1;
    const horizon = horizonOf(p.sec);
    const waitKey = `${p.surface}:${p.bus}:${p.stopId}`;

    // A row beyond the cap is neither scored nor part of a wait.
    if (horizon === null) {
      this.bump(p.routeId, null, p.surface, p.build, (c) => { c.n += 1; c.beyond += 1; });
      this.endWait(waitKey, p.surface);
      return;
    }
    const truth = truthAt(visits.get(`${p.bus}:${p.routeId}:${p.stopId}`), p.at);
    if (truth.kind === "standing") {
      this.bump(p.routeId, horizon, p.surface, p.build, (c) => { c.n += 1; c.standing += 1; });
      this.endWait(waitKey, p.surface);
      return;
    }
    if (truth.kind === "missing") {
      this.bump(p.routeId, horizon, p.surface, p.build, (c) => { c.n += 1; c.missing += 1; });
      this.endWait(waitKey, p.surface);
      return;
    }

    const actualSec = (truth.at - p.at) / 1000;
    const err = p.sec - actualSec;
    const hasInterval = p.high > p.low;
    const covered = hasInterval && actualSec >= p.low && actualSec <= p.high;
    this.bump(p.routeId, horizon, p.surface, p.build, (c) => {
      c.n += 1;
      c.signed.push(err);
      if (hasInterval) {
        c.intervalRows += 1;
        if (covered) c.covered += 1;
      }
    });

    // Waits: consecutive rows of one (surface, bus, stop) paired to one arrival.
    const w = this.waits.get(waitKey);
    if (w && w.arrival === truth.at) {
      if (p.at - w.lastAt <= JUMP_GAP_MS) {
        const moved = Math.abs((p.at + p.sec * 1000) - (w.lastAt + w.lastSec * 1000)) / 1000;
        // The jump belongs to the horizon the rider was looking at when it moved.
        const prevHorizon = horizonOf(w.lastSec);
        this.bump(p.routeId, prevHorizon, p.surface, null, (c) => {
          c.jumpPairs += 1;
          if (moved >= JUMP_SEC) c.jumps += 1;
        });
      }
      w.lastAt = p.at;
      w.lastSec = p.sec;
    } else {
      if (w) this.closeWait(w, p.surface);
      this.waits.set(waitKey, { arrival: truth.at, routeId: p.routeId, lastAt: p.at, lastSec: p.sec });
    }
  }

  private endWait(key: string, surface: ScorecardSurface): void {
    const w = this.waits.get(key);
    if (!w) return;
    this.closeWait(w, surface);
    this.waits.delete(key);
  }

  /** The wait is over: was the screen still promising minutes as the bus came? */
  private closeWait(w: WaitState, surface: ScorecardSurface): void {
    if (w.arrival - w.lastAt > STRAND_WINDOW_MS) return;
    const strand = w.lastSec >= STRAND_SEC;
    this.bump(w.routeId, null, surface, null, (c) => {
      c.waits += 1;
      if (strand) c.strands += 1;
    });
  }

  private surfaceOfKey(key: string): ScorecardSurface {
    return key.slice(0, key.indexOf(":")) as ScorecardSurface;
  }

  /**
   * Apply `f` to every cell a row belongs to: its route and all routes, its
   * horizon (when it has one) and all horizons, its surface and — for the
   * rider surfaces — the pooled "ours".
   */
  private bump(
    routeId: number,
    horizon: Horizon | null,
    surface: ScorecardSurface,
    build: string | null,
    f: (c: Cell) => void,
  ): void {
    const surfaces: ScorecardSurface[] = isShown(surface) ? [surface, OURS_SURFACE] : [surface];
    const horizons: string[] = horizon === null ? [ALL_HORIZON] : [horizon, ALL_HORIZON];
    for (const s of surfaces) {
      const withBuilds = s !== UPSTREAM_SURFACE && s !== CENSUS_SURFACE;
      for (const r of [routeId, ALL_ROUTES]) {
        for (const h of horizons) {
          const key = `${r}|${h}|${s}`;
          let c = this.cells.get(key);
          if (!c) {
            c = newCell(withBuilds);
            this.cells.set(key, c);
          }
          f(c);
          if (c.builds && build !== null) c.builds.set(build, (c.builds.get(build) ?? 0) + 1);
        }
      }
    }
  }

  // -- reads -----------------------------------------------------------------

  private loadVisits(from: number, to: number): Map<string, Visit[]> {
    const index = new Map<string, Visit[]>();
    let rows: VisitRow[] = [];
    try {
      rows = this.sqlite
        .prepare(
          `SELECT bus_name, route_id, stop_id, arrived_at, departed_at FROM arrivals
           WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at ASC`,
        )
        .all(from, to) as VisitRow[];
    } catch {
      rows = [];
    }
    for (const a of rows) {
      const key = `${normBusName(a.bus_name)}:${a.route_id}:${a.stop_id}`;
      const visit: Visit = { t: a.arrived_at, d: a.departed_at };
      const list = index.get(key);
      if (list) list.push(visit);
      else index.set(key, [visit]);
    }
    return index;
  }

  /** Both tables' rows in [from, to), each in its own time order. */
  private loadPredictions(from: number, to: number): Pred[] {
    const out: Pred[] = [];
    try {
      const rows = this.sqlite
        .prepare(
          `SELECT bus_name, route_id, to_stop_id, predicted_sec, predicted_low_sec,
                  predicted_high_sec, predicted_at, client_build, surface
           FROM predictions_log WHERE predicted_at >= ? AND predicted_at < ?
           ORDER BY predicted_at ASC`,
        )
        .all(from, to) as PredRow[];
      for (const r of rows) {
        const surface = r.surface === UPSTREAM_SURFACE || isShown(r.surface) ? r.surface : null;
        if (surface === null) continue;
        out.push({
          bus: normBusName(r.bus_name),
          routeId: r.route_id,
          stopId: r.to_stop_id,
          at: r.predicted_at,
          sec: r.predicted_sec,
          low: r.predicted_low_sec,
          high: r.predicted_high_sec,
          surface: surface as ScorecardSurface,
          build: r.client_build,
        });
      }
    } catch {
      /* pre-migration database: no rider rows to score */
    }
    try {
      // Marker rows (an answer with no predictions) carry no bus and are not
      // predictions. A row without a route cannot be paired to an arrival.
      const rows = this.sqlite
        .prepare(
          `SELECT bus_name, route_id, stop_id, eta_sec, sampled_at, calc_at
           FROM upstream_etas WHERE sampled_at >= ? AND sampled_at < ?
           AND bus_name IS NOT NULL AND route_id IS NOT NULL AND eta_sec IS NOT NULL
           ORDER BY sampled_at ASC`,
        )
        .all(from, to) as CensusRow[];
      for (const r of rows) {
        const sec = r.eta_sec!;
        out.push({
          bus: normBusName(r.bus_name),
          routeId: r.route_id!,
          stopId: r.stop_id,
          // Upstream's own calculation instant when it was sane, else ours.
          at: r.calc_at ?? r.sampled_at,
          sec,
          low: sec,
          high: sec,
          surface: CENSUS_SURFACE,
          build: null,
        });
      }
    } catch {
      /* the census table arrived in a later migration than this database */
    }
    return out;
  }
}

function metricsOf(c: Cell): ScorecardMetrics {
  const paired = c.signed.length;
  const abs = c.signed.map((e) => Math.abs(e));
  const share = (k: number) => (paired === 0 ? null : Math.round((k / paired) * 1000) / 10);
  const m: ScorecardMetrics = {
    n: c.n,
    beyondHorizon: c.beyond,
    standing: c.standing,
    missing: c.missing,
    paired,
    medianSignedSec: paired ? pct(c.signed, 0.5) : null,
    medianAbsSec: paired ? pct(abs, 0.5) : null,
    p90AbsSec: paired ? pct(abs, 0.9) : null,
    within120Pct: share(abs.filter((a) => a <= 120).length),
    pessimistic120Pct: share(c.signed.filter((e) => e >= 120).length),
    optimistic120Pct: share(c.signed.filter((e) => e <= -120).length),
    intervalRows: c.intervalRows,
    intervalCoveragePct: c.intervalRows === 0
      ? null
      : Math.round((c.covered / c.intervalRows) * 1000) / 10,
    waits: c.waits,
    strands: c.strands,
    jumpPairs: c.jumpPairs,
    jumps: c.jumps,
  };
  if (c.builds && c.builds.size > 0) {
    m.builds = Object.fromEntries([...c.builds.entries()].sort((a, b) => b[1] - a[1]));
  }
  return m;
}

/** Nearest-rank quantile, as predictions.ts computes it. */
function pct(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return Math.round(s[i]! * 10) / 10;
}

// -- persistence --------------------------------------------------------------

export interface DayMeta {
  scoredThrough: number;
  scoredAt: number;
  final: boolean;
  estimatorVersion: string;
}

/** Replace the day's rows in one transaction. Re-running a day is a no-op in effect. */
export function writeDay(
  sqlite: Database.Database,
  day: string,
  rows: readonly ScorecardRow[],
  meta: DayMeta,
): void {
  const del = sqlite.prepare("DELETE FROM scorecard_days WHERE day = ?");
  const ins = sqlite.prepare(
    `INSERT INTO scorecard_days
       (day, route_id, horizon, surface, metrics, estimator_version, scored_through, scored_at, final)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  sqlite.transaction(() => {
    del.run(day);
    for (const r of rows) {
      ins.run(
        day, r.routeId, r.horizon, r.surface, JSON.stringify(r.metrics),
        meta.estimatorVersion, meta.scoredThrough, meta.scoredAt, meta.final ? 1 : 0,
      );
    }
  })();
}

export interface StoredDay {
  day: string;
  scoredThrough: number;
  scoredAt: number;
  final: boolean;
  estimatorVersion: string | null;
}

export interface StoredRow extends ScorecardRow {
  day: string;
}

export interface ScorecardReport {
  /** The rules the rows were scored under, so a reader can label them. */
  rules: {
    horizonCapSec: number;
    matchWindowSec: number;
    standingLookbackSec: number;
    settleSec: number;
    jumpSec: number;
    jumpGapSec: number;
    strandSec: number;
    strandWindowSec: number;
    horizons: readonly string[];
    surfaces: readonly string[];
    /** "promise − actual; negative = optimistic". */
    errorSign: string;
  };
  days: StoredDay[];
  rows: StoredRow[];
  routes: Array<{ id: number; name: string; shortName: string }>;
}

/** The last `days` ET days of rows, oldest first. Never throws. */
export function readScorecard(sqlite: Database.Database, days: number, now: number): ScorecardReport {
  const sinceDay = etDay(now - (Math.max(1, days) - 1) * 86_400_000);
  let dayRows: Array<{ day: string; scored_through: number; scored_at: number; final: number; estimator_version: string | null }> = [];
  let rows: Array<{ day: string; route_id: number; horizon: string; surface: string; metrics: string }> = [];
  let routes: Array<{ id: number; name: string; shortName: string }> = [];
  try {
    dayRows = sqlite
      .prepare(
        `SELECT day, MAX(scored_through) AS scored_through, MAX(scored_at) AS scored_at,
                MIN(final) AS final, MAX(estimator_version) AS estimator_version
         FROM scorecard_days WHERE day >= ? GROUP BY day ORDER BY day ASC`,
      )
      .all(sinceDay) as typeof dayRows;
    rows = sqlite
      .prepare(
        `SELECT day, route_id, horizon, surface, metrics FROM scorecard_days
         WHERE day >= ? ORDER BY day ASC, route_id ASC, surface ASC, horizon ASC`,
      )
      .all(sinceDay) as typeof rows;
    routes = sqlite
      .prepare("SELECT id, name, short_name AS shortName FROM routes ORDER BY id ASC")
      .all() as typeof routes;
  } catch {
    /* pre-migration database */
  }
  return {
    rules: {
      horizonCapSec: COMPARE_HORIZON_SEC,
      matchWindowSec: COMPARE_MATCH_WINDOW_MS / 1000,
      standingLookbackSec: STANDING_LOOKBACK_MS / 1000,
      settleSec: SETTLE_MS / 1000,
      jumpSec: JUMP_SEC,
      jumpGapSec: JUMP_GAP_MS / 1000,
      strandSec: STRAND_SEC,
      strandWindowSec: STRAND_WINDOW_MS / 1000,
      horizons: [...HORIZONS, ALL_HORIZON],
      surfaces: SCORECARD_SURFACES,
      errorSign: "promise - actual, seconds; negative = optimistic (bus came later than promised)",
    },
    days: dayRows.map((d) => ({
      day: d.day,
      scoredThrough: d.scored_through,
      scoredAt: d.scored_at,
      final: d.final === 1,
      estimatorVersion: d.estimator_version,
    })),
    rows: rows.map((r) => ({
      day: r.day,
      routeId: r.route_id,
      horizon: r.horizon as ScorecardRow["horizon"],
      surface: r.surface as ScorecardSurface,
      metrics: parseMetrics(r.metrics),
    })),
    routes,
  };
}

function parseMetrics(text: string): ScorecardMetrics {
  try {
    return JSON.parse(text) as ScorecardMetrics;
  } catch {
    return metricsOf(newCell(false));
  }
}

/** Drop rows older than the retention. */
export function pruneScorecard(sqlite: Database.Database, now: number): number {
  try {
    const cutoff = etDay(now - RETAIN_DAYS * 86_400_000);
    return sqlite.prepare("DELETE FROM scorecard_days WHERE day < ?").run(cutoff).changes;
  } catch {
    return 0;
  }
}

/** Days already closed. */
function finalDays(sqlite: Database.Database): Set<string> {
  try {
    const rows = sqlite
      .prepare("SELECT DISTINCT day FROM scorecard_days WHERE final = 1")
      .all() as Array<{ day: string }>;
    return new Set(rows.map((r) => r.day));
  } catch {
    return new Set();
  }
}

/** The earliest instant either prediction table still holds, or null when both are empty. */
function earliestPrediction(sqlite: Database.Database): number | null {
  const mins: number[] = [];
  for (const q of [
    "SELECT MIN(predicted_at) AS t FROM predictions_log",
    "SELECT MIN(sampled_at) AS t FROM upstream_etas",
  ]) {
    try {
      const row = sqlite.prepare(q).get() as { t: number | null } | undefined;
      if (row && typeof row.t === "number") mins.push(row.t);
    } catch {
      /* table absent on this database */
    }
  }
  return mins.length ? Math.min(...mins) : null;
}

/** The server build the rows are scored under. Stamped by the Dockerfile. */
export function resolveEstimatorVersion(): string {
  const raw = (process.env.SHUTTLE_BUILD_SHA ?? "").trim();
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.slice(0, 12) : "dev";
}

// -- the job ----------------------------------------------------------------------

export interface ScorecardLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface ScorecardJobOptions {
  sqlite: Database.Database;
  logger?: ScorecardLogger;
  now?: () => number;
  estimatorVersion?: string;
  /** Minute past the hour the tick runs at. 35: the 03:35 tick closes yesterday. */
  minuteOfHour?: number;
  /** Delay before the boot tick (the backfill), so startup work goes first. */
  bootDelayMs?: number;
  /** Test seam: called between chunks instead of yielding to the event loop. */
  yieldFn?: () => Promise<void>;
}

export interface TickReport {
  /** Days written this tick, with what was scanned. */
  days: Array<{ day: string; rows: number; scanned: number; final: boolean; ms: number }>;
  skipped: boolean;
}

export interface ScorecardJob {
  start(): void;
  stop(): void;
  /** Score everything settled. Safe to call at any time; overlapping calls are skipped. */
  tick(): Promise<TickReport>;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function createScorecardJob(opts: ScorecardJobOptions): ScorecardJob {
  const { sqlite } = opts;
  const logger: ScorecardLogger = opts.logger ?? {
    info: (msg, meta) => console.log(JSON.stringify({ level: "info", msg, ...meta })),
    warn: (msg, meta) => console.warn(JSON.stringify({ level: "warn", msg, ...meta })),
    error: (msg, meta) => console.error(JSON.stringify({ level: "error", msg, ...meta })),
  };
  const now = opts.now ?? Date.now;
  const version = opts.estimatorVersion ?? resolveEstimatorVersion();
  const minute = Math.max(0, Math.min(59, opts.minuteOfHour ?? 35));
  const pause = opts.yieldFn ?? yieldToLoop;

  /** One accumulator per open day; a day leaves the map when it is closed. */
  const open = new Map<string, DayScorer>();
  /** Days whose closing pass found nothing at all: no row to mark, so remembered here. */
  const emptyClosed = new Set<string>();
  let inFlight = false;
  let stopped = false;
  let handle: NodeJS.Timeout | null = null;

  async function tick(): Promise<TickReport> {
    if (inFlight) return { days: [], skipped: true };
    inFlight = true;
    const report: TickReport = { days: [], skipped: false };
    try {
      const t0 = now();
      const settled = t0 - SETTLE_MS;
      const earliest = earliestPrediction(sqlite);
      if (earliest === null) return report;
      const done = finalDays(sqlite);
      const firstDay = etDay(Math.max(earliest, t0 - MAX_BACKFILL_DAYS * 86_400_000));
      const lastDay = etDay(settled);
      for (let day = firstDay; day <= lastDay; day = etDay(etDayStartMs(day) + 26 * 3_600_000)) {
        if (stopped) break;
        if (done.has(day) || emptyClosed.has(day)) continue;
        const started = Date.now();
        // The closing pass recomputes from scratch: an accumulator built across
        // restarts and late detector writes must not be what the record keeps.
        const closing = t0 >= etDayStartMs(etDay(etDayStartMs(day) + 26 * 3_600_000)) + FINAL_AFTER_MS;
        let scorer = closing ? undefined : open.get(day);
        if (!scorer) {
          scorer = new DayScorer(sqlite, day);
          if (!closing) open.set(day, scorer);
        }
        const target = Math.min(settled, scorer.dayEnd);
        while (scorer.scoredThrough < target) {
          scorer.advance(Math.min(scorer.scoredThrough + CHUNK_MS, target));
          await pause();
          if (stopped) break;
        }
        if (stopped) break;
        const rows = scorer.rows();
        const final = closing && scorer.complete;
        // A day with nothing in it gets no row: the dashboard reads absence as
        // "no data", not as a day of zeros, and a closed empty day is only
        // remembered in memory (one cheap rescan per restart).
        if (rows.length === 0) {
          if (final) { emptyClosed.add(day); open.delete(day); }
          continue;
        }
        writeDay(sqlite, day, rows, {
          scoredThrough: scorer.scoredThrough,
          scoredAt: now(),
          final,
          estimatorVersion: version,
        });
        if (final) open.delete(day);
        const entry = { day, rows: rows.length, scanned: scorer.scanned, final, ms: Date.now() - started };
        report.days.push(entry);
        logger.info("scorecard.scored", entry);
      }
      const pruned = pruneScorecard(sqlite, t0);
      if (pruned > 0) logger.info("scorecard.pruned", { rows: pruned });
    } catch (err) {
      logger.error("scorecard.tick_failed", { error: (err as Error).message });
    } finally {
      inFlight = false;
    }
    return report;
  }

  function schedule(): void {
    if (stopped) return;
    const t = now();
    const d = new Date(t);
    // Next :MM, at least a minute away so a tick at :MM does not reschedule itself.
    let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), minute, 0, 0);
    if (next <= t + 60_000) next += 3_600_000;
    handle = setTimeout(() => {
      void tick().finally(schedule);
    }, next - t);
    handle.unref?.();
  }

  return {
    start() {
      stopped = false;
      handle = setTimeout(() => {
        void tick().finally(schedule);
      }, opts.bootDelayMs ?? 90_000);
      handle.unref?.();
    },
    stop() {
      stopped = true;
      if (handle) clearTimeout(handle);
      handle = null;
    },
    tick,
  };
}
