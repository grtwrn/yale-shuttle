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
import type { TransitNetwork } from "../network/TransitNetwork.js";
import { geocode } from "./geocode.js";

const round1 = (x: number): number => Math.round(x * 10) / 10;

// -- /api/buses ---------------------------------------------------------------

export function buildBusesPayload(collector: Collector): Record<string, unknown> {
  const net = collector.ref.get();
  const live = collector.getLiveBuses();

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
  }));

  // Live bus count per route → stand-in for v1's historical "peak concurrent".
  const liveByRoute = new Map<number, number>();
  for (const b of live) liveByRoute.set(b.routeId, (liveByRoute.get(b.routeId) ?? 0) + 1);

  const routes: Record<string, number[]> = {};
  const route_paths: Record<string, [number, number][]> = {};
  const segments: Record<string, Record<string, { avg: number; sd: number; n: number }>> = {};
  const dwells: Record<string, Record<string, { med: number; sd: number; n: number }>> = {};
  const route_peaks: Record<string, number> = {};

  for (const r of net.routes.values()) {
    const rid = String(r.id);
    routes[rid] = r.stops;
    if (r.path) route_paths[rid] = r.path;
    route_peaks[rid] = liveByRoute.get(r.id) ?? 0;

    const n = r.stops.length;
    const segMap: Record<string, { avg: number; sd: number; n: number }> = {};
    for (let i = 0; i < n; i++) {
      const from = r.stops[i]!;
      const to = r.stops[(i + 1) % n]!;
      const s = net.getSegmentStats(r.id, from, to);
      segMap[`${from}-${to}`] = { avg: round1(s.mean), sd: round1(s.stddev), n: s.n };
    }
    segments[rid] = segMap;

    const dwMap: Record<string, { med: number; sd: number; n: number }> = {};
    for (const sid of new Set(r.stops)) {
      const d = net.getDwellStats(r.id, sid);
      dwMap[String(sid)] = { med: round1(d.mean), sd: round1(d.stddev), n: d.n };
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
    stop_names,
    stop_coords,
    segments,
    dwells,
    dwells_by_bus: {},
    route_peaks,
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
 * Keyed on `collector.dataVersion()`, which covers positions, calibration and
 * topology. The wall-clock bound is the subtle half: during an upstream outage
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

interface GeocodeV1Hit {
  display_name: string;
  lat: number;
  lon: number;
  type: string;
  class: string;
}

// New Haven bounding box (lon/lat) so address lookups stay local.
const NH_VIEWBOX = "-73.05,41.38,-72.83,41.22";
const geoCache = new Map<string, { at: number; results: GeocodeV1Hit[] }>();
const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_CACHE_MAX = 500;

// Nominatim's usage policy caps a single application at 1 request/second.
// The frontend fires one lookup per debounced keystroke from two call sites,
// so a few hundred riders typing destinations would blow straight past that
// and get this machine's egress IP blocked. That failure is *silent* — a
// block just yields empty results forever, and address search quietly dies —
// so we throttle ourselves rather than find out the hard way.
const NOMINATIM_MIN_INTERVAL_MS = 1100;
// Rather than drop a lookup that arrives inside the interval, hold it for the
// next slot — a rider typing one address should still get an answer, and the
// frontend debounces keystrokes so this queue stays shallow in practice. Past
// this much backlog we shed load and answer from local stops/landmarks alone:
// degrading beats getting the egress IP banned, which breaks search for good.
const NOMINATIM_MAX_WAIT_MS = 2_500;
let nextSlotAt = 0;
// Collapses concurrent identical lookups (50 riders typing "union station"
// should cost one outbound request, not 50).
const nominatimInFlight = new Map<string, Promise<GeocodeV1Hit[]>>();

export async function geocodeV1(network: TransitNetwork, q: string): Promise<GeocodeV1Hit[]> {
  // Local stops + curated Yale landmarks first (ranked), mapped to v1 fields.
  const local: GeocodeV1Hit[] = geocode(network, q).map((h) => ({
    display_name: h.label,
    lat: h.lat,
    lon: h.lon,
    type: h.kind === "stop" ? "bus_stop" : "landmark",
    class: h.kind === "stop" ? "shuttle" : "yale",
  }));

  const query = q.trim();
  // Skip the external lookup for short queries and under tests (keeps the
  // suite hermetic and off the network).
  if (query.length < 3 || process.env.VITEST) return local;

  const external = await nominatim(query);
  // Merge, deduping anything within ~30 m of a local hit.
  const merged = [...local];
  for (const e of external) {
    if (merged.some((m) => Math.abs(m.lat - e.lat) < 3e-4 && Math.abs(m.lon - e.lon) < 3e-4)) {
      continue;
    }
    merged.push(e);
  }
  return merged.slice(0, 12);
}

async function nominatim(query: string): Promise<GeocodeV1Hit[]> {
  const cached = geoCache.get(query);
  if (cached && Date.now() - cached.at < GEO_TTL_MS) return cached.results;

  // Someone is already fetching this exact query — ride along on their request.
  const pending = nominatimInFlight.get(query);
  if (pending) return pending;

  // Claim the next 1-per-second slot. If the backlog is already deeper than
  // we're willing to make a rider wait, give up on the external lookup and let
  // the caller answer from local stops and Yale landmarks alone.
  const nowMs = Date.now();
  const slotAt = Math.max(nowMs, nextSlotAt);
  if (slotAt - nowMs > NOMINATIM_MAX_WAIT_MS) return cached?.results ?? [];
  nextSlotAt = slotAt + NOMINATIM_MIN_INTERVAL_MS;

  const req = (async () => {
    const delay = slotAt - Date.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return nominatimFetch(query);
  })().finally(() => nominatimInFlight.delete(query));
  nominatimInFlight.set(query, req);
  return req;
}

async function nominatimFetch(query: string): Promise<GeocodeV1Hit[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5` +
    `&viewbox=${NH_VIEWBOX}&bounded=1&q=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      // Nominatim requires a real, reachable contact. This advertised
      // yale-shuttle-v2.fly.dev, an app destroyed in the v2 migration — a
      // dead URL invites exactly the block we're trying to avoid.
      headers: { "User-Agent": "yale-shuttle (https://yale-shuttle.fly.dev)" },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{
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
    // Evict oldest-first. Clearing the whole map (the previous behaviour)
    // threw away the hot queries too, so every flush caused a burst of
    // re-fetches against the very rate limit we're trying to respect.
    while (geoCache.size >= GEO_CACHE_MAX) {
      const oldest = geoCache.keys().next().value;
      if (oldest === undefined) break;
      geoCache.delete(oldest);
    }
    geoCache.set(query, { at: Date.now(), results });
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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

function emptyAccuracy(): Record<string, unknown> {
  return { overall: null, buckets: [], stops: [] };
}

/**
 * ⚠️ Prediction logging is NOT implemented. Nothing anywhere in `src/` inserts
 * into `predictions_log` — the schema definition plus two readers (this
 * function and server/accuracy.ts) are the table's only references — so in
 * production it holds zero rows and this endpoint's only honest answer is the
 * empty rollup. It still has to be *served*: the frontend polls /api/accuracy
 * every 2 min per rider (~1.7 req/s at 200 riders), so producing that constant
 * must cost nothing. Hence the probe below — one `LIMIT 1` at most once a
 * minute, then we bail before the real query runs.
 *
 * If prediction logging is ever wired up, this function needs work before it
 * faces rider poll rates: the SELECT further down is a table SCAN — no index
 * leads with `predicted_at` — over a 7-day window, run synchronously by
 * better-sqlite3 on the one event loop that also serves every other request
 * and the 5 s collector poll. It wants an index on
 * `predictions_log(predicted_at)` and a memoized result (the window is 7 days;
 * a minute of staleness is free) before it can be let out.
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
    return emptyAccuracy();
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

  if (errs.length === 0) return emptyAccuracy();

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

  return {
    overall: {
      ...overall,
      weighted: "pooled (v2 backend; v1-compatible rollup)",
    },
    buckets: [],
    stops,
  };
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
