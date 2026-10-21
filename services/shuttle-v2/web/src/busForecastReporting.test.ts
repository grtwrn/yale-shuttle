import { describe, expect, it } from 'vitest';
import { emptyForecastReportingState, forecastReportingNotice, forecastReportingSnapshot, stepForecastReporting,
  type ForecastReportingState } from './busForecastReporting';
import { reportingKey, type ReportingSnapshot, type ReportingWatch } from './busReporting';
import { attachServerEta } from './etaSource';
import type { BusData } from './map-data';
import fixture from './__fixtures__/blue-night-forecast-loss-2026-10-21.json';

const start = 1792547815075;
const watch: ReportingWatch = { busName: '38', routeLabel: 'Blue Night', routeIds: [13] };
const next: ReportingWatch = { ...watch, busName: '45' };
const bus = (at: number, name = '#38'): BusData => ({ observed_at: at, bus_id: 67979, bus_name: name,
  route_id: 13, lat: 41.311215, lon: -72.925735, heading: 30, last_stop_id: 41 });
const snapshot = (elapsed: number, present = [watch, next]): ReportingSnapshot => ({ at: start + elapsed,
  serverAt: start + elapsed, buses: [bus(start + elapsed), bus(start + elapsed, '#45')],
  forecasts: { at: start + elapsed, watches: present } });
const step = (prior: ForecastReportingState, elapsed: number, present = [watch, next], watched = [watch],
  available = true, visible = true, scope = ['Blue Night']) => stepForecastReporting(prior, snapshot(elapsed, present), watched, scope, available, visible);
const watching = () => step(emptyForecastReportingState(), 0);
const lost = () => step(step(watching(), 5000, [next], [next]), 10000, [next], [next]);

