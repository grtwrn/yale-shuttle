import { z } from "zod";

import type { Route, Stop } from "../schema/api.js";

// Upstream wire formats from yale.downtownerapp.com. The fields are loosely
// typed at the source (some ints arrive as strings); coerce defensively.

const BASE_URL = "https://yale.downtownerapp.com";
const FETCH_TIMEOUT_MS = 10_000;

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

const BusesResponseSchema = z.array(RawBusSchema);
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

  async buses(): Promise<RawBus[]> {
    return this.fetchValidated("/routes_buses.php", BusesResponseSchema);
  }

  async announcements(): Promise<Announcement[]> {
    // The service banners Yale's own map shows (stop relocations, detours).
    // NOTE: this host answers 200 + the SPA's HTML for any unknown path, so a
    // vanished endpoint surfaces as a JSON parse error, not a 404 — exactly
    // what fetchValidated already treats as an UpstreamError.
    return this.fetchValidated("/routes_announcements.php", AnnouncementsResponseSchema);
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
