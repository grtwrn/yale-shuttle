// Rain warning — the pure "should we mention rain?" rule.
//
// The server (`src/server/weather.ts`) owns the upstream call, the 10-minute
// cache and the epoch-ms normalisation; everything here is a decision over
// numbers, so it is unit-tested without React, timers or a network.
//
// The rule riders actually care about is "will I get wet on this trip", and
// every trip here starts with a walk leg, so the horizon is short: a >= 50%
// chance inside the next hour. Anything longer-range would fire on afternoons
// that are dry when the rider walks, and a warning that is usually wrong is
// one riders learn to ignore.

/** One forecast hour, as served by GET /api/weather. */
export type WeatherHour = {
  /** Start of the hour this bucket covers, epoch ms. */
  timeMs: number;
  /** Chance of precipitation during that hour, 0-100. */
  probability: number;
  /** Expected precipitation, mm. */
  precipitationMm?: number;
  /** Temperature, °F. Absent on an older server. */
  temperatureF?: number;
  /** WMO weather code. Absent on an older server. */
  weatherCode?: number;
};

export type WeatherPayload =
  | { available: true; fetchedAtMs?: number; hourly: WeatherHour[] }
  | { available: false };

/** At or above this chance we say something. Below it, silence. */
export const RAIN_PROBABILITY_THRESHOLD = 50;
/** How far ahead we look — one walk leg's worth. */
export const RAIN_HORIZON_MS = 60 * 60_000;

export type RainVerdict = {
  likely: boolean;
  probability: number;
  /** Temperature now, °F, when the server sent one. */
  temperatureF?: number;
  /** Condition now, as a WMO code, when the server sent one. */
  weatherCode?: number;
  /** False when there is no forecast at all — the line stays hidden. */
  known: boolean;
};

const NO_RAIN: RainVerdict = { likely: false, probability: 0, known: false };

/**
 * At or above this chance the line stops being a note and becomes a warning:
 * amber, bold, and leading with "Take an umbrella". Below it the same line
 * still shows the forecast, quietly.
 */
export const RAIN_PROMINENT_THRESHOLD = 70;

/**
 * The temperature, in both units.
 *
 * Upstream is asked for Fahrenheit and that stays the leading number — this
 * is a New Haven shuttle — but a good share of the riders grew up on Celsius,
 * so the conversion rides along in brackets rather than behind a setting
 * nobody would find (rider request, 2026-09-02). Converting the ALREADY
 * ROUNDED Fahrenheit keeps the two halves of the line consistent with each
 * other: whatever °F a rider reads is exactly what the °C was computed from.
 */
export function temperatureText(fahrenheit: number | undefined): string | null {
  if (typeof fahrenheit !== "number" || !Number.isFinite(fahrenheit)) return null;
  const f = Math.round(fahrenheit);
  // Math.round(-0.4) is -0, which prints as "-0°C".
  const c = Math.round(((f - 32) * 5) / 9) + 0;
  return `${f}°F (${c}°C)`;
}

/** Plain words for the WMO code — only the distinctions a rider acts on. */
export function conditionText(code: number | undefined): string | null {
  if (code == null || !Number.isFinite(code)) return null;
  if (code === 0) return "Clear";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Cloudy";
  if (code <= 49) return "Fog";
  if (code <= 59) return "Drizzle";
  if (code <= 69) return "Rain";
  if (code <= 79) return "Snow";
  if (code <= 84) return "Showers";
  if (code <= 86) return "Snow showers";
  return "Thunderstorms";
}

/**
 * Highest chance of rain in the next hour, and whether it clears the
 * threshold.
 *
 * An hourly bucket labelled 18:00 describes 18:00-19:00, so "the next hour"
 * means every bucket whose interval OVERLAPS [now, now + 1 h) — at 17:56 that
 * is both the 17:00 bucket (it is raining now) and the 18:00 one (it starts in
 * four minutes). Taking only the bucket containing `now` would miss rain that
 * begins minutes from now, which is precisely the rider this feature is for.
 *
 * Total defensiveness is deliberate: garbage in (missing array, NaN, an
 * unavailable payload) yields "no rain", never a throw and never a false
 * alarm.
 */
