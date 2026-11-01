import { describe, expect, it } from 'vitest';
import {
  EMPTY_RIDER_LOCATION, RIDER_LOCATION_CACHE_MAX_AGE_MS, RIDER_LOCATION_CLOCK_MAX_AGE_MS,
  RIDER_LOCATION_FRESH_MS, RIDER_LOCATION_FUTURE_TOLERANCE_MS, RIDER_LOCATION_MAX_ACCURACY_M,
  acceptRiderLocation, hydrateRiderLocation, markRiderTrackingInterrupted, riderLocationCacheValue,
  type RiderPosition,
} from './riderLocation';

const now = 1_793_571_000_000;
const visible = { trackingVisible: true, protectArmedPosition: false };
const armed = { trackingVisible: true, protectArmedPosition: true };
const fix = (timestamp = now, accuracy: number | null = 10, latitude = 41.31, longitude = -72.92): RiderPosition =>
  ({ timestamp, coords: { latitude, longitude, accuracy } });
const fine = () => acceptRiderLocation(null, fix(), now, visible);

describe('shared rider location acceptance', () => {
  it('keeps the actual point, sensor time and precision in one qualified snapshot', () => {
    expect(fine()).toEqual({ point: { lat: 41.31, lon: -72.92 }, observedAt: now,
      accuracy: 10, trackingQualified: true });
    expect(RIDER_LOCATION_FRESH_MS).toBe(60_000);
    expect(RIDER_LOCATION_MAX_ACCURACY_M).toBe(80);
  });

  it('preserves the armed point but pauses authority on a current unusable measurement', () => {
    const prior = fine();
    for (const [lat, lon] of [[NaN, -72.92], [Infinity, -72.92], [91, -72.92], [-91, -72.92],
      [41.31, NaN], [41.31, Infinity], [41.31, 181], [41.31, -181]]) {
      const rejected = acceptRiderLocation(prior, fix(now + 1000, 10, lat, lon), now + 1000, armed);
      expect(rejected).toEqual({ ...prior, trackingQualified: false });
      expect(rejected.point).toBe(prior.point);
    }
    expect(acceptRiderLocation(null, fix(now, 10, -90, 180), now, visible).point).toEqual({ lat: -90, lon: 180 });
    expect(acceptRiderLocation(prior, fix(), NaN, armed)).toBe(prior);
  });

  it('ignores an older callback from any current watch, locate or rescue path, keeping prior authority', () => {
    const prior = fine();
    for (const older of [now - 1, now - 90_000, now - RIDER_LOCATION_CLOCK_MAX_AGE_MS - 1]) {
      expect(acceptRiderLocation(prior, fix(older, 200, 41.32), now + 1000, armed)).toBe(prior);
      expect(acceptRiderLocation(prior, fix(older, 10, 41.32), now + 1000, visible)).toBe(prior);
      expect(acceptRiderLocation(prior, fix(older, 10, NaN), now + 1000, armed)).toBe(prior);
    }
  });

  it('refuses a changed coordinate on the same measurement clock', () => {
    const prior = fine();
    expect(acceptRiderLocation(prior, fix(now, 10, 41.32), now + 1000, visible)).toBe(prior);
    expect(acceptRiderLocation(prior, fix(now, 200, 41.32), now + 1000, armed)).toBe(prior);
    const duplicate = acceptRiderLocation(prior, fix(now), now + 1000, visible);
    expect(duplicate.observedAt).toBe(now);
    expect(duplicate.trackingQualified).toBe(true);
  });

  it('does not age-cancel a stationary uninterrupted watch or refresh a repeated old measurement', () => {
    const prior = fine();
    // No callback is required to keep this state. Even a repeated old sample
    // cannot be treated as a new degraded estimate or a new measurement time.
    const later = acceptRiderLocation(prior, fix(now), now + 10 * 60_000, armed);
    expect(later).toBe(prior);
    expect(later.trackingQualified).toBe(true);
    expect(riderLocationCacheValue(later)?.t).toBe(now);
  });

  it('uses age and accuracy boundaries when qualifying a NEW measurement', () => {
    expect(acceptRiderLocation(null, fix(now - 60_000, 80), now, visible).trackingQualified).toBe(true);
    expect(acceptRiderLocation(null, fix(now - 60_001, 80), now, visible).trackingQualified).toBe(false);
    expect(acceptRiderLocation(null, fix(now, 80.01), now, visible).trackingQualified).toBe(false);
    // Geolocation's accuracy value is nonnegative; zero is a valid estimate,
    // including browser emulation. It is not an absent/unknown measurement.
    expect(acceptRiderLocation(null, fix(now, 0), now, visible).trackingQualified).toBe(true);
    for (const accuracy of [-1, NaN, Infinity, null]) {
      const state = acceptRiderLocation(null, fix(now, accuracy), now, visible);
      expect(state.point).not.toBeNull();
      expect(state.accuracy).toBeNull();
      expect(state.trackingQualified).toBe(false);
    }
    expect(acceptRiderLocation(null, fix(), now,
      { trackingVisible: false, protectArmedPosition: false }).trackingQualified).toBe(false);
  });

  it('never replaces bad sensor time with the callback receipt clock', () => {
    for (const timestamp of [0, -1, NaN, Infinity, now + 5001, now - RIDER_LOCATION_CLOCK_MAX_AGE_MS - 1]) {
      const state = acceptRiderLocation(null, fix(timestamp), now, visible);
      expect(state.point).toEqual({ lat: 41.31, lon: -72.92 });
      expect(state.observedAt).toBeNull();
      expect(state.trackingQualified).toBe(false);
      expect(riderLocationCacheValue(state)).toBeNull();
    }
    const missing = acceptRiderLocation(null, { coords: fix().coords }, now, visible);
    expect(missing.observedAt).toBeNull();
    expect(acceptRiderLocation(null, fix(now + RIDER_LOCATION_FUTURE_TOLERANCE_MS), now, visible).observedAt)
      .toBe(now + 5000);
    expect(acceptRiderLocation(null, fix(now - RIDER_LOCATION_CLOCK_MAX_AGE_MS), now, visible).observedAt)
      .toBe(now - RIDER_LOCATION_CLOCK_MAX_AGE_MS);
  });

  it('protects every armed mode from a current-timestamp broad estimate and permits precise recovery', () => {
    const prior = fine();
    const uncertain = acceptRiderLocation(prior, fix(now + 1000, 200, 41.32), now + 1000, armed);
    expect(uncertain.point).toBe(prior.point);
    expect(uncertain.observedAt).toBe(now);
    expect(uncertain.accuracy).toBe(10);
    expect(uncertain.trackingQualified).toBe(false);
    const recovered = acceptRiderLocation(uncertain, fix(now + 2000, 10, 41.32), now + 2000, armed);
    expect(recovered).toEqual({ point: { lat: 41.32, lon: -72.92 }, observedAt: now + 2000,
      accuracy: 10, trackingQualified: true });
  });

  it('protects an armed point from unknown clocks and stale NEW acquisitions without attaching their metadata', () => {
    const prior = fine();
    for (const position of [fix(NaN, 10, 41.32), fix(now + 5001, 10, 41.32)]) {
      expect(acceptRiderLocation(prior, position, now, armed)).toEqual({ ...prior, trackingQualified: false });
    }
    const old = acceptRiderLocation(null, fix(now - 120_000), now - 120_000, visible);
    const laterButStale = acceptRiderLocation(old, fix(now - 61_000, 10, 41.32), now, armed);
    expect(laterButStale).toEqual({ ...old, trackingQualified: false });
  });

  it('keeps rough first/rescue positions usable outside an arm and clears the old time on a new unknown-clock point', () => {
    const prior = fine();
    const rough = acceptRiderLocation(prior, fix(now + 1000, 200, 41.32), now + 1000, visible);
    expect(rough).toEqual({ point: { lat: 41.32, lon: -72.92 }, observedAt: now + 1000,
      accuracy: 200, trackingQualified: false });
    const unknown = acceptRiderLocation(prior, fix(NaN, 200, 41.32), now + 1000, visible);
    expect(unknown).toEqual({ point: { lat: 41.32, lon: -72.92 }, observedAt: null,
      accuracy: 200, trackingQualified: false });
    const first = acceptRiderLocation(null, fix(now, 200), now, armed);
    expect(first.point).not.toBeNull();
    expect(first.trackingQualified).toBe(false);
  });

  it('interrupts tracking idempotently and restores it only through a qualifying current callback', () => {
    const prior = fine(), stopped = markRiderTrackingInterrupted(prior);
    expect(stopped).toEqual({ ...prior, trackingQualified: false });
    expect(stopped.point).toBe(prior.point);
    expect(markRiderTrackingInterrupted(stopped)).toBe(stopped);
    // A current watch may return this still-recent cached measurement. Its
    // sensor time stays unchanged; the current callback restores continuity.
    expect(acceptRiderLocation(stopped, fix(), now + 1000, armed).trackingQualified).toBe(true);
    expect(acceptRiderLocation(stopped, fix(now - 1), now + 1000, armed)).toBe(stopped);
    expect(markRiderTrackingInterrupted(EMPTY_RIDER_LOCATION)).toBe(EMPTY_RIDER_LOCATION);
  });
});

