/**
 * The operator's own ETA, recorded beside ours.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * Every accuracy number this project has is ours against the arrivals we
 * detected. That answers "are we good in absolute terms" and never answers
 * "are we better than what the rider would otherwise have used". The official
 * Downtowner app publishes a prediction for the same vehicle at the same stop,
 * off the same feed, and it is the only second opinion that exists. Logging it
 * into `predictions_log` with `surface = "upstream"` makes the two arms
 * pairable against the SAME `arrivals` rows, by the same code, in the same
 * table — so a comparison is a query rather than an argument.
 *
 * ── What upstream actually offers ──────────────────────────────────────────
 *
 * `GET /routes_eta.php?stop=<id>` →
 *   `{"etas":{"<id>":{"etas":[{avg,bus_id,bus_name,route},…]}},
 *     "calculation_time":<unix s>}`
 *
 * Read out of the official SPA's bundle (`assets/index-*.js`, the `M3`/`kj`
 * query functions), not guessed at. Two consequences shape everything below:
 *
 *  1. **It is per stop.** There is no fleet-wide form — the official app's own
 *     "many stops" path is `Promise.all` over one request each. So a full
 *     sweep of 172 stops cannot be one poll, and this module SAMPLES.
 *  2. **`avg` is whole minutes.** Their resolution is 60 s, so a scored
 *     comparison carries ~±30 s of rounding on their side before any real
 *     disagreement. `compare-upstream.ts` prints that caveat; do not remove
 *     it, and do not read a 20 s gap between the arms as meaningful.
 *
 * ── The budget, and what it buys ───────────────────────────────────────────
 *
 * The official app refetches ETAs every 30 s (`A1 = 3e4`), so a 30 s cycle is
 * the operator's own cadence, not an imposition. Within a cycle this module
 * makes {@link STOPS_PER_CYCLE} requests spaced {@link SPACING_MS} apart:
 * 12 requests / 30 s = 0.4 req/s sustained, against the 0.2 req/s the buses
 * poll already costs. That is the whole extra load.
 *
 * Twelve stops is not 172, so the choice of WHICH twelve is the design:
 *
 *  - {@link FOCUS_STOP_NAMES} — the five the canary and the operator actually
 *    watch — are polled EVERY cycle, so the stops a human is looking at always
 *    have both arms.
 *  - the remaining slots rotate over the stops RIDERS have watched recently
 *    (distinct `to_stop_id` in `predictions_log`), because a head-to-head on
 *    the same (bus, stop, minute) only exists where both arms have a row, and
 *    ours only exist where a rider was looking. On production that set was 19
 *    stops in 24 h, so the rotation closes in ~1 min.
 *  - failing that (an empty log, a fresh database), they rotate over stops
 *    served by routes with a live bus, so the poller is still useful on day
 *    one.
 *
 * Say this plainly wherever the numbers are quoted: **this is a sample, not a
 * census.** Coverage differs between the arms, which is exactly why the
 * comparison script reports a head-to-head on shared pairs alongside the
 * per-arm totals.
 *
 * ── Failure shape ──────────────────────────────────────────────────────────
 *
 * `actives.ts` is the precedent. Nothing here may affect the buses poll or any
 * endpoint: its own timer, its own in-flight guard, every path non-throwing,
 * and a cycle that fails costs 30 s of measurement and nothing else. A stop
 * with nothing approaching answers `{}` — an empty list, not an error.
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 *
 * Unchanged, and if anything narrower: these rows carry no viewer at all, not
 * even the "some client had this on screen" of the rider-reported surfaces.
 * They are a statement about a bus, made by the operator, about the operator's
 * own fleet. The rider payload is untouched.
 */
import type Database from "better-sqlite3";

import type { NetworkRef } from "../network/NetworkRef.js";
import type { BusPosition } from "../schema/api.js";
import { PREDICTION_BUCKET_MS, UPSTREAM_SURFACE, normBusName } from "../server/predictions.js";
import type { Logger } from "./collector.js";
import { UpstreamClient, type UpstreamStopEta } from "./upstream.js";

