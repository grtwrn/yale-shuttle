/**
 * v1-compatibility API layer.
 *
 * The v1 frontend (TransitMap.tsx) talks to a specific set of endpoints with
 * specific payload shapes — most importantly `/api/buses`, a single fat
 * response from which the client does its own trip planning and ETA math. v2's
 * backend models the same data differently (clean /api/live + server-side
 * /api/plan). This module reshapes v2's live network + calibrated stats into
 * exactly the JSON v1 expects, so the v1 frontend runs unmodified on v2.
 *
 * What v2 can't supply 1:1 degrades gracefully (v1 tolerates these empty):
 *   - `bus_pace`       — v2 doesn't compute per-bus fast/slow; returned as {}.
 *   - `dwells_by_bus`  — no per-bus dwell calibration; returned as {}.
 *   - `route_peaks`    — approximated by current live bus count per route.
 */

import type { Collector } from "../collector/collector.js";
import type { DbBundle } from "../db/client.js";
import { distanceMeters } from "../network/geo.js";
import type { TransitNetwork } from "../network/TransitNetwork.js";
import { geocode, normalizeName, relevanceOf } from "./geocode.js";
import { parsePublishedHours, type PublishedWindow } from "./publishedHours.js";

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * One hop / one stop in the v1 payload. `avg`/`sd`/`n` and `med`/`sd`/`n` are
 * v1's arrival-to-arrival numbers; `drive`/`driveN` and `q`/`qn` are the
 * stand/drive split the client's `hopPricing.ts` consumes — mirror its
 * `SegmentStat` / `DwellStat` types in `web/src/arrivals.ts`.
 */
type SegmentEntry = { avg: number; sd: number; n: number; drive?: number; driveN?: number };
type DwellEntry = { med: number; sd: number; n: number; low?: number; q?: number[]; qn?: number };

// -- /api/buses ---------------------------------------------------------------

export function buildBusesPayload(collector: Collector): Record<string, unknown> {
  const net = collector.ref.get();
  const live = collector.getLiveBuses();
  // Geometry derived from where buses actually drove, best-so-far per route.
  // Usually empty at first boot and fills in over the following days as each
  // route is caught running; see `Collector.runDerivePaths`.
  // Route geometry is served EXACTLY as the operator publishes it, so the map
  // is byte-for-byte the one on yale.downtownerapp.com. GPS-derived paths are
  // kept as diagnostics (/api/stats) and as an opt-in safety net for a route
  // whose published line becomes untraceable — they are not what riders see
  // unless SHUTTLE_SERVE_DERIVED_PATHS=1 is set deliberately.
  const derivedPaths = process.env.SHUTTLE_SERVE_DERIVED_PATHS === "1"
    ? collector.derivedPaths()
    : new Map<number, readonly [number, number][]>();

  const buses = live.map((b) => ({
    bus_id: b.busId,
    bus_name: b.busName,
    route_id: b.routeId,
    lat: b.lat,
    lon: b.lon,
    heading: b.heading,
    last_stop_id: b.lastStopId,
    stationary: b.atStopId != null,
    ...(b.atStopId != null ? { at_stop_id: b.atStopId } : {}),
    // v1's frontend parses this as `new Date(at_stop_since + "Z")` — it
    // appends the UTC marker itself, so we must emit a NAIVE timestamp
    // (no trailing "Z"). Emitting toISOString() verbatim yielded "…ZZ" →
    // Invalid Date → NaN dwell counters.
    ...(b.atStopSince != null
      ? { at_stop_since: new Date(b.atStopSince).toISOString().replace(/Z$/, "") }
      : {}),
    // The stationary clock WITHOUT the at-a-stop gate, so the client can see a
    // bus that is taking its layover short of the marker. Same naive-UTC
    // spelling as `at_stop_since` — the client appends the "Z" itself.
    // Consumed by the approach-zone rule in web/src/hopPricing.ts.
    ...(b.stationarySince != null
      ? { stationary_since: new Date(b.stationarySince).toISOString().replace(/Z$/, "") }
      : {}),
  }));

  // Live bus count per route → stand-in for v1's historical "peak concurrent".
  const liveByRoute = new Map<number, number>();
  for (const b of live) liveByRoute.set(b.routeId, (liveByRoute.get(b.routeId) ?? 0) + 1);

  const routes: Record<string, number[]> = {};
  const route_paths: Record<string, [number, number][]> = {};
  const segments: Record<string, Record<string, SegmentEntry>> = {};
  const dwells: Record<string, Record<string, DwellEntry>> = {};
  const route_peaks: Record<string, number> = {};
  // The operator's published timetable per route, parsed from the free-text
  // route description. Only routes whose text parsed are present; the client
  // falls back to its ROUTE_HOURS table for the rest. This is what riders are
  // SHOWN ("Runs M–F 7a–6p") — the in-service gate stays on ROUTE_HOURS,
  // which is deliberately wider (see web/src/schedule.ts).
  const route_hours: Record<string, PublishedWindow> = {};

  for (const r of net.routes.values()) {
    const rid = String(r.id);
    routes[rid] = r.stops;
    const published = parsePublishedHours(r.description);
    if (published) route_hours[rid] = published;
    // Prefer the derived line over upstream's published one. Several published
    // paths are too coarse to locate a stop on — Orange Night ships 37 points
    // for a 9.5 km loop, putting a stop a median 97 m from its own route — and
    // this payload is where the map gets the geometry it draws a rider's ride
    // on. A derived path is only ever present when it measured materially
    // closer to the stops (see `isBetterThanUpstream`), so preferring it is
    // never a downgrade; when there is none, upstream is used unchanged.
    const derived = derivedPaths.get(r.id);
    if (derived) route_paths[rid] = derived as [number, number][];
    else if (r.path) route_paths[rid] = r.path;
    route_peaks[rid] = liveByRoute.get(r.id) ?? 0;

    const n = r.stops.length;
    const segMap: Record<string, SegmentEntry> = {};
    for (let i = 0; i < n; i++) {
      const from = r.stops[i]!;
      const to = r.stops[(i + 1) % n]!;
      const s = net.getSegmentStats(r.id, from, to);
      segMap[`${from}-${to}`] = {
        avg: round1(s.mean), sd: round1(s.stddev), n: s.n,
        // The DRIVE half of the hop, on the at_stop_since clock, with the legs
        // behind it — the client prorates this en route instead of `avg`
        // (web/src/hopPricing.ts) once `driveN` clears its gate. Whole
        // seconds: the feed's poll quantum is 5 s.
        ...(s.drive !== undefined && s.driveN !== undefined ? { drive: Math.round(s.drive), driveN: s.driveN } : {}),
      };
    }
    segments[rid] = segMap;

    const dwMap: Record<string, DwellEntry> = {};
    for (const sid of new Set(r.stops)) {
      const d = net.getDwellStats(r.id, sid);
      dwMap[String(sid)] = {
        med: round1(d.mean), sd: round1(d.stddev), n: d.n,
        // `low` is what the client bills for a dwell the bus has not started
        // (see DwellStats.low). Absent until the stop has enough history.
        ...(d.low !== undefined ? { low: round1(d.low) } : {}),
        // Standing-time quantiles on the at_stop_since clock (DwellStats.q),
        // whole seconds, with the stopped visits behind them. This is the
        // `stand` half the client conditions on r with; `qn` is its gate.
        ...(d.q !== undefined && d.qn !== undefined ? { q: d.q.map((x) => Math.round(x)), qn: d.qn } : {}),
      };
    }
    dwells[rid] = dwMap;
  }

  const stop_names: Record<string, string> = {};
  const stop_coords: Record<string, { lat: number; lon: number }> = {};
  for (const s of net.stops.values()) {
    stop_names[String(s.id)] = s.name;
    stop_coords[String(s.id)] = { lat: s.lat, lon: s.lon };
  }

  return {
    buses,
    routes,
    route_paths,
    // Service banners from Yale's own map (routes_announcements.php), so a stop
    // relocation reaches the rider at decision time. `title` names the affected
    // routes as free text ("Red, Brown"); matching to routes happens client-side
    // where the route names already live.
    announcements: collector.announcements(),
    stop_names,
    stop_coords,
    segments,
    dwells,
    dwells_by_bus: {},
    route_peaks,
    route_hours,
    bus_pace: {},
  };
}

