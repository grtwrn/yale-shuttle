/**
 * Sample the operator's per-stop ETA endpoint and keep everything it says.
 *
 * ── Why a second recorder ──────────────────────────────────────────────────
 *
 * `upstreamEta.ts` already polls `routes_eta.php` — twelve stops every 30 s,
 * the five the operator watches plus whatever riders looked at — and files a
 * curated row into `predictions_log` so upstream can be scored head-to-head
 * with what riders were shown. That answers "are we better than the official
 * app at the stops people use". It cannot answer the three questions this
 * module exists for, because it throws away exactly the rows they need:
 *
 *  1. **Their error by horizon, everywhere.** It caps at 30 min and only
 *     visits ~20 stops; a blend of their number into our estimator needs the
 *     whole network and the far horizon too.
 *  2. **Do they know something we do not?** On a folded route (Purple's West
 *     Campus out-and-back) our anchor cannot tell which leg a bus is on; the
 *     dispatcher's system may. That shows up as which stops they predict AT
 *     ALL, which is invisible once rows are filtered to "stops the route
 *     serves, ≤ 30 min".
 *  3. **What happens before a bus goes out of service.** The signal is an
 *     ABSENCE — predictions that stop being made — and an absence has no row
 *     unless the sampler writes one. So a call that answers nothing writes a
 *     marker row, and routes upstream calls active but that have no live bus
 *     are probed once a minute on purpose.
 *
 * So this is a census, not a sample: every stop of every route with a live
 * bus, round-robin, one call a second, verbatim into `upstream_etas`
 * (`src/db/schema.ts` says what the columns mean). It is a data-collection
 * job; nothing reads the table on the request path.
 *
 * ── Policy ─────────────────────────────────────────────────────────────────
 *
 *  - One request per {@link DEFAULT_INTERVAL_MS} (1 s), never faster: the
 *    interval is the rate limit and an in-flight call skips the tick. The
 *    official app makes one such request per visible stop every 30 s, so a
 *    rider with a 30-stop route open costs the provider what we do.
 *  - The rotation is the stops of routes that currently have a live bus, in
 *    route-id then sequence order, deduplicated (a stop on two live routes is
 *    asked once; the answer carries both routes). With ~50 live stops on a
 *    weekend that is every stop every ~50 s; ~170 on a weekday, every ~3 min.
 *  - Every {@link IDLE_PROBE_MS} (60 s), one stop of each route that upstream
 *    flags `active` but that has NO live bus goes to the head of the queue
 *    (`probe = 1`), cycling through that route's stops on successive minutes.
 *    Overnight, with nothing active, the sampler makes no calls at all.
 *
 * ── Failure shape ──────────────────────────────────────────────────────────
 *
 * Its own timer, its own in-flight guard, every path non-throwing. A failed
 * call is counted and the first failure after a success is logged once (an
 * outage at 1 req/s must not write 3,600 log lines an hour); the counts go
 * out every 5 min as `collector.eta_sampled`. The buses poll never waits on,
 * or learns about, anything here.
 */
import type Database from "better-sqlite3";

import type { NetworkRef } from "../network/NetworkRef.js";
import type { BusPosition } from "../schema/api.js";
import type { Logger } from "./collector.js";
import { UpstreamClient, UpstreamError, type UpstreamStopEtas } from "./upstream.js";

/** One call a second — the ceiling, and the default. */
export const DEFAULT_INTERVAL_MS = 1_000;
/** How often each active-but-empty route gets one stop probed. */
export const IDLE_PROBE_MS = 60_000;
/** Cadence of the `collector.eta_sampled` summary line. */
export const SUMMARY_MS = 5 * 60_000;
/** `raw` is for the unexpected; it must not become a place to store a page. */
export const RAW_MAX_CHARS = 2_048;

export interface UpstreamEtaSamplerOptions {
  sqlite: Database.Database;
  ref: NetworkRef;
  upstream: UpstreamClient;
  /** The collector's live fleet: which routes have a bus right now. */
  liveBuses: () => readonly BusPosition[];
  /** Upstream's `active` flag per route id (`Collector.routeActiveMap`). */
  routeActive: () => ReadonlyMap<number, boolean>;
  logger: Logger;
  intervalMs?: number;
  /** Test seam. */
  now?: () => number;
}

interface Pick {
  stopId: number;
  /** Set on an idle-route probe: the route the probe was for. */
  probeRouteId: number | null;
}

