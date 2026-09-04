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
 * Ten hours, matching the server's `forecast_hours`, so a morning check still
 * surfaces an afternoon/evening system (rider report, 2026-09-03: 6 h queried
 * before 2pm hid rain due at 4pm).
 */
export const OUTLOOK_HORIZON_MS = 10 * 60 * 60_000;

export type RainVerdict = {
  likely: boolean;
  probability: number;
  /** Temperature now, °F, when the server sent one. */
  temperatureF?: number;
  /** Condition now, as a WMO code, when the server sent one. */
  weatherCode?: number;
  /**
   * The bucket `probability` was taken from: when it starts, and whether the
   * rider is already inside it.
   *
   * The line has to name a time (report #83, "it should tell what time rain
   * is expected") and only the bucket knows which one. `started` is what
   * keeps that honest: the peak may be the hour the rider is standing in, and
   * naming its start would read as "it is raining now" — the one thing this
   * line must never say, since the window is the next hour and nothing about
   * it is about NOW. Absent when the payload carried no usable bucket time.
   */
  peak?: { timeMs: number; started: boolean };
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
  let peakHour: WeatherHour | null = null;
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
    // Which bucket that number came from. A tie keeps the EARLIER hour — at
    // 4:23 with 29% in both the 4pm and 5pm buckets, the rain to plan around
    // is the nearer one — and the times are compared rather than the arrival
    // order, which the payload does not promise.
    if (peakHour === null
      || h.probability > peakHour.probability
      || (h.probability === peakHour.probability && h.timeMs < peakHour.timeMs)) {
      peakHour = h;
    }
    if (h.timeMs <= nowMs && (!current || h.timeMs > current.timeMs)) current = h;
  }
  if (!known) return NO_RAIN;
  const first = current ?? hourly.find((h) => h && h.timeMs + 60 * 60_000 > nowMs) ?? null;
  return {
    likely: peak >= RAIN_PROBABILITY_THRESHOLD,
    probability: Math.round(peak),
    known: true,
    ...(peakHour
      ? { peak: { timeMs: peakHour.timeMs, started: peakHour.timeMs <= nowMs } }
      : {}),
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
 * Which way the temperature is going, and how far — ONE number, not two.
 *
 * A rider asked for the high and the low; seeing both, the operator decided
 * (2026-09-03) that only the direction it is heading is actionable: at 9am on
 * a warming day the low is the temperature you are already standing in. So
 * this reports the extreme FURTHER from now — the high while it warms, the
 * low while it cools — with the hour it arrives.
 *
 * And only when the swing is worth a rider's attention: see
 * TREND_MIN_SWING_F. Null is a normal answer, not a failure.
 */
export interface TempTrend {
  dir: "up" | "down";
  temperatureF: number;
  timeMs: number;
}

/**
 * How big a swing has to be before the line spends words on it, °F.
 *
 * Every window has a high and a low, so without a floor the clause is never
 * absent — and overnight in New Haven it is the same non-fact every night:
 * "73°F · cooling to 71° by 6am" (measured off the live forecast, 2026-09-03).
 * The operator screenshotted that clause twice and wrote "I don't need to know
 * when its cooling" (report #90, cropped to "· cooling to 70° by 1am", about
 * five degrees off the temperature he was standing in).
 *
 * Ten degrees is roughly "you would dress differently", which is the only
 * reason this clause exists — a rider is not going to fetch a jacket over 3°.
 * Both lines he complained about are 5-8° and now say nothing; a real
 * afternoon climb (60° at 8am to 78° by 2pm) is 18° and still speaks.
 */
export const TREND_MIN_SWING_F = 10;

export function tempTrend(
  hours: readonly ForecastHour[] | null | undefined,
  nowF: number | undefined,
): TempTrend | null {
  if (!Array.isArray(hours) || typeof nowF !== "number" || !Number.isFinite(nowF)) return null;
  const withTemp = hours.filter(
    (h): h is ForecastHour & { temperatureF: number } =>
      !!h && typeof h.temperatureF === "number" && Number.isFinite(h.temperatureF),
  );
  if (withTemp.length === 0) return null;
  // EARLIEST hour at each extreme: "by 1pm" should name when it first gets
  // there, not the last hour it stays there.
  let hi = withTemp[0]!;
  let lo = withTemp[0]!;
  for (const h of withTemp) {
    if (h.temperatureF > hi.temperatureF) hi = h;
    if (h.temperatureF < lo.temperatureF) lo = h;
  }
  const now = Math.round(nowF);
  const up = hi.temperatureF - now;
  const down = now - lo.temperatureF;
  // Flat window, or a swing too small to change what a rider wears: nothing to
  // say. Silence here is not a gap — weatherMessage gives the room back to the
  // condition word ("73°F · Clear · no rain expected").
  if (Math.max(up, down) < TREND_MIN_SWING_F) return null;
  // Equal swings both ways (a dip then an equal climb): name whichever
  // arrives first, since that is the one the rider meets.
  const pickUp = up > down || (up === down && hi.timeMs <= lo.timeMs);
  const pick = pickUp ? hi : lo;
  return { dir: pickUp ? "up" : "down", temperatureF: pick.temperatureF, timeMs: pick.timeMs };
}

/**
 * "warming to 80° by 1pm" — spelled out, not "↑80°": a bare arrow beside a
 * plain number reads as a DELTA ("up 80 degrees") rather than a destination,
 * which is exactly the reading an operator got from it live (2026-09-03).
 *
 * Rides in the SAME sentence as the rest of the line, not its own row — a
 * second row was tried first and read as two separate facts when it is one.
 * To fit, it only ever appears in the quietest branch (temperature + no
 * near-term rain), which is also the branch where it is most useful: a rider
 * who is not about to get rained on is the one asking "what should I expect
 * the next couple hours". See weatherMessage for how that trade is made.
 *
 * Null when the destination reads the same as now IN THE UNIT ON SCREEN —
 * 66°F and 67°F are both 19°C, and "warming to 19°" beside "19°C" says
 * nothing.
 */
export function trendText(
  trend: TempTrend | null | undefined,
  nowF: number | undefined,
  unit: TempUnit,
  withHour = true,
  withDestination = true,
): string | null {
  if (!trend) return null;
  const to = temperatureIn(trend.temperatureF, unit);
  const from = temperatureIn(nowF, unit);
  if (to == null || to === from) return null;
  const verb = trend.dir === "up" ? "warming" : "cooling";
  // Direction only. The rain half has spent the line's remaining width on an
  // hour (report #83) and, measured at 390px, the destination no longer fits
  // beside it: "100°F · rain by 12am (29%) · warming to 108°" is 267px
  // against 238px of line; the same line ending in "warming" is 230px. The
  // full clause survives untouched in the branch it was written for — the
  // quiet one, where there is no rain hour to name.
  if (!withDestination) return verb;
  const label = withHour ? hourLabel(trend.timeMs) : "";
  return `${verb} to ${to}°${label ? ` by ${label}` : ""}`;
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
 * It has to fit ONE line on a phone, so the condition word is dropped
 * whenever there is a rain time to give — "Clear" is the least useful thing
 * on the line once it can say "rain likely 10pm". The window's high and low
 * are NOT in here for the same reason; they render on their own row (see
 * trendText). The hour-by-hour lives behind the tap.
 */
/**
 * True exactly when weatherMessage will spend its words on the temperature
 * trend rather than rain or the condition word — i.e. the quietest branch.
 * Shared with the caller so the hourly strip marks a cell ONLY when the line
 * actually named it; string-matching the rendered message to answer this
 * would work but silently rot the moment the wording changes.
 */
/**
 * True when weatherMessage has room to name the hour the trend arrives.
 *
 * The line carries BOTH facts the operator asked for — the chance of rain and
 * which way the temperature is going (2026-09-03) — and at 390px that is all
 * it can carry. Measured: "5% rain · warming to 80° by 2pm" fits;
 * "rain 9pm (70%) · warming to 80° by 2pm" does not. So the trend keeps its
 * hour only when the rain half is a bare percentage.
 */
export function trendHourFits(v: RainVerdict, later?: ForecastHour | null): boolean {
  return v.known && v.probability < RAIN_MENTION_THRESHOLD && !later;
}

/**
 * The rain half of the line, in priority order:
 *
 *   - a real chance within the hour → the percentage (plus the umbrella
 *     advice past 70%), because that is what a rider about to walk needs;
 *   - otherwise, rain arriving LATER in the window → the hour it starts,
 *     which is the whole point of the outlook (a rider out for the evening
 *     is not helped by "5% within the hour");
 *   - otherwise → nothing is coming, so say so.
 *
 * `terse` is set when the temperature trend is sharing the line, and only
 * then: "5% rain" instead of "5% chance of rain within the hour". Alone, the
 * longer wording still reads better and still fits, so the quiet-day line
 * did not change when the trend arrived beside it.
 *
 * The window is THE NEXT HOUR either way — `probability` is the peak across
 * every bucket overlapping it (see rainLikely) — which is why this never
 * says "now".
 */
export function nearTermRainWhen(v: RainVerdict): string | null {
  if (!v.peak || !Number.isFinite(v.peak.timeMs)) return null;
  // Already inside the bucket: the chance runs to the END of it, and that end
  // is the only honest clock time to print. Naming its start ("rain 4pm" at
  // 4:23) would say the rain is happening, which the line must never claim.
  const label = v.peak.started
    ? hourLabel(v.peak.timeMs + 60 * 60_000)
    : hourLabel(v.peak.timeMs);
  if (!label) return null;
  return v.peak.started ? `by ${label}` : label;
}

export function rainFragment(
  v: RainVerdict,
  later?: ForecastHour | null,
  terse = false,
): string {
  if (!v.known) return "";
  if (v.probability >= RAIN_MENTION_THRESHOLD) {
    // Name the hour (report #83) in the shape the later-rain branch already
    // uses, so there is one pattern to read and not two. Past the umbrella
    // threshold the percentage goes rather than the hour: "take an umbrella"
    // has already said the number is high, and the hour is the half the
    // rider asked for.
    const when = nearTermRainWhen(v);
    if (when) {
      // Past the umbrella threshold the PERCENTAGE gives, not the hour and
      // not the advice: measured at 390px, "100°F · rain by 12am (85%) —
      // umbrella" is 242px against 236px of line, while dropping the number
      // fits at 200px. A rider told to take an umbrella does not also need
      // to be told it is 85%.
      return v.probability >= RAIN_PROMINENT_THRESHOLD
        ? `rain ${when} — umbrella`
        : `rain ${when} (${v.probability}%)`;
    }
    // No usable bucket time (an older server, or the NWS fallback): the
    // wording degrades to the number alone rather than to nothing.
    const pct = terse
      ? `${v.probability}% rain`
      : `${v.probability}% chance of rain within the hour`;
    return v.probability >= RAIN_PROMINENT_THRESHOLD ? `${pct} — take an umbrella` : pct;
  }
  if (later) {
    return terse
      ? `rain ${hourLabel(later.timeMs)} (${later.probability}%)`
      : `rain likely ${hourLabel(later.timeMs)} (${later.probability}%)`;
  }
  return terse ? "no rain" : "no rain expected";
}

export function weatherMessage(
  v: RainVerdict,
  later?: ForecastHour | null,
  unit: TempUnit = "F",
  trend?: TempTrend | null,
): string {
  if (!v.known) return "";
  const temp = temperatureText(v.temperatureF, unit);
  // Both halves, always, in one line: what the sky is about to do and what
  // the temperature is about to do. Neither hides the other any more — the
  // previous cut showed the trend ONLY when there was no rain to report, so
  // the two facts the operator asked for were never on screen together
  // (2026-09-03).
  // Three facts, one phone line, and at 390px they do not all fit once the
  // rain half names an hour (report #83). Measured, in order of what a rider
  // acts on: the hour stays, the trend's destination temperature gives, and
  // past the umbrella threshold the trend gives entirely — "100°F · rain by
  // 12am — umbrella · warming" is 298px against 236px of line.
  const namesRainHour = v.probability >= RAIN_MENTION_THRESHOLD && nearTermRainWhen(v) !== null;
  const shouting = namesRainHour && v.probability >= RAIN_PROMINENT_THRESHOLD;
  const trendClause = shouting
    ? null
    : trendText(trend, v.temperatureF, unit, trendHourFits(v, later), !namesRainHour);
  const rain = rainFragment(v, later, !!trendClause);
  const parts = [temp, rain].filter(Boolean);
  if (trendClause) parts.push(trendClause);
  // With no trend to carry the line there is room for the condition word.
  // A wet code with a low chance ("Rain", 10%) replaces the rain half rather
  // than sitting beside it — "Rain · no rain expected" is nonsense.
  if (!trendClause && v.probability < RAIN_MENTION_THRESHOLD) {
    const cond = conditionText(v.weatherCode);
    if (cond && isWetCode(v.weatherCode) && !later) {
      return [temp, cond].filter(Boolean).join(" · ");
    }
    if (cond && !later) parts.splice(parts.length - 1, 0, cond);
  }
  return parts.join(" · ");
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
