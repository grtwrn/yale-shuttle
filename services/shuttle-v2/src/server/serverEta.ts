/**
 * The ring estimator, stepped SERVER-SIDE — foundation only, off by default.
 *
 * ## Why this exists
 *
 * The estimator runs in the BROWSER today, a legacy of v2's frontend being a
 * fork of v1's. It is stateful — an HMM belief per bus (`web/src/eta/`) — so
 * every browser keeps its own copy, and that is a class of defect rather than
 * a list of them:
 *
 *  - a rider who just opened the app has a COLD belief; one with a tab open an
 *    hour has a WARM one. They see different numbers for the same bus at the
 *    same instant.
 *  - PR #176 existed solely to make a cold start read direction correctly,
 *    shipped, and was REVERTED the next morning (#183) once the canary
 *    measured leader jumps rising from 0.36 to 1.34 per watched hour.
 *  - the countdown was observed flapping between two fixed values 72 s apart
 *    (1:57 / 3:09) poll to poll while a bus stood — a belief with too little
 *    history to commit.
 *
 * A belief stepped by the collector is ALWAYS warm, because it never stops
 * tracking, and there is then ONE answer per bus for every rider.
 *
 * ## What this file is, and is not
 *
 * It is the SAME module, not a port. `computeUpcomingArrivals` is imported
 * from `web/src/arrivals.ts` verbatim; nothing here reimplements a line of the
 * estimator, and nothing here may. The whole value of the move is that the two
 * sides cannot disagree, and `serverEta.parity.test.ts` is what proves it —
 * it replays a captured production poll sequence through a "client" store and
 * this server engine and requires every row to match exactly.
 *
 * It is NOT wired to any rider. `SHUTTLE_SERVER_ETA=1` is what constructs it;
 * with the flag unset `buildApp` passes nothing, `createBusesPayloadCache`
 * attaches nothing, and the `/api/buses` bytes are identical (asserted in
 * `serverEta.test.ts`). No client code reads `server_eta`, and the display
 * rules, the #119 clamp and #185/#186's range are untouched.
 *
 * ## The three constraints this file is built around
 *
 *  1. **The poll must never stall.** Every entry point here is non-throwing:
 *     an estimator exception is counted and logged and the served field simply
 *     goes absent, exactly as if the flag were off.
 *  2. **One step per observation.** The belief is stepped once per collector
 *     `dataVersion()` — the counter `updateLivePositions` bumps once per poll.
 *     The `/api/buses` cache also rebuilds on a one-second wall clock during an
 *     upstream outage, and stepping the filter again on the SAME fix would feed
 *     it a repeat observation upstream never sent, which this model reads as
 *     evidence the bus is standing. So a same-version call re-serves the rows
 *     it already has (minus buses that have since aged out) and steps nothing.
 *  3. **A route allowlist.** Client-side a bug is bounded by which routes the
 *     bundle prices; server-side it would reach every rider at once. Beliefs
 *     are stepped for EVERY route — warmth is the point, and a widened
 *     allowlist should not need a warm-up — but only allowlisted routes are
 *     SERVED. See {@link DEFAULT_SERVER_ETA_ROUTES}.
 */

import { anchorKeyFor } from "../../web/src/liveAnchor.js";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from "../../web/src/arrivals.js";
import { registerRoutePaths } from "../../web/src/anchor.js";
import { BELIEF_STALE_MS } from "../../web/src/eta/filter.js";
import { applyModelParams } from "../../web/src/eta/params.js";
import type { AnchorStore } from "../../web/src/eta/index.js";
import type { BusData } from "../../web/src/map-data.js";
import type { LatLon } from "../../web/src/geo.js";
import { ROUTE_LISTS } from "../../web/src/routes.js";

/**
 * The lines whose answer is SERVED when the flag is on, overridable with
 * `SHUTTLE_SERVER_ETA_ROUTES` (comma-separated labels, or `*` for every line).
 *
 * Red and Blue Day, because they are the lines riders actually use and Red is
 * the founding complaint — the same pair every measured ETA decision in
 * `docs/eta-accuracy.md` was argued on. The rollout widens this the way the
 * ring estimator itself went out: route by route, on the rider simulator's
 * paired FIXED/INTRODUCED split, never all fifteen at once.
 */
