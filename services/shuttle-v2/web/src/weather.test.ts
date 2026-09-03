import { describe, expect, it } from "vitest";

import {
  conditionText, RAIN_PROBABILITY_THRESHOLD, rainLikely, rainLikelyFrom, rainMessage,
  hourLabel, nextWetHour, outlookHours, temperatureText, weatherEmoji, weatherMessage, weatherTone,
  type RainVerdict, type WeatherHour,
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
      known: true,
    });
  });

  it("warns when the current hour is wet", () => {
    expect(rainLikely(hours(70, 0, 0), H18 + 30 * 60_000)).toEqual({
      likely: true,
      probability: 70,
      known: true,
    });
  });

  it("warns about rain that starts partway into the horizon", () => {
    // 17:56: the 17:00 bucket is dry, but the 18:00 one begins in four
    // minutes and is soaking. This is the rider the feature exists for.
    const v = rainLikely(hoursFrom(-1, 10, 80, 0), H18 - 4 * 60_000);
    expect(v).toEqual({ likely: true, probability: 80, known: true });
  });

  it("takes the peak across the overlapping buckets, not the first", () => {
    expect(rainLikely(hours(20, 65, 0), H18 + 10 * 60_000).probability).toBe(65);
  });

  it("ignores buckets wholly outside the next hour", () => {
    // Two hours out: 95% is real rain, but not on this rider's walk.
    expect(rainLikely(hours(0, 0, 95), H18 + 5 * 60_000)).toEqual({
      likely: false,
      probability: 0,
      known: true, // buckets exist and are dry — that is information too
    });
  });

  it("ignores buckets that have already passed", () => {
    const past = [{ timeMs: H18 - 3 * HOUR, probability: 100, precipitationMm: 4 }];
    expect(rainLikely(past, H18)).toEqual({ likely: false, probability: 0, known: false });
  });

  it("fires exactly at the threshold, not below it", () => {
    const at = rainLikely(hours(RAIN_PROBABILITY_THRESHOLD), H18);
    const below = rainLikely(hours(RAIN_PROBABILITY_THRESHOLD - 1), H18);
    expect(at.likely).toBe(true);
    expect(below.likely).toBe(false);
  });

  it("never throws or warns on junk", () => {
    expect(rainLikely(null, H18)).toEqual({ likely: false, probability: 0, known: false });
    expect(rainLikely(undefined, H18)).toEqual({ likely: false, probability: 0, known: false });
    expect(rainLikely([], H18)).toEqual({ likely: false, probability: 0, known: false });
    expect(rainLikely(hours(80), NaN)).toEqual({ likely: false, probability: 0, known: false });
    const junk = [
      { timeMs: NaN, probability: 100 },
      { timeMs: H18, probability: NaN },
      null as unknown as WeatherHour,
    ];
    expect(rainLikely(junk, H18)).toEqual({ likely: false, probability: 0, known: false });
  });

  it("rounds the reported probability for display", () => {
    expect(rainLikely([{ timeMs: H18, probability: 62.4 }], H18).probability).toBe(62);
  });
});

describe("rainLikelyFrom", () => {
  it("says no rain when the forecast is unavailable", () => {
    expect(rainLikelyFrom({ available: false }, H18)).toEqual({ likely: false, probability: 0, known: false });
    expect(rainLikelyFrom(null, H18)).toEqual({ likely: false, probability: 0, known: false });
    expect(rainLikelyFrom(undefined, H18)).toEqual({ likely: false, probability: 0, known: false });
  });

  it("reads the hourly block when it is available", () => {
    const v = rainLikelyFrom({ available: true, hourly: hours(75) }, H18);
    expect(v).toEqual({ likely: true, probability: 75, known: true });
  });
});

describe("the weather line", () => {
  const v = (probability: number, extra: Partial<RainVerdict> = {}): RainVerdict => ({
    likely: probability >= 50, probability, known: true, ...extra,
  });

  it("says something on a dry day too — the line is always on", () => {
    // A line that only appears when it rains is one nobody learns to look for.
    expect(weatherTone(v(0))).toBe("quiet");
    expect(weatherMessage(v(0, { temperatureF: 68, weatherCode: 0 })))
      .toBe("68°F (20°C) · Clear · no rain expected for a few hours");
    expect(weatherEmoji(v(0, { weatherCode: 0 }))).toBe("☀️");
  });

  it("mentions a small chance without alarm", () => {
    expect(weatherTone(v(20))).toBe("quiet");
    expect(weatherMessage(v(20, { temperatureF: 55, weatherCode: 3 })))
      .toBe("55°F (13°C) · Cloudy · 20% chance of rain within the hour");
  });

  it("warns about the walk legs once rain is likely", () => {
    expect(weatherTone(v(60))).toBe("quiet");
    expect(weatherMessage(v(60))).toBe(
      "60% chance of rain within the hour — the walk legs may get wet",
    );
    expect(weatherEmoji(v(60))).toBe("🌧");
  });

  it("becomes a warning at a high chance", () => {
    expect(weatherTone(v(85))).toBe("warning");
    expect(weatherMessage(v(85, { temperatureF: 61, weatherCode: 61 })))
      .toBe("Take an umbrella — 85% chance of rain within the hour · 61°F (16°C) · Rain");
    expect(weatherEmoji(v(85))).toBe("☔");
  });

  it("stays hidden when there is no forecast at all", () => {
    expect(weatherTone({ likely: false, probability: 0, known: false })).toBe("hidden");
    expect(weatherMessage({ likely: false, probability: 0, known: false })).toBe("");
  });

  it("degrades to the rain-only wording when the server sends no temperature", () => {
    expect(weatherMessage(v(0))).toBe("no rain expected for a few hours");
    expect(weatherMessage(v(30))).toBe("30% chance of rain within the hour");
  });

  it("describes the hour the rider is in, not the peak hour", () => {
    // 18:30: the 18:00 bucket is now (clear, 60°F), the 19:00 one brings rain.
    const now = Date.parse("2026-09-02T18:30:00-04:00");
    const hourly = [
      { timeMs: Date.parse("2026-09-02T18:00:00-04:00"), probability: 10, temperatureF: 60, weatherCode: 0 },
      { timeMs: Date.parse("2026-09-02T19:00:00-04:00"), probability: 80, temperatureF: 57, weatherCode: 61 },
    ];
    const verdict = rainLikely(hourly, now);
    expect(verdict.probability).toBe(80);
    expect(verdict.temperatureF).toBe(60);
    expect(conditionText(verdict.weatherCode)).toBe("Clear");
  });
});

