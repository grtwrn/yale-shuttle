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
 * an outage upstream must be invisible to riders. On failure we serve the
 * last good forecast, and if there is none, `{ available: false }` — which the
 * client renders as no weather line at all.
 *
 * TWO sources, tried in order. On 2026-09-02 Open-Meteo returned
 * `503 {"reason":"The service is overloaded"}` to the production machine for
 * several minutes — long enough that a restart left the cache cold and the
 * weather line disappeared for riders — while answering this Pi normally. It
 * recovered on its own within the hour (40/40 later requests from the same VM
 * returned 200), so that is free-tier load shedding, NOT a block on our
 * address: an earlier version of this comment claimed the latter and was
 * wrong. The National Weather Service (api.weather.gov) answers the same
 * machine fine, needs no key and covers New Haven, so it stands behind
 * Open-Meteo. Neither is trusted to be up; the cache spans both, and the
 * point of the fallback is that the next few minutes of load shedding are
 * invisible rather than blank.
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
  // Temperature and the WMO weather code come along so the app can say what
  // it is like out there, not only whether it will rain: the line is now
  // always on, and "12% chance of rain" alone is a strange thing to read on a
  // clear afternoon.
  "&hourly=precipitation_probability,precipitation,temperature_2m,weather_code" +
  "&forecast_hours=3&timezone=America%2FNew_York&temperature_unit=fahrenheit";

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

/**
 * Milliseconds left of a refresh's budget, floored so a provider that is
 * tried second still gets a real (if short) chance rather than a zero
 * timeout that aborts before the socket opens.
 */
export const MIN_ATTEMPT_MS = 250;
export function budgetMs(deadlineMs: number, nowMs: number): number {
  const left = deadlineMs - nowMs;
  return Number.isFinite(left) ? Math.max(MIN_ATTEMPT_MS, left) : MIN_ATTEMPT_MS;
}

/**
 * The National Weather Service's hourly forecast for the same point, used
 * when Open-Meteo will not answer. Two calls: /points resolves the grid cell,
 * whose hourly URL is stable, so it is resolved once and remembered.
 * api.weather.gov requires a User-Agent that identifies the caller.
 */
const NWS_POINT_URL = `https://api.weather.gov/points/${LATITUDE},${LONGITUDE}`;
const NWS_HEADERS = { "User-Agent": "yale-shuttle (github.com/grtwrn/yale-shuttle)", accept: "application/geo+json" };

/**
 * Parse the NWS hourly forecast into the same buckets as Open-Meteo.
 *
 * Its periods carry a real ISO timestamp with an offset, so no timezone
 * reconstruction is needed. `probabilityOfPrecipitation.value` is null rather
 * than 0 when there is no chance worth reporting; temperature is already °F
 * for this office but the unit is checked rather than assumed.
 */
export function parseNwsForecast(raw: unknown): WeatherHour[] | null {
  if (!raw || typeof raw !== "object") return null;
  const periods = (raw as { properties?: { periods?: unknown } }).properties?.periods;
  if (!Array.isArray(periods)) return null;
  const out: WeatherHour[] = [];
  for (const p of periods.slice(0, 6)) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const t = typeof o.startTime === "string" ? Date.parse(o.startTime) : NaN;
    if (!Number.isFinite(t)) continue;
    const popRaw = (o.probabilityOfPrecipitation as { value?: unknown } | undefined)?.value;
    const probability = typeof popRaw === "number" && Number.isFinite(popRaw) ? popRaw : 0;
    const tempRaw = o.temperature;
    const tempF = typeof tempRaw === "number" && Number.isFinite(tempRaw)
      ? (o.temperatureUnit === "C" ? tempRaw * 9 / 5 + 32 : tempRaw)
      : undefined;
    out.push({
      timeMs: t,
      probability: Math.max(0, Math.min(100, probability)),
      precipitationMm: 0,
      ...(tempF !== undefined ? { temperatureF: tempF } : {}),
      // No WMO code from this source; the client falls back to a plain
      // cloud icon and drops the condition word rather than inventing one.
    });
  }
  return out.length > 0 ? out : null;
}