export const DEFAULT_SERVER_ETA_ROUTES: readonly string[] = ["Red", "Blue Day"];

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
 * `[busIndex, stopId, etaSec, lowSec, highSec, stopsAhead, estimated]`
 */
export type ServerEtaRow = readonly [number, number, number, number, number, number, 0 | 1];

export interface ServerEtaWire {
  /** Bumped when the row shape changes. A client that does not recognise it ignores the field. */
  v: 1;
  /** The instant the belief behind these rows was stepped, ms. */
  at: number;
  /** `[busName, routeLabel]`, the index space `rows` points into. */
  buses: (readonly [string, string])[];
  rows: ServerEtaRow[];
}

export interface ServerEtaStats {
  /** Beliefs currently held, one per (route label, bus name). */
  beliefs: number;
  /** Collector data versions stepped. */
  steps: number;
  /** Exceptions swallowed. Non-zero means the field is absent, never that the poll broke. */
  failures: number;
  /** Wall-clock of the last full step, ms. */
  lastStepMs: number;
  /** Rows in the last served answer. */
  rows: number;
}

type Log = (event: string, fields: Record<string, unknown>) => void;

/**
 * Reads the flag. `null` — the default — means the machinery is not
 * constructed at all and `/api/buses` is byte-for-byte what it is today.
 */
export function serverEtaFromEnv(env: NodeJS.ProcessEnv = process.env, log?: Log): ServerEta | null {
  if (env.SHUTTLE_SERVER_ETA !== "1") return null;
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

  constructor(opts: { routes: readonly string[]; log?: Log }) {
    this.served = new Set(opts.routes);
    this.log = opts.log ?? (() => {});
  }

  /**
   * Step the beliefs for this collector data version and return the field to
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
      }
      return this.filterToLive(this.wire, payload.buses);
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

    const arrivals = computeUpcomingArrivals(
      targets, payload.buses, payload.routes, payload.stop_coords,
      payload.segments, now, payload.dwells, this.store,
    );

    this.markSeen(payload.buses, now);
    this.evict(now);
    this.steps++;
    this.lastStepMs = Date.now() - t0;

    const index = new Map<string, number>();
    const buses: (readonly [string, string])[] = [];
    const rows: ServerEtaRow[] = [];
    for (const a of arrivals) {
      if (!this.served.has(a.routeLabel)) continue;
      const k = `${a.routeLabel}|${a.busName}`;
      let i = index.get(k);
      if (i === undefined) {
        i = buses.length;
        index.set(k, i);
        buses.push([a.busName, a.routeLabel]);
      }
      rows.push([i, a.stopId, Math.round(a.eta), Math.round(a.low), Math.round(a.high), a.stopsAhead, a.estimated ? 1 : 0]);
    }
    if (rows.length === 0) return null;
    return { v: 1, at: now, buses, rows };
  }

  /**
   * Drop rows for buses that have aged off the live list since the step.
   *
   * `getLiveBuses()` applies its 120 s TTL at READ time, so during an upstream
   * outage the payload's bus array empties while the collector's data version
   * never moves. Without this the field would keep naming a bus the same
   * payload no longer carries.
   */
  private filterToLive(wire: ServerEtaWire | null, live: readonly BusData[]): ServerEtaWire | null {
    if (!wire) return null;
    const names = new Set<string>();
    for (const b of live) names.add(b.bus_name.replace("#", ""));
    if (wire.buses.every((b) => names.has(b[0]))) return wire;
    const keep = new Set<number>();
    wire.buses.forEach((b, i) => { if (names.has(b[0])) keep.add(i); });
    if (keep.size === 0) return null;
    // Reindex rather than leave holes, so `buses` stays the row index space.
    const remap = new Map<number, number>();
    const buses: (readonly [string, string])[] = [];
    for (const i of [...keep].sort((a, b) => a - b)) {
      remap.set(i, buses.length);
      buses.push(wire.buses[i]!);
    }
    const rows = wire.rows
      .filter((r) => remap.has(r[0]))
      .map((r) => [remap.get(r[0])!, r[1], r[2], r[3], r[4], r[5], r[6]] as ServerEtaRow);
    return { v: 1, at: wire.at, buses, rows };
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