/**
 * How long a memoized payload may be served without re-checking the live bus
 * list. See {@link createBusesPayloadCache} — this is not a freshness budget
 * for bus positions (the version key handles those), it exists solely because
 * `getLiveBuses()` also applies the 120 s liveness TTL at *read* time.
 */
const BUSES_CACHE_MAX_AGE_MS = 1_000;

/**
 * Memoize the fat `/api/buses` payload, serialized.
 *
 * This is the endpoint every rider polls, and building it means walking every
 * route's stop list to rebuild six dictionaries and then stringifying ~87 KB —
 * of which the static topology (`route_paths`, `stop_coords`, `stop_names`,
 * `routes`) is ~74% and only moves on a 6-hourly refresh. Doing that per
 * request meant ~40 identical rebuilds a second at launch load, all on the one
 * event loop that also runs the collector. Now it happens once per collector
 * tick and every concurrent request gets the same string back.
 *
 * Keyed on `collector.dataVersion()`, which covers positions, calibration,
 * topology and newly derived route geometry. The wall-clock bound is the subtle half: during an upstream outage
 * `runPoll` bails before touching live positions, so the version never moves —
 * but `getLiveBuses()` filters on LIVE_BUS_TTL_MS against the clock, so a
 * version-only key would keep serving ghost buses that have aged off the map.
 * Re-checking once a second still collapses ~40:1 at launch load.
 */
export function createBusesPayloadCache(collector: Collector): () => string {
  let cachedVersion = -1;
  let cachedAt = 0;
  let cachedJson = "";
  return () => {
    const nowMs = Date.now();
    if (cachedVersion === collector.dataVersion() && nowMs - cachedAt < BUSES_CACHE_MAX_AGE_MS) {
      return cachedJson;
    }
    cachedVersion = collector.dataVersion();
    cachedJson = JSON.stringify(buildBusesPayload(collector));
    cachedAt = nowMs;
    return cachedJson;
  };
}