describe('actual-time rider location cache', () => {
  it('persists the actual measurement time and hydrates only display state, even for a precise recent cache', () => {
    const state = fine(), value = riderLocationCacheValue(state);
    expect(value).toEqual({ lat: 41.31, lon: -72.92, t: now, accuracy: 10 });
    expect(hydrateRiderLocation(value, now + 60_000)).toEqual({ ...state, trackingQualified: false });
    expect(riderLocationCacheValue(hydrateRiderLocation(value, now + 60_000))?.t).toBe(now);
    const zeroAccuracy = riderLocationCacheValue(acceptRiderLocation(null, fix(now, 0), now, visible));
    expect(zeroAccuracy?.accuracy).toBe(0);
    expect(hydrateRiderLocation(zeroAccuracy, now + 1000).accuracy).toBe(0);
  });

  it('supports the legacy timestamped cache without inventing accuracy or tracking authority', () => {
    const cached = hydrateRiderLocation({ lat: 41.31, lon: -72.92, t: now }, now + RIDER_LOCATION_CACHE_MAX_AGE_MS);
    expect(cached).toEqual({ point: { lat: 41.31, lon: -72.92 }, observedAt: now,
      accuracy: null, trackingQualified: false });
    expect(hydrateRiderLocation({ lat: 41.31, lon: -72.92, t: now }, now + RIDER_LOCATION_CACHE_MAX_AGE_MS + 1))
      .toBe(EMPTY_RIDER_LOCATION);
  });

  it('rejects invalid/future cache clocks and coordinates instead of making them a fresh session origin', () => {
    for (const cache of [null, [], {}, { lat: NaN, lon: -72.92, t: now }, { lat: 91, lon: -72.92, t: now },
      { lat: 41.31, lon: 181, t: now }, { lat: 41.31, lon: -72.92 },
      { lat: 41.31, lon: -72.92, t: Infinity }, { lat: 41.31, lon: -72.92, t: now + 5001 }]) {
      expect(hydrateRiderLocation(cache, now)).toBe(EMPTY_RIDER_LOCATION);
    }
    expect(riderLocationCacheValue(EMPTY_RIDER_LOCATION)).toBeNull();
  });
});
