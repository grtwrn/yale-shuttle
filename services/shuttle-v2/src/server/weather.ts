/**
 * Rain warning: a tiny cached proxy in front of Open-Meteo's hourly forecast
 * for downtown New Haven.
 *
 * Why it is a server endpoint and not a browser fetch:
 * - **One upstream call per 10 minutes, regardless of rider count.** Every
 *   rider polling Open-Meteo directly would be ~40 req/s at launch load
 *   against someone else's free service. The cache here is the whole point.
 * - The forecast is identical for every rider (the shuttle serves one small
 *   area), so there is nothing per-rider to ask for.
 *
 * Contract: **this never throws and never rejects.** A rain hint is a nicety;
 * an outage at Open-Meteo must be invisible to riders. On failure we serve the
 * last good forecast, and if there is none, `{ available: false }` — which the
 * client renders as "no rain line", exactly like a dry forecast.
 *
 * Timestamps are normalised to epoch milliseconds HERE, not in the browser.
 * Open-Meteo returns local wall-clock strings ("2026-09-01T18:00") with a
 * separate `utc_offset_seconds`; a phone left on another timezone parsing
 * those with `new Date()` would land hours off — the same bug class that once
 * showed riders "No shuttles running" while buses ran.
 */

/** Downtown New Haven — the middle of the shuttle's service area. */
const LATITUDE = 41.3083;
const LONGITUDE = -72.9279;

const FORECAST_URL =
  "https://api.open-meteo.com/v1/forecast" +
  `?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
  "&hourly=precipitation_probability,precipitation" +
  "&forecast_hours=3&timezone=America%2FNew_York";

/** One upstream call per this interval, shared by every client. */
export const WEATHER_TTL_MS = 10 * 60_000;
/**
 * Past this age a cached forecast stops being served at all. The client's
 * next-hour window would ignore stale hours anyway, but an outage should
 * degrade to "no information", not to a confidently ancient one.
 */
export const WEATHER_MAX_AGE_MS = 3 * 60 * 60_000;
/** Upstream is a nicety; don't let a hung connection sit around. */
const FETCH_TIMEOUT_MS = 5_000;

export interface WeatherHour {
  /** Start of the hour this bucket covers, epoch ms. */
  timeMs: number;
  /** Chance of precipitation during that hour, 0-100. */
  probability: number;
  /** Expected precipitation, mm. */
  precipitationMm: number;
}

export type WeatherPayload =
  | { available: true; fetchedAtMs: number; hourly: WeatherHour[] }
  | { available: false };

export const WEATHER_UNAVAILABLE: WeatherPayload = { available: false };

export interface WeatherService {
  /** Never rejects. Cached; may serve a slightly stale forecast. */
  get(now?: number): Promise<WeatherPayload>;
}

export interface WeatherServiceOptions {
  /** Injectable so tests never touch the network. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  url?: string;
}

/**
 * Parse Open-Meteo's hourly block into epoch-ms buckets. Returns null for
 * anything we don't fully recognise — a half-understood forecast is worse
 * than none, and the caller then keeps its last good value.
 */
export function parseForecast(raw: unknown): WeatherHour[] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const hourly = r.hourly as Record<string, unknown> | undefined;
  if (!hourly || typeof hourly !== "object") return null;
  const times = hourly.time;
  const probs = hourly.precipitation_probability;
  const amounts = hourly.precipitation;
  if (!Array.isArray(times) || !Array.isArray(probs)) return null;
  // Local wall-clock strings plus this offset; see the header comment.
  const offsetMs =
    typeof r.utc_offset_seconds === "number" && Number.isFinite(r.utc_offset_seconds)
      ? r.utc_offset_seconds * 1000
      : 0;

  const out: WeatherHour[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (typeof t !== "string") continue;
    // Open-Meteo omits the zone designator when `timezone` is set; adding "Z"
    // makes Date.parse read it as UTC, and subtracting the offset recovers the
    // real instant without depending on this process's own TZ.
    const parsed = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
    if (!Number.isFinite(parsed)) continue;
    const probability = typeof probs[i] === "number" ? (probs[i] as number) : 0;
    const amount = Array.isArray(amounts) && typeof amounts[i] === "number"
      ? (amounts[i] as number)
      : 0;
    out.push({
      timeMs: parsed - offsetMs,
      probability: Number.isFinite(probability) ? Math.max(0, Math.min(100, probability)) : 0,
      precipitationMm: Number.isFinite(amount) ? Math.max(0, amount) : 0,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Cache + single-flight in front of `url`. Stale-while-revalidate: once a
 * forecast exists, a request past the TTL gets the old one immediately and
 * kicks off the refresh in the background, so no rider ever waits on
 * Open-Meteo. Only the very first request (cold cache) awaits it.
 */
export function createWeatherService(options: WeatherServiceOptions = {}): WeatherService {
  const now = options.now ?? Date.now;
  const url = options.url ?? FORECAST_URL;
  // Resolved lazily so a test (or a runtime without global fetch) can swap it.
  const doFetch: typeof fetch | undefined = options.fetchImpl ?? globalThis.fetch;

  let cached: { hourly: WeatherHour[]; fetchedAtMs: number } | null = null;
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    // Single-flight: 40 concurrent riders arriving the instant the TTL
    // expires must still produce exactly one upstream call.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        if (!doFetch) return;
        const res = await doFetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { accept: "application/json" },
        });
        if (!res.ok) return;
        const hourly = parseForecast(await res.json());
        // Keep the previous good forecast when the shape is unrecognised.
        if (hourly) cached = { hourly, fetchedAtMs: now() };
      } catch {
        /* upstream down / timeout / bad JSON — last good value stands */
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const serve = (t: number): WeatherPayload => {
    if (!cached || t - cached.fetchedAtMs > WEATHER_MAX_AGE_MS) return WEATHER_UNAVAILABLE;
    return { available: true, fetchedAtMs: cached.fetchedAtMs, hourly: cached.hourly };
  };

  return {
    async get(nowMs?: number): Promise<WeatherPayload> {
      const t = nowMs ?? now();
      if (!cached) {
        // Cold: nothing to serve, so this one request waits.
        await refresh();
        return serve(nowMs ?? now());
      }
      if (t - cached.fetchedAtMs > WEATHER_TTL_MS) {
        // Warm but stale: answer from cache, refresh behind the response.
        void refresh();
      }
      return serve(t);
    },
  };
}
