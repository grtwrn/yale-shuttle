import { describe, expect, it } from 'vitest';
import type { BusData } from './map-data';
import { recentSpeedStatus } from './recentSpeed';

const now = Date.UTC(2026, 9, 18, 20);
function bus(): BusData {
  return { bus_id: 1, bus_name: '#317', route_id: 3, lat: 41.3, lon: -72.9, heading: 0,
    last_stop_id: 11, observed_at: now,
    recent_speed: { mph: 17.2, at: now, window_sec: 30, expires_at: now + 12_000 } };
}

describe('recent speed display', () => {
  it('rounds a fresh GPS average, names its window, and leaves the input alone', () => {
    const b = bus(), before = structuredClone(b);
    expect(recentSpeedStatus(b, now)).toEqual({ label: 'Recent speed ≈15 mph', detail: '30s GPS average' });
    expect(b).toEqual(before);
  });
  it('distinguishes a small supported speed from a stopped bus', () => {
    const b = bus(); b.recent_speed!.mph = 1.9; b.recent_speed!.window_sec = 25;
    expect(recentSpeedStatus(b, now)).toEqual({ label: 'Recent speed <5 mph', detail: '25s GPS average' });
  });
  it('hides the feature for an older server and declares a missing estimate unavailable', () => {
    const b = bus(); delete b.recent_speed;
    expect(recentSpeedStatus(b, now)).toBeNull();
    b.recent_speed = null;
    expect(recentSpeedStatus(b, now)?.label).toBe('Recent speed unavailable');
  });
  it('expires on the provider fix deadline even when the HTTP observation is younger', () => {
    expect(recentSpeedStatus(bus(), now + 12_000)?.label).toBe('Recent speed ≈15 mph');
    expect(recentSpeedStatus(bus(), now + 12_001)?.label).toBe('Recent speed unavailable');
  });
  it('removes the estimate during transport failure and restores a still-fresh one on recovery', () => {
    expect(recentSpeedStatus(bus(), now, false)?.label).toBe('Recent speed unavailable');
    expect(recentSpeedStatus(bus(), now, true)?.label).toBe('Recent speed ≈15 mph');
  });
  it.each([
    ['different observation', (b: BusData) => { b.observed_at = now - 1; }],
    ['future fix', (b: BusData) => { b.recent_speed!.at = now + 5_001; b.observed_at = now + 5_001; }],
    ['extended expiry', (b: BusData) => { b.recent_speed!.expires_at = now + 20_001; }],
    ['expiry before observation', (b: BusData) => { b.recent_speed!.expires_at = now - 1; }],
    ['short history', (b: BusData) => { b.recent_speed!.window_sec = 24; }],
    ['long history', (b: BusData) => { b.recent_speed!.window_sec = 31; }],
    ['NaN', (b: BusData) => { b.recent_speed!.mph = NaN; }],
    ['negative', (b: BusData) => { b.recent_speed!.mph = -1; }],
    ['impossible', (b: BusData) => { b.recent_speed!.mph = 120; }],
  ])('does not show an unsupported estimate: %s', (_label, change) => {
    const b = bus(); change(b);
    expect(recentSpeedStatus(b, now)?.label).toBe('Recent speed unavailable');
  });
});
