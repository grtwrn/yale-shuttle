import type { BusData } from './map-data';

export interface RecentSpeedStatus { label: string; detail: string }

/** Older servers omit the field. Unknown or expired GPS speed is never zero. */
export function recentSpeedStatus(bus: BusData, now: number, available = true): RecentSpeedStatus | null {
  if (bus.recent_speed === undefined) return null;
  const speed = bus.recent_speed;
  if (!available || !speed || ![now, speed.mph, speed.at, speed.window_sec, speed.expires_at].every(Number.isFinite)
    || speed.mph < 0 || speed.mph > 115 || speed.at !== bus.observed_at
    || speed.at > now + 5_000 || speed.expires_at < now || speed.expires_at < speed.at
    || speed.expires_at > speed.at + 20_000 || speed.window_sec < 25 || speed.window_sec > 30) {
    return { label: 'Recent speed unavailable', detail: 'Waiting for enough fresh GPS movement.' };
  }
  const mph = Math.round(speed.mph / 5) * 5;
  return {
    label: mph === 0 ? 'Recent speed <5 mph' : `Recent speed ≈${mph} mph`,
    detail: `${Math.round(speed.window_sec)}s GPS average`,
  };
}