export interface WeatherHour {
  /** Start of the hour this bucket covers, epoch ms. */
  timeMs: number;
  /** Chance of precipitation during that hour, 0-100. */
  probability: number;
  /** Expected precipitation, mm. */
  precipitationMm: number;
  /** Temperature, °F. Absent when upstream did not send one. */
  temperatureF?: number;
  /** WMO weather code (0 clear … 95 thunderstorm). Absent when not sent. */
  weatherCode?: number;
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
  /** Override the National Weather Service point lookup (tests). */
  nwsPointUrl?: string;
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
  const temps = hourly.temperature_2m;
  const codes = hourly.weather_code;
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
    // Temperature and condition are optional: an upstream that stops sending
    // them must degrade to the rain-only line, not to no forecast at all.
    const temp = Array.isArray(temps) ? temps[i] : undefined;
    const code = Array.isArray(codes) ? codes[i] : undefined;
    out.push({
      timeMs: parsed - offsetMs,
      probability: Number.isFinite(probability) ? Math.max(0, Math.min(100, probability)) : 0,
      precipitationMm: Number.isFinite(amount) ? Math.max(0, amount) : 0,
      ...(typeof temp === "number" && Number.isFinite(temp) ? { temperatureF: temp } : {}),
      ...(typeof code === "number" && Number.isFinite(code) ? { weatherCode: code } : {}),
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

  // The NWS grid URL for our point, resolved once and remembered: it does
  // not move, and spending a call on it every refresh would be rude.
  let nwsHourlyUrl: string | null = null;

  // ONE budget for the whole refresh, not one per call: chaining two
  // providers at 5 s each made a cold, hung refresh block the first request
  // for 10 s, and single-flight means every concurrent rider waits with it.
  const remaining = (deadline: number) => budgetMs(deadline, now());

  const fromOpenMeteo = async (f: typeof fetch, deadline: number): Promise<WeatherHour[] | null> => {
    const res = await f(url, {
      signal: AbortSignal.timeout(remaining(deadline)),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return parseForecast(await res.json());
  };

  const fromNws = async (f: typeof fetch, deadline: number): Promise<WeatherHour[] | null> => {
    if (!nwsHourlyUrl) {
      const p = await f(options.nwsPointUrl ?? NWS_POINT_URL, {
        signal: AbortSignal.timeout(remaining(deadline)),
        headers: NWS_HEADERS,
      });
      if (!p.ok) return null;
      const pj = (await p.json()) as { properties?: { forecastHourly?: unknown } };
      const u = pj.properties?.forecastHourly;
      if (typeof u !== "string") return null;
      nwsHourlyUrl = u;
    }
    const res = await f(nwsHourlyUrl, {
      signal: AbortSignal.timeout(remaining(deadline)),
      headers: NWS_HEADERS,
    });
    if (!res.ok) {
      // Forgotten, so the NEXT refresh re-resolves the grid — this pass is
      // already over its budget to try again.
      nwsHourlyUrl = null;
      return null;
    }
    return parseNwsForecast(await res.json());
  };

  const refresh = (): Promise<void> => {
    // Single-flight: 40 concurrent riders arriving the instant the TTL
    // expires must still produce exactly one upstream call.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        if (!doFetch) return;
        // Open-Meteo first (richer: it carries a condition code), the
        // National Weather Service when it will not answer. Each source is
        // independently allowed to fail; only a parsed forecast replaces the
        // cache, so a bad day upstream leaves the last good one standing.
        const deadline = now() + FETCH_TIMEOUT_MS;
        let hourly: WeatherHour[] | null = null;
        try {
          hourly = await fromOpenMeteo(doFetch, deadline);
        } catch { /* try the fallback */ }
        if (!hourly) {
          try {
            hourly = await fromNws(doFetch, deadline);
          } catch { /* both down — last good value stands */ }
        }
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