// -- /api/geocode (v1 shape) --------------------------------------------------

export interface GeocodeV1Hit {
  display_name: string;
  lat: number;
  lon: number;
  type: string;
  class: string;
}

// New Haven bounding box for the two external providers. Nominatim wants
// lon/lat as left,top,right,bottom; Photon wants minLon,minLat,maxLon,maxLat.
const NH_VIEWBOX = "-73.05,41.38,-72.83,41.22";
const PHOTON_BBOX = "-73.05,41.22,-72.83,41.38";
// Bias point for Photon's ranking: central campus.
const PHOTON_BIAS = { lat: 41.31, lon: -72.93 };
const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_CACHE_MAX = 500;

// Nominatim's usage policy caps a single application at 1 request/second and
// Photon asks for fair use. The frontend fires one lookup per debounced
// keystroke from two call sites, so a few hundred riders typing destinations
// would blow straight past that and get this machine's egress IP blocked.
// That failure is *silent* — a block just yields empty results forever, and
// address search quietly dies — so we throttle ourselves rather than find out
// the hard way. ONE queue covers both providers: a Photon miss followed by a
// Nominatim fallback is two outbound requests and takes two slots.
const GEOCODE_MIN_INTERVAL_MS = 1100;
// Rather than drop a lookup that arrives inside the interval, hold it for the
// next slot — a rider typing one address should still get an answer, and the
// frontend debounces keystrokes so this queue stays shallow in practice. The
// budget is the whole wall-clock a lookup may take, queue wait AND both
// providers' requests included: past it we answer from local stops and
// landmarks alone. Degrading beats getting the egress IP banned, which breaks
// search for good — and beats a cold request that waits 2.5 s twice.
const GEOCODE_BUDGET_MS = 2_500;

/**
 * Does this read like a street address the rider expects to land on a
 * building? A leading house number and at least one more word.
 *
 * A bare number is NOT an address — "800" is Building 800, a stop — and the
 * local matcher answers those. Deliberately loose about the rest: "517
 * Prospect", "517 Prospect St", "1 Prospect Street New Haven" all qualify.
 */
export function looksLikeStreetAddress(query: string): boolean {
  return /^\s*\d{1,6}\s+\S/.test(query);
}

/**
 * A destination the rider gave as a coordinate — "41.296105,-72.955812",
 * pasted from a map or a message.
 *
 * This is NOT a name, and that is the whole point. Every layer below is built
 * to compare names: the curated matcher, the reach filter, and above all the
 * name-relevance filter that drops a hit whose name has no relationship to the
 * query. A coordinate has no name to relate to anything, so it scored zero
 * against every candidate and the rider's own destination was thrown away.
 *
 * It used to survive by accident. Photon returns nothing for a bare
 * coordinate; Nominatim reverse-geocodes it to the nearest house ("452, Front
 * Avenue, Allingtown…"), and before the relevance filter shipped that house
 * was passed through as the answer — 127 m from the point the rider actually
 * typed. So the pre-regression behaviour was an approximation nobody chose.
 *
 * A coordinate needs no geocoding: it IS the answer. Recognising it here is
 * exact, costs no external call and no rate limit, cannot be changed by a
 * provider, and leaves the relevance filter untouched — the guard that keeps
 * EbLens out of "elenas" is load-bearing and is not what this fix pays with.
 *
 * Deliberately strict: comma-separated, and BOTH parts must carry a decimal
 * point. "800" is Building 800, and a hypothetical "1,2" is far likelier to be
 * something a rider typed than a destination in the Gulf of Guinea. Every real
 * pasted coordinate has decimals.
 */
