import { describe, expect, it } from "vitest";

import {
  conditionText,
  degreesText,
  hourLabel,
  loadTempUnit,
  nextWetHour,
  outlookHours,
  outlookRange,
  RAIN_PROBABILITY_THRESHOLD,
  rainLikely,
  rainLikelyFrom,
  rangeText,
  saveTempUnit,
  temperatureText,
  weatherEmoji,
  weatherMessage,
  weatherTone,
  type RainVerdict,
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
      .toBe("68°F · Clear · no rain expected");
    expect(weatherEmoji(v(0, { weatherCode: 0 }))).toBe("☀️");
  });

  it("mentions a small chance without alarm", () => {
    expect(weatherTone(v(20))).toBe("quiet");
    expect(weatherMessage(v(20, { temperatureF: 55, weatherCode: 3 })))
      .toBe("55°F · 20% chance of rain within the hour");
  });

  it("warns about the walk legs once rain is likely", () => {
    expect(weatherTone(v(60))).toBe("quiet");
    expect(weatherMessage(v(60))).toBe("60% chance of rain within the hour");
    expect(weatherEmoji(v(60))).toBe("🌧");
  });

  it("becomes a warning at a high chance", () => {
    expect(weatherTone(v(85))).toBe("warning");
    expect(weatherMessage(v(85, { temperatureF: 61, weatherCode: 61 })))
      .toBe("61°F · 85% chance of rain within the hour — take an umbrella");
    expect(weatherEmoji(v(85))).toBe("☔");
  });

  it("stays hidden when there is no forecast at all", () => {
    expect(weatherTone({ likely: false, probability: 0, known: false })).toBe("hidden");
    expect(weatherMessage({ likely: false, probability: 0, known: false })).toBe("");
  });

  it("degrades to the rain-only wording when the server sends no temperature", () => {
    expect(weatherMessage(v(0))).toBe("no rain expected");
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

describe("temperatureText — the rider's unit (report #66)", () => {
  it("prints whichever unit was asked for", () => {
    expect(temperatureText(68, "F")).toBe("68°F");
    expect(temperatureText(68, "C")).toBe("20°C");
    expect(temperatureText(32, "C")).toBe("0°C");
    expect(temperatureText(5, "C")).toBe("-15°C");
  });

  it("converts the number the rider actually reads, not the raw one", () => {
    // Upstream sends 70.9; the line says 71°F, so the °C must be 71's.
    expect(temperatureText(70.9, "C")).toBe("22°C");
  });

  it("never prints a negative zero", () => {
    for (let f = -50; f <= 120; f++) {
      expect(temperatureText(f, "C")).not.toContain("-0°");
      expect(degreesText(f, "C")).not.toContain("-0°");
    }
  });

  it("says nothing when there is no temperature", () => {
    expect(temperatureText(undefined)).toBeNull();
    expect(temperatureText(NaN)).toBeNull();
  });
});

describe("the rider chooses the unit", () => {
  it("prints the one they picked, not both", () => {
    const v = { likely: false, probability: 5, known: true, temperatureF: 68, weatherCode: 0 };
    expect(weatherMessage(v)).toBe("68°F · Clear · no rain expected");
    expect(weatherMessage(v, null, "C")).toBe("20°C · Clear · no rain expected");
  });

  it("converts, and never prints -0°", () => {
    expect(temperatureText(68, "C")).toBe("20°C");
    expect(temperatureText(32, "C")).toBe("0°C");
    expect(temperatureText(32, "F")).toBe("32°F");
    expect(degreesText(68, "C")).toBe("20°");
    expect(degreesText(68, "F")).toBe("68°");
    expect(degreesText(undefined, "F")).toBe("—");
  });

  it("still works when the fallback source sends no temperature", () => {
    expect(weatherMessage({ likely: false, probability: 5, known: true }))
      .toBe("no rain expected");
    expect(weatherMessage({ likely: false, probability: 35, known: true }))
      .toBe("35% chance of rain within the hour");
  });

  it("defaults to Fahrenheit, and survives a browser with storage blocked", () => {
    const real = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { throw new Error("blocked"); },
    });
    // try/finally, or a failing assertion here leaves every later test in the
    // file with a localStorage that throws.
    try {
      expect(loadTempUnit()).toBe("F");
      expect(() => saveTempUnit("C")).not.toThrow();
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: real });
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
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
    expect(hourLabel(hours[0]!.timeMs)).toBe("6pm");
    expect(hours[0]!.temperatureF).toBe(60);
  });

  it("names the hour the dry spell ends", () => {
    const later = nextWetHour(evening, now)!;
    expect(hourLabel(later.timeMs)).toBe("9pm");
    expect(later.probability).toBe(70);
  });

  it("says so in the line, in one clause", () => {
    const v = { likely: false, probability: 10, known: true, temperatureF: 60, weatherCode: 0 };
    expect(weatherMessage(v, nextWetHour(evening, now)))
      .toBe("60°F · rain 9pm (70%)");
  });

  it("stays quiet about later when the whole outlook is dry", () => {
    const dry = [H(18, 5), H(19, 5), H(20, 0), H(21, 5)];
    expect(nextWetHour(dry, now)).toBeNull();
    expect(weatherMessage({ likely: false, probability: 0, known: true }, null))
      .toBe("no rain expected");
  });

  it("does not repeat itself when it is already raining soon", () => {
    // The near-term verdict covers the next hour; the outlook must not
    // announce the same hour again.
    const soon = [H(18, 80), H(19, 85)];
    const v = { likely: true, probability: 85, known: true, temperatureF: 61 };
    // The near-term number owns the line; the outlook must not name an hour
    // that is already inside the window the number covers.
    expect(weatherMessage(v, nextWetHour(soon, now))).toContain("within the hour");
    expect(weatherMessage(v, nextWetHour(soon, now))).not.toContain("7pm");
  });

  it("does not hide a near-term chance behind a later hour", () => {
    // 45% in the next hour and 70% at nine: the rider walking a leg NOW is
    // told about now. The nine o'clock hour is one tap away in the strip.
    const v = { likely: false, probability: 45, known: true, temperatureF: 60, weatherCode: 3 };
    expect(weatherMessage(v, nextWetHour(evening, now)))
      .toBe("60°F · 45% chance of rain within the hour");
  });

  it("never calls a coin flip unlikely, and never claims rain has started", () => {
    const at = (p: number) => weatherMessage({ likely: p >= 50, probability: p, known: true });
    for (const p of [20, 35, 49, 50, 69, 70, 85, 100]) {
      expect(at(p)).toContain(`${p}% chance of rain within the hour`);
      expect(at(p)).not.toContain("unlikely");
      expect(at(p)).not.toContain("now");
    }
    // Only the umbrella clause changes across the 69→70 boundary.
    expect(at(69)).toBe("69% chance of rain within the hour");
    expect(at(70)).toBe("70% chance of rain within the hour — take an umbrella");
  });

  it("does not print a wet condition beside \"no rain expected\"", () => {
    // Upstream says it is raining but puts the hour's chance at 10%.
    expect(weatherMessage({ likely: false, probability: 10, known: true, temperatureF: 55, weatherCode: 61 }, null))
      .toBe("55°F · Rain");
    expect(weatherMessage({ likely: false, probability: 10, known: true, temperatureF: 55, weatherCode: 3 }, null))
      .toBe("55°F · Cloudy · no rain expected");
  });

  it("ignores hours beyond the outlook horizon", () => {
    const tomorrow = [H(18, 5), { timeMs: now + 9 * 60 * 60_000, probability: 90 }];
    expect(nextWetHour(tomorrow, now)).toBeNull();
    expect(outlookHours(tomorrow, now)).toHaveLength(1);
  });
});

