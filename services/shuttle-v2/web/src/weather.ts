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
/** How far ahead the "will I get wet on this trip" verdict looks. */
export const RAIN_HORIZON_MS = 60 * 60_000;
/**
 * How far ahead the line will look to answer "and later?". A rider out for
 * the evening is not helped by "no rain within the hour" if it starts at
 * nine, so when the next hour is dry the line says when the dry spell ends.
 */
export const OUTLOOK_HORIZON_MS = 6 * 60 * 60_000;

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
/** Below this the line stops quoting a number: "12% chance of rain" is noise
 *  a rider cannot act on. At or above it the number is quoted plainly, with
 *  no adjective — 45% is neither "likely" nor "unlikely", it is 45%. */
export const RAIN_MENTION_THRESHOLD = 20;

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

/**
 * The temperature, in both units.
 *
 * Fahrenheit leads — this is a New Haven shuttle — but plenty of riders grew
 * up on Celsius, so the conversion rides along in brackets rather than behind
 * a setting nobody would find (rider report #66). Converting the ALREADY
 * ROUNDED Fahrenheit keeps the halves consistent: whatever °F a rider reads is
 * exactly what the °C was computed from.
 */
/**
 * Which unit the rider reads. Yale's students are half international, so
 * neither unit is "the" unit — but printing BOTH ("68°F (20°C)") spent a third
 * of a one-line summary on saying the same thing twice, so the rider picks
 * one and it sticks (operator, 2026-09-02).
 */
export type TempUnit = "F" | "C";

export const TEMP_UNIT_LS_KEY = "shuttle.tempUnit";

/** Fahrenheit unless the rider said otherwise. Never throws: a browser with
 *  storage blocked (private mode, "block all cookies") just gets the default. */
export function loadTempUnit(): TempUnit {
  try {
    return localStorage.getItem(TEMP_UNIT_LS_KEY) === "C" ? "C" : "F";
  } catch {
    return "F";
  }
}

export function saveTempUnit(unit: TempUnit): void {
  try {
    localStorage.setItem(TEMP_UNIT_LS_KEY, unit);
  } catch {
    /* storage blocked — the choice just won't outlive the tab */
  }
}

/** The number the rider sees, already rounded. Both feeds report Fahrenheit. */
export function temperatureIn(fahrenheit: number | undefined, unit: TempUnit): number | null {
  if (typeof fahrenheit !== "number" || !Number.isFinite(fahrenheit)) return null;
  const f = Math.round(fahrenheit);
  if (unit === "F") return f;
  const c = Math.round(((f - 32) * 5) / 9);
  // -0 would print as "-0°"; only 32°F lands there, but the guard is free.
  return Object.is(c, -0) ? 0 : c;
}

/** "68°F" / "20°C" — for the summary line. */
export function temperatureText(
  fahrenheit: number | undefined,
  unit: TempUnit = "F",
): string | null {
  const v = temperatureIn(fahrenheit, unit);
  return v == null ? null : `${v}°${unit}`;
}

/**
 * Warmest and coolest hour of the window the strip shows — NOT the calendar
 * day's high/low. A rider deciding what to wear for the next few hours is
 * asking about those hours (operator, 2026-09-03).
 */
export type OutlookRange = { highF: number; lowF: number };

export function outlookRange(
  hours: readonly ForecastHour[] | null | undefined,
): OutlookRange | null {
  if (!Array.isArray(hours)) return null;
  const temps = hours
    .map((h) => h?.temperatureF)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  if (temps.length === 0) return null;
  return { highF: Math.max(...temps), lowF: Math.min(...temps) };
}

/**
 * "↑67° ↓60°", in the rider's unit — rendered on its own row under the
 * sentence, not inside it: in the sentence it pushed every branch past one
 * line on a 390px phone, and the dry branch ("69°F ↑80° ↓69° · Cloudy · no
 * rain expected") shipped wrapped on 2026-09-03 before this was caught live.
 * Null when there is nothing to add: no
 * temperatures at all, or a window flat enough that both ends round to the
 * same number in the unit being shown (66°F and 67°F are both 19°C).
 */
export function rangeText(
  range: OutlookRange | null | undefined,
  unit: TempUnit,
): string | null {
  if (!range) return null;
  const hi = temperatureIn(range.highF, unit);
  const lo = temperatureIn(range.lowF, unit);
  if (hi == null || lo == null || hi === lo) return null;
  return `↑${hi}° ↓${lo}°`;
}