/** Matches the official app's own ETA refetch interval (`A1 = 3e4`). */
export const CYCLE_MS = 30_000;
/** Requests per cycle. 12 / 30 s = 0.4 req/s; the buses poll costs 0.2 req/s. */
export const STOPS_PER_CYCLE = 12;
/**
 * Gap between requests inside a cycle, so a cycle is a trickle, not a burst.
 * 11 gaps x 2 s = 22 s, leaving headroom inside the 30 s cycle for the
 * requests themselves — a cycle that overruns is simply skipped by the
 * in-flight guard, but it should not be the normal case.
 */
export const SPACING_MS = 2_000;
/** Of each cycle's slots, how many go to the fixed focus stops. */
export const FOCUS_SLOTS = 5;

/**
 * The stops the canary and the operator actually watch, by NAME.
 *
 * By name, not by id, on purpose: stop ids come from upstream and a renumbering
 * would silently point this at the wrong corner, whereas an unmatched name just
 * drops out of the rotation. Resolved against the live network every cycle.
 */
export const FOCUS_STOP_NAMES: readonly string[] = [
  "Prospect / Canner",
  "Division / Prospect",
  "344 Winchester",
  "72 LEPH / 60 College", // School of Public Health
  "333 Cedar",
];

/** How far back "a stop riders have watched" reaches. */
const RIDER_STOP_WINDOW_MS = 3 * 60 * 60_000;
/** How long the rider-stop candidate list is reused before requerying. */
const RIDER_STOP_REFRESH_MS = 5 * 60_000;
/** Nothing sane is further out than this; matches predictions.ts's own cap. */
const MAX_ETA_SEC = 2 * 60 * 60;

export interface UpstreamEtaPollerOptions {
  sqlite: Database.Database;
  ref: NetworkRef;
  upstream: UpstreamClient;
  /** The collector's live fleet — the only source for a bus's current anchor. */
  liveBuses: () => readonly BusPosition[];
  logger: Logger;
  /** Test seams. */
  cycleMs?: number;
  spacingMs?: number;
  stopsPerCycle?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface PendingRow {
  busId: number;
  busName: string;
  routeId: number;
  fromStopId: number;
  toStopId: number;
  stopsAhead: number;
  predictedSec: number;
  predictedAt: number;
  surface: string;
}

export class UpstreamEtaPoller {
  private readonly sqlite: Database.Database;
  private readonly ref: NetworkRef;
  private readonly upstream: UpstreamClient;
  private readonly liveBuses: () => readonly BusPosition[];
  private readonly logger: Logger;
  private readonly cycleMs: number;
  private readonly spacingMs: number;
  private readonly stopsPerCycle: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private insert: Database.Statement | null = null;
  private handle: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;
  private cursor = 0;

  private riderStops: number[] = [];
  private riderStopsAt = 0;

  /** Counters for `collector.upstream_eta` — cycles, rows, and failures. */
  cycles = 0;
  requests = 0;
  rowsWritten = 0;
  failures = 0;

  constructor(opts: UpstreamEtaPollerOptions) {
    this.sqlite = opts.sqlite;
    this.ref = opts.ref;
    this.upstream = opts.upstream;
    this.liveBuses = opts.liveBuses;
    this.logger = opts.logger;
    this.cycleMs = opts.cycleMs ?? CYCLE_MS;
    this.spacingMs = opts.spacingMs ?? SPACING_MS;
    this.stopsPerCycle = opts.stopsPerCycle ?? STOPS_PER_CYCLE;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

    try {
      // Same statement, same `OR IGNORE` against `predictions_shown_uniq`, as
      // the rider-reported surfaces: polling one stop twice inside a bucket is
      // a no-op rather than a duplicate, and the first answer for a bucket is
      // the one that stands.
      this.insert = this.sqlite.prepare(`
        INSERT OR IGNORE INTO predictions_log
          (bus_id, bus_name, route_id, from_stop_id, to_stop_id, stops_ahead,
           predicted_sec, predicted_low_sec, predicted_high_sec, predicted_at,
           client_build, surface)
        VALUES
          (@busId, @busName, @routeId, @fromStopId, @toStopId, @stopsAhead,
           @predictedSec, @predictedSec, @predictedSec, @predictedAt,
           NULL, @surface)
      `);
    } catch {
      // Pre-migration database: degrade to a no-op rather than throwing on
      // every cycle.
      this.insert = null;
    }
  }

