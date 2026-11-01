import { FIX_MAX_AGE_MS } from './rideEnd';
import { AT_PLACE_M } from './walk';

export type RiderPoint = { lat: number; lon: number };
export type RiderLocationState = {
  point: RiderPoint | null;
  /** Actual provider measurement time; never the callback receipt time. */
  observedAt: number | null;
  accuracy: number | null;
  /** Qualified tracking continuity, not a promise of physical accuracy. */
  trackingQualified: boolean;
};

export type RiderPosition = {
  coords: { latitude: number; longitude: number; accuracy?: number | null };
  timestamp?: number;
};

export type RiderLocationOptions = {
  trackingVisible: boolean;
  protectArmedPosition: boolean;
};

export type RiderLocationCache = {
  lat: number; lon: number; t: number; accuracy: number | null;
};

export const EMPTY_RIDER_LOCATION: RiderLocationState = {
  point: null, observedAt: null, accuracy: null, trackingQualified: false,
};
export const RIDER_LOCATION_FRESH_MS = FIX_MAX_AGE_MS;
export const RIDER_LOCATION_MAX_ACCURACY_M = AT_PLACE_M;
export const RIDER_LOCATION_FUTURE_TOLERANCE_MS = 5_000;
export const RIDER_LOCATION_CLOCK_MAX_AGE_MS = 24 * 3600_000;
export const RIDER_LOCATION_CACHE_MAX_AGE_MS = 5 * 60_000;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const epoch = (value: unknown): value is number => finite(value) && value > 0;
const pointValid = (lat: unknown, lon: unknown): lat is number =>
  finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const accuracyOf = (value: unknown): number | null => finite(value) && value >= 0 ? value : null;
const samePoint = (a: RiderPoint, b: RiderPoint): boolean => a.lat === b.lat && a.lon === b.lon;

/** Tracking interruption invalidates walking authority, never the rider's place. */
export function markRiderTrackingInterrupted(state: RiderLocationState): RiderLocationState {
  return state.trackingQualified ? { ...state, trackingQualified: false } : state;
}

/**
 * One acceptance path for watch, explicit locate and rescue callbacks.
 * A quiet, uninterrupted watch does not expire: stationary providers need not
 * emit periodic estimates. The age bound qualifies NEW measurements only.
 */
export function acceptRiderLocation(
  previous: RiderLocationState | null | undefined,
  position: RiderPosition,
  now: number,
  { trackingVisible, protectArmedPosition }: RiderLocationOptions,
): RiderLocationState {
  const prior = previous ?? EMPTY_RIDER_LOCATION;
  if (!epoch(now)) return prior;
  const sensorAt = epoch(position?.timestamp) ? position.timestamp : null;
  // Chronology is checked before data quality: a discarded old callback
  // cannot revoke a newer authority just because its coordinates are bad.
  if (prior.point && prior.observedAt !== null && sensorAt !== null && sensorAt < prior.observedAt) return prior;
  const coords = position?.coords;
  if (!coords || !pointValid(coords.latitude, coords.longitude)) return markRiderTrackingInterrupted(prior);
  const point = { lat: coords.latitude, lon: coords.longitude };

  if (prior.point && prior.observedAt !== null && sensorAt !== null) {
    if (sensorAt === prior.observedAt) {
      if (!samePoint(point, prior.point)) return prior;
      // A repeated old measurement is not a new degraded estimate or refresh.
      if (now - sensorAt > RIDER_LOCATION_FRESH_MS) return prior;
    }
  }

  const observedAt = sensorAt !== null
    && sensorAt <= now + RIDER_LOCATION_FUTURE_TOLERANCE_MS
    && now - sensorAt <= RIDER_LOCATION_CLOCK_MAX_AGE_MS ? sensorAt : null;
  const accuracy = accuracyOf(coords.accuracy);
  const trackingQualified = trackingVisible && observedAt !== null
    && now - observedAt <= RIDER_LOCATION_FRESH_MS
    && accuracy !== null && accuracy <= RIDER_LOCATION_MAX_ACCURACY_M;

  // An uncertain callback may explain why Leave is paused, but must not move
  // an armed plan to another point. Custom bus-based reminders retain the plan.
  if (protectArmedPosition && prior.point && !trackingQualified) {
    return markRiderTrackingInterrupted(prior);
  }
  return { point, observedAt, accuracy, trackingQualified };
}

/** A recent cache is a display seed only, including the legacy {lat,lon,t}. */
export function hydrateRiderLocation(cache: unknown, now: number): RiderLocationState {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache) || !epoch(now)) return EMPTY_RIDER_LOCATION;
  const value = cache as Partial<RiderLocationCache>;
  if (!pointValid(value.lat, value.lon) || !epoch(value.t)
    || value.t > now + RIDER_LOCATION_FUTURE_TOLERANCE_MS
    || now - value.t > RIDER_LOCATION_CACHE_MAX_AGE_MS) return EMPTY_RIDER_LOCATION;
  return { point: { lat: value.lat, lon: value.lon! }, observedAt: value.t,
    accuracy: accuracyOf(value.accuracy), trackingQualified: false };
}

/** No clock argument: persistence cannot relabel an old fix as newly measured. */
export function riderLocationCacheValue(state: RiderLocationState): RiderLocationCache | null {
  if (!state.point || !pointValid(state.point.lat, state.point.lon) || !epoch(state.observedAt)) return null;
  return { lat: state.point.lat, lon: state.point.lon, t: state.observedAt,
    accuracy: accuracyOf(state.accuracy) };
}