describe('watched arrival estimate notices', () => {
  it('keeps the original bus through automatic replacement and confirms two distinct missing models', () => {
    const first = step(watching(), 5000, [next], [next]);
    expect(first.records.find(r => r.busName === '38')?.status).toBe('watching');
    const state = step(first, 10000, [next], [next]);
    const record = state.records.find(r => r.busName === '38')!;
    expect(record.status).toBe('unavailable');
    expect(forecastReportingNotice(record, next)).toEqual({ title: 'Blue Night #38: arrival estimate unavailable',
      detail: 'The trip now shows #45; check its updated arrival time.' });
    expect(forecastReportingNotice(record, next).detail).not.toMatch(/stopped reporting|offline|left service/);
  });
  it('does not count the same cached model twice even on a new HTTP poll', () => {
    const first = step(watching(), 5000, [next], [next]);
    const same = { ...snapshot(10000, [next]), forecasts: { at: start + 5000, watches: [next] } };
    expect(stepForecastReporting(first, same, [next], ['Blue Night'], true, true)).toBe(first);
  });
  it('requires the grace even with two rapid distinct models', () => {
    const first = step(watching(), 5000, [next], [next]);
    expect(step(first, 6000, [next], [next]).records.find(r => r.busName === '38')?.status).toBe('watching');
  });
  it('keeps one missing poll quiet and does not claim a recovery', () => {
    const returned = step(step(watching(), 5000, [next]), 10000);
    expect(returned.records.find(r => r.busName === '38')?.status).toBe('watching');
  });
  it('forgets an ordinary choice change while the old forecast remains present', () => {
    expect(step(watching(), 5000, [watch, next], [next]).records.map(r => r.busName)).toEqual(['45']);
  });
  it('does not start watching an already unavailable bus from GPS alone', () => {
    expect(step(emptyForecastReportingState(), 0, [next]).records).toEqual([]);
  });
  for (const reason of ['failed connection', 'hidden tab', 'missing model'] as const) {
    it(`does not count ${reason} as a bus forecast loss`, () => {
      const first = step(watching(), 5000, [next], [next]);
      const s = reason === 'missing model' ? { ...snapshot(10000, [next]), forecasts: null } : snapshot(10000, [next]);
      const paused = stepForecastReporting(first, s, [next], ['Blue Night'], reason !== 'failed connection', reason !== 'hidden tab');
      expect(paused.records.find(r => r.busName === '38')?.missingModels).toBe(0);
      expect(step(paused, 15000, [next], [next]).records.find(r => r.busName === '38')?.status).toBe('watching');
      expect(step(step(paused, 15000, [next], [next]), 20000, [next], [next]).records.find(r => r.busName === '38')?.status).toBe('unavailable');
    });
  }
  it('leaves missing and stale GPS to the separate reporting monitor', () => {
    for (const buses of [[], [bus(start)]]) {
      const s = { ...snapshot(50000, [next]), buses };
      const result = stepForecastReporting(watching(), s, [next], ['Blue Night'], true, true);
      expect(result.records.find(r => r.busName === '38')).toMatchObject({ status: 'watching', missingModels: 0 });
    }
  });
  it('does not treat another route with the same number as a usable GPS observation', () => {
    const s = { ...snapshot(5000, [next]), buses: [{ ...bus(start + 5000), route_id: 3 }] };
    expect(stepForecastReporting(watching(), s, [next], ['Blue Night'], true, true).records[0]?.missingModels).toBe(0);
  });
  it('does not repeat a dismissed episode, but reports forecast recovery once', () => {
    const state = lost(); state.records.find(r => r.busName === '38')!.dismissed = true;
    expect(step(state, 15000, [next], [next]).records.find(r => r.busName === '38')?.dismissed).toBe(true);
    const restored = step(state, 20000, [watch, next], [next]);
    const record = restored.records.find(r => r.busName === '38')!;
    expect(record).toMatchObject({ status: 'restored', dismissed: false });
    expect(forecastReportingNotice(record).title).toBe('Blue Night #38: arrival estimate restored');
    expect(step(restored, 50000, [watch, next], [next]).records.find(r => r.busName === '38')).toBeUndefined();
  });
  it('can alert for a later new loss after recovery', () => {
    const restored = step(lost(), 15000);
    const again = step(step(restored, 20000, [next], [next]), 25000, [next], [next]);
    expect(again.records.find(r => r.busName === '38')).toMatchObject({ status: 'unavailable', changedAt: start + 25000 });
  });
  it('clears records on a viewing-scope change', () => {
    expect(step(lost(), 15000, [], [], true, true, ['Red']).records).toEqual([]);
  });
  it('does not arm from an invalid, missing, expired or unregistered whole ETA source', () => {
    expect(forecastReportingSnapshot([bus(start)], start, start, false)).toBeNull();
    expect(forecastReportingSnapshot([bus(start)], NaN, start, true)).toBeNull();
    expect(forecastReportingSnapshot([bus(start)], start, start, true)?.watches).toEqual([]);
  });
  it('replays the exact recorded source loss and return while GPS stays fresh', () => {
    let state = emptyForecastReportingState(); const results: string[] = [];
    for (const frame of fixture.frames) {
      const feed = structuredClone(frame.feed);
      const ready = attachServerEta(feed.buses, feed.server_eta, frame.modelAt);
      expect(ready).toBe(true);
      const forecasts = forecastReportingSnapshot(feed.buses, frame.modelAt, frame.modelAt, ready)!;
      const present = forecasts.watches.some(w => reportingKey(w) === reportingKey(watch));
      const selected = present ? watch : next;
      state = stepForecastReporting(state, { at: frame.modelAt, serverAt: feed.server_eta.servedAt,
        buses: feed.buses, forecasts }, [selected], ['Blue Night'], true, true);
      results.push(state.records.find(r => r.busName === '38')?.status ?? 'absent');
    }
    expect(results).toEqual(['watching', 'watching', 'watching', 'unavailable', 'unavailable', 'restored', 'watching']);
  });
});