export function rainLikely(
  hourly: readonly WeatherHour[] | null | undefined,
  nowMs: number,
): RainVerdict {
  if (!Array.isArray(hourly) || !Number.isFinite(nowMs)) return NO_RAIN;
  const windowEnd = nowMs + RAIN_HORIZON_MS;
  let peak = 0;
  let known = false;
  // Conditions come from the bucket the rider is standing in, not the peak:
  // "42°F · Clear" should describe now, while the rain chance looks ahead.
  let current: WeatherHour | null = null;
  for (const h of hourly) {
    if (!h || !Number.isFinite(h.timeMs) || !Number.isFinite(h.probability)) continue;
    const covers = h.timeMs + 60 * 60_000 > nowMs && h.timeMs < windowEnd;
    if (!covers) continue;
    known = true;
    if (h.probability > peak) peak = h.probability;
    if (h.timeMs <= nowMs && (!current || h.timeMs > current.timeMs)) current = h;
  }
  if (!known) return NO_RAIN;
  const first = current ?? hourly.find((h) => h && h.timeMs + 60 * 60_000 > nowMs) ?? null;
  return {
    likely: peak >= RAIN_PROBABILITY_THRESHOLD,
    probability: Math.round(peak),
    known: true,
    ...(first && typeof first.temperatureF === "number"
      ? { temperatureF: Math.round(first.temperatureF) } : {}),
    ...(first && typeof first.weatherCode === "number"
      ? { weatherCode: first.weatherCode } : {}),
  };
}

/** Convenience over the whole endpoint payload (which may be unavailable). */
export function rainLikelyFrom(
  payload: WeatherPayload | null | undefined,
  nowMs: number,
): RainVerdict {
  if (!payload || payload.available !== true) return NO_RAIN;
  return rainLikely(payload.hourly, nowMs);
}

/** How loudly to say it: nothing at all, a quiet line, or a warning. */
export type WeatherTone = "hidden" | "quiet" | "warning";

export function weatherTone(v: RainVerdict): WeatherTone {
  if (!v.known) return "hidden";
  if (v.probability >= RAIN_PROMINENT_THRESHOLD) return "warning";
  return "quiet";
}

/**
 * The one compact line above the trip options.
 *
 * Always present when a forecast exists (operator request, 2026-09-02): a
 * rider deciding whether to walk a leg wants the weather whatever it says,
 * and a line that only ever appears on rainy days is one nobody learns to
 * look for. It gets louder as the chance climbs.
 */
export function weatherMessage(v: RainVerdict): string {
  if (!v.known) return "";
  const bits: string[] = [];
  const temp = temperatureText(v.temperatureF);
  if (temp) bits.push(temp);
  const cond = conditionText(v.weatherCode);
  if (cond) bits.push(cond);
  const head = bits.join(" · ");
  if (v.probability >= RAIN_PROMINENT_THRESHOLD) {
    return `Take an umbrella — ${v.probability}% chance of rain within the hour${head ? ` · ${head}` : ""}`;
  }
  if (v.likely) {
    return `${v.probability}% chance of rain within the hour — the walk legs may get wet${head ? ` · ${head}` : ""}`;
  }
  if (v.probability > 0) {
    return `${head}${head ? " · " : ""}${v.probability}% chance of rain within the hour`;
  }
  return `${head}${head ? " · " : ""}No rain expected within the hour`;
}

/** The emoji that leads the line. */
export function weatherEmoji(v: RainVerdict): string {
  if (v.probability >= RAIN_PROMINENT_THRESHOLD) return "☔";
  if (v.likely) return "🌧";
  const cond = conditionText(v.weatherCode);
  if (cond === "Clear") return "☀️";
  if (cond === "Snow" || cond === "Snow showers") return "🌨";
  if (cond === "Thunderstorms") return "⛈";
  if (cond === "Fog") return "🌫";
  if (cond === "Partly cloudy") return "🌤";
  return "☁️";
}

/** Kept for the leave-alert prefix, which only cares about the warning case. */
export function rainMessage(v: RainVerdict): string {
  return `${weatherEmoji(v)} ${weatherMessage(v)}`;
}