export function parseCoordinateQuery(q: string): { lat: number; lon: number } | null {
  const m = /^\s*([+-]?\d{1,3}\.\d+)\s*,\s*([+-]?\d{1,3}\.\d+)\s*$/.exec(q);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * Junk out of the list, before it can become junk on a rider's screen.
 *
 * The two external providers are outside our control, and the
 * `ExternalGeocoder` interface is injectable, so a hit can reach here with a
 * field missing or of the wrong type even though `parsePhoton` and
 * `parseNominatim` are careful. Two things then go wrong: `rankExternal`
 * splits `display_name` and would throw — 500ing the whole lookup, so one bad
 * row costs every good one — and anything that survives is rendered by the
 * client, where a missing name blank-screened the app on 2026-09-03.
 *
 * The client guards itself too (`sanitizeGeocodeResults` in web/src/format.ts,
 * same rules), because the crash must be impossible whatever the server sends.
 * This end keeps the list itself honest: a row with no name is unreadable and
 * a row with no plausible coordinate is unplannable, so neither is an answer.
 *
 * This is NOT a relevance or reach judgement — both of those still happen in
 * `rankExternal`, unchanged, on rows that are at least well-formed.
 */
export function sanitizeHits(hits: unknown): GeocodeV1Hit[] {
  if (!Array.isArray(hits)) return [];
  const out: GeocodeV1Hit[] = [];
  for (const row of hits) {
    if (!row || typeof row !== "object") continue;
    const h = row as Partial<Record<keyof GeocodeV1Hit, unknown>>;
    if (typeof h.display_name !== "string" || h.display_name.trim() === "") continue;
    const lat = coordOrNull(h.lat, 90);
    const lon = coordOrNull(h.lon, 180);
    if (lat === null || lon === null) continue;
    out.push({
      display_name: h.display_name,
      lat,
      lon,
      // Optional in practice: they only steer the icon and the client's
      // auto-pick, so a missing one takes the same neutral default the
      // providers' own parsers already use rather than dropping the row.
      type: typeof h.type === "string" ? h.type : "place",
      class: typeof h.class === "string" ? h.class : "osm",
    });
  }
  return out;
}

/**
 * A coordinate, or null. Numeric strings pass (Nominatim sends lat/lon as
 * strings); `null`, `""` and booleans do not, because `Number()` turns them
 * into 0, which is a real-looking point in the Gulf of Guinea.
 */
function coordOrNull(v: unknown, limit: number): number | null {
  const n = typeof v === "number" ? v
    : typeof v === "string" && v.trim() !== "" ? Number(v)
    : NaN;
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** An address-level hit: the building the rider actually typed. */
function hasAddressHit(hits: readonly GeocodeV1Hit[]): boolean {
  return hits.some((h) => h.type === "house");
}

/**
 * The external half of destination lookup. Injectable into `buildApp` (and
 * `geocodeV1`) so tests exercise the merge/rank/fallback with a stubbed
 * fetch and never touch the network.
 */
export interface ExternalGeocoder {
  /** Best-effort results for `query`. Never throws; [] when nothing answers. */
  lookup(query: string): Promise<GeocodeV1Hit[]>;
}

export interface ExternalGeocoderOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock budget per lookup, queue wait included. Default 2.5 s. */
  budgetMs?: number;
}

type Provider = "photon" | "nominatim";
type ProviderFetch = (query: string, signal: AbortSignal) => Promise<GeocodeV1Hit[] | null>;

/**
 * Photon first, Nominatim when Photon errors or returns nothing.
 *
 * Photon (komoot) is the primary because it tolerates what riders actually
 * type: measured on 2026-09-02, "elenas" found Elena's on Orange, "steling
 * library" found Sterling, "peobody" found the Peabody. Nominatim returned
 * nothing for "elenas" until the apostrophe went in — the operator hit that
 * one personally — and nothing for "stop and shop". Nominatim stays as the
 * fallback because it is a different service on different infrastructure:
 * when one sheds load the other usually does not.
 */
export function createExternalGeocoder(options: ExternalGeocoderOptions = {}): ExternalGeocoder {
  const doFetch: typeof fetch | undefined = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budgetMs = options.budgetMs ?? GEOCODE_BUDGET_MS;

  // Keyed by provider + query, so a Photon miss (cached as empty) does not
  // hide the Nominatim answer, and vice versa.
  const cache = new Map<string, { at: number; results: GeocodeV1Hit[] }>();
  // Collapses concurrent identical lookups (50 riders typing "union station"
  // should cost one outbound request, not 50).
  const inFlight = new Map<string, Promise<GeocodeV1Hit[]>>();
  let nextSlotAt = 0;

  const remember = (key: string, results: GeocodeV1Hit[]) => {
    // Evict oldest-first. Clearing the whole map (an earlier behaviour) threw
    // away the hot queries too, so every flush caused a burst of re-fetches
    // against the very rate limit we're trying to respect.
    while (cache.size >= GEO_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(key, { at: now(), results });
  };

  /**
   * One provider's answer, or null when it could not be asked (no slot inside
   * the budget, aborted, network error, non-2xx). Only a real answer — even
   * an empty one — is cached; a failure must be retried next time.
   */
  const ask = async (
    provider: Provider,
    query: string,
    deadline: number,
    signal: AbortSignal,
    run: ProviderFetch,
  ): Promise<GeocodeV1Hit[] | null> => {
    // "Union Station" and "union station" are one lookup, not two slots.
    const key = `${provider}:${query.trim().toLowerCase().replace(/\s+/g, " ")}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < GEO_TTL_MS) return cached.results;

    // Claim the next slot. If it falls outside this lookup's budget, give up
    // on this provider and let the caller degrade.
    const t = now();
    const slotAt = Math.max(t, nextSlotAt);
    if (slotAt > deadline) return null;
    nextSlotAt = slotAt + GEOCODE_MIN_INTERVAL_MS;
    if (slotAt > t) await sleep(slotAt - t);
    if (signal.aborted) return null;

    try {
      const results = await run(query, signal);
      if (results === null) return null;
      remember(key, results);
      return results;
    } catch {
      return null;
    }
  };

  const photon: ProviderFetch = async (query, signal) => {
    if (!doFetch) return null;
    const url =
      `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}` +
      `&lat=${PHOTON_BIAS.lat}&lon=${PHOTON_BIAS.lon}&limit=8&lang=en&bbox=${PHOTON_BBOX}`;
    const res = await doFetch(url, {
      signal,
      headers: { "User-Agent": "yale-shuttle (https://yale-shuttle.fly.dev)" },
    });
    if (!res.ok) return null;
    return parsePhoton(await res.json());
  };

  const nominatim: ProviderFetch = async (query, signal) => {
    if (!doFetch) return null;
    const url =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5` +
      `&viewbox=${NH_VIEWBOX}&bounded=1&q=${encodeURIComponent(query)}`;
    const res = await doFetch(url, {
      signal,
      // Nominatim requires a real, reachable contact. This advertised
      // yale-shuttle-v2.fly.dev, an app destroyed in the v2 migration — a
      // dead URL invites exactly the block we're trying to avoid.
      headers: { "User-Agent": "yale-shuttle (https://yale-shuttle.fly.dev)" },
    });
    if (!res.ok) return null;
    return parseNominatim(await res.json());
  };

  const lookup = async (query: string): Promise<GeocodeV1Hit[]> => {
    // Someone is already fetching this query — ride along on their request.
    // Keyed like the cache, so "Union Station" and "union station" typed at
    // the same moment cost one slot, not two.
    const flightKey = query.trim().toLowerCase().replace(/\s+/g, " ");
    const pending = inFlight.get(flightKey);
    if (pending) return pending;

    const req = (async () => {
      const deadline = now() + budgetMs;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), budgetMs);
      try {
        const first = await ask("photon", query, deadline, ctrl.signal, photon);
        // "Returned something" is not "returned something useful".
        //
        // Photon answers an address-shaped query with whatever shares the
        // street's words: measured 2026-09-03, "517 Prospect St" came back as
        // Prospect Hill (a neighbourhood), Prospect Hill Historic District,
        // Prospect Hill (a peak), Prospect Beach and two Prospect Street
        // centrelines — and NO house. Because that list is non-empty, the
        // Nominatim fallback never fired, and Nominatim resolves the very
        // same query to "517, Prospect Street, ... 06511" first try.
        //
        // The rider-visible result was that "517 Prospect" worked (Photon
        // returns nothing at all for it, so the fallback fired) while "517
        // Prospect St" did not — adding the suffix most people type broke
        // the lookup. So for an address-shaped query, an answer with no
        // address in it is treated as no answer, and the other provider is
        // asked as well. Its address hits lead; Photon's places follow,
        // because a rider who typed a house number wants the house.
        const wantAddress = looksLikeStreetAddress(query);
        if (first && first.length > 0 && !(wantAddress && !hasAddressHit(first))) {
          return first;
        }
        const second = await ask("nominatim", query, deadline, ctrl.signal, nominatim);
        if (!second || second.length === 0) return first ?? [];
        if (!first || first.length === 0) return second;
        const addresses = second.filter((h) => h.type === "house");
        return addresses.length > 0 ? [...addresses, ...first] : first;
      } catch {
        return [];
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, req);
    return req;
  };

  return { lookup };
}

/**
 * Photon answers GeoJSON. `display_name` is built as "name, street, city"
 * (with the house number ahead of the street, as a New Haven address is
 * written) because the frontend shows the first two comma-parts: a rider
 * reads "Elena's on Orange, Orange Street".
 */
export function parsePhoton(body: unknown): GeocodeV1Hit[] {
  const features = (body as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features)) return [];
  const results: GeocodeV1Hit[] = [];
  for (const f of features) {
    if (!f || typeof f !== "object") continue;
    const feat = f as {
      geometry?: { coordinates?: unknown };
      properties?: Record<string, unknown>;
    };
    const coords = feat.geometry?.coordinates;
    const p = feat.properties ?? {};
    if (!Array.isArray(coords)) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string).trim() : "");
    const name = str("name");
    const street = [str("housenumber"), str("street")].filter(Boolean).join(" ");
    const city = str("city");
    const kind = str("type");
    // A country, state or county is never where a rider is going.
    if (kind === "country" || kind === "state" || kind === "county") continue;
    const parts: string[] = [];
    if (name) parts.push(name);
    if (street && street !== name) parts.push(street);
    if (city && city !== name) parts.push(city);
    if (parts.length === 0) continue;
    const osmKey = str("osm_key");
    const osmValue = str("osm_value");
    // "house" is the value the frontend auto-picks on for an exact address,
    // so an address-shaped answer must keep it whatever OSM tagged it. Photon
    // labels every point result `type: "house"` — a shop as much as a
    // building — so that field alone says nothing; the OSM tags do, as does
    // a nameless hit that is only a house number on a street.
    const isHouse =
      osmKey === "building" ||
      osmValue === "house" ||
      osmValue === "building" ||
      (!name && str("housenumber") !== "");
    results.push({
      display_name: parts.join(", "),
      lat,
      lon,
      type: isHouse ? "house" : osmValue || kind || "place",
      class: "osm",
    });
  }
  return results;
}

