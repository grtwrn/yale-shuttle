/** Shared live forecasts: one stateful estimator, stepped by collector GPS polls.
 * Browsers consume its arrivals, route position and standing state together.
 * A local checkpoint preserves tracking across short service restarts.
 * Missing/stale output is unavailable to riders; requests never advance belief.
 */

import { anchorKeyFor, anchorIndexOnList, resolveStandingStop } from "../../web/src/liveAnchor.js";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from "../../web/src/arrivals.js";
import { registerRoutePaths } from "../../web/src/anchor.js";
import { BELIEF_STALE_MS } from "../../web/src/eta/filter.js";
import { applyModelParams } from "../../web/src/eta/params.js";
import type { AnchorStore } from "../../web/src/eta/index.js";
import type { BusData } from "../../web/src/map-data.js";
import type { LatLon } from "../../web/src/geo.js";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes.js";
import { ETA_MAX_AGE_MS } from '../../web/src/etaSource.js';
import { serialize, deserialize } from 'node:v8';

export const RECOVERY_MAX_AGE_MS = 120_000;
export interface EtaCheckpointStore { load(): Uint8Array | null; save(value: Uint8Array): void }

/** Serve the network by default; an explicit allowlist can withhold routes. */
export const DEFAULT_SERVER_ETA_ROUTES: readonly string[] = ROUTE_LISTS.map(c => c.label);

/** How long a bus may be absent before its belief is dropped. */
export const BELIEF_EVICT_MS = BELIEF_STALE_MS;

/** The `/api/buses` fields the estimator reads. Structurally what the client gets. */
export interface EtaPayloadView {
  buses: BusData[];
  routes: Record<string, number[]>;
  stop_coords: Record<number, LatLon>;
  segments: SegmentTimes;
  dwells: DwellTimes;
  route_paths?: Record<string, readonly (readonly [number, number])[]>;
  model_params?: unknown;
}

/**
 * The served answer, ADDITIVE and compact.
 *
 * A row per (bus, stop) as a fixed-shape array rather than an object: the
 * estimator returns up to two entries per bus per stop on its route (this lap
 * and the next, which is what lets a single-bus line answer "next in 54 min"),
 * so an object-per-row shape spends more bytes on repeated keys than on
 * numbers. `buses` is the index space the rows point into.
 *
 * `[busIndex, stopId, etaSec, lowSec, highSec, stopsAhead, estimated, departNow, lowFloor]`
 */
export type { ServerEtaRow, ServerEtaWire } from "../../web/src/etaSource.js";
import type { ServerEtaRow, ServerEtaWire, ServerEtaBus } from "../../web/src/etaSource.js";

export interface ServerEtaStats {
  restored: number;
  forecastAt: number | null;
  checkpointAt: number | null;
  /** Beliefs currently held, one per (route label, bus name). */
  beliefs: number;
  /** Collector observation versions stepped. */
  steps: number;
  /** Exceptions swallowed. Non-zero means the field is absent, never that the poll broke. */
  failures: number;
  /** Wall-clock of the last full step, ms. */
  lastStepMs: number;
  /** Rows in the last served answer. */
  rows: number;
}

type Log = (event: string, fields: Record<string, unknown>) => void;

/** Enabled by default. Setting 0 withholds live ETAs without stopping GPS. */
export function serverEtaFromEnv(env: NodeJS.ProcessEnv = process.env, log?: Log): ServerEta | null {
  if (env.SHUTTLE_SERVER_ETA === "0") return null;
  const raw = env.SHUTTLE_SERVER_ETA_ROUTES?.trim();
  const routes = !raw
    ? DEFAULT_SERVER_ETA_ROUTES
    : raw === "*"
      ? ROUTE_LISTS.map((c) => c.label)
      : raw.split(",").map((s) => s.trim()).filter(Boolean);
  const opts: { routes: readonly string[]; log?: Log } = { routes };
  if (log) opts.log = log;
  return new ServerEta(opts);
}

export class ServerEta {
  /** One belief per bus, keyed exactly as the client keys it: `anchorKeyFor(label, busName)`. */
  private readonly store: AnchorStore = new Map();
  /** Last poll each key was present in, for eviction. */
  private readonly seenAt = new Map<string, number>();
  private readonly served: ReadonlySet<string>;
  private readonly log: Log;

  private lastVersion = -1;
  private wire: ServerEtaWire | null = null;
  private steps = 0;
  private failures = 0;
  private lastStepMs = 0;
  private restored = 0;
  private checkpoint: EtaCheckpointStore | undefined;
  private lastSavedAt = -Infinity;
  private readonly observed = new Map<string, BusData>();

  constructor(opts: { routes: readonly string[]; log?: Log }) {
    this.served = new Set(opts.routes);
    this.log = opts.log ?? (() => {});
  }

