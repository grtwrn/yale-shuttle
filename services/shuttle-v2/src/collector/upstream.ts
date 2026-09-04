import { z } from "zod";

import type { Route, Stop } from "../schema/api.js";

// Upstream wire formats from yale.downtownerapp.com. The fields are loosely
// typed at the source (some ints arrive as strings); coerce defensively.

const BASE_URL = "https://yale.downtownerapp.com";
const FETCH_TIMEOUT_MS = 10_000;
/** How far upstream's own `calculation_time` may sit from ours before we ignore it. */
const CALC_TIME_TRUST_MS = 5 * 60_000;

const numFromString = z.union([z.number(), z.string().transform(Number)]);

const RawBusSchema = z.object({
  id: numFromString,
  name: z.string(),
  lat: numFromString,
  lon: numFromString,
  heading: numFromString.default(0),
  route: numFromString,
  lastStop: numFromString.nullable().optional(),
  lastUpdate: numFromString.optional(),
});
export type RawBus = z.infer<typeof RawBusSchema>;

const RawStopSchema = z.object({
  id: numFromString,
  name: z.string(),
  lat: numFromString,
  lon: numFromString,
});

const RawRouteSchema = z.object({
  id: numFromString,
  name: z.string(),
  short_name: z.string().default(""),
  description: z.string().default(""),
  color: z.string().default("#888"),
  stops: z.array(numFromString),
  // Flat [lat, lon, lat, lon, ...]; sometimes absent on older feeds.
  path: z.array(numFromString).optional(),
});

const RawAnnouncementSchema = z.object({
  id: z.number(),
  // `title` doubles as the affected-routes list ("Red, Brown"); free text.
  title: z.string(),
  message: z.string(),
  button_text: z.string().nullable().optional(),
  button_url: z.string().nullable().optional(),
});
export type Announcement = z.infer<typeof RawAnnouncementSchema>;
const AnnouncementsResponseSchema = z.array(RawAnnouncementSchema);

/**
 * One vehicle's predicted arrival at ONE stop, as the operator's own app is
 * told it. Read out of `yale.downtownerapp.com/assets/index-*.js` rather than
 * guessed: the official SPA calls `routes_eta.php` with a single `stop`
 * parameter and renders `bus_name` beside `avg` minutes.
 *
 * `avg` is WHOLE MINUTES — the operator's resolution, not ours. A comparison
 * against our seconds therefore carries ~±30 s of rounding on their side
 * before any real disagreement, and every reader of these rows must say so.
 * `avg: 0` is what their app prints as "Arrived".
 *
 * `bus_id`, `bus_name` and `route` are byte-identical to `/routes_buses.php`
 * (checked against a live fleet on 2026-09-04: ids 65954/65956/65967… and
 * names `#38`/`#310`/`#49` appear in both), so they need no reconciliation
 * with ours — we poll the same provider.
 */
const RawStopEtaSchema = z.object({
  avg: numFromString,
  bus_id: numFromString,
  bus_name: z.string(),
  route: numFromString,
});

/**
 * `{"etas":{"<stopId>":{"etas":[...]}},"calculation_time":1788547381}` — and a
 * bare `{}` for a stop with nothing approaching, which is not an error.
 * Rows are validated individually for the same reason bus rows are (see
 * BusesResponseSchema): one malformed vehicle must not cost the whole stop.
 */
const StopEtaResponseSchema = z.object({
  etas: z.record(z.string(), z.object({ etas: z.array(z.unknown()) })).optional(),
  calculation_time: numFromString.optional(),
});

/** One upstream prediction, flattened onto our identifiers. */
export interface UpstreamStopEta {
  stopId: number;
  busId: number;
  /** `#310`, exactly as `/routes_buses.php` and our own `arrivals` spell it. */
  busName: string;
  routeId: number;
  /** Whole minutes, as served. 0 = their app prints "Arrived". */
  avgMin: number;
}

export interface UpstreamStopEtas {
  /** Epoch ms upstream says it computed these, or null when absent/implausible. */
  calculatedAtMs: number | null;
  etas: UpstreamStopEta[];
}

// The bus list is validated PER ROW. One malformed vehicle (a bus logged in
// but unassigned reports `route: null`; a dead GPS reports `lat: null`) used
// to fail the whole array, so every tick threw, `getLiveBuses()` emptied
// after the TTL, and riders read "no shuttles" while the other 20 buses ran.
// Bad rows are dropped and counted (`lastDroppedRows`) so the collector can
// log them; the good rows keep flowing.
const BusesResponseSchema = z.array(z.unknown());
const StopsResponseSchema = z.array(RawStopSchema);
const RoutesResponseSchema = z.array(RawRouteSchema);

export interface UpstreamClientOptions {
  /** Override base URL for tests. */
  baseUrl?: string;
  /** Override fetch implementation for tests. */
  fetchImpl?: typeof fetch;
}

function normalizeHexColor(raw: string): string {
  const v = raw.trim();
  if (v.length === 0) return "#888888";
  if (v.startsWith("#")) return v;
  // Accept bare 3- or 6-digit hex; pass everything else through untouched
  // (named CSS colors, rgb()/hsl() expressions, etc.) so an upstream change
  // to a richer color format doesn't get mangled.
  return /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? `#${v}` : v;
}