export function parseNominatim(body: unknown): GeocodeV1Hit[] {
  if (!Array.isArray(body)) return [];
  const rows = body as Array<{
    display_name?: string;
    lat?: string;
    lon?: string;
    type?: string;
    class?: string;
    addresstype?: string;
  }>;
  const results: GeocodeV1Hit[] = [];
  for (const r of rows) {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !r.display_name) continue;
    const isHouse = r.type === "house" || r.addresstype === "building" || r.addresstype === "house";
    results.push({
      display_name: r.display_name,
      lat,
      lon,
      type: isHouse ? "house" : r.type ?? "place",
      class: r.class ?? "osm",
    });
  }
  return results;
}

// The right area is "near the shuttle network", not a rectangle: a viewbox
// admits a street in Branford as readily as one on Orange Street. Any result
// farther than this from every stop is dropped when a closer one exists.
//
// The bound is the planner's own walking limit (`MAX_WALK_M` in
// web/src/walk.ts, pinned by a test in v1compat.geocode.test.ts): past it the
// app cannot offer a shuttle trip to the place at all, so listing it only
// invites the rider to pick a destination the shuttle does not serve. It used
// to be 2.5 km, which is how "pepes" reached Pepe's Lawn Care in West Haven
// (1,971 m from any stop) and Pepes Farm Road in Orange (2,224 m), both of
// them under the pizzeria the rider meant (operator, 2026-09-03).
//
// It does NOT remove the second Trader Joe's from that operator's third
// screenshot, and an earlier draft claiming it did was measuring an invented
// coordinate: Photon's Hamden node is 286 m from Aldi/Walmart, which route 18
// serves. Both stores are genuinely plannable, so both are listed.
export const EXTERNAL_REACH_M = 1_500;
const LOCAL_DEDUP_M = 60;
const EXTERNAL_DEDUP_M = 150;
const MERGED_MAX = 12;

