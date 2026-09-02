import { describe, expect, it, vi } from "vitest";

import {
  budgetMs,
  createWeatherService,
  MIN_ATTEMPT_MS,
  parseForecast,
  parseNwsForecast,
  WEATHER_MAX_AGE_MS,
  WEATHER_TTL_MS,
} from "./weather.js";

// A realistic Open-Meteo body: local wall-clock strings plus the offset that
// turns them back into instants. ET is UTC-4 in September.
const OFFSET_SEC = -4 * 3600;
const BODY = {
  latitude: 41.31,
  longitude: -72.93,
  utc_offset_seconds: OFFSET_SEC,
  hourly: {
    time: ["2026-09-01T18:00", "2026-09-01T19:00", "2026-09-01T20:00"],
    precipitation_probability: [10, 60, 5],
    precipitation: [0, 1.4, 0],
  },
};

const okResponse = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response;

describe("parseForecast", () => {
  it("converts local wall-clock times to the right instant", () => {
    const hours = parseForecast(BODY)!;
    expect(hours).toHaveLength(3);
    // 18:00 ET on 2026-09-01 is 22:00 UTC.
    expect(hours[0]!.timeMs).toBe(Date.parse("2026-09-01T22:00:00Z"));
    expect(hours[1]!.probability).toBe(60);
    expect(hours[1]!.precipitationMm).toBe(1.4);
  });

  it("does not depend on the process timezone", () => {
    // Same instant whichever way the box is set — the offset comes from the
    // payload, never from Date's local interpretation.
    const shifted = { ...BODY, utc_offset_seconds: 0 };
    const hours = parseForecast(shifted)!;
    expect(hours[0]!.timeMs).toBe(Date.parse("2026-09-01T18:00:00Z"));
  });

  it("rejects a shape it does not recognise", () => {
    expect(parseForecast(null)).toBeNull();
    expect(parseForecast({})).toBeNull();
    expect(parseForecast({ hourly: {} })).toBeNull();
    expect(parseForecast({ hourly: { time: [], precipitation_probability: [] } })).toBeNull();
    expect(parseForecast({ error: true, reason: "nope" })).toBeNull();
  });

  it("fills in missing numbers rather than dropping the hour", () => {
    const hours = parseForecast({
      utc_offset_seconds: OFFSET_SEC,
      hourly: { time: ["2026-09-01T18:00"], precipitation_probability: [null] },
    })!;
    expect(hours[0]!.probability).toBe(0);
    expect(hours[0]!.precipitationMm).toBe(0);
  });
});

describe("createWeatherService", () => {
  it("calls upstream once and serves the cache for the whole TTL", async () => {
    let t = 1_000_000;
    const fetchImpl = vi.fn(async () => okResponse(BODY));
    const svc = createWeatherService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t });

    const first = await svc.get();
    expect(first.available).toBe(true);
    t += WEATHER_TTL_MS - 1;
    await svc.get();
    await svc.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes behind the response once the TTL lapses", async () => {
    let t = 1_000_000;
    const fetchImpl = vi.fn(async () => okResponse(BODY));
    const svc = createWeatherService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t });
    await svc.get();

    t += WEATHER_TTL_MS + 1;
    // The stale value comes back immediately; the refetch happens behind it.
    const stale = await svc.get();
    expect(stale).toMatchObject({ available: true, fetchedAtMs: 1_000_000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("makes ONE upstream call for a burst of concurrent cold requests", async () => {
    const fetchImpl = vi.fn(async () => okResponse(BODY));
    const svc = createWeatherService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all(Array.from({ length: 20 }, () => svc.get()));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serves the last good forecast when upstream breaks", async () => {
    let t = 1_000_000;
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("network down");
      return okResponse(BODY);
    });
    const svc = createWeatherService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t });
    await svc.get();

    fail = true;
    t += WEATHER_TTL_MS + 1;
    await svc.get();
    await new Promise((r) => setTimeout(r, 0));
    const after = await svc.get();
    expect(after).toMatchObject({ available: true, fetchedAtMs: 1_000_000 });
  });

  it("reports unavailable rather than throwing when it never succeeded", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const svc = createWeatherService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(svc.get()).resolves.toEqual({ available: false });
  });

  it("treats a non-200 as a failure, not as data", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response);
    const svc = createWeatherService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(svc.get()).resolves.toEqual({ available: false });
  });

  it("stops serving a forecast that has gone truly stale", async () => {
    let t = 1_000_000;
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("still down");
      return okResponse(BODY);
    });
    const svc = createWeatherService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t });
    await svc.get();
    fail = true;
    t += WEATHER_MAX_AGE_MS + 1;
    await expect(svc.get()).resolves.toEqual({ available: false });
  });
});

