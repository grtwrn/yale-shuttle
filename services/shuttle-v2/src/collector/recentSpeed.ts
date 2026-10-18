import { distanceMeters } from '../network/geo.js';
import { reconcileTracks, type BusObservation, type TrackPlan, type TrackedIdentity } from './detector.js';

const WINDOW_MS = 30_000;
const MIN_WINDOW_MS = 25_000;
const MAX_GAP_MS = 20_000;
const MAX_FIX_AGE_MS = 20_000;
const MAX_FUTURE_MS = 5_000;
const MAX_STEP_M_S = 50;
const MIN_EXTENT_M = 15;
const MAX_TRACKS = 256;
const MAX_SAMPLES = 32;
const MPH_PER_M_S = 2.2369362920544;

interface Sample { lat: number; lon: number; at: number; fixAt: number }
interface History extends TrackedIdentity { routeId: number; samples: Sample[] }

/** Display information only. Never use recent GPS speed to price an ETA. */
export interface RecentSpeedEstimate {
  mph: number;
  at: number;
  windowSec: number;
  /** The estimate expires with the GPS fix, even if HTTP keeps responding. */
  expiresAt: number;
}

/** Upstream normally sends Unix seconds. Accept milliseconds defensively. */
function fixTimeMs(raw: number | null | undefined, at: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw < 100_000_000_000 ? raw * 1000 : raw;
  return ms <= at + MAX_FUTURE_MS && at - ms <= MAX_FIX_AGE_MS ? ms : null;
}

/** A bounded trailing path, using the collector's own disambiguated track keys.
 * Repeated positions are observations, not evidence that the bus is stopped.
 * A frozen window therefore has no speed estimate. */
export class RecentSpeedTracker {
  private readonly histories = new Map<string, History>();

  get trackedCount(): number { return this.histories.size; }

  clear(): void { this.histories.clear(); }

  update(observations: readonly BusObservation[], plan: TrackPlan,
    rawFixTimes: ReadonlyMap<number, number | null | undefined>, now: number): void {
    for (const [key, history] of this.histories) {
      if (now - history.samples.at(-1)!.at > 60_000) this.histories.delete(key);
    }
    reconcileTracks(this.histories, plan);
    for (const o of observations) {
      const key = plan.keys.get(o.busId) ?? o.busName;
      const fixAt = fixTimeMs(rawFixTimes.get(o.busId), o.collectedAt);
      if (fixAt === null || ![o.lat, o.lon, o.collectedAt].every(Number.isFinite)
        || Math.abs(o.lat) > 90 || Math.abs(o.lon) > 180 || (o.lat === 0 && o.lon === 0)) {
        this.histories.delete(key);
        continue;
      }
      let history = this.histories.get(key);
      const previous = history?.samples.at(-1);
      if (previous && o.collectedAt <= previous.at) continue;
      if (previous && (fixAt < previous.fixAt
        || (fixAt === previous.fixAt && (o.lat !== previous.lat || o.lon !== previous.lon)))) {
        this.histories.delete(key);
        continue;
      }
      const reset = !history || history.busName !== o.busName || history.routeId !== o.routeId
        || !previous || o.collectedAt - previous.at > MAX_GAP_MS
        || distanceMeters(previous, o) / ((o.collectedAt - previous.at) / 1000) > MAX_STEP_M_S;
      if (reset) {
        history = { busId: o.busId, busName: o.busName, routeId: o.routeId, samples: [] };
        this.histories.set(key, history);
      }
      history!.busId = o.busId;
      history!.samples.push({ lat: o.lat, lon: o.lon, at: o.collectedAt, fixAt });
      // Keep one point before the boundary so a crossing segment can be split.
      while (history!.samples.length > 1 && history!.samples[1]!.at <= o.collectedAt - WINDOW_MS) {
        history!.samples.shift();
      }
      if (history!.samples.length > MAX_SAMPLES) history!.samples.shift();
    }
    while (this.histories.size > MAX_TRACKS) {
      const oldest = [...this.histories].reduce((a, b) =>
        a[1].samples.at(-1)!.at <= b[1].samples.at(-1)!.at ? a : b);
      this.histories.delete(oldest[0]);
    }
  }

  get(key: string, now: number): RecentSpeedEstimate | null {
    const samples = this.histories.get(key)?.samples;
    if (!samples?.length) return null;
    const last = samples.at(-1)!;
    const expiresAt = Math.min(last.at, last.fixAt) + MAX_FIX_AGE_MS;
    if (!Number.isFinite(now) || now > expiresAt || last.at - now > MAX_FUTURE_MS) return null;
    const start = Math.max(samples[0]!.at, last.at - WINDOW_MS);
    if (last.at - start < MIN_WINDOW_MS) return null;
    let distance = 0, first: { lat: number; lon: number } | undefined, extent = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!, b = samples[i]!;
      if (b.at <= start) continue;
      const portion = (b.at - Math.max(a.at, start)) / (b.at - a.at);
      distance += distanceMeters(a, b) * portion;
      first ??= { lat: b.lat + (a.lat - b.lat) * portion, lon: b.lon + (a.lon - b.lon) * portion };
      extent = Math.max(extent, distanceMeters(first, b));
    }
    // Zero/repeated fixes cannot distinguish a rest from a stalled GPS feed.
    if (extent < MIN_EXTENT_M) return null;
    return { mph: distance / ((last.at - start) / 1000) * MPH_PER_M_S,
      at: last.at, windowSec: (last.at - start) / 1000, expiresAt };
  }
}