/**
 * Keeps the provider's order (it ranks by relevance; a distance sort once put
 * a street centreline ahead of the house the rider typed) and drops the hits
 * out of reach of the shuttle network when a reachable one exists. Two
 * external hits for the same place (Photon lists a shop's node and its
 * building) collapse on name + proximity.
 */
export function rankExternal(
  network: TransitNetwork,
  hits: GeocodeV1Hit[],
  query?: string,
): GeocodeV1Hit[] {
  const stops = [...network.stops.values()];
  const nearest = (h: GeocodeV1Hit) => {
    let best = Infinity;
    for (const s of stops) {
      const d = distanceMeters(h, s);
      if (d < best) best = d;
    }
    return best;
  };
  // A result has to be a plausible answer to what the rider typed. Photon
  // matches loosely: "elenas" returned EbLens, a clothing shop, and it sat
  // directly under the ice cream shop the rider meant. No distance rule could
  // catch that one — the shop is 292 m from a stop, genuinely reachable
  // (operator, 2026-09-03). The test is the SAME matcher the curated list
  // uses, at its weakest tier, so a real alternative survives ("police" still
  // reaches New Haven Police Department, "cvs" the other branches) and only
  // an unrelated name goes. It may empty the external list: the local answer
  // is then the whole answer, which is the honest outcome.
  //
  // An ADDRESS is exempt, and has to be. Nominatim writes a house as
  // "517, Prospect Street, Prospect Hill, ..." — its first segment is the bare
  // number "517", which no relevance test can match against "517 Prospect St",
  // so the exact building the rider typed scored zero and was dropped. That is
  // the whole of report #59/#69's street-address fix undone (it shipped this
  // morning; its test caught this). A house-typed hit answering an
  // address-shaped query IS the answer, so it never faces this filter.
  const addressQuery = query !== undefined && looksLikeStreetAddress(query);
  const related = query
    ? hits.filter((h) =>
        (addressQuery && h.type === "house") ||
        relevanceOf(query, h.display_name.split(",").slice(0, 2).join(" ").trim()) > 0)
    : hits;
  // Keep the provider's order — it ranks by relevance, and re-sorting by
  // distance put a street centreline ahead of the house the rider typed —
  // and only DROP hits that are out of reach when a reachable one exists.
  const scored = related.map((h) => ({ h, d: nearest(h) }));
  const reachable = scored.some((s) => s.d <= EXTERNAL_REACH_M)
    ? scored.filter((s) => s.d <= EXTERNAL_REACH_M)
    : scored;
  const out: GeocodeV1Hit[] = [];
  for (const { h } of reachable) {
    const name = normalizeName(h.display_name.split(",")[0] ?? "");
    const twin = out.some(
      (k) =>
        normalizeName(k.display_name.split(",")[0] ?? "") === name &&
        distanceMeters(k, h) < EXTERNAL_DEDUP_M,
    );
    if (!twin) out.push(h);
  }
  return out;
}