  /** Versioned local checkpoint preserves the posterior and display history
   * across a short deploy. An old/corrupt checkpoint is discarded atomically. */
  useCheckpoint(checkpoint: EtaCheckpointStore, now = Date.now()): void {
    this.checkpoint = checkpoint;
    try {
      const bytes = checkpoint.load();
      if (!bytes) return;
      const saved = deserialize(Buffer.from(bytes)) as { v: number; at: number; store: AnchorStore; seen: Map<string, number> };
      if (saved.v !== 1 || !Number.isFinite(saved.at) || saved.at > now
        || now - saved.at > RECOVERY_MAX_AGE_MS || !(saved.store instanceof Map) || !(saved.seen instanceof Map)
        || saved.store.size > 200) return;
      for (const [key, entry] of saved.store) {
        const b = entry.belief;
        if (typeof key !== 'string' || !b || typeof b.ringKey !== 'string'
          || !(b.p instanceof Float64Array) || !(b.restMask instanceof Uint8Array)
          || !(b.standLeg instanceof Int32Array) || !(b.zoneKey instanceof Int32Array)
          || !Number.isFinite(b.seenAt) || !Number.isFinite(saved.seen.get(key))) return;
      }
      for (const [key, entry] of saved.store) this.store.set(key, entry);
      for (const [key, at] of saved.seen) this.seenAt.set(key, at);
      this.restored = saved.store.size;
    } catch (err) { this.log('server_eta.checkpoint_load_failed', { error: String(err) }); }
  }

  private saveCheckpoint(now: number): void {
    if (!this.checkpoint || now - this.lastSavedAt < 30_000) return;
    try {
      this.checkpoint.save(serialize({ v: 1, at: now, store: this.store, seen: this.seenAt }));
      this.lastSavedAt = now;
    } catch (err) { this.log('server_eta.checkpoint_save_failed', { error: String(err) }); }
  }

  /**
   * Step the beliefs for this collector observation version and return the field to
   * attach to `/api/buses`, or null when there is nothing to say.
   *
   * Never throws. A same-`version` call re-serves the rows already computed,
   * filtered to buses still in the payload — see constraint 2 in the header.
   */
  contribute(payload: EtaPayloadView, version: number, now: number): ServerEtaWire | null {
    try {
      if (version !== this.lastVersion) {
        this.lastVersion = version;
        this.wire = this.recompute(payload, now);
        this.saveCheckpoint(now);
      }
      const wire = this.filterToLive(this.wire, payload.buses, now);
      return wire ? { ...wire, servedAt: now } : null;
    } catch (err) {
      this.failures++;
      this.wire = null;
      this.log("server_eta.step_failed", {
        error: err instanceof Error ? err.message : String(err),
        failures: this.failures,
      });
      return null;
    }
  }

  stats(): ServerEtaStats {
    return {
      restored: this.restored,
      forecastAt: this.wire?.at ?? null,
      checkpointAt: Number.isFinite(this.lastSavedAt) ? this.lastSavedAt : null,
      beliefs: this.store.size,
      steps: this.steps,
      failures: this.failures,
      lastStepMs: this.lastStepMs,
      rows: this.wire?.rows.length ?? 0,
    };
  }

  /** The lines this engine serves. Exposed for the tests and for /healthz-style reporting. */
  servedRoutes(): string[] {
    return [...this.served];
  }