export class UpstreamError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "UpstreamError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class UpstreamClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: UpstreamClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Rows of the last `buses()` response that failed validation and were dropped. */
  lastDroppedRows = 0;

  async buses(): Promise<RawBus[]> {
    const rows = await this.fetchValidated("/routes_buses.php", BusesResponseSchema);
    const out: RawBus[] = [];
    let dropped = 0;
    for (const row of rows) {
      const parsed = RawBusSchema.safeParse(row);
      if (parsed.success) out.push(parsed.data);
      else dropped += 1;
    }
    this.lastDroppedRows = dropped;
    return out;
  }

  async announcements(): Promise<Announcement[]> {
    // The service banners Yale's own map shows (stop relocations, detours).
    // NOTE: this host answers 200 + the SPA's HTML for any unknown path, so a
    // vanished endpoint surfaces as a JSON parse error, not a 404 — exactly
    // what fetchValidated already treats as an UpstreamError.
    return this.fetchValidated("/routes_announcements.php", AnnouncementsResponseSchema);
  }

  /**
   * The operator's OWN prediction for one stop — a second opinion on the very
   * arrivals ours is scored against.
   *
   * Per stop, one request: the endpoint has no fleet-wide form. The official
   * app makes exactly this call for every visible stop every 30 s
   * (`A1 = 3e4` in its bundle), which is the ceiling this client's caller
   * stays under; `upstreamEta.ts` owns the sampling that keeps it there.
   *
   * A stop with nothing approaching answers `{}`. That is an empty list, not a
   * failure, and must not be logged as one.
   */
  async stopEtas(stopId: number): Promise<UpstreamStopEtas> {
    const body = await this.fetchValidated(
      `/routes_eta.php?stop=${encodeURIComponent(String(stopId))}`,
      StopEtaResponseSchema,
    );
    const etas: UpstreamStopEta[] = [];
    for (const [key, value] of Object.entries(body.etas ?? {})) {
      // The response keys itself by stop id. Trust that over the id we asked
      // for, but only when it parses — a key we cannot read is a row we
      // cannot attribute to a stop, and a misattributed prediction is worse
      // than a missing one.
      const keyed = Number.parseInt(key, 10);
      if (!Number.isInteger(keyed)) continue;
      for (const row of value.etas) {
        const parsed = RawStopEtaSchema.safeParse(row);
        if (!parsed.success) continue;
        etas.push({
          stopId: keyed,
          busId: parsed.data.bus_id,
          busName: parsed.data.bus_name,
          routeId: parsed.data.route,
          avgMin: parsed.data.avg,
        });
      }
    }
    // Seconds upstream, and believed only when it sits near our own clock: a
    // stale or wrong `calculation_time` would place a row at an instant that
    // never existed, which is the one thing `predictions_log` may not do.
    let calculatedAtMs: number | null = null;
    if (body.calculation_time !== undefined && Number.isFinite(body.calculation_time)) {
      const ms = body.calculation_time * 1000;
      if (Math.abs(ms - Date.now()) <= CALC_TIME_TRUST_MS) calculatedAtMs = ms;
    }
    return { calculatedAtMs, etas };
  }

  async stops(): Promise<Stop[]> {
    const raw = await this.fetchValidated("/routes_stops.php", StopsResponseSchema);
    return raw.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));
  }

  async routes(): Promise<Route[]> {
    const raw = await this.fetchValidated(
      "/routes_routes.php?inactive=true",
      RoutesResponseSchema,
    );
    return raw.map((r) => {
      // Pair up the flat polyline into [lat, lon] tuples; drop a trailing
      // odd entry rather than throwing — upstream occasionally emits one.
      let path: [number, number][] | undefined;
      if (r.path && r.path.length >= 4) {
        path = [];
        for (let i = 0; i + 1 < r.path.length; i += 2) {
          path.push([r.path[i]!, r.path[i + 1]!]);
        }
      }
      return {
        id: r.id,
        name: r.name,
        shortName: r.short_name,
        // Upstream returns hex without the leading '#' (e.g. "4472C4").
        // Normalize on ingest so every downstream consumer can drop the
        // string straight into CSS / SVG color slots without ceremony.
        color: normalizeHexColor(r.color),
        stops: r.stops,
        ...(path ? { path } : {}),
        // Kept verbatim (trimmed) so the timetable riders see is the one the
        // operator publishes, not our hand-maintained ROUTE_HOURS table.
        ...(r.description.trim() ? { description: r.description.trim() } : {}),
      };
    });
  }

  private async fetchValidated<T extends z.ZodTypeAny>(
    pathname: string,
    schema: T,
  ): Promise<z.infer<T>> {
    const url = new URL(pathname, this.baseUrl).toString();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new UpstreamError(`fetch failed: ${pathname}`, err);
    }
    if (!response.ok) {
      throw new UpstreamError(`${response.status} ${response.statusText}: ${pathname}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new UpstreamError(`invalid JSON: ${pathname}`, err);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new UpstreamError(
        `schema mismatch: ${pathname}: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        parsed.error,
      );
    }
    return parsed.data;
  }
}