export async function geocodeV1(
  network: TransitNetwork,
  q: string,
  external: ExternalGeocoder,
): Promise<GeocodeV1Hit[]> {
  // A coordinate is already the answer — see parseCoordinateQuery. Answered
  // before anything else so it never meets a filter built to compare names,
  // and so it costs no external lookup.
  const point = parseCoordinateQuery(q);
  if (point) {
    return [{
      display_name: `${point.lat}, ${point.lon}`,
      lat: point.lat,
      lon: point.lon,
      // Its own class/type rather than a borrowed one: calling a coordinate a
      // "house" would be a lie, and `suggIcon` already falls back to 📍 for a
      // type it has no glyph for. The frontend auto-picks a single result, so
      // the rider still goes straight to the plan.
      type: "coordinate",
      class: "coordinate",
    }];
  }
  // Local stops + curated Yale landmarks first (ranked), mapped to v1 fields.
  const hits = geocode(network, q);
  const local: GeocodeV1Hit[] = hits.map((h) => ({
    display_name: h.label,
    lat: h.lat,
    lon: h.lon,
    // The curated category ('pizza', 'library') rides in `type`, where the
    // client's icon table already reads OSM's own values for external hits.
    type: h.kind === "stop" ? "bus_stop" : h.poi ?? "landmark",
    class: h.kind === "stop" ? "shuttle" : "yale",
  }));

  const query = q.trim();
  // Skip the external lookup for short queries.
  // Gate on what the matcher saw: "!!!" is three characters and no query.
  if (normalizeName(query).length < 3) return local;

  // The shipped geocoder never throws, but the interface is injectable and a
  // rejection here would 500 the route: degrade to local instead.
  const externalHits = sanitizeHits(await external.lookup(query).catch(() => []));
  const ranked = rankExternal(network, externalHits, query);
  // Local results always come first; an external hit for a place we already
  // list (Photon knows our stops as bus_stop nodes) is noise.
  const merged = [...local];
  for (const e of ranked) {
    if (local.some((m) => distanceMeters(m, e) < LOCAL_DEDUP_M)) continue;
    merged.push(e);
  }
  // One last pass over everything, the local half included: stop names come
  // from the upstream feed, so "well-formed" is not ours to assume there
  // either, and this is the last point before the payload leaves.
  return sanitizeHits(merged.slice(0, MERGED_MAX));
}

// -- /api/accuracy (v1 shape) -------------------------------------------------

interface AccCell {
  n: number;
  in_range_pct: number;
  mae_sec: number;
  bias_sec: number;
  p90_sec: number | null;
  p95_sec: number | null;
}

const IN_RANGE_TOL_SEC = 90; // symmetric tolerance for the headline "in range %"
const ACC_WINDOW_DAYS = 7;
const ACC_MATCH_MS = 2 * 60 * 60 * 1000;

// How often we re-check an empty predictions_log before answering "no data"
// from the latch below.
const EMPTY_ACCURACY_PROBE_INTERVAL_MS = 60_000;
// Latch per database, so the test suite's throwaway bundles don't inherit each
// other's answer.
const predictionProbes = new WeakMap<object, { seen: boolean; lastProbeAt: number }>();
// Memoized rollup, per database for the same reason the latch is. Now that
// predictions_log has a writer, the query below is real work on the request
// path; 60 s of staleness on a 7-day window is invisible.
const ACCURACY_MEMO_MS = 60_000;
const accuracyMemo = new WeakMap<object, { at: number; value: Record<string, unknown> }>();
function memoAccuracy(bundle: DbBundle, value: Record<string, unknown>): Record<string, unknown> {
  accuracyMemo.set(bundle.sqlite, { at: Date.now(), value });
  return value;
}

function emptyAccuracy(): Record<string, unknown> {
  return { overall: null, buckets: [], stops: [] };
}

/**
 * ⚠️ Prediction logging WAS not implemented, and this function was written for
 * a permanently-empty table. `POST /api/shown` now fills it (see
 * server/predictions.ts), so the two guards below are load-bearing rather than
 * theoretical:
 *
 *  - the probe, one `LIMIT 1` at most once a minute, which still short-circuits
 *    a database that has no rows yet (a fresh deploy, a staging DB, every test
 *    that does not write one);
 *  - and the MEMO, because the query underneath is a 7-day scan run
 *    synchronously by better-sqlite3 on the one event loop that also serves
 *    every other request and the 5 s collector poll. `predictions_time_idx`
 *    leads with `predicted_at` so it is an index range rather than a table
 *    scan, but a 7-day range is still thousands of rows to fold, and this route
 *    is public. The window is seven days; a minute of staleness is free.
 *
 * Nothing in the current frontend calls /api/accuracy — the comment that said
 * riders poll it every 2 min predates the v2 client, which does not — but it is
 * public and cached-for-60s, so it is sized as though they did.
 */