describe("the National Weather Service fallback", () => {
  // Open-Meteo's free tier sheds load: on 2026-09-02 it returned
  // 503 "The service is overloaded" to the production machine for minutes at
  // a time, long enough that a restart left the cache cold and riders saw no
  // weather at all, then recovered by itself. The fallback is what makes the
  // next such spell invisible.
  const NWS_POINT = { properties: { forecastHourly: "https://api.weather.gov/gridpoints/OKX/66,75/forecast/hourly" } };
  const NWS_HOURLY = {
    properties: {
      periods: [
        { startTime: "2026-09-02T16:00:00-04:00", temperature: 72, temperatureUnit: "F", probabilityOfPrecipitation: { value: 25 }, shortForecast: "Chance Rain Showers" },
        { startTime: "2026-09-02T17:00:00-04:00", temperature: 70, temperatureUnit: "F", probabilityOfPrecipitation: { value: null }, shortForecast: "Cloudy" },
      ],
    },
  };

  const jsonRes = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("parses the NWS shape into the same buckets", () => {
    const hours = parseNwsForecast(NWS_HOURLY)!;
    expect(hours).toHaveLength(2);
    expect(hours[0]).toMatchObject({
      timeMs: Date.parse("2026-09-02T16:00:00-04:00"),
      probability: 25,
      temperatureF: 72,
    });
    // A null probability means "nothing worth reporting", not "unknown".
    expect(hours[1]!.probability).toBe(0);
    // No condition code from this source — better absent than invented.
    expect(hours[0]!.weatherCode).toBeUndefined();
  });

  it("converts a Celsius period rather than trusting the unit", () => {
    const c = { properties: { periods: [{ startTime: "2026-09-02T16:00:00-04:00", temperature: 20, temperatureUnit: "C", probabilityOfPrecipitation: { value: 10 } }] } };
    expect(parseNwsForecast(c)![0]!.temperatureF).toBe(68);
  });

  it("returns null for a shape it does not recognise", () => {
    expect(parseNwsForecast(null)).toBeNull();
    expect(parseNwsForecast({})).toBeNull();
    expect(parseNwsForecast({ properties: { periods: [] } })).toBeNull();
    expect(parseNwsForecast({ properties: { periods: [{ startTime: "nonsense" }] } })).toBeNull();
  });

  it("falls back when Open-Meteo refuses, and serves the result", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (u: string | URL) => {
      const url = String(u);
      calls.push(url);
      if (url.includes("open-meteo")) return jsonRes({ reason: "The service is overloaded", error: true }, 503);
      if (url.includes("/points/")) return jsonRes(NWS_POINT);
      return jsonRes(NWS_HOURLY);
    }) as unknown as typeof fetch;
    const svc = createWeatherService({ fetchImpl, now: () => 1_000_000 });
    const payload = await svc.get();
    expect(payload.available).toBe(true);
    if (payload.available) expect(payload.hourly[0]!.temperatureF).toBe(72);
    expect(calls[0]).toContain("open-meteo");
    expect(calls.some((c) => c.includes("/points/"))).toBe(true);
  });

  it("resolves the NWS grid URL once, not on every refresh", async () => {
    let points = 0;
    const fetchImpl = (async (u: string | URL) => {
      const url = String(u);
      if (url.includes("open-meteo")) return jsonRes({}, 503);
      if (url.includes("/points/")) { points += 1; return jsonRes(NWS_POINT); }
      return jsonRes(NWS_HOURLY);
    }) as unknown as typeof fetch;
    let t = 1_000_000;
    const svc = createWeatherService({ fetchImpl, now: () => t });
    await svc.get();
    t += WEATHER_TTL_MS + 1;
    await svc.get();
    await svc.get();
    expect(points).toBe(1);
  });

  it("still answers unavailable, never throws, when both sources are down", async () => {
    const fetchImpl = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const svc = createWeatherService({ fetchImpl, now: () => 1_000_000 });
    await expect(svc.get()).resolves.toEqual({ available: false });
  });
});

describe("the whole refresh shares one timeout budget", () => {
  // Chaining two providers at a fresh 5 s each blocked the first cold request
  // for 10 s, and single-flight makes every concurrent rider wait with it.
  it("hands the second provider what is left, not another full timeout", () => {
    const deadline = 10_000;
    expect(budgetMs(deadline, 0)).toBe(10_000);
    expect(budgetMs(deadline, 6_000)).toBe(4_000);
  });

  it("never hands out a zero or negative timeout", () => {
    expect(budgetMs(10_000, 10_000)).toBe(MIN_ATTEMPT_MS);
    expect(budgetMs(10_000, 99_999)).toBe(MIN_ATTEMPT_MS);
    expect(budgetMs(NaN, 0)).toBe(MIN_ATTEMPT_MS);
  });
});
