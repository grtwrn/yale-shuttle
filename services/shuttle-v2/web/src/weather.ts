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
};

export type WeatherPayload =
  | { available: true; fetchedAtMs?: number; hourly: WeatherHour[] }
  | { available: false };

/** At or above this chance we say something. Below it, silence. */
export const RAIN_PROBABILITY_THRESHOLD = 50;
/** How far ahead we look — one walk leg's worth. */
export const RAIN_HORIZON_MS = 60 * 60_000;

export type RainVerdict = { likely: boolean; probability: number };

const NO_RAIN: RainVerdict = { likely: false, probability: 0 };

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
  for (const h of hourly) {
    if (!h || !Number.isFinite(h.timeMs) || !Number.isFinite(h.probability)) continue;
    const covers = h.timeMs + 60 * 60_000 > nowMs && h.timeMs < windowEnd;
    if (covers && h.probability > peak) peak = h.probability;
  }
  return { likely: peak >= RAIN_PROBABILITY_THRESHOLD, probability: Math.round(peak) };
}

/** Convenience over the whole endpoint payload (which may be unavailable). */
export function rainLikelyFrom(
  payload: WeatherPayload | null | undefined,
  nowMs: number,
): RainVerdict {
  if (!payload || payload.available !== true) return NO_RAIN;
  return rainLikely(payload.hourly, nowMs);
}

/** The one compact line shown under the trip options. */
export function rainMessage(v: RainVerdict): string {
  return `🌧 ${v.probability}% chance of rain in the next hour — the walk legs may get wet`;
}