export function buildAccuracyV1(bundle: DbBundle, network: TransitNetwork): Record<string, unknown> {
  let probe = predictionProbes.get(bundle.sqlite);
  if (!probe) {
    probe = { seen: false, lastProbeAt: 0 };
    predictionProbes.set(bundle.sqlite, probe);
  }
  if (!probe.seen) {
    const probedAt = Date.now();
    if (probedAt - probe.lastProbeAt < EMPTY_ACCURACY_PROBE_INTERVAL_MS) return emptyAccuracy();
    probe.lastProbeAt = probedAt;
    if (bundle.sqlite.prepare(`SELECT 1 FROM predictions_log LIMIT 1`).get() === undefined) {
      return emptyAccuracy();
    }
    probe.seen = true;
  }

  const cached = accuracyMemo.get(bundle.sqlite);
  if (cached && Date.now() - cached.at < ACCURACY_MEMO_MS) return cached.value;

  const cutoff = Date.now() - ACC_WINDOW_DAYS * 86_400_000;

  type Pred = {
    bus_id: number;
    route_id: number;
    to_stop_id: number;
    stops_ahead: number;
    predicted_sec: number;
    predicted_at: number;
  };
  const preds = bundle.sqlite
    .prepare(
      `SELECT bus_id, route_id, to_stop_id, stops_ahead, predicted_sec, predicted_at
       FROM predictions_log WHERE predicted_at >= ? ORDER BY predicted_at ASC`,
    )
    .all(cutoff) as Pred[];

  if (preds.length === 0) {
    // Memoized like any other answer: once the table HAS rows the probe latch
    // above stops short-circuiting, and "rows exist but none in the window"
    // would otherwise re-run this scan on every public request.
    return memoAccuracy(bundle, emptyAccuracy());
  }

  const earliest = preds[0]!.predicted_at;
  const latest = preds[preds.length - 1]!.predicted_at + ACC_MATCH_MS;
  const arr = bundle.sqlite
    .prepare(
      `SELECT bus_id, stop_id, arrived_at FROM arrivals
       WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at ASC`,
    )
    .all(earliest, latest) as Array<{ bus_id: number; stop_id: number; arrived_at: number }>;

  const index = new Map<string, number[]>();
  for (const a of arr) {
    const key = `${a.bus_id}:${a.stop_id}`;
    const list = index.get(key);
    if (list) list.push(a.arrived_at);
    else index.set(key, [a.arrived_at]);
  }

  // Collect signed errors, tagged with stop + route + distance bucket.
  interface Err { stopId: number; routeId: number; bucket: string; error: number }
  const errs: Err[] = [];
  for (const p of preds) {
    const list = index.get(`${p.bus_id}:${p.to_stop_id}`);
    if (!list) continue;
    const actual = firstAtLeast(list, p.predicted_at);
    if (actual === null || actual > p.predicted_at + ACC_MATCH_MS) continue;
    const actualWait = (actual - p.predicted_at) / 1000;
    errs.push({
      stopId: p.to_stop_id,
      routeId: p.route_id,
      bucket: distBucket(p.stops_ahead),
      error: actualWait - p.predicted_sec,
    });
  }

  // Same reason as the empty-window return above: rows without a matching
  // arrival yet is the NORMAL state for a few minutes after a deploy.
  if (errs.length === 0) return memoAccuracy(bundle, emptyAccuracy());

  const overall = cell(errs.map((e) => e.error));

  // Per-stop rollup with by-distance breakdown.
  const byStop = new Map<number, Err[]>();
  for (const e of errs) {
    const list = byStop.get(e.stopId);
    if (list) list.push(e);
    else byStop.set(e.stopId, [e]);
  }

  const stops: Record<string, unknown>[] = [];
  for (const [stopId, group] of byStop) {
    const route = network.routes.get(group[0]!.routeId);
    const c = cell(group.map((e) => e.error));
    const byBucket = new Map<string, number[]>();
    for (const e of group) {
      const list = byBucket.get(e.bucket);
      if (list) list.push(e.error);
      else byBucket.set(e.bucket, [e.error]);
    }
    const by_distance = [...byBucket.entries()]
      .sort((a, b) => bucketOrder(a[0]) - bucketOrder(b[0]))
      .map(([stops_ahead, vals]) => {
        const d = cell(vals);
        return {
          stops_ahead,
          n: d.n,
          p50_sec: round1(median(vals.map(Math.abs))),
          p90_sec: d.p90_sec,
          p95_sec: d.p95_sec,
          mae_sec: d.mae_sec,
          bias_sec: d.bias_sec,
        };
      });
    stops.push({
      stop_id: stopId,
      stop_name: network.stops.get(stopId)?.name ?? `Stop ${stopId}`,
      route_id: group[0]!.routeId,
      route_name: route?.name ?? `Route ${group[0]!.routeId}`,
      route_color: normalizeHex(route?.color),
      n: c.n,
      mae_sec: c.mae_sec,
      bias_sec: c.bias_sec,
      p90_sec: c.p90_sec,
      p95_sec: c.p95_sec,
      in_range_pct: c.in_range_pct,
      buckets: [],
      by_distance,
    });
  }
  stops.sort((a, b) => (b.n as number) - (a.n as number));

  const value = {
    overall: {
      ...overall,
      weighted: "pooled (v2 backend; v1-compatible rollup)",
    },
    buckets: [],
    stops,
  };
  return memoAccuracy(bundle, value);
}

function cell(signed: number[]): AccCell {
  const abs = signed.map((x) => Math.abs(x));
  const inRange = signed.filter((x) => Math.abs(x) <= IN_RANGE_TOL_SEC).length;
  return {
    n: signed.length,
    in_range_pct: round1((inRange / signed.length) * 100),
    mae_sec: round1(mean(abs)),
    bias_sec: round1(mean(signed)),
    p90_sec: round1(percentile(abs, 0.9)),
    p95_sec: round1(percentile(abs, 0.95)),
  };
}

function distBucket(stopsAhead: number): string {
  if (stopsAhead >= 11) return "10+";
  return String(Math.max(1, stopsAhead));
}

function bucketOrder(b: string): number {
  return b === "10+" ? Infinity : Number(b);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  return percentile(xs, 0.5);
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

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

function normalizeHex(c: string | undefined | null): string {
  if (!c) return "#888888";
  const v = c.trim();
  if (v.startsWith("#")) return v;
  return /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? `#${v}` : v;
}
