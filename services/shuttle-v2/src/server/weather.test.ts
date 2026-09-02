import { describe, expect, it, vi } from "vitest";

import {
  createWeatherService,
  parseForecast,
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