  private recompute(payload: EtaPayloadView, now: number): ServerEtaWire | null {
    const t0 = Date.now();
    // The published polylines are a module-level registration on the client
    // (the shell calls this once per poll before anything reads a bus); the
    // server has one process and does the same, before anything is priced.
    registerRoutePaths(payload.route_paths ?? {});
    // The published parameter set, applied exactly where the client applies it
    // (TransitMap's poll handler). Without this a published fit would move
    // every browser and leave the server on its compiled constants.
    applyModelParams(payload.model_params);

    // EVERY stop on EVERY route is a target, not just the served ones: the
    // belief is what has to stay warm, and a route left unstepped until it is
    // allowlisted would start cold on the day it is widened to.
    const targets: number[] = [];
    const seen = new Set<number>();
    for (const rid in payload.routes) {
      for (const sid of payload.routes[rid]!) {
        if (!seen.has(sid)) { seen.add(sid); targets.push(sid); }
      }
    }

    // An absent bus can remain on the map during the collector's 120 s TTL.
    // It must not gain fresh evidence from other vehicles' successful polls.
    const current = payload.buses.filter(b => b.observed_at === undefined || now - b.observed_at < ETA_MAX_AGE_MS);
    const tracked = current.map(bus => {
      const key = `${bus.route_id}|${bus.bus_name}`;
      const old = this.observed.get(key);
      if (old && bus.observed_at !== undefined && old.observed_at === bus.observed_at) return old;
      this.observed.set(key, bus);
      return bus;
    });
    for (const [key, bus] of this.observed) {
      if (bus.observed_at !== undefined && now - bus.observed_at > BELIEF_EVICT_MS) this.observed.delete(key);
    }
    const arrivals = computeUpcomingArrivals(
      targets, tracked, payload.routes, payload.stop_coords,
      payload.segments, now, payload.dwells, this.store,
    );

    this.markSeen(current, now);
    this.evict(now);
    this.steps++;
    this.lastStepMs = Date.now() - t0;

    const index = new Map<string, number>();
    const buses: ServerEtaBus[] = [];
    const rows: ServerEtaRow[] = [];
    for (const a of arrivals) {
      if (!this.served.has(a.routeLabel)) continue;
      const k = `${a.routeLabel}|${a.busName}`;
      let i = index.get(k);
      if (i === undefined) {
        i = buses.length;
        index.set(k, i);
        const cfg = ROUTE_LISTS.find(c => c.label === a.routeLabel)!;
        const bus = tracked.find(b => b.bus_name.replace(/^#/, '') === a.busName && cfg.busRouteIds.includes(b.route_id))!;
        const seq = mergedRouteStops(cfg, payload.routes);
        buses.push([a.busName, a.routeLabel,
          anchorIndexOnList(bus, cfg, payload.routes, payload.stop_coords, seq, now, this.store),
          resolveStandingStop(bus, cfg, payload.routes, payload.stop_coords, now, this.store)]);
      }
      rows.push([i, a.stopId, Math.round(a.eta), Math.round(a.low), Math.round(a.high), a.stopsAhead, a.estimated ? 1 : 0, Math.round(a.departNow), Math.round(a.lowFloor)]);
    }
    if (rows.length === 0) return null;
    return { v: 2, at: now, servedAt: now, buses, rows };
  }

  /**
   * Drop rows for buses that have aged off the live list since the step.
   *
   * `getLiveBuses()` applies its 120 s TTL at READ time, so during an upstream
   * outage the payload's bus array empties while the collector's data version
   * never moves. Without this the field would keep naming a bus the same
   * payload no longer carries.
   */
  private filterToLive(wire: ServerEtaWire | null, live: readonly BusData[], now: number): ServerEtaWire | null {
    if (!wire) return null;
    const names = new Set<string>();
    for (const b of live) {
      if (b.observed_at !== undefined && now - b.observed_at >= ETA_MAX_AGE_MS) continue;
      for (const cfg of ROUTE_LISTS) {
        if (cfg.busRouteIds.includes(b.route_id)) names.add(`${cfg.label}|${b.bus_name.replace(/^#/, '')}`);
      }
    }
    if (wire.buses.every((b) => names.has(`${b[1]}|${b[0]}`))) return wire;
    const keep = new Set<number>();
    wire.buses.forEach((b, i) => { if (names.has(`${b[1]}|${b[0]}`)) keep.add(i); });
    if (keep.size === 0) return null;
    // Reindex rather than leave holes, so `buses` stays the row index space.
    const remap = new Map<number, number>();
    const buses: ServerEtaBus[] = [];
    for (const i of [...keep].sort((a, b) => a - b)) {
      remap.set(i, buses.length);
      buses.push(wire.buses[i]!);
    }
    const rows = wire.rows
      .filter((r) => remap.has(r[0]))
      .map((r) => [remap.get(r[0])!, ...r.slice(1)] as unknown as ServerEtaRow);
    return { ...wire, buses, rows };
  }

  /**
   * `bus_name` is the identity, never `bus_id` — TransLoc reissues the id per
   * service block (~1,000 ids for 50 buses in 30 days). The key is built by
   * the same rule `computeUpcomingArrivals` uses internally, so what is marked
   * seen here is exactly what was stepped there, including a bus temporarily
   * off its route (which `isBusOnRoute` skips but which must not be evicted).
   */
  private markSeen(buses: readonly BusData[], now: number): void {
    for (const bus of buses) {
      for (const cfg of ROUTE_LISTS) {
        if (cfg.busRouteIds.includes(bus.route_id)) {
          this.seenAt.set(anchorKeyFor(cfg.label, bus.bus_name), now);
        }
      }
    }
  }

  private evict(now: number): void {
    const cutoff = now - BELIEF_EVICT_MS;
    for (const [key, at] of this.seenAt) {
      if (at >= cutoff) continue;
      this.seenAt.delete(key);
      this.store.delete(key);
    }
    // A key in the store that was never marked seen cannot happen through
    // `contribute`, but a store that outlives a topology change could strand
    // one; drop anything the seen map has no record of at all.
    for (const key of this.store.keys()) {
      if (!this.seenAt.has(key)) this.store.delete(key);
    }
  }
}