  start(): void {
    if (this.handle || this.insert === null) return;
    this.handle = setInterval(() => void this.runCycle(), this.cycleMs);
    this.handle.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }

  /**
   * One sweep. Public so tests can drive it without a timer. Never throws and
   * never rejects — a failure here must be invisible to the buses poll.
   */
  async runCycle(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const stops = this.pickStops();
      if (stops.length === 0) return;
      const rows: PendingRow[] = [];
      for (let i = 0; i < stops.length; i++) {
        if (this.stopped) break;
        // Spaced, not burst: the point is a trickle beside the 5 s buses poll.
        if (i > 0 && this.spacingMs > 0) await this.sleep(this.spacingMs);
        const stopId = stops[i]!;
        try {
          this.requests += 1;
          const answer = await this.upstream.stopEtas(stopId);
          const at = quantise(answer.calculatedAtMs ?? this.now());
          for (const eta of answer.etas) {
            const row = this.toRow(eta, at);
            if (row) rows.push(row);
          }
        } catch {
          // One stop's failure is one stop's failure. Counted, not logged per
          // occurrence — an upstream wobble must not fill the log.
          this.failures += 1;
        }
      }
      this.write(rows);
      this.cycles += 1;
      if (this.cycles % 20 === 0) {
        this.logger.info("collector.upstream_eta", {
          cycles: this.cycles,
          requests: this.requests,
          rows: this.rowsWritten,
          failures: this.failures,
        });
      }
    } catch {
      this.failures += 1;
    } finally {
      this.inFlight = false;
    }
  }

  /** Focus stops first, then a rotating sample. Exposed for tests. */
  pickStops(): number[] {
    const network = this.ref.get();
    const out: number[] = [];
    const seen = new Set<number>();

    const push = (id: number): void => {
      if (seen.has(id) || out.length >= this.stopsPerCycle) return;
      seen.add(id);
      out.push(id);
    };

    // Resolve the focus names against the live topology, by name (see the
    // comment on FOCUS_STOP_NAMES). Unmatched names simply drop out.
    const byName = new Map<string, number>();
    for (const s of network.stops.values()) byName.set(s.name, s.id);
    let focus = 0;
    for (const name of FOCUS_STOP_NAMES) {
      if (focus >= FOCUS_SLOTS) break;
      const id = byName.get(name);
      if (id === undefined) continue;
      push(id);
      focus += 1;
    }

    const candidates = this.rotationCandidates(network);
    if (candidates.length > 0) {
      // Round-robin from a persistent cursor so successive cycles walk the
      // list rather than re-polling its head.
      for (let n = 0; n < candidates.length && out.length < this.stopsPerCycle; n++) {
        push(candidates[this.cursor % candidates.length]!);
        this.cursor += 1;
      }
    }
    return out;
  }

  /**
   * Stops worth rotating over: the ones riders watched recently, because a
   * head-to-head needs a row in BOTH arms and ours only exist where somebody
   * was looking. Falls back to stops on routes with a live bus, so a fresh
   * database is not stuck polling five stops forever.
   */
  private rotationCandidates(network: ReturnType<NetworkRef["get"]>): number[] {
    const now = this.now();
    if (this.riderStops.length > 0 && now - this.riderStopsAt < RIDER_STOP_REFRESH_MS) {
      return this.riderStops;
    }
    let rider: number[] = [];
    try {
      const rows = this.sqlite
        .prepare(
          `SELECT DISTINCT to_stop_id AS id FROM predictions_log
           WHERE predicted_at >= ? AND surface <> ?`,
        )
        .all(now - RIDER_STOP_WINDOW_MS, UPSTREAM_SURFACE) as Array<{ id: number }>;
      rider = rows.map((r) => r.id).filter((id) => network.stops.has(id));
    } catch {
      rider = [];
    }
    if (rider.length === 0) {
      const live = new Set<number>();
      for (const b of this.liveBuses()) live.add(b.routeId);
      const fallback = new Set<number>();
      for (const routeId of live) {
        const route = network.routes.get(routeId);
        if (!route) continue;
        for (const id of route.stops) fallback.add(id);
      }
      rider = [...fallback];
    }
    rider.sort((a, b) => a - b);
    this.riderStops = rider;
    this.riderStopsAt = now;
    return rider;
  }