describe("temperatureText — both units (report #66)", () => {
  it("leads with Fahrenheit and brackets the Celsius", () => {
    expect(temperatureText(68)).toBe("68°F (20°C)");
    expect(temperatureText(32)).toBe("32°F (0°C)");
    expect(temperatureText(5)).toBe("5°F (-15°C)");
  });

  it("converts the number the rider actually reads, not the raw one", () => {
    // Upstream sends 70.9; the line says 71°F, so the °C must be 71's.
    expect(temperatureText(70.9)).toBe("71°F (22°C)");
  });

  it("never prints a negative zero", () => {
    for (let f = -50; f <= 120; f++) expect(temperatureText(f)).not.toContain("-0°C");
  });

  it("says nothing when there is no temperature", () => {
    expect(temperatureText(undefined)).toBeNull();
    expect(temperatureText(NaN)).toBeNull();
  });
});

describe("the weather line carries both units", () => {
  it("puts them in the line the rider sees", () => {
    expect(weatherMessage({ likely: false, probability: 5, known: true, temperatureF: 68, weatherCode: 0 }))
      .toBe("68°F (20°C) · Clear · 5% chance of rain within the hour");
  });

  it("still works when the fallback source sends no temperature", () => {
    expect(weatherMessage({ likely: false, probability: 5, known: true }))
      .toBe("5% chance of rain within the hour");
  });
});

describe("the outlook — answering \"and later?\"", () => {
  const H = (h: number, prob: number, temp = 60) =>
    ({ timeMs: Date.parse(`2026-09-02T${String(h).padStart(2, "0")}:00:00-04:00`), probability: prob, temperatureF: temp });
  const now = Date.parse("2026-09-02T18:30:00-04:00");
  // Dry now, wet at nine: exactly the rider who is out for two hours.
  const evening = [H(18, 5), H(19, 10), H(20, 35), H(21, 70), H(22, 80), H(23, 60)];

  it("lists the hours from the one the rider is in", () => {
    const hours = outlookHours(evening, now);
    expect(hours).toHaveLength(6);
    expect(hourLabel(hours[0]!.timeMs)).toBe("6p");
    expect(hours[0]!.temperatureF).toBe(60);
  });

  it("names the hour the dry spell ends", () => {
    const later = nextWetHour(evening, now)!;
    expect(hourLabel(later.timeMs)).toBe("9p");
    expect(later.probability).toBe(70);
  });

  it("says so in the line, in one clause", () => {
    const v = { likely: false, probability: 10, known: true, temperatureF: 60, weatherCode: 0 };
    expect(weatherMessage(v, nextWetHour(evening, now)))
      .toBe("60°F (16°C) · Clear · dry now, 70% chance of rain around 9p");
  });

  it("stays quiet about later when the whole outlook is dry", () => {
    const dry = [H(18, 5), H(19, 5), H(20, 0), H(21, 5)];
    expect(nextWetHour(dry, now)).toBeNull();
    expect(weatherMessage({ likely: false, probability: 0, known: true }, null))
      .toBe("no rain expected for a few hours");
    // A small non-zero chance still reports itself rather than claiming dry.
    expect(weatherMessage({ likely: false, probability: 5, known: true }, null))
      .toBe("5% chance of rain within the hour");
  });

  it("does not repeat itself when it is already raining soon", () => {
    // The near-term verdict covers the next hour; the outlook must not
    // announce the same hour again.
    const soon = [H(18, 80), H(19, 85)];
    const v = { likely: true, probability: 85, known: true, temperatureF: 61 };
    expect(weatherMessage(v, nextWetHour(soon, now))).toContain("within the hour");
    expect(weatherMessage(v, nextWetHour(soon, now))).not.toContain("dry now");
  });

  it("ignores hours beyond the outlook horizon", () => {
    const tomorrow = [H(18, 5), { timeMs: now + 9 * 60 * 60_000, probability: 90 }];
    expect(nextWetHour(tomorrow, now)).toBeNull();
    expect(outlookHours(tomorrow, now)).toHaveLength(1);
  });
});