describe("the window's high and low (operator, 2026-09-03)", () => {
  const H = (h: number, prob: number, temp?: number) => ({
    timeMs: Date.parse(`2026-09-03T${String(h).padStart(2, "0")}:00:00-04:00`),
    probability: prob,
    ...(temp == null ? {} : { temperatureF: temp }),
  });
  const now = Date.parse("2026-09-03T18:30:00-04:00");

  it("reads the hours the strip shows, not the calendar day", () => {
    const hours = outlookHours([H(18, 5, 66), H(19, 10, 64), H(20, 35, 67), H(21, 70, 60)], now);
    expect(outlookRange(hours)).toEqual({ highF: 67, lowF: 60 });
  });

  it("says nothing when the feed carries no temperatures", () => {
    const hours = outlookHours([H(18, 5), H(19, 10)], now);
    expect(outlookRange(hours)).toBeNull();
    expect(rangeText(null, "F")).toBeNull();
    expect(outlookRange(null)).toBeNull();
    expect(outlookRange([])).toBeNull();
  });

  it("skips the hours that have no temperature rather than counting them as zero", () => {
    const hours = outlookHours([H(18, 5, 66), H(19, 10), H(20, 5, 71)], now);
    expect(outlookRange(hours)).toEqual({ highF: 71, lowF: 66 });
  });

  it("stays quiet when both ends round to the same number in the unit shown", () => {
    // 66-67°F is 19°C either way: two arrows pointing at one number is noise.
    expect(rangeText({ highF: 67, lowF: 66 }, "F")).toBe("↑67° ↓66°");
    expect(rangeText({ highF: 67, lowF: 66 }, "C")).toBeNull();
    expect(rangeText({ highF: 66, lowF: 66 }, "F")).toBeNull();
  });

  it("puts now first, then the window, in the line the rider reads", () => {
    const v = { likely: false, probability: 10, known: true, temperatureF: 66, weatherCode: 0 };
    const later = { timeMs: Date.parse("2026-09-03T21:00:00-04:00"), probability: 70 };
    expect(weatherMessage(v, later, "F", { highF: 67, lowF: 60 }))
      .toBe("66°F ↑67° ↓60° · rain 9pm (70%)");
    expect(weatherMessage(v, later, "C", { highF: 67, lowF: 60 }))
      .toBe("19°C ↑19° ↓16° · rain 9pm (70%)");
  });

  it("degrades to the old line when there is no range to show", () => {
    const v = { likely: false, probability: 10, known: true, temperatureF: 66, weatherCode: 0 };
    expect(weatherMessage(v, null, "F", null)).toBe("66°F · Clear · no rain expected");
    expect(weatherMessage(v, null, "F")).toBe("66°F · Clear · no rain expected");
  });

  it("shows the window even when the current temperature is missing", () => {
    const v = { likely: false, probability: 10, known: true };
    expect(weatherMessage(v, null, "F", { highF: 67, lowF: 60 }))
      .toBe("↑67° ↓60° · no rain expected");
  });
});
