import { describe, expect, it } from "vitest";

import {
  RAIN_PROBABILITY_THRESHOLD,
  rainLikely,
  rainLikelyFrom,
  rainMessage,
  type WeatherHour,
} from "./weather";

const HOUR = 60 * 60_000;
// 2026-09-01 18:00 ET — an arbitrary fixed instant so nothing depends on the
// machine's clock or timezone.
const H18 = Date.parse("2026-09-01T22:00:00Z");

const hours = (...probs: number[]): WeatherHour[] =>
  probs.map((probability, i) => ({ timeMs: H18 + i * HOUR, probability, precipitationMm: 0 }));

/** Same, but the first bucket is `n` hours before 18:00. */
const hoursFrom = (startHourOffset: number, ...probs: number[]): WeatherHour[] =>
  probs.map((probability, i) => ({
    timeMs: H18 + (startHourOffset + i) * HOUR,
    probability,
    precipitationMm: 0,
  }));

describe("rainLikely", () => {
  it("is silent when the next hour is dry", () => {
    // 18:05, and the wet weather does not start until 20:00 — two hours out.
    expect(rainLikely(hours(5, 5, 90), H18 + 5 * 60_000)).toEqual({
      likely: false,
      probability: 5,
    });
  });

  it("warns when the current hour is wet", () => {
    expect(rainLikely(hours(70, 0, 0), H18 + 30 * 60_000)).toEqual({
      likely: true,
      probability: 70,
    });
  });

  it("warns about rain that starts partway into the horizon", () => {
    // 17:56: the 17:00 bucket is dry, but the 18:00 one begins in four
    // minutes and is soaking. This is the rider the feature exists for.
    const v = rainLikely(hoursFrom(-1, 10, 80, 0), H18 - 4 * 60_000);
    expect(v).toEqual({ likely: true, probability: 80 });
  });

  it("takes the peak across the overlapping buckets, not the first", () => {
    expect(rainLikely(hours(20, 65, 0), H18 + 10 * 60_000).probability).toBe(65);
  });

  it("ignores buckets wholly outside the next hour", () => {
    // Two hours out: 95% is real rain, but not on this rider's walk.
    expect(rainLikely(hours(0, 0, 95), H18 + 5 * 60_000)).toEqual({
      likely: false,
      probability: 0,
    });
  });

  it("ignores buckets that have already passed", () => {
    const past = [{ timeMs: H18 - 3 * HOUR, probability: 100, precipitationMm: 4 }];
    expect(rainLikely(past, H18)).toEqual({ likely: false, probability: 0 });
  });

  it("fires exactly at the threshold, not below it", () => {
    const at = rainLikely(hours(RAIN_PROBABILITY_THRESHOLD), H18);
    const below = rainLikely(hours(RAIN_PROBABILITY_THRESHOLD - 1), H18);
    expect(at.likely).toBe(true);
    expect(below.likely).toBe(false);
  });

  it("never throws or warns on junk", () => {
    expect(rainLikely(null, H18)).toEqual({ likely: false, probability: 0 });
    expect(rainLikely(undefined, H18)).toEqual({ likely: false, probability: 0 });
    expect(rainLikely([], H18)).toEqual({ likely: false, probability: 0 });
    expect(rainLikely(hours(80), NaN)).toEqual({ likely: false, probability: 0 });
    const junk = [
      { timeMs: NaN, probability: 100 },
      { timeMs: H18, probability: NaN },
      null as unknown as WeatherHour,
    ];
    expect(rainLikely(junk, H18)).toEqual({ likely: false, probability: 0 });
  });

  it("rounds the reported probability for display", () => {
    expect(rainLikely([{ timeMs: H18, probability: 62.4 }], H18).probability).toBe(62);
  });
});

describe("rainLikelyFrom", () => {
  it("says no rain when the forecast is unavailable", () => {
    expect(rainLikelyFrom({ available: false }, H18)).toEqual({ likely: false, probability: 0 });
    expect(rainLikelyFrom(null, H18)).toEqual({ likely: false, probability: 0 });
    expect(rainLikelyFrom(undefined, H18)).toEqual({ likely: false, probability: 0 });
  });

  it("reads the hourly block when it is available", () => {
    const v = rainLikelyFrom({ available: true, hourly: hours(75) }, H18);
    expect(v).toEqual({ likely: true, probability: 75 });
  });
});

describe("rainMessage", () => {
  it("spells out the chance without promising anything about the ride", () => {
    expect(rainMessage({ likely: true, probability: 60 })).toBe(
      "🌧 60% chance of rain in the next hour — the walk legs may get wet",
    );
  });
});