  private toRow(eta: UpstreamStopEta, at: number): PendingRow | null {
    const network = this.ref.get();
    if (!Number.isInteger(eta.stopId) || !Number.isInteger(eta.busId)) return null;
    if (!Number.isFinite(eta.avgMin) || eta.avgMin < 0) return null;
    const predictedSec = eta.avgMin * 60;
    if (predictedSec > MAX_ETA_SEC) return null;
    // Their prediction must be for a stop their route actually serves. Same
    // check the rider path makes, for the same reason.
    const positions = network.routeStopPositions.get(eta.routeId)?.get(eta.stopId);
    if (!positions || positions.length === 0) return null;

    // `from_stop_id` / `stops_ahead` describe where the bus was when the
    // prediction was made. Upstream does not say, so these come from OUR live
    // fleet — the same source the rider path uses — and are -1 / 0 when we do
    // not know, never invented.
    let fromStopId = -1;
    let stopsAhead = 0;
    const bus = this.findBus(eta.busName);
    if (bus && bus.lastStopId != null) {
      fromStopId = bus.lastStopId;
      stopsAhead = stopsBetween(network, eta.routeId, fromStopId, eta.stopId);
    }

    return {
      busId: eta.busId,
      busName: eta.busName,
      routeId: eta.routeId,
      fromStopId,
      toStopId: eta.stopId,
      stopsAhead,
      predictedSec,
      predictedAt: at,
      surface: UPSTREAM_SURFACE,
    };
  }

  private findBus(busName: string): BusPosition | undefined {
    const want = normBusName(busName);
    for (const b of this.liveBuses()) {
      if (normBusName(b.busName) === want) return b;
    }
    return undefined;
  }

  private write(rows: readonly PendingRow[]): void {
    if (rows.length === 0 || !this.insert) return;
    try {
      // Deduplicate within the cycle before SQLite has to: one bus can be
      // returned for several of the stops we asked about, but never twice for
      // the same one in the same bucket.
      const uniq = new Map<string, PendingRow>();
      for (const r of rows) {
        uniq.set(`${r.busId}:${r.toStopId}:${r.predictedAt}`, r);
      }
      const batch = [...uniq.values()];
      this.sqlite.transaction(() => {
        for (const r of batch) this.insert!.run(r);
      })();
      this.rowsWritten += batch.length;
    } catch {
      // Measurement must never break collection. A dropped batch costs one
      // cycle; re-queueing a failing batch would cost the heap.
    }
  }
}

function quantise(ms: number): number {
  return Math.floor(ms / PREDICTION_BUCKET_MS) * PREDICTION_BUCKET_MS;
}

/**
 * How many stops forward `to` sits from `from` on a route, or 0 when the pair
 * does not resolve. Uses `routeStopPositions` (not `routeStopIndex`) because
 * routes 9 and 10 repeat stops on the West Campus out-and-back, and the first
 * occurrence is the wrong one half the time.
 */
function stopsBetween(
  network: ReturnType<NetworkRef["get"]>,
  routeId: number,
  fromStopId: number,
  toStopId: number,
): number {
  const positions = network.routeStopPositions.get(routeId);
  if (!positions) return 0;
  const froms = positions.get(fromStopId);
  const tos = positions.get(toStopId);
  if (!froms?.length || !tos?.length) return 0;
  const route = network.routes.get(routeId);
  const loop = route?.stops.length ?? 0;
  if (loop === 0) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (const f of froms) {
    for (const t of tos) {
      const ahead = t > f ? t - f : t - f + loop;
      if (ahead > 0 && ahead < best) best = ahead;
    }
  }
  return Number.isFinite(best) ? best : 0;
}