/** "68°" — for the hourly strip, where the unit is stated once on the toggle. */
export function degreesText(fahrenheit: number | undefined, unit: TempUnit): string {
  const v = temperatureIn(fahrenheit, unit);
  return v == null ? "—" : `${v}°`;
}

export type ForecastHour = { timeMs: number; temperatureF?: number; probability: number };

/**
 * The hours the line and its expanded view describe: from the one the rider
 * is standing in, out to the outlook horizon, in order.
 */
export function outlookHours(
  hourly: readonly WeatherHour[] | null | undefined,
  nowMs: number,
): ForecastHour[] {
  if (!Array.isArray(hourly) || !Number.isFinite(nowMs)) return [];
  return hourly
    .filter((h) => h && Number.isFinite(h.timeMs) && Number.isFinite(h.probability)
      && h.timeMs + 60 * 60_000 > nowMs && h.timeMs < nowMs + OUTLOOK_HORIZON_MS)
    .map((h) => ({
      timeMs: h.timeMs,
      probability: Math.max(0, Math.min(100, Math.round(h.probability))),
      ...(typeof h.temperatureF === "number" ? { temperatureF: Math.round(h.temperatureF) } : {}),
    }))
    .sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * The first hour past the next one that is wet enough to mention, if any.
 *
 * This is what turns "no rain within the hour" into an answer for a rider who
 * will be out for three: the useful fact is not a table of hours, it is the
 * hour the dry spell ends.
 */
export function nextWetHour(
  hourly: readonly WeatherHour[] | null | undefined,
  nowMs: number,
): ForecastHour | null {
  for (const h of outlookHours(hourly, nowMs)) {
    // Skip the hour the near-term verdict already covers.
    if (h.timeMs < nowMs + RAIN_HORIZON_MS && h.probability < RAIN_PROBABILITY_THRESHOLD) continue;
    if (h.probability >= RAIN_PROBABILITY_THRESHOLD) return h;
  }
  return null;
}

/**
 * "9pm" / "12am". Spelled out rather than the app's usual "9p", because a
 * bare letter beside a temperature and a percentage is one abbreviation too
 * many to decode at a glance (operator, 2026-09-02).
 */
export function hourLabel(timeMs: number, tz = "America/New_York"): string {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: true })
      .format(new Date(timeMs));
    return s.replace(/\s?AM$/i, "am").replace(/\s?PM$/i, "pm");
  } catch {
    return "";
  }
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
/**
 * The collapsed line: temperature, then WHEN IT WILL NEXT RAIN, in as few
 * words as that takes.
 *
 * It has to fit one line on a phone, so the condition word is dropped
 * whenever there is a rain time to give — "Clear" is the least useful thing
 * on the line once it can say "rain likely 10pm". The hour-by-hour lives
 * behind the tap.
 */
export function weatherMessage(
  v: RainVerdict,
  later?: ForecastHour | null,
  unit: TempUnit = "F",
): string {
  if (!v.known) return "";
  const temp = temperatureText(v.temperatureF, unit);
  const head = temp ? `${temp} · ` : "";
  // "within the hour", never "now": `probability` is the PEAK across every
  // bucket that overlaps the next hour (see rainLikely), so at 20:05 an 85%
  // bucket at 21:00 would have the line announcing rain up to 55 minutes
  // early. The number and the window are quoted as they are; only the
  // umbrella clause changes with severity, so nothing about the wording
  // flips at the 69→70 boundary.
  if (v.probability >= RAIN_PROMINENT_THRESHOLD) {
    return `${head}${v.probability}% chance of rain within the hour — take an umbrella`;
  }
  if (v.probability >= RAIN_MENTION_THRESHOLD) {
    return `${head}${v.probability}% chance of rain within the hour`;
  }
  // Dry for the next hour: spend the words on when that ends. This branch is
  // BELOW the near-term one deliberately — a rider with 45% in the next hour
  // must not be told about 9pm instead.
  if (later) {
    return `${head}rain likely ${hourLabel(later.timeMs)} (${later.probability}%)`;
  }
  const cond = conditionText(v.weatherCode);
  // A wet code with a low chance ("Rain", 10%) must not print "Rain · no rain
  // expected" — the condition alone is the honest line.
  if (cond && isWetCode(v.weatherCode)) return `${head}${cond}`;
  return `${head}${cond ? `${cond} · ` : ""}no rain expected`;
}

/** WMO codes from 50 up are drizzle/rain/snow/showers/thunderstorms. */
function isWetCode(code: number | undefined): boolean {
  return typeof code === "number" && Number.isFinite(code) && code >= 50;
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