interface Counters {
  calls: number;
  rows: number;
  empty: number;
  probes: number;
  failures: number;
  stops: Set<number>;
}

function freshCounters(): Counters {
  return { calls: 0, rows: 0, empty: 0, probes: 0, failures: 0, stops: new Set() };
}

export class UpstreamEtaSampler {
  private readonly sqlite: Database.Database;
  private readonly ref: NetworkRef;
  private readonly upstream: UpstreamClient;
  private readonly liveBuses: () => readonly BusPosition[];
  private readonly routeActive: () => ReadonlyMap<number, boolean>;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly now: () => number;

  private insert: Database.Statement | null = null;
  private handle: NodeJS.Timeout | null = null;
  private inFlight = false;

  /** Last stop the rotation asked about; the cursor survives list rebuilds. */
  private lastRotationStop: number | null = null;
  /** Per idle route, how far through its stop list the probes have walked. */
  private readonly idleCursor = new Map<number, number>();
  private idleDueAt = 0;
  private readonly pending: Pick[] = [];

  /** True after a failure until the next success; gates the one-line warning. */
  private failing = false;
  private windowStartedAt = 0;
  private window: Counters = freshCounters();
  /** Cumulative, for tests and /healthz-style introspection. */
  readonly totals = freshCounters();

  constructor(opts: UpstreamEtaSamplerOptions) {
    this.sqlite = opts.sqlite;
    this.ref = opts.ref;
    this.upstream = opts.upstream;
    this.liveBuses = opts.liveBuses;
    this.routeActive = opts.routeActive;
    this.logger = opts.logger;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.windowStartedAt = this.now();
    this.idleDueAt = this.now();
    try {
      this.insert = this.sqlite.prepare(`
        INSERT INTO upstream_etas
          (sampled_at, calc_at, stop_id, route_id, bus_id, bus_name,
           eta_min, eta_sec, probe, raw)
        VALUES
          (@sampledAt, @calcAt, @stopId, @routeId, @busId, @busName,
           @etaMin, @etaSec, @probe, @raw)
      `);
    } catch {
      // Pre-migration database: a no-op sampler rather than a throwing one.
      this.insert = null;
    }
  }

  start(): void {
    if (this.handle || this.insert === null) return;
    this.handle = setInterval(() => void this.tick(), this.intervalMs);
    this.handle.unref?.();
  }

  stop(): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }

  /**
   * One call, at most. Public so tests can drive it without a timer. Never
   * throws and never rejects.
   */
  async tick(): Promise<void> {
    if (this.inFlight || this.insert === null) return;
    this.inFlight = true;
    try {
      const pick = this.next();
      if (pick) await this.sample(pick);
      this.maybeSummarise();
    } catch (err) {
      // Nothing above should reach here; if it does, it is one tick lost.
      this.noteFailure(err);
    } finally {
      this.inFlight = false;
    }
  }

  /** The next stop to ask about, or null when nothing is running. Exposed for tests. */
  next(): Pick | null {
    this.enqueueIdleProbes();
    const probe = this.pending.shift();
    if (probe) return probe;

    const rotation = this.rotation();
    if (rotation.length === 0) return null;
    const at = this.lastRotationStop === null ? -1 : rotation.indexOf(this.lastRotationStop);
    // A stop that left the list (its route's last bus went home) restarts the
    // walk from the top; otherwise carry on from where the last tick left off.
    const stopId = rotation[(at + 1) % rotation.length]!;
    this.lastRotationStop = stopId;
    return { stopId, probeRouteId: null };
  }

  /** Stops of every route with a live bus, route-id then sequence order, deduplicated. */
  private rotation(): number[] {
    const network = this.ref.get();
    const live = new Set<number>();
    for (const b of this.liveBuses()) live.add(b.routeId);
    const out: number[] = [];
    const seen = new Set<number>();
    for (const routeId of [...live].sort((a, b) => a - b)) {
      const route = network.routes.get(routeId);
      if (!route) continue;
      for (const stopId of route.stops) {
        if (seen.has(stopId)) continue;
        seen.add(stopId);
        out.push(stopId);
      }
    }
    return out;
  }

  /** Once a minute, one stop of each active route that has no live bus. */
  private enqueueIdleProbes(): void {
    const now = this.now();
    if (now < this.idleDueAt) return;
    this.idleDueAt = now + IDLE_PROBE_MS;
    const network = this.ref.get();
    const live = new Set<number>();
    for (const b of this.liveBuses()) live.add(b.routeId);
    const idle = [...this.routeActive()]
      .filter(([id, active]) => active && !live.has(id))
      .map(([id]) => id)
      .sort((a, b) => a - b);
    for (const routeId of idle) {
      const route = network.routes.get(routeId);
      if (!route || route.stops.length === 0) continue;
      const i = this.idleCursor.get(routeId) ?? 0;
      this.idleCursor.set(routeId, (i + 1) % route.stops.length);
      this.pending.push({ stopId: route.stops[i % route.stops.length]!, probeRouteId: routeId });
    }
  }

  private async sample(pick: Pick): Promise<void> {
    const sampledAt = this.now();
    let answer: UpstreamStopEtas;
    try {
      answer = await this.upstream.stopEtas(pick.stopId);
    } catch (err) {
      this.noteFailure(err);
      return;
    }
    if (this.failing) {
      this.failing = false;
      this.logger.info("collector.eta_sample_recovered");
    }
    const written = this.write(pick, sampledAt, answer);
    for (const c of [this.window, this.totals]) {
      c.calls += 1;
      c.rows += written;
      c.stops.add(pick.stopId);
      if (pick.probeRouteId !== null) c.probes += 1;
      if (answer.etas.length === 0) c.empty += 1;
    }
  }

  /** Rows written: one per prediction, or one marker when there were none. */
  private write(pick: Pick, sampledAt: number, answer: UpstreamStopEtas): number {
    if (!this.insert) return 0;
    const probe = pick.probeRouteId === null ? 0 : 1;
    const envelope = answer.extra ? clip(JSON.stringify(answer.extra)) : null;
    const rows: Record<string, unknown>[] = [];
    if (answer.etas.length === 0) {
      rows.push({
        sampledAt,
        calcAt: answer.calculatedAtMs,
        stopId: pick.stopId,
        routeId: pick.probeRouteId,
        busId: null,
        busName: null,
        etaMin: null,
        etaSec: null,
        probe,
        raw: envelope,
      });
    } else {
      answer.etas.forEach((eta, i) => {
        const extra: Record<string, unknown> = { ...(eta.extra ?? {}) };
        // The envelope's oddities ride on the first row rather than on every
        // row of the call, so a chatty envelope costs one copy.
        if (i === 0 && answer.extra) Object.assign(extra, { envelope: answer.extra });
        rows.push({
          sampledAt,
          calcAt: answer.calculatedAtMs,
          stopId: eta.stopId,
          routeId: eta.routeId,
          busId: eta.busId,
          busName: eta.busName,
          etaMin: eta.avgMin,
          etaSec: Math.round(eta.avgMin * 60),
          probe,
          raw: Object.keys(extra).length > 0 ? clip(JSON.stringify(extra)) : null,
        });
      });
    }
    try {
      this.sqlite.transaction(() => {
        for (const r of rows) this.insert!.run(r);
      })();
      return rows.length;
    } catch (err) {
      // A dropped call is one call; measurement must never break collection.
      this.noteFailure(err);
      return 0;
    }
  }

  private noteFailure(err: unknown): void {
    this.window.failures += 1;
    this.totals.failures += 1;
    if (this.failing) return;
    this.failing = true;
    // Same split as the collector's `logUpstreamError`: a provider fault is a
    // warning, anything else is ours and an error — but edge-triggered, once
    // per outage, because this runs every second.
    if (err instanceof UpstreamError) {
      this.logger.warn("collector.eta_sample_upstream", { error: err.message });
    } else {
      this.logger.error("collector.eta_sample_unexpected", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private maybeSummarise(): void {
    const now = this.now();
    if (now - this.windowStartedAt < SUMMARY_MS) return;
    const w = this.window;
    if (w.calls > 0 || w.failures > 0) {
      this.logger.info("collector.eta_sampled", {
        calls: w.calls,
        rows: w.rows,
        empty: w.empty,
        probes: w.probes,
        failures: w.failures,
        stops: w.stops.size,
        windowMs: now - this.windowStartedAt,
      });
    }
    this.window = freshCounters();
    this.windowStartedAt = now;
  }
}

function clip(json: string): string {
  return json.length <= RAW_MAX_CHARS ? json : json.slice(0, RAW_MAX_CHARS - 1) + "…";
}
